import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { streamOpenAIToAnthropic } from "../src/proxy/stream-conversion.js";
import {
  buildStatuslineState,
  readStatuslineState,
  writeStatuslineState,
} from "../src/statusline/state.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "opencode-stream-test-"));
  process.env["OPENCODE_STATUSLINE_STATE_FILE_OVERRIDE"] = join(tmpDir, "state.json");
});

afterEach(() => {
  delete process.env["OPENCODE_STATUSLINE_STATE_FILE_OVERRIDE"];
  rmSync(tmpDir, { recursive: true, force: true });
});

function sseData(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function responseFromSse(body: string): Response {
  return new Response(new TextEncoder().encode(body));
}

async function collectEvents(response: Response): Promise<any[]> {
  const chunks: string[] = [];
  for await (const chunk of streamOpenAIToAnthropic(response)) {
    chunks.push(chunk);
  }

  return chunks
    .join("")
    .split("\n\n")
    .filter(Boolean)
    .map((event) => {
      const dataLine = event.split("\n").find((line) => line.startsWith("data: "));
      return JSON.parse(dataLine!.slice("data: ".length));
    });
}

describe("streamOpenAIToAnthropic", () => {
  test("forwards final usage from Chat Completions usage chunks", async () => {
    writeStatuslineState(buildStatuslineState({
      provider: "opencode",
      model: "minimax-m2.7",
      permissionMode: "default",
      proxyUrl: "http://localhost:8080",
      cliVersion: "test",
    }));
    const response = responseFromSse([
      sseData({
        choices: [{ delta: { content: "hello" }, finish_reason: null }],
      }),
      sseData({
        choices: [],
        usage: {
          prompt_tokens: 120,
          completion_tokens: 30,
          prompt_tokens_details: {
            cached_tokens: 40,
            cache_creation_tokens: 10,
          },
        },
      }),
      sseData({
        choices: [{ delta: {}, finish_reason: "stop" }],
      }),
    ].join(""));

    const events = await collectEvents(response);
    const delta = events.find((event) => event.type === "message_delta");

    expect(delta.usage).toEqual({
      input_tokens: 120,
      output_tokens: 30,
      cache_creation_input_tokens: 10,
      cache_read_input_tokens: 40,
    });
    expect(readStatuslineState()?.lastUsage).toMatchObject({
      inputTokens: 120,
      outputTokens: 30,
      contextTokens: 170,
      totalTokens: 200,
    });
  });
});
