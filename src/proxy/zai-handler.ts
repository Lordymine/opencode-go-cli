// ============================================================
// Z.ai Handler — cria chat, gera assinatura, faz request, retorna
// response em formato Anthropic (streaming ou JSON)
// ============================================================

import {
  ZAI_API_V2,
  ZAI_AUTH_URL,
  ZAI_CHAT_NEW_URL,
  ZAI_FE_VERSION,
} from "../constants.js";
import { createLogger } from "../logger.js";
import { generateZaiSignature, buildZaiUrlParams } from "./zai-signature.js";
import { streamZaiToAnthropic } from "./zai-stream.js";
import { generateMsgId } from "./helpers.js";

const logger = createLogger("[zai]");

// Cache de chat IDs — reutiliza o mesmo chat enquanto possível
let cachedChatId: string | null = null;
let cachedChatModel: string | null = null;

/**
 * Valida o token Z.ai contra o endpoint de auth.
 * Retorna o userId se válido, null se inválido.
 */
export async function validateZaiToken(token: string): Promise<string | null> {
  try {
    const resp = await fetch(ZAI_AUTH_URL, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!resp.ok) return null;
    const data = await resp.json() as any;
    return data?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * Cria um novo chat no Z.ai (necessário antes de cada conversa).
 */
async function createChat(token: string, model: string): Promise<string> {
  const resp = await fetch(ZAI_CHAT_NEW_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      chat: { title: "OpenCode Go", models: [model] },
    }),
  });

  if (!resp.ok) {
    throw new Error(`Failed to create Z.ai chat: ${resp.status} ${await resp.text()}`);
  }

  const data = await resp.json() as any;
  return data.id;
}

/**
 * Garante que temos um chat ID válido para o modelo.
 */
async function ensureChatId(token: string, model: string): Promise<string> {
  // Sempre cria um novo chat — é mais seguro e o Z.ai não se importa
  cachedChatId = await createChat(token, model);
  cachedChatModel = model;
  logger.debug(`Created chat ${cachedChatId?.slice(0, 8)} for model ${model}`);
  return cachedChatId;
}

/**
 * Handle a Claude Code /v1/messages request against Z.ai's free API.
 */
