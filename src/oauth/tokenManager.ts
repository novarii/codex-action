/**
 * OAuth token lifecycle management for the ChatGPT backend.
 *
 * Handles loading, validation, refresh, and JWT decoding of OAuth tokens
 * used to authenticate against `https://chatgpt.com/backend-api/`.
 */

const TOKEN_URL = "https://auth.openai.com/oauth/token";
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const JWT_CLAIM_PATH = "https://api.openai.com/auth";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TokenState {
  accessToken: string;
  refreshToken: string;
  /** Absolute timestamp (ms) when the access token expires. */
  expires: number;
  /** ChatGPT account ID extracted from the JWT. */
  accountId: string;
  /** Token relay URL for fetching fresh tokens (relay mode). */
  relayUrl?: string;
  /** API key for the token relay. */
  relayKey?: string;
}

interface JWTPayload {
  [JWT_CLAIM_PATH]?: { chatgpt_account_id?: string };
  exp?: number;
  [key: string]: unknown;
}

type TokenRefreshResult =
  | { type: "success"; access: string; refresh: string; expires: number }
  | { type: "failed" };

// ---------------------------------------------------------------------------
// JWT helpers
// ---------------------------------------------------------------------------

export function decodeJWT(token: string): JWTPayload | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const decoded = Buffer.from(parts[1], "base64").toString("utf-8");
    return JSON.parse(decoded) as JWTPayload;
  } catch {
    return null;
  }
}

export function getAccountId(accessToken: string): string {
  const payload = decodeJWT(accessToken);
  const accountId = payload?.[JWT_CLAIM_PATH]?.chatgpt_account_id;
  if (!accountId) {
    throw new Error("Failed to extract chatgpt_account_id from access token");
  }
  return accountId;
}

// ---------------------------------------------------------------------------
// Token state
// ---------------------------------------------------------------------------

/**
 * Build an initial TokenState from raw tokens.  The access token's JWT `exp`
 * claim is used as the expiry if present; otherwise we assume it has already
 * expired so a refresh is triggered immediately.
 */
export function loadTokens(
  accessToken: string,
  refreshToken: string,
): TokenState {
  const payload = decodeJWT(accessToken);

  let expires = 0;
  if (payload?.exp) {
    expires = payload.exp * 1000; // JWT exp is in seconds
  }

  const accountId = getAccountId(accessToken);

  return { accessToken, refreshToken, expires, accountId };
}

export function shouldRefreshToken(state: TokenState): boolean {
  // Refresh 60 s before actual expiry to avoid races.
  return state.expires - 60_000 < Date.now();
}

// ---------------------------------------------------------------------------
// Token refresh
// ---------------------------------------------------------------------------

export async function refreshAccessToken(
  refreshToken: string,
): Promise<TokenRefreshResult> {
  try {
    const response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: CLIENT_ID,
      }),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      console.error(
        "[oauth-proxy] Token refresh failed:",
        response.status,
        text,
      );
      return { type: "failed" };
    }

    const json = (await response.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
    };

    if (
      !json?.access_token ||
      !json?.refresh_token ||
      typeof json?.expires_in !== "number"
    ) {
      console.error(
        "[oauth-proxy] Token refresh response missing fields:",
        json,
      );
      return { type: "failed" };
    }

    return {
      type: "success",
      access: json.access_token,
      refresh: json.refresh_token,
      expires: Date.now() + json.expires_in * 1000,
    };
  } catch (error) {
    console.error("[oauth-proxy] Token refresh error:", error);
    return { type: "failed" };
  }
}

/**
 * Fetch a fresh access token from the token relay service.
 */
async function fetchFromRelay(state: TokenState): Promise<TokenState> {
  console.log("[oauth-proxy] Fetching fresh token from relay...");
  const res = await fetch(state.relayUrl!, {
    headers: { Authorization: `Bearer ${state.relayKey}` },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.error("[oauth-proxy] Relay fetch failed:", res.status, text);
    throw new Error("Failed to fetch token from relay");
  }

  const json = (await res.json()) as {
    access_token?: string;
    expires_at?: number;
  };

  if (!json.access_token || typeof json.expires_at !== "number") {
    throw new Error("Relay response missing access_token or expires_at");
  }

  state.accessToken = json.access_token;
  state.expires = json.expires_at;
  state.accountId = getAccountId(json.access_token);

  console.log("[oauth-proxy] Token fetched from relay successfully");
  return state;
}

/**
 * Ensure the TokenState has a valid (non-expired) access token, refreshing if
 * necessary.  Mutates and returns the same object.
 */
export async function ensureValidToken(
  state: TokenState,
): Promise<TokenState> {
  if (!shouldRefreshToken(state)) {
    return state;
  }

  // Relay mode: fetch from relay instead of refreshing directly
  if (state.relayUrl) {
    return fetchFromRelay(state);
  }

  console.log("[oauth-proxy] Access token expired or expiring, refreshing...");
  const result = await refreshAccessToken(state.refreshToken);
  if (result.type === "failed") {
    throw new Error("Failed to refresh OAuth access token");
  }

  state.accessToken = result.access;
  state.refreshToken = result.refresh;
  state.expires = result.expires;
  state.accountId = getAccountId(result.access);

  console.log("[oauth-proxy] Token refreshed successfully");
  return state;
}
