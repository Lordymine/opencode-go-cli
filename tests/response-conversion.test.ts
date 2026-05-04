import { afterEach, beforeEach, describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { convertOpenAIResponseToAnthropic } from "../src/proxy/response-conversion.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "opencode-response-test-"));
  process.env["OPENCODE_STATUSLINE_STATE_FILE_OVERRIDE"] = join(tmpDir, "state.json");
});

afterEach(() => {
  delete process.env["OPENCODE_STATUSLINE_STATE_FILE_OVERRIDE"];
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("convertOpenAIResponseToAnthropic", () => {
  test("converts message.content to type:text block", () => {
    const openaiResp = {
      id: "chatcmpl-123",
      model: "minimax-m2.7",
      choices: [
        {
          message: { role: "assistant", content: "Hello world" },
          finish_reason: "stop",
        },
      ],
    };
    const result = convertOpenAIResponseToAnthropic(openaiResp);
    expect(result.content[0]).toEqual({ type: "text", text: "Hello world" });
  });

  test("converts tool_calls to type:tool_use blocks", () => {
    const openaiResp = {
      id: "chatcmpl-123",
      model: "minimax-m2.7",
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_abc",
                type: "function",
                function: { name: "read_file", arguments: '{"path":"/tmp"}' },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    };
    const result = convertOpenAIResponseToAnthropic(openaiResp);
    expect(result.content[0]).toEqual({
      type: "tool_use",
      id: "call_abc",
      name: "read_file",
      input: { path: "/tmp" },
    });
  });

  test('maps id chatcmpl-xxx to msg_xxx', () => {
    const openaiResp = {
      id: "chatcmpl-abc123",
      model: "minimax-m2.7",
      choices: [{ message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
    };
    const result = convertOpenAIResponseToAnthropic(openaiResp);
    expect(result.id).toBe("msg-abc123");
  });

  test('maps finish_reason "stop" to stop_reason "end_turn"', () => {
    const openaiResp = {
      id: "chatcmpl-123",
      model: "minimax-m2.7",
      choices: [{ message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
    };
    const result = convertOpenAIResponseToAnthropic(openaiResp);
    expect(result.stop_reason).toBe("end_turn");
  });

  test('maps finish_reason "tool_calls" to stop_reason "tool_use"', () => {
    const openaiResp = {
      id: "chatcmpl-123",
      model: "minimax-m2.7",
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }],
          },
          finish_reason: "tool_calls",
        },
      ],
    };
    const result = convertOpenAIResponseToAnthropic(openaiResp);
    expect(result.stop_reason).toBe("tool_use");
  });

  test("forwards usage token counts", () => {
    const openaiResp = {
      id: "chatcmpl-123",
      model: "minimax-m2.7",
      usage: { prompt_tokens: 100, completion_tokens: 50 },
      choices: [{ message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
    };
    const result = convertOpenAIResponseToAnthropic(openaiResp);
    expect(result.usage.input_tokens).toBe(100);
    expect(result.usage.output_tokens).toBe(50);
  });

  test("generates msgId when id is missing", () => {
    const openaiResp = {
      model: "minimax-m2.7",
      choices: [{ message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
    };
    const result = convertOpenAIResponseToAnthropic(openaiResp);
    expect(result.id).toMatch(/^msg_/);
  });
});
