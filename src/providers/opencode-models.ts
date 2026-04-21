// ============================================================
// OpenCode Go — dynamic model catalog
//
// Fetches the live list of models from https://opencode.ai/zen/v1/models
// (OpenAI-compatible `object: "list"` payload). Caches the normalized
// result on disk with a 1h TTL. Falls back to the static `MODELS`
// snapshot in `constants.ts` when the fetch fails.
// ============================================================

import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import {
  MODELS,
  OPENCODE_MODELS_CACHE_FILE,
  OPENCODE_MODELS_CACHE_TTL_MS,
  OPENCODE_MODELS_ENDPOINT,
  OPENCODE_MODELS_FETCH_TIMEOUT_MS,
  type Model,
} from "../constants.js";
import { createLogger } from "../logger.js";

function resolveCacheFile(): string {
  return process.env["OPENCODE_MODELS_CACHE_FILE_OVERRIDE"] || OPENCODE_MODELS_CACHE_FILE;
}

const log = createLogger("[opencode-models]");

interface CacheFile {
  version: 1;
  fetchedAt: number;
  models: Model[];
}

interface ModelsApiResponse {
  object?: string;
  data?: Array<{ id?: unknown; owned_by?: unknown }>;
}

let memoryCache: { fetchedAt: number; models: Model[] } | null = null;

// Capitalization map for known vendor / variant segments. Anything not
// in this map falls through untouched (preserves version strings like
// "4.7", "m2.5", etc.).
const SEGMENT_MAP: Record<string, string> = {
  gpt: "GPT",
  glm: "GLM",
  claude: "Claude",
  gemini: "Gemini",
  kimi: "Kimi",
  qwen: "Qwen",
  ling: "Ling",
  minimax: "MiniMax",
  nemotron: "Nemotron",
  trinity: "Trinity",
  opus: "Opus",
  sonnet: "Sonnet",
  haiku: "Haiku",
  pro: "Pro",
  flash: "Flash",
  mini: "Mini",
  nano: "Nano",
  max: "Max",
  turbo: "Turbo",
  plus: "Plus",
  codex: "Codex",
  coder: "Coder",
  spark: "Spark",
  large: "Large",
  preview: "Preview",
};

const NUMERIC_SEGMENT = /^\d+(?:\.\d+)*$/;

export function humanizeModelId(id: string): string {
  const segments = id.split("-");
  const isFree = segments.at(-1) === "free";
  const core = isFree ? segments.slice(0, -1) : segments;
  const pretty = core.map((seg) => SEGMENT_MAP[seg.toLowerCase()] ?? seg);
  // Join consecutive numeric segments with `.` so "claude-opus-4-7" reads
  // as "Claude Opus 4.7" instead of "Claude Opus 4 7".
  let out = "";
  for (let i = 0; i < pretty.length; i++) {
    const seg = pretty[i]!;
    if (i === 0) {
      out = seg;
      continue;
    }
    const joinWithDot = NUMERIC_SEGMENT.test(seg) && NUMERIC_SEGMENT.test(core[i - 1]!);
    out += joinWithDot ? `.${seg}` : ` ${seg}`;
  }
  out = out.trim();
  return isFree ? `${out} (Free)` : out;
}

function buildDescription(raw: { id: string; owned_by?: string }): string {
  if (raw.id.endsWith("-free")) return "Free tier";
  if (raw.owned_by && raw.owned_by !== "opencode") return `Provided by ${raw.owned_by}`;
  return "";
}

function normalize(raw: ModelsApiResponse): Model[] {
  if (!raw || !Array.isArray(raw.data)) return [];
  const out: Model[] = [];
  const seen = new Set<string>();
  for (const entry of raw.data) {
    if (!entry || typeof entry.id !== "string" || entry.id.length === 0) continue;
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    const owned = typeof entry.owned_by === "string" ? entry.owned_by : undefined;
    out.push({
      id: entry.id,
      name: humanizeModelId(entry.id),
      description: buildDescription({ id: entry.id, owned_by: owned }),
    });
  }
  return out;
}

function readCacheFile(): CacheFile | null {
  try {
    if (!existsSync(resolveCacheFile())) return null;
    const raw = JSON.parse(readFileSync(resolveCacheFile(), "utf-8"));
    if (!raw || raw.version !== 1 || typeof raw.fetchedAt !== "number") return null;
    if (!Array.isArray(raw.models)) return null;
    return raw as CacheFile;
  } catch (err) {
    log.debug(`Cache read failed: ${(err as Error).message}`);
    return null;
  }
}

function writeCacheFile(models: Model[]): void {
  try {
    mkdirSync(dirname(resolveCacheFile()), { recursive: true });
    const payload: CacheFile = { version: 1, fetchedAt: Date.now(), models };
    writeFileSync(resolveCacheFile(), JSON.stringify(payload, null, 2));
  } catch (err) {
    log.debug(`Cache write failed: ${(err as Error).message}`);
  }
}

async function fetchFromApi(): Promise<Model[] | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OPENCODE_MODELS_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(OPENCODE_MODELS_ENDPOINT, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    if (!res.ok) {
      log.debug(`Fetch returned HTTP ${res.status}`);
      return null;
    }
    const json = (await res.json()) as ModelsApiResponse;
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

export interface GetModelsOptions {
  /** Ignore any cached result and hit the network. */
  refresh?: boolean;
  /** Skip the network entirely — return cache-or-fallback only. */
  offline?: boolean;
}

export interface ModelsResult {
  models: Model[];
  source: "network" | "cache" | "fallback";
  fetchedAt?: number;
}

export async function getOpenCodeModels(
  options: GetModelsOptions = {},
): Promise<ModelsResult> {
  const { refresh = false, offline = false } = options;
  const now = Date.now();

  if (!refresh && memoryCache && now - memoryCache.fetchedAt < OPENCODE_MODELS_CACHE_TTL_MS) {
    return { models: memoryCache.models, source: "cache", fetchedAt: memoryCache.fetchedAt };
  }

  if (!refresh) {
    const disk = readCacheFile();
    if (disk && now - disk.fetchedAt < OPENCODE_MODELS_CACHE_TTL_MS) {
      memoryCache = { fetchedAt: disk.fetchedAt, models: disk.models };
      return { models: disk.models, source: "cache", fetchedAt: disk.fetchedAt };
    }
  }

  if (offline) {
    const disk = readCacheFile();
    if (disk) {
      memoryCache = { fetchedAt: disk.fetchedAt, models: disk.models };
      return { models: disk.models, source: "cache", fetchedAt: disk.fetchedAt };
    }
    return { models: MODELS, source: "fallback" };
  }

  const fresh = await fetchFromApi();
  if (fresh) {
    memoryCache = { fetchedAt: Date.now(), models: fresh };
    writeCacheFile(fresh);
    return { models: fresh, source: "network", fetchedAt: memoryCache.fetchedAt };
  }

  const disk = readCacheFile();
  if (disk) {
    memoryCache = { fetchedAt: disk.fetchedAt, models: disk.models };
    return { models: disk.models, source: "cache", fetchedAt: disk.fetchedAt };
  }
  return { models: MODELS, source: "fallback" };
}

export function clearOpenCodeModelsCache(): void {
  memoryCache = null;
  try {
    if (existsSync(resolveCacheFile())) unlinkSync(resolveCacheFile());
  } catch {}
}

// Test hook — reset in-memory cache without touching disk.
export function __resetMemoryCacheForTests(): void {
  memoryCache = null;
}
