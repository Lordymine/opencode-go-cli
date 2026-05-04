// ============================================================
// OAuth — OpenAI / Codex device authorization flow
// ============================================================

import { randomBytes } from "node:crypto";
import { generatePKCE } from "@openauthjs/openauth/pkce";
import {
  CODEX_CLIENT_ID,
  CODEX_AUTH_URL,
  CODEX_TOKEN_URL,
  CODEX_REDIRECT_URI,
  CODEX_SCOPE,
} from "../constants.js";

export interface PKCEPair {
  challenge: string;
  verifier: string;
}

export interface AuthorizationFlow {
  pkce: PKCEPair;
  state: string;
  url: string;
}

export interface TokenSuccess {
  type: "success";
  access: string;
  refresh: string;
  expires: number; // timestamp ms
  accountId?: string;
  planType?: string;
}

export interface TokenFailure {
  type: "failed";
}

export type TokenResult = TokenSuccess | TokenFailure;

export interface ParsedAuthInput {
  code?: string;
  state?: string;
}

/**
 * Generate a random state value for OAuth flow
 */
export function createState(): string {
  return randomBytes(16).toString("hex");
}

/**
 * Parse authorization code and state from user input
 * (handles URL, code#state, or plain code)
 */
export function parseAuthorizationInput(input: string): ParsedAuthInput {
  const value = (input || "").trim();
  if (!value) return {};

  try {
    const url = new URL(value);
    return {
      code: url.searchParams.get("code") ?? undefined,
      state: url.searchParams.get("state") ?? undefined,
    };
  } catch {}

  if (value.includes("#")) {
    const [code, state] = value.split("#", 2);
    return { code, state };
  }
  if (value.includes("code=")) {
    const params = new URLSearchParams(value);
    return {
      code: params.get("code") ?? undefined,
      state: params.get("state") ?? undefined,
    };
  }
  return { code: value };
}

/**
 * Exchange authorization code for access and refresh tokens
 */
export async function exchangeAuthorizationCode(
  code: string,
  verifier: string,
  redirectUri: string = CODEX_REDIRECT_URI,
): Promise<TokenResult> {
  const res = await fetch(CODEX_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CODEX_CLIENT_ID,
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.error(`[oauth] Token exchange failed: ${res.status} ${text}`);
    return { type: "failed" };
  }

  const json = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    id_token?: string;
    expires_in?: number;
  };

  if (!json?.access_token || !json?.refresh_token || typeof json?.expires_in !== "number") {
    console.error("[oauth] Token response missing fields:", json);
    return { type: "failed" };
  }

  return {
    type: "success",
    access: json.access_token,
    refresh: json.refresh_token,
    expires: Date.now() + json.expires_in * 1000,
    ...extractOpenAIClaims(json.id_token),
  };
}

/**
 * Refresh access token using refresh token
 */
export async function refreshAccessToken(refreshToken: string): Promise<TokenResult> {
  try {
    const response = await fetch(CODEX_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: CODEX_CLIENT_ID,
      }),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      console.error(`[oauth] Token refresh failed: ${response.status} ${text}`);
      return { type: "failed" };
    }

    const json = (await response.json()) as {
      access_token?: string;
      refresh_token?: string;
      id_token?: string;
      expires_in?: number;
    };

    if (!json?.access_token || !json?.refresh_token || typeof json?.expires_in !== "number") {
      console.error("[oauth] Token refresh response missing fields:", json);
      return { type: "failed" };
    }

    return {
      type: "success",
      access: json.access_token,
      refresh: json.refresh_token,
      expires: Date.now() + json.expires_in * 1000,
      ...extractOpenAIClaims(json.id_token),
    };
  } catch (error) {
    const err = error as Error;
    console.error(`[oauth] Token refresh error: ${err.message}`);
    return { type: "failed" };
  }
}

/**
 * Decode JWT token to extract payload
 */
export function decodeJWT(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const payload = parts[1];
    const decoded = Buffer.from(payload, "base64").toString("utf-8");
    return JSON.parse(decoded);
  } catch {
    return null;
  }
}

function extractOpenAIClaims(idToken: string | undefined): {
  accountId?: string;
  planType?: string;
} {
  if (!idToken) return {};
  const claims = decodeJWT(idToken);
  const auth = claims?.["https://api.openai.com/auth"];
  const authClaims = auth && typeof auth === "object" ? auth as Record<string, unknown> : {};
  const accountId = typeof authClaims.chatgpt_account_id === "string"
    ? authClaims.chatgpt_account_id
    : typeof claims?.chatgpt_account_id === "string"
      ? claims.chatgpt_account_id
      : undefined;
  const planType = typeof authClaims.chatgpt_plan_type === "string"
    ? authClaims.chatgpt_plan_type
    : typeof claims?.chatgpt_plan_type === "string"
      ? claims.chatgpt_plan_type
      : undefined;
  return { accountId, planType };
}

/**
 * Create OAuth authorization flow (PKCE + state + URL)
 */
export async function createAuthorizationFlow(): Promise<AuthorizationFlow> {
  const pkce = await generatePKCE();
  const state = createState();

  const url = new URL(CODEX_AUTH_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", CODEX_CLIENT_ID);
  url.searchParams.set("redirect_uri", CODEX_REDIRECT_URI);
  url.searchParams.set("scope", CODEX_SCOPE);
  url.searchParams.set("code_challenge", pkce.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  url.searchParams.set("id_token_add_organizations", "true");
  url.searchParams.set("codex_cli_simplified_flow", "true");
  url.searchParams.set("originator", "opencode-go-cli");

  return { pkce, state, url: url.toString() };
}
