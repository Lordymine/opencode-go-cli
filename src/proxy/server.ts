// ============================================================
// Proxy Server — Bun.serve + roteamento
// ============================================================

import {
  OPENCODE_GO_ENDPOINT,
  CODEX_API_URL,
  type Provider,
} from "../constants.js";
import { getConfig } from "../config.js";
import { createLogger } from "../logger.js";
import { refreshAccessToken } from "../auth/oauth.js";
import { convertAnthropicRequestToOpenAI } from "./request-conversion.js";
import { convertOpenAIResponseToAnthropic } from "./response-conversion.js";
import { streamOpenAIToAnthropic } from "./stream-conversion.js";
import { convertAnthropicRequestToResponses } from "./request-conversion-responses.js";
import { convertResponsesApiToAnthropic } from "./response-conversion-responses.js";
import { streamResponsesToAnthropic } from "./stream-conversion-responses.js";
import { hasWebSearchTool, handleWebSearch } from "./websearch-interceptor.js";
import { ensureSearXNG } from "../search/searxng.js";
import { handleQwenRequest } from "./qwen-handler.js";
import { handleZaiRequest } from "./zai-handler.js";
import { countAccounts } from "../db/accounts.js";

const logger = createLogger("[proxy]");

function isPortInUseError(err: any): boolean {
  return err?.code === "EADDRINUSE" || err?.message?.includes("address already in use");
}

function formatPortRange(startPort: number, attempts: number): string {
  const endPort = startPort + attempts - 1;
  return attempts === 1 ? `${startPort}` : `${startPort}-${endPort}`;
}

