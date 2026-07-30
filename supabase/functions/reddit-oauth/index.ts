// reddit-oauth — Reddit OAuth 2.0 (identity + submit) for Reddit ledger records.
//
// Frontend contract (POST, signed-in user's Supabase bearer token required):
//   { action:"capabilities" }            -> { configured, authenticationEnabled, postingEnabled, callbackUrl }
//   { action:"start", ledgerId }         -> { authorizationUrl }
//   { action:"disconnect", ledgerId }    -> { disconnected:true }
//
// Reddit redirects to GET /reddit-oauth?state&code. The exchange completes
// entirely server-side (the authorization code never reaches a page) and the
// user is redirected to the app with ?reddit=connected or ?reddit=error&reason=…
//
// Safety model: tokens only in Vault via service-role RPCs (migration 021);
// hashed single-use states bound to owner+ledger with a 10-minute expiry;
// identity check binds the exact recorded ledger username before storing.
//
// Deploy WITHOUT gateway JWT verification (the GET callback has no Supabase
// Authorization header); every POST action validates the user JWT manually:
//   supabase functions deploy reddit-oauth --no-verify-jwt
// Required secrets: REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const REDDIT_CLIENT_ID = Deno.env.get("REDDIT_CLIENT_ID") || "";
const REDDIT_CLIENT_SECRET = Deno.env.get("REDDIT_CLIENT_SECRET") || "";
const CALLBACK_URL = Deno.env.get("REDDIT_OAUTH_REDIRECT_URI") ||
  "https://nwsqyuucwzihruszocge.supabase.co/functions/v1/reddit-oauth";
const APP_ORIGIN = Deno.env.get("REDDIT_OAUTH_APP_ORIGIN") || "https://mypersonas.online";
const USER_AGENT = "web:online.mypersonas:v0.5 (MyPersonas account connector)";
const SCOPES = ["identity", "submit", "read"];

const service = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });

function configured(): boolean { return Boolean(REDDIT_CLIENT_ID && REDDIT_CLIENT_SECRET); }

function corsHeaders(origin: string): HeadersInit {
  const allowed = new Set([APP_ORIGIN, "http://localhost:8000", "http://127.0.0.1:8000"]);
  return {
    "Access-Control-Allow-Origin": allowed.has(origin) ? origin : APP_ORIGIN,
    "Access-Control-Allow-Headers": "authorization, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}
function json(origin: string, status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders(origin), "Content-Type": "application/json" } });
}
function redirectToApp(params: Record<string, string>): Response {
  const search = new URLSearchParams(params).toString();
  return new Response(null, { status: 302, headers: { Location: `${APP_ORIGIN}/?${search}#/studio` } });
}
async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}
function basicAuth(): string { return "Basic " + btoa(`${REDDIT_CLIENT_ID}:${REDDIT_CLIENT_SECRET}`); }
function normalizeUsername(v: string): string {
  return (v || "").normalize("NFKC").trim().toLowerCase().replace(/^\/?u\//, "").replace(/^@/, "");
}

async function requireUser(req: Request): Promise<string> {
  const authorization = req.headers.get("Authorization") || "";
  if (!authorization.startsWith("Bearer ")) return "";
  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false },
  });
  const { data } = await userClient.auth.getUser();
  return data?.user?.id || "";
}

async function start(origin: string, uid: string, ledgerId: string): Promise<Response> {
  if (!configured()) return json(origin, 409, { error: "The Reddit connector's client credentials are not installed yet." });
  if (!/^[0-9a-f-]{36}$/i.test(ledgerId)) return json(origin, 400, { error: "A ledger id is required" });
  const { data: ledger } = await service.from("account_ledger")
    .select("id,owner,provider,username").eq("id", ledgerId).eq("owner", uid).eq("provider", "reddit").maybeSingle();
  if (!ledger) return json(origin, 404, { error: "Owned Reddit ledger record not found" });
  if (!normalizeUsername(ledger.username || "")) {
    return json(origin, 409, { error: "Add the Reddit username in Edit details before connecting" });
  }
  const state = randomToken();
  const stateHash = await sha256Hex(state);
  await service.from("reddit_oauth_states").delete().eq("ledger_id", ledger.id).eq("owner", uid);
  const { error: stateError } = await service.from("reddit_oauth_states").insert({
    state_hash: stateHash, owner: uid, ledger_id: ledger.id,
    expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
  });
  if (stateError) return json(origin, 500, { error: "Authorization could not be prepared. Run migration 021 first." });
  const url = new URL("https://www.reddit.com/api/v1/authorize");
  url.searchParams.set("client_id", REDDIT_CLIENT_ID);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", state);
  url.searchParams.set("redirect_uri", CALLBACK_URL);
  url.searchParams.set("duration", "permanent");
  url.searchParams.set("scope", SCOPES.join(" "));
  return json(origin, 200, { authorizationUrl: url.toString() });
}

