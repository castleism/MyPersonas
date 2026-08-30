// Patreon API v2 OAuth, exact campaign binding, and read-only reporting.
// Patreon does not expose ordinary post creation/scheduling through this API.
// No endpoint in this function writes, edits, schedules, or deletes posts.
//
// POST, AAL2:
//   {action:"capabilities",ledgerId?}
//   {action:"start",ledgerId}
//   {action:"complete",state,code,browserNonce,providerError?}
//   {action:"select-campaign",ledgerId,campaignId}
//   {action:"refresh",ledgerId}
//   {action:"report",ledgerId}
//   {action:"disconnect",ledgerId,manualRevocationAcknowledged:true}
// GET is only the provider callback trampoline.
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { requireAal2 } from "../_shared/aal2.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const CLIENT_ID = Deno.env.get("PATREON_CLIENT_ID") || "";
const CLIENT_SECRET = Deno.env.get("PATREON_CLIENT_SECRET") || "";
const CALLBACK_URL = Deno.env.get("PATREON_OAUTH_REDIRECT_URI") ||
  "https://nwsqyuucwzihruszocge.supabase.co/functions/v1/patreon-oauth";
const APP_ORIGIN = (Deno.env.get("PATREON_OAUTH_APP_ORIGIN") ||
  "https://mypersonas.online").replace(/\/$/, "");
const AUTHORIZE_URL = "https://www.patreon.com/oauth2/authorize";
const TOKEN_URL = "https://www.patreon.com/api/oauth2/token";
const API_ROOT = "https://www.patreon.com/api/oauth2/v2";
const REVOCATION_SETTINGS_URL = "https://www.patreon.com/settings/apps";
const CLIENTS_URL =
  "https://www.patreon.com/portal/registration/register-clients";
const USER_AGENT = "MyPersonas/1.0 (+https://mypersonas.online)";
const REQUIRED_SCOPES = ["identity", "campaigns", "campaigns.posts"];
const SAFE_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_STATE = /^[A-Za-z0-9_-]{32,256}$/;
const ALLOWED_ORIGINS = new Set([
  APP_ORIGIN,
  "https://www.mypersonas.online",
  "https://aliaspaces.com",
  "https://www.aliaspaces.com",
  "http://localhost:8000",
  "http://127.0.0.1:8000",
]);
type Json = Record<string, unknown>;
type Ledger = {
  id: string;
  owner: string;
  username: string;
  url: string;
  suspended: boolean;
};
type Campaign = { id: string; name: string; vanity: string; url: string };
type Token = {
  accessToken: string;
  refreshToken: string;
  scopes: string[];
  expiresAt: string;
};
type Stored = Token & {
  userId: string;
  campaignId: string;
  campaignName: string;
  campaignUrl: string;
};

const service = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function cors(origin: string): HeadersInit {
  return {
    ...(ALLOWED_ORIGINS.has(origin)
      ? { "Access-Control-Allow-Origin": origin }
      : {}),
    "Access-Control-Allow-Headers":
      "authorization, content-type, apikey, x-client-info",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Cache-Control": "no-store",
    "Vary": "Origin",
  };
}
function json(origin: string, status: number, body: Json) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...cors(origin),
      "Content-Type": "application/json",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
