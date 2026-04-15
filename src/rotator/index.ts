// ============================================================
// Rotator — account selection and error handling
// ============================================================

import { db, getStickyLimit, getStrategy } from "../db/index.js";
import {
  updateAccount,
  type Account,
} from "../db/accounts.js";
import {
  getEarliestLockUntil,
  isModelLockActive,
  clearModelLock,
  setModelLock,
} from "../db/locks.js";
import { checkFallbackError, formatDuration } from "./fallback.js";

export interface RateLimitedResult {
  allRateLimited: true;
  retryAfter: string; // ISO
  retryAfterHuman: string;
}

export function isRateLimitedResult(
  v: Account | RateLimitedResult | null,
): v is RateLimitedResult {
  return (
    typeof v === "object" && v !== null && "allRateLimited" in v && v.allRateLimited === true
  );
}

/**
 * Pick the next usable account for a given model, applying the configured
 * rotation strategy and honoring model locks.
 *
 * Returns:
 *   - An Account on success
 *   - RateLimitedResult if every candidate is currently locked
 *   - null if there are simply no active accounts at all
 */
export function selectAccount(
  model: string | null,
  excludeIds?: Set<string>,
): Account | RateLimitedResult | null {
  const strategy = getStrategy();
  const stickyLimit = getStickyLimit();

  const all = db()
    .query("SELECT * FROM accounts WHERE is_active = 1 ORDER BY priority ASC")
    .all() as Account[];

  const candidates = all.filter((a) => {
    if (excludeIds?.has(a.id)) return false;
    if (isModelLockActive(a.id, model)) return false;
    return true;
  });

  if (candidates.length === 0) {
    const anyLocked = all.some(
      (a) => !excludeIds?.has(a.id) && isModelLockActive(a.id, model),
    );
    if (anyLocked) {
      const earliest = getEarliestLockUntil(model);
      const retryAfter = earliest ?? new Date(Date.now() + 60_000).toISOString();
      const diff = earliest
        ? new Date(earliest).getTime() - Date.now()
        : 60_000;
      return {
        allRateLimited: true,
        retryAfter,
        retryAfterHuman: `reset after ${formatDuration(diff)}`,
      };
    }
    return null;
  }

  let selected: Account;

  if (strategy === "round-robin") {
    const withUsage = candidates.filter((a) => a.last_used_at);
    const withoutUsage = candidates.filter((a) => !a.last_used_at);
    if (withoutUsage.length > 0) {
      // Prefer never-used accounts first (warm up the pool).
      selected = withoutUsage[0]!;
    } else {
      const oldestFirst = [...withUsage].sort(
        (a, b) =>
          new Date(a.last_used_at!).getTime() -
          new Date(b.last_used_at!).getTime(),
      );
      const mostRecent = [...withUsage].sort(
        (a, b) =>
          new Date(b.last_used_at!).getTime() -
          new Date(a.last_used_at!).getTime(),
      )[0]!;
      // Stay sticky with the most recently used account until we hit the
      // sticky limit, then rotate to the oldest.
      selected =
        mostRecent.consecutive_use_count < stickyLimit
          ? mostRecent
          : (oldestFirst[0] ?? candidates[0]!);
    }
  } else {
    // fill-first: always grab the highest-priority available account.
    selected = candidates[0]!;
  }

  const isSticky =
    strategy === "round-robin" &&
    selected.last_used_at !== null &&
    selected.consecutive_use_count < stickyLimit;

  updateAccount(selected.id, {
    last_used_at: new Date().toISOString(),
    consecutive_use_count: isSticky ? selected.consecutive_use_count + 1 : 1,
  });

  return selected;
}

export interface MarkUnavailableResult {
  shouldFallback: boolean;
  cooldownMs: number;
}

/**
 * Record an error against an account. If the decision says we should
 * fall back, a model lock is placed so the rotator skips this account
 * on the next attempt.
 */
export function markAccountUnavailable(
  accountId: string,
  status: number,
  errorText: string,
  model: string | null,
): MarkUnavailableResult {
  const row = db()
    .query("SELECT backoff_level FROM accounts WHERE id = ?")
    .get(accountId) as { backoff_level: number } | undefined;
  const decision = checkFallbackError(status, errorText, row?.backoff_level ?? 0);

  const patch: Record<string, unknown> = {
    last_error: errorText.slice(0, 500),
    error_code: status,
    last_error_at: new Date().toISOString(),
  };

  if (decision.cooldownMs > 0) {
    patch.test_status = "unavailable";
    setModelLock(accountId, model, decision.cooldownMs);
  }

  if (decision.newBackoffLevel !== undefined) {
    patch.backoff_level = decision.newBackoffLevel;
  }

  updateAccount(accountId, patch);

  return {
    shouldFallback: decision.shouldFallback,
    cooldownMs: decision.cooldownMs,
  };
}

export function clearAccountError(
  accountId: string,
  model: string | null = null,
): void {
  updateAccount(accountId, {
    test_status: "active",
    last_error: null,
    error_code: null,
    backoff_level: 0,
  });
  if (model) clearModelLock(accountId, model);
}
