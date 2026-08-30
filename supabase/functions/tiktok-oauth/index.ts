// tiktok-oauth — TikTok Login Kit OAuth 2.0 with state, same-browser nonce,
// and PKCE. Tokens never return to the browser and are stored only in Vault.
//
// POST actions (signed-in Supabase bearer token + allowed Origin):
//   { action:"capabilities", ledgerId? }
//   { action:"start", ledgerId, enableDirectPost? }
//   { action:"complete", state, code, browserNonce, providerError? }
//   { action:"refresh", ledgerId }
//   { action:"disconnect", ledgerId }
//   { action:"reset", ledgerId, manualRevocationAcknowledged:true }
//
// GET is the provider callback and only redirects the code/state to the same
// allowed app origin. The POST complete action atomically consumes the hashed
// state and checks the initiating browser nonce before exchanging the code.
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { requireAal2 } from "../_shared/aal2.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const TIKTOK_CLIENT_KEY = Deno.env.get("TIKTOK_CLIENT_KEY") || "";
const TIKTOK_CLIENT_SECRET = Deno.env.get("TIKTOK_CLIENT_SECRET") || "";
const CALLBACK_URL = Deno.env.get("TIKTOK_OAUTH_REDIRECT_URI") ||
  "https://nwsqyuucwzihruszocge.supabase.co/functions/v1/tiktok-oauth";
const APP_ORIGIN = Deno.env.get("TIKTOK_OAUTH_APP_ORIGIN") ||
  "https://mypersonas.online";
const DIRECT_POST_ENABLED =
  Deno.env.get("TIKTOK_DIRECT_POST_ENABLED") === "true";
const CLIENT_AUDIT_STATE = Deno.env.get("TIKTOK_CLIENT_AUDIT_STATE") || "";
const AUTHORIZE_URL = "https://www.tiktok.com/v2/auth/authorize/";
const TOKEN_URL = "https://open.tiktokapis.com/v2/oauth/token/";
const REVOKE_URL = "https://open.tiktokapis.com/v2/oauth/revoke/";
const USER_URL =
  "https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name,username";
const PROVIDER_TIMEOUT_MS = 20_000;
const UPLOAD_SCOPES = [
  "user.info.basic",
  "user.info.profile",
  "video.upload",
] as const;
const DIRECT_SCOPES = [...UPLOAD_SCOPES, "video.publish"] as const;
const SAFE_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_OPEN_ID = /^[A-Za-z0-9._~-]{1,200}$/;
const SAFE_USERNAME = /^[A-Za-z0-9._]{2,64}$/;
const ALLOWED_ORIGINS = new Set([
  APP_ORIGIN,
  "https://aliaspaces.com",
  "https://www.aliaspaces.com",
  "https://app.aliaspaces.com",
  "https://mypersonas.online",
  "http://localhost:8000",
  "http://127.0.0.1:8000",
]);

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

type Ledger = {
  id: string;
  owner: string;
  provider: string;
  username: string | null;
  suspended: boolean;
};

type OAuthBody = {
  action?: string;
  ledgerId?: string;
  enableDirectPost?: boolean;
  state?: string;
  code?: string;
  browserNonce?: string;
  providerError?: string;
  manualRevocationAcknowledged?: boolean;
};

type OAuthTransaction = {
  owner: string;
  ledger_id: string;
  code_verifier: string;
  requested_scopes: unknown;
  access_mode: "upload" | "direct";
};

type TokenBundle = {
  accessToken: string;
  refreshToken: string;
  tokenType: string;
  scopes: string[];
  openId: string;
  expiresAt: string;
  refreshExpiresAt: string;
};

type Identity = {
  openId: string;
  username: string;
  displayName: string;
};

function cors(origin: string): HeadersInit {
  return {
    ...(ALLOWED_ORIGINS.has(origin)
      ? { "Access-Control-Allow-Origin": origin }
      : {}),
    "Access-Control-Allow-Headers": "authorization, content-type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Cache-Control": "no-store",
    "Vary": "Origin",
  };
}

