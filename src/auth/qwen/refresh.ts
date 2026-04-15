// ============================================================
// Qwen OAuth — token refresh
// ============================================================

import {
  QWEN_CLIENT_ID,
  QWEN_TOKEN_URL,
  QWEN_TOKEN_EXPIRY_BUFFER_MS,
} from "../../constants.js";
import { updateAccount, type Account } from "../../db/accounts.js";

export interface RefreshedTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  resourceUrl?: string;
}

export async function refreshQwenToken(
  refreshToken: string,
): Promise<RefreshedTokens | null> {
  try {
    const resp = await fetch(QWEN_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: QWEN_CLIENT_ID,
      }),
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      resource_url?: string;
    };
    if (!data.access_token) return null;
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? refreshToken,
      expiresIn: data.expires_in ?? 3600,
      resourceUrl: data.resource_url,
    };
  } catch {
    return null;
  }
}

/**
 * If the account's access token is about to expire (within the buffer window),
 * refresh it and persist the new values. Returns the (possibly updated) account.
 * On refresh failure, returns the original account unchanged — caller decides
 * what to do with the 401 that will likely follow.
 */
export async function checkAndRefreshAccount(
  account: Account,
): Promise<Account> {
  const expiresAt = new Date(account.expires_at).getTime();
  if (expiresAt - Date.now() > QWEN_TOKEN_EXPIRY_BUFFER_MS) {
    return account;
  }

  const refreshed = await refreshQwenToken(account.refresh_token);
  if (!refreshed) return account;

  const patch: Record<string, unknown> = {
    access_token: refreshed.accessToken,
    refresh_token: refreshed.refreshToken,
    expires_at: new Date(
      Date.now() + refreshed.expiresIn * 1000,
    ).toISOString(),
  };
  if (refreshed.resourceUrl) {
    patch.resource_url = refreshed.resourceUrl;
  }
  updateAccount(account.id, patch);

  return { ...account, ...(patch as Partial<Account>) };
}
