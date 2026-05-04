import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildStatuslineState,
  getStatuslineStateFile,
  readStatuslineState,
  updateStatuslineRateLimits,
  updateStatuslineUsage,
  writeStatuslineState,
} from "../src/statusline/state.js";

let tmpDir: string;
let stateFile: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "opencode-statusline-state-"));
  stateFile = join(tmpDir, "state.json");
  process.env["OPENCODE_STATUSLINE_STATE_FILE_OVERRIDE"] = stateFile;
});

afterEach(() => {
  delete process.env["OPENCODE_STATUSLINE_STATE_FILE_OVERRIDE"];
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("statusline state", () => {
  test("uses env override for state file path", () => {
    expect(getStatuslineStateFile()).toBe(stateFile);
  });

  test("builds safe launch metadata", () => {
    const state = buildStatuslineState({
      provider: "qwen",
      model: "qwen3-coder-plus",
      permissionMode: "acceptEdits",
      proxyUrl: "http://localhost:8080",
      cliVersion: "1.2.3",
      now: new Date("2026-05-04T10:00:00.000Z"),
    });

    expect(state).toEqual({
      version: 1,
      provider: "qwen",
      model: "qwen3-coder-plus",
      permissionMode: "acceptEdits",
      proxyUrl: "http://localhost:8080",
      startedAt: "2026-05-04T10:00:00.000Z",
      cliVersion: "1.2.3",
      updatedAt: "2026-05-04T10:00:00.000Z",
    });

    const serialized = JSON.stringify(state);
    expect(serialized).not.toContain("token");
    expect(serialized).not.toContain("apiKey");
  });

  test("writes and reads valid state", () => {
    const state = buildStatuslineState({
      provider: "openai",
      model: "gpt-5.4",
      permissionMode: "default",
      proxyUrl: "http://localhost:8081",
      cliVersion: "1.2.3",
    });

    writeStatuslineState(state);

    expect(existsSync(stateFile)).toBe(true);
    expect(readStatuslineState()).toEqual(state);
  });

  test("updates last usage without storing prompts or credentials", () => {
    const state = buildStatuslineState({
      provider: "openai",
      model: "gpt-5.4",
      permissionMode: "default",
      proxyUrl: "http://localhost:8081",
      cliVersion: "1.2.3",
    });
    writeStatuslineState(state);

    updateStatuslineUsage({
      input_tokens: 1000,
      output_tokens: 250,
      cache_creation_input_tokens: 50,
      cache_read_input_tokens: 700,
    });

    const updated = readStatuslineState();
    expect(updated?.lastUsage).toMatchObject({
      inputTokens: 1000,
      outputTokens: 250,
      cacheCreationInputTokens: 50,
      cacheReadInputTokens: 700,
      contextTokens: 1750,
      totalTokens: 2000,
    });
    expect(JSON.stringify(updated)).not.toContain("sk-");
  });

  test("updates Codex usage windows without storing tokens", () => {
    const state = buildStatuslineState({
      provider: "openai",
      model: "gpt-5.4",
      permissionMode: "default",
      proxyUrl: "http://localhost:8081",
      cliVersion: "1.2.3",
    });
    writeStatuslineState(state);

    updateStatuslineRateLimits({
      source: "openai-wham",
      updatedAt: "2026-05-04T10:01:00.000Z",
      five_hour: {
        used_percentage: 23,
        resets_at: 1_777_893_120,
        limit_window_seconds: 18_000,
      },
      seven_day: {
        used_percentage: 41,
        limit_window_seconds: 604_800,
      },
    });

    const updated = readStatuslineState();
    expect(updated?.rateLimits).toMatchObject({
      source: "openai-wham",
      five_hour: { used_percentage: 23 },
      seven_day: { used_percentage: 41 },
    });
    expect(JSON.stringify(updated)).not.toContain("access");
    expect(JSON.stringify(updated)).not.toContain("refresh");
  });

  test("returns null for missing or malformed state", () => {
    expect(readStatuslineState()).toBeNull();

    writeFileSync(stateFile, "{ nope");
    expect(readStatuslineState()).toBeNull();

    writeFileSync(stateFile, JSON.stringify({ version: 1, provider: "bad" }));
    expect(readStatuslineState()).toBeNull();
  });
});
