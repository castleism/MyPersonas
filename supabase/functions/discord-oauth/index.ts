// discord-oauth — official Discord OAuth2 webhook.incoming channel consent.
//
// Browser contract:
//   POST { action:"capabilities" }
//   POST { action:"start", ledgerId }
//     -> { authorizationUrl, browserNonce }
//   GET  ?state&code (Discord callback)
//     -> redirects to the initiating app origin with discord=finish
//   POST { action:"complete", state, code, browserNonce, providerError? }
//   POST { action:"disconnect", ledgerId }
//
// start, complete, and disconnect require a currently validated AAL2 Supabase
// session. State is random, hashed at rest, short-lived, single-use, and bound
// to a second nonce retained only by the initiating browser session.
//
// No Discord password, user token automation, bot token, or pasted webhook URL
// is accepted. The webhook URL/token and OAuth access/refresh tokens returned by
// Discord are stored only in Supabase Vault through migration-066 service RPCs.
// Disconnect deletes the exact provider webhook, revokes the OAuth grant, and
// only then erases the local Vault bundle.
//
// Deploy without gateway JWT verification because the GET provider callback has
// no Supabase Authorization header. Every privileged POST validates JWT+AAL2.
// Required secrets: DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET
// Optional: DISCORD_OAUTH_REDIRECT_URI, DISCORD_OAUTH_APP_ORIGIN
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { requireAal2 } from "../_shared/aal2.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const DISCORD_CLIENT_ID = (Deno.env.get("DISCORD_CLIENT_ID") || "").trim();
const DISCORD_CLIENT_SECRET = (Deno.env.get("DISCORD_CLIENT_SECRET") || "")
  .trim();
const CALLBACK_URL = (Deno.env.get("DISCORD_OAUTH_REDIRECT_URI") ||
  "https://nwsqyuucwzihruszocge.supabase.co/functions/v1/discord-oauth").trim();
const APP_ORIGIN = (Deno.env.get("DISCORD_OAUTH_APP_ORIGIN") ||
  "https://mypersonas.online").replace(/\/$/, "");
const API_BASE = "https://discord.com/api/v10";
const PROVIDER_TIMEOUT_MS = 20_000;
const OAUTH_TTL_MS = 5 * 60 * 1000;
const SAFE_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SNOWFLAKE = /^[0-9]{10,25}$/;
const WEBHOOK_TOKEN = /^[A-Za-z0-9_.-]{30,255}$/;
const ALLOWED_ORIGINS = new Set([
  APP_ORIGIN,
  "https://www.mypersonas.online",
  "http://localhost:8000",
  "http://localhost:5500",
  "http://127.0.0.1:8000",
  "http://127.0.0.1:5500",
]);

type RequestBody = {
  action?: unknown;
  ledgerId?: unknown;
  state?: unknown;
  code?: unknown;
  browserNonce?: unknown;
  providerError?: unknown;
};

type DiscordSecretBundle = {
  legacy?: unknown;
  webhook_url?: unknown;
  webhook_token?: unknown;
  webhook_id?: unknown;
  guild_id?: unknown;
  channel_id?: unknown;
  application_id?: unknown;
  webhook_name?: unknown;
  access_token?: unknown;
  refresh_token?: unknown;
  expires_at?: unknown;
  scopes?: unknown;
};

type DiscordWebhook = {
  id: string;
  guildId: string;
  channelId: string;
  applicationId: string;
  name: string;
  token: string;
  url: string;
};

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function configured() {
  return SNOWFLAKE.test(DISCORD_CLIENT_ID) && Boolean(DISCORD_CLIENT_SECRET);
}

function corsHeaders(origin: string): HeadersInit {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.has(origin)
      ? origin
      : APP_ORIGIN,
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Cache-Control": "no-store",
    "Vary": "Origin",
  };
}

function json(origin: string, status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(origin),
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
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

function base64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(
    /=+$/g,
    "",
  );
}

function randomUrlSafe(bytes = 32) {
  return base64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

async function sha256Hex(value: string) {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function basicAuth() {
  return `Basic ${btoa(`${DISCORD_CLIENT_ID}:${DISCORD_CLIENT_SECRET}`)}`;
}

function normalizedScopes(value: unknown) {
  const values = Array.isArray(value)
    ? value
    : typeof value === "string"
    ? value.split(/[\s,]+/)
    : [];
  return [
    ...new Set(values.map((item) => String(item || "").trim()).filter(Boolean)),
  ]
    .sort();
}

function exactWebhookUrl(webhookId: string, token: string) {
  return `https://discord.com/api/webhooks/${webhookId}/${token}`;
}

function parseSecretBundle(value: unknown): DiscordSecretBundle | null {
  let parsed = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return null;
    }
  }
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as DiscordSecretBundle
    : null;
}

