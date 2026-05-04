import { CODEX_USAGE_URL } from "../constants.js";
import {
  type StatuslineRateLimits,
  updateStatuslineRateLimits,
} from "../statusline/state.js";

interface UsageWindowPayload {
  used_percent?: number | null;
  reset_at?: number | null;
  limit_window_seconds?: number | null;
  reset_after_seconds?: number | null;
}

interface UsagePayload {
  rate_limit?: {
    primary_window?: UsageWindowPayload | null;
    secondary_window?: UsageWindowPayload | null;
  } | null;
  plan_type?: string | null;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function mapResetAt(window: UsageWindowPayload, nowSeconds: number): number | undefined {
  const resetAt = numberValue(window.reset_at);
  if (resetAt !== undefined) return resetAt;
  const resetAfter = numberValue(window.reset_after_seconds);
  return resetAfter !== undefined ? nowSeconds + Math.max(0, resetAfter) : undefined;
}

function mapWindow(
  window: UsageWindowPayload | null | undefined,
  nowSeconds: number,
): StatuslineRateLimits["five_hour"] {
  if (!window || typeof window.used_percent !== "number") return undefined;
  return {
    used_percentage: window.used_percent,
    resets_at: mapResetAt(window, nowSeconds),
    limit_window_seconds: numberValue(window.limit_window_seconds),
  };
}

export function mapCodexUsageToStatuslineRateLimits(
  payload: UsagePayload,
  now = new Date(),
): StatuslineRateLimits | null {
  const rateLimit = payload.rate_limit;
  if (!rateLimit) return null;

  const nowSeconds = Math.floor(now.getTime() / 1000);
  const primary = rateLimit.primary_window ?? null;
  const secondary = rateLimit.secondary_window ?? null;
  const limits: StatuslineRateLimits = {
    source: "openai-wham",
    updatedAt: now.toISOString(),
  };

  if (primary?.limit_window_seconds === 604_800) {
    limits.seven_day = mapWindow(primary, nowSeconds);
  } else {
    limits.five_hour = mapWindow(primary, nowSeconds);
  }

  const secondaryWindow = mapWindow(secondary, nowSeconds);
  if (secondaryWindow) {
    limits.seven_day = secondaryWindow;
  }

  return limits.five_hour || limits.seven_day ? limits : null;
}

export async function fetchCodexUsageRateLimits(args: {
  accessToken: string;
  accountId?: string;
  signal?: AbortSignal;
}): Promise<StatuslineRateLimits | null> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    Authorization: `Bearer ${args.accessToken}`,
  };

  if (args.accountId && !args.accountId.startsWith("email_") && !args.accountId.startsWith("local_")) {
    headers["chatgpt-account-id"] = args.accountId;
  }

  const response = await fetch(CODEX_USAGE_URL, {
    method: "GET",
    headers,
    signal: args.signal,
  });

  if (!response.ok) {
    throw new Error(`Codex usage fetch failed: HTTP ${response.status}`);
  }

  const payload = await response.json() as UsagePayload;
  return mapCodexUsageToStatuslineRateLimits(payload);
}

export async function refreshStatuslineCodexUsage(args: {
  accessToken: string;
  accountId?: string;
}): Promise<boolean> {
  try {
    const limits = await fetchCodexUsageRateLimits({
      accessToken: args.accessToken,
      accountId: args.accountId,
      signal: AbortSignal.timeout(10_000),
    });
    if (!limits) return false;
    updateStatuslineRateLimits(limits);
    return true;
  } catch {
    return false;
  }
}
