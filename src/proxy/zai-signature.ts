// ============================================================
// Z.ai Signature — HMAC-SHA256 duplo em TypeScript puro
// ============================================================
//
// Algoritmo (reverse-engineered do frontend JS):
//   1. sortedPayload = "requestId,<uuid>,timestamp,<ts>,user_id,<userId>"
//   2. bucket = Math.floor(timestamp / 300000)
//   3. k1 = hmac_sha256(ZAI_HMAC_KEY, String(bucket))
//   4. signature = hmac_sha256(k1, sortedPayload + "|" + btoa(prompt) + "|" + timestamp)
//
// O resultado é hex (lowercase), igual ao js-sha256 v0.10.1

import { createHmac } from "node:crypto";
import { ZAI_HMAC_KEY, ZAI_TIME_BUCKET_MS } from "../constants.js";

/**
 * Gera a assinatura HMAC dupla do Z.ai.
 * Retorna a string hex da assinatura.
 */
export function generateZaiSignature(params: {
  requestId: string;
  timestamp: string;
  userId: string;
  prompt: string;
}): string {
  const { requestId, timestamp, userId, prompt } = params;

  // sortedPayload: campos ordenados por chave
  const sortedPayload = `requestId,${requestId},timestamp,${timestamp},user_id,${userId}`;

  // btoa do prompt (base64 ASCII)
  const b64Prompt = Buffer.from(prompt, "utf-8").toString("base64");

  // Data to sign
  const dataToSign = `${sortedPayload}|${b64Prompt}|${timestamp}`;

  // Time bucket (5 min)
  const bucket = Math.floor(Number(timestamp) / ZAI_TIME_BUCKET_MS);

  // k1 = hmac(key, bucket)
  const k1 = createHmac("sha256", ZAI_HMAC_KEY)
    .update(String(bucket))
    .digest("hex");

  // signature = hmac(k1, dataToSign)
  const signature = createHmac("sha256", k1)
    .update(dataToSign)
    .digest("hex");

  return signature;
}

/**
 * Monta a query string com fingerprint fake + signature_timestamp.
 * O Z.ai valida a presença do signature_timestamp na URL.
 */
export function buildZaiUrlParams(params: {
  timestamp: string;
  requestId: string;
  userId: string;
  token: string;
}): string {
  const { timestamp, requestId, userId, token } = params;
  return [
    `timestamp=${timestamp}`,
    `requestId=${requestId}`,
    `user_id=${userId}`,
    `version=0.0.1`,
    `platform=web`,
    `token=${encodeURIComponent(token)}`,
    `language=en-US`,
    `timezone=America%2FSao_Paulo`,
    `cookie_enabled=true`,
    `screen_width=1280`,
    `screen_height=720`,
    `screen_resolution=1280x720`,
    `color_depth=24`,
    `pixel_ratio=1`,
    `pathname=%2F`,
    `host=chat.z.ai`,
    `hostname=chat.z.ai`,
    `protocol=https%3A`,
    `referrer=`,
    `title=Z.ai`,
    `timezone_offset=180`,
    `is_mobile=false`,
    `is_touch=false`,
    `max_touch_points=0`,
    `browser_name=Chrome`,
    `os_name=Linux`,
    `signature_timestamp=${timestamp}`,
  ].join("&");
}
