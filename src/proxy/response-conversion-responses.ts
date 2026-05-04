// ============================================================
// Response Conversion — OpenAI Responses API → Anthropic (non-streaming)
// ============================================================

import { generateMsgId } from "./helpers.js";
import { mapResponsesUsageToAnthropic, recordStatuslineUsage } from "./usage.js";

export function convertResponsesApiToAnthropic(resp: any): any {
  const contentBlocks: any[] = [];

  for (const item of resp.output ?? []) {
    if (item.type === "message") {
      for (const c of item.content ?? []) {
        if (c.type === "output_text") {
          contentBlocks.push({ type: "text", text: c.text });
        }
      }
    } else if (item.type === "function_call") {
      let input: any = {};
      try {
        input = JSON.parse(item.arguments);
      } catch {}
      contentBlocks.push({
        type: "tool_use",
        id: item.call_id ?? item.id,
        name: item.name,
        input,
      });
    }
  }

  // Determine stop reason
  const hasToolCall = (resp.output ?? []).some((o: any) => o.type === "function_call");
  let stopReason = "end_turn";
  if (hasToolCall) stopReason = "tool_use";
  if (resp.incomplete_details) stopReason = "max_tokens";

  const usage = mapResponsesUsageToAnthropic(resp.usage);
  recordStatuslineUsage(usage);

  return {
    id: resp.id ? resp.id.replace("resp_", "msg_") : generateMsgId(),
    type: "message",
    role: "assistant",
    content: contentBlocks,
    model: resp.model ?? "",
    stop_reason: stopReason,
    stop_sequence: null,
    usage,
  };
}
