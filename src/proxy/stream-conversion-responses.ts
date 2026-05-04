// ============================================================
// Stream Conversion — OpenAI Responses API SSE → Anthropic SSE
// ============================================================

import { createLogger } from "../logger.js";
import { generateMsgId, makeSSE } from "./helpers.js";
import { mapResponsesUsageToAnthropic, recordStatuslineUsage } from "./usage.js";

export async function* streamResponsesToAnthropic(response: Response): AsyncGenerator<string> {
  const msgId = generateMsgId();
  const logger = createLogger("[proxy]");

  // 1. message_start
  yield makeSSE("message_start", {
    type: "message_start",
    message: {
      id: msgId,
      type: "message",
      role: "assistant",
      content: [],
      model: "proxy",
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  });

  yield makeSSE("ping", { type: "ping" });

  // State tracking
  let nextBlockIndex = 0;
  let textBlockStarted = false;
  let textBlockIndex = -1;
  const toolCallBlocks: Record<string, number> = {}; // item_id → blockIndex
  let hasToolCalls = false;
  let usage: any = null;

  if (!response.body) {
    logger.warn("response.body is null!");
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let rawChunkCount = 0;

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      logger.debug(`Responses API stream ended after ${rawChunkCount} raw chunks`);
      break;
    }

    const rawText = decoder.decode(value, { stream: true });
    rawChunkCount++;
    if (rawChunkCount <= 3) {
      logger.debug(`Raw Responses chunk #${rawChunkCount}: ${rawText.slice(0, 300).replace(/\n/g, "\\n")}`);
    }
    buffer += rawText;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    let currentEventType = "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      // Responses API uses named events: "event: response.output_text.delta"
      if (trimmed.startsWith("event:")) {
        currentEventType = trimmed.replace(/^event:\s*/, "");
        continue;
      }

      if (!trimmed.startsWith("data:")) continue;
      const dataStr = trimmed.replace(/^data:\s*/, "");

      let parsed: any;
      try {
        parsed = JSON.parse(dataStr);
      } catch {
        continue;
      }

      // --- Text delta ---
      if (currentEventType === "response.output_text.delta") {
        if (!textBlockStarted) {
          textBlockStarted = true;
          textBlockIndex = nextBlockIndex;
          nextBlockIndex++;
          yield makeSSE("content_block_start", {
            type: "content_block_start",
            index: textBlockIndex,
            content_block: { type: "text", text: "" },
          });
        }
        yield makeSSE("content_block_delta", {
          type: "content_block_delta",
          index: textBlockIndex,
          delta: { type: "text_delta", text: parsed.delta ?? "" },
        });
      }

      // --- Text done (close text block) ---
      if (currentEventType === "response.output_text.done") {
        if (textBlockStarted) {
          yield makeSSE("content_block_stop", {
            type: "content_block_stop",
            index: textBlockIndex,
          });
          textBlockStarted = false;
        }
      }

      // --- Function call added (start tool_use block) ---
      if (currentEventType === "response.output_item.added" && parsed.item?.type === "function_call") {
        hasToolCalls = true;

        // Close text block if still open
        if (textBlockStarted) {
          yield makeSSE("content_block_stop", {
            type: "content_block_stop",
            index: textBlockIndex,
          });
          textBlockStarted = false;
        }

        const blockIndex = nextBlockIndex;
        nextBlockIndex++;
        const itemId = parsed.item.id ?? parsed.item.call_id;
        toolCallBlocks[itemId] = blockIndex;

        yield makeSSE("content_block_start", {
          type: "content_block_start",
          index: blockIndex,
          content_block: {
            type: "tool_use",
            id: parsed.item.call_id ?? itemId,
            name: parsed.item.name ?? "",
            input: {},
          },
        });
      }

      // --- Function call arguments delta ---
      if (currentEventType === "response.function_call_arguments.delta") {
        const itemId = parsed.item_id;
        const blockIndex = toolCallBlocks[itemId];
        if (blockIndex !== undefined) {
          yield makeSSE("content_block_delta", {
            type: "content_block_delta",
            index: blockIndex,
            delta: { type: "input_json_delta", partial_json: parsed.delta ?? "" },
          });
        }
      }

      // --- Function call done (close tool_use block) ---
      if (currentEventType === "response.output_item.done" && parsed.item?.type === "function_call") {
        const itemId = parsed.item.id ?? parsed.item.call_id;
        const blockIndex = toolCallBlocks[itemId];
        if (blockIndex !== undefined) {
          yield makeSSE("content_block_stop", {
            type: "content_block_stop",
            index: blockIndex,
          });
        }
      }

      // --- Message output item done (close text block if message type) ---
      if (currentEventType === "response.output_item.done" && parsed.item?.type === "message") {
        if (textBlockStarted) {
          yield makeSSE("content_block_stop", {
            type: "content_block_stop",
            index: textBlockIndex,
          });
          textBlockStarted = false;
        }
      }

      // --- Response completed ---
      if (currentEventType === "response.completed") {
        usage = parsed.response?.usage;

        // Close any open text block
        if (textBlockStarted) {
          yield makeSSE("content_block_stop", {
            type: "content_block_stop",
            index: textBlockIndex,
          });
        }

        const finalUsage = mapResponsesUsageToAnthropic(usage);
        recordStatuslineUsage(finalUsage);
        yield makeSSE("message_delta", {
          type: "message_delta",
          delta: {
            stop_reason: hasToolCalls ? "tool_use" : "end_turn",
            stop_sequence: null,
          },
          usage: finalUsage,
        });

        yield makeSSE("message_stop", { type: "message_stop" });
        return;
      }

      currentEventType = "";
    }
  }

  // Safety: if stream ends without response.completed
  if (textBlockStarted) {
    yield makeSSE("content_block_stop", {
      type: "content_block_stop",
      index: textBlockIndex,
    });
  }

  const finalUsage = mapResponsesUsageToAnthropic(usage);
  recordStatuslineUsage(finalUsage);
  yield makeSSE("message_delta", {
    type: "message_delta",
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: finalUsage,
  });
  yield makeSSE("message_stop", { type: "message_stop" });
}