function json(origin: string, status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...cors(origin),
      "Content-Type": "application/json",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function redirectToApp(params: Record<string, string>, returnOrigin = "") {
  const origin = ALLOWED_ORIGINS.has(returnOrigin) ? returnOrigin : APP_ORIGIN;
  const target = new URL(`${origin}/#/studio`);
  for (const [key, value] of Object.entries(params)) {
    if (value) target.searchParams.set(key, value);
  }
  return new Response(null, {
    status: 302,
    headers: {
      "Location": target.toString(),
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function normalizeUsername(value: unknown) {
  return String(value || "").normalize("NFKC").trim().replace(/^@+/, "")
    .toLowerCase();
}

function normalizeScopes(value: unknown): string[] {
  const values = Array.isArray(value)
    ? value
    : typeof value === "string"
    ? value.split(/[\s,]+/)
    : [];
  return [
    ...new Set(
      values.map((item) => String(item).trim().toLowerCase())
        .filter((item) => /^[a-z0-9._:-]{1,128}$/.test(item)),
    ),
  ].sort();
}

function hasScopes(scopes: string[], required: readonly string[]) {
  return required.every((scope) => scopes.includes(scope));
}

function directConfigurationExplicit() {
  return DIRECT_POST_ENABLED &&
    (CLIENT_AUDIT_STATE === "audited" || CLIENT_AUDIT_STATE === "unaudited");
}

function base64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(
    /=+$/g,
    "",
  );
}

function randomUrlSafe(byteLength: number) {
  return base64Url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

async function sha256Bytes(value: string) {
  return new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(value),
    ),
  );
}

async function sha256Hex(value: string) {
  return [...await sha256Bytes(value)]
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function expiry(seconds: unknown, maxSeconds: number) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value < 60) return "";
  return new Date(Date.now() + Math.min(maxSeconds, Math.floor(value)) * 1000)
    .toISOString();
}

function credentialsConfigured() {
  return Boolean(TIKTOK_CLIENT_KEY && TIKTOK_CLIENT_SECRET);
}

async function caller(req: Request) {
  const authorization = req.headers.get("Authorization") || "";
  const token = authorization.replace(/^Bearer\s+/i, "");
  if (!token || token === authorization) return null;
  const result = await admin.auth.getUser(token);
  return result.error ? null : result.data.user;
}

async function ownedLedger(ledgerId: string, owner: string) {
  const result = await admin.from("account_ledger")
    .select("id,owner,provider,username,suspended")
    .eq("id", ledgerId).eq("owner", owner).eq("provider", "tiktok")
    .maybeSingle();
  return result.error ? null : result.data as Ledger | null;
}

async function markConnectionError(
  ledger: Ledger,
  errorCode: string,
  force = false,
) {
  const existing = await admin.from("account_connections")
    .select("connection_state").eq("ledger_id", ledger.id)
    .eq("owner", ledger.owner).maybeSingle();
  if (existing.error) return false;
  if (!force && existing.data?.connection_state === "connected") return true;
  const now = new Date().toISOString();
  const result = await admin.from("account_connections").upsert({
    ledger_id: ledger.id,
    owner: ledger.owner,
    provider: "tiktok",
    provider_subject: "",
    provider_email: normalizeUsername(ledger.username),
    granted_scopes: [],
    connection_state: "error",
    verification_method: "tiktok_oauth2_pkce",
    last_checked_at: now,
    error_code: errorCode,
    updated_at: now,
  }, { onConflict: "ledger_id" });
  return !result.error;
}

async function claimLease(
  ledger: Ledger,
  operationKind: "connect" | "refresh" | "disconnect" | "reset",
) {
  const leaseId = crypto.randomUUID();
  const result = await admin.rpc("claim_tiktok_token_operation", {
    p_ledger_id: ledger.id,
    p_owner: ledger.owner,
    p_lease_id: leaseId,
    p_operation_kind: operationKind,
    p_ttl_seconds: 120,
  });
  return result.error || result.data !== true ? "" : leaseId;
}

async function releaseLease(ledger: Ledger, leaseId: string) {
  if (!leaseId) return;
  await admin.rpc("release_tiktok_token_operation", {
    p_ledger_id: ledger.id,
    p_owner: ledger.owner,
    p_lease_id: leaseId,
  });
}

async function exchangeCode(code: string, codeVerifier: string) {
  try {
    const response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "application/json",
        "Cache-Control": "no-cache",
      },
      body: new URLSearchParams({
        client_key: TIKTOK_CLIENT_KEY,
        client_secret: TIKTOK_CLIENT_SECRET,
        code,
        grant_type: "authorization_code",
        redirect_uri: CALLBACK_URL,
        code_verifier: codeVerifier,
      }),
      redirect: "error",
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });
    const payload = await response.json().catch(() => null) as
      | Record<string, unknown>
      | null;
    if (
      !response.ok || !payload || typeof payload.access_token !== "string" ||
      typeof payload.refresh_token !== "string" ||
      String(payload.token_type || "").toLowerCase() !== "bearer" ||
      !SAFE_OPEN_ID.test(String(payload.open_id || ""))
    ) {
      return {
        token: null,
        uncertain: response.status === 408 || response.status >= 500 ||
          (response.ok && !payload),
      };
    }
    const token: TokenBundle = {
      accessToken: payload.access_token,
      refreshToken: payload.refresh_token,
      tokenType: "bearer",
      scopes: normalizeScopes(payload.scope),
      openId: String(payload.open_id),
      expiresAt: expiry(payload.expires_in, 172_800),
      refreshExpiresAt: expiry(payload.refresh_expires_in, 400 * 86_400),
    };
    if (!token.expiresAt || !token.refreshExpiresAt) {
      return { token: null, uncertain: true };
    }
    return { token, uncertain: false };
  } catch {
    return { token: null, uncertain: true };
  }
}

