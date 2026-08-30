// YouTube OAuth 2.0 Authorization Code + PKCE connector.
//
// POST (owner JWT + AAL2):
//   {action:"capabilities",ledgerId?}
//   {action:"start",ledgerId} -> {authorizationUrl,browserNonce}
//   {action:"complete",state,code,browserNonce,providerError?}
//   {action:"refresh",ledgerId}
//   {action:"disconnect",ledgerId}
// GET is only Google's callback trampoline; it never receives or trusts a
// browser session. The initiating tab must finish with its one-time nonce.
//
// Required secrets: YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET.
// Deploy with --no-verify-jwt because the provider callback has no Supabase JWT.
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { requireAal2 } from "../_shared/aal2.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const CLIENT_ID = Deno.env.get("YOUTUBE_CLIENT_ID") || "";
const CLIENT_SECRET = Deno.env.get("YOUTUBE_CLIENT_SECRET") || "";
const CALLBACK_URL = Deno.env.get("YOUTUBE_OAUTH_REDIRECT_URI") ||
  "https://nwsqyuucwzihruszocge.supabase.co/functions/v1/youtube-oauth";
const APP_ORIGIN = Deno.env.get("YOUTUBE_OAUTH_APP_ORIGIN") || "https://mypersonas.online";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";
const CHANNELS_URL = "https://www.googleapis.com/youtube/v3/channels?part=id,snippet&mine=true&maxResults=1";
const UPLOAD_SCOPE = "https://www.googleapis.com/auth/youtube.upload";
const REQUIRED_SCOPES = ["openid", "email", UPLOAD_SCOPE] as const;
const SAFE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_STATE = /^[A-Za-z0-9_-]{32,256}$/;
const SAFE_CHANNEL = /^UC[A-Za-z0-9_-]{22}$/;
const ALLOWED_ORIGINS = new Set([
  APP_ORIGIN,
  "https://mypersonas.online",
  "https://aliaspaces.com",
  "https://www.aliaspaces.com",
  "https://app.aliaspaces.com",
  "http://localhost:8000",
  "http://127.0.0.1:8000",
]);

const service = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

type Ledger = {
  id: string;
  owner: string;
  provider: string;
  username: string;
  login_email: string;
  url: string;
  suspended: boolean;
};
type TokenBundle = {
  accessToken: string;
  refreshToken: string;
  scopes: string[];
  expiresAt: string;
};
type Identity = {
  googleSubject: string;
  email: string;
  channelId: string;
  channelTitle: string;
};

