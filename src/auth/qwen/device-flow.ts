// ============================================================
// Qwen OAuth — device authorization flow
// ============================================================

import {
  QWEN_CLIENT_ID,
  QWEN_DEVICE_CODE_URL,
  QWEN_SCOPE,
  QWEN_TOKEN_URL,
} from "../../constants.js";
import { generatePKCE, parseIdTokenEmail } from "./pkce.js";
import {
  addAccount,
  type Account,
} from "../../db/accounts.js";

export interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval?: number;
}

export interface DeviceTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  id_token?: string;
  resource_url?: string;
}

const POLL_MAX_ATTEMPTS = 60;

export async function requestDeviceCode(
  codeChallenge: string,
): Promise<DeviceCodeResponse> {
  const resp = await fetch(QWEN_DEVICE_CODE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: QWEN_CLIENT_ID,
      scope: QWEN_SCOPE,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    }),
  });
  if (!resp.ok) {
    throw new Error(
      `Device code request failed (${resp.status}): ${await resp.text()}`,
    );
  }
  return (await resp.json()) as DeviceCodeResponse;
}

export async function pollForToken(
  deviceCode: string,
  codeVerifier: string,
  intervalSecs: number,
  expiresIn: number,
  onTick?: (secsLeft: number) => void,
): Promise<DeviceTokenResponse> {
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    device_code: deviceCode,
    client_id: QWEN_CLIENT_ID,
    code_verifier: codeVerifier,
  });
  const deadline = Date.now() + expiresIn * 1000;
  let interval = intervalSecs;

  for (let i = 0; i < POLL_MAX_ATTEMPTS; i++) {
    onTick?.(Math.max(0, Math.ceil((deadline - Date.now()) / 1000)));
    await Bun.sleep(interval * 1000);
    if (Date.now() >= deadline) {
      throw new Error("Device code expired. Please try again.");
    }
    const resp = await fetch(QWEN_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body,
    });
    if (resp.ok) {
      return (await resp.json()) as DeviceTokenResponse;
    }
    const data = (await resp.json().catch(() => ({}))) as {
      error?: string;
      error_description?: string;
    };
    const error = data.error;
    if (error === "authorization_pending") continue;
    if (error === "slow_down") {
      interval = Math.min(interval + 5, 30);
      continue;
    }
    if (error === "expired_token") {
      throw new Error("Device code expired. Please try again.");
    }
    if (error === "access_denied") {
      throw new Error("Authorization denied by user.");
    }
    throw new Error(
      `Token poll failed (${resp.status}): ${data.error_description ?? error ?? "unknown"}`,
    );
  }
  throw new Error("Timed out waiting for authorization.");
}

/**
 * Perform a full Qwen OAuth device-code login and persist the resulting
 * account to the local SQLite DB. The UX (spinners, browser open) lives
 * in the CLI caller so this module stays testable and side-effect light.
 */
export interface LoginCallbacks {
  onDeviceCode?: (device: DeviceCodeResponse) => void | Promise<void>;
  onPollTick?: (secsLeft: number) => void;
}

export async function qwenLogin(
  callbacks: LoginCallbacks = {},
): Promise<Account> {
  const { codeVerifier, codeChallenge } = generatePKCE();
  const device = await requestDeviceCode(codeChallenge);
  await callbacks.onDeviceCode?.(device);

  const tokens = await pollForToken(
    device.device_code,
    codeVerifier,
    device.interval ?? 5,
    device.expires_in ?? 300,
    callbacks.onPollTick,
  );

  const email = tokens.id_token ? parseIdTokenEmail(tokens.id_token) : null;
  const expiresAt = new Date(
    Date.now() + tokens.expires_in * 1000,
  ).toISOString();

  return addAccount({
    email,
    display_name: email,
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: expiresAt,
    resource_url: tokens.resource_url ?? null,
  });
}