function redirectToApp(origin: string, params: Record<string, string>) {
  const base = ALLOWED_ORIGINS.has(origin) ? origin : APP_ORIGIN;
  const target = new URL(base + "/");
  for (const [key, value] of Object.entries(params)) {
    if (value) target.searchParams.set(key, value);
  }
  target.hash = "/studio";
  return new Response(null, {
    status: 302,
    headers: {
      Location: target.toString(),
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
function randomSafe(size = 32) {
  const bytes = crypto.getRandomValues(new Uint8Array(size));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(
    /=+$/g,
    "",
  );
}
async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}
function scopes(value: unknown): string[] {
  const items = Array.isArray(value) ? value : String(value || "").split(/\s+/);
  return [...new Set(items.map(String).map((x) => x.trim()).filter(Boolean))]
    .sort();
}
function expiry(value: unknown) {
  const seconds = Number(value);
  const bounded = Number.isFinite(seconds)
    ? Math.max(60, Math.min(90 * 24 * 60 * 60, Math.floor(seconds)))
    : 30 * 24 * 60 * 60;
  return new Date(Date.now() + bounded * 1000).toISOString();
}
function configured() {
  return Boolean(CLIENT_ID && CLIENT_SECRET);
}
function hasExactReadScopes(value: string[]) {
  return REQUIRED_SCOPES.every((scope) => value.includes(scope)) &&
    value.every((scope) => REQUIRED_SCOPES.includes(scope));
}
function campaignSlug(urlValue: string) {
  try {
    const url = new URL(urlValue);
    if (!/(^|\.)patreon\.com$/i.test(url.hostname)) return "";
    const parts = url.pathname.split("/").filter(Boolean);
    const candidate = ["c", "join"].includes((parts[0] || "").toLowerCase())
      ? parts[1]
      : parts[0];
    return String(candidate || "").toLowerCase();
  } catch {
    return "";
  }
}
function expectedCampaignSlug(ledger: Ledger) {
  const fromUrl = campaignSlug(String(ledger.url || ""));
  if (fromUrl) return fromUrl;
  const fromName = String(ledger.username || "").trim().replace(/^@/, "")
    .toLowerCase();
  return /^[a-z0-9_-]{1,100}$/.test(fromName) ? fromName : "";
}
async function ownedLedger(id: string, owner: string): Promise<Ledger | null> {
  const result = await service.from("account_ledger")
    .select("id,owner,username,url,suspended")
    .eq("id", id).eq("owner", owner).eq("provider", "patreon").maybeSingle();
  return result.error || !result.data ? null : result.data as Ledger;
}
function apiHeaders(accessToken: string): HeadersInit {
  return {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
    "User-Agent": USER_AGENT,
  };
}
async function exchange(code: string): Promise<Token | null> {
  try {
    const response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": USER_AGENT,
      },
      body: new URLSearchParams({
        code,
        grant_type: "authorization_code",
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uri: CALLBACK_URL,
      }),
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
    const payload = await response.json().catch(() => ({})) as Json;
    if (
      !response.ok || typeof payload.access_token !== "string" ||
      typeof payload.refresh_token !== "string" ||
      String(payload.token_type || "").toLowerCase() !== "bearer"
    ) return null;
    return {
      accessToken: payload.access_token,
      refreshToken: payload.refresh_token,
      scopes: scopes(payload.scope),
      expiresAt: expiry(payload.expires_in),
    };
  } catch {
    return null;
  }
}
async function refreshToken(refreshToken: string): Promise<Token | null> {
  try {
    const response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": USER_AGENT,
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
      }),
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
    const payload = await response.json().catch(() => ({})) as Json;
    if (
      !response.ok || typeof payload.access_token !== "string" ||
      typeof payload.refresh_token !== "string"
    ) return null;
    return {
      accessToken: payload.access_token,
      refreshToken: payload.refresh_token,
      scopes: scopes(payload.scope),
      expiresAt: expiry(payload.expires_in),
    };
  } catch {
    return null;
  }
}
async function identity(accessToken: string) {
  const url = new URL(`${API_ROOT}/identity`);
  url.searchParams.set("fields[user]", "full_name,url,is_creator");
  try {
    const response = await fetch(url, {
      headers: apiHeaders(accessToken),
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
    const payload = await response.json().catch(() => ({})) as { data?: Json };
    const id = String(payload.data?.id || "");
    return response.ok && id ? id : "";
  } catch {
    return "";
  }
}
async function campaigns(accessToken: string): Promise<Campaign[] | null> {
  const url = new URL(`${API_ROOT}/campaigns`);
  url.searchParams.set("fields[campaign]", "name,creation_name,url,vanity");
  url.searchParams.set("page[count]", "100");
  try {
    const response = await fetch(url, {
      headers: apiHeaders(accessToken),
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
    const payload = await response.json().catch(() => ({})) as {
      data?: Json[];
    };
    if (!response.ok || !Array.isArray(payload.data)) return null;
    return payload.data.map((row) => {
      const attributes = row.attributes && typeof row.attributes === "object"
        ? row.attributes as Json
        : {};
      return {
        id: String(row.id || ""),
        name: String(
          attributes.name || attributes.creation_name ||
            "Untitled Patreon campaign",
        ).slice(0, 200),
        vanity: String(attributes.vanity || "").toLowerCase(),
        url: String(attributes.url || "").slice(0, 1000),
      };
    }).filter((row) => row.id);
  } catch {
    return null;
  }
}
async function stored(owner: string, ledgerId: string): Promise<Stored | null> {
  const result = await service.rpc("patreon_get_token_bundle", {
    p_ledger_id: ledgerId,
    p_owner: owner,
  });
  const row = (Array.isArray(result.data) ? result.data[0] : result.data) as
    | Json
    | null;
  let bundle = row?.token_bundle as Json | string | undefined;
  if (typeof bundle === "string") {
    try {
      bundle = JSON.parse(bundle) as Json;
    } catch {
      return null;
    }
  }
  if (result.error || !row || !bundle || typeof bundle !== "object") {
    return null;
  }
  return {
    userId: String(row.patreon_user_id || ""),
    campaignId: String(row.campaign_id || ""),
    campaignName: String(row.campaign_name || ""),
    campaignUrl: String(row.campaign_url || ""),
    accessToken: String(bundle.access_token || ""),
    refreshToken: String(bundle.refresh_token || ""),
    scopes: scopes(bundle.granted_scopes),
    expiresAt: String(bundle.expires_at || ""),
  };
}
async function save(
  ledger: Ledger,
  userId: string,
  token: Token,
  campaign?: Campaign,
) {
  return await service.rpc("patreon_store_token_bundle", {
    p_ledger_id: ledger.id,
    p_owner: ledger.owner,
    p_patreon_user_id: userId,
    p_campaign_id: campaign?.id || "",
    p_campaign_name: campaign?.name || "",
    p_campaign_url: campaign?.url || "",
    p_access_token: token.accessToken,
    p_refresh_token: token.refreshToken,
    p_expires_at: token.expiresAt,
    p_granted_scopes: token.scopes,
  });
}
async function verified(owner: string, ledger: Ledger): Promise<Stored | null> {
  const prior = await stored(owner, ledger.id);
  if (!prior || !hasExactReadScopes(prior.scopes)) return null;
  let token: Token = prior;
  let userId = await identity(prior.accessToken);
  if (!userId) {
    const next = await refreshToken(prior.refreshToken);
    if (!next || !hasExactReadScopes(next.scopes)) return null;
    token = next;
    userId = await identity(next.accessToken);
  }
  if (!userId || userId !== prior.userId) return null;
  const saved = await save(
    ledger,
    userId,
    token,
    prior.campaignId
      ? {
        id: prior.campaignId,
        name: prior.campaignName,
        url: prior.campaignUrl,
        vanity: campaignSlug(prior.campaignUrl),
      }
      : undefined,
  );
  return saved.error ? null : { ...prior, ...token };
}
async function lease(
  ledger: Ledger,
  kind: "connect" | "refresh" | "disconnect" | "read",
  origin: string,
  operation: () => Promise<Response>,
) {
  const leaseId = crypto.randomUUID();
  const claim = await service.rpc("claim_patreon_operation", {
    p_ledger_id: ledger.id,
    p_owner: ledger.owner,
    p_lease_id: leaseId,
    p_operation_kind: kind,
    p_ttl_seconds: 180,
  });
  if (claim.error || claim.data !== true) {
    return json(origin, 409, { error: "Another Patreon operation is active" });
  }
  try {
    return await operation();
  } finally {
    await service.rpc("release_patreon_operation", {
      p_ledger_id: ledger.id,
      p_owner: ledger.owner,
      p_lease_id: leaseId,
    });
  }
}
function campaignMatchesLedger(ledger: Ledger, campaign: Campaign) {
  const expected = expectedCampaignSlug(ledger);
  if (!expected) return true;
  return campaign.vanity === expected ||
    campaignSlug(campaign.url) === expected;
}

serve(async (req) => {
  const origin = req.headers.get("Origin") || "";
  if (req.method === "OPTIONS") {
    return ALLOWED_ORIGINS.has(origin)
      ? new Response(null, { status: 204, headers: cors(origin) })
      : new Response(null, { status: 403 });
  }
  if (req.method === "GET") {
    const url = new URL(req.url);
    const state = url.searchParams.get("state") || "";
    if (!SAFE_STATE.test(state)) {
      return redirectToApp(APP_ORIGIN, {
        patreon: "error",
        reason: "invalid_oauth_state",
      });
    }
    const transaction = await service.from("patreon_oauth_transactions")
      .select("return_origin,expires_at").eq(
        "state_hash",
        await sha256Hex(state),
      ).maybeSingle();
    const returnOrigin = String(transaction.data?.return_origin || APP_ORIGIN);
    if (
      transaction.error || !transaction.data ||
      Date.parse(transaction.data.expires_at) <= Date.now()
    ) {
      return redirectToApp(returnOrigin, {
        patreon: "error",
        reason: "expired_oauth_state",
      });
    }
    return redirectToApp(returnOrigin, {
      patreon: "finish",
      state,
      code: url.searchParams.get("code") || "",
      provider_error: url.searchParams.get("error") || "",
    });
  }
  if (req.method !== "POST") return json(origin, 405, { error: "POST only" });
  if (!ALLOWED_ORIGINS.has(origin)) {
    return json(origin, 403, { error: "Origin not allowed" });
  }
  const auth = createClient(SUPABASE_URL, ANON_KEY, {
    global: {
      headers: { Authorization: req.headers.get("Authorization") || "" },
    },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const guard = await requireAal2(req, auth);
  if (!guard.ok) {
    return json(origin, guard.status, { error: guard.error, code: guard.code });
  }
  const raw = await req.text();
  if (new TextEncoder().encode(raw).byteLength > 16_384) {
    return json(origin, 413, { error: "Request is too large" });
  }
  let body: Json;
  try {
    body = JSON.parse(raw) as Json;
  } catch {
    return json(origin, 400, { error: "Invalid request body" });
  }
  const action = String(body.action || "");
  const ledgerId = String(body.ledgerId || "");
  const owner = guard.user.id;

  if (action === "capabilities" && !ledgerId) {
    return json(origin, 200, {
      credentialsConfigured: configured(),
      apiVersion: "v2",
      scopes: REQUIRED_SCOPES,
      readOnly: true,
      campaignBindingSupported: true,
      existingPostReportingSupported: true,
      ordinaryPostCreateSupported: false,
      ordinaryPostSchedulingSupported: false,
      nativeHandoffSupported: true,
      webhookFoundation:
        "Patreon API v2 documents webhooks, but no webhook write scope is requested by this least-privilege connector.",
      clientsUrl: CLIENTS_URL,
    });
  }
  if (!configured()) {
    return json(origin, 503, {
      error: "Patreon OAuth credentials are not configured",
      clientsUrl: CLIENTS_URL,
    });
  }

  if (action === "complete") {
    const state = String(body.state || "");
    const browserNonce = String(body.browserNonce || "");
    const code = String(body.code || "");
    if (!SAFE_STATE.test(state) || !SAFE_STATE.test(browserNonce)) {
      return json(origin, 400, { error: "Invalid Patreon OAuth completion" });
    }
    const consumed = await service.from("patreon_oauth_transactions").delete()
      .eq("state_hash", await sha256Hex(state)).eq("owner", owner)
      .eq("browser_nonce_hash", await sha256Hex(browserNonce))
      .gt("expires_at", new Date().toISOString()).select("ledger_id")
      .maybeSingle();
    if (consumed.error || !consumed.data) {
      return json(origin, 409, {
        error: "Patreon authorization expired or was already used",
      });
    }
    const ledger = await ownedLedger(String(consumed.data.ledger_id), owner);
    if (!ledger || ledger.suspended) {
      return json(origin, 409, {
        error: "Patreon ledger entry is unavailable",
      });
    }
    if (body.providerError || !code || code.length > 4096) {
      return json(origin, 409, {
        error: "Patreon authorization was cancelled or invalid",
      });
    }
    return await lease(ledger, "connect", origin, async () => {
      const token = await exchange(code);
      if (!token || !hasExactReadScopes(token.scopes)) {
        return json(origin, 409, {
          error:
            "Patreon did not return exactly the three requested v2 read permissions. Revoke any older broader grant before reconnecting.",
          manualRevocationUrl: REVOCATION_SETTINGS_URL,
        });
      }
      const [userId, available] = await Promise.all([
        identity(token.accessToken),
        campaigns(token.accessToken),
      ]);
      if (!userId || !available) {
        return json(origin, 502, {
          error: "Patreon identity or campaigns could not be verified",
          manualRevocationUrl: REVOCATION_SETTINGS_URL,
        });
      }
      const matching = available.filter((campaign) =>
        campaignMatchesLedger(ledger, campaign)
      );
      const selected = matching.length === 1 ? matching[0] : undefined;
      const saved = await save(ledger, userId, token, selected);
      if (saved.error) {
        return json(origin, 503, {
          error: "Patreon grant could not be stored safely",
          manualRevocationUrl: REVOCATION_SETTINGS_URL,
        });
      }
      return json(origin, 200, {
        connected: Boolean(selected),
        campaignSelectionRequired: !selected,
        campaign: selected || null,
        campaigns: selected ? [] : available,
        expectedCampaignSlug: expectedCampaignSlug(ledger) || null,
        readOnly: true,
        providerWriteGranted: false,
      });
    });
  }

  if (!SAFE_UUID.test(ledgerId)) {
    return json(origin, 400, { error: "Valid ledgerId required" });
  }
  const ledger = await ownedLedger(ledgerId, owner);
  if (!ledger) {
    return json(origin, 404, { error: "Owned Patreon ledger not found" });
  }
  if (action === "capabilities") {
    const connection = await service.from("account_connections")
      .select(
        "connection_state,provider_subject,granted_scopes,expires_at,error_code",
      )
      .eq("ledger_id", ledger.id).eq("owner", owner).eq("provider", "patreon")
      .maybeSingle();
    return json(origin, 200, {
      credentialsConfigured: configured(),
      connected: connection.data?.connection_state === "connected",
      campaignSelectionRequired:
        connection.data?.connection_state === "verified",
      campaignId: connection.data?.provider_subject || "",
      grantedScopes: scopes(connection.data?.granted_scopes),
      expiresAt: connection.data?.expires_at || null,
      errorCode: connection.data?.error_code || "",
      readOnly: true,
      ordinaryPostCreateSupported: false,
      ordinaryPostSchedulingSupported: false,
      nativeHandoffSupported: true,
    });
  }
  if (action === "start") {
    if (ledger.suspended) {
      return json(origin, 409, {
        error: "Resume this Patreon account before connecting",
      });
    }
    await service.from("patreon_oauth_transactions").delete().eq("owner", owner)
      .eq("ledger_id", ledger.id);
    const state = randomSafe();
    const browserNonce = randomSafe();
    const inserted = await service.from("patreon_oauth_transactions").insert({
      state_hash: await sha256Hex(state),
      owner,
      ledger_id: ledger.id,
      browser_nonce_hash: await sha256Hex(browserNonce),
      return_origin: origin,
      expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
    });
    if (inserted.error) {
      return json(origin, 503, {
        error: "Could not start Patreon authorization",
      });
    }
    const url = new URL(AUTHORIZE_URL);
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: CLIENT_ID,
      redirect_uri: CALLBACK_URL,
      scope: REQUIRED_SCOPES.join(" "),
      state,
    }).toString();
    return json(origin, 200, {
      authorizationUrl: url.toString(),
      browserNonce,
      requestedScopes: REQUIRED_SCOPES,
    });
  }
  if (action === "select-campaign") {
    const requestedId = String(body.campaignId || "");
    if (!requestedId || requestedId.length > 100) {
      return json(origin, 400, { error: "Valid campaignId required" });
    }
    return await lease(ledger, "read", origin, async () => {
      const access = await verified(owner, ledger);
      if (!access) {
        return json(origin, 409, {
          error: "Reconnect Patreon before selecting a campaign",
        });
      }
      const available = await campaigns(access.accessToken);
      const selected = available?.find((campaign) =>
        campaign.id === requestedId
      );
      if (!selected || !campaignMatchesLedger(ledger, selected)) {
        return json(origin, 409, {
          error:
            "That campaign does not match this exact Patreon account record",
        });
      }
      const bound = await service.rpc("patreon_set_campaign_binding_service", {
        p_ledger_id: ledger.id,
        p_owner: owner,
        p_campaign_id: selected.id,
        p_campaign_name: selected.name,
        p_campaign_url: selected.url,
      });
      return bound.error || bound.data !== true
        ? json(origin, 503, {
          error: "Patreon campaign binding could not be stored",
        })
        : json(origin, 200, {
          connected: true,
          campaign: selected,
          readOnly: true,
        });
    });
  }
  if (action === "refresh") {
    return await lease(ledger, "refresh", origin, async () => {
      const access = await verified(owner, ledger);
      return access
        ? json(origin, 200, {
          connected: Boolean(access.campaignId),
          campaignId: access.campaignId,
          expiresAt: access.expiresAt,
          readOnly: true,
        })
        : json(origin, 409, {
          error: "Patreon access is invalid; reconnect this campaign",
        });
    });
  }
  if (action === "report") {
    return await lease(ledger, "read", origin, async () => {
      const access = await verified(owner, ledger);
      if (!access || !access.campaignId) {
        return json(origin, 409, {
          error: "Select and reconnect the Patreon campaign first",
        });
      }
      const url = new URL(
        `${API_ROOT}/campaigns/${encodeURIComponent(access.campaignId)}/posts`,
      );
      url.searchParams.set(
        "fields[post]",
        "title,url,published_at,is_paid,is_public",
      );
      url.searchParams.set("page[count]", "50");
      try {
        const response = await fetch(url, {
          headers: apiHeaders(access.accessToken),
          redirect: "error",
          signal: AbortSignal.timeout(20_000),
        });
        const payload = await response.json().catch(() => ({})) as {
          data?: Json[];
          meta?: Json;
        };
        if (!response.ok || !Array.isArray(payload.data)) {
          return json(origin, 502, {
            error: "Patreon could not return the campaign post report",
          });
        }
        const posts = payload.data.map((row) => ({
          id: String(row.id || ""),
          ...(row.attributes && typeof row.attributes === "object"
            ? row.attributes as Json
            : {}),
        }));
        return json(origin, 200, {
          campaignId: access.campaignId,
          campaignName: access.campaignName,
          campaignUrl: access.campaignUrl,
          posts,
          pagination: payload.meta || {},
          readOnly: true,
          providerWritePerformed: false,
        });
      } catch {
        return json(origin, 502, {
          error: "Patreon post reporting is temporarily unavailable",
        });
      }
    });
  }
  if (action === "disconnect") {
    if (body.manualRevocationAcknowledged !== true) {
      return json(origin, 409, {
        manualRevocationRequired: true,
        manualRevocationUrl: REVOCATION_SETTINGS_URL,
        instruction:
          "Revoke MyPersonas under Patreon's connected apps, then confirm here. Patreon documents no developer token-revoke endpoint.",
      });
    }
    return await lease(ledger, "disconnect", origin, async () => {
      const removed = await service.rpc("patreon_delete_token_bundle", {
        p_ledger_id: ledger.id,
        p_owner: owner,
      });
      return removed.error
        ? json(origin, 503, {
          error: "Patreon local credential cleanup needs attention",
        })
        : json(origin, 200, {
          disconnected: true,
          providerRevocationOwnerConfirmed: true,
        });
    });
  }
  return json(origin, 400, { error: "Unsupported Patreon OAuth action" });
});