async function refreshToken(stored: TokenBundle) {
  try {
    const response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "application/json",
        "Cache-Control": "no-cache",
      },
      body: new URLSearchParams({
        client_key: TIKTOK_CLIENT_KEY,
        client_secret: TIKTOK_CLIENT_SECRET,
        grant_type: "refresh_token",
        refresh_token: stored.refreshToken,
      }),
      redirect: "error",
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });
    const payload = await response.json().catch(() => null) as
      | Record<string, unknown>
      | null;
    if (
      !response.ok || !payload || typeof payload.access_token !== "string" ||
      typeof payload.refresh_token !== "string" ||
      String(payload.token_type || "").toLowerCase() !== "bearer" ||
      !SAFE_OPEN_ID.test(String(payload.open_id || ""))
    ) {
      return {
        token: null,
        uncertain: response.status === 408 || response.status >= 500 ||
          (response.ok && !payload),
      };
    }
    const token: TokenBundle = {
      accessToken: payload.access_token,
      refreshToken: payload.refresh_token,
      tokenType: "bearer",
      scopes: normalizeScopes(payload.scope).length
        ? normalizeScopes(payload.scope)
        : stored.scopes,
      openId: String(payload.open_id),
      expiresAt: expiry(payload.expires_in, 172_800),
      refreshExpiresAt: expiry(payload.refresh_expires_in, 400 * 86_400),
    };
    if (!token.expiresAt || !token.refreshExpiresAt) {
      return { token: null, uncertain: true };
    }
    return { token, uncertain: false };
  } catch {
    return { token: null, uncertain: true };
  }
}

async function revokeAtProvider(accessToken: string) {
  try {
    const response = await fetch(REVOKE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "application/json",
        "Cache-Control": "no-cache",
      },
      body: new URLSearchParams({
        client_key: TIKTOK_CLIENT_KEY,
        client_secret: TIKTOK_CLIENT_SECRET,
        token: accessToken,
      }),
      redirect: "error",
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });
    // TikTok documents an empty success response. Every 2xx is definitive.
    return {
      revoked: response.status >= 200 && response.status < 300,
      uncertain: response.status === 408 || response.status >= 500,
    };
  } catch {
    return { revoked: false, uncertain: true };
  }
}

async function fetchIdentity(accessToken: string, expectedOpenId: string) {
  try {
    const response = await fetch(USER_URL, {
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Accept": "application/json",
      },
      redirect: "error",
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });
    const payload = await response.json().catch(() => null) as
      | Record<string, unknown>
      | null;
    const data = payload?.data as Record<string, unknown> | undefined;
    const user = data?.user as Record<string, unknown> | undefined;
    const error = payload?.error as Record<string, unknown> | undefined;
    const identity: Identity = {
      openId: String(user?.open_id || ""),
      username: normalizeUsername(user?.username),
      displayName: String(user?.display_name || "").trim().slice(0, 160),
    };
    if (
      !response.ok || String(error?.code || "") !== "ok" ||
      identity.openId !== expectedOpenId ||
      !SAFE_OPEN_ID.test(identity.openId) ||
      !SAFE_USERNAME.test(identity.username)
    ) {
      return {
        identity: null,
        uncertain: response.status === 408 || response.status >= 500 ||
          (response.ok && !payload),
      };
    }
    return { identity, uncertain: false };
  } catch {
    return { identity: null, uncertain: true };
  }
}

