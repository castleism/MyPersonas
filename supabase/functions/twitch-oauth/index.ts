// Twitch OAuth connector for exact broadcaster binding and least-privilege
// feature grants. Twitch is not exposed as a general post/video publisher.
//
// POST (AAL2):
//   {action:"capabilities",ledgerId?}
//   {action:"start",ledgerId,features:["channel_info","schedule","announcements"]}
//   {action:"complete",state,code,browserNonce,providerError?}
//   {action:"validate",ledgerId} | {action:"refresh",ledgerId}
//   {action:"disconnect",ledgerId}
// GET is only the provider callback trampoline.
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { requireAal2 } from "../_shared/aal2.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const CLIENT_ID = Deno.env.get("TWITCH_CLIENT_ID") || "";
const CLIENT_SECRET = Deno.env.get("TWITCH_CLIENT_SECRET") || "";
const CALLBACK_URL = Deno.env.get("TWITCH_OAUTH_REDIRECT_URI") ||
  "https://nwsqyuucwzihruszocge.supabase.co/functions/v1/twitch-oauth";
const APP_ORIGIN = (Deno.env.get("TWITCH_OAUTH_APP_ORIGIN") ||
  "https://mypersonas.online").replace(/\/$/, "");
const AUTH_URL = "https://id.twitch.tv/oauth2/authorize";
const TOKEN_URL = "https://id.twitch.tv/oauth2/token";
const VALIDATE_URL = "https://id.twitch.tv/oauth2/validate";
const REVOKE_URL = "https://id.twitch.tv/oauth2/revoke";
const USERS_URL = "https://api.twitch.tv/helix/users";
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
const FEATURE_SCOPES = {
  channel_info: "channel:manage:broadcast",
  schedule: "channel:manage:schedule",
  announcements: "moderator:manage:announcements",
} as const;
const ALL_SCOPES = Object.values(FEATURE_SCOPES);
const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

type Ledger = {
  id: string;
  owner: string;
  provider: string;
  username: string;
  url: string;
  suspended: boolean;
};
type Token = {
  accessToken: string;
  refreshToken: string;
  scopes: string[];
  expiresAt: string;
};
type Validation = {
  clientId: string;
  userId: string;
  login: string;
  scopes: string[];
  expiresAt: string;
};

