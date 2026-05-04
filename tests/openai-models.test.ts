import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CODEX_MODELS_CLIENT_VERSION,
  CODEX_MODELS_ENDPOINT,
  OPENAI_MODELS,
} from "../src/constants.js";
import {
  __resetOpenAIModelsMemoryCacheForTests,
  __openAIModelsForTests,
  clearOpenAIModelsCache,
  getOpenAIModels,
} from "../src/providers/openai-models.js";

let tmpDir: string;
let cacheFile: string;
const originalFetch = globalThis.fetch;

function installFetchMock(
  impl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
): void {
  globalThis.fetch = impl as typeof fetch;
}

function restoreFetch(): void {
  globalThis.fetch = originalFetch;
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "openai-models-test-"));
  cacheFile = join(tmpDir, "cache.json");
  process.env["OPENCODE_OPENAI_MODELS_CACHE_FILE_OVERRIDE"] = cacheFile;
  __resetOpenAIModelsMemoryCacheForTests();
});

afterEach(() => {
  delete process.env["OPENCODE_OPENAI_MODELS_CACHE_FILE_OVERRIDE"];
  restoreFetch();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("getOpenAIModels", () => {
  test("fetches ChatGPT Codex models with auth and account headers", async () => {
    let receivedUrl: URL | null = null;
    let receivedHeaders: Headers | null = null;
    installFetchMock(async (input, init) => {
      receivedUrl = new URL(String(input));
      receivedHeaders = new Headers(init?.headers);
      return new Response(
        JSON.stringify({
          models: [
            {
              slug: "codex-auto-review",
              display_name: "Codex Auto Review",
              description: "Hidden",
              supported_in_api: true,
              visibility: "hide",
              priority: 1,
            },
            {
              slug: "gpt-5.4-mini",
              display_name: "GPT-5.4-Mini",
              description: "Small and fast",
              supported_in_api: true,
              visibility: "list",
              priority: 4,
            },
            {
              slug: "gpt-5.4",
              display_name: "gpt-5.4",
              description: "Strong model",
              supported_in_api: true,
              visibility: "list",
              priority: 2,
            },
            {
              slug: "internal-model",
              display_name: "Internal",
              supported_in_api: false,
              visibility: "list",
              priority: 3,
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    const result = await getOpenAIModels({
      accessToken: "access-token",
      accountId: "acct_123",
      clientVersion: CODEX_MODELS_CLIENT_VERSION,
    });

    expect(result.source).toBe("network");
    expect(receivedUrl?.origin + receivedUrl?.pathname).toBe(CODEX_MODELS_ENDPOINT);
    expect(receivedUrl?.searchParams.get("client_version")).toBe(CODEX_MODELS_CLIENT_VERSION);
    expect(receivedHeaders?.get("authorization")).toBe("Bearer access-token");
    expect(receivedHeaders?.get("accept")).toBe("application/json");
    expect(receivedHeaders?.get("chatgpt-account-id")).toBe("acct_123");
    expect(result.models).toEqual([
      { id: "gpt-5.4", name: "gpt-5.4", description: "Strong model" },
      { id: "gpt-5.4-mini", name: "GPT-5.4-Mini", description: "Small and fast" },
    ]);
    expect(existsSync(cacheFile)).toBe(true);
  });

  test("uses disk cache on second call within TTL", async () => {
    let calls = 0;
    installFetchMock(async () => {
      calls++;
      return new Response(
        JSON.stringify({
          models: [
            {
              slug: "gpt-5.2",
              display_name: "gpt-5.2",
              description: "Cached model",
              priority: 10,
            },
          ],
        }),
        { status: 200 },
      );
    });

    await getOpenAIModels({ accessToken: "access-token", clientVersion: CODEX_MODELS_CLIENT_VERSION });
    __resetOpenAIModelsMemoryCacheForTests();
    const second = await getOpenAIModels({
      accessToken: "access-token",
      clientVersion: CODEX_MODELS_CLIENT_VERSION,
    });

    expect(calls).toBe(1);
    expect(second.source).toBe("cache");
    expect(second.models[0]?.id).toBe("gpt-5.2");
  });

  test("falls back to static models without auth and no cache", async () => {
    installFetchMock(async () => {
      throw new Error("fetch should not be called");
    });

    const result = await getOpenAIModels();

    expect(result.source).toBe("fallback");
    expect(result.models).toBe(OPENAI_MODELS);
  });

  test("uses stale cache when network refresh fails", async () => {
    installFetchMock(async () =>
      new Response(
        JSON.stringify({
          models: [
            {
              slug: "gpt-5.4",
              display_name: "gpt-5.4",
              description: "Fresh enough",
              priority: 1,
            },
          ],
        }),
        { status: 200 },
      ),
    );
    await getOpenAIModels({ accessToken: "access-token", clientVersion: CODEX_MODELS_CLIENT_VERSION });
    __resetOpenAIModelsMemoryCacheForTests();

    installFetchMock(async () => new Response("nope", { status: 500 }));
    const result = await getOpenAIModels({
      accessToken: "access-token",
      clientVersion: CODEX_MODELS_CLIENT_VERSION,
      refresh: true,
    });

    expect(result.source).toBe("cache");
    expect(result.models[0]?.id).toBe("gpt-5.4");
  });

  test("clearOpenAIModelsCache removes cached data", async () => {
    installFetchMock(async () =>
      new Response(
        JSON.stringify({
          models: [{ slug: "gpt-5.4", display_name: "gpt-5.4", priority: 1 }],
        }),
        { status: 200 },
      ),
    );

    await getOpenAIModels({ accessToken: "access-token", clientVersion: CODEX_MODELS_CLIENT_VERSION });
    expect(existsSync(cacheFile)).toBe(true);
    clearOpenAIModelsCache();
    expect(existsSync(cacheFile)).toBe(false);
  });

  test("fetches the latest Codex client version from GitHub releases", async () => {
    installFetchMock(async () =>
      new Response(
        JSON.stringify({ name: "0.128.0", tag_name: "rust-v0.128.0" }),
        { status: 200 },
      ),
    );

    const version = await __openAIModelsForTests.getLatestCodexClientVersion();

    expect(version).toBe("0.128.0");
  });
});