function cors(origin: string): HeadersInit {
  const allowed = ALLOWED_ORIGINS.has(origin) ? origin : APP_ORIGIN;
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Cache-Control": "no-store",
    "Vary": "Origin",
  };
}
function json(origin: string, status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors(origin), "Content-Type": "application/json", "X-Content-Type-Options": "nosniff" },
  });
}
function redirectToApp(origin: string, params: Record<string, string>) {
  const base = ALLOWED_ORIGINS.has(origin) ? origin : APP_ORIGIN;
  const target = new URL(base + "/");
  for (const [key, value] of Object.entries(params)) if (value) target.searchParams.set(key, value);
  target.hash = "/studio";
  return new Response(null, {
    status: 302,
    headers: {
      Location: target.toString(), "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff",
    },
  });
}
function base64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function randomUrlSafe(length: number) {
  return base64Url(crypto.getRandomValues(new Uint8Array(length)));
}
async function sha256Bytes(value: string) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}
async function sha256Hex(value: string) {
  return [...await sha256Bytes(value)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function normalizeScopes(value: unknown) {
  const values = Array.isArray(value) ? value : String(value || "").split(/\s+/);
  return [...new Set(values.map((v) => String(v).trim()).filter(Boolean))].sort();
}
function safeExpiry(value: unknown) {
  const seconds = Number(value);
  const bounded = Number.isFinite(seconds) ? Math.min(86_400, Math.max(60, Math.floor(seconds))) : 3_600;
  return new Date(Date.now() + bounded * 1000).toISOString();
}
function channelIdFromLedger(ledger: Ledger) {
  const combined = `${ledger.username || ""} ${ledger.url || ""}`;
  return combined.match(/(?:^|[\s/])((?:UC)[A-Za-z0-9_-]{22})(?:$|[\s/?#])/i)?.[1] || "";
}
function configured() {
  return Boolean(CLIENT_ID && CLIENT_SECRET);
}
async function ownedLedger(id: string, owner: string): Promise<Ledger | null> {
  const result = await service.from("account_ledger")
    .select("id,owner,provider,username,login_email,url,suspended")
    .eq("id", id).eq("owner", owner).eq("provider", "youtube").maybeSingle();
  return result.error || !result.data ? null : result.data as Ledger;
}
async function markDisconnected(ledger: Ledger, errorCode = "") {
  const now = new Date().toISOString();
  await service.from("account_connections").upsert({
    ledger_id: ledger.id, owner: ledger.owner, provider: "youtube", provider_subject: "",
    provider_email: "", granted_scopes: [], connection_state: errorCode ? "error" : "disconnected",
    verification_method: "youtube_oauth2_pkce", last_checked_at: now, expires_at: null,
    error_code: errorCode, updated_at: now,
  }, { onConflict: "ledger_id" });
}

async function exchangeCode(code: string, verifier: string): Promise<TokenBundle | null> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      code, client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
      redirect_uri: CALLBACK_URL, grant_type: "authorization_code", code_verifier: verifier,
    }),
    redirect: "error", signal: AbortSignal.timeout(20_000),
  });
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok || typeof payload.access_token !== "string" ||
    typeof payload.refresh_token !== "string" || !payload.refresh_token ||
    String(payload.token_type || "").toLowerCase() !== "bearer") return null;
  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
    scopes: normalizeScopes(payload.scope),
    expiresAt: safeExpiry(payload.expires_in),
  };
}
async function refreshToken(refreshToken: string, priorScopes: string[]): Promise<TokenBundle | null> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
      refresh_token: refreshToken, grant_type: "refresh_token",
    }),
    redirect: "error", signal: AbortSignal.timeout(20_000),
  });
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok || typeof payload.access_token !== "string" ||
    String(payload.token_type || "").toLowerCase() !== "bearer") return null;
  const scopes = normalizeScopes(payload.scope);
  return {
    accessToken: payload.access_token, refreshToken,
    scopes: scopes.length ? scopes : priorScopes, expiresAt: safeExpiry(payload.expires_in),
  };
}
async function providerIdentity(accessToken: string): Promise<Identity | null> {
  const [userResponse, channelResponse] = await Promise.all([
    fetch(USERINFO_URL, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
      redirect: "error", signal: AbortSignal.timeout(20_000),
    }),
    fetch(CHANNELS_URL, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
      redirect: "error", signal: AbortSignal.timeout(20_000),
    }),
  ]);
  const user = await userResponse.json().catch(() => ({})) as Record<string, unknown>;
  const channels = await channelResponse.json().catch(() => ({})) as {
    items?: Array<{ id?: unknown; snippet?: { title?: unknown } }>;
  };
  const item = Array.isArray(channels.items) && channels.items.length === 1 ? channels.items[0] : null;
  const subject = String(user.sub || "").trim();
  const email = String(user.email || "").trim().toLowerCase();
  const channelId = String(item?.id || "").trim();
  const channelTitle = String(item?.snippet?.title || "").trim();
  if (!userResponse.ok || !channelResponse.ok || user.email_verified !== true ||
    !/^[0-9]{1,64}$/.test(subject) || !email.includes("@") || !SAFE_CHANNEL.test(channelId)) return null;
  return { googleSubject: subject, email, channelId, channelTitle };
}
async function revoke(token: string) {
  if (!token) return false;
  try {
    const response = await fetch(REVOKE_URL, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }), redirect: "error", signal: AbortSignal.timeout(20_000),
    });
    return response.ok;
  } catch { return false; }
}
async function rejectAndCleanGrant(
  origin: string,
  ledger: Ledger,
  token: TokenBundle,
  message: string,
  errorCode: string,
) {
  const revoked = await revoke(token.refreshToken || token.accessToken);
  if (revoked) {
    const removed = await service.rpc("youtube_delete_token_bundle", {
      p_ledger_id: ledger.id,
      p_owner: ledger.owner,
    });
    if (removed.error) {
      await markDisconnected(ledger, "youtube_revoked_local_cleanup_failed");
      return json(origin, 503, {
        error: `${message} Google confirmed revocation, but local credential cleanup needs attention.`,
        rejectedGrantRevoked: true,
        localCleanupRequired: true,
      });
    }
    await markDisconnected(ledger);
    return json(origin, 409, { error: message, rejectedGrantRevoked: true });
  }
  await markDisconnected(ledger, errorCode);
  return json(origin, 502, {
    error: `${message} Google did not confirm revocation; revoke MyPersonas manually before reconnecting.`,
    manualRevocationRequired: true,
    manualRevocationUrl: "https://myaccount.google.com/connections",
  });
}
async function storedCredential(ledger: Ledger) {
  const result = await service.rpc("youtube_get_token_bundle", {
    p_ledger_id: ledger.id, p_owner: ledger.owner,
  });
  const row = (Array.isArray(result.data) ? result.data[0] : result.data) as Record<string, unknown> | null;
  const bundle = row?.token_bundle as Record<string, unknown> | null;
  if (result.error || !row || !bundle) return null;
  return {
    googleSubject: String(row.google_subject || ""), providerEmail: String(row.provider_email || ""),
    channelId: String(row.channel_id || ""), channelTitle: String(row.channel_title || ""),
    accessToken: String(bundle.access_token || ""), refreshToken: String(bundle.refresh_token || ""),
    scopes: normalizeScopes(bundle.scope), expiresAt: String(bundle.expires_at || ""),
  };
}
async function store(ledger: Ledger, token: TokenBundle, identity: Identity) {
  return await service.rpc("youtube_store_token_bundle", {
    p_ledger_id: ledger.id, p_owner: ledger.owner,
    p_google_subject: identity.googleSubject, p_provider_email: identity.email,
    p_channel_id: identity.channelId, p_channel_title: identity.channelTitle,
    p_access_token: token.accessToken, p_refresh_token: token.refreshToken,
    p_token_type: "bearer", p_scope: token.scopes.join(" "), p_expires_at: token.expiresAt,
  });
}
async function withLease(
  ledger: Ledger, kind: "connect" | "refresh" | "disconnect",
  origin: string, operation: () => Promise<Response>,
) {
  const leaseId = crypto.randomUUID();
  const claim = await service.rpc("claim_youtube_token_operation", {
    p_ledger_id: ledger.id, p_owner: ledger.owner, p_lease_id: leaseId,
    p_operation_kind: kind, p_ttl_seconds: 120,
  });
  if (claim.error) return json(origin, 503, { error: "Could not safely start the YouTube connection operation" });
  if (claim.data !== true) return json(origin, 409, { error: "Another YouTube connection operation is in progress" });
  try { return await operation(); }
  finally {
    await service.rpc("release_youtube_token_operation", {
      p_ledger_id: ledger.id, p_owner: ledger.owner, p_lease_id: leaseId,
    });
  }
}