export async function startProxy(port: number, provider: Provider, attempts = 1): Promise<number> {
  const config = getConfig();
  const endpoint =
    provider === "openai"
      ? CODEX_API_URL
      : provider === "qwen"
        ? "qwen-dynamic" // resolved per-request by handleQwenRequest
        : provider === "zai"
          ? "zai-dynamic" // resolved per-request by handleZaiRequest
          : OPENCODE_GO_ENDPOINT;

  // accessToken is only used by the non-Qwen providers (Qwen resolves per-request
  // inside handleQwenRequest via the SQLite pool). Default to empty string so we
  // don't confuse the Bun.serve closure scope.
  let accessToken = "";

  if (provider === "openai") {
    if (!config.openaiTokens) {
      throw new Error("OpenAI tokens not found. Run 'opencode-go --oauth-login' first.");
    }
    // Refresh if expiring within 1 minute
    if (Date.now() > config.openaiTokens.expiresAt - 60000) {
      logger.info("OpenAI token expired, refreshing...");
      const refreshed = await refreshAccessToken(config.openaiTokens.refresh);
      if (refreshed.type === "success") {
        config.openaiTokens = {
          access: refreshed.access,
          refresh: refreshed.refresh,
          expiresAt: refreshed.expires,
        };
        // saveConfig(config); // tokens already saved in cli after refresh
      }
    }
    accessToken = config.openaiTokens.access;
    logger.info(`Starting on port ${port} (OpenAI)`);
    logger.debug(`Endpoint: ${endpoint}`);
  } else if (provider === "qwen") {
    // Qwen uses per-request account selection via the rotator. We only
    // need to confirm there's at least one account in the pool before
    // spawning the proxy.
    if (countAccounts() === 0) {
      throw new Error(
        "No Qwen accounts found. Run 'opencode-go --qwen-login' first.",
      );
    }
    logger.info(`Starting on port ${port} (Qwen)`);
  } else if (provider === "zai") {
    // Z.ai uses a stored JWT token from browser login.
    const cfg = getConfig();
    if (!cfg.zaiToken) {
      throw new Error(
        "No Z.ai token found. Run 'opencode-go --zai-login' first.",
      );
    }
    logger.info(`Starting on port ${port} (Z.ai)`);
  } else {
    if (!config.apiKey) {
      throw new Error("API key not found. Run 'opencode-go --setup' first.");
    }
    accessToken = config.apiKey;
    logger.info(`Starting on port ${port} (OpenCode Go)`);
    logger.debug(`API Key: ${accessToken.slice(0, 10)}...`);
    logger.debug(`Endpoint: ${endpoint}`);
  }

  let server;
  let boundPort: number | undefined;

  for (let attempt = 0; attempt < attempts; attempt++) {
    const candidatePort = port + attempt;
    try {
      server = Bun.serve({
        port: candidatePort,
        // Upstream LLM streaming responses can idle well beyond Bun's
        // 10s default while a remote provider is thinking. Raise the
        // cap so long-running turns don't get cut off mid-stream with
        // "[Bun.serve]: request timed out after 10 seconds".
        idleTimeout: 255,
        async fetch(req) {
          const url = new URL(req.url);
          logger.debug(`${req.method} ${url.pathname}`);

          // Claude Code sends HEAD / to check connectivity
          if (req.method === "HEAD" || req.method === "GET") {
            return new Response("OK", { status: 200 });
          }

          if (req.method !== "POST") {
            return new Response("Method not allowed", { status: 405 });
          }

          if (url.pathname === "/v1/messages") {
            try {
              const anthropicBody = await req.json() as any;
              const isStreaming = anthropicBody.stream === true;
              logger.debug(`Model: ${anthropicBody.model} | stream: ${isStreaming} | tools: ${anthropicBody.tools?.length ?? 0}`);

              // Intercept WebSearch server tool requests
              if (hasWebSearchTool(anthropicBody)) {
                logger.info("Intercepting WebSearch request");
                return await handleWebSearch(anthropicBody);
              }

              // Qwen: delegate to the rotation handler. It owns account
              // selection, refresh, retry, and response translation.
              if (provider === "qwen") {
                return await handleQwenRequest(anthropicBody);
              }

              // Z.ai: delegate to the Z.ai handler. It owns signature,
              // chat creation, and stream conversion.
              if (provider === "zai") {
                const cfg = getConfig();
                return await handleZaiRequest(anthropicBody, cfg.zaiToken!);
              }

              const isResponses = provider === "openai";
              const outBody = isResponses
                ? convertAnthropicRequestToResponses(anthropicBody)
                : convertAnthropicRequestToOpenAI(anthropicBody);

              logger.debug(`→ ${endpoint} (${isResponses ? "Responses API" : "Chat Completions"})`);
              logger.debug(`Request body: ${JSON.stringify(outBody).slice(0, 2000)}`);

              const response = await fetch(endpoint, {
                method: "POST",
                headers: {
                  "Authorization": `Bearer ${accessToken}`,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify(outBody),
              });

              logger.info(`← status ${response.status}`);

              if (!response.ok) {
                const errorText = await response.text();
                logger.error(`API error: ${errorText.slice(0, 500)}`);
                return new Response(JSON.stringify({
                  type: "error",
                  error: {
                    type: "api_error",
                    message: errorText,
                  },
                }), {
                  status: response.status,
                  headers: { "Content-Type": "application/json" },
                });
              }

              // Codex backend always requires stream=true, so for OpenAI provider
              // we always get a streaming response even if Claude Code asked for non-streaming.
              // In that case, we consume the stream and return a non-streaming Anthropic response.
              const upstreamIsStreaming = isResponses ? true : isStreaming;

              if (upstreamIsStreaming) {
                const streamGenerator = isResponses
                  ? streamResponsesToAnthropic(response)
                  : streamOpenAIToAnthropic(response);

                if (isStreaming) {
                  // Client wants streaming: pass through
                  const stream = new ReadableStream({
                    async start(controller) {
                      let chunkCount = 0;
                      try {
                        for await (const chunk of streamGenerator) {
                          chunkCount++;
                          if (chunkCount <= 5) {
                            logger.debug(`SSE chunk #${chunkCount}: ${chunk.slice(0, 200).replace(/\n/g, "\\n")}`);
                          }
                          controller.enqueue(new TextEncoder().encode(chunk));
                        }
                        logger.debug(`Stream complete: ${chunkCount} chunks sent`);
                      } catch (e) {
                        logger.error(`Stream error: ${e}`);
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
                      "Connection": "keep-alive",
                    },
                  });
                } else {
                  // Client wants non-streaming but upstream is streaming (Codex):
                  // consume stream, collect text/tool blocks, return as JSON
                  let fullText = "";
                  const toolUses: any[] = [];
                  const toolArgs: Record<number, string> = {};
                  let stopReason = "end_turn";

                  for await (const chunk of streamGenerator) {
                    // Parse SSE events from our own generator output
                    const lines = chunk.split("\n");
                    for (const line of lines) {
                      if (!line.startsWith("data: ")) continue;
                      const dataStr = line.slice(6);
                      try {
                        const evt = JSON.parse(dataStr);
                        if (evt.type === "content_block_start" && evt.content_block?.type === "text") {
                          // text block starting
                        } else if (evt.type === "content_block_delta" && evt.delta?.type === "text_delta") {
                          fullText += evt.delta.text;
                        } else if (evt.type === "content_block_start" && evt.content_block?.type === "tool_use") {
                          toolUses.push({
                            type: "tool_use",
                            id: evt.content_block.id,
                            name: evt.content_block.name,
                            input: {},
                          });
                          toolArgs[evt.index] = "";
                        } else if (evt.type === "content_block_delta" && evt.delta?.type === "input_json_delta") {
                          toolArgs[evt.index] = (toolArgs[evt.index] ?? "") + evt.delta.partial_json;
                        } else if (evt.type === "message_delta" && evt.delta?.stop_reason) {
                          stopReason = evt.delta.stop_reason;
                        }
                      } catch {}
                    }
                  }

                  // Parse accumulated tool args
                  for (const tu of toolUses) {
                    const idx = toolUses.indexOf(tu);
                    const rawArgs = Object.values(toolArgs).find((_, i) => i === idx);
                    if (rawArgs) {
                      try { tu.input = JSON.parse(rawArgs); } catch {}
                    }
                  }

                  const content: any[] = [];
                  if (fullText) content.push({ type: "text", text: fullText });
                  content.push(...toolUses);

                  const anthropicResponse = {
                    id: `msg_${Math.random().toString(36).substring(2, 15)}`,
                    type: "message",
                    role: "assistant",
                    content,
                    model: anthropicBody.model ?? "",
                    stop_reason: stopReason,
                    stop_sequence: null,
                    usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
                  };

                  logger.debug(`Response (collected): stop_reason=${stopReason}, blocks=${content.length}`);
                  return new Response(JSON.stringify(anthropicResponse), {
                    status: 200,
                    headers: { "Content-Type": "application/json" },
                  });
                }
              }

              // Non-streaming (Chat Completions only, OpenCode Go)
              const data = await response.json() as any;
              const anthropicResponse = convertOpenAIResponseToAnthropic(data);
              logger.debug(`Response: stop_reason=${anthropicResponse.stop_reason}, blocks=${anthropicResponse.content.length}`);

              return new Response(JSON.stringify(anthropicResponse), {
                status: 200,
                headers: { "Content-Type": "application/json" },
              });
            } catch (e: any) {
              logger.error(`Internal error: ${e.message}`);
              return new Response(JSON.stringify({
                type: "error",
                error: {
                  type: "internal_server_error",
                  message: e.message,
                },
              }), {
                status: 500,
                headers: { "Content-Type": "application/json" },
              });
            }
          }

          return new Response("Not found", { status: 404 });
        },
      });
      boundPort = server.port;
      break;
    } catch (err: any) {
      if (isPortInUseError(err) && attempt < attempts - 1) {
        logger.warn(`Port ${candidatePort} is already in use. Trying ${candidatePort + 1}...`);
        continue;
      }

      if (isPortInUseError(err)) {
        throw new Error(`No available proxy port in range ${formatPortRange(port, attempts)}.`);
      }

      throw err;
    }
  }

  if (boundPort === undefined) {
    throw new Error(`Failed to start proxy on port range ${formatPortRange(port, attempts)}.`);
  }

  if (boundPort !== port) {
    logger.info(`Preferred port ${port} unavailable, using ${boundPort}`);
  }
  logger.info(`Proxy ready at http://localhost:${boundPort}`);
  logger.info("Waiting for Claude Code...");

  // Start SearXNG in background for WebSearch interception
  ensureSearXNG().then((ok) => {
    if (ok) logger.info("WebSearch interception enabled (SearXNG)");
    else logger.warn("WebSearch interception disabled (SearXNG unavailable)");
  });

  return boundPort;
}
