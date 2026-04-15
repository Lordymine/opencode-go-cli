// ============================================================
// DB — SQLite storage for Qwen accounts, model locks, settings
// ============================================================
//
// Uses bun:sqlite (built-in). Schema mirrors gqwen-auth so future
// migration paths stay simple, but lives under ~/.opencode-go-cli/
// to keep this project self-contained.

import { Database } from "bun:sqlite";
import { mkdirSync, existsSync } from "node:fs";
import {
  CONFIG_DIR,
  QWEN_DB_FILE,
  QWEN_DEFAULT_STRATEGY,
  QWEN_DEFAULT_STICKY_LIMIT,
} from "../constants.js";

export type RotationStrategy = "fill-first" | "round-robin";

let _db: Database | null = null;

function ensureConfigDir(): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

export function db(): Database {
  if (_db) return _db;

  // Allow tests to redirect storage to an ephemeral location by setting
  // QWEN_DB_PATH before the module is first used. In the common case
  // (empty env var) we fall back to the user config dir.
  const override = process.env.QWEN_DB_PATH;
  const path = override && override.length > 0 ? override : QWEN_DB_FILE;
  if (!override) ensureConfigDir();
  _db = new Database(path);
  _db.exec("PRAGMA journal_mode = WAL");
  _db.exec("PRAGMA foreign_keys = ON");

  _db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      email TEXT,
      display_name TEXT,
      access_token TEXT NOT NULL,
      refresh_token TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      resource_url TEXT,
      priority INTEGER NOT NULL DEFAULT 1,
      is_active INTEGER NOT NULL DEFAULT 1,
      test_status TEXT NOT NULL DEFAULT 'unknown',
      last_error TEXT,
      error_code INTEGER,
      last_error_at TEXT,
      backoff_level INTEGER NOT NULL DEFAULT 0,
      consecutive_use_count INTEGER NOT NULL DEFAULT 0,
      last_used_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  _db.exec(`
    CREATE TABLE IF NOT EXISTS model_locks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      model TEXT NOT NULL,
      locked_until TEXT NOT NULL
    )
  `);

  _db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

  _db.query("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)").run(
    "strategy",
    QWEN_DEFAULT_STRATEGY,
  );
  _db.query("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)").run(
    "sticky_limit",
    String(QWEN_DEFAULT_STICKY_LIMIT),
  );

  return _db;
}

/** Reset the singleton. For tests that need a fresh DB. */
export function resetDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

export function getSetting(key: string): string | null {
  const row = db().query("SELECT value FROM settings WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function setSetting(key: string, value: string): void {
  db()
    .query("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)")
    .run(key, value);
}

export function getStrategy(): RotationStrategy {
  const v = getSetting("strategy") ?? QWEN_DEFAULT_STRATEGY;
  return v === "round-robin" ? "round-robin" : "fill-first";
}

export function setStrategy(strategy: RotationStrategy): void {
  setSetting("strategy", strategy);
}

export function getStickyLimit(): number {
  const raw = getSetting("sticky_limit") ?? String(QWEN_DEFAULT_STICKY_LIMIT);
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : QWEN_DEFAULT_STICKY_LIMIT;
}
