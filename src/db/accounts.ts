// ============================================================
// DB — accounts repository
// ============================================================

import { randomUUID } from "node:crypto";
import { db } from "./index.js";

export interface Account {
  id: string;
  email: string | null;
  display_name: string | null;
  access_token: string;
  refresh_token: string;
  expires_at: string; // ISO
  resource_url: string | null;
  priority: number;
  is_active: number; // 0 | 1
  test_status: "active" | "unavailable" | "unknown";
  last_error: string | null;
  error_code: number | null;
  last_error_at: string | null;
  backoff_level: number;
  consecutive_use_count: number;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface NewAccountInput {
  email: string | null;
  display_name: string | null;
  access_token: string;
  refresh_token: string;
  expires_at: string;
  resource_url: string | null;
}

export type AccountPatch = Partial<
  Omit<Account, "id" | "created_at" | "updated_at">
>;

export function listAccounts(): Account[] {
  return db()
    .query("SELECT * FROM accounts ORDER BY priority ASC")
    .all() as Account[];
}

export function listActiveAccounts(): Account[] {
  return db()
    .query("SELECT * FROM accounts WHERE is_active = 1 ORDER BY priority ASC")
    .all() as Account[];
}

export function countAccounts(): number {
  const row = db().query("SELECT COUNT(*) AS c FROM accounts").get() as
    | { c: number }
    | undefined;
  return row?.c ?? 0;
}

export function getAccountById(id: string): Account | null {
  const exact = db()
    .query("SELECT * FROM accounts WHERE id = ?")
    .get(id) as Account | undefined;
  if (exact) return exact;
  // Prefix match — allow short IDs in CLI (e.g. first 8 chars)
  const prefix = db()
    .query("SELECT * FROM accounts WHERE id LIKE ? || '%' LIMIT 1")
    .get(id) as Account | undefined;
  return prefix ?? null;
}

export function getAccountByEmail(email: string): Account | null {
  return (
    (db()
      .query("SELECT * FROM accounts WHERE email LIKE '%' || ? || '%' LIMIT 1")
      .get(email) as Account | undefined) ?? null
  );
}

export function addAccount(data: NewAccountInput): Account {
  const now = new Date().toISOString();

  // If an account with the same email exists, update in place (re-login flow).
  if (data.email) {
    const existing = db()
      .query("SELECT * FROM accounts WHERE email = ?")
      .get(data.email) as Account | undefined;
    if (existing) {
      db()
        .query(
          `UPDATE accounts
           SET access_token = ?, refresh_token = ?, expires_at = ?, resource_url = ?,
               test_status = 'unknown', last_error = NULL, error_code = NULL,
               backoff_level = 0, is_active = 1, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          data.access_token,
          data.refresh_token,
          data.expires_at,
          data.resource_url,
          now,
          existing.id,
        );
      return getAccountById(existing.id)!;
    }
  }

  const id = randomUUID();
  const row = db()
    .query("SELECT COALESCE(MAX(priority), 0) AS m FROM accounts")
    .get() as { m: number } | undefined;
  const maxPri = row?.m ?? 0;

  db()
    .query(
      `INSERT INTO accounts
         (id, email, display_name, access_token, refresh_token, expires_at, resource_url,
          priority, is_active, test_status, backoff_level, consecutive_use_count,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 'unknown', 0, 0, ?, ?)`,
    )
    .run(
      id,
      data.email,
      data.display_name,
      data.access_token,
      data.refresh_token,
      data.expires_at,
      data.resource_url,
      maxPri + 1,
      now,
      now,
    );

  return getAccountById(id)!;
}

type Bindable = string | number | bigint | boolean | null | Uint8Array;

export function updateAccount(id: string, patch: AccountPatch): void {
  const entries = Object.entries(patch);
  if (entries.length === 0) return;
  const sets = entries.map(([k]) => `${k} = ?`).join(", ");
  const values = entries.map(([, v]) => v as Bindable);
  const now = new Date().toISOString();
  db()
    .query(`UPDATE accounts SET ${sets}, updated_at = ? WHERE id = ?`)
    .run(...values, now, id);
}

export function removeAccount(id: string): boolean {
  const { changes } = db()
    .query("DELETE FROM accounts WHERE id = ?")
    .run(id);
  if (changes > 0) reorderPriorities();
  return changes > 0;
}

function reorderPriorities(): void {
  const rows = db()
    .query("SELECT id FROM accounts ORDER BY priority ASC")
    .all() as Array<{ id: string }>;
  const stmt = db().query("UPDATE accounts SET priority = ? WHERE id = ?");
  rows.forEach((a, i) => stmt.run(i + 1, a.id));
}