async function getStoredToken(ledger: Ledger): Promise<TokenBundle | null> {
  const result = await admin.rpc("tiktok_get_token_bundle", {
    p_ledger_id: ledger.id,
    p_owner: ledger.owner,
  });
  const row = (Array.isArray(result.data) ? result.data[0] : result.data) as
    | Record<string, unknown>
    | null;
  let bundle = row?.token_bundle as Record<string, unknown> | string | null;
  if (typeof bundle === "string") {
    try {
      bundle = JSON.parse(bundle) as Record<string, unknown>;
    } catch {
      bundle = null;
    }
  }
  if (result.error || !row || !bundle || typeof bundle !== "object") {
    return null;
  }
  const token: TokenBundle = {
    accessToken: String(bundle.access_token || ""),
    refreshToken: String(bundle.refresh_token || ""),
    tokenType: String(bundle.token_type || ""),
    scopes: normalizeScopes(bundle.scopes),
    openId: String(row.provider_open_id || ""),
    expiresAt: String(bundle.expires_at || ""),
    refreshExpiresAt: String(bundle.refresh_expires_at || ""),
  };
  return token.accessToken && token.refreshToken &&
      token.tokenType === "bearer" &&
      SAFE_OPEN_ID.test(token.openId) &&
      Number.isFinite(Date.parse(token.expiresAt))
    ? token
    : null;
}

async function storeToken(
  ledger: Ledger,
  token: TokenBundle,
  identity: Identity,
) {
  return await admin.rpc("tiktok_store_token_bundle", {
    p_ledger_id: ledger.id,
    p_owner: ledger.owner,
    p_expected_ledger_username: normalizeUsername(ledger.username),
    p_provider_open_id: identity.openId,
    p_provider_username: identity.username,
    p_access_token: token.accessToken,
    p_refresh_token: token.refreshToken,
    p_token_type: token.tokenType,
    p_scopes: token.scopes,
    p_expires_at: token.expiresAt,
    p_refresh_expires_at: token.refreshExpiresAt,
  });
}

async function cleanupAfterGrant(
  ledger: Ledger,
  token: TokenBundle,
  errorCode: string,
  message: string,
  origin: string,
) {
  const revoke = await revokeAtProvider(token.accessToken);
  if (!revoke.revoked) {
    await markConnectionError(ledger, "tiktok_manual_revoke_required", true);
    return json(origin, 502, {
      error:
        `${message} TikTok did not confirm revocation. Revoke MyPersonas in TikTok Manage app permissions before resetting this account.`,
      manualRevocationRequired: true,
    });
  }
  await markConnectionError(ledger, errorCode, true);
  return json(origin, 409, { error: message, retrySafe: true });
}

async function capabilities(req: Request, origin: string, ledgerId = "") {
  const user = await caller(req);
  if (!user) return json(origin, 401, { error: "Sign in first" });
  const result: Record<string, unknown> = {
    provider: "tiktok",
    credentialsConfigured: credentialsConfigured(),
    oauthConfigured: credentialsConfigured(),
    uploadInboxSupported: true,
    uploadScope: "video.upload",
    directPostConfigured: directConfigurationExplicit(),
    directPostEnabled: directConfigurationExplicit(),
    clientAuditState: CLIENT_AUDIT_STATE || "not_configured",
    unauditedVisibility: CLIENT_AUDIT_STATE === "unaudited"
      ? "SELF_ONLY"
      : null,
    textOnlySupported: false,
    schedulingEnabled: false,
    previewRequired: true,
  };
  if (!ledgerId) return json(origin, 200, result);
  if (!SAFE_UUID.test(ledgerId)) {
    return json(origin, 400, { error: "Invalid account id" });
  }
  const ledger = await ownedLedger(ledgerId, user.id);
  if (!ledger) {
    return json(origin, 404, { error: "Owned TikTok account not found" });
  }
  const connection = await admin.from("account_connections")
    .select(
      "connection_state,error_code,provider_subject,provider_email,granted_scopes,expires_at",
    )
    .eq("ledger_id", ledger.id).eq("owner", user.id).eq("provider", "tiktok")
    .maybeSingle();
  const scopes = normalizeScopes(connection.data?.granted_scopes);
  return json(origin, 200, {
    ...result,
    ledgerId: ledger.id,
    username: normalizeUsername(ledger.username),
    connectionState: connection.data?.connection_state || "disconnected",
    errorCode: connection.data?.error_code || "",
    providerOpenId: connection.data?.provider_subject || "",
    providerUsername: connection.data?.provider_email || "",
    grantedScopes: scopes,
    uploadConnected: connection.data?.connection_state === "connected" &&
      hasScopes(scopes, UPLOAD_SCOPES),
    directPostConnected: connection.data?.connection_state === "connected" &&
      hasScopes(scopes, DIRECT_SCOPES),
    expiresAt: connection.data?.expires_at || null,
  });
}

