// gmail-oauth — dedicated per-ledger Gmail authorization.
//
// POST { action:"start", ledgerId } with the user's Supabase JWT returns a
// Google authorization URL. Google redirects back here with code + one-time
// state. Refresh tokens are stored only in Supabase Vault through service-only
// RPCs from migration 010; the browser never receives Google tokens.
//
// Deploy without gateway JWT verification because the Google callback has no
// Supabase Authorization header. POST actions still validate JWTs manually.
// Deploy: supabase functions deploy gmail-oauth --no-verify-jwt
// Secrets: GOOGLE_GMAIL_CLIENT_ID, GOOGLE_GMAIL_CLIENT_SECRET
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GOOGLE_CLIENT_ID = Deno.env.get("GOOGLE_GMAIL_CLIENT_ID") || "";
const GOOGLE_CLIENT_SECRET = Deno.env.get("GOOGLE_GMAIL_CLIENT_SECRET") || "";
const CALLBACK_URL = Deno.env.get("GMAIL_OAUTH_REDIRECT_URI") ||
  "https://nwsqyuucwzihruszocge.supabase.co/functions/v1/gmail-oauth";
const APP_RETURN_URL = Deno.env.get("GMAIL_OAUTH_APP_URL") ||
  "https://mypersonas.online/#/studio";
const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";

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
  login_email: string | null;
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
};

function cors(origin: string) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
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
    },
  });
}

function redirectToApp(params: Record<string, string>, returnOrigin = "") {
  const target = new URL(ALLOWED_ORIGINS.has(returnOrigin) ? `${returnOrigin}/#/studio` : APP_RETURN_URL);
  for (const [key, value] of Object.entries(params)) {
    if (value) target.searchParams.set(key, value);
  }
  return new Response(null, {
    status: 302,
    headers: { "Location": target.toString(), "Cache-Control": "no-store" },
  });
}

function base64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function randomUrlSafe(byteLength: number) {
  return base64Url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

async function sha256Bytes(value: string) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

async function sha256Hex(value: string) {
  return [...await sha256Bytes(value)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function caller(req: Request) {
  const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!jwt) return null;
  const { data, error } = await admin.auth.getUser(jwt);
  return error ? null : data.user;
}

async function ownedGmailLedger(ledgerId: string, owner: string): Promise<Ledger | null> {
  const { data, error } = await admin.from("account_ledger")
    .select("id,owner,provider,login_email")
    .eq("id", ledgerId)
    .eq("owner", owner)
    .eq("provider", "gmail")
    .maybeSingle();
  return error || !data ? null : data as Ledger;
}

async function markConnectionError(ledger: Ledger, errorCode: string) {
  const { data: existing } = await admin.from("account_connections")
    .select("connection_state")
    .eq("ledger_id", ledger.id)
    .maybeSingle();
  if (existing?.connection_state === "connected") return;
  const now = new Date().toISOString();
  if (existing) {
    await admin.from("account_connections").update({
      connection_state: "error",
      error_code: errorCode,
      last_checked_at: now,
      updated_at: now,
    }).eq("ledger_id", ledger.id);
  } else {
    await admin.from("account_connections").insert({
      ledger_id: ledger.id,
      owner: ledger.owner,
      provider: "gmail",
      provider_email: (ledger.login_email || "").trim().toLowerCase(),
      connection_state: "error",
      verification_method: "google_oauth",
      last_checked_at: now,
      error_code: errorCode,
      updated_at: now,
    });
  }
}

async function revokeGoogleToken(token: string) {
  if (!token) return false;
  try {
    const response = await fetch("https://oauth2.googleapis.com/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }),
    });
    if (response.ok) return true;
    const failure = await response.json().catch(() => ({})) as { error?: string };
    return failure.error === "invalid_token";
  } catch {
    return false;
  }
}

async function startAuthorization(req: Request, origin: string, ledgerIdInput = "") {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    return json({ error: "Gmail authorization is not configured yet" }, 503, origin);
  }
  const user = await caller(req);
  if (!user) return json({ error: "Invalid or expired session" }, 401, origin);

  const ledgerId = ledgerIdInput.trim();
  if (!/^[0-9a-f-]{36}$/i.test(ledgerId)) return json({ error: "Invalid account id" }, 400, origin);

  const ledger = await ownedGmailLedger(ledgerId, user.id);
  if (!ledger || !(ledger.login_email || "").trim()) {
    return json({ error: "Owned Gmail account with a login email is required" }, 404, origin);
  }

  const state = randomUrlSafe(32);
  const browserNonce = randomUrlSafe(32);
  const verifier = randomUrlSafe(64);
  const stateHash = await sha256Hex(state);
  const browserNonceHash = await sha256Hex(browserNonce);
  const challenge = base64Url(await sha256Bytes(verifier));
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

  await admin.from("gmail_oauth_transactions").delete().lt("expires_at", new Date().toISOString());
  const { error: stateError } = await admin.from("gmail_oauth_transactions").upsert({
    state_hash: stateHash,
    owner: user.id,
    ledger_id: ledger.id,
    code_verifier: verifier,
    browser_nonce_hash: browserNonceHash,
    return_origin: origin,
    expires_at: expiresAt,
  }, { onConflict: "owner,ledger_id" });
  if (stateError) return json({ error: "Could not start Gmail authorization" }, 500, origin);

  const authorization = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authorization.search = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: CALLBACK_URL,
    response_type: "code",
    scope: `openid email ${GMAIL_SCOPE}`,
    access_type: "offline",
    include_granted_scopes: "true",
    prompt: "select_account consent",
    login_hint: ledger.login_email!.trim(),
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();

  return json({ authorizationUrl: authorization.toString(), browserNonce }, 200, origin);
}

