// ============================================================
// Qwen OAuth — PKCE helpers
// ============================================================
//
// Qwen's device-code flow uses plain S256 PKCE. We avoid the
// @openauthjs dependency here because it's overkill for two
// lines of crypto.

import { createHash, randomBytes } from "node:crypto";

export interface PKCEPair {
  codeVerifier: string;
  codeChallenge: string;
}

export function generatePKCE(): PKCEPair {
  const codeVerifier = randomBytes(32).toString("base64url");
  const codeChallenge = createHash("sha256")
    .update(codeVerifier)
    .digest("base64url");
  return { codeVerifier, codeChallenge };
}

export function parseIdTokenEmail(idToken: string): string | null {
  try {
    const parts = idToken.split(".");
    const part = parts[1];
    if (!part) return null;
    const payload = JSON.parse(
      Buffer.from(part, "base64url").toString("utf-8"),
    );
    return typeof payload.email === "string" ? payload.email : null;
  } catch {
    return null;
  }
}