async function start(req: Request, origin: string, body: OAuthBody) {
  if (!credentialsConfigured()) {
    return json(origin, 503, {
      error: "TikTok client credentials are not configured",
    });
  }
  const user = await caller(req);
  if (!user) return json(origin, 401, { error: "Sign in first" });
  const ledgerId = String(body.ledgerId || "").trim();
  if (!SAFE_UUID.test(ledgerId)) {
    return json(origin, 400, { error: "Invalid account id" });
  }
  const ledger = await ownedLedger(ledgerId, user.id);
  if (!ledger || ledger.suspended) {
    return json(origin, 404, {
      error: "Owned active TikTok account not found",
    });
  }
  const username = normalizeUsername(ledger.username);
  if (!SAFE_USERNAME.test(username)) {
    return json(origin, 409, {
      error: "Record the exact TikTok username before connecting",
    });
  }
  const direct = body.enableDirectPost === true;
  if (direct && !directConfigurationExplicit()) {
    return json(origin, 409, {
      error:
        "Direct Post remains disabled until the explicit client audit state and release flag are configured.",
      uploadInboxAvailable: true,
    });
  }
  const existing = await admin.from("account_connections")
    .select("connection_state,error_code").eq("ledger_id", ledger.id)
    .eq("owner", ledger.owner).maybeSingle();
  if (existing.error) {
    return json(origin, 503, {
      error: "Connection state could not be checked",
    });
  }
  if (existing.data?.connection_state === "connected") {
    return json(origin, 409, {
      error: "Disconnect the current TikTok grant before reconnecting",
    });
  }
  if (existing.data?.error_code === "tiktok_manual_revoke_required") {
    return json(origin, 409, {
      error:
        "Revoke MyPersonas in TikTok Manage app permissions, then confirm reset first.",
      manualRevocationRequired: true,
    });
  }
  const state = randomUrlSafe(48);
  const browserNonce = randomUrlSafe(48);
  const codeVerifier = randomUrlSafe(64);
  // TikTok's PKCE documentation specifies a hex-encoded SHA-256 challenge.
  const codeChallenge = await sha256Hex(codeVerifier);
  const scopes = [...(direct ? DIRECT_SCOPES : UPLOAD_SCOPES)];
  await admin.from("tiktok_oauth_transactions").delete()
    .eq("owner", user.id).eq("ledger_id", ledger.id);
  const stored = await admin.from("tiktok_oauth_transactions").insert({
    state_hash: await sha256Hex(state),
    owner: user.id,
    ledger_id: ledger.id,
    code_verifier: codeVerifier,
    browser_nonce_hash: await sha256Hex(browserNonce),
    requested_scopes: scopes,
    access_mode: direct ? "direct" : "upload",
    return_origin: origin,
    expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
  });
  if (stored.error) {
    return json(origin, 500, {
      error: "TikTok authorization could not be started",
    });
  }
  const target = new URL(AUTHORIZE_URL);
  target.searchParams.set("client_key", TIKTOK_CLIENT_KEY);
  target.searchParams.set("response_type", "code");
  target.searchParams.set("scope", scopes.join(","));
  target.searchParams.set("redirect_uri", CALLBACK_URL);
  target.searchParams.set("state", state);
  target.searchParams.set("code_challenge", codeChallenge);
  target.searchParams.set("code_challenge_method", "S256");
  return json(origin, 200, {
    authorizationUrl: target.toString(),
    browserNonce,
    accessMode: direct ? "direct" : "upload",
    requestedScopes: scopes,
  });
}

async function callback(url: URL) {
  const state = (url.searchParams.get("state") || "").trim();
  if (state.length < 32 || state.length > 512) {
    return redirectToApp({ tiktok: "error", reason: "invalid_state" });
  }
  const stateHash = await sha256Hex(state);
  const tx = await admin.from("tiktok_oauth_transactions")
    .select("return_origin,expires_at").eq("state_hash", stateHash)
    .maybeSingle();
  if (tx.error || !tx.data || Date.parse(tx.data.expires_at) <= Date.now()) {
    return redirectToApp({ tiktok: "error", reason: "expired_state" });
  }
  const code = (url.searchParams.get("code") || "").trim().slice(0, 8192);
  const providerError = (url.searchParams.get("error") || "").trim().slice(
    0,
    120,
  );
  return redirectToApp({
    tiktok: "finish",
    state,
    code,
    provider_error: providerError,
  }, tx.data.return_origin);
}

