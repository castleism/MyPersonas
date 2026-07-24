// twitter-oauth — X / Twitter OAuth 2.0 Authorization Code + PKCE.
//
// Frontend contract (all POST requests require the signed-in user's Supabase
// bearer token and an allowed Origin):
//   { action:"capabilities", ledgerId? }
//   { action:"start", ledgerId }
//     -> { authorizationUrl, browserNonce }
//   { action:"complete", state, code, browserNonce, providerError? }
//   { action:"refresh", ledgerId }
//   { action:"disconnect", ledgerId }
//   { action:"reset", ledgerId, manualRevocationAcknowledged? }
//
// X redirects to GET /twitter-oauth. This function validates the hashed state
// record and redirects to the initiating app origin with:
//   twitter=finish, state, code, provider_error
// or:
//   twitter=error, reason
// The frontend must retain browserNonce only in the initiating browser session,
// call "complete" immediately (X authorization codes are short-lived), and then
// remove OAuth parameters from the visible URL. If an ambiguous provider
// response returns manualRevocationRequired:true, the owner must revoke
// MyPersonas in X Connected Apps and explicitly send
// manualRevocationAcknowledged:true with "reset"; no credential is deleted
// merely because an ambiguous provider request failed.
//
// Tokens are never returned to the browser. Access and refresh tokens are stored
// only in Supabase Vault by service-only migration 015 RPCs. This connector does
// not contain any X posting endpoint and reports postingEnabled:false.
//
// Deploy without gateway JWT verification because the X callback has no
// Supabase Authorization header. Every POST action validates the JWT manually.
// Deploy: supabase functions deploy twitter-oauth --no-verify-jwt
// Required secrets: X_CLIENT_ID, X_CLIENT_SECRET
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const X_CLIENT_ID = Deno.env.get("X_CLIENT_ID") || "";
const X_CLIENT_SECRET = Deno.env.get("X_CLIENT_SECRET") || "";
const CALLBACK_URL = Deno.env.get("X_OAUTH_REDIRECT_URI") ||
  "https://nwsqyuucwzihruszocge.supabase.co/functions/v1/twitter-oauth";
const APP_RETURN_URL = Deno.env.get("X_OAUTH_APP_URL") ||
  "https://mypersonas.online/#/studio";

const X_AUTHORIZATION_URL = "https://x.com/i/oauth2/authorize";
const X_TOKEN_URL = "https://api.x.com/2/oauth2/token";
const X_REVOKE_URL = "https://api.x.com/2/oauth2/revoke";
const X_ME_URL = "https://api.x.com/2/users/me";
// Least privilege for identity binding and durable connection health. A future
// posting connector must request tweet.write through explicit reauthorization
// only after its publish path and consent UI are reviewed and enabled.
const REQUIRED_SCOPES = [
  "tweet.read",
  "users.read",
  "offline.access",
] as const;
const LOCAL_RESET_ERROR_CODES = new Set([
  "twitter_already_connected",
  "shared_grant_cleanup_failed",
  "local_credential_cleanup_failed",
]);
const NO_PROVIDER_GRANT_ERROR_CODES = new Set([
  "x_access_denied",
  "x_oauth_error",
  "missing_authorization_code",
  "x_token_exchange_failed",
]);
const ALLOWED_ORIGINS = new Set([
  "https://aliaspaces.com",
  "https://www.aliaspaces.com",
  "https://app.aliaspaces.com",
  "https://mypersonas.online",
]);

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

type Ledger = {
  id: string;
  owner: string;
  provider: string;
  username: string | null;
};

type OAuthTransaction = {
  owner: string;
  ledger_id: string;
  code_verifier: string;
};

type OAuthActionBody = {
  action?: string;
  ledgerId?: string;
  code?: string;
  state?: string;
  browserNonce?: string;
  providerError?: string;
  manualRevocationAcknowledged?: boolean;
};

type XIdentity = {
  id: string;
  username: string;
  name: string;
};

type XToken = {
  accessToken: string;
  refreshToken: string;
  tokenType: string;
  scopes: string[];
  expiresAt: string;
};

type StoredCredential = XToken & {
  providerSubject: string;
  providerUsername: string;
};

type ProviderGrantFailureOptions = {
  errorCode: string;
  message: string;
  status?: number;
  token?: XToken | null;
  identity?: XIdentity | null;
  allowRecoveryStorage?: boolean;
};

function cors(origin: string) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Cache-Control": "no-store",
    "Vary": "Origin",
  };
}

