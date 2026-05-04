import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  CONFIG_DIR,
  PERMISSION_MODES,
  PROVIDERS,
  type PermissionMode,
  type Provider,
} from "../constants.js";

export interface StatuslineState {
  version: 1;
  provider: Provider;
  model: string;
  permissionMode: PermissionMode;
  proxyUrl: string;
  startedAt: string;
  cliVersion: string;
  updatedAt: string;
  lastUsage?: StatuslineUsage;
  rateLimits?: StatuslineRateLimits;
}

export interface StatuslineUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  contextTokens: number;
  totalTokens: number;
  updatedAt: string;
}

export interface StatuslineRateLimitWindow {
  used_percentage: number;
  resets_at?: number;
  limit_window_seconds?: number;
}

export interface StatuslineRateLimits {
  source: "openai-wham";
  updatedAt: string;
  five_hour?: StatuslineRateLimitWindow;
  seven_day?: StatuslineRateLimitWindow;
}

export interface BuildStatuslineStateArgs {
  provider: Provider;
  model: string;
  permissionMode: PermissionMode;
  proxyUrl: string;
  cliVersion: string;
  now?: Date;
}

export function getStatuslineStateFile(): string {
  return process.env["OPENCODE_STATUSLINE_STATE_FILE_OVERRIDE"]
    ?? join(CONFIG_DIR, "statusline-state.json");
}

function isStatuslineState(value: any): value is StatuslineState {
  return value?.version === 1
    && PROVIDERS.includes(value.provider)
    && typeof value.model === "string"
    && PERMISSION_MODES.includes(value.permissionMode)
    && typeof value.proxyUrl === "string"
    && typeof value.startedAt === "string"
    && typeof value.cliVersion === "string"
    && typeof value.updatedAt === "string";
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function readStatuslineState(): StatuslineState | null {
  const file = getStatuslineStateFile();
  try {
    if (!existsSync(file)) return null;
    const parsed = JSON.parse(readFileSync(file, "utf-8"));
    return isStatuslineState(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function writeStatuslineState(state: StatuslineState): void {
  const file = getStatuslineStateFile();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(state, null, 2));
}

export function updateStatuslineUsage(usage: {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}): void {
  const state = readStatuslineState();
  if (!state) return;

  const inputTokens = numberOrZero(usage.input_tokens);
  const outputTokens = numberOrZero(usage.output_tokens);
  const cacheCreationInputTokens = numberOrZero(usage.cache_creation_input_tokens);
  const cacheReadInputTokens = numberOrZero(usage.cache_read_input_tokens);

  if (inputTokens + outputTokens + cacheCreationInputTokens + cacheReadInputTokens === 0) {
    return;
  }

  const updatedAt = new Date().toISOString();
  const contextTokens = inputTokens + cacheCreationInputTokens + cacheReadInputTokens;
  writeStatuslineState({
    ...state,
    updatedAt,
    lastUsage: {
      inputTokens,
      outputTokens,
      cacheCreationInputTokens,
      cacheReadInputTokens,
      contextTokens,
      totalTokens: inputTokens + outputTokens + cacheCreationInputTokens + cacheReadInputTokens,
      updatedAt,
    },
  });
}

export function updateStatuslineRateLimits(rateLimits: StatuslineRateLimits): void {
  const state = readStatuslineState();
  if (!state) return;

  writeStatuslineState({
    ...state,
    updatedAt: new Date().toISOString(),
    rateLimits,
  });
}

export function buildStatuslineState(args: BuildStatuslineStateArgs): StatuslineState {
  const now = args.now ?? new Date();
  const timestamp = now.toISOString();

  return {
    version: 1,
    provider: args.provider,
    model: args.model,
    permissionMode: args.permissionMode,
    proxyUrl: args.proxyUrl,
    startedAt: timestamp,
    cliVersion: args.cliVersion,
    updatedAt: timestamp,
  };
}
