import { describe, expect, test } from "bun:test";
import { checkFallbackError } from "../src/rotator/fallback.js";
import {
  QWEN_COOLDOWN_NOT_FOUND_MS,
  QWEN_COOLDOWN_PAYMENT_MS,
  QWEN_COOLDOWN_TRANSIENT_MS,
  QWEN_COOLDOWN_UNAUTHORIZED_MS,
  QWEN_RATE_LIMIT_BACKOFF_BASE_MS,
  QWEN_RATE_LIMIT_BACKOFF_MAX_LEVEL,
  QWEN_RATE_LIMIT_BACKOFF_MAX_MS,
} from "../src/constants.js";

describe("checkFallbackError", () => {
  test("401 → fallback with unauthorized cooldown", () => {
    const d = checkFallbackError(401, "Unauthorized");
    expect(d.shouldFallback).toBe(true);
    expect(d.cooldownMs).toBe(QWEN_COOLDOWN_UNAUTHORIZED_MS);
    expect(d.newBackoffLevel).toBeUndefined();
  });

  test("402 → fallback with payment cooldown", () => {
    const d = checkFallbackError(402, "");
    expect(d.shouldFallback).toBe(true);
    expect(d.cooldownMs).toBe(QWEN_COOLDOWN_PAYMENT_MS);
  });

  test("403 → fallback with payment cooldown", () => {
    const d = checkFallbackError(403, "");
    expect(d.shouldFallback).toBe(true);
    expect(d.cooldownMs).toBe(QWEN_COOLDOWN_PAYMENT_MS);
  });

  test("404 → no fallback but lock for 15m", () => {
    const d = checkFallbackError(404, "not found");
    expect(d.shouldFallback).toBe(false);
    expect(d.cooldownMs).toBe(QWEN_COOLDOWN_NOT_FOUND_MS);
  });

  test("429 at level 0 → fallback with base cooldown and bumped level", () => {
    const d = checkFallbackError(429, "rate limit exceeded");
    expect(d.shouldFallback).toBe(true);
    expect(d.cooldownMs).toBe(QWEN_RATE_LIMIT_BACKOFF_BASE_MS);
    expect(d.newBackoffLevel).toBe(1);
  });

  test("429 at level 3 → 2^3 * base", () => {
    const d = checkFallbackError(429, "", 3);
    expect(d.cooldownMs).toBe(QWEN_RATE_LIMIT_BACKOFF_BASE_MS * 8);
    expect(d.newBackoffLevel).toBe(4);
  });

  test("429 backoff caps at max", () => {
    const d = checkFallbackError(429, "", 20);
    expect(d.cooldownMs).toBe(QWEN_RATE_LIMIT_BACKOFF_MAX_MS);
    expect(d.newBackoffLevel).toBe(QWEN_RATE_LIMIT_BACKOFF_MAX_LEVEL);
  });

  test("200 body containing 'quota exceeded' triggers fallback", () => {
    // Some Qwen endpoints return 200-in-body-error; we match on substring too
    const d = checkFallbackError(400, "quota exceeded for the day");
    expect(d.shouldFallback).toBe(true);
    expect(d.newBackoffLevel).toBe(1);
  });

  test("500 → fallback with transient cooldown", () => {
    const d = checkFallbackError(500, "internal error");
    expect(d.shouldFallback).toBe(true);
    expect(d.cooldownMs).toBe(QWEN_COOLDOWN_TRANSIENT_MS);
  });

  test("503 → fallback with transient cooldown", () => {
    const d = checkFallbackError(503, "upstream unavailable");
    expect(d.shouldFallback).toBe(true);
    expect(d.cooldownMs).toBe(QWEN_COOLDOWN_TRANSIENT_MS);
  });

  test("'timeout' text with non-5xx still treated as transient", () => {
    const d = checkFallbackError(408, "request timeout");
    expect(d.shouldFallback).toBe(true);
    expect(d.cooldownMs).toBe(QWEN_COOLDOWN_TRANSIENT_MS);
  });

  test("'request not allowed' → fallback, unauthorized cooldown", () => {
    const d = checkFallbackError(400, "request not allowed in your region");
    expect(d.shouldFallback).toBe(true);
    expect(d.cooldownMs).toBe(QWEN_COOLDOWN_UNAUTHORIZED_MS);
  });

  test("generic 400 → no fallback, no cooldown", () => {
    const d = checkFallbackError(400, "bad request");
    expect(d.shouldFallback).toBe(false);
    expect(d.cooldownMs).toBe(0);
  });
});
