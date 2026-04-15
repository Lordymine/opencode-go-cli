// ============================================================
// Z.ai Stream Conversion — Z.ai SSE → Anthropic SSE
// ============================================================
//
// Formato SSE do Z.ai:
//   data: {"type":"chat:completion","data":{"delta_content":"...","phase":"thinking"}}
//   data: {"type":"chat:completion","data":{"delta_content":"...","phase":"answer"}}
//   data: {"data":"[DONE]"}
//
// A gente só repassa o phase="answer" pro Anthropic.
// Thinking é descartado (poderia ser repassado como extended thinking no futuro).

import { createLogger } from "../logger.js";
import { generateMsgId, makeSSE } from "./helpers.js";

export async function* streamZaiToAnthropic(
  response: Response,
  model: string,
): AsyncGenerator<string> {
  const msgId = generateMsgId();
  const logger = createLogger("[zai]");

  // 1. message_start
  yield makeSSE("message_start", {
    type: "message_start",
    message: {
      id: msgId,
      type: "message",
      role: "assistant",
      content: [],
      model,
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  });

  yield makeSSE("ping", { type: "ping" });

  let textBlockStarted = false;
  let blockIndex = 0;
  let outputTokens = 0;

  if (!response.body) {
    logger.warn("response.body is null!");
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith("data:")) continue;
      const dataStr = trimmed.replace(/^data:\s*/, "");

      // [DONE] signal
      if (dataStr === "[DONE]" || dataStr.includes('"[DONE]"')) {
        if (textBlockStarted) {
          yield makeSSE("content_block_stop", {
            type: "content_block_stop",
            index: blockIndex,
          });
        }

        yield makeSSE("message_delta", {
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { output_tokens: outputTokens },
        });

        yield makeSSE("message_stop", { type: "message_stop" });
        return;
      }

      let parsed: any;
      try {
        parsed = JSON.parse(dataStr);
      } catch {
        continue;
      }

      // Handle Z.ai event format
      const eventData = parsed?.data;
      const phase = eventData?.phase;
      const deltaContent = eventData?.delta_content;

      // Skip thinking phase — só repassamos "answer"
      if (phase !== "answer" || !deltaContent) continue;

      outputTokens++;

      if (!textBlockStarted) {
        textBlockStarted = true;
        yield makeSSE("content_block_start", {
          type: "content_block_start",
          index: blockIndex,
          content_block: { type: "text", text: "" },
        });
      }

      yield makeSSE("content_block_delta", {
        type: "content_block_delta",
        index: blockIndex,
        delta: { type: "text_delta", text: deltaContent },
      });
    }
  }

  // Safety: se o stream acabou sem [DONE]
  if (textBlockStarted) {
    yield makeSSE("content_block_stop", {
      type: "content_block_stop",
      index: blockIndex,
    });
  }

  yield makeSSE("message_delta", {
    type: "message_delta",
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: { output_tokens: outputTokens },
  });

  yield makeSSE("message_stop", { type: "message_stop" });
}
