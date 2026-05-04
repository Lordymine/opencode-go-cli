import { afterEach, describe, expect, test } from "bun:test";
import { CODEX_USAGE_URL } from "../src/constants.js";
import {
  fetchCodexUsageRateLimits,
  mapCodexUsageToStatuslineRateLimits,
} from "../src/providers/openai-usage.js";

const originalFetch = globalThis.fetch;

function installFetchMock(
  impl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
): void {
  globalThis.fetch = impl as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("OpenAI usage", () => {
  test("maps primary and secondary windows to 5h and 7d statusline limits", () => {
    const limits = mapCodexUsageToStatuslineRateLimits(
      {
        rate_limit: {
          primary_window: {
            used_percent: 23.4,
            reset_at: 1_777_893_120,
            limit_window_seconds: 18_000,
          },
          secondary_window: {
            used_percent: 41.2,
            reset_after_seconds: 600,
            limit_window_seconds: 604_800,
          },
        },
      },
      new Date("2026-05-04T10:00:00.000Z"),
    );

    expect(limits).toMatchObject({
      source: "openai-wham",
      five_hour: {
        used_percentage: 23.4,
        resets_at: 1_777_893_120,
        limit_window_seconds: 18_000,
      },
      seven_day: {
        used_percentage: 41.2,
        resets_at: 1_777_889_400,
        limit_window_seconds: 604_800,
      },
    });
  });

  test("treats a weekly primary window as the 7d limit", () => {
    const limits = mapCodexUsageToStatuslineRateLimits({
      rate_limit: {
        primary_window: {
          used_percent: 12,
          limit_window_seconds: 604_800,
        },
      },
    });

    expect(limits?.five_hour).toBeUndefined();
    expect(limits?.seven_day?.used_percentage).toBe(12);
  });

  test("fetches the usage endpoint with OpenAI auth and account headers", async () => {
    let receivedUrl = "";
    let receivedHeaders: Headers | null = null;
    installFetchMock(async (input, init) => {
      receivedUrl = String(input);
      receivedHeaders = new Headers(init?.headers);
      return new Response(
        JSON.stringify({
          rate_limit: {
            primary_window: {
              used_percent: 7,
              limit_window_seconds: 18_000,
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    const limits = await fetchCodexUsageRateLimits({
      accessToken: "access-token",
      accountId: "acct_123",
    });

    expect(receivedUrl).toBe(CODEX_USAGE_URL);
    expect(receivedHeaders?.get("authorization")).toBe("Bearer access-token");
    expect(receivedHeaders?.get("accept")).toBe("application/json");
    expect(receivedHeaders?.get("chatgpt-account-id")).toBe("acct_123");
    expect(limits?.five_hour?.used_percentage).toBe(7);
  });

  test("does not send synthetic local account ids upstream", async () => {
    let receivedHeaders: Headers | null = null;
    installFetchMock(async (_input, init) => {
      receivedHeaders = new Headers(init?.headers);
      return new Response(JSON.stringify({ rate_limit: {} }), { status: 200 });
    });

    await fetchCodexUsageRateLimits({
      accessToken: "access-token",
      accountId: "local_dev",
    });

    expect(receivedHeaders?.has("chatgpt-account-id")).toBe(false);
  });
});