async function complete(req: Request, origin: string, body: OAuthBody) {
  if (!credentialsConfigured()) {
    return json(origin, 503, {
      error: "TikTok authorization is not configured",
    });
  }
  const user = await caller(req);
  if (!user) return json(origin, 401, { error: "Sign in first" });
  const state = String(body.state || "").trim();
  const browserNonce = String(body.browserNonce || "").trim();
  const code = String(body.code || "").trim();
  if (
    state.length < 32 || state.length > 512 || browserNonce.length < 32 ||
    browserNonce.length > 512 || code.length > 8192
  ) {
    return json(origin, 400, {
      error: "TikTok authorization expired or is invalid",
    });
  }
  const consumed = await admin.rpc("consume_tiktok_oauth_state", {
    p_state_hash: await sha256Hex(state),
    p_owner: user.id,
    p_browser_nonce_hash: await sha256Hex(browserNonce),
  });
  const tx =
    (Array.isArray(consumed.data) ? consumed.data[0] : consumed.data) as
      | OAuthTransaction
      | null;
  if (consumed.error || !tx) {
    return json(origin, 400, {
      error:
        "TikTok authorization expired or opened in a different browser session",
    });
  }
  const ledger = await ownedLedger(tx.ledger_id, user.id);
  if (!ledger || ledger.suspended) {
    return json(origin, 404, { error: "Owned TikTok account not found" });
  }
  const leaseId = await claimLease(ledger, "connect");
  if (!leaseId) {
    return json(origin, 409, {
      error: "Another TikTok authorization operation is in progress",
    });
  }
  try {
    if (body.providerError || !code) {
      await markConnectionError(
        ledger,
        body.providerError === "access_denied"
          ? "tiktok_access_denied"
          : "tiktok_oauth_error",
        true,
      );
      return json(origin, 400, {
        error: body.providerError
          ? "TikTok authorization was cancelled"
          : "TikTok returned no authorization code",
      });
    }
    const requestedScopes = normalizeScopes(tx.requested_scopes);
    if (
      !hasScopes(
        requestedScopes,
        tx.access_mode === "direct" ? DIRECT_SCOPES : UPLOAD_SCOPES,
      ) ||
      (tx.access_mode === "direct" && !directConfigurationExplicit())
    ) {
      return json(origin, 409, {
        error: "The requested TikTok access mode is no longer enabled",
      });
    }
    const exchanged = await exchangeCode(code, tx.code_verifier);
    if (!exchanged.token) {
      await markConnectionError(
        ledger,
        exchanged.uncertain
          ? "tiktok_manual_revoke_required"
          : "tiktok_token_exchange_failed",
        true,
      );
      return json(origin, exchanged.uncertain ? 502 : 400, {
        error: exchanged.uncertain
          ? "TikTok did not confirm whether the code exchange completed. Revoke MyPersonas in TikTok Manage app permissions before reset."
          : "TikTok rejected the authorization code.",
        manualRevocationRequired: exchanged.uncertain,
      });
    }
    const token = exchanged.token;
    if (!hasScopes(token.scopes, requestedScopes)) {
      return await cleanupAfterGrant(
        ledger,
        token,
        "tiktok_scope_missing",
        "TikTok did not grant every requested identity and content permission.",
        origin,
      );
    }
    const identityResult = await fetchIdentity(token.accessToken, token.openId);
    if (!identityResult.identity) {
      return await cleanupAfterGrant(
        ledger,
        token,
        identityResult.uncertain
          ? "tiktok_identity_unreachable"
          : "tiktok_identity_invalid",
        "The selected TikTok identity could not be verified.",
        origin,
      );
    }
    const identity = identityResult.identity;
    if (identity.username !== normalizeUsername(ledger.username)) {
      return await cleanupAfterGrant(
        ledger,
        token,
        "tiktok_username_mismatch",
        "The selected TikTok account does not match the exact username recorded here.",
        origin,
      );
    }
    const duplicate = await admin.from("tiktok_credentials").select("ledger_id")
      .eq("provider_open_id", identity.openId).neq("ledger_id", ledger.id)
      .maybeSingle();
    if (duplicate.error || duplicate.data) {
      return await cleanupAfterGrant(
        ledger,
        token,
        "tiktok_open_id_already_connected",
        "This TikTok identity is already bound to another account record.",
        origin,
      );
    }
    const stored = await storeToken(ledger, token, identity);
    if (stored.error) {
      return await cleanupAfterGrant(
        ledger,
        token,
        "tiktok_token_storage_failed",
        "TikTok authorized, but the credential could not be stored safely.",
        origin,
      );
    }
    return json(origin, 200, {
      connected: true,
      ledgerId: ledger.id,
      providerOpenId: identity.openId,
      username: identity.username,
      displayName: identity.displayName,
      accessMode: tx.access_mode,
      grantedScopes: token.scopes,
      uploadInboxEnabled: hasScopes(token.scopes, UPLOAD_SCOPES),
      directPostEnabled: directConfigurationExplicit() &&
        hasScopes(token.scopes, DIRECT_SCOPES),
    });
  } finally {
    await releaseLease(ledger, leaseId);
  }
}

