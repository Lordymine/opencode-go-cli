import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  __resetMemoryCacheForTests,
  clearOpenCodeModelsCache,
  getOpenCodeModels,
  humanizeModelId,
} from "../src/providers/opencode-models.js";
import { MODELS } from "../src/constants.js";

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
  tmpDir = mkdtempSync(join(tmpdir(), "opencode-models-test-"));
  cacheFile = join(tmpDir, "cache.json");
  process.env["OPENCODE_MODELS_CACHE_FILE_OVERRIDE"] = cacheFile;
  __resetMemoryCacheForTests();
});

afterEach(() => {
  delete process.env["OPENCODE_MODELS_CACHE_FILE_OVERRIDE"];
  restoreFetch();
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
});

describe("humanizeModelId", () => {
  test("capitalizes known vendor segments", () => {
    expect(humanizeModelId("minimax-m2.7")).toBe("MiniMax m2.7");
    expect(humanizeModelId("kimi-k2.6")).toBe("Kimi k2.6");
    expect(humanizeModelId("glm-5.1")).toBe("GLM 5.1");
    expect(humanizeModelId("gpt-5.4-pro")).toBe("GPT 5.4 Pro");
  });

  test("joins consecutive numeric segments with dots", () => {
    expect(humanizeModelId("claude-opus-4-7")).toBe("Claude Opus 4.7");
    expect(humanizeModelId("claude-3-5-haiku")).toBe("Claude 3.5 Haiku");
    expect(humanizeModelId("claude-haiku-4-5")).toBe("Claude Haiku 4.5");
  });

  test("strips -free suffix and appends (Free) tag", () => {
    expect(humanizeModelId("minimax-m2.5-free")).toBe("MiniMax m2.5 (Free)");
    expect(humanizeModelId("nemotron-3-super-free")).toBe("Nemotron 3 super (Free)");
  });

  test("preserves unknown segments untouched", () => {
    expect(humanizeModelId("big-pickle")).toBe("big pickle");
  });
});

describe("getOpenCodeModels", () => {
  test("fetches from network when no cache", async () => {
    installFetchMock(async () =>
      new Response(
        JSON.stringify({
          object: "list",
          data: [
            { id: "minimax-m2.7", object: "model", owned_by: "opencode" },
            { id: "kimi-k2.6", object: "model", owned_by: "opencode" },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const result = await getOpenCodeModels();
    expect(result.source).toBe("network");
    expect(result.models.length).toBe(2);
    expect(result.models[0]?.id).toBe("minimax-m2.7");
    expect(result.models[0]?.name).toBe("MiniMax m2.7");
    expect(existsSync(cacheFile)).toBe(true);
  });

  test("skips empty responses and falls back", async () => {
    installFetchMock(async () =>
      new Response(JSON.stringify({ object: "list", data: [] }), { status: 200 }),
    );
    const result = await getOpenCodeModels();
    expect(result.source).toBe("fallback");
    expect(result.models).toBe(MODELS);
  });

  test("falls back to static MODELS when fetch fails with no cache", async () => {
    installFetchMock(async () => {
      throw new Error("network down");
    });
    const result = await getOpenCodeModels();
    expect(result.source).toBe("fallback");
    expect(result.models).toBe(MODELS);
  });

  test("uses disk cache on second call within TTL", async () => {
    let calls = 0;
    installFetchMock(async () => {
      calls++;
      return new Response(
        JSON.stringify({
          object: "list",
          data: [{ id: "glm-5", object: "model", owned_by: "opencode" }],
        }),
        { status: 200 },
      );
    });
    await getOpenCodeModels();
    __resetMemoryCacheForTests();
    const second = await getOpenCodeModels();
    expect(calls).toBe(1);
    expect(second.source).toBe("cache");
    expect(second.models[0]?.id).toBe("glm-5");
  });

  test("refresh=true bypasses cache", async () => {
    writeFileSync(
      cacheFile,
      JSON.stringify({
        version: 1,
        fetchedAt: Date.now(),
        models: [{ id: "cached", name: "Cached", description: "" }],
      }),
    );
    installFetchMock(async () =>
      new Response(
        JSON.stringify({
          object: "list",
          data: [{ id: "fresh", object: "model", owned_by: "opencode" }],
        }),
        { status: 200 },
      ),
    );
    const result = await getOpenCodeModels({ refresh: true });
    expect(result.source).toBe("network");
    expect(result.models[0]?.id).toBe("fresh");
  });

  test("falls back to disk cache when fetch fails", async () => {
    writeFileSync(
      cacheFile,
      JSON.stringify({
        version: 1,
        fetchedAt: Date.now(),
        models: [{ id: "cached-only", name: "Cached Only", description: "" }],
      }),
    );
    // Cache is fresh → will be used before fetch. Expire it to force the
    // fetch attempt:
    const stale = {
      version: 1,
      fetchedAt: Date.now() - 2 * 60 * 60 * 1000, // 2h old
      models: [{ id: "cached-only", name: "Cached Only", description: "" }],
    };
    writeFileSync(cacheFile, JSON.stringify(stale));
    installFetchMock(async () => {
      throw new Error("offline");
    });
    const result = await getOpenCodeModels();
    expect(result.source).toBe("cache");
    expect(result.models[0]?.id).toBe("cached-only");
  });

  test("non-200 response treated as failure", async () => {
    installFetchMock(async () =>
      new Response("server error", { status: 500 }),
    );
    const result = await getOpenCodeModels();
    expect(result.source).toBe("fallback");
  });

  test("normalize deduplicates and drops invalid entries", async () => {
    installFetchMock(async () =>
      new Response(
        JSON.stringify({
          object: "list",
          data: [
            { id: "glm-5", owned_by: "opencode" },
            { id: "glm-5", owned_by: "opencode" }, // duplicate
            { id: "", owned_by: "opencode" }, // empty id
            { object: "model" }, // missing id
            { id: "kimi-k2.6", owned_by: "opencode" },
          ],
        }),
        { status: 200 },
      ),
    );
    const result = await getOpenCodeModels();
    expect(result.models.length).toBe(2);
    expect(result.models.map((m) => m.id)).toEqual(["glm-5", "kimi-k2.6"]);
  });

  test("offline=true skips network and returns cache or fallback", async () => {
    let fetchCalled = false;
    installFetchMock(async () => {
      fetchCalled = true;
      return new Response("{}", { status: 200 });
    });
    const result = await getOpenCodeModels({ offline: true });
    expect(fetchCalled).toBe(false);
    expect(result.source).toBe("fallback");
  });

  test("clearOpenCodeModelsCache removes disk cache", async () => {
    installFetchMock(async () =>
      new Response(
        JSON.stringify({
          object: "list",
          data: [{ id: "glm-5", owned_by: "opencode" }],
        }),
        { status: 200 },
      ),
    );
    await getOpenCodeModels();
    expect(existsSync(cacheFile)).toBe(true);
    clearOpenCodeModelsCache();
    expect(existsSync(cacheFile)).toBe(false);
  });
});
