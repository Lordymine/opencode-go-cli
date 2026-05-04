import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  CODEX_MODELS_CACHE_FILE,
  CODEX_MODELS_CACHE_TTL_MS,
  CODEX_MODELS_CLIENT_VERSION,
  CODEX_MODELS_ENDPOINT,
  CODEX_MODELS_FETCH_TIMEOUT_MS,
  CODEX_RELEASES_LATEST_URL,
  OPENAI_MODELS,
  type Model,
} from "../constants.js";
import { createLogger } from "../logger.js";
import { humanizeModelId } from "./opencode-models.js";

const log = createLogger("[openai-models]");
const CLIENT_VERSION_CACHE_TTL_MS = 60 * 60 * 1000;
const VERSION_RE = /^\d+\.\d+\.\d+$/;

interface CacheFile {
  version: 2;
  fetchedAt: number;
  clientVersion: string;
  models: Model[];
}

interface CodexModelsApiResponse {
  models?: CodexModelEntry[];
}

interface CodexModelEntry {
  slug?: unknown;
  display_name?: unknown;
  description?: unknown;
  supported_in_api?: unknown;
  visibility?: unknown;
  priority?: unknown;
}

export interface GetOpenAIModelsOptions {
  accessToken?: string;
  accountId?: string;
  clientVersion?: string;
  refresh?: boolean;
  offline?: boolean;
}

export interface OpenAIModelsResult {
  models: Model[];
  source: "network" | "cache" | "fallback";
  fetchedAt?: number;
}

let memoryCache: { fetchedAt: number; clientVersion: string; models: Model[] } | null = null;
let clientVersionCache: { fetchedAt: number; version: string } | null = null;

function resolveCacheFile(): string {
  return process.env["OPENCODE_OPENAI_MODELS_CACHE_FILE_OVERRIDE"] || CODEX_MODELS_CACHE_FILE;
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
}

function shouldListModel(entry: CodexModelEntry): boolean {
  if (entry.supported_in_api === false) return false;
  if (entry.visibility === "hide") return false;
  return true;
}

function normalize(raw: CodexModelsApiResponse): Model[] {
  if (!raw || !Array.isArray(raw.models)) return [];
  const models: Array<Model & { priority: number }> = [];
  const seen = new Set<string>();

  for (const entry of raw.models) {
    const id = typeof entry.slug === "string" ? entry.slug.trim() : "";
    if (!id || seen.has(id) || !shouldListModel(entry)) continue;
    seen.add(id);
    const displayName = typeof entry.display_name === "string" && entry.display_name.trim()
      ? entry.display_name.trim()
      : humanizeModelId(id);
    const description = typeof entry.description === "string" ? entry.description.trim() : "";
    models.push({
      id,
      name: displayName,
      description,
      priority: numberValue(entry.priority),
    });
  }

  return models
    .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id))
    .map(({ priority: _priority, ...model }) => model);
}

function isUsableCache(
  cache: CacheFile | typeof memoryCache,
  now: number,
  clientVersion: string | null,
): cache is NonNullable<typeof cache> {
  if (!cache || now - cache.fetchedAt >= CODEX_MODELS_CACHE_TTL_MS) return false;
  return !clientVersion || cache.clientVersion === clientVersion;
}

function readCacheFile(): CacheFile | null {
  try {
    const file = resolveCacheFile();
    if (!existsSync(file)) return null;
    const raw = JSON.parse(readFileSync(file, "utf-8"));
    if (!raw || raw.version !== 2 || typeof raw.fetchedAt !== "number") return null;
    if (typeof raw.clientVersion !== "string" || !raw.clientVersion) return null;
    if (!Array.isArray(raw.models)) return null;
    return raw as CacheFile;
  } catch (err) {
    log.debug(`Cache read failed: ${(err as Error).message}`);
    return null;
  }
}

function writeCacheFile(models: Model[], clientVersion: string): void {
  try {
    const file = resolveCacheFile();
    mkdirSync(dirname(file), { recursive: true });
    const payload: CacheFile = { version: 2, fetchedAt: Date.now(), clientVersion, models };
    writeFileSync(file, JSON.stringify(payload, null, 2));
  } catch (err) {
    log.debug(`Cache write failed: ${(err as Error).message}`);
  }
}

