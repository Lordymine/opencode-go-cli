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
  lastModel?: string;
  proxyPort?: number;
}

// ─── Providers ─────────────────────────────────────────────

export const PROVIDERS = ["opencode", "openai"] as const;
export type Provider = typeof PROVIDERS[number];

// ─── OpenCode Go (default) ────────────────────────────────

export const MODELS: Model[] = [
  { id: "minimax-m2.5", name: "MiniMax M2.5", description: "Balanced speed and quality" },
  { id: "minimax-m2.7", name: "MiniMax M2.7", description: "High performance coding model" },
  { id: "kimi-k2.5", name: "Kimi K2.5", description: "Strong reasoning for complex tasks" },
  { id: "glm-5", name: "GLM-5", description: "Latest generation from Zhipu AI" },
  { id: "glm-5.1", name: "GLM-5.1", description: "Enhanced reasoning from Zhipu AI" },
];

export const OPENCODE_GO_ENDPOINT = "https://opencode.ai/zen/go/v1/chat/completions";

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

// ─── Config paths ────────────────────────────────────────

export const CONFIG_DIR = join(homedir(), ".opencode-go-cli");
export const CONFIG_FILE = join(CONFIG_DIR, "config.json");
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