async function callback(req: Request) {
  const url = new URL(req.url);
  const rawState = url.searchParams.get("state") || "";
  const providerError = url.searchParams.get("error");
  const code = url.searchParams.get("code") || "";
  if (rawState.length < 32) return redirectToApp({ gmail: "error", reason: "invalid_state" });
  const { data: pending } = await admin.from("gmail_oauth_transactions")
    .select("return_origin")
    .eq("state_hash", await sha256Hex(rawState))
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();
  const returnOrigin = typeof pending?.return_origin === "string" && ALLOWED_ORIGINS.has(pending.return_origin)
    ? pending.return_origin
    : "";
  if (!returnOrigin) return redirectToApp({ gmail: "error", reason: "invalid_state" });
  if (!code && !providerError) return redirectToApp({ gmail: "error", reason: "missing_code" }, returnOrigin);
  return redirectToApp({
    gmail: "finish",
    state: rawState,
    code,
    provider_error: providerError === "access_denied" ? "access_denied" : providerError ? "oauth_error" : "",
  }, returnOrigin);
}

async function completeAuthorization(req: Request, origin: string, body: OAuthActionBody) {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    return json({ error: "Gmail authorization is not configured yet" }, 503, origin);
  }
  const user = await caller(req);
  if (!user) return json({ error: "Invalid or expired session" }, 401, origin);

  const rawState = (body.state || "").trim();
  const browserNonce = (body.browserNonce || "").trim();
  const code = (body.code || "").trim();
  const providerError = body.providerError === "access_denied" ? "access_denied" : body.providerError ? "oauth_error" : "";
  if (rawState.length < 32 || browserNonce.length < 32) {
    return json({ error: "The Gmail authorization expired. Please try again." }, 400, origin);
  }

  const { data: consumed, error: stateError } = await admin.rpc("consume_gmail_oauth_state", {
    p_state_hash: await sha256Hex(rawState),
    p_owner: user.id,
    p_browser_nonce_hash: await sha256Hex(browserNonce),
  });
  const transaction = (Array.isArray(consumed) ? consumed[0] : consumed) as OAuthTransaction | null;
  if (stateError || !transaction) {
    return json({ error: "The Gmail authorization expired or was opened in a different browser tab." }, 400, origin);
  }

  const ledger = await ownedGmailLedger(transaction.ledger_id, user.id);
  if (!ledger) return json({ error: "The Gmail account record was not found." }, 404, origin);

  if (providerError) {
    await markConnectionError(ledger, providerError === "access_denied" ? "google_access_denied" : "google_oauth_error");
    return json({ error: providerError === "access_denied" ? "Gmail authorization was cancelled." : "Google could not complete authorization." }, 400, origin);
  }
  if (!code) {
    await markConnectionError(ledger, "missing_authorization_code");
    return json({ error: "Google did not return an authorization code." }, 400, origin);
  }

  let tokenResponse: Response;
  try {
    tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: CALLBACK_URL,
        grant_type: "authorization_code",
        code_verifier: transaction.code_verifier,
      }),
    });
  } catch {
    await markConnectionError(ledger, "google_token_unreachable");
    return json({ error: "Google could not complete authorization. Please try again." }, 502, origin);
  }
  const token = await tokenResponse.json().catch(() => ({})) as Record<string, unknown>;
  if (!tokenResponse.ok || typeof token.access_token !== "string") {
    await markConnectionError(ledger, "google_token_exchange_failed");
    return json({ error: "Google could not complete authorization. Please try again." }, 400, origin);
  }
  const accessToken = token.access_token;

  const grantedScopes = typeof token.scope === "string" ? token.scope.split(/\s+/).filter(Boolean) : [];
  if (!grantedScopes.includes(GMAIL_SCOPE)) {
    await markConnectionError(ledger, "gmail_scope_missing");
    return json({ error: "Gmail read-only permission was not granted." }, 400, origin);
  }

  let userInfoResponse: Response;
  let profileResponse: Response;
  try {
    [userInfoResponse, profileResponse] = await Promise.all([
      fetch("https://openidconnect.googleapis.com/v1/userinfo", {
        headers: { "Authorization": `Bearer ${accessToken}` },
      }),
      fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
        headers: { "Authorization": `Bearer ${accessToken}` },
      }),
    ]);
  } catch {
    await markConnectionError(ledger, "google_profile_unreachable");
    return json({ error: "The selected Gmail account could not be verified." }, 502, origin);
  }
  const userInfo = await userInfoResponse.json().catch(() => ({})) as Record<string, unknown>;
  const profile = await profileResponse.json().catch(() => ({})) as Record<string, unknown>;
  const ledgerEmail = (ledger.login_email || "").trim().toLowerCase();
  const identityEmail = typeof userInfo.email === "string" ? userInfo.email.trim().toLowerCase() : "";
  const gmailEmail = typeof profile.emailAddress === "string" ? profile.emailAddress.trim().toLowerCase() : "";
  const subject = typeof userInfo.sub === "string" ? userInfo.sub : "";
  if (!userInfoResponse.ok || !profileResponse.ok || userInfo.email_verified !== true || !subject ||
      !identityEmail || identityEmail !== gmailEmail || gmailEmail !== ledgerEmail) {
    await markConnectionError(ledger, gmailEmail && gmailEmail !== ledgerEmail ? "gmail_email_mismatch" : "google_profile_invalid");
    return json({ error: gmailEmail && gmailEmail !== ledgerEmail
      ? "That Google account does not match the Gmail address recorded here."
      : "The selected Gmail account could not be verified." }, 400, origin);
  }

  const { data: existingSubject, error: subjectLookupError } = await admin.from("account_connections")
    .select("ledger_id")
    .eq("provider", "gmail")
    .eq("provider_subject", subject)
    .maybeSingle();
  if (subjectLookupError) {
    return json({ error: "Could not check the existing Gmail connection." }, 500, origin);
  }
  if (existingSubject && existingSubject.ledger_id !== ledger.id) {
    await markConnectionError(ledger, "gmail_already_connected");
    return json({ error: "That Gmail account is already connected elsewhere." }, 409, origin);
  }

  const { data: storedRefresh, error: storedRefreshError } = await admin.rpc("gmail_get_refresh_token", {
    p_ledger_id: ledger.id,
    p_owner: ledger.owner,
  });
  if (storedRefreshError) {
    await markConnectionError(ledger, "refresh_token_read_failed");
    return json({ error: "The stored Gmail authorization could not be read safely." }, 500, origin);
  }
  const hadStoredRefresh = typeof storedRefresh === "string" && storedRefresh.length > 0;
  const refreshToken = typeof token.refresh_token === "string" && token.refresh_token
    ? token.refresh_token
    : hadStoredRefresh ? storedRefresh : "";
  if (!refreshToken) {
    await markConnectionError(ledger, "google_refresh_token_missing");
    return json({ error: "Google did not provide ongoing access. Please try again." }, 400, origin);
  }

  if (typeof token.refresh_token === "string" && token.refresh_token) {
    const { error: storeError } = await admin.rpc("gmail_store_refresh_token", {
      p_ledger_id: ledger.id,
      p_owner: ledger.owner,
      p_provider_email: gmailEmail,
      p_refresh_token: token.refresh_token,
    });
    if (storeError) {
      await markConnectionError(ledger, "refresh_token_storage_failed");
      return json({ error: "Gmail authorization could not be stored securely." }, 500, origin);
    }
  }

  const now = new Date();
  const expiresIn = typeof token.expires_in === "number" ? token.expires_in : 3600;
  const { error: connectionError } = await admin.from("account_connections").upsert({
    ledger_id: ledger.id,
    owner: ledger.owner,
    provider: "gmail",
    provider_subject: subject,
    provider_email: gmailEmail,
    granted_scopes: grantedScopes,
    connection_state: "connected",
    verification_method: "google_oauth",
    verified_at: now.toISOString(),
    connected_at: now.toISOString(),
    last_checked_at: now.toISOString(),
    expires_at: new Date(now.getTime() + expiresIn * 1000).toISOString(),
    error_code: "",
    updated_at: now.toISOString(),
  }, { onConflict: "ledger_id" });
  if (connectionError) {
    if (connectionError.code === "23505") {
      await admin.rpc("gmail_delete_refresh_token", { p_ledger_id: ledger.id, p_owner: ledger.owner });
    }
    await markConnectionError(ledger, connectionError.code === "23505" ? "gmail_already_connected" : "connection_save_failed");
    return json({ error: connectionError.code === "23505"
      ? "That Gmail account is already connected elsewhere."
      : "Gmail authorized, but its connection record could not be saved." }, 409, origin);
  }

  return json({ connected: true, ledgerId: ledger.id }, 200, origin);
}