async function refresh(req: Request, origin: string, ledgerId: string) {
  if (!credentialsConfigured()) {
    return json(origin, 503, {
      error: "TikTok authorization is not configured",
    });
  }
  const user = await caller(req);
  if (!user) return json(origin, 401, { error: "Sign in first" });
  if (!SAFE_UUID.test(ledgerId)) {
    return json(origin, 400, { error: "Invalid account id" });
  }
  const ledger = await ownedLedger(ledgerId, user.id);
  if (!ledger || ledger.suspended) {
    return json(origin, 404, {
      error: "Owned active TikTok account not found",
    });
  }
  const leaseId = await claimLease(ledger, "refresh");
  if (!leaseId) {
    return json(origin, 409, {
      error: "Another TikTok token operation is in progress",
    });
  }
  try {
    const stored = await getStoredToken(ledger);
    if (!stored || stored.openId === "") {
      return json(origin, 409, { error: "Reconnect this TikTok account" });
    }
    const refreshed = await refreshToken(stored);
    if (!refreshed.token) {
      await markConnectionError(
        ledger,
        refreshed.uncertain
          ? "tiktok_manual_revoke_required"
          : "tiktok_refresh_failed",
        true,
      );
      return json(origin, refreshed.uncertain ? 502 : 401, {
        error: refreshed.uncertain
          ? "TikTok did not confirm token rotation. Revoke MyPersonas in TikTok before reset."
          : "TikTok rejected the refresh token. Reconnect this account.",
        manualRevocationRequired: refreshed.uncertain,
      });
    }
    const token = refreshed.token;
    if (
      token.openId !== stored.openId || !hasScopes(token.scopes, UPLOAD_SCOPES)
    ) {
      await markConnectionError(
        ledger,
        "tiktok_refreshed_identity_invalid",
        true,
      );
      return json(origin, 409, {
        error:
          "The refreshed TikTok identity or scopes changed. Revoke and reconnect.",
      });
    }
    const identityResult = await fetchIdentity(token.accessToken, token.openId);
    if (
      !identityResult.identity ||
      identityResult.identity.username !== normalizeUsername(ledger.username)
    ) {
      await markConnectionError(
        ledger,
        "tiktok_refreshed_identity_invalid",
        true,
      );
      return json(origin, 409, {
        error: "The refreshed TikTok identity no longer matches this account.",
      });
    }
    const saved = await storeToken(ledger, token, identityResult.identity);
    if (saved.error) {
      await markConnectionError(ledger, "tiktok_manual_revoke_required", true);
      return json(origin, 502, {
        error:
          "TikTok rotated the token, but the new token could not be stored. Revoke MyPersonas in TikTok before reset.",
        manualRevocationRequired: true,
      });
    }
    return json(origin, 200, {
      refreshed: true,
      ledgerId: ledger.id,
      grantedScopes: token.scopes,
    });
  } finally {
    await releaseLease(ledger, leaseId);
  }
}

