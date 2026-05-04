import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { streamResponsesToAnthropic } from "../src/proxy/stream-conversion-responses.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "opencode-responses-stream-test-"));
  process.env["OPENCODE_STATUSLINE_STATE_FILE_OVERRIDE"] = join(tmpDir, "state.json");
});

afterEach(() => {
  delete process.env["OPENCODE_STATUSLINE_STATE_FILE_OVERRIDE"];
  rmSync(tmpDir, { recursive: true, force: true });
});

function responseEvent(event: string, payload: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

function responseFromSse(body: string): Response {
  return new Response(new TextEncoder().encode(body));
}

async function collectEvents(response: Response): Promise<any[]> {
  const chunks: string[] = [];
  for await (const chunk of streamResponsesToAnthropic(response)) {
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

describe("streamResponsesToAnthropic", () => {
  test("forwards usage from response.completed", async () => {
    const response = responseFromSse([
      responseEvent("response.output_text.delta", { delta: "hello" }),
      responseEvent("response.output_text.done", {}),
      responseEvent("response.completed", {
        response: {
          usage: {
            input_tokens: 200,
            output_tokens: 50,
            input_tokens_details: {
              cached_tokens: 75,
              cache_creation_tokens: 25,
            },
          },
        },
      }),
    ].join(""));

    const events = await collectEvents(response);
    const delta = events.find((event) => event.type === "message_delta");

    expect(delta.usage).toEqual({
      input_tokens: 200,
      output_tokens: 50,
      cache_creation_input_tokens: 25,
      cache_read_input_tokens: 75,
    });
  });
});