function json(body: unknown, status = 200, origin = "") {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...(origin && ALLOWED_ORIGINS.has(origin) ? cors(origin) : {}),
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function redirectToApp(params: Record<string, string>, returnOrigin = "") {
  const target = new URL(
    ALLOWED_ORIGINS.has(returnOrigin)
      ? `${returnOrigin}/#/studio`
      : APP_RETURN_URL,
  );
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
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
}

async function sha256Hex(value: string) {
  return [...await sha256Bytes(value)].map((byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

function normalizeUsername(value: unknown) {
  return String(value || "").trim().replace(/^@+/, "").toLowerCase();
}

function validLedgerId(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    .test(value);
}

function credentialsConfigured() {
  return Boolean(X_CLIENT_ID && X_CLIENT_SECRET);
}

function basicAuthorization() {
  return `Basic ${btoa(`${X_CLIENT_ID}:${X_CLIENT_SECRET}`)}`;
}

function normalizeScopes(value: unknown) {
  const scopes = Array.isArray(value)
    ? value
    : typeof value === "string"
    ? value.split(/\s+/)
    : [];
  return [
    ...new Set(
      scopes.map((scope) => String(scope).trim()).filter(Boolean),
    ),
  ].sort();
}

function hasRequiredScopes(scopes: string[]) {
  return REQUIRED_SCOPES.every((scope) => scopes.includes(scope));
}

function safeExpiry(expiresIn: unknown) {
  const seconds = typeof expiresIn === "number" ? expiresIn : Number(expiresIn);
  const bounded = Number.isFinite(seconds)
    ? Math.min(86_400, Math.max(60, Math.floor(seconds)))
    : 7_200;
  return new Date(Date.now() + bounded * 1000).toISOString();
}

async function caller(req: Request) {
  const jwt = (req.headers.get("Authorization") || "").replace(
    /^Bearer\s+/i,
    "",
  );
  if (!jwt) return null;
  const { data, error } = await admin.auth.getUser(jwt);
  return error ? null : data.user;
}

async function ownedTwitterLedger(
  ledgerId: string,
  owner: string,
): Promise<Ledger | null> {
  const { data, error } = await admin.from("account_ledger")
    .select("id,owner,provider,username")
    .eq("id", ledgerId)
    .eq("owner", owner)
    .eq("provider", "twitter")
    .maybeSingle();
  return error || !data ? null : data as Ledger;
}

async function markConnectionError(
  ledger: Ledger,
  errorCode: string,
  force = false,
) {
  const { data: existing, error: lookupError } = await admin.from(
    "account_connections",
  )
    .select("connection_state")
    .eq("ledger_id", ledger.id)
    .maybeSingle();
  if (lookupError) return false;
  const now = new Date().toISOString();
  if (existing) {
    if (!force && existing.connection_state === "connected") return true;
    const { error } = await admin.from("account_connections").update({
      connection_state: "error",
      error_code: errorCode,
      last_checked_at: now,
      updated_at: now,
    }).eq("ledger_id", ledger.id).eq("owner", ledger.owner);
    return !error;
  }
  const { error } = await admin.from("account_connections").insert({
    ledger_id: ledger.id,
    owner: ledger.owner,
    provider: "twitter",
    provider_subject: "",
    provider_email: normalizeUsername(ledger.username),
    granted_scopes: [],
    connection_state: "error",
    verification_method: "x_oauth2_pkce",
    last_checked_at: now,
    error_code: errorCode,
    updated_at: now,
  });
  return !error;
}

async function markDisconnected(ledger: Ledger) {
  const now = new Date().toISOString();
  const { error } = await admin.from("account_connections").upsert(
    {
      ledger_id: ledger.id,
      owner: ledger.owner,
      provider: "twitter",
      provider_subject: "",
      provider_email: normalizeUsername(ledger.username),
      granted_scopes: [],
      connection_state: "disconnected",
      verification_method: "x_oauth2_pkce",
      connected_at: null,
      last_checked_at: now,
      expires_at: null,
      error_code: "",
      updated_at: now,
    },
    { onConflict: "ledger_id" },
  );
  return !error;
}

async function fetchXIdentity(accessToken: string) {
  try {
    const response = await fetch(
      `${X_ME_URL}?user.fields=id,name,username`,
      {
        headers: {
          "Authorization": `Bearer ${accessToken}`,
          "Accept": "application/json",
        },
        signal: AbortSignal.timeout(15_000),
      },
    );
    const payload = await response.json().catch(() => ({})) as {
      data?: Record<string, unknown>;
    };
    const id = typeof payload.data?.id === "string"
      ? payload.data.id.trim()
      : "";
    const username = typeof payload.data?.username === "string"
      ? payload.data.username.trim()
      : "";
    const name = typeof payload.data?.name === "string"
      ? payload.data.name.trim()
      : "";
    if (
      !response.ok || !/^[0-9]{1,32}$/.test(id) ||
      !/^[A-Za-z0-9_]{1,15}$/.test(username)
    ) {
      return { identity: null, unavailable: false };
    }
    return {
      identity: { id, username, name } as XIdentity,
      unavailable: false,
    };
  } catch {
    return { identity: null, unavailable: true };
  }
}

async function exchangeAuthorizationCode(
  code: string,
  codeVerifier: string,
) {
  try {
    const response = await fetch(X_TOKEN_URL, {
      method: "POST",
      headers: {
        "Authorization": basicAuthorization(),
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "application/json",
      },
      body: new URLSearchParams({
        code,
        grant_type: "authorization_code",
        redirect_uri: CALLBACK_URL,
        code_verifier: codeVerifier,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const payload = await response.json().catch(() => ({})) as Record<
      string,
      unknown
    >;
    if (
      !response.ok || typeof payload.access_token !== "string" ||
      !payload.access_token.trim() ||
      typeof payload.token_type !== "string" ||
      payload.token_type.toLowerCase() !== "bearer"
    ) {
      return {
        token: null,
        unavailable: response.status === 408 || response.status >= 500 ||
          response.status < 400,
      };
    }
    return {
      token: {
        accessToken: payload.access_token,
        refreshToken: typeof payload.refresh_token === "string"
          ? payload.refresh_token
          : "",
        tokenType: "bearer",
        scopes: normalizeScopes(payload.scope),
        expiresAt: safeExpiry(payload.expires_in),
      } as XToken,
      unavailable: false,
    };
  } catch {
    return { token: null, unavailable: true };
  }
}

async function refreshAtX(refreshToken: string, priorScopes: string[]) {
  try {
    const response = await fetch(X_TOKEN_URL, {
      method: "POST",
      headers: {
        "Authorization": basicAuthorization(),
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "application/json",
      },
      body: new URLSearchParams({
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const payload = await response.json().catch(() => ({})) as Record<
      string,
      unknown
    >;
    if (
      !response.ok || typeof payload.access_token !== "string" ||
      !payload.access_token.trim() ||
      typeof payload.token_type !== "string" ||
      payload.token_type.toLowerCase() !== "bearer"
    ) {
      return {
        token: null,
        unavailable: response.status === 408 || response.status >= 500 ||
          response.status < 400,
      };
    }
    const responseScopes = normalizeScopes(payload.scope);
    return {
      token: {
        accessToken: payload.access_token,
        refreshToken: typeof payload.refresh_token === "string" &&
            payload.refresh_token
          ? payload.refresh_token
          : refreshToken,
        tokenType: "bearer",
        scopes: responseScopes.length ? responseScopes : priorScopes,
        expiresAt: safeExpiry(payload.expires_in),
      } as XToken,
      unavailable: false,
    };
  } catch {
    return { token: null, unavailable: true };
  }
}

async function revokeXToken(token: string) {
  if (!token) return false;
  try {
    const response = await fetch(X_REVOKE_URL, {
      method: "POST",
      headers: {
        "Authorization": basicAuthorization(),
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "application/json",
      },
      body: new URLSearchParams({ token }),
      signal: AbortSignal.timeout(15_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function accessTokenConfirmedInvalid(accessToken: string) {
  if (!accessToken) return false;
  try {
    const response = await fetch(X_ME_URL, {
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Accept": "application/json",
      },
      signal: AbortSignal.timeout(15_000),
    });
    return response.status === 401;
  } catch {
    return false;
  }
}

async function revokeXGrantPair(refreshToken: string, accessToken: string) {
  if (!refreshToken || !accessToken) return false;
  const refreshRevoked = await revokeXToken(refreshToken);
  if (!refreshRevoked) return false;
  const accessRevoked = await revokeXToken(accessToken);
  if (accessRevoked) return true;
  // X documents access- and refresh-token revocation separately. If access
  // revocation is non-2xx after refresh revocation, accept only an explicit 401
  // from /2/users/me as proof that the access token is already invalid.
  return await accessTokenConfirmedInvalid(accessToken);
}

async function storeTokenBundle(
  ledger: Ledger,
  token: XToken,
  identity: XIdentity | null,
) {
  return await admin.rpc("twitter_store_token_bundle", {
    p_ledger_id: ledger.id,
    p_owner: ledger.owner,
    p_expected_ledger_username: normalizeUsername(ledger.username),
    p_provider_subject: identity?.id || "",
    p_provider_username: identity?.username || "",
    p_access_token: token.accessToken,
    p_refresh_token: token.refreshToken,
    p_token_type: token.tokenType,
    p_scope: token.scopes.join(" "),
    p_expires_at: token.expiresAt,
  });
}

async function getStoredCredential(
  ledger: Ledger,
): Promise<{ credential: StoredCredential | null; error: boolean }> {
  const { data, error } = await admin.rpc("twitter_get_token_bundle", {
    p_ledger_id: ledger.id,
    p_owner: ledger.owner,
  });
  if (error) return { credential: null, error: true };
  const row = (Array.isArray(data) ? data[0] : data) as
    | Record<string, unknown>
    | null;
  if (!row) return { credential: null, error: false };
  let bundle = row.token_bundle as Record<string, unknown> | string | null;
  if (typeof bundle === "string") {
    try {
      bundle = JSON.parse(bundle) as Record<string, unknown>;
    } catch {
      return { credential: null, error: true };
    }
  }
  if (!bundle || typeof bundle !== "object") {
    return { credential: null, error: true };
  }
  const accessToken = typeof bundle.access_token === "string"
    ? bundle.access_token
    : "";
  const refreshToken = typeof bundle.refresh_token === "string"
    ? bundle.refresh_token
    : "";
  const expiresAt = typeof bundle.expires_at === "string"
    ? bundle.expires_at
    : "";
  if (!accessToken || !expiresAt) {
    return { credential: null, error: true };
  }
  return {
    credential: {
      providerSubject: typeof row.provider_subject === "string"
        ? row.provider_subject
        : "",
      providerUsername: typeof row.provider_username === "string"
        ? row.provider_username
        : "",
      accessToken,
      refreshToken,
      tokenType: typeof bundle.token_type === "string"
        ? bundle.token_type
        : "bearer",
      scopes: normalizeScopes(bundle.scope),
      expiresAt,
    },
    error: false,
  };
}

async function deleteStoredCredential(ledger: Ledger) {
  const { error } = await admin.rpc("twitter_delete_token_bundle", {
    p_ledger_id: ledger.id,
    p_owner: ledger.owner,
  });
  return !error;
}

async function withTokenOperationLease(
  ledger: Ledger,
  operationKind: "connect" | "refresh" | "disconnect" | "reset",
  origin: string,
  operation: () => Promise<Response>,
) {
  const leaseId = crypto.randomUUID();
  const { data: claimed, error } = await admin.rpc(
    "claim_twitter_token_operation",
    {
      p_ledger_id: ledger.id,
      p_owner: ledger.owner,
      p_lease_id: leaseId,
      p_operation_kind: operationKind,
      p_ttl_seconds: 90,
    },
  );
  if (error) {
    return json(
      { error: "Could not safely start the X token operation" },
      500,
      origin,
    );
  }
  if (claimed !== true) {
    return json(
      {
        error:
          "Another X connection operation is already in progress. Please wait a moment and try again.",
      },
      409,
      origin,
    );
  }
  try {
    return await operation();
  } finally {
    await admin.rpc("release_twitter_token_operation", {
      p_ledger_id: ledger.id,
      p_owner: ledger.owner,
      p_lease_id: leaseId,
    });
  }
}

async function findSharedXIdentity(ledger: Ledger, subject: string) {
  const { data, error } = await admin.from("account_connections")
    .select("ledger_id")
    .eq("provider", "twitter")
    .eq("provider_subject", subject)
    .neq("ledger_id", ledger.id)
    .limit(1)
    .maybeSingle();
  return { shared: Boolean(data), error: Boolean(error) };
}

async function rejectSharedXGrant(
  ledger: Ledger,
  origin: string,
  localCleanupFailed = false,
) {
  const errorCode = localCleanupFailed
    ? "shared_grant_cleanup_failed"
    : "twitter_already_connected";
  const recorded = await markConnectionError(ledger, errorCode);
  if (!recorded) {
    return json(
      {
        error:
          "That X account is already connected elsewhere, but the local safety state could not be recorded.",
      },
      500,
      origin,
    );
  }
  return json(
    {
      error: localCleanupFailed
        ? "That X account is already connected elsewhere, and the attempted local credential copy could not be removed. Reset the local attempt; do not revoke the shared X grant."
        : "That X account is already connected elsewhere.",
      localResetAvailable: true,
    },
    localCleanupFailed ? 500 : 409,
    origin,
  );
}

async function failAfterProviderGrant(
  ledger: Ledger,
  origin: string,
  options: ProviderGrantFailureOptions,
) {
  const {
    errorCode,
    message,
    status = 400,
    token = null,
    identity = null,
    allowRecoveryStorage = true,
  } = options;
  let recoveryStored = false;
  if (allowRecoveryStorage && token?.accessToken) {
    const { error } = await storeTokenBundle(ledger, token, identity);
    recoveryStored = !error;
  }
  const manualRevocationRequired = Boolean(
    token?.accessToken && !recoveryStored,
  );
  const recorded = await markConnectionError(
    ledger,
    recoveryStored
      ? "twitter_revoke_required"
      : manualRevocationRequired
      ? "x_manual_revoke_required"
      : errorCode,
  );
  if (!recorded) {
    return json(
      {
        error:
          `${message} The X safety state could not be recorded. Review X Connected Apps and revoke MyPersonas before trying again.`,
        revocationRequired: true,
        manualRevocationRequired,
      },
      500,
      origin,
    );
  }
  return json(
    {
      error: recoveryStored
        ? `${message} Use Disconnect X to revoke the attempted grant before trying again.`
        : `${message} Review X Connected Apps and revoke MyPersonas there if access was granted.`,
      revocationRequired: true,
      manualRevocationRequired,
    },
    status,
    origin,
  );
}

async function capabilities(
  req: Request,
  origin: string,
  ledgerIdInput = "",
) {
  const user = await caller(req);
  if (!user) return json({ error: "Invalid or expired session" }, 401, origin);

  const result: Record<string, unknown> = {
    provider: "twitter",
    configured: credentialsConfigured(),
    authenticationEnabled: credentialsConfigured(),
    postingEnabled: false,
    requiredScopes: [...REQUIRED_SCOPES],
    refreshSupported: true,
    revokeSupported: true,
    callbackUrl: CALLBACK_URL,
  };
  const ledgerId = ledgerIdInput.trim();
  if (!ledgerId) return json(result, 200, origin);
  if (!validLedgerId(ledgerId)) {
    return json({ error: "Invalid account id" }, 400, origin);
  }
  const ledger = await ownedTwitterLedger(ledgerId, user.id);
  if (!ledger) {
    return json({ error: "Owned X account not found" }, 404, origin);
  }
  const [connection, credential] = await Promise.all([
    admin.from("account_connections")
      .select("connection_state,error_code,expires_at")
      .eq("ledger_id", ledger.id)
      .maybeSingle(),
    admin.from("twitter_credentials")
      .select("ledger_id")
      .eq("ledger_id", ledger.id)
      .eq("owner", ledger.owner)
      .maybeSingle(),
  ]);
  if (connection.error || credential.error) {
    return json({ error: "Could not inspect the X connection" }, 500, origin);
  }
  result.ledgerId = ledger.id;
  result.recordedUsername = normalizeUsername(ledger.username);
  result.connectionState = connection.data?.connection_state || "disconnected";
  result.errorCode = connection.data?.error_code || "";
  result.expiresAt = connection.data?.expires_at || null;
  result.credentialPresent = Boolean(credential.data);
  return json(result, 200, origin);
}

async function startAuthorization(
  req: Request,
  origin: string,
  ledgerIdInput = "",
) {
  if (!credentialsConfigured()) {
    return json(
      { error: "X authorization is not configured yet" },
      503,
      origin,
    );
  }
  const user = await caller(req);
  if (!user) return json({ error: "Invalid or expired session" }, 401, origin);

  const ledgerId = ledgerIdInput.trim();
  if (!validLedgerId(ledgerId)) {
    return json({ error: "Invalid account id" }, 400, origin);
  }
  const ledger = await ownedTwitterLedger(ledgerId, user.id);
  const ledgerUsername = normalizeUsername(ledger?.username);
  if (
    !ledger || !/^[a-z0-9_]{1,15}$/i.test(ledgerUsername)
  ) {
    return json(
      { error: "Owned X account with a valid username is required" },
      404,
      origin,
    );
  }

  const [connection, credential, matchingUsername] = await Promise.all([
    admin.from("account_connections")
      .select("connection_state,error_code")
      .eq("ledger_id", ledger.id)
      .maybeSingle(),
    admin.from("twitter_credentials")
      .select("ledger_id")
      .eq("ledger_id", ledger.id)
      .eq("owner", ledger.owner)
      .maybeSingle(),
    admin.from("account_connections")
      .select("ledger_id")
      .eq("provider", "twitter")
      .eq("provider_email", ledgerUsername)
      .eq("connection_state", "connected")
      .neq("ledger_id", ledger.id)
      .limit(1)
      .maybeSingle(),
  ]);
  if (connection.error || credential.error || matchingUsername.error) {
    return json(
      { error: "Could not inspect the current X connection" },
      500,
      origin,
    );
  }
  if (connection.data?.connection_state === "connected") {
    return json(
      {
        error:
          "This X account is already connected. Disconnect it before authorizing it again.",
      },
      409,
      origin,
    );
  }
  if (
    connection.data?.connection_state === "error" &&
    connection.data.error_code === "x_manual_revoke_required"
  ) {
    return json(
      {
        error:
          "Revoke MyPersonas in X Connected Apps, then confirm manual revocation before authorizing again.",
        manualRevocationRequired: true,
      },
      409,
      origin,
    );
  }
  if (
    connection.data?.connection_state === "error" &&
    LOCAL_RESET_ERROR_CODES.has(connection.data.error_code || "")
  ) {
    return json(
      {
        error:
          "Reset the failed local X attempt before authorizing again. Do not revoke the shared X grant.",
        localResetRequired: true,
      },
      409,
      origin,
    );
  }
  if (
    !credential.data &&
    connection.data?.connection_state === "error" &&
    !NO_PROVIDER_GRANT_ERROR_CODES.has(connection.data.error_code || "")
  ) {
    const recorded = await markConnectionError(
      ledger,
      "x_manual_revoke_required",
      true,
    );
    return json(
      {
        error: recorded
          ? "This failed X connection may still have provider access. Revoke MyPersonas in X Connected Apps, then confirm manual revocation before authorizing again."
          : "This failed X connection may still have provider access, and the local safety state could not be recorded. Revoke MyPersonas in X Connected Apps before trying again.",
        manualRevocationRequired: true,
      },
      recorded ? 409 : 500,
      origin,
    );
  }
  if (credential.data) {
    const localResetRequired = LOCAL_RESET_ERROR_CODES.has(
      connection.data?.error_code || "",
    );
    return json(
      {
        error: localResetRequired
          ? "Reset the failed local X attempt before authorizing again."
          : "Disconnect the previous X authorization before authorizing again.",
        localResetRequired,
        revocationRequired: !localResetRequired,
      },
      409,
      origin,
    );
  }
  if (matchingUsername.data) {
    return json(
      { error: "That X username is already connected elsewhere." },
      409,
      origin,
    );
  }

  const state = randomUrlSafe(32);
  const browserNonce = randomUrlSafe(32);
  const verifier = randomUrlSafe(64);
  const stateHash = await sha256Hex(state);
  const browserNonceHash = await sha256Hex(browserNonce);
  const challenge = base64Url(await sha256Bytes(verifier));
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();

  await admin.from("twitter_oauth_transactions").delete().lt(
    "expires_at",
    new Date().toISOString(),
  );
  const { error: stateError } = await admin.from("twitter_oauth_transactions")
    .upsert({
      state_hash: stateHash,
      owner: user.id,
      ledger_id: ledger.id,
      code_verifier: verifier,
      browser_nonce_hash: browserNonceHash,
      return_origin: origin,
      expires_at: expiresAt,
    }, { onConflict: "owner,ledger_id" });
  if (stateError) {
    return json({ error: "Could not start X authorization" }, 500, origin);
  }

  const authorization = new URL(X_AUTHORIZATION_URL);
  authorization.search = new URLSearchParams({
    response_type: "code",
    client_id: X_CLIENT_ID,
    redirect_uri: CALLBACK_URL,
    scope: REQUIRED_SCOPES.join(" "),
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();

  return json(
    {
      authorizationUrl: authorization.toString(),
      browserNonce,
      postingEnabled: false,
    },
    200,
    origin,
  );
}

async function callback(req: Request) {
  const url = new URL(req.url);
  const rawState = url.searchParams.get("state") || "";
  const code = url.searchParams.get("code") || "";
  const providerError = url.searchParams.get("error") || "";
  if (rawState.length < 32 || rawState.length > 512) {
    return redirectToApp({ twitter: "error", reason: "invalid_state" });
  }
  const { data: pending, error } = await admin.from(
    "twitter_oauth_transactions",
  )
    .select("return_origin")
    .eq("state_hash", await sha256Hex(rawState))
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();
  const returnOrigin = !error && typeof pending?.return_origin === "string" &&
      ALLOWED_ORIGINS.has(pending.return_origin)
    ? pending.return_origin
    : "";
  if (!returnOrigin) {
    return redirectToApp({ twitter: "error", reason: "invalid_state" });
  }
  if ((!code && !providerError) || code.length > 8192) {
    return redirectToApp(
      { twitter: "error", reason: "missing_code" },
      returnOrigin,
    );
  }
  return redirectToApp({
    twitter: "finish",
    state: rawState,
    code,
    provider_error: providerError === "access_denied"
      ? "access_denied"
      : providerError
      ? "oauth_error"
      : "",
  }, returnOrigin);
}

async function completeAuthorization(
  req: Request,
  origin: string,
  body: OAuthActionBody,
) {
  if (!credentialsConfigured()) {
    return json(
      { error: "X authorization is not configured yet" },
      503,
      origin,
    );
  }
  const user = await caller(req);
  if (!user) return json({ error: "Invalid or expired session" }, 401, origin);

  const rawState = (body.state || "").trim();
  const browserNonce = (body.browserNonce || "").trim();
  const code = (body.code || "").trim();
  const providerError = body.providerError === "access_denied"
    ? "access_denied"
    : body.providerError
    ? "oauth_error"
    : "";
  if (
    rawState.length < 32 || rawState.length > 512 ||
    browserNonce.length < 32 || browserNonce.length > 512 ||
    code.length > 8192
  ) {
    return json(
      { error: "The X authorization expired. Please try again." },
      400,
      origin,
    );
  }

  const { data: consumed, error: stateError } = await admin.rpc(
    "consume_twitter_oauth_state",
    {
      p_state_hash: await sha256Hex(rawState),
      p_owner: user.id,
      p_browser_nonce_hash: await sha256Hex(browserNonce),
    },
  );
  const transaction = (Array.isArray(consumed) ? consumed[0] : consumed) as
    | OAuthTransaction
    | null;
  if (stateError || !transaction) {
    return json(
      {
        error:
          "The X authorization expired or was opened in a different browser session.",
      },
      400,
      origin,
    );
  }

  const ledger = await ownedTwitterLedger(transaction.ledger_id, user.id);
  if (!ledger) {
    return json({ error: "The X account record was not found." }, 404, origin);
  }
  return withTokenOperationLease(ledger, "connect", origin, async () => {
    if (providerError) {
      await markConnectionError(
        ledger,
        providerError === "access_denied" ? "x_access_denied" : "x_oauth_error",
      );
      return json(
        {
          error: providerError === "access_denied"
            ? "X authorization was cancelled."
            : "X could not complete authorization.",
        },
        400,
        origin,
      );
    }
    if (!code) {
      await markConnectionError(ledger, "missing_authorization_code");
      return json(
        { error: "X did not return an authorization code." },
        400,
        origin,
      );
    }

    const [currentConnection, currentCredential] = await Promise.all([
      admin.from("account_connections")
        .select("connection_state,error_code")
        .eq("ledger_id", ledger.id)
        .eq("owner", ledger.owner)
        .maybeSingle(),
      admin.from("twitter_credentials")
        .select("ledger_id")
        .eq("ledger_id", ledger.id)
        .eq("owner", ledger.owner)
        .maybeSingle(),
    ]);
    if (currentConnection.error || currentCredential.error) {
      return json(
        {
          error:
            "Could not safely recheck the X connection before exchanging the authorization code.",
        },
        500,
        origin,
      );
    }
    if (currentConnection.data?.connection_state === "connected") {
      return json(
        {
          error:
            "This X account was connected while another authorization was in progress. No second grant was requested.",
        },
        409,
        origin,
      );
    }
    if (
      currentConnection.data?.connection_state === "error" &&
      currentConnection.data.error_code === "x_manual_revoke_required"
    ) {
      return json(
        {
          error:
            "A prior X authorization has an ambiguous provider state. Revoke MyPersonas in X Connected Apps, then confirm manual revocation before trying again.",
          manualRevocationRequired: true,
        },
        409,
        origin,
      );
    }
    if (
      currentConnection.data?.connection_state === "error" &&
      LOCAL_RESET_ERROR_CODES.has(currentConnection.data.error_code || "")
    ) {
      return json(
        {
          error:
            "Reset the failed local X attempt before authorizing again. Do not revoke the shared X grant.",
          localResetRequired: true,
        },
        409,
        origin,
      );
    }
    if (currentCredential.data) {
      return json(
        {
          error:
            "A previous X authorization is still stored. Disconnect or reset it before authorizing again.",
        },
        409,
        origin,
      );
    }
    if (
      currentConnection.data?.connection_state === "error" &&
      !NO_PROVIDER_GRANT_ERROR_CODES.has(
        currentConnection.data.error_code || "",
      )
    ) {
      const recorded = await markConnectionError(
        ledger,
        "x_manual_revoke_required",
        true,
      );
      return json(
        {
          error: recorded
            ? "A prior X authorization may still have provider access. Revoke MyPersonas in X Connected Apps, then confirm manual revocation before trying again."
            : "A prior X authorization may still have provider access, and the local safety state could not be recorded. Revoke MyPersonas in X Connected Apps before trying again.",
          manualRevocationRequired: true,
        },
        recorded ? 409 : 500,
        origin,
      );
    }

    const exchanged = await exchangeAuthorizationCode(
      code,
      transaction.code_verifier,
    );
    if (!exchanged.token) {
      if (exchanged.unavailable) {
        const recorded = await markConnectionError(
          ledger,
          "x_manual_revoke_required",
          true,
        );
        return json(
          {
            error: recorded
              ? "X did not confirm whether the one-time authorization code was exchanged. Revoke MyPersonas in X Connected Apps, then confirm manual revocation to reset this account."
              : "X did not confirm whether the one-time authorization code was exchanged, and the local safety state could not be recorded. Revoke MyPersonas in X Connected Apps before trying again.",
            revocationRequired: true,
            manualRevocationRequired: true,
          },
          recorded ? 502 : 500,
          origin,
        );
      }
      await markConnectionError(
        ledger,
        "x_token_exchange_failed",
      );
      return json(
        { error: "X could not complete authorization. Please try again." },
        400,
        origin,
      );
    }
    const token = exchanged.token;

    const identityResult = await fetchXIdentity(token.accessToken);
    if (!identityResult.identity) {
      return failAfterProviderGrant(ledger, origin, {
        errorCode: identityResult.unavailable
          ? "x_identity_unreachable"
          : "x_identity_invalid",
        message: "The selected X account could not be verified.",
        status: identityResult.unavailable ? 502 : 400,
        token,
      });
    }
    const identity = identityResult.identity;

    const shared = await findSharedXIdentity(ledger, identity.id);
    if (shared.error) {
      return failAfterProviderGrant(ledger, origin, {
        errorCode: "x_identity_lookup_failed",
        message: "Could not safely check existing X connections.",
        status: 500,
        token,
        identity,
        allowRecoveryStorage: false,
      });
    }
    if (shared.shared) return rejectSharedXGrant(ledger, origin);

    if (!hasRequiredScopes(token.scopes)) {
      return failAfterProviderGrant(ledger, origin, {
        errorCode: "x_scope_missing",
        message:
          "X did not grant every required identity, reading, and offline-access permission.",
        token,
        identity,
      });
    }
    if (
      normalizeUsername(identity.username) !==
        normalizeUsername(ledger.username)
    ) {
      return failAfterProviderGrant(ledger, origin, {
        errorCode: "x_username_mismatch",
        message:
          "The selected X account does not match the username recorded here.",
        token,
        identity,
      });
    }
    if (!token.refreshToken) {
      return failAfterProviderGrant(ledger, origin, {
        errorCode: "x_refresh_token_missing",
        message:
          "X did not provide ongoing access. Revoke the attempt and authorize again.",
        token,
        identity,
      });
    }

    const stored = await storeTokenBundle(ledger, token, identity);
    if (stored.error) {
      if (stored.error.code === "23505") {
        return rejectSharedXGrant(ledger, origin);
      }
      return failAfterProviderGrant(ledger, origin, {
        errorCode: "x_token_storage_failed",
        message: "X authorization could not be stored securely.",
        status: 500,
        token,
        identity,
        allowRecoveryStorage: false,
      });
    }

    const now = new Date().toISOString();
    const { error: connectionError } = await admin.from("account_connections")
      .upsert({
        ledger_id: ledger.id,
        owner: ledger.owner,
        provider: "twitter",
        provider_subject: identity.id,
        provider_email: normalizeUsername(identity.username),
        granted_scopes: token.scopes,
        connection_state: "connected",
        verification_method: "x_oauth2_pkce",
        verified_at: now,
        connected_at: now,
        last_checked_at: now,
        expires_at: token.expiresAt,
        error_code: "",
        updated_at: now,
      }, { onConflict: "ledger_id" });
    if (connectionError) {
      if (connectionError.code === "23505") {
        const cleaned = await deleteStoredCredential(ledger);
        return rejectSharedXGrant(ledger, origin, !cleaned);
      }
      return failAfterProviderGrant(ledger, origin, {
        errorCode: "x_connection_save_failed",
        message: "X authorized, but the connection record could not be saved.",
        status: 500,
        token,
        identity,
      });
    }

    return json(
      {
        connected: true,
        ledgerId: ledger.id,
        identity: {
          id: identity.id,
          username: identity.username,
          name: identity.name,
        },
        postingEnabled: false,
      },
      200,
      origin,
    );
  });
}

async function refreshAuthorization(
  req: Request,
  origin: string,
  ledgerIdInput = "",
) {
  if (!credentialsConfigured()) {
    return json(
      { error: "X authorization is not configured yet" },
      503,
      origin,
    );
  }
  const user = await caller(req);
  if (!user) return json({ error: "Invalid or expired session" }, 401, origin);
  const ledgerId = ledgerIdInput.trim();
  if (!validLedgerId(ledgerId)) {
    return json({ error: "Invalid account id" }, 400, origin);
  }
  const ledger = await ownedTwitterLedger(ledgerId, user.id);
  if (!ledger) {
    return json({ error: "Owned X account not found" }, 404, origin);
  }
  return withTokenOperationLease(ledger, "refresh", origin, async () => {
    const { data: connection, error: connectionError } = await admin.from(
      "account_connections",
    )
      .select("provider_subject,connection_state")
      .eq("ledger_id", ledger.id)
      .eq("owner", ledger.owner)
      .maybeSingle();
    if (
      connectionError || !connection ||
      connection.connection_state !== "connected"
    ) {
      return json({ error: "This X account is not connected" }, 409, origin);
    }

    const stored = await getStoredCredential(ledger);
    if (stored.error || !stored.credential?.refreshToken) {
      await markConnectionError(ledger, "x_refresh_token_unavailable", true);
      return json(
        { error: "The stored X authorization could not be refreshed safely" },
        500,
        origin,
      );
    }
    const credential = stored.credential;
    if (
      !/^[0-9]{1,32}$/.test(credential.providerSubject) ||
      credential.providerSubject !== connection.provider_subject ||
      normalizeUsername(credential.providerUsername) !==
        normalizeUsername(ledger.username)
    ) {
      await markConnectionError(ledger, "x_stored_identity_invalid", true);
      return json(
        { error: "The stored X identity could not be safely verified." },
        409,
        origin,
      );
    }
    const refreshed = await refreshAtX(
      credential.refreshToken,
      credential.scopes,
    );
    if (!refreshed.token) {
      if (refreshed.unavailable) {
        // A timed-out refresh may have rotated the provider token even though
        // no response reached us. Keep the ambiguous Vault handle fail-closed.
        await markConnectionError(
          ledger,
          "x_manual_revoke_required",
          true,
        );
        return json(
          {
            error:
              "X did not confirm whether the refresh completed. Revoke MyPersonas in X Connected Apps before resetting this account.",
            manualRevocationRequired: true,
          },
          502,
          origin,
        );
      }
      await markConnectionError(
        ledger,
        "x_refresh_failed",
        true,
      );
      return json(
        {
          error: "X rejected the stored authorization. Reconnect this account.",
        },
        401,
        origin,
      );
    }
    const token = refreshed.token;
    // X may rotate refresh tokens. Persist the newly issued bundle before the
    // follow-up identity check so a transient /users/me failure cannot strand
    // the connection with an invalidated previous refresh token.
    const continuityIdentity: XIdentity = {
      id: credential.providerSubject,
      username: credential.providerUsername,
      name: "",
    };
    const saved = await storeTokenBundle(ledger, token, continuityIdentity);
    if (saved.error) {
      const providerCleanupConfirmed = await revokeXGrantPair(
        token.refreshToken,
        token.accessToken,
      );
      if (providerCleanupConfirmed) {
        const localCleanupConfirmed = await deleteStoredCredential(ledger);
        const disconnected = localCleanupConfirmed &&
          await markDisconnected(ledger);
        if (disconnected) {
          return json(
            {
              error:
                "The refreshed X authorization could not be stored. The new grant was revoked and this account was safely disconnected.",
              disconnected: true,
              xRevocationConfirmed: true,
            },
            500,
            origin,
          );
        }
      }
      await markConnectionError(
        ledger,
        "x_manual_revoke_required",
        true,
      );
      return json(
        {
          error:
            "The refreshed X grant could not be stored or safely cleaned up. Revoke MyPersonas in X Connected Apps before resetting this account.",
          manualRevocationRequired: true,
        },
        502,
        origin,
      );
    }
    if (!hasRequiredScopes(token.scopes)) {
      await markConnectionError(ledger, "x_scope_missing", true);
      return json(
        { error: "The refreshed X grant is missing required permissions." },
        403,
        origin,
      );
    }

    const identityResult = await fetchXIdentity(token.accessToken);
    const identity = identityResult.identity;
    if (
      !identity ||
      identity.id !== credential.providerSubject ||
      identity.id !== connection.provider_subject ||
      normalizeUsername(identity.username) !==
        normalizeUsername(credential.providerUsername) ||
      normalizeUsername(identity.username) !==
        normalizeUsername(ledger.username)
    ) {
      await markConnectionError(
        ledger,
        identityResult.unavailable
          ? "x_identity_unreachable"
          : "x_identity_changed",
        true,
      );
      return json(
        { error: "The refreshed X identity could not be safely verified." },
        identityResult.unavailable ? 502 : 409,
        origin,
      );
    }

    const now = new Date().toISOString();
    const { error: updateError } = await admin.from("account_connections")
      .update(
        {
          provider_email: normalizeUsername(identity.username),
          granted_scopes: token.scopes,
          connection_state: "connected",
          last_checked_at: now,
          expires_at: token.expiresAt,
          error_code: "",
          updated_at: now,
        },
      ).eq("ledger_id", ledger.id).eq("owner", ledger.owner);
    if (updateError) {
      await markConnectionError(ledger, "x_connection_update_failed", true);
      return json(
        {
          error:
            "The X authorization was refreshed, but its status could not be updated.",
        },
        500,
        origin,
      );
    }
    return json(
      {
        refreshed: true,
        ledgerId: ledger.id,
        expiresAt: token.expiresAt,
        postingEnabled: false,
      },
      200,
      origin,
    );
  });
}

async function disconnect(
  req: Request,
  origin: string,
  ledgerIdInput = "",
) {
  const user = await caller(req);
  if (!user) return json({ error: "Invalid or expired session" }, 401, origin);
  const ledgerId = ledgerIdInput.trim();
  if (!validLedgerId(ledgerId)) {
    return json({ error: "Invalid account id" }, 400, origin);
  }
  const ledger = await ownedTwitterLedger(ledgerId, user.id);
  if (!ledger) {
    return json({ error: "Owned X account not found" }, 404, origin);
  }

  return withTokenOperationLease(ledger, "disconnect", origin, async () => {
    const { data: connection, error: connectionError } = await admin.from(
      "account_connections",
    )
      .select("connection_state,error_code")
      .eq("ledger_id", ledger.id)
      .eq("owner", ledger.owner)
      .maybeSingle();
    if (connectionError) {
      return json(
        { error: "Could not inspect the current X connection" },
        500,
        origin,
      );
    }
    if (
      connection?.connection_state === "error" &&
      connection.error_code === "x_manual_revoke_required"
    ) {
      return json(
        {
          error:
            "X could not confirm the current grant state. Revoke MyPersonas in X Connected Apps, then confirm manual revocation to reset this account.",
          manualRevocationRequired: true,
        },
        409,
        origin,
      );
    }
    if (
      connection?.connection_state === "error" &&
      LOCAL_RESET_ERROR_CODES.has(connection.error_code || "")
    ) {
      return json(
        {
          error:
            "Reset this failed local X attempt without revoking the shared X grant.",
          localResetRequired: true,
        },
        409,
        origin,
      );
    }

    const stored = await getStoredCredential(ledger);
    if (stored.error) {
      return json(
        { error: "The stored X authorization could not be read safely" },
        500,
        origin,
      );
    }
    if (
      !stored.credential &&
      (connection?.connection_state === "connected" ||
        (connection?.connection_state === "error" &&
          !NO_PROVIDER_GRANT_ERROR_CODES.has(connection.error_code || "")))
    ) {
      const recorded = await markConnectionError(
        ledger,
        "x_manual_revoke_required",
        true,
      );
      return json(
        {
          error: recorded
            ? "This account has a prior X grant state but no local credential that can be revoked safely. Revoke MyPersonas in X Connected Apps, then confirm manual revocation to reset this account."
            : "This account has a prior X grant state but no local credential, and the local safety state could not be recorded. Revoke MyPersonas in X Connected Apps before trying again.",
          manualRevocationRequired: true,
        },
        recorded ? 409 : 500,
        origin,
      );
    }
    if (stored.credential) {
      if (!stored.credential.providerSubject) {
        // Recovery bundles created before /users/me succeeded have no attested
        // identity. Never revoke one blindly: it may represent the same X grant
        // already protected by another ledger. Re-resolve the identity, then
        // atomically bind it to this error row. The global provider-subject
        // uniqueness constraint closes the check-to-revoke race with another
        // concurrent connection.
        const recoveredIdentity = await fetchXIdentity(
          stored.credential.accessToken,
        );
        if (!recoveredIdentity.identity) {
          await markConnectionError(
            ledger,
            "x_manual_revoke_required",
            true,
          );
          return json(
            {
              error:
                "The recovery grant's X identity could not be verified safely. Revoke MyPersonas in X Connected Apps, then confirm manual revocation to reset this account.",
              manualRevocationRequired: true,
            },
            recoveredIdentity.unavailable ? 502 : 409,
            origin,
          );
        }
        const now = new Date().toISOString();
        const { data: identityClaim, error: identityClaimError } = await admin
          .from("account_connections")
          .update({
            provider_subject: recoveredIdentity.identity.id,
            provider_email: normalizeUsername(
              recoveredIdentity.identity.username,
            ),
            last_checked_at: now,
            updated_at: now,
          })
          .eq("ledger_id", ledger.id)
          .eq("owner", ledger.owner)
          .eq("provider", "twitter")
          .select("ledger_id")
          .maybeSingle();
        if (identityClaimError?.code === "23505") {
          if (
            !await deleteStoredCredential(ledger) ||
            !await markDisconnected(ledger)
          ) {
            return json(
              {
                error:
                  "The X grant is already protected by another ledger, but the local recovery copy could not be cleared.",
              },
              500,
              origin,
            );
          }
          return json(
            {
              disconnected: true,
              xRevocationConfirmed: false,
              xGrantUnchanged: true,
              sharedGrantProtected: true,
            },
            200,
            origin,
          );
        }
        if (identityClaimError || !identityClaim) {
          return json(
            {
              error:
                "The recovery grant identity could not be claimed safely. Nothing was revoked or deleted; please try again.",
            },
            500,
            origin,
          );
        }
      }
      if (!credentialsConfigured()) {
        return json(
          {
            error:
              "X revocation is not configured. Nothing was deleted; restore the X client configuration and try again.",
          },
          503,
          origin,
        );
      }
      if (
        !await revokeXGrantPair(
          stored.credential.refreshToken,
          stored.credential.accessToken,
        )
      ) {
        const recorded = await markConnectionError(
          ledger,
          "x_manual_revoke_required",
          true,
        );
        return json(
          {
            error: recorded
              ? "X did not confirm complete revocation. Revoke MyPersonas in X Connected Apps, then confirm manual revocation to reset this account."
              : "X did not confirm complete revocation, and the local safety state could not be recorded. Revoke MyPersonas in X Connected Apps before trying again.",
            manualRevocationRequired: true,
          },
          recorded ? 502 : 500,
          origin,
        );
      }
      if (!await deleteStoredCredential(ledger)) {
        return json(
          { error: "Could not remove the stored X authorization" },
          500,
          origin,
        );
      }
    }

    const now = new Date().toISOString();
    const { error: updateError } = await admin.from("account_connections")
      .upsert(
        {
          ledger_id: ledger.id,
          owner: ledger.owner,
          provider: "twitter",
          provider_subject: "",
          provider_email: normalizeUsername(ledger.username),
          granted_scopes: [],
          connection_state: "disconnected",
          verification_method: "x_oauth2_pkce",
          connected_at: null,
          last_checked_at: now,
          expires_at: null,
          error_code: "",
          updated_at: now,
        },
        { onConflict: "ledger_id" },
      );
    if (updateError) {
      return json(
        {
          error: stored.credential
            ? "X was revoked but local status could not be updated"
            : "The local X status could not be marked disconnected",
        },
        500,
        origin,
      );
    }
    return json(
      {
        disconnected: true,
        xRevocationConfirmed: Boolean(stored.credential),
      },
      200,
      origin,
    );
  });
}

async function resetLocalAttempt(
  req: Request,
  origin: string,
  ledgerIdInput = "",
  manualRevocationAcknowledged = false,
) {
  const user = await caller(req);
  if (!user) return json({ error: "Invalid or expired session" }, 401, origin);
  const ledgerId = ledgerIdInput.trim();
  if (!validLedgerId(ledgerId)) {
    return json({ error: "Invalid account id" }, 400, origin);
  }
  const ledger = await ownedTwitterLedger(ledgerId, user.id);
  if (!ledger) {
    return json({ error: "Owned X account not found" }, 404, origin);
  }
  return withTokenOperationLease(ledger, "reset", origin, async () => {
    const { data: connection, error } = await admin.from("account_connections")
      .select("connection_state,error_code")
      .eq("ledger_id", ledger.id)
      .eq("owner", ledger.owner)
      .maybeSingle();
    if (error) {
      return json(
        { error: "Could not inspect the failed X attempt" },
        500,
        origin,
      );
    }
    const manualRevocationRequired = connection?.connection_state === "error" &&
      connection.error_code === "x_manual_revoke_required";
    if (manualRevocationRequired && !manualRevocationAcknowledged) {
      return json(
        {
          error:
            "Revoke MyPersonas in X Connected Apps, then explicitly confirm manual revocation to reset this account.",
          manualRevocationRequired: true,
        },
        409,
        origin,
      );
    }
    if (
      connection?.connection_state !== "error" ||
      (!manualRevocationRequired &&
        !LOCAL_RESET_ERROR_CODES.has(connection.error_code || ""))
    ) {
      return json(
        { error: "This X connection must be disconnected, not locally reset" },
        409,
        origin,
      );
    }
    if (!await deleteStoredCredential(ledger)) {
      const { data: remaining, error: lookupError } = await admin.from(
        "twitter_credentials",
      )
        .select("ledger_id")
        .eq("ledger_id", ledger.id)
        .eq("owner", ledger.owner)
        .maybeSingle();
      if (lookupError || remaining) {
        return json(
          { error: "Could not remove the failed local X token copy" },
          500,
          origin,
        );
      }
    }

    if (!await markDisconnected(ledger)) {
      return json(
        {
          error: "The local token was removed but X status could not be reset",
        },
        500,
        origin,
      );
    }
    return json(
      {
        reset: true,
        xGrantUnchanged: !manualRevocationRequired,
        manualRevocationAcknowledged: manualRevocationRequired,
      },
      200,
      origin,
    );
  });
}

serve(async (req) => {
  const origin = req.headers.get("Origin") || "";
  if (req.method === "OPTIONS") {
    return ALLOWED_ORIGINS.has(origin)
      ? new Response("ok", { headers: cors(origin) })
      : new Response("Forbidden", { status: 403 });
  }
  if (req.method === "GET") return callback(req);
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!ALLOWED_ORIGINS.has(origin)) {
    return json({ error: "Origin not allowed" }, 403);
  }
  const contentLength = Number(req.headers.get("Content-Length") || "0");
  if (Number.isFinite(contentLength) && contentLength > 32_768) {
    return json({ error: "Request is too large" }, 413, origin);
  }

  let body: OAuthActionBody;
  try {
    const rawBody = await req.text();
    if (new TextEncoder().encode(rawBody).byteLength > 32_768) {
      return json({ error: "Request is too large" }, 413, origin);
    }
    body = JSON.parse(rawBody) as OAuthActionBody;
  } catch {
    return json({ error: "Invalid request" }, 400, origin);
  }
  if (body.action === "capabilities") {
    return capabilities(req, origin, body.ledgerId);
  }
  if (body.action === "start") {
    return startAuthorization(req, origin, body.ledgerId);
  }
  if (body.action === "complete") {
    return completeAuthorization(req, origin, body);
  }
  if (body.action === "refresh") {
    return refreshAuthorization(req, origin, body.ledgerId);
  }
  if (body.action === "disconnect") {
    return disconnect(req, origin, body.ledgerId);
  }
  if (body.action === "reset") {
    return resetLocalAttempt(
      req,
      origin,
      body.ledgerId,
      body.manualRevocationAcknowledged === true,
    );
  }
  return json({ error: "Unknown action" }, 400, origin);
});
