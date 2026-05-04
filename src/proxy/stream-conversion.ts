// ============================================================
// Stream Conversion — OpenAI SSE → Anthropic SSE (chunk-by-chunk)
// ============================================================

import { createLogger } from "../logger.js";
import { generateMsgId, mapStopReason, makeSSE } from "./helpers.js";
import { mapChatUsageToAnthropic, recordStatuslineUsage } from "./usage.js";

export async function* streamOpenAIToAnthropic(response: Response): AsyncGenerator<string> {
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

  let textBlockStarted = false;
  let nextBlockIndex = 0;
  const toolCallAccumulators: Record<number, string> = {};
  const openaiToolIndexToBlockIndex: Record<number, number> = {};
  let encounteredToolCall = false;
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
      logger.debug(`OpenAI stream ended after ${rawChunkCount} raw chunks`);
      break;
    }

    const rawText = decoder.decode(value, { stream: true });
    rawChunkCount++;
    if (rawChunkCount <= 3) {
      logger.debug(`Raw OpenAI chunk #${rawChunkCount}: ${rawText.slice(0, 300).replace(/\n/g, "\\n")}`);
    }
    buffer += rawText;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith("data:")) continue;
      const dataStr = trimmed.replace(/^data:\s*/, "");

      if (dataStr === "[DONE]") {
        if (textBlockStarted && Object.keys(toolCallAccumulators).length === 0) {
          yield makeSSE("content_block_stop", {
            type: "content_block_stop",
            index: 0,
          });
        }
        if (encounteredToolCall) {
          for (const idx in toolCallAccumulators) {
            yield makeSSE("content_block_stop", {
              type: "content_block_stop",
              index: parseInt(idx, 10),
            });
          }
        }

        const finalUsage = mapChatUsageToAnthropic(usage);
        recordStatuslineUsage(finalUsage);
        yield makeSSE("message_delta", {
          type: "message_delta",
          delta: {
            stop_reason: encounteredToolCall ? "tool_use" : "end_turn",
            stop_sequence: null,
          },
          usage: finalUsage,
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

      if (parsed.usage) {
        usage = parsed.usage;
      }

      const choice = parsed.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta;
      if (!delta) continue;

      // --- Text content ---
      if (delta.content) {
        if (!textBlockStarted) {
          textBlockStarted = true;
          yield makeSSE("content_block_start", {
            type: "content_block_start",
            index: nextBlockIndex,
            content_block: { type: "text", text: "" },
          });
        }
        yield makeSSE("content_block_delta", {
          type: "content_block_delta",
          index: nextBlockIndex,
          delta: { type: "text_delta", text: delta.content },
        });
      }

      // --- Tool calls ---
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const openaiIdx = tc.index;

          if (openaiToolIndexToBlockIndex[openaiIdx] === undefined) {
            encounteredToolCall = true;

            if (textBlockStarted && Object.keys(toolCallAccumulators).length === 0) {
              yield makeSSE("content_block_stop", {
                type: "content_block_stop",
                index: nextBlockIndex,
              });
              nextBlockIndex++;
            }

            const blockIndex = nextBlockIndex;
            openaiToolIndexToBlockIndex[openaiIdx] = blockIndex;
            toolCallAccumulators[blockIndex] = "";

            yield makeSSE("content_block_start", {
              type: "content_block_start",
              index: blockIndex,
              content_block: {
                type: "tool_use",
                id: tc.id ?? `tool_${blockIndex}`,
                name: tc.function?.name ?? "",
                input: {},
              },
            });

            nextBlockIndex = blockIndex + 1;
          }

          const blockIndex = openaiToolIndexToBlockIndex[openaiIdx];

          const newArgs = tc.function?.arguments ?? "";
          if (newArgs) {
            yield makeSSE("content_block_delta", {
              type: "content_block_delta",
              index: blockIndex,
              delta: { type: "input_json_delta", partial_json: newArgs },
            });
            toolCallAccumulators[blockIndex] += newArgs;
          }
        }
      }

      // --- Finish reason ---
      if (choice.finish_reason) {
        if (textBlockStarted && Object.keys(toolCallAccumulators).length === 0) {
          yield makeSSE("content_block_stop", {
            type: "content_block_stop",
            index: 0,
          });
        }

        if (encounteredToolCall) {
          for (const idx in toolCallAccumulators) {
            yield makeSSE("content_block_stop", {
              type: "content_block_stop",
              index: parseInt(idx, 10),
            });
          }
        }

        const finalUsage = mapChatUsageToAnthropic(usage);
        recordStatuslineUsage(finalUsage);
        yield makeSSE("message_delta", {
          type: "message_delta",
          delta: {
            stop_reason: mapStopReason(choice.finish_reason),
            stop_sequence: null,
          },
          usage: finalUsage,
        });

        yield makeSSE("message_stop", { type: "message_stop" });
        return;
      }
    }
  }

  // Safety: if we exit the loop without sending message_stop
  const finalUsage = mapChatUsageToAnthropic(usage);
  recordStatuslineUsage(finalUsage);
  yield makeSSE("message_delta", {
    type: "message_delta",
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: finalUsage,
  });
  yield makeSSE("message_stop", { type: "message_stop" });
}
