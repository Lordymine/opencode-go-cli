// ============================================================
// DB — model_locks repository
// ============================================================
//
// A lock marks an account as cooling down for a given model
// (or all models when model === null → "__all").
// Used by the rotator to skip accounts that are rate-limited
// or temporarily unavailable.

import { db } from "./index.js";

export const ALL_MODELS = "__all";

export interface ModelLockRow {
  model: string;
  locked_until: string;
}

export function isModelLockActive(
  accountId: string,
  model: string | null,
): boolean {
  const now = new Date().toISOString();
  const key = model ?? ALL_MODELS;
  const lock = db()
    .query(
      `SELECT id FROM model_locks
       WHERE account_id = ? AND (model = ? OR model = ?) AND locked_until > ?
       LIMIT 1`,
    )
    .get(accountId, key, ALL_MODELS, now);
  return !!lock;
}

export function setModelLock(
  accountId: string,
  model: string | null,
  cooldownMs: number,
): void {
  const key = model ?? ALL_MODELS;
  const until = new Date(Date.now() + cooldownMs).toISOString();
  const existing = db()
    .query(
      "SELECT id FROM model_locks WHERE account_id = ? AND model = ?",
    )
    .get(accountId, key) as { id: number } | undefined;

  if (existing) {
    db()
      .query("UPDATE model_locks SET locked_until = ? WHERE id = ?")
      .run(until, existing.id);
  } else {
    db()
      .query(
        "INSERT INTO model_locks (account_id, model, locked_until) VALUES (?, ?, ?)",
      )
      .run(accountId, key, until);
  }
}

export function clearModelLock(
  accountId: string,
  model: string | null,
): void {
  const key = model ?? ALL_MODELS;
  db()
    .query("DELETE FROM model_locks WHERE account_id = ? AND model = ?")
    .run(accountId, key);
}

export function clearAllLocksForAccount(accountId: string): void {
  db().query("DELETE FROM model_locks WHERE account_id = ?").run(accountId);
}

export function getActiveModelLocks(accountId: string): ModelLockRow[] {
  const now = new Date().toISOString();
  return db()
    .query(
      "SELECT model, locked_until FROM model_locks WHERE account_id = ? AND locked_until > ?",
    )
    .all(accountId, now) as ModelLockRow[];
}

export function getEarliestLockUntil(model: string | null): string | null {
  const now = new Date().toISOString();
  const key = model ?? ALL_MODELS;
  const row = db()
    .query(
      `SELECT MIN(locked_until) AS until FROM model_locks
       WHERE (model = ? OR model = ?) AND locked_until > ?`,
    )
    .get(key, ALL_MODELS, now) as { until: string | null } | undefined;
  return row?.until ?? null;
}