serve(async (req: Request) => {
  const origin = req.headers.get("Origin") || "";
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origin) });

  if (req.method === "GET") {
    const requestUrl = new URL(req.url);
    const state = requestUrl.searchParams.get("state") || "";
    if (!SAFE_STATE.test(state)) return redirectToApp(APP_ORIGIN, { youtube: "error", reason: "invalid_oauth_state" });
    const hash = await sha256Hex(state);
    const result = await service.from("youtube_oauth_transactions")
      .select("return_origin,expires_at").eq("state_hash", hash).maybeSingle();
    const returnOrigin = String(result.data?.return_origin || APP_ORIGIN);
    if (result.error || !result.data || Date.parse(result.data.expires_at) <= Date.now()) {
      return redirectToApp(returnOrigin, { youtube: "error", reason: "expired_oauth_state" });
    }
    return redirectToApp(returnOrigin, {
      youtube: "finish", state,
      code: requestUrl.searchParams.get("code") || "",
      provider_error: requestUrl.searchParams.get("error") || "",
    });
  }
  if (req.method !== "POST") return json(origin, 405, { error: "POST only" });
  if (!ALLOWED_ORIGINS.has(origin)) return json(origin, 403, { error: "Origin not allowed" });

  const authClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: req.headers.get("Authorization") || "" } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const guard = await requireAal2(req, authClient);
  if (!guard.ok) return json(origin, guard.status, { error: guard.error, code: guard.code });
  const owner = guard.user.id;
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json(origin, 400, { error: "Invalid request body" }); }
  const action = String(body.action || "");
  const ledgerId = String(body.ledgerId || "");

  if (action === "capabilities") {
    if (!ledgerId) return json(origin, 200, {
      credentialsConfigured: configured(), requiredScopes: REQUIRED_SCOPES,
      postingSupported: true, mediaKinds: ["video/mp4", "video/webm"],
      defaultPrivacy: "private", communityPostsSupported: false,
    });
    if (!SAFE_UUID.test(ledgerId)) return json(origin, 400, { error: "Invalid ledger id" });
    const ledger = await ownedLedger(ledgerId, owner);
    if (!ledger) return json(origin, 404, { error: "Owned YouTube ledger not found" });
    const connection = await service.from("account_connections")
      .select("connection_state,provider_subject,provider_email,granted_scopes,expires_at,error_code")
      .eq("ledger_id", ledger.id).eq("owner", owner).maybeSingle();
    const scopes = normalizeScopes(connection.data?.granted_scopes);
    return json(origin, 200, {
      credentialsConfigured: configured(), requiredScopes: REQUIRED_SCOPES,
      connected: connection.data?.connection_state === "connected",
      channelId: connection.data?.provider_subject || "", providerEmail: connection.data?.provider_email || "",
      grantedScopes: scopes, uploadAuthorized: scopes.includes(UPLOAD_SCOPE),
      expiresAt: connection.data?.expires_at || null, errorCode: connection.data?.error_code || "",
      postingSupported: true, defaultPrivacy: "private", communityPostsSupported: false,
    });
  }
  if (!configured()) return json(origin, 503, { error: "YouTube OAuth credentials are not configured" });

  if (action === "complete") {
    const state = String(body.state || ""), code = String(body.code || "");
    const browserNonce = String(body.browserNonce || ""), providerError = String(body.providerError || "");
    if (!SAFE_STATE.test(state) || !SAFE_STATE.test(browserNonce)) return json(origin, 400, { error: "Invalid OAuth completion" });
    const stateHash = await sha256Hex(state), nonceHash = await sha256Hex(browserNonce);
    const consumed = await service.from("youtube_oauth_transactions").delete()
      .eq("state_hash", stateHash).eq("owner", owner).eq("browser_nonce_hash", nonceHash)
      .gt("expires_at", new Date().toISOString())
      .select("owner,ledger_id,code_verifier,return_origin").maybeSingle();
    if (consumed.error || !consumed.data) return json(origin, 409, { error: "OAuth state expired, was already used, or belongs to another browser tab" });
    const transaction = consumed.data;
    const ledger = await ownedLedger(transaction.ledger_id, owner);
    if (!ledger || ledger.suspended) return json(origin, 409, { error: "YouTube ledger is unavailable" });
    if (providerError) return json(origin, 409, { error: providerError === "access_denied" ? "YouTube authorization was cancelled" : "YouTube authorization failed" });
    if (!code || code.length > 4096) return json(origin, 400, { error: "Google did not return an authorization code" });
    return await withLease(ledger, "connect", origin, async () => {
      let token: TokenBundle | null = null;
      try { token = await exchangeCode(code, transaction.code_verifier); } catch { /* fail closed */ }
      if (!token || !REQUIRED_SCOPES.every((scope) => token!.scopes.includes(scope))) {
        if (token) return await rejectAndCleanGrant(
          origin, ledger, token,
          "Google did not grant the exact offline YouTube upload authorization.",
          "youtube_rejected_grant_revocation_unconfirmed",
        );
        return json(origin, 409, { error: "Google did not return a complete offline YouTube upload authorization" });
      }
      let identity: Identity | null = null;
      try { identity = await providerIdentity(token.accessToken); } catch { /* fail closed */ }
      const recordedChannel = channelIdFromLedger(ledger);
      if (!identity || (recordedChannel && recordedChannel !== identity.channelId) ||
        (ledger.login_email && ledger.login_email.trim().toLowerCase() !== identity.email)) {
        return await rejectAndCleanGrant(
          origin, ledger, token,
          "The selected Google account or YouTube channel does not match this ledger entry.",
          "youtube_identity_mismatch_revocation_unconfirmed",
        );
      }
      const stored = await store(ledger, token, identity);
      if (stored.error) {
        return await rejectAndCleanGrant(
          origin, ledger, token,
          "Authorization succeeded but could not be safely stored.",
          "youtube_storage_failure_revocation_unconfirmed",
        );
      }
      return json(origin, 200, {
        connected: true, channelId: identity.channelId, channelTitle: identity.channelTitle,
        providerEmail: identity.email, grantedScopes: token.scopes, uploadAuthorized: true,
      });
    });
  }

  if (!SAFE_UUID.test(ledgerId)) return json(origin, 400, { error: "A valid ledger id is required" });
  const ledger = await ownedLedger(ledgerId, owner);
  if (!ledger) return json(origin, 404, { error: "Owned YouTube ledger not found" });

  if (action === "start") {
    if (ledger.suspended) return json(origin, 409, { error: "Resume this ledger entry before connecting it" });
    await service.from("youtube_oauth_transactions").delete().or(
      `expires_at.lte.${new Date().toISOString()},owner.eq.${owner}`,
    );
    const state = randomUrlSafe(32), browserNonce = randomUrlSafe(32), verifier = randomUrlSafe(64);
    const challenge = base64Url(await sha256Bytes(verifier));
    const inserted = await service.from("youtube_oauth_transactions").insert({
      state_hash: await sha256Hex(state), owner, ledger_id: ledger.id, code_verifier: verifier,
      browser_nonce_hash: await sha256Hex(browserNonce), return_origin: origin,
      expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
    });
    if (inserted.error) return json(origin, 503, { error: "Could not start YouTube authorization" });
    const url = new URL(AUTH_URL);
    url.search = new URLSearchParams({
      client_id: CLIENT_ID, redirect_uri: CALLBACK_URL, response_type: "code",
      scope: REQUIRED_SCOPES.join(" "), access_type: "offline", prompt: "consent",
      include_granted_scopes: "false", state, code_challenge: challenge,
      code_challenge_method: "S256", login_hint: ledger.login_email || "",
    }).toString();
    return json(origin, 200, { authorizationUrl: url.toString(), browserNonce, requestedScopes: REQUIRED_SCOPES });
  }

  if (action === "refresh") {
    return await withLease(ledger, "refresh", origin, async () => {
      const prior = await storedCredential(ledger);
      if (!prior?.refreshToken) return json(origin, 409, { error: "Reconnect this YouTube account" });
      let token: TokenBundle | null = null;
      try { token = await refreshToken(prior.refreshToken, prior.scopes); } catch { /* fail closed */ }
      if (!token || !REQUIRED_SCOPES.every((scope) => token!.scopes.includes(scope))) {
        await markDisconnected(ledger, "youtube_refresh_failed");
        return json(origin, 409, { error: "YouTube access could not refresh; reconnect the account" });
      }
      let identity: Identity | null = null;
      try { identity = await providerIdentity(token.accessToken); } catch { /* fail closed */ }
      if (!identity || identity.googleSubject !== prior.googleSubject ||
        identity.channelId !== prior.channelId || identity.email !== prior.providerEmail) {
        return json(origin, 409, { error: "The refreshed YouTube identity no longer matches the bound channel" });
      }
      const stored = await store(ledger, token, identity);
      if (stored.error) return json(origin, 503, { error: "Refreshed access could not be safely stored" });
      return json(origin, 200, { connected: true, channelId: identity.channelId, expiresAt: token.expiresAt });
    });
  }

  if (action === "disconnect") {
    return await withLease(ledger, "disconnect", origin, async () => {
      const prior = await storedCredential(ledger);
      if (!prior) { await markDisconnected(ledger); return json(origin, 200, { disconnected: true }); }
      const revoked = await revoke(prior.refreshToken || prior.accessToken);
      if (!revoked) return json(origin, 502, {
        error: "Google did not confirm revocation. Revoke MyPersonas in Google Account permissions, then try disconnect again.",
        manualRevocationUrl: "https://myaccount.google.com/connections",
      });
      const removed = await service.rpc("youtube_delete_token_bundle", {
        p_ledger_id: ledger.id, p_owner: owner,
      });
      if (removed.error) return json(origin, 503, { error: "Google revoked access, but local credential cleanup needs attention" });
      await service.from("youtube_upload_sessions").delete().eq("owner", owner).eq("ledger_id", ledger.id);
      await markDisconnected(ledger);
      return json(origin, 200, { disconnected: true });
    });
  }

  return json(origin, 400, { error: "Unsupported YouTube OAuth action" });
});