async function disconnect(req: Request, origin: string, ledgerId: string) {
  const user = await caller(req);
  if (!user) return json({ error: "Invalid or expired session" }, 401, origin);
  const ledger = await ownedGmailLedger(ledgerId, user.id);
  if (!ledger) return json({ error: "Owned Gmail account not found" }, 404, origin);

  const { data: credential, error: credentialLookupError } = await admin.from("gmail_credentials")
    .select("ledger_id")
    .eq("ledger_id", ledger.id)
    .eq("owner", ledger.owner)
    .maybeSingle();
  if (credentialLookupError) return json({ error: "Could not inspect the stored Gmail authorization" }, 500, origin);
  let revoked = true;
  if (credential) {
    const { data: refreshToken, error: tokenError } = await admin.rpc("gmail_get_refresh_token", {
      p_ledger_id: ledger.id,
      p_owner: ledger.owner,
    });
    if (tokenError || typeof refreshToken !== "string" || !refreshToken) {
      return json({ error: "The stored Gmail authorization could not be read safely" }, 500, origin);
    }
    revoked = await revokeGoogleToken(refreshToken);
  }
  if (!revoked) {
    const now = new Date().toISOString();
    await admin.from("account_connections").update({
      error_code: "google_revoke_failed",
      last_checked_at: now,
      updated_at: now,
    }).eq("ledger_id", ledger.id);
    return json({ error: "Google did not confirm revocation. Nothing was deleted; please try again." }, 502, origin);
  }
  const { error: deleteError } = await admin.rpc("gmail_delete_refresh_token", {
    p_ledger_id: ledger.id,
    p_owner: ledger.owner,
  });
  if (deleteError) return json({ error: "Could not remove the stored Gmail authorization" }, 500, origin);

  const now = new Date().toISOString();
  const { error: updateError } = await admin.from("account_connections").upsert({
    ledger_id: ledger.id,
    owner: ledger.owner,
    provider: "gmail",
    provider_subject: "",
    provider_email: (ledger.login_email || "").trim().toLowerCase(),
    granted_scopes: [],
    connection_state: "disconnected",
    verification_method: "google_oauth",
    connected_at: null,
    last_checked_at: now,
    expires_at: null,
    error_code: revoked ? "" : "google_revoke_unconfirmed",
    updated_at: now,
  }, { onConflict: "ledger_id" });
  if (updateError) return json({ error: "Gmail was revoked but local status could not be updated" }, 500, origin);
  return json({ disconnected: true, googleRevocationConfirmed: revoked }, 200, origin);
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
  if (!ALLOWED_ORIGINS.has(origin)) return json({ error: "Origin not allowed" }, 403);

  let actionBody: OAuthActionBody;
  try {
    actionBody = await req.clone().json();
  } catch {
    return json({ error: "Invalid request" }, 400, origin);
  }
  if (actionBody.action === "start") return startAuthorization(req, origin, actionBody.ledgerId);
  if (actionBody.action === "complete") return completeAuthorization(req, origin, actionBody);
  if (actionBody.action === "disconnect" && actionBody.ledgerId) {
    return disconnect(req, origin, actionBody.ledgerId);
  }
  return json({ error: "Unknown action" }, 400, origin);
});
