// ============================================================
// Request Conversion — Anthropic → OpenAI
// ============================================================

import { convertImageSource } from "./helpers.js";

export function convertAnthropicRequestToOpenAI(body: any): any {
  const openaiMessages: any[] = [];

  // 1. System prompt → system message
  if (body.system) {
    let systemText: string;
    if (typeof body.system === "string") {
      systemText = body.system;
    } else if (Array.isArray(body.system)) {
      systemText = body.system
        .filter((b: any) => b.type === "text")
        .map((b: any) => b.text)
        .join("\n");
    } else {
      systemText = String(body.system);
    }
    openaiMessages.push({ role: "system", content: systemText });
  }

  // 2. Messages
  for (const msg of body.messages ?? []) {
    const role = msg.role;
    const content = msg.content;

    if (role === "user") {
      if (typeof content === "string") {
        openaiMessages.push({ role: "user", content });
        continue;
      }

      if (Array.isArray(content)) {
        const hasToolResult = content.some((b: any) => b.type === "tool_result");

        if (hasToolResult) {
          const textParts: string[] = [];
          for (const block of content) {
            if (block.type === "tool_result") {
              let toolContent = "";
              if (typeof block.content === "string") {
                toolContent = block.content;
              } else if (Array.isArray(block.content)) {
                toolContent = block.content
                  .filter((c: any) => c.type === "text")
                  .map((c: any) => c.text)
                  .join(" ");
              }
              openaiMessages.push({
                role: "tool",
                tool_call_id: block.tool_use_id,
                content: toolContent || "Success",
              });
            } else if (block.type === "text" && block.text) {
              textParts.push(block.text);
            }
          }
          if (textParts.length > 0) {
            openaiMessages.push({ role: "user", content: textParts.join("\n") });
          }
        } else {
          const openaiContent: any[] = [];
          for (const block of content) {
            if (block.type === "text") {
              openaiContent.push({ type: "text", text: block.text });
            } else if (block.type === "image") {
              openaiContent.push({
                type: "image_url",
                image_url: { url: convertImageSource(block.source) },
              });
            }
          }
          openaiMessages.push({ role: "user", content: openaiContent });
        }
      }
    } else if (role === "assistant") {
      const openaiMsg: any = { role: "assistant" };

      if (typeof content === "string") {
        openaiMsg.content = content;
      } else if (Array.isArray(content)) {
        const textParts: string[] = [];
        const reasoningParts: string[] = [];
        const toolCalls: any[] = [];

        for (const block of content) {
          if (block.type === "text") {
            textParts.push(block.text);
          } else if (block.type === "thinking") {
            // Anthropic thinking blocks carry the reasoning text that
            // extended-thinking backends (Moonshot/Kimi, DeepSeek, etc.)
            // require echoed back on subsequent turns as
            // `reasoning_content`. Dropping them causes providers to
            // reject the request with "reasoning_content is missing".
            if (typeof block.thinking === "string") {
              reasoningParts.push(block.thinking);
            } else if (typeof block.text === "string") {
              reasoningParts.push(block.text);
            }
          } else if (block.type === "redacted_thinking") {
            // Provider-opaque thinking. No plain text is available, but
            // we still need a non-empty reasoning_content marker so the
            // upstream doesn't complain about a missing field.
            reasoningParts.push("[redacted]");
          } else if (block.type === "tool_use") {
            toolCalls.push({
              id: block.id,
              type: "function",
              function: {
                name: block.name,
                arguments: JSON.stringify(block.input),
              },
            });
          }
        }

        if (textParts.length > 0) {
          openaiMsg.content = textParts.join("\n");
        }
        if (toolCalls.length > 0) {
          openaiMsg.tool_calls = toolCalls;
        }
        // Extended-thinking backends (Moonshot/Kimi via OpenCode Zen,
        // DeepSeek reasoner, etc.) require assistant messages that carry
        // `tool_calls` to include a non-empty `reasoning_content` field.
        // Some providers enable thinking upstream regardless of whether
        // the client asked for it, so we emit the field whenever we
        // translate a tool-calling assistant turn. If Anthropic actually
        // sent thinking blocks we use that text; otherwise we fall back
        // to a placeholder so the upstream stops rejecting the request
        // with "reasoning_content is missing in assistant tool call
        // message at index N". Providers that ignore the field are
        // unaffected.
        if (reasoningParts.length > 0) {
          openaiMsg.reasoning_content = reasoningParts.join("\n");
        } else if (toolCalls.length > 0) {
          openaiMsg.reasoning_content = "[no reasoning provided]";
        }
      }

      openaiMessages.push(openaiMsg);
    }
  }

  // 3. Tools
  const tools: any[] = [];
  if (body.tools) {
    for (const tool of body.tools) {
      tools.push({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description ?? "",
          parameters: tool.input_schema,
        },
      });
    }
  }

  // 4. Build final body
  const openaiBody: any = {
    model: body.model,
    messages: openaiMessages,
    stream: body.stream ?? false,
  };

  if (body.max_tokens != null) openaiBody.max_tokens = body.max_tokens;
  if (body.temperature != null) openaiBody.temperature = body.temperature;
  if (body.top_p != null) openaiBody.top_p = body.top_p;
  if (body.stop_sequences) openaiBody.stop = body.stop_sequences;

  if (tools.length > 0) {
    openaiBody.tools = tools;

    if (body.tool_choice) {
      const tc = body.tool_choice;
      if (tc.type === "any") openaiBody.tool_choice = "required";
      else if (tc.type === "auto") openaiBody.tool_choice = "auto";
      else if (tc.type === "tool") {
        openaiBody.tool_choice = {
          type: "function",
          function: { name: tc.name },
        };
      }
    }
  }

  return openaiBody;
}
