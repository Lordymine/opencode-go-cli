// ============================================================
// Env — construção de variáveis de ambiente para Claude Code
// ============================================================

import { PRESERVED_CLAUDE_CODE_VARS } from "./constants.js";
import { getInstallationPath } from "./path.js";
import { DEFAULT_INSTALLATION_ID } from "./constants.js";

function cleanupClaudeCodeVars(env: Record<string, string>): void {
  for (const key of Object.keys(env)) {
    if (PRESERVED_CLAUDE_CODE_VARS.has(key)) continue;
    if (key.startsWith("CLAUDECODE") || key.startsWith("CLAUDE_CODE")) {
      delete env[key];
    }
  }
}

export function buildClaudeEnv(
  apiKey: string,
  model: string,
  baseUrl: string,
  installationId?: string,
): Record<string, string> {
  const env: Record<string, string> = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }

  cleanupClaudeCodeVars(env);

  delete env["ANTHROPIC_API_KEY"];
  delete env["ANTHROPIC_ACCOUNT_ID"];
  delete env["CLAUDE_ACCOUNT_ID"];

  env["ANTHROPIC_BASE_URL"] = baseUrl;
  env["ANTHROPIC_AUTH_TOKEN"] = apiKey;
  env["ANTHROPIC_MODEL"] = model;
  env["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"] = "1";
  env["CLAUDE_CODE_NO_FLICKER"] = "1";
  env["CLAUDE_CODE_SUBAGENT_MODEL"] = model;
  env["ANTHROPIC_DEFAULT_SONNET_MODEL"] = model;
  env["ANTHROPIC_DEFAULT_OPUS_MODEL"] = model;
  env["ANTHROPIC_DEFAULT_HAIKU_MODEL"] = model;

  if (installationId && installationId !== DEFAULT_INSTALLATION_ID) {
    env["CLAUDE_CONFIG_DIR"] = getInstallationPath(installationId);
  }

  return env;
}
