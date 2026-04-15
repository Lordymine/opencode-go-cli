// ============================================================
// Config — persistência de configuração do usuário
// SRP: só persistência, não resolve paths
// ============================================================

import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync, rmSync } from "node:fs";
import { CONFIG_FILE, CONFIG_DIR, type Config } from "./constants.js";
import { resetDb } from "./db/index.js";

export function getConfig(): Config {
  try {
    if (existsSync(CONFIG_FILE)) {
      return JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
    }
  } catch {}
  return {};
}

export function saveConfig(config: Config): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

export function deleteConfig(): void {
  try {
    unlinkSync(CONFIG_FILE);
  } catch {}
}

/**
 * Wipe every piece of state the CLI persists under CONFIG_DIR:
 * config.json, qwen.db (accounts/locks/settings), zai browser profile,
 * installations, searxng config. Closes the SQLite handle first so
 * Windows lets us delete the file.
 */
export function resetAll(): void {
  resetDb();
  try {
    rmSync(CONFIG_DIR, { recursive: true, force: true });
  } catch {}
}
