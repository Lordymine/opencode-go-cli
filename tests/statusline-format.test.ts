import { describe, expect, test } from "bun:test";
import { formatStatusline } from "../src/statusline/format.js";
import type { StatuslineState } from "../src/statusline/state.js";

const state: StatuslineState = {
  version: 1,
  provider: "opencode",
  model: "kimi-k2.6",
  permissionMode: "acceptEdits",
  proxyUrl: "http://localhost:8080",
  startedAt: "2026-05-04T10:00:00.000Z",
  cliVersion: "1.0.7",
  updatedAt: "2026-05-04T10:00:00.000Z",
};

describe("formatStatusline", () => {
  test("renders compact provider, model, effort, context and rate limits", () => {
    const line = formatStatusline(
      {
        model: { id: "kimi-k2.6", display_name: "Kimi K2.6" },
        effort: { level: "high" },
        context_window: {
          used_percentage: 42,
          remaining_percentage: 58,
        },
        rate_limits: {
          five_hour: {
            used_percentage: 23.4,
            resets_at: 1_777_893_120,
          },
          seven_day: {
            used_percentage: 41.2,
          },
        },
      },
      state,
      { now: new Date("2026-05-04T10:00:00.000Z") },
    );

    expect(line).toBe(
      "OpenCode Go | Kimi K2.6 | high | ctx 42% (58% left) | 5h 23% reset 1h12m | 7d 41%",
    );
  });

  test("falls back to model id and survives missing fields", () => {
    const line = formatStatusline({ model: { id: "qwen3-coder-plus" } });

    expect(line).toBe("qwen3-coder-plus");
  });

  test("uses local state provider and model when stdin does not provide them", () => {
    const line = formatStatusline({}, state);

    expect(line).toBe("OpenCode Go | kimi-k2.6");
  });

  test("minimal style renders only model and context", () => {
    const line = formatStatusline(
      {
        model: { display_name: "GPT-5.4" },
        effort: { level: "xhigh" },
        context_window: { used_percentage: 12 },
      },
      { ...state, provider: "openai" },
      { style: "minimal" },
    );

    expect(line).toBe("GPT-5.4 | ctx 12%");
  });

  test("shows remaining tokens when current usage and window size exist", () => {
    const line = formatStatusline({
      model: { display_name: "Opus" },
      context_window: {
        context_window_size: 200_000,
        used_percentage: 42,
        current_usage: {
          input_tokens: 70_000,
          cache_creation_input_tokens: 10_000,
          cache_read_input_tokens: 4_000,
        },
      },
    });

    expect(line).toBe("Opus | ctx 42% (116k left)");
  });

  test("uses local proxy usage when Claude Code sends null context percentages", () => {
    const line = formatStatusline(
      {
        model: { display_name: "GPT-5.4" },
        context_window: {
          context_window_size: 200_000,
          current_usage: null,
          used_percentage: null,
          remaining_percentage: null,
        },
      },
      {
        ...state,
        provider: "openai",
        lastUsage: {
          inputTokens: 18_000,
          outputTokens: 1_000,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 1_000,
          contextTokens: 19_000,
          totalTokens: 20_000,
          updatedAt: "2026-05-04T10:01:00.000Z",
        },
      },
    );

    expect(line).toBe("OpenAI | GPT-5.4 | ctx ~10% (181k left)");
  });

  test("uses local Codex usage windows when Claude Code omits rate limits", () => {
    const line = formatStatusline(
      {
        model: { display_name: "GPT-5.4" },
      },
      {
        ...state,
        provider: "openai",
        rateLimits: {
          source: "openai-wham",
          updatedAt: "2026-05-04T10:01:00.000Z",
          five_hour: {
            used_percentage: 23,
            resets_at: 1_777_893_120,
          },
          seven_day: {
            used_percentage: 41,
          },
        },
      },
      { now: new Date("2026-05-04T10:00:00.000Z") },
    );

    expect(line).toBe("OpenAI | GPT-5.4 | 5h 23% reset 1h12m | 7d 41%");
  });

  test("drops optional segments before truncating", () => {
    const line = formatStatusline(
      {
        model: { display_name: "A very long model name" },
        effort: { level: "high" },
        context_window: { used_percentage: 99 },
        rate_limits: {
          five_hour: { used_percentage: 90 },
          seven_day: { used_percentage: 80 },
        },
      },
      state,
      { maxWidth: 36 },
    );

    expect(line).toBe("A very long model name | ctx 99%");
  });
});
