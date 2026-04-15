// ============================================================
// Rotator — fallback decision (status code → cooldown)
// ============================================================
//
// Pure function, no DB. Maps an upstream HTTP status + body text
// to a cooldown decision. Tested in isolation.

import {
  QWEN_COOLDOWN_NOT_FOUND_MS,
  QWEN_COOLDOWN_PAYMENT_MS,
  QWEN_COOLDOWN_TRANSIENT_MS,
  QWEN_COOLDOWN_UNAUTHORIZED_MS,
  QWEN_RATE_LIMIT_BACKOFF_BASE_MS,
  QWEN_RATE_LIMIT_BACKOFF_MAX_LEVEL,
  QWEN_RATE_LIMIT_BACKOFF_MAX_MS,
} from "../constants.js";

export interface FallbackDecision {
  /** Whether the rotator should advance to another account */
  shouldFallback: boolean;
  /** Cooldown to apply to the failing account (0 = no lock) */
  cooldownMs: number;
  /** New backoff_level for the account, if bumped */
  newBackoffLevel?: number;
}

function exponentialCooldown(level: number): number {
  return Math.min(
    QWEN_RATE_LIMIT_BACKOFF_BASE_MS * Math.pow(2, level),
    QWEN_RATE_LIMIT_BACKOFF_MAX_MS,
  );
}

export function checkFallbackError(
  status: number,
  errorText: string,
  backoffLevel = 0,
): FallbackDecision {
  const lower = errorText.toLowerCase();

  if (status === 401) {
    return {
      shouldFallback: true,
      cooldownMs: QWEN_COOLDOWN_UNAUTHORIZED_MS,
    };
  }

  if (status === 402 || status === 403) {
    return { shouldFallback: true, cooldownMs: QWEN_COOLDOWN_PAYMENT_MS };
  }

  if (status === 404) {
    return { shouldFallback: false, cooldownMs: QWEN_COOLDOWN_NOT_FOUND_MS };
  }

  if (
    status === 429 ||
    lower.includes("rate limit") ||
    lower.includes("quota exceeded") ||
    lower.includes("too many requests")
  ) {
    const newLevel = Math.min(
      backoffLevel + 1,
      QWEN_RATE_LIMIT_BACKOFF_MAX_LEVEL,
    );
    return {
      shouldFallback: true,
      cooldownMs: exponentialCooldown(backoffLevel),
      newBackoffLevel: newLevel,
    };
  }

  if (status >= 500 || lower.includes("timeout")) {
    return { shouldFallback: true, cooldownMs: QWEN_COOLDOWN_TRANSIENT_MS };
  }

  if (lower.includes("request not allowed")) {
    return {
      shouldFallback: true,
      cooldownMs: QWEN_COOLDOWN_UNAUTHORIZED_MS,
    };
  }

  return { shouldFallback: false, cooldownMs: 0 };
}

export function formatDuration(ms: number): string {
  if (ms <= 0) return "expired";
  if (ms < 60_000) return `${Math.ceil(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.ceil(ms / 60_000)}m`;
  return `${Math.ceil(ms / 3_600_000)}h`;
}