function validatedWebhookFromToken(
  payload: Record<string, unknown>,
): DiscordWebhook | null {
  const raw = payload.webhook;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const webhook = raw as Record<string, unknown>;
  const id = String(webhook.id || "");
  const guildId = String(webhook.guild_id || "");
  const channelId = String(webhook.channel_id || "");
  const applicationId = String(webhook.application_id || "");
  const token = String(webhook.token || "");
  const url = String(webhook.url || "");
  const name = typeof webhook.name === "string"
    ? webhook.name.trim().slice(0, 80)
    : "";
  if (
    Number(webhook.type) !== 1 || !SNOWFLAKE.test(id) ||
    !SNOWFLAKE.test(guildId) || !SNOWFLAKE.test(channelId) ||
    applicationId !== DISCORD_CLIENT_ID || !WEBHOOK_TOKEN.test(token) ||
    url !== exactWebhookUrl(id, token)
  ) return null;
  return { id, guildId, channelId, applicationId, name, token, url };
}

async function markConnectionError(
  ledgerId: string,
  owner: string,
  errorCode: string,
) {
  const now = new Date().toISOString();
  const existing = await admin.from("account_connections")
    .select("ledger_id").eq("ledger_id", ledgerId).eq("owner", owner)
    .maybeSingle();
  if (existing.error) return false;
  if (existing.data) {
    // Preserve the exact channel identity and scopes so a failed disconnect or
    // ambiguous callback still has a trustworthy provider-revocation target.
    const { error } = await admin.from("account_connections").update({
      connection_state: "error",
      error_code: errorCode.slice(0, 120),
      last_checked_at: now,
      updated_at: now,
    }).eq("ledger_id", ledgerId).eq("owner", owner).eq("provider", "discord");
    return !error;
  }
  const { error } = await admin.from("account_connections").insert({
    ledger_id: ledgerId,
    owner,
    provider: "discord",
    provider_subject: "",
    granted_scopes: [],
    connection_state: "error",
    verification_method: "",
    error_code: errorCode.slice(0, 120),
    last_checked_at: now,
    updated_at: now,
  });
  return !error;
}

async function markNoGrantFailure(
  ledgerId: string,
  owner: string,
  errorCode: string,
) {
  const now = new Date().toISOString();
  const { error } = await admin.from("account_connections").upsert({
    ledger_id: ledgerId,
    owner,
    provider: "discord",
    provider_subject: "",
    granted_scopes: [],
    connection_state: "disconnected",
    verification_method: "",
    error_code: errorCode.slice(0, 120),
    last_checked_at: now,
    updated_at: now,
  }, { onConflict: "ledger_id" });
  return !error;
}

async function claimOperation(
  ledgerId: string,
  owner: string,
  operation: "connect" | "disconnect",
) {
  const leaseId = crypto.randomUUID();
  const { data, error } = await admin.rpc("claim_discord_operation_service", {
    p_ledger_id: ledgerId,
    p_owner: owner,
    p_lease_id: leaseId,
    p_operation_kind: operation,
    p_ttl_seconds: 180,
  });
  return { leaseId, claimed: !error && data === true, error };
}

async function releaseOperation(
  ledgerId: string,
  owner: string,
  leaseId: string,
) {
  const { data, error } = await admin.rpc("release_discord_operation_service", {
    p_ledger_id: ledgerId,
    p_owner: owner,
    p_lease_id: leaseId,
  });
  return !error && data === true;
}

async function deleteProviderWebhook(webhookId: string, token: string) {
  if (!SNOWFLAKE.test(webhookId) || !WEBHOOK_TOKEN.test(token)) return false;
  try {
    const response = await fetch(`${API_BASE}/webhooks/${webhookId}/${token}`, {
      method: "DELETE",
      redirect: "error",
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });
    return response.status === 204 || response.status === 404;
  } catch {
    return false;
  }
}