async function callback(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const state = url.searchParams.get("state") || "";
  const code = url.searchParams.get("code") || "";
  const providerError = url.searchParams.get("error") || "";
  if (!state) return redirectToApp({ reddit: "error", reason: "invalid_state" });
  const stateHash = await sha256Hex(state);
  const { data: stateRow } = await service.from("reddit_oauth_states")
    .select("state_hash,owner,ledger_id,expires_at").eq("state_hash", stateHash).maybeSingle();
  await service.from("reddit_oauth_states").delete().eq("state_hash", stateHash);
  if (!stateRow || new Date(stateRow.expires_at).getTime() < Date.now()) {
    return redirectToApp({ reddit: "error", reason: "invalid_state" });
  }
  if (providerError === "access_denied") return redirectToApp({ reddit: "error", reason: "cancelled" });
  if (providerError || !code) return redirectToApp({ reddit: "error", reason: "missing_code" });

  const tokenResponse = await fetch("https://www.reddit.com/api/v1/access_token", {
    method: "POST",
    headers: { "Authorization": basicAuth(), "Content-Type": "application/x-www-form-urlencoded", "User-Agent": USER_AGENT },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: CALLBACK_URL }),
  });
  const token = await tokenResponse.json().catch(() => ({}));
  if (!tokenResponse.ok || !token.access_token) return redirectToApp({ reddit: "error", reason: "token_exchange_failed" });
  const grantedScopes = String(token.scope || "").split(/[ ,]+/).filter(Boolean);
  if (!grantedScopes.includes("identity") || !grantedScopes.includes("submit")) {
    return redirectToApp({ reddit: "error", reason: "scope_missing" });
  }
  if (!token.refresh_token) return redirectToApp({ reddit: "error", reason: "refresh_token_missing" });

  const meResponse = await fetch("https://oauth.reddit.com/api/v1/me", {
    headers: { "Authorization": `Bearer ${token.access_token}`, "User-Agent": USER_AGENT },
  });
  const me = await meResponse.json().catch(() => ({}));
  const redditUsername = normalizeUsername(String(me?.name || ""));
  if (!meResponse.ok || !redditUsername) return redirectToApp({ reddit: "error", reason: "profile_check_failed" });

  const { data: ledger } = await service.from("account_ledger")
    .select("id,owner,username").eq("id", stateRow.ledger_id).eq("owner", stateRow.owner).eq("provider", "reddit").maybeSingle();
  if (!ledger) return redirectToApp({ reddit: "error", reason: "connection_save_failed" });
  if (normalizeUsername(ledger.username || "") !== redditUsername) {
    return redirectToApp({ reddit: "error", reason: "username_mismatch" });
  }

  const expiresAt = new Date(Date.now() + Math.max(60, Number(token.expires_in || 3600)) * 1000).toISOString();
  const { error: storeError } = await service.rpc("reddit_store_tokens_service", {
    p_ledger_id: ledger.id, p_owner: ledger.owner, p_username: redditUsername,
    p_access_token: String(token.access_token), p_refresh_token: String(token.refresh_token),
    p_scopes: grantedScopes, p_expires_at: expiresAt,
  });
  if (storeError) return redirectToApp({ reddit: "error", reason: "secure_storage_failed" });
  return redirectToApp({ reddit: "connected" });
}

async function disconnect(origin: string, uid: string, ledgerId: string): Promise<Response> {
  if (!/^[0-9a-f-]{36}$/i.test(ledgerId)) return json(origin, 400, { error: "A ledger id is required" });
  const { data: ledger } = await service.from("account_ledger")
    .select("id").eq("id", ledgerId).eq("owner", uid).eq("provider", "reddit").maybeSingle();
  if (!ledger) return json(origin, 404, { error: "Owned Reddit ledger record not found" });
  if (configured()) {
    const { data: tokens } = await service.rpc("reddit_get_tokens_service", { p_ledger_id: ledgerId });
    const refresh = Array.isArray(tokens) ? tokens[0]?.refresh_token : tokens?.refresh_token;
    if (refresh) {
      await fetch("https://www.reddit.com/api/v1/revoke_token", {
        method: "POST",
        headers: { "Authorization": basicAuth(), "Content-Type": "application/x-www-form-urlencoded", "User-Agent": USER_AGENT },
        body: new URLSearchParams({ token: String(refresh), token_type_hint: "refresh_token" }),
      }).catch(() => null);
    }
  }
  const { error } = await service.rpc("reddit_clear_tokens_service", { p_ledger_id: ledgerId });
  if (error) return json(origin, 500, { error: "Local cleanup failed. Try again." });
  return json(origin, 200, { disconnected: true });
}

serve(async (req: Request): Promise<Response> => {
  const origin = req.headers.get("Origin") || "";
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(origin) });
  if (req.method === "GET") return callback(req);
  if (req.method !== "POST") return json(origin, 405, { error: "POST only" });
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch (_e) { return json(origin, 400, { error: "Invalid request body" }); }
  const action = String(body.action || "");
  if (action === "capabilities") {
    return json(origin, 200, {
      configured: configured(), authenticationEnabled: configured(),
      postingEnabled: configured(), callbackUrl: CALLBACK_URL,
    });
  }
  const uid = await requireUser(req);
  if (!uid) return json(origin, 401, { error: "Sign in again before connecting Reddit" });
  const ledgerId = String(body.ledgerId || "");
  if (action === "start") return start(origin, uid, ledgerId);
  if (action === "disconnect") return disconnect(origin, uid, ledgerId);
  return json(origin, 400, { error: "Unknown action" });
});