async function disconnect(req: Request, origin: string, ledgerId: string) {
  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: {
      headers: { Authorization: req.headers.get("Authorization") || "" },
    },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const guard = await requireAal2(req, userClient);
  if (!guard.ok) {
    return json(origin, guard.status, { error: guard.error, code: guard.code });
  }
  if (!SAFE_UUID.test(ledgerId)) {
    return json(origin, 400, { error: "Invalid account id" });
  }
  const ledger = await ownedLedger(ledgerId, guard.user.id);
  if (!ledger) {
    return json(origin, 404, { error: "Owned TikTok account not found" });
  }
  const leaseId = await claimLease(ledger, "disconnect");
  if (!leaseId) {
    return json(origin, 409, {
      error: "Another TikTok token operation is in progress",
    });
  }
  try {
    const token = await getStoredToken(ledger);
    if (!token) {
      await admin.rpc("tiktok_delete_token_bundle", {
        p_ledger_id: ledger.id,
        p_owner: ledger.owner,
      });
      return json(origin, 200, {
        disconnected: true,
        providerGrantPresent: false,
      });
    }
    const revoked = await revokeAtProvider(token.accessToken);
    if (!revoked.revoked) {
      await markConnectionError(ledger, "tiktok_manual_revoke_required", true);
      return json(origin, revoked.uncertain ? 502 : 409, {
        error:
          "TikTok did not confirm revocation. Revoke MyPersonas in TikTok Manage app permissions before reset.",
        manualRevocationRequired: true,
      });
    }
    const deleted = await admin.rpc("tiktok_delete_token_bundle", {
      p_ledger_id: ledger.id,
      p_owner: ledger.owner,
    });
    if (deleted.error) {
      return json(origin, 500, {
        error: "TikTok revoked access, but local cleanup needs attention",
      });
    }
    return json(origin, 200, {
      disconnected: true,
      providerGrantPresent: false,
    });
  } finally {
    await releaseLease(ledger, leaseId);
  }
}

async function reset(req: Request, origin: string, body: OAuthBody) {
  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: {
      headers: { Authorization: req.headers.get("Authorization") || "" },
    },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const guard = await requireAal2(req, userClient);
  if (!guard.ok) {
    return json(origin, guard.status, { error: guard.error, code: guard.code });
  }
  const ledgerId = String(body.ledgerId || "").trim();
  if (!SAFE_UUID.test(ledgerId)) {
    return json(origin, 400, { error: "Invalid account id" });
  }
  if (body.manualRevocationAcknowledged !== true) {
    return json(origin, 409, {
      error:
        "Confirm that you revoked MyPersonas in TikTok Manage app permissions first",
    });
  }
  const ledger = await ownedLedger(ledgerId, guard.user.id);
  if (!ledger) {
    return json(origin, 404, { error: "Owned TikTok account not found" });
  }
  const connection = await admin.from("account_connections")
    .select("error_code").eq("ledger_id", ledger.id).eq("owner", ledger.owner)
    .eq("provider", "tiktok").maybeSingle();
  if (
    connection.error ||
    connection.data?.error_code !== "tiktok_manual_revoke_required"
  ) {
    return json(origin, 409, {
      error:
        "Manual reset is available only for an ambiguous TikTok revocation state",
    });
  }
  const leaseId = await claimLease(ledger, "reset");
  if (!leaseId) {
    return json(origin, 409, {
      error: "Another TikTok token operation is in progress",
    });
  }
  try {
    const deleted = await admin.rpc("tiktok_delete_token_bundle", {
      p_ledger_id: ledger.id,
      p_owner: ledger.owner,
    });
    if (deleted.error) {
      return json(origin, 500, {
        error: "The local TikTok credential could not be cleared",
      });
    }
    return json(origin, 200, { reset: true, ledgerId: ledger.id });
  } finally {
    await releaseLease(ledger, leaseId);
  }
}

serve(async (req) => {
  const origin = req.headers.get("Origin") || "";
  if (req.method === "OPTIONS") {
    return ALLOWED_ORIGINS.has(origin)
      ? new Response(null, { status: 204, headers: cors(origin) })
      : new Response(null, { status: 403 });
  }
  if (req.method === "GET") return await callback(new URL(req.url));
  if (req.method !== "POST") {
    return json(origin, 405, { error: "Method not allowed" });
  }
  if (!ALLOWED_ORIGINS.has(origin)) {
    return json(origin, 403, { error: "Origin not allowed" });
  }
  let body: OAuthBody;
  try {
    body = await req.json() as OAuthBody;
  } catch {
    return json(origin, 400, { error: "Invalid JSON" });
  }
  const action = String(body.action || "");
  if (action === "capabilities") {
    return await capabilities(req, origin, String(body.ledgerId || ""));
  }
  if (action === "start") return await start(req, origin, body);
  if (action === "complete") return await complete(req, origin, body);
  if (action === "refresh") {
    return await refresh(req, origin, String(body.ledgerId || ""));
  }
  if (action === "disconnect") {
    return await disconnect(req, origin, String(body.ledgerId || ""));
  }
  if (action === "reset") return await reset(req, origin, body);
  return json(origin, 400, { error: "Unknown TikTok OAuth action" });
});
