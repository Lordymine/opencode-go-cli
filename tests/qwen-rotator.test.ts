// Unit tests for the rotator. Uses an in-memory SQLite DB by setting
// QWEN_DB_PATH to `:memory:` before importing the db module.

process.env.QWEN_DB_PATH = ":memory:";

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { db, resetDb, setStrategy } from "../src/db/index.js";
import { addAccount } from "../src/db/accounts.js";
import { setModelLock } from "../src/db/locks.js";
import {
  clearAccountError,
  isRateLimitedResult,
  markAccountUnavailable,
  selectAccount,
} from "../src/rotator/index.js";
import type { Account } from "../src/db/accounts.js";

function futureIso(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}

function insert(
  email: string,
  overrides: Partial<{ is_active: number; expires_in_ms: number }> = {},
): Account {
  return addAccount({
    email,
    display_name: email,
    access_token: `token-${email}`,
    refresh_token: `refresh-${email}`,
    expires_at: futureIso(overrides.expires_in_ms ?? 3_600_000),
    resource_url: null,
  });
}

function resetTables(): void {
  db().exec("DELETE FROM model_locks");
  db().exec("DELETE FROM accounts");
}

beforeEach(() => {
  resetTables();
  setStrategy("fill-first");
});

afterEach(() => {
  resetTables();
});

describe("selectAccount — fill-first", () => {
  test("returns null when pool is empty", () => {
    expect(selectAccount("qwen3-coder-plus")).toBeNull();
  });

  test("picks the highest-priority (first-added) active account", () => {
    const a = insert("a@example.com");
    insert("b@example.com");
    const picked = selectAccount("qwen3-coder-plus");
    expect(picked).not.toBeNull();
    if (picked === null || isRateLimitedResult(picked)) {
      throw new Error("expected Account");
    }
    expect(picked.id).toBe(a.id);
  });

  test("skips excluded IDs", () => {
    const a = insert("a@example.com");
    const b = insert("b@example.com");
    const picked = selectAccount("qwen3-coder-plus", new Set([a.id]));
    if (picked === null || isRateLimitedResult(picked)) {
      throw new Error("expected Account");
    }
    expect(picked.id).toBe(b.id);
  });

  test("skips accounts with active model lock", () => {
    const a = insert("a@example.com");
    const b = insert("b@example.com");
    setModelLock(a.id, "qwen3-coder-plus", 60_000);
    const picked = selectAccount("qwen3-coder-plus");
    if (picked === null || isRateLimitedResult(picked)) {
      throw new Error("expected Account");
    }
    expect(picked.id).toBe(b.id);
  });

  test("returns RateLimitedResult when all accounts are locked", () => {
    const a = insert("a@example.com");
    const b = insert("b@example.com");
    setModelLock(a.id, "qwen3-coder-plus", 60_000);
    setModelLock(b.id, "qwen3-coder-plus", 30_000);
    const picked = selectAccount("qwen3-coder-plus");
    expect(picked).not.toBeNull();
    expect(isRateLimitedResult(picked!)).toBe(true);
  });

  test("ALL-models lock blocks even model-specific lookups", () => {
    const a = insert("a@example.com");
    setModelLock(a.id, null, 60_000); // "__all"
    const picked = selectAccount("qwen3-coder-plus");
    expect(picked).not.toBeNull();
    expect(isRateLimitedResult(picked!)).toBe(true);
  });
});

describe("selectAccount — round-robin", () => {
  beforeEach(() => setStrategy("round-robin"));

  function pick(): Account {
    const picked = selectAccount("m");
    if (picked === null || isRateLimitedResult(picked)) {
      throw new Error("expected Account, got " + JSON.stringify(picked));
    }
    return picked;
  }

  test("warmup: fills all accounts before entering sticky mode", () => {
    const a = insert("a@example.com");
    const b = insert("b@example.com");

    // Phase 1 — warmup. Both a and b start without last_used_at, so the
    // first two picks should hit each account once (order: a, then b).
    const first = pick();
    expect(first.id).toBe(a.id);
    const second = pick();
    expect(second.id).toBe(b.id);
  });

  test("single account: repeatedly returns the same account", () => {
    const a = insert("solo@example.com");
    const p1 = pick();
    const p2 = pick();
    const p3 = pick();
    expect(p1.id).toBe(a.id);
    expect(p2.id).toBe(a.id);
    expect(p3.id).toBe(a.id);
  });

  test("sticky mode: sticks on most-recent then rotates after limit", async () => {
    const a = insert("a@example.com");
    const b = insert("b@example.com");

    // Warmup fills both. We sleep between picks so last_used_at is
    // strictly ordered (ms-resolution timestamps otherwise tie and the
    // stable sort fallback makes the test order-dependent).
    pick(); // a, consecutive=1
    await Bun.sleep(5);
    pick(); // b, consecutive=1 → b.last_used_at > a.last_used_at
    await Bun.sleep(5);

    // Both have usage now. mostRecent = b.
    // sticky_limit defaults to 3, so successive picks stay on b until
    // b.consecutive_use_count reaches 3.
    const third = pick(); // b, consecutive=2
    await Bun.sleep(5);
    const fourth = pick(); // b, consecutive=3
    await Bun.sleep(5);
    expect(third.id).toBe(b.id);
    expect(fourth.id).toBe(b.id);

    // Fifth pick: b.consecutive_use_count (3) is no longer < sticky_limit,
    // so rotation kicks in → oldest by last_used_at, which is a.
    const fifth = pick();
    expect(fifth.id).toBe(a.id);
  });
});

describe("markAccountUnavailable", () => {
  test("429 locks the account for the current model and bumps backoff", () => {
    const a = insert("a@example.com");
    const decision = markAccountUnavailable(a.id, 429, "rate limit", "qwen3-coder-plus");
    expect(decision.shouldFallback).toBe(true);
    expect(decision.cooldownMs).toBeGreaterThan(0);

    // Subsequent selection should skip a for that model
    const picked = selectAccount("qwen3-coder-plus");
    // Only one account → all locked → RateLimitedResult
    expect(isRateLimitedResult(picked!)).toBe(true);
  });

  test("404 does NOT request a fallback but still locks", () => {
    const a = insert("a@example.com");
    insert("b@example.com");
    const decision = markAccountUnavailable(a.id, 404, "not found", "qwen3-coder-plus");
    expect(decision.shouldFallback).toBe(false);
    expect(decision.cooldownMs).toBeGreaterThan(0);
  });

  test("clearAccountError resets status and backoff", () => {
    const a = insert("a@example.com");
    markAccountUnavailable(a.id, 429, "rate limit", "m");
    clearAccountError(a.id, "m");
    const row = db().query("SELECT * FROM accounts WHERE id = ?").get(a.id) as any;
    expect(row.test_status).toBe("active");
    expect(row.last_error).toBeNull();
    expect(row.backoff_level).toBe(0);
  });
});

// Clean up at the very end so a stray DB doesn't leak into the next test file.
afterEach(() => {
  resetDb();
});
