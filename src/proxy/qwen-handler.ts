// ============================================================
// Qwen Handler — orchestrates account selection, refresh, and
// rotation-on-error for a single /v1/messages request.
// ============================================================
//
// Key invariant (matches gqwen): rotation only happens BEFORE the
// first chunk of the upstream response is streamed to the client.
// Once bytes start flowing through, any mid-stream failure is
// reported as-is — we can't rewind the client's state.

import {
  QWEN_MAX_ROTATION_ATTEMPTS,
  buildQwenChatCompletionsUrl,
  buildQwenHeaders,
} from "../constants.js";
import { createLogger } from "../logger.js";
import { checkAndRefreshAccount } from "../auth/qwen/refresh.js";
import {
  clearAccountError,
  isRateLimitedResult,
  markAccountUnavailable,
  selectAccount,
  type RateLimitedResult,
} from "../rotator/index.js";
import type { Account } from "../db/accounts.js";
import { convertAnthropicRequestToOpenAI } from "./request-conversion.js";
import { convertOpenAIResponseToAnthropic } from "./response-conversion.js";
import { streamOpenAIToAnthropic } from "./stream-conversion.js";

const logger = createLogger("[qwen]");

export interface QwenHandlerResult {
  response: Response;
}

/**
 * Handle a Claude Code /v1/messages request against Qwen's OpenAI-compatible
 * endpoint, rotating accounts on recoverable errors (401/429/5xx/etc).
 */
export async function handleQwenRequest(
  anthropicBody: any,
): Promise<Response> {
  const isStreaming = anthropicBody.stream === true;
  const model: string | null = anthropicBody.model ?? null;
  const openAIBody = convertAnthropicRequestToOpenAI(anthropicBody);

  const excludeIds = new Set<string>();
  let lastError: { status: number; text: string } | null = null;
  let lastRateLimited: RateLimitedResult | null = null;

  for (let attempt = 0; attempt < QWEN_MAX_ROTATION_ATTEMPTS; attempt++) {
    const picked = selectAccount(model, excludeIds);

    if (picked === null) {
      // Nothing in the pool — either empty DB or all excluded
      return errorResponse(
        503,
        "no_accounts",
        "No Qwen accounts available. Run `opencode-go --qwen-login` to add one.",
      );
    }

    if (isRateLimitedResult(picked)) {
      lastRateLimited = picked;
      break;
    }

    const account: Account = picked;
    let refreshed: Account;
    try {
      refreshed = await checkAndRefreshAccount(account);
    } catch (err) {
      logger.warn(`Refresh threw for ${shortId(account.id)}: ${errMsg(err)}`);
      refreshed = account;
    }

    const url = buildQwenChatCompletionsUrl(refreshed.resource_url);
    const headers = buildQwenHeaders(refreshed.access_token, isStreaming);
    const body = JSON.stringify({ ...openAIBody, stream: isStreaming });

    logger.debug(
      `attempt ${attempt + 1}/${QWEN_MAX_ROTATION_ATTEMPTS} → account=${shortId(account.id)} model=${model} stream=${isStreaming}`,
    );

    let upstream: Response;
    try {
      upstream = await fetch(url, { method: "POST", headers, body });
    } catch (err) {
      const msg = errMsg(err);
      logger.warn(`Network error on ${shortId(account.id)}: ${msg}`);
      const decision = markAccountUnavailable(account.id, 599, msg, model);
      if (decision.shouldFallback) {
        excludeIds.add(account.id);
        lastError = { status: 599, text: msg };
        continue;
      }
      return errorResponse(502, "upstream_network_error", msg);
    }

    if (!upstream.ok) {
      const errText = await upstream.text().catch(() => "");
      logger.warn(
        `Upstream ${upstream.status} on ${shortId(account.id)}: ${errText.slice(0, 120)}`,
      );
      const decision = markAccountUnavailable(
        account.id,
        upstream.status,
        errText,
        model,
      );
      lastError = { status: upstream.status, text: errText };
      if (decision.shouldFallback) {
        excludeIds.add(account.id);
        continue;
      }
      return errorResponse(upstream.status, "api_error", errText);
    }

    // First-byte success. Clear any prior error state and proceed.
    clearAccountError(account.id, model);
    logger.info(
      `ok ← ${shortId(account.id)} (${upstream.status}) stream=${isStreaming}`,
    );

    if (isStreaming) {
      return wrapStream(upstream);
    }

    const data = (await upstream.json()) as any;
    const anthropicResponse = convertOpenAIResponseToAnthropic(data);
    return new Response(JSON.stringify(anthropicResponse), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Exhausted rotation attempts
  if (lastRateLimited) {
    return errorResponse(
      429,
      "rate_limit",
      `All Qwen accounts are cooling down. ${lastRateLimited.retryAfterHuman}`,
      { "Retry-After": secondsUntil(lastRateLimited.retryAfter) },
    );
  }

  if (lastError) {
    return errorResponse(
      lastError.status >= 400 && lastError.status < 600
        ? lastError.status
        : 502,
      "all_accounts_failed",
      `Tried ${QWEN_MAX_ROTATION_ATTEMPTS} accounts, last error: ${lastError.text.slice(0, 300)}`,
    );
  }

  return errorResponse(
    503,
    "no_accounts",
    "No Qwen accounts could serve the request.",
  );
}

// ─── helpers ──────────────────────────────────────────────

function wrapStream(upstream: Response): Response {
  const generator = streamOpenAIToAnthropic(upstream);
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      try {
        for await (const chunk of generator) {
          controller.enqueue(encoder.encode(chunk));
        }
      } catch (e) {
        logger.error(`stream error: ${errMsg(e)}`);
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

function errorResponse(
  status: number,
  type: string,
  message: string,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(
    JSON.stringify({ type: "error", error: { type, message } }),
    {
      status,
      headers: { "Content-Type": "application/json", ...extraHeaders },
    },
  );
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function secondsUntil(iso: string): string {
  const diff = new Date(iso).getTime() - Date.now();
  return String(Math.max(1, Math.ceil(diff / 1000)));
}
