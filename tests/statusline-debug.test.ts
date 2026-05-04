import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  clearStatuslineDebugFiles,
  disableStatuslineDebug,
  enableStatuslineDebug,
  getStatuslineDebugFlagFile,
  getStatuslineDebugLatestFile,
  getStatuslineDebugLogFile,
  isStatuslineDebugEnabled,
  readLatestStatuslineDebugCapture,
  writeStatuslineDebugCapture,
} from "../src/statusline/debug.js";

let tmpDir: string;
let flagFile: string;
let latestFile: string;
let logFile: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "opencode-statusline-debug-"));
  flagFile = join(tmpDir, "debug.enabled");
  latestFile = join(tmpDir, "latest.json");
  logFile = join(tmpDir, "debug.jsonl");
  process.env["OPENCODE_STATUSLINE_DEBUG_FLAG_FILE_OVERRIDE"] = flagFile;
  process.env["OPENCODE_STATUSLINE_DEBUG_LATEST_FILE_OVERRIDE"] = latestFile;
  process.env["OPENCODE_STATUSLINE_DEBUG_LOG_FILE_OVERRIDE"] = logFile;
  delete process.env["OPENCODE_STATUSLINE_DEBUG"];
});

afterEach(() => {
  delete process.env["OPENCODE_STATUSLINE_DEBUG_FLAG_FILE_OVERRIDE"];
  delete process.env["OPENCODE_STATUSLINE_DEBUG_LATEST_FILE_OVERRIDE"];
  delete process.env["OPENCODE_STATUSLINE_DEBUG_LOG_FILE_OVERRIDE"];
  delete process.env["OPENCODE_STATUSLINE_DEBUG"];
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("statusline debug", () => {
  test("toggles debug through a marker file", () => {
    expect(isStatuslineDebugEnabled()).toBe(false);

    enableStatuslineDebug();
    expect(existsSync(getStatuslineDebugFlagFile())).toBe(true);
    expect(isStatuslineDebugEnabled()).toBe(true);

    disableStatuslineDebug();
    expect(isStatuslineDebugEnabled()).toBe(false);
  });

  test("does not write captures while disabled", () => {
    writeStatuslineDebugCapture({
      rawInput: "{}",
      input: {},
      parseOk: true,
      state: null,
    });

    expect(existsSync(getStatuslineDebugLatestFile())).toBe(false);
  });

  test("writes latest and bounded history while enabled", () => {
    enableStatuslineDebug();

    for (let i = 0; i < 105; i++) {
      writeStatuslineDebugCapture({
        rawInput: `{"i":${i}}`,
        input: { i, context_window: { used_percentage: i } },
        parseOk: true,
        state: null,
      });
    }

    const latest = readLatestStatuslineDebugCapture();
    const lines = readFileSync(getStatuslineDebugLogFile(), "utf-8")
      .split(/\r?\n/)
      .filter(Boolean);

    expect(latest?.contextWindow).toEqual({ used_percentage: 104 });
    expect(lines).toHaveLength(100);
  });

  test("script captures raw Claude Code input when debug is enabled", () => {
    const input = JSON.stringify({
      model: { display_name: "GPT-5.4" },
      effort: { level: "medium" },
      context_window: { used_percentage: 25 },
    });
    const result = spawnSync("bun", ["src/statusline/script.ts"], {
      cwd: process.cwd(),
      input,
      encoding: "utf-8",
      env: {
        ...process.env,
        OPENCODE_STATUSLINE_DEBUG: "1",
        OPENCODE_STATUSLINE_DEBUG_FLAG_FILE_OVERRIDE: flagFile,
        OPENCODE_STATUSLINE_DEBUG_LATEST_FILE_OVERRIDE: latestFile,
        OPENCODE_STATUSLINE_DEBUG_LOG_FILE_OVERRIDE: logFile,
        OPENCODE_STATUSLINE_STATE_FILE_OVERRIDE: join(tmpDir, "state.json"),
      },
    });

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("GPT-5.4 | medium | ctx 25%");
    expect(readLatestStatuslineDebugCapture()?.contextWindow).toEqual({
      used_percentage: 25,
    });

    clearStatuslineDebugFiles();
    expect(existsSync(latestFile)).toBe(false);
    expect(existsSync(logFile)).toBe(false);
  });
});
