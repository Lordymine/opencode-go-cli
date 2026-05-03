// ============================================================
// Constants — valores compartilhados por todos os módulos
// ============================================================

import { homedir } from "node:os";
import { join } from "node:path";

// ─── Interfaces (primeiro, antes de serem usadas) ──────────

export interface Model {
  id: string;
  name: string;
  description: string;
}

export interface OpenAIAuthTokens {
  access: string;
  refresh: string;
  expiresAt: number; // timestamp ms
}

export interface Config {
  apiKey?: string;
  provider?: Provider;
  openaiTokens?: OpenAIAuthTokens;
  zaiToken?: string;
  lastModel?: string;
  proxyPort?: number;
}

// ─── Providers ─────────────────────────────────────────────

export const PROVIDERS = ["opencode", "openai", "qwen", "zai"] as const;
export type Provider = typeof PROVIDERS[number];

// ─── OpenCode Go (default) ────────────────────────────────

// Fallback snapshot of the OpenCode Zen catalog. Used only when the live
// /zen/v1/models endpoint is unreachable. Updated 2026-04. For the current
// list, the CLI fetches the catalog at runtime — see
// src/providers/opencode-models.ts.
export const MODELS: Model[] = [
  { id: "minimax-m2.7", name: "MiniMax M2.7", description: "High performance coding model" },
  { id: "minimax-m2.5", name: "MiniMax M2.5", description: "Balanced speed and quality" },
  { id: "minimax-m2.5-free", name: "MiniMax M2.5 (Free)", description: "Free tier" },
  { id: "kimi-k2.6", name: "Kimi K2.6", description: "Latest Kimi reasoning model" },
  { id: "kimi-k2.5", name: "Kimi K2.5", description: "Strong reasoning for complex tasks" },
  { id: "glm-5.1", name: "GLM-5.1", description: "Enhanced reasoning from Zhipu AI" },
  { id: "glm-5", name: "GLM-5", description: "Latest generation from Zhipu AI" },
  { id: "qwen3.6-plus", name: "Qwen3.6 Plus", description: "Latest Qwen3 flagship" },
  { id: "qwen3.5-plus", name: "Qwen3.5 Plus", description: "Qwen3 flagship" },
  { id: "big-pickle", name: "Big Pickle", description: "OpenCode house model" },
  { id: "ling-2.6-flash-free", name: "Ling 2.6 Flash (Free)", description: "Free tier" },
  { id: "trinity-large-preview-free", name: "Trinity Large Preview (Free)", description: "Free tier preview" },
  { id: "nemotron-3-super-free", name: "Nemotron 3 Super (Free)", description: "Free tier" },
];

export const OPENCODE_GO_ENDPOINT = "https://opencode.ai/zen/go/v1/chat/completions";
export const OPENCODE_MODELS_ENDPOINT = "https://opencode.ai/zen/v1/models";
export const OPENCODE_MODELS_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
export const OPENCODE_MODELS_FETCH_TIMEOUT_MS = 5_000;

// ─── OpenAI / Codex (OAuth) ─────────────────────────────

export const OPENAI_MODELS: Model[] = [
  { id: "gpt-5.2", name: "GPT-5.2", description: "Latest GPT-5 model" },
  { id: "gpt-5.3", name: "GPT-5.3", description: "High performance GPT-5" },
  { id: "gpt-5.4", name: "GPT-5.4", description: "Balanced GPT-5" },
  { id: "gpt-5.1-codex", name: "GPT-5.1 Codex", description: "Code-optimized GPT-5.1" },
  { id: "gpt-5.2-codex", name: "GPT-5.2 Codex", description: "Code-optimized GPT-5.2" },
  { id: "gpt-5.3-codex", name: "GPT-5.3 Codex", description: "Code-optimized GPT-5.3" },
];

// OAuth constants — same as Codex CLI
export const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const CODEX_AUTH_URL = "https://auth.openai.com/oauth/authorize";
export const CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token";
export const CODEX_REDIRECT_URI = "http://localhost:1455/auth/callback";
export const CODEX_SCOPE = "openid profile email offline_access";
export const CODEX_API_URL = "https://chatgpt.com/backend-api/codex/responses";

// ─── Qwen (OAuth device flow) ────────────────────────────

export const QWEN_MODELS: Model[] = [
  { id: "qwen3-coder-plus", name: "Qwen3 Coder Plus", description: "High-performance Qwen coding model" },
  { id: "qwen3-coder-flash", name: "Qwen3 Coder Flash", description: "Fast, cost-efficient Qwen coding model" },
];

export const QWEN_CLIENT_ID = "f0304373b74a44d2b584a3fb70ca9e56";
export const QWEN_DEVICE_CODE_URL = "https://chat.qwen.ai/api/v1/oauth2/device/code";
export const QWEN_TOKEN_URL = "https://chat.qwen.ai/api/v1/oauth2/token";
export const QWEN_SCOPE = "openid profile email model.completion";
export const QWEN_DEFAULT_API_BASE = "https://portal.qwen.ai/v1";
export const QWEN_CODE_VERSION = "0.13.2";

// Token refresh buffer: refresh if expiring within 5 minutes
export const QWEN_TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000;