export async function handleZaiRequest(
  anthropicBody: any,
  zaiToken: string,
): Promise<Response> {
  const isStreaming = anthropicBody.stream === true;
  const model = anthropicBody.model ?? "glm-4.7";
  const prompt = extractPrompt(anthropicBody);

  // Validar token e pegar userId
  const userId = await validateZaiToken(zaiToken);
  if (!userId) {
    return errorResponse(401, "auth_error", "Invalid Z.ai token. Run 'opencode-go --zai-login' to update.");
  }

  // Criar chat
  const chatId = await ensureChatId(zaiToken, model);

  // Gerar assinatura
  const timestamp = String(Date.now());
  const requestId = crypto.randomUUID();
  const signature = generateZaiSignature({ requestId, timestamp, userId, prompt });
  const urlParams = buildZaiUrlParams({ timestamp, requestId, userId, token: zaiToken });

  // Montar body no formato Z.ai
  const messages = convertMessages(anthropicBody);
  const zaiBody = {
    stream: true,
    model,
    messages,
    signature_prompt: prompt,
    params: {},
    extra: {},
    features: {
      image_generation: false,
      web_search: false,
      auto_web_search: false,
      preview_mode: true,
      flags: [] as string[],
      enable_thinking: false,
    },
    variables: buildVariables(),
    chat_id: chatId,
    id: crypto.randomUUID(),
    current_user_message_id: crypto.randomUUID(),
    current_user_message_parent_id: null,
    background_tasks: {
      tags_generation: true,
      title_generation: true,
    },
  };

  const url = `${ZAI_API_V2}?${urlParams}`;

  logger.debug(`→ Z.ai model=${model} chat=${chatId.slice(0, 8)} stream=${isStreaming}`);

  let upstream: Response;
  try {
    upstream = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${zaiToken}`,
        "Accept-Language": "en-US",
        "X-FE-Version": ZAI_FE_VERSION,
        "X-Signature": signature,
      },
      body: JSON.stringify(zaiBody),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`Network error: ${msg}`);
    return errorResponse(502, "network_error", msg);
  }

  if (!upstream.ok) {
    const errText = await upstream.text();
    logger.error(`Z.ai ${upstream.status}: ${errText.slice(0, 200)}`);

    // 500 = modelo sobrecarregado, dá feedback util
    if (upstream.status === 500) {
      return errorResponse(
        503,
        "model_overloaded",
        `Z.ai model "${model}" returned 500 — likely overloaded. Try a different model with --model (e.g. glm-4.7).`,
      );
    }

    return errorResponse(upstream.status, "api_error", errText);
  }

  logger.info(`← Z.ai ${upstream.status} stream=${isStreaming}`);

  if (isStreaming) {
    return wrapStream(upstream, model);
  }

  // Non-streaming: consumir o stream e montar JSON
  let fullText = "";
  for await (const chunk of streamZaiToAnthropic(upstream, model)) {
    const lines = chunk.split("\n");
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      try {
        const evt = JSON.parse(line.slice(6));
        if (evt.type === "content_block_delta" && evt.delta?.type === "text_delta") {
          fullText += evt.delta.text;
        }
      } catch {}
    }
  }

  const anthropicResponse = {
    id: generateMsgId(),
    type: "message",
    role: "assistant",
    content: [{ type: "text", text: fullText }],
    model,
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  };

  return new Response(JSON.stringify(anthropicResponse), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

// ─── Helpers ──────────────────────────────────────────────

function wrapStream(upstream: Response, model: string): Response {
  const generator = streamZaiToAnthropic(upstream, model);
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      try {
        for await (const chunk of generator) {
          controller.enqueue(encoder.encode(chunk));
        }
      } catch (e) {
        logger.error(`stream error: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

/**
 * Extrai o prompt (texto do usuário) do body Anthropic.
 */
function extractPrompt(body: any): string {
  const messages = body?.messages ?? [];
  // Pega a última mensagem do usuário
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role !== "user") continue;
    const content = msg.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block?.type === "text") return block.text ?? "";
      }
    }
  }
  return "";
}

/**
 * Converte mensagens do formato Anthropic pro formato Z.ai (OpenAI-like).
 */
function convertMessages(body: any): Array<{ role: string; content: string }> {
  const messages: Array<{ role: string; content: string }> = [];
  for (const msg of body?.messages ?? []) {
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        messages.push({ role: "user", content: msg.content });
      } else if (Array.isArray(msg.content)) {
        const textParts = msg.content
          .filter((b: any) => b.type === "text")
          .map((b: any) => b.text)
          .join("\n");
        if (textParts) messages.push({ role: "user", content: textParts });
      }
    } else if (msg.role === "assistant") {
      if (typeof msg.content === "string") {
        messages.push({ role: "assistant", content: msg.content });
      } else if (Array.isArray(msg.content)) {
        const textParts = msg.content
          .filter((b: any) => b.type === "text")
          .map((b: any) => b.text)
          .join("\n");
        if (textParts) messages.push({ role: "assistant", content: textParts });
      }
    }
  }
  return messages;
}

/**
 * Variáveis de template que o Z.ai espera.
 */
function buildVariables(): Record<string, string> {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const dateStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const timeStr = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

  return {
    "{{CURRENT_DATETIME}}": `${dateStr} ${timeStr}`,
    "{{CURRENT_DATE}}": dateStr,
    "{{CURRENT_TIMEZONE}}": Intl.DateTimeFormat().resolvedOptions().timeZone,
    "{{CURRENT_TIME}}": timeStr,
    "{{CURRENT_WEEKDAY}}": days[now.getDay()],
    "{{USER_LANGUAGE}}": "en-US",
    "{{USER_LOCATION}}": "Unknown",
    "{{USER_NAME}}": "User",
  };
}

function errorResponse(
  status: number,
  type: string,
  message: string,
): Response {
  return new Response(
    JSON.stringify({ type: "error", error: { type, message } }),
    {
      status,
      headers: { "Content-Type": "application/json" },
    },
  );
}