async function revokeProviderGrant(refreshToken: string, accessToken: string) {
  if (!configured()) return false;
  const token = refreshToken || accessToken;
  if (!token || token.length > 16_384) return false;
  try {
    const response = await fetch(`${API_BASE}/oauth2/token/revoke`, {
      method: "POST",
      headers: {
        "Authorization": basicAuth(),
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "application/json",
      },
      body: new URLSearchParams({
        token,
        token_type_hint: refreshToken ? "refresh_token" : "access_token",
      }),
      redirect: "error",
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function cleanIssuedGrant(
  webhook: DiscordWebhook,
  refreshToken: string,
  accessToken: string,
) {
  const webhookDeleted = await deleteProviderWebhook(webhook.id, webhook.token);
  const grantRevoked = await revokeProviderGrant(refreshToken, accessToken);
  return webhookDeleted && grantRevoked;
}

async function retainCleanupHold(
  ledgerId: string,
  owner: string,
  leaseId: string,
  webhook: DiscordWebhook,
  accessToken: string,
  refreshToken: string,
  tokenExpiresAt: string,
  errorCode: string,
) {
  if (
    !accessToken || !refreshToken || accessToken.length > 16_384 ||
    refreshToken.length > 16_384
  ) return false;
  const parsedExpiry = Date.parse(tokenExpiresAt);
  const safeExpiry = Number.isFinite(parsedExpiry) && parsedExpiry > Date.now()
    ? new Date(parsedExpiry).toISOString()
    : new Date(Date.now() + 5 * 60 * 1000).toISOString();
  try {
    const held = await admin.rpc(
      "discord_store_oauth_cleanup_hold_service",
      {
        p_ledger_id: ledgerId,
        p_owner: owner,
        p_lease_id: leaseId,
        p_guild_id: webhook.guildId,
        p_channel_id: webhook.channelId,
        p_webhook_id: webhook.id,
        p_application_id: webhook.applicationId,
        p_webhook_name: webhook.name,
        p_webhook_url: webhook.url,
        p_webhook_token: webhook.token,
        p_access_token: accessToken,
        p_refresh_token: refreshToken,
        p_token_expires_at: safeExpiry,
        p_error_code: errorCode,
      },
    );
    if (!held.error && held.data) return true;

    // A lost RPC response is not proof the atomic hold failed. Read back only
    // the exact identities; never return any secret to the browser.
    const [readback, connection] = await Promise.all([
      admin.rpc("discord_get_connection_secret_service", {
        p_ledger_id: ledgerId,
        p_owner: owner,
      }),
      admin.from("account_connections")
        .select(
          "provider_subject,connection_state,verification_method,error_code",
        )
        .eq("ledger_id", ledgerId).eq("owner", owner).eq("provider", "discord")
        .maybeSingle(),
    ]);
    const bundle = parseSecretBundle(readback.data);
    return !readback.error && !connection.error && Boolean(bundle) &&
      String(bundle?.webhook_id || "") === webhook.id &&
      String(bundle?.channel_id || "") === webhook.channelId &&
      String(bundle?.guild_id || "") === webhook.guildId &&
      String(bundle?.webhook_url || "") === webhook.url &&
      connection.data?.provider_subject === webhook.channelId &&
      connection.data?.connection_state === "error" &&
      connection.data?.verification_method === "discord_oauth_cleanup_hold" &&
      connection.data?.error_code === errorCode.slice(0, 120);
  } catch {
    return false;
  }
}

async function verifyProviderWebhook(webhook: DiscordWebhook) {
  try {
    const response = await fetch(
      `${API_BASE}/webhooks/${webhook.id}/${webhook.token}`,
      {
        headers: { "Accept": "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
      },
    );
    if (!response.ok) return false;
    const value = await response.json().catch(() => null) as
      | Record<string, unknown>
      | null;
    return Boolean(value) && String(value?.id || "") === webhook.id &&
      String(value?.guild_id || "") === webhook.guildId &&
      String(value?.channel_id || "") === webhook.channelId &&
      String(value?.application_id || "") === webhook.applicationId &&
      Number(value?.type) === 1;
  } catch {
    return false;
  }
}

async function ownedLedger(ledgerId: string, owner: string) {
  const { data, error } = await admin.from("account_ledger")
    .select("id,owner,provider,suspended")
    .eq("id", ledgerId).eq("owner", owner).eq("provider", "discord")
    .maybeSingle();
  return error || !data ? null : data;
}

async function start(origin: string, owner: string, ledgerId: string) {
  if (!configured()) {
    return json(origin, 503, {
      error: "Discord authorization is not configured yet.",
      missingSecrets: ["DISCORD_CLIENT_ID", "DISCORD_CLIENT_SECRET"],
    });
  }
  if (!SAFE_UUID.test(ledgerId)) {
    return json(origin, 400, { error: "A ledger id is required." });
  }
  const ledger = await ownedLedger(ledgerId, owner);
  if (!ledger) {
    return json(origin, 404, {
      error: "Owned Discord account record not found.",
    });
  }
  if (ledger.suspended) {
    return json(origin, 409, {
      error: "Resume this Discord account record before connecting it.",
    });
  }

  const [credential, binding, connection, legacy] = await Promise.all([
    admin.from("discord_credentials").select("ledger_id")
      .eq("ledger_id", ledgerId).eq("owner", owner).maybeSingle(),
    admin.from("discord_channel_bindings").select("ledger_id")
      .eq("ledger_id", ledgerId).eq("owner", owner).maybeSingle(),
    admin.from("account_connections").select("connection_state,error_code")
      .eq("ledger_id", ledgerId).eq("owner", owner).maybeSingle(),
    admin.rpc("discord_get_connection_secret_service", {
      p_ledger_id: ledgerId,
      p_owner: owner,
    }),
  ]);
  if (credential.error || binding.error || connection.error || legacy.error) {
    return json(origin, 503, {
      error:
        "The current Discord connection could not be verified. Nothing was changed.",
    });
  }
  if (
    credential.data || binding.data || legacy.data ||
    ["connected", "error"].includes(
      String(connection.data?.connection_state || ""),
    )
  ) {
    return json(origin, 409, {
      error:
        "Disconnect or finish cleaning up the current Discord connection before authorizing a new channel.",
    });
  }

  const state = randomUrlSafe(32);
  const browserNonce = randomUrlSafe(32);
  const expiresAt = new Date(Date.now() + OAUTH_TTL_MS).toISOString();
  await admin.from("discord_oauth_transactions").delete()
    .lt("expires_at", new Date().toISOString());
  const { error: stateError } = await admin.from("discord_oauth_transactions")
    .upsert({
      state_hash: await sha256Hex(state),
      owner,
      ledger_id: ledgerId,
      browser_nonce_hash: await sha256Hex(browserNonce),
      return_origin: ALLOWED_ORIGINS.has(origin) ? origin : APP_ORIGIN,
      expires_at: expiresAt,
    }, { onConflict: "owner,ledger_id" });
  if (stateError) {
    return json(origin, 500, {
      error:
        "Discord authorization could not be prepared. Apply migration 066 first.",
    });
  }

  const authorization = new URL("https://discord.com/oauth2/authorize");
  authorization.search = new URLSearchParams({
    response_type: "code",
    client_id: DISCORD_CLIENT_ID,
    scope: "webhook.incoming",
    state,
    redirect_uri: CALLBACK_URL,
    prompt: "consent",
  }).toString();
  return json(origin, 200, {
    authorizationUrl: authorization.toString(),
    browserNonce,
    requestedScopes: ["webhook.incoming"],
    channelSelectionRequired: true,
    expiresAt,
  });
}

async function callback(req: Request) {
  const url = new URL(req.url);
  const state = (url.searchParams.get("state") || "").trim();
  const code = (url.searchParams.get("code") || "").trim();
  const providerError = (url.searchParams.get("error") || "").trim();
  if (state.length < 32 || state.length > 512 || code.length > 8192) {
    return redirectToApp({ discord: "error", reason: "invalid_state" });
  }
  const { data, error } = await admin.from("discord_oauth_transactions")
    .select("return_origin")
    .eq("state_hash", await sha256Hex(state))
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();
  const returnOrigin =
    !error && ALLOWED_ORIGINS.has(String(data?.return_origin || ""))
      ? String(data?.return_origin)
      : "";
  if (!returnOrigin) {
    return redirectToApp({ discord: "error", reason: "invalid_state" });
  }
  if (
    (!code && !providerError) ||
    (providerError && providerError !== "access_denied")
  ) {
    return redirectToApp(
      { discord: "error", reason: "oauth_error" },
      returnOrigin,
    );
  }
  return redirectToApp({
    discord: "finish",
    state,
    code,
    provider_error: providerError === "access_denied" ? "access_denied" : "",
  }, returnOrigin);
}

async function complete(
  origin: string,
  owner: string,
  body: RequestBody,
) {
  if (!configured()) {
    return json(origin, 503, {
      error: "Discord authorization is not configured yet.",
    });
  }
  const state = String(body.state || "").trim();
  const code = String(body.code || "").trim();
  const browserNonce = String(body.browserNonce || "").trim();
  const providerError = body.providerError === "access_denied"
    ? "access_denied"
    : body.providerError
    ? "oauth_error"
    : "";
  if (
    state.length < 32 || state.length > 512 ||
    browserNonce.length < 32 || browserNonce.length > 512 ||
    code.length > 8192
  ) {
    return json(origin, 400, {
      error:
        "The Discord authorization expired. Start again in this browser tab.",
    });
  }

  const { data, error } = await admin.rpc("consume_discord_oauth_state", {
    p_state_hash: await sha256Hex(state),
    p_owner: owner,
    p_browser_nonce_hash: await sha256Hex(browserNonce),
  });
  const transaction = Array.isArray(data) ? data[0] : data;
  if (
    error || !transaction ||
    !SAFE_UUID.test(String(transaction.ledger_id || ""))
  ) {
    return json(origin, 400, {
      error:
        "The Discord authorization expired or was opened in a different browser session.",
    });
  }
  const ledgerId = String(transaction.ledger_id);
  if (providerError || !code) {
    await markNoGrantFailure(
      ledgerId,
      owner,
      providerError === "access_denied"
        ? "discord_access_denied"
        : "discord_oauth_error",
    );
    return json(origin, 400, {
      error: providerError === "access_denied"
        ? "Discord authorization was cancelled."
        : "Discord did not return an authorization code.",
    });
  }

  const operation = await claimOperation(ledgerId, owner, "connect");
  if (!operation.claimed) {
    return json(origin, 409, {
      error:
        "Another Discord connection operation is in progress. Wait and try again.",
    });
  }
  let issuedWebhook: DiscordWebhook | null = null;
  let issuedRefreshToken = "";
  let issuedAccessToken = "";
  let issuedExpiresAt = "";
  let connectionStored = false;
  try {
    const ledger = await ownedLedger(ledgerId, owner);
    if (!ledger || ledger.suspended) {
      return json(origin, 409, {
        error: "The Discord account record changed during authorization.",
      });
    }

    let tokenResponse: Response;
    try {
      tokenResponse = await fetch(`${API_BASE}/oauth2/token`, {
        method: "POST",
        headers: {
          "Authorization": basicAuth(),
          "Content-Type": "application/x-www-form-urlencoded",
          "Accept": "application/json",
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: CALLBACK_URL,
        }),
        redirect: "error",
        signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
      });
    } catch {
      await markConnectionError(
        ledgerId,
        owner,
        "discord_oauth_outcome_unknown",
      );
      return json(origin, 502, {
        error:
          "Discord did not confirm whether authorization completed. Check Discord Authorized Apps and Server Integrations before trying again.",
        manualReviewRequired: true,
        authorizedAppsUrl: "https://discord.com/settings/authorized-apps",
      });
    }
    const token = await tokenResponse.json().catch(() => ({})) as Record<
      string,
      unknown
    >;
    if (!tokenResponse.ok) {
      if (
        tokenResponse.status === 408 || tokenResponse.status === 429 ||
        tokenResponse.status >= 500
      ) {
        await markConnectionError(
          ledgerId,
          owner,
          "discord_oauth_outcome_unknown",
        );
        return json(origin, 502, {
          error:
            "Discord did not provide a definitive authorization outcome. Check Authorized Apps and Server Integrations before retrying.",
          manualReviewRequired: true,
          authorizedAppsUrl: "https://discord.com/settings/authorized-apps",
        });
      }
      await markNoGrantFailure(
        ledgerId,
        owner,
        `discord_token_http_${tokenResponse.status}`,
      );
      return json(origin, 400, {
        error: "Discord rejected the authorization-code exchange. Start again.",
      });
    }
    const accessToken = String(token.access_token || "");
    const refreshToken = String(token.refresh_token || "");
    const tokenType = String(token.token_type || "").toLowerCase();
    const scopes = normalizedScopes(token.scope);
    const expiresIn = Number(token.expires_in || 0);
    const webhook = validatedWebhookFromToken(token);
    issuedWebhook = webhook;
    issuedRefreshToken = refreshToken;
    issuedAccessToken = accessToken;
    issuedExpiresAt = Number.isFinite(expiresIn) && expiresIn >= 60 &&
        expiresIn <= 31_536_000
      ? new Date(Date.now() + expiresIn * 1000).toISOString()
      : "";
    if (
      !webhook || !accessToken || !refreshToken || tokenType !== "bearer" ||
      accessToken.length > 16_384 || refreshToken.length > 16_384 ||
      scopes.length !== 1 || scopes[0] !== "webhook.incoming" ||
      !Number.isFinite(expiresIn) || expiresIn < 60 || expiresIn > 31_536_000
    ) {
      const webhookDeleted = webhook
        ? await deleteProviderWebhook(webhook.id, webhook.token)
        : false;
      const grantRevoked = accessToken || refreshToken
        ? await revokeProviderGrant(refreshToken, accessToken)
        : false;
      const cleaned = webhookDeleted && grantRevoked;
      const retained = !cleaned && webhook
        ? await retainCleanupHold(
          ledgerId,
          owner,
          operation.leaseId,
          webhook,
          accessToken,
          refreshToken,
          issuedExpiresAt,
          "discord_cleanup_required",
        )
        : false;
      if (cleaned) {
        await markNoGrantFailure(
          ledgerId,
          owner,
          "discord_invalid_token_response",
        );
      } else if (!retained) {
        await markConnectionError(
          ledgerId,
          owner,
          "discord_manual_revoke_required",
        );
      }
      return json(origin, cleaned ? 502 : 409, {
        error: cleaned
          ? "Discord returned an invalid channel authorization. Provider access was removed and nothing was connected."
          : retained
          ? "Discord returned an invalid authorization. Exact cleanup handles were retained securely; use Disconnect to retry provider removal."
          : "Discord returned an invalid authorization and cleanup was not confirmed. Remove MyPersonas from Discord Authorized Apps and Server Integrations.",
        providerCleanupRequired: !cleaned,
        retryDisconnect: retained,
        manualRevocationRequired: !cleaned && !retained,
        authorizedAppsUrl: "https://discord.com/settings/authorized-apps",
      });
    }
    if (!await verifyProviderWebhook(webhook)) {
      const cleaned = await cleanIssuedGrant(
        webhook,
        refreshToken,
        accessToken,
      );
      const retained = !cleaned
        ? await retainCleanupHold(
          ledgerId,
          owner,
          operation.leaseId,
          webhook,
          accessToken,
          refreshToken,
          issuedExpiresAt,
          "discord_cleanup_required",
        )
        : false;
      if (cleaned) {
        await markNoGrantFailure(
          ledgerId,
          owner,
          "discord_webhook_verification_failed",
        );
      } else if (!retained) {
        await markConnectionError(
          ledgerId,
          owner,
          "discord_manual_revoke_required",
        );
      }
      return json(origin, cleaned ? 502 : 409, {
        error: cleaned
          ? "Discord did not verify the selected channel webhook. Nothing was connected."
          : retained
          ? "Discord verification failed. Exact cleanup handles were retained securely; use Disconnect to retry provider removal."
          : "Discord verification failed and provider cleanup was not confirmed. Delete the MyPersonas webhook in Server Settings and revoke MyPersonas in Authorized Apps.",
        providerCleanupRequired: !cleaned,
        retryDisconnect: retained,
        manualRevocationRequired: !cleaned && !retained,
        authorizedAppsUrl: "https://discord.com/settings/authorized-apps",
      });
    }

    const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
    const storeArgs = {
      p_ledger_id: ledgerId,
      p_owner: owner,
      p_lease_id: operation.leaseId,
      p_guild_id: webhook.guildId,
      p_channel_id: webhook.channelId,
      p_webhook_id: webhook.id,
      p_application_id: webhook.applicationId,
      p_webhook_name: webhook.name,
      p_webhook_url: webhook.url,
      p_webhook_token: webhook.token,
      p_access_token: accessToken,
      p_refresh_token: refreshToken,
      p_token_expires_at: expiresAt,
      p_scopes: scopes,
    };
    const stored = await admin.rpc(
      "discord_store_oauth_connection_service",
      storeArgs,
    );
    if (stored.error || !stored.data) {
      const readback = await admin.rpc(
        "discord_get_connection_secret_service",
        {
          p_ledger_id: ledgerId,
          p_owner: owner,
        },
      );
      const bundle = parseSecretBundle(readback.data);
      const saved = !readback.error && bundle &&
        String(bundle.webhook_id || "") === webhook.id &&
        String(bundle.channel_id || "") === webhook.channelId &&
        String(bundle.guild_id || "") === webhook.guildId &&
        String(bundle.webhook_url || "") === webhook.url;
      if (!saved) {
        const cleaned = await cleanIssuedGrant(
          webhook,
          refreshToken,
          accessToken,
        );
        const retained = !cleaned
          ? await retainCleanupHold(
            ledgerId,
            owner,
            operation.leaseId,
            webhook,
            accessToken,
            refreshToken,
            expiresAt,
            "discord_cleanup_required",
          )
          : false;
        if (cleaned) {
          await markNoGrantFailure(
            ledgerId,
            owner,
            "discord_secure_storage_failed",
          );
        } else if (!retained) {
          await markConnectionError(
            ledgerId,
            owner,
            "discord_manual_revoke_required",
          );
        }
        return json(origin, cleaned ? 500 : 409, {
          error: cleaned
            ? "Discord access was cleaned up because secure storage failed. Apply migration 066 and try again."
            : retained
            ? "The initial connection write failed, but exact cleanup handles were retained securely. Use Disconnect before retrying."
            : "Secure storage failed and provider cleanup was not confirmed. Delete the webhook and revoke MyPersonas in Discord before retrying.",
          providerCleanupRequired: !cleaned,
          retryDisconnect: retained,
          manualRevocationRequired: !cleaned && !retained,
          authorizedAppsUrl: "https://discord.com/settings/authorized-apps",
        });
      }
    }
    connectionStored = true;
    return json(origin, 200, {
      connected: true,
      ledgerId,
      guildId: webhook.guildId,
      channelId: webhook.channelId,
      webhookId: webhook.id,
      webhookName: webhook.name,
      grantedScopes: ["webhook.incoming"],
      scheduledPublishingEnabled: false,
    });
  } catch {
    let cleaned = false;
    let retained = false;
    if (issuedWebhook && !connectionStored) {
      cleaned = await cleanIssuedGrant(
        issuedWebhook,
        issuedRefreshToken,
        issuedAccessToken,
      );
      if (!cleaned) {
        retained = await retainCleanupHold(
          ledgerId,
          owner,
          operation.leaseId,
          issuedWebhook,
          issuedAccessToken,
          issuedRefreshToken,
          issuedExpiresAt,
          "discord_cleanup_required",
        );
      }
    }
    if (cleaned) {
      await markNoGrantFailure(
        ledgerId,
        owner,
        "discord_authorization_internal_failure",
      );
    } else if (!retained) {
      await markConnectionError(
        ledgerId,
        owner,
        "discord_manual_revoke_required",
      );
    }
    return json(origin, cleaned ? 500 : 409, {
      error: cleaned
        ? "Discord provider access was removed after an internal connection failure. Nothing was connected."
        : retained
        ? "Discord authorization ended in an unsafe state. Exact cleanup handles were retained securely; use Disconnect before retrying."
        : "Discord authorization ended in an unsafe unknown state. Review Authorized Apps and Server Integrations before retrying.",
      providerCleanupRequired: !cleaned,
      retryDisconnect: retained,
      manualRevocationRequired: !cleaned && !retained,
      authorizedAppsUrl: "https://discord.com/settings/authorized-apps",
    });
  } finally {
    const released = await releaseOperation(ledgerId, owner, operation.leaseId);
    if (!released) {
      console.error(
        "Discord connect lease release could not be verified",
        ledgerId,
      );
    }
  }
}

async function disconnect(origin: string, owner: string, ledgerId: string) {
  if (!SAFE_UUID.test(ledgerId)) {
    return json(origin, 400, { error: "A ledger id is required." });
  }
  const ledger = await ownedLedger(ledgerId, owner);
  if (!ledger) {
    return json(origin, 404, {
      error: "Owned Discord account record not found.",
    });
  }
  const operation = await claimOperation(ledgerId, owner, "disconnect");
  if (!operation.claimed) {
    return json(origin, 409, {
      error:
        "Another Discord operation or unresolved publish is blocking disconnect.",
    });
  }
  try {
    const { data, error } = await admin.rpc(
      "discord_get_connection_secret_service",
      {
        p_ledger_id: ledgerId,
        p_owner: owner,
      },
    );
    if (error) {
      return json(origin, 503, {
        error:
          "Stored Discord access could not be inspected. Nothing was disconnected.",
      });
    }
    const bundle = parseSecretBundle(data);
    if (!bundle) {
      const [connection, binding, credential] = await Promise.all([
        admin.from("account_connections").select("connection_state")
          .eq("ledger_id", ledgerId).eq("owner", owner).eq(
            "provider",
            "discord",
          )
          .maybeSingle(),
        admin.from("discord_channel_bindings").select("ledger_id")
          .eq("ledger_id", ledgerId).eq("owner", owner).maybeSingle(),
        admin.from("discord_credentials").select("ledger_id")
          .eq("ledger_id", ledgerId).eq("owner", owner).maybeSingle(),
      ]);
      if (connection.error || binding.error || credential.error) {
        return json(origin, 503, {
          error:
            "The complete Discord revocation state could not be inspected. Nothing was disconnected.",
        });
      }
      if (
        binding.data || credential.data ||
        ["connected", "error"].includes(
          String(connection.data?.connection_state || ""),
        )
      ) {
        await markConnectionError(
          ledgerId,
          owner,
          "discord_manual_revoke_required",
        );
        return json(origin, 409, {
          error:
            "The local record indicates prior Discord access but no safe revocation handle remains. Remove MyPersonas in Discord Authorized Apps and Server Integrations before local cleanup.",
          manualRevocationRequired: true,
          authorizedAppsUrl: "https://discord.com/settings/authorized-apps",
        });
      }
      await admin.from("discord_oauth_transactions").delete()
        .eq("owner", owner).eq("ledger_id", ledgerId);
      return json(origin, 200, { disconnected: true, noStoredGrant: true });
    }
    const webhookId = String(bundle.webhook_id || "");
    const webhookToken = String(bundle.webhook_token || "");
    const webhookUrl = String(bundle.webhook_url || "");
    const accessToken = String(bundle.access_token || "");
    const refreshToken = String(bundle.refresh_token || "");
    const legacy = bundle.legacy === true;
    if (
      !SNOWFLAKE.test(webhookId) || !WEBHOOK_TOKEN.test(webhookToken) ||
      (webhookUrl !== exactWebhookUrl(webhookId, webhookToken) &&
        !/^https:\/\/(discord\.com|discordapp\.com)\/api(?:\/v[0-9]+)?\/webhooks\//
          .test(webhookUrl))
    ) {
      await markConnectionError(
        ledgerId,
        owner,
        "discord_manual_revoke_required",
      );
      return json(origin, 409, {
        error:
          "Stored Discord webhook identity is invalid. Remove it manually in Server Settings before local cleanup.",
        manualRevocationRequired: true,
      });
    }
    if (!legacy && (!configured() || !refreshToken || !accessToken)) {
      return json(origin, 409, {
        error:
          "Discord app credentials and the stored OAuth grant are required before safe disconnect. Nothing was erased.",
      });
    }
    if (!await deleteProviderWebhook(webhookId, webhookToken)) {
      await markConnectionError(
        ledgerId,
        owner,
        "discord_webhook_delete_unconfirmed",
      );
      return json(origin, 502, {
        error:
          "Discord did not confirm deletion of the exact channel webhook. Local access was retained; retry before deleting the account record.",
      });
    }
    if (!legacy && !await revokeProviderGrant(refreshToken, accessToken)) {
      await markConnectionError(
        ledgerId,
        owner,
        "discord_oauth_revoke_unconfirmed",
      );
      return json(origin, 502, {
        error:
          "The webhook was deleted, but Discord did not confirm OAuth revocation. Local revocation handles were retained; retry.",
      });
    }
    const cleared = await admin.rpc("discord_clear_connection_service", {
      p_ledger_id: ledgerId,
      p_owner: owner,
      p_lease_id: operation.leaseId,
    });
    if (cleared.error || cleared.data !== true) {
      return json(origin, 500, {
        error:
          "Discord provider access was removed, but local Vault cleanup could not be verified. Retry disconnect.",
      });
    }
    await admin.from("discord_oauth_transactions").delete()
      .eq("owner", owner).eq("ledger_id", ledgerId);
    return json(origin, 200, {
      disconnected: true,
      providerWebhookDeleted: true,
      providerGrantRevoked: !legacy,
      legacyWebhookRemoved: legacy,
    });
  } finally {
    if (!await releaseOperation(ledgerId, owner, operation.leaseId)) {
      console.error(
        "Discord disconnect lease release could not be verified",
        ledgerId,
      );
    }
  }
}

serve(async (req: Request) => {
  const origin = req.headers.get("Origin") || "";
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }
  if (req.method === "GET") return await callback(req);
  if (req.method !== "POST") return json(origin, 405, { error: "POST only" });

  let body: RequestBody;
  try {
    body = await req.json();
  } catch {
    return json(origin, 400, { error: "Invalid request body" });
  }
  const action = String(body.action || "");
  if (action === "capabilities") {
    return json(origin, 200, {
      configured: configured(),
      authenticationEnabled: configured(),
      postingEnabled: configured(),
      callbackUrl: CALLBACK_URL,
      requiredScopes: ["webhook.incoming"],
      scheduledPublishingEnabled: false,
      missingSecrets: configured()
        ? []
        : ["DISCORD_CLIENT_ID", "DISCORD_CLIENT_SECRET"],
    });
  }

  const authClient = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const guard = await requireAal2(req, authClient);
  if (!guard.ok) {
    return json(origin, guard.status, { error: guard.error, code: guard.code });
  }
  const owner = guard.user.id;
  if (action === "start") {
    return await start(origin, owner, String(body.ledgerId || ""));
  }
  if (action === "complete") return await complete(origin, owner, body);
  if (action === "disconnect") {
    return await disconnect(origin, owner, String(body.ledgerId || ""));
  }
  return json(origin, 400, { error: "Unknown action" });
});
