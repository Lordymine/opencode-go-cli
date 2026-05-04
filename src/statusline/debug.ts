import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG_DIR } from "../constants.js";
import type { StatuslineState } from "./state.js";

const MAX_DEBUG_EVENTS = 100;

export interface StatuslineDebugCapture {
  capturedAt: string;
  parseOk: boolean;
  topLevelKeys: string[];
  model: unknown;
  effort: unknown;
  contextWindow: unknown;
  rateLimits: unknown;
  state: StatuslineState | null;
  input: unknown;
  rawInput: string;
}

export function getStatuslineDebugFlagFile(): string {
  return process.env["OPENCODE_STATUSLINE_DEBUG_FLAG_FILE_OVERRIDE"]
    ?? join(CONFIG_DIR, "statusline-debug.enabled");
}

export function getStatuslineDebugLatestFile(): string {
  return process.env["OPENCODE_STATUSLINE_DEBUG_LATEST_FILE_OVERRIDE"]
    ?? join(CONFIG_DIR, "statusline-debug-latest.json");
}

export function getStatuslineDebugLogFile(): string {
  return process.env["OPENCODE_STATUSLINE_DEBUG_LOG_FILE_OVERRIDE"]
    ?? join(CONFIG_DIR, "statusline-debug.jsonl");
}

export function isStatuslineDebugEnabled(): boolean {
  const env = process.env["OPENCODE_STATUSLINE_DEBUG"];
  if (env === "1" || env === "true" || env === "yes") return true;
  return existsSync(getStatuslineDebugFlagFile());
}

export function enableStatuslineDebug(): void {
  const flagFile = getStatuslineDebugFlagFile();
  mkdirSync(dirname(flagFile), { recursive: true });
  writeFileSync(flagFile, new Date().toISOString());
}

export function disableStatuslineDebug(): void {
  try {
    unlinkSync(getStatuslineDebugFlagFile());
  } catch {}
}

export function clearStatuslineDebugFiles(): void {
  for (const file of [getStatuslineDebugLatestFile(), getStatuslineDebugLogFile()]) {
    try {
      rmSync(file, { force: true });
    } catch {}
  }
}

function objectKeys(value: unknown): string[] {
  return value && typeof value === "object" ? Object.keys(value).sort() : [];
}

function field(value: unknown, key: string): unknown {
  return value && typeof value === "object" ? (value as Record<string, unknown>)[key] : null;
}

function buildCapture(args: {
  rawInput: string;
  input: unknown;
  parseOk: boolean;
  state: StatuslineState | null;
}): StatuslineDebugCapture {
  return {
    capturedAt: new Date().toISOString(),
    parseOk: args.parseOk,
    topLevelKeys: objectKeys(args.input),
    model: field(args.input, "model"),
    effort: field(args.input, "effort"),
    contextWindow: field(args.input, "context_window"),
    rateLimits: field(args.input, "rate_limits"),
    state: args.state,
    input: args.input,
    rawInput: args.rawInput,
  };
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function appendBoundedJsonl(file: string, capture: StatuslineDebugCapture): void {
  let lines: string[] = [];
  try {
    lines = readFileSync(file, "utf-8").split(/\r?\n/).filter(Boolean);
  } catch {}
  lines.push(JSON.stringify(capture));
  lines = lines.slice(-MAX_DEBUG_EVENTS);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${lines.join("\n")}\n`);
}

export function writeStatuslineDebugCapture(args: {
  rawInput: string;
  input: unknown;
  parseOk: boolean;
  state: StatuslineState | null;
}): void {
  if (!isStatuslineDebugEnabled()) return;

  try {
    const capture = buildCapture(args);
    writeJson(getStatuslineDebugLatestFile(), capture);
    appendBoundedJsonl(getStatuslineDebugLogFile(), capture);
  } catch {}
}

export function readLatestStatuslineDebugCapture(): StatuslineDebugCapture | null {
  try {
    return JSON.parse(readFileSync(getStatuslineDebugLatestFile(), "utf-8"));
  } catch {
    return null;
  }
}