// Cooldown durations per error class (matches gqwen)
export const QWEN_COOLDOWN_UNAUTHORIZED_MS = 5 * 60 * 1000; // 401
export const QWEN_COOLDOWN_PAYMENT_MS = 60 * 60 * 1000; // 402/403
export const QWEN_COOLDOWN_TRANSIENT_MS = 5_000; // 5xx/timeout
export const QWEN_COOLDOWN_NOT_FOUND_MS = 15 * 60 * 1000; // 404
export const QWEN_RATE_LIMIT_BACKOFF_BASE_MS = 1_000;
export const QWEN_RATE_LIMIT_BACKOFF_MAX_MS = 2 * 60 * 1000;
export const QWEN_RATE_LIMIT_BACKOFF_MAX_LEVEL = 15;

// Max number of accounts to try in a single /v1/messages request before giving up
export const QWEN_MAX_ROTATION_ATTEMPTS = 5;

// Rotation strategy defaults
export const QWEN_DEFAULT_STRATEGY = "fill-first"; // or "round-robin"
export const QWEN_DEFAULT_STICKY_LIMIT = 3;

/**
 * Resolve the per-account Qwen API base URL. Some tokens come back with a
 * `resource_url` pointing to a region-specific endpoint (matching dashscope
 * behaviour). If absent, fall back to the default portal base.
 */
export function buildQwenApiBase(resourceUrl: string | null): string {
  if (!resourceUrl) return QWEN_DEFAULT_API_BASE;
  const raw = resourceUrl.trim();
  if (raw.startsWith("http")) return raw.replace(/\/$/, "");
  return `https://${raw.replace(/\/$/, "")}/v1`;
}

export function buildQwenChatCompletionsUrl(resourceUrl: string | null): string {
  return `${buildQwenApiBase(resourceUrl)}/chat/completions`;
}

/**
 * Build the set of HTTP headers Qwen's backend expects. Mirrors the
 * headers QwenCode / gqwen send: the DashScope "qwen-oauth" auth type
 * is required for OAuth-issued tokens, and the Stainless headers are
 * kept so server-side logging / quota behaves identically.
 */
export function buildQwenHeaders(
  accessToken: string,
  stream: boolean,
): Record<string, string> {
  const userAgent = `QwenCode/${QWEN_CODE_VERSION} (${process.platform}; ${process.arch})`;
  const stainlessOs =
    process.platform === "darwin"
      ? "MacOS"
      : process.platform === "win32"
        ? "Windows"
        : "Linux";
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${accessToken}`,
    "User-Agent": userAgent,
    "X-DashScope-UserAgent": userAgent,
    "X-DashScope-AuthType": "qwen-oauth",
    "X-DashScope-CacheControl": "enable",
    "X-Stainless-Runtime": "node",
    "X-Stainless-Runtime-Version": process.version,
    "X-Stainless-Lang": "js",
    "X-Stainless-Arch": process.arch,
    "X-Stainless-Os": stainlessOs,
    "X-Stainless-Package-Version": "5.11.0",
    "X-Stainless-Retry-Count": "0",
    Accept: stream ? "text/event-stream" : "application/json",
  };
}

// ─── Z.ai (free GLM models) ────────────────────────────

export const ZAI_MODELS: Model[] = [
  { id: "glm-4.7", name: "GLM-4.7", description: "Fast and reliable — stable availability" },
  { id: "glm-5-turbo", name: "GLM-5 Turbo", description: "Fast GLM-5 variant" },
  { id: "glm-5.1", name: "GLM-5.1", description: "Latest GLM — best reasoning (may be overloaded)" },
  { id: "glm-5", name: "GLM-5", description: "Base GLM-5 model (may be overloaded)" },
];

export const ZAI_BASE_URL = "https://chat.z.ai";
export const ZAI_API_V2 = `${ZAI_BASE_URL}/api/v2/chat/completions`;
export const ZAI_AUTH_URL = `${ZAI_BASE_URL}/api/v1/auths/`;
export const ZAI_CHAT_NEW_URL = `${ZAI_BASE_URL}/api/v1/chats/new`;
export const ZAI_FE_VERSION = "prod-fe-1.1.11";
export const ZAI_HMAC_KEY = "key-@@@@)))()((9))-xxxx&&&%%%%%";
export const ZAI_TIME_BUCKET_MS = 5 * 60 * 1000; // 5 minutes

// ─── Config paths ────────────────────────────────────────

export const CONFIG_DIR = join(homedir(), ".opencode-go-cli");
export const CONFIG_FILE = join(CONFIG_DIR, "config.json");
export const QWEN_DB_FILE = join(CONFIG_DIR, "qwen.db");
export const OPENCODE_MODELS_CACHE_FILE = join(CONFIG_DIR, "opencode-models.json");
export const INSTALLATIONS_DIR = join(CONFIG_DIR, "installations");
export const DEFAULT_INSTALLATION_ID = "default";
export const DEFAULT_PROXY_PORT = 8080;
export const PROXY_PORT_FALLBACK_ATTEMPTS = 20;

export const PRESERVED_CLAUDE_CODE_VARS = new Set([
  "CLAUDE_CODE_GIT_BASH_PATH",
  "CLAUDE_CODE_NO_FLICKER",
  "CLAUDE_CODE_SHELL",
  "CLAUDE_CODE_TMPDIR",
]);