async function fetchFromApi(args: {
  accessToken: string;
  accountId?: string;
  clientVersion: string;
}): Promise<Model[] | null> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    Authorization: `Bearer ${args.accessToken}`,
  };

  if (args.accountId && !args.accountId.startsWith("email_") && !args.accountId.startsWith("local_")) {
    headers["chatgpt-account-id"] = args.accountId;
  }

  const url = new URL(CODEX_MODELS_ENDPOINT);
  url.searchParams.set("client_version", args.clientVersion);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CODEX_MODELS_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { headers, signal: controller.signal });
    if (!response.ok) {
      log.debug(`Fetch returned HTTP ${response.status}`);
      return null;
    }
    const json = await response.json() as CodexModelsApiResponse;
    const models = normalize(json);
    if (models.length === 0) {
      log.debug("Fetch returned empty model list");
      return null;
    }
    return models;
  } catch (err) {
    log.debug(`Fetch failed: ${(err as Error).message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function getLatestCodexClientVersion(): Promise<string> {
  const envVersion = process.env["OPENCODE_CODEX_CLIENT_VERSION"];
  if (envVersion && VERSION_RE.test(envVersion)) return envVersion;

  const now = Date.now();
  if (clientVersionCache && now - clientVersionCache.fetchedAt < CLIENT_VERSION_CACHE_TTL_MS) {
    return clientVersionCache.version;
  }

  try {
    const response = await fetch(CODEX_RELEASES_LATEST_URL, {
      headers: { Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      log.debug(`Codex release fetch returned HTTP ${response.status}`);
      return CODEX_MODELS_CLIENT_VERSION;
    }
    const json = await response.json() as { name?: unknown; tag_name?: unknown };
    const version = typeof json.name === "string" && VERSION_RE.test(json.name)
      ? json.name
      : typeof json.tag_name === "string"
        ? json.tag_name.replace(/^rust-v/, "")
        : "";
    if (!VERSION_RE.test(version)) {
      log.debug("Codex release fetch returned an unexpected version");
      return CODEX_MODELS_CLIENT_VERSION;
    }
    clientVersionCache = { fetchedAt: now, version };
    return version;
  } catch (err) {
    log.debug(`Codex release fetch failed: ${(err as Error).message}`);
    return CODEX_MODELS_CLIENT_VERSION;
  }
}

export async function getOpenAIModels(
  options: GetOpenAIModelsOptions = {},
): Promise<OpenAIModelsResult> {
  const { accessToken, accountId, refresh = false, offline = false } = options;
  const now = Date.now();
  const clientVersion = !offline && accessToken
    ? options.clientVersion ?? await getLatestCodexClientVersion()
    : null;

  if (!refresh && isUsableCache(memoryCache, now, clientVersion)) {
    return { models: memoryCache.models, source: "cache", fetchedAt: memoryCache.fetchedAt };
  }

  if (!refresh) {
    const disk = readCacheFile();
    if (isUsableCache(disk, now, clientVersion)) {
      memoryCache = {
        fetchedAt: disk.fetchedAt,
        clientVersion: disk.clientVersion,
        models: disk.models,
      };
      return { models: disk.models, source: "cache", fetchedAt: disk.fetchedAt };
    }
  }

  if (!accessToken || offline) {
    const disk = readCacheFile();
    if (disk) {
      memoryCache = {
        fetchedAt: disk.fetchedAt,
        clientVersion: disk.clientVersion,
        models: disk.models,
      };
      return { models: disk.models, source: "cache", fetchedAt: disk.fetchedAt };
    }
    return { models: OPENAI_MODELS, source: "fallback" };
  }

  const fresh = await fetchFromApi({ accessToken, accountId, clientVersion: clientVersion! });
  if (fresh) {
    memoryCache = { fetchedAt: Date.now(), clientVersion: clientVersion!, models: fresh };
    writeCacheFile(fresh, clientVersion!);
    return { models: fresh, source: "network", fetchedAt: memoryCache.fetchedAt };
  }

  const disk = readCacheFile();
  if (disk) {
    memoryCache = {
      fetchedAt: disk.fetchedAt,
      clientVersion: disk.clientVersion,
      models: disk.models,
    };
    return { models: disk.models, source: "cache", fetchedAt: disk.fetchedAt };
  }
  return { models: OPENAI_MODELS, source: "fallback" };
}

export function clearOpenAIModelsCache(): void {
  memoryCache = null;
  try {
    const file = resolveCacheFile();
    if (existsSync(file)) unlinkSync(file);
  } catch {}
}

export function __resetOpenAIModelsMemoryCacheForTests(): void {
  memoryCache = null;
  clientVersionCache = null;
}

export const __openAIModelsForTests = {
  normalize,
  getLatestCodexClientVersion,
};