function cors(origin: string): HeadersInit {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.has(origin)
      ? origin
      : APP_ORIGIN,
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
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
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
function scopes(value: unknown): string[] {
  const input = Array.isArray(value) ? value : String(value || "").split(/\s+/);
  return [
    ...new Set(input.map(String).map((item) => item.trim()).filter(Boolean)),
  ]
    .sort();
}
function sameScopes(left: string[], right: string[]) {
  return left.length === right.length &&
    left.every((scope, index) => scope === right[index]);
}
function expiry(value: unknown) {
  const seconds = Number(value);
  const bounded = Number.isFinite(seconds)
    ? Math.max(60, Math.min(60 * 60 * 24 * 90, Math.floor(seconds)))
    : 4 * 60 * 60;
  return new Date(Date.now() + bounded * 1000).toISOString();
}
function expectedLogin(ledger: Ledger) {
  const fromName = String(ledger.username || "").trim().replace(/^@/, "")
    .toLowerCase();
  if (/^[a-z0-9_]{1,25}$/.test(fromName)) return fromName;
  try {
    const url = new URL(String(ledger.url || ""));
    if (!/(^|\.)twitch\.tv$/i.test(url.hostname)) return "";
    const login = url.pathname.split("/").filter(Boolean)[0]?.toLowerCase() ||
      "";
    return /^[a-z0-9_]{1,25}$/.test(login) ? login : "";
  } catch {
    return "";
  }
}
function configured() {
  return Boolean(CLIENT_ID && CLIENT_SECRET);
}
async function ownedLedger(id: string, owner: string): Promise<Ledger | null> {
  const result = await admin.from("account_ledger")
    .select("id,owner,provider,username,url,suspended")
    .eq("id", id).eq("owner", owner).eq("provider", "twitch").maybeSingle();
  return result.error || !result.data ? null : result.data as Ledger;
}
async function exchangeCode(code: string): Promise<Token | null> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code,
      grant_type: "authorization_code",
      redirect_uri: CALLBACK_URL,
    }),
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
  const payload = await response.json().catch(() => ({})) as Record<
    string,
    unknown
  >;
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
}
async function refreshToken(refreshToken: string): Promise<Token | null> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
  const payload = await response.json().catch(() => ({})) as Record<
    string,
    unknown
  >;
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
}
async function validateToken(accessToken: string): Promise<Validation | null> {
  const response = await fetch(VALIDATE_URL, {
    headers: { Authorization: `OAuth ${accessToken}` },
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
  const payload = await response.json().catch(() => ({})) as Record<
    string,
    unknown
  >;
  const userId = String(payload.user_id || "");
  const login = String(payload.login || "").toLowerCase();
  const clientId = String(payload.client_id || "");
  if (
    !response.ok || !/^[0-9]{1,30}$/.test(userId) ||
    !/^[a-z0-9_]{1,25}$/.test(login) || clientId !== CLIENT_ID
  ) return null;
  return {
    clientId,
    userId,
    login,
    scopes: scopes(payload.scopes),
    expiresAt: expiry(payload.expires_in),
  };
}
async function displayName(token: string, userId: string) {
  const url = new URL(USERS_URL);
  url.searchParams.set("id", userId);
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Client-Id": CLIENT_ID,
      Accept: "application/json",
    },
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
  const payload = await response.json().catch(() => ({})) as {
    data?: Array<Record<string, unknown>>;
  };
  const item =
    response.ok && Array.isArray(payload.data) && payload.data.length === 1
      ? payload.data[0]
      : null;
  return item && String(item.id || "") === userId
    ? String(item.display_name || "").slice(0, 100)
    : "";
}
async function revoke(accessToken: string) {
  try {
    const response = await fetch(REVOKE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: CLIENT_ID, token: accessToken }),
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}
async function stored(ledger: Ledger) {
  const result = await admin.rpc("twitch_get_token_bundle", {
    p_ledger_id: ledger.id,
    p_owner: ledger.owner,
  });
  const row = (Array.isArray(result.data) ? result.data[0] : result.data) as
    | Record<string, unknown>
    | null;
  const bundle = row?.token_bundle as Record<string, unknown> | null;
  if (result.error || !row || !bundle) return null;
  return {
    broadcasterId: String(row.broadcaster_id || ""),
    login: String(row.broadcaster_login || ""),
    name: String(row.broadcaster_name || ""),
    accessToken: String(bundle.access_token || ""),
    refreshToken: String(bundle.refresh_token || ""),
    grantedScopes: scopes(bundle.granted_scopes),
  };
}
async function store(
  ledger: Ledger,
  token: Token,
  identity: Validation,
  name: string,
) {
  return await admin.rpc("twitch_store_token_bundle", {
    p_ledger_id: ledger.id,
    p_owner: ledger.owner,
    p_broadcaster_id: identity.userId,
    p_broadcaster_login: identity.login,
    p_broadcaster_name: name,
    p_access_token: token.accessToken,
    p_refresh_token: token.refreshToken,
    p_expires_at: identity.expiresAt,
    p_granted_scopes: identity.scopes,
  });
}
async function lease(
  ledger: Ledger,
  kind: "connect" | "refresh" | "disconnect",
  origin: string,
  operation: () => Promise<Response>,
) {
  const leaseId = crypto.randomUUID();
  const claim = await admin.rpc("claim_twitch_operation", {
    p_ledger_id: ledger.id,
    p_owner: ledger.owner,
    p_lease_id: leaseId,
    p_operation_kind: kind,
    p_ttl_seconds: 120,
  });
  if (claim.error || claim.data !== true) {
    return json(origin, 409, { error: "Another Twitch operation is active" });
  }
  try {
    return await operation();
  } finally {
    await admin.rpc("release_twitch_operation", {
      p_ledger_id: ledger.id,
      p_owner: ledger.owner,
      p_lease_id: leaseId,
    });
  }
}

serve(async (req) => {
  const origin = req.headers.get("Origin") || "";
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors(origin) });
  }
  if (req.method === "GET") {
    const url = new URL(req.url);
    const state = url.searchParams.get("state") || "";
    if (!SAFE_STATE.test(state)) {
      return redirectToApp(APP_ORIGIN, {
        twitch: "error",
        reason: "invalid_oauth_state",
      });
    }
    const record = await admin.from("twitch_oauth_transactions")
      .select("return_origin,expires_at")
      .eq("state_hash", await sha256Hex(state)).maybeSingle();
    const returnOrigin = String(record.data?.return_origin || APP_ORIGIN);
    if (
      record.error || !record.data ||
      Date.parse(record.data.expires_at) <= Date.now()
    ) {
      return redirectToApp(returnOrigin, {
        twitch: "error",
        reason: "expired_oauth_state",
      });
    }
    return redirectToApp(returnOrigin, {
      twitch: "finish",
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
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json(origin, 400, { error: "Invalid request body" });
  }
  const action = String(body.action || "");
  const ledgerId = String(body.ledgerId || "");
  const owner = guard.user.id;

  if (action === "capabilities" && !ledgerId) {
    return json(origin, 200, {
      credentialsConfigured: configured(),
      generalFeedPostingSupported: false,
      videoUploadSupported: false,
      supportedFeatures: [
        { id: "channel_info", scope: FEATURE_SCOPES.channel_info },
        { id: "schedule", scope: FEATURE_SCOPES.schedule },
        { id: "announcements", scope: FEATURE_SCOPES.announcements },
      ],
      announcementSchedulingSupported: false,
      nonRecurringScheduleEligibility: "Twitch Affiliate or Partner only",
    });
  }
  if (!configured()) {
    return json(origin, 503, {
      error: "Twitch OAuth credentials are not configured",
    });
  }

  if (action === "complete") {
    const state = String(body.state || "");
    const browserNonce = String(body.browserNonce || "");
    const code = String(body.code || "");
    if (!SAFE_STATE.test(state) || !SAFE_STATE.test(browserNonce)) {
      return json(origin, 400, { error: "Invalid Twitch OAuth completion" });
    }
    const consumed = await admin.from("twitch_oauth_transactions").delete()
      .eq("state_hash", await sha256Hex(state)).eq("owner", owner)
      .eq("browser_nonce_hash", await sha256Hex(browserNonce))
      .gt("expires_at", new Date().toISOString())
      .select("ledger_id,requested_scopes").maybeSingle();
    if (consumed.error || !consumed.data) {
      return json(origin, 409, {
        error: "Twitch authorization expired or was already used",
      });
    }
    const transaction = consumed.data;
    const ledger = await ownedLedger(transaction.ledger_id, owner);
    if (!ledger || ledger.suspended) {
      return json(origin, 409, {
        error: "The Twitch ledger entry is unavailable",
      });
    }
    if (body.providerError || !code || code.length > 4096) {
      return json(origin, 409, {
        error: "Twitch authorization was cancelled or invalid",
      });
    }
    return await lease(ledger, "connect", origin, async () => {
      let token: Token | null = null;
      try {
        token = await exchangeCode(code);
      } catch {
        // Provider outcome may be ambiguous; fail closed.
      }
      if (!token) {
        return json(origin, 502, {
          error:
            "Twitch did not return a complete token. Review Twitch Connections before retrying.",
          manualRevocationUrl: "https://www.twitch.tv/settings/connections",
        });
      }
      const validation = await validateToken(token.accessToken).catch(() =>
        null
      );
      const requested = scopes(transaction.requested_scopes);
      const expected = expectedLogin(ledger);
      if (
        !validation || !expected || validation.login !== expected ||
        !sameScopes(requested, validation.scopes) ||
        validation.scopes.some((scope) =>
          !ALL_SCOPES.includes(scope as typeof ALL_SCOPES[number])
        )
      ) {
        const revoked = await revoke(token.accessToken);
        return json(origin, revoked ? 409 : 502, {
          error: !expected
            ? "Record the exact Twitch username before connecting."
            : "The selected Twitch broadcaster or permissions do not match this account record.",
          rejectedGrantRevoked: revoked,
          ...(!revoked
            ? {
              manualRevocationUrl: "https://www.twitch.tv/settings/connections",
            }
            : {}),
        });
      }
      const name = await displayName(token.accessToken, validation.userId)
        .catch(() => "");
      const saved = await store(ledger, token, validation, name);
      if (saved.error) {
        const revoked = await revoke(token.accessToken);
        return json(origin, 503, {
          error:
            "Twitch authorized, but the exact broadcaster grant could not be stored safely.",
          rejectedGrantRevoked: revoked,
          ...(!revoked
            ? {
              manualRevocationUrl: "https://www.twitch.tv/settings/connections",
            }
            : {}),
        });
      }
      return json(origin, 200, {
        connected: true,
        broadcasterId: validation.userId,
        broadcasterLogin: validation.login,
        broadcasterName: name,
        grantedScopes: validation.scopes,
        generalFeedPostingSupported: false,
        videoUploadSupported: false,
      });
    });
  }

  if (!SAFE_UUID.test(ledgerId)) {
    return json(origin, 400, { error: "A valid ledger id is required" });
  }
  const ledger = await ownedLedger(ledgerId, owner);
  if (!ledger) {
    return json(origin, 404, { error: "Owned Twitch ledger not found" });
  }

  if (action === "capabilities") {
    const connection = await admin.from("account_connections")
      .select(
        "connection_state,provider_subject,granted_scopes,expires_at,error_code",
      )
      .eq("ledger_id", ledger.id).eq("owner", owner).maybeSingle();
    const granted = scopes(connection.data?.granted_scopes);
    return json(origin, 200, {
      credentialsConfigured: configured(),
      connected: connection.data?.connection_state === "connected",
      broadcasterId: connection.data?.provider_subject || "",
      grantedScopes: granted,
      enabledFeatures: Object.entries(FEATURE_SCOPES)
        .filter(([, scope]) => granted.includes(scope)).map(([feature]) =>
          feature
        ),
      expiresAt: connection.data?.expires_at || null,
      errorCode: connection.data?.error_code || "",
      generalFeedPostingSupported: false,
      videoUploadSupported: false,
    });
  }
  if (action === "start") {
    if (ledger.suspended) {
      return json(origin, 409, {
        error: "Resume this Twitch account before connecting",
      });
    }
    if (!expectedLogin(ledger)) {
      return json(origin, 409, {
        error: "Record the exact Twitch username before connecting",
      });
    }
    const features = Array.isArray(body.features)
      ? [...new Set(body.features.map(String))]
      : [];
    if (
      !features.length || features.some((item) => !(item in FEATURE_SCOPES))
    ) {
      return json(origin, 400, {
        error: "Select at least one supported Twitch feature",
      });
    }
    const requested = features.map((item) =>
      FEATURE_SCOPES[item as keyof typeof FEATURE_SCOPES]
    )
      .sort();
    await admin.from("twitch_oauth_transactions").delete().eq("owner", owner)
      .eq("ledger_id", ledger.id);
    const state = randomSafe();
    const browserNonce = randomSafe();
    const inserted = await admin.from("twitch_oauth_transactions").insert({
      state_hash: await sha256Hex(state),
      owner,
      ledger_id: ledger.id,
      browser_nonce_hash: await sha256Hex(browserNonce),
      requested_scopes: requested,
      return_origin: origin,
      expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
    });
    if (inserted.error) {
      return json(origin, 503, {
        error: "Could not start Twitch authorization",
      });
    }
    const url = new URL(AUTH_URL);
    url.search = new URLSearchParams({
      client_id: CLIENT_ID,
      redirect_uri: CALLBACK_URL,
      response_type: "code",
      scope: requested.join(" "),
      state,
      force_verify: "true",
    }).toString();
    return json(origin, 200, {
      authorizationUrl: url.toString(),
      browserNonce,
      requestedScopes: requested,
    });
  }

  if (action === "validate" || action === "refresh") {
    return await lease(ledger, "refresh", origin, async () => {
      const prior = await stored(ledger);
      if (!prior) {
        return json(origin, 409, {
          error: "Reconnect this Twitch broadcaster",
        });
      }
      let token: Token | null = {
        accessToken: prior.accessToken,
        refreshToken: prior.refreshToken,
        scopes: prior.grantedScopes,
        expiresAt: new Date().toISOString(),
      };
      let rotated = false;
      let validation = await validateToken(prior.accessToken).catch(() => null);
      if (!validation || action === "refresh") {
        token = await refreshToken(prior.refreshToken).catch(() => null);
        rotated = Boolean(token);
        validation = token
          ? await validateToken(token.accessToken).catch(() => null)
          : null;
      }
      if (
        !token || !validation || validation.userId !== prior.broadcasterId ||
        validation.login !== prior.login ||
        !sameScopes(prior.grantedScopes, validation.scopes)
      ) {
        await admin.from("account_connections").update({
          connection_state: "error",
          error_code: "twitch_reconnect_required",
          last_checked_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }).eq("ledger_id", ledger.id).eq("owner", owner);
        return json(origin, 409, {
          error: "Twitch access is invalid; reconnect this broadcaster",
        });
      }
      const name = await displayName(token.accessToken, validation.userId)
        .catch(() => prior.name);
      const saved = await store(ledger, token, validation, name);
      if (saved.error) {
        const code = rotated
          ? "twitch_manual_revoke_required"
          : "twitch_validation_checkpoint_failed";
        const now = new Date().toISOString();
        await admin.from("account_connections").update({
          connection_state: "error",
          error_code: code,
          last_checked_at: now,
          updated_at: now,
        }).eq("ledger_id", ledger.id).eq("owner", owner).eq(
          "provider",
          "twitch",
        );
        return json(origin, rotated ? 502 : 503, {
          error: rotated
            ? "Twitch rotated the grant, but its new token could not be stored. Revoke MyPersonas in Twitch Connections before resetting this account."
            : "Validated Twitch access could not be checkpointed safely.",
          ...(rotated
            ? {
              manualRevocationRequired: true,
              manualRevocationUrl: "https://www.twitch.tv/settings/connections",
            }
            : {}),
        });
      }
      return json(origin, 200, {
        connected: true,
        broadcasterId: validation.userId,
        broadcasterLogin: validation.login,
        grantedScopes: validation.scopes,
        expiresAt: validation.expiresAt,
      });
    });
  }

  if (action === "disconnect") {
    return await lease(ledger, "disconnect", origin, async () => {
      const prior = await stored(ledger);
      if (prior && !await revoke(prior.accessToken)) {
        return json(origin, 502, {
          error:
            "Twitch did not confirm revocation. Remove MyPersonas in Twitch Connections before retrying.",
          manualRevocationUrl: "https://www.twitch.tv/settings/connections",
        });
      }
      const removed = await admin.rpc("twitch_delete_token_bundle", {
        p_ledger_id: ledger.id,
        p_owner: owner,
      });
      if (removed.error) {
        return json(origin, 503, {
          error: "Twitch revoked access, but local cleanup needs attention",
        });
      }
      return json(origin, 200, { disconnected: true });
    });
  }
  return json(origin, 400, { error: "Unsupported Twitch OAuth action" });
});
