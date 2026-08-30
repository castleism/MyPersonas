// WordPress.com Authorization Code OAuth plus self-hosted Application Password
// connector. WordPress.com does not document PKCE on its production OAuth2
// endpoint, so this implementation uses a hashed single-use state and a
// same-browser HttpOnly cookie. Authorization codes are exchanged only on the
// server and never copied into the MyPersonas URL. The owner must be at AAL2
// immediately before starting the ten-minute flow. Self-hosted credentials are accepted only over public HTTPS,
// verified against /users/me, and stored exclusively in Supabase Vault.
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { requireAal2 } from "../_shared/aal2.ts";
import { loadCmsAppSecret, sha256Hex } from "../_shared/cms-drafts.ts";
import { normalizeWordPressSiteUrl, safeWordPressFetch } from "../_shared/wordpress-safe-url.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const CLIENT_ID = Deno.env.get("WORDPRESS_COM_CLIENT_ID") || "";
const CALLBACK_URL = Deno.env.get("WORDPRESS_COM_REDIRECT_URI") ||
  "https://nwsqyuucwzihruszocge.supabase.co/functions/v1/wordpress-oauth";
const APP_ORIGIN = Deno.env.get("WORDPRESS_OAUTH_APP_ORIGIN") ||
  "https://mypersonas.online";
const AUTH_URL = "https://public-api.wordpress.com/oauth2/authorize";
const TOKEN_URL = "https://public-api.wordpress.com/oauth2/token";
const TOKEN_INFO_URL = "https://public-api.wordpress.com/oauth2/token-info";
const SAFE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_STATE = /^[A-Za-z0-9_-]{32,256}$/;
const SAFE_NUMERIC_ID = /^\d{1,32}$/;
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
    headers: {
      ...cors(origin),
      "Content-Type": "application/json",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
function redirectToApp(params: Record<string, string>) {
  const target = new URL(APP_ORIGIN + "/");
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
      "Set-Cookie": "mp_wordpress_oauth=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax",
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
function randomToken() {
  return base64Url(crypto.getRandomValues(new Uint8Array(32)));
}
function cookieValue(req: Request, name: string) {
  const cookies = req.headers.get("Cookie") || "";
  for (const item of cookies.split(";")) {
    const [key, ...rest] = item.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return "";
}
async function configured() {
  return Boolean(
    CLIENT_ID && CALLBACK_URL.startsWith("https://") &&
      await loadCmsAppSecret(service, "wordpress_com_client_secret"),
  );
}
function authorizationUrl(state: string, blog: string) {
  const url = new URL(AUTH_URL);
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("redirect_uri", CALLBACK_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "posts");
  url.searchParams.set("state", state);
  if (blog) url.searchParams.set("blog", blog);
  return url.toString();
}
function scopes(value: unknown) {
  const source = Array.isArray(value) ? value.join(" ") : String(value || "");
  return [
    ...new Set(
      source.split(/[\s,]+/).map((item) => item.trim()).filter(Boolean),
    ),
  ].sort();
}
function basicAuthorization(username: string, applicationPassword: string) {
  const bytes = new TextEncoder().encode(`${username}:${applicationPassword}`);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `Basic ${btoa(binary)}`;
}

async function ownedLedger(ledgerId: string, owner: string) {
  const result = await service.from("account_ledger").select(
    "id,owner,provider,url,username,login_email,suspended",
  ).eq("id", ledgerId).eq("owner", owner).eq("provider", "wordpress")
    .maybeSingle();
  return result.error || !result.data || result.data.suspended ? null : result.data;
}

async function exchangeCode(code: string, clientSecret: string) {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: clientSecret,
      code,
      grant_type: "authorization_code",
      redirect_uri: CALLBACK_URL,
    }),
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
  const payload = await response.json().catch(() => null) as
    | Record<string, unknown>
    | null;
  if (
    !response.ok || !payload || typeof payload.access_token !== "string" ||
    String(payload.token_type || "").toLowerCase() !== "bearer"
  ) return null;
  return payload;
}

async function wordpressComIdentity(accessToken: string) {
  const infoUrl = new URL(TOKEN_INFO_URL);
  infoUrl.searchParams.set("client_id", CLIENT_ID);
  infoUrl.searchParams.set("token", accessToken);
  const tokenResponse = await fetch(infoUrl, {
    headers: { Accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
  const token = await tokenResponse.json().catch(() => null) as
    | Record<string, unknown>
    | null;
  const siteId = String(token?.blog_id || "");
  const tokenUserId = String(token?.user_id || "");
  const grantedScopes = scopes(token?.scope);
  if (
    !tokenResponse.ok || !token ||
    String(token.client_id || "") !== CLIENT_ID ||
    !SAFE_NUMERIC_ID.test(siteId) || !SAFE_NUMERIC_ID.test(tokenUserId) ||
    !(grantedScopes.includes("posts") || grantedScopes.includes("global"))
  ) return null;
  const [siteResponse, userResponse] = await Promise.all([
    fetch(
      `https://public-api.wordpress.com/rest/v1.1/sites/${encodeURIComponent(siteId)}`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
        },
        redirect: "error",
        signal: AbortSignal.timeout(20_000),
      },
    ),
    fetch(
      `https://public-api.wordpress.com/wp/v2/sites/${encodeURIComponent(siteId)}/users/me?context=edit`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
        },
        redirect: "error",
        signal: AbortSignal.timeout(20_000),
      },
    ),
  ]);
  const site = await siteResponse.json().catch(() => null) as
    | Record<string, unknown>
    | null;
  const user = await userResponse.json().catch(() => null) as
    | Record<string, unknown>
    | null;
  const authorId = String(user?.id || "");
  const capabilities = site?.capabilities && typeof site.capabilities === "object" ? site.capabilities as Record<string, unknown> : {};
  const siteUrlCandidate = String(
    site?.URL || site?.url || site?.jetpack || "",
  );
  const siteUrl = normalizeWordPressSiteUrl(siteUrlCandidate);
  if (
    !siteResponse.ok || !userResponse.ok || !site || !user ||
    !SAFE_NUMERIC_ID.test(authorId) || authorId !== tokenUserId ||
    capabilities.edit_posts !== true || !siteUrl
  ) return null;
  return {
    siteId,
    siteUrl,
    siteName: String(site.name || site.title || new URL(siteUrl).hostname)
      .slice(0, 200),
    authorId,
    authorName: String(
      user.name || user.slug || user.username || `WordPress user ${authorId}`,
    ).slice(0, 200),
    scopes: grantedScopes,
  };
}

async function connectSelfHosted(
  owner: string,
  ledgerId: string,
  siteInput: string,
  username: string,
  applicationPassword: string,
) {
  const siteUrl = normalizeWordPressSiteUrl(siteInput);
  if (
    !siteUrl || username.length < 1 || username.length > 100 ||
    applicationPassword.length < 16 || applicationPassword.length > 256
  ) {
    return {
      error: "Use a public HTTPS WordPress site, username, and dedicated Application Password.",
      status: 400,
    };
  }
  let response: Response;
  try {
    response = await safeWordPressFetch(
      siteUrl,
      "/wp-json/wp/v2/users/me?context=edit",
      {
        headers: {
          Authorization: basicAuthorization(username, applicationPassword),
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(20_000),
      },
    );
  } catch {
    return {
      error: "The WordPress site could not be safely reached over public HTTPS.",
      status: 409,
    };
  }
  const user = await response.json().catch(() => null) as
    | Record<string, unknown>
    | null;
  const authorId = String(user?.id || "");
  const capabilities = user?.capabilities && typeof user.capabilities === "object" ? user.capabilities as Record<string, unknown> : {};
  if (
    !response.ok || !user || !SAFE_NUMERIC_ID.test(authorId) ||
    capabilities.edit_posts !== true
  ) {
    return {
      error: "The Application Password did not verify an author with permission to edit posts.",
      status: 409,
    };
  }
  const siteHash = await sha256Hex(siteUrl);
  const target = `wpself:${siteHash}:${authorId}`;
  const stored = await service.rpc("cms_store_credential_service", {
    p_ledger_id: ledgerId,
    p_owner: owner,
    p_provider: "wordpress",
    p_provider_mode: "wordpress_application_password",
    p_provider_subject: target,
    p_site_id: siteHash,
    p_site_url: siteUrl,
    p_site_name: new URL(siteUrl).hostname,
    p_author_id: authorId,
    p_author_name: String(user.name || user.slug || username).slice(0, 200),
    p_secret: {
      username,
      application_password: applicationPassword,
      stored_at: new Date().toISOString(),
    },
    p_granted_scopes: ["posts", "application-password"],
  });
  if (stored.error) {
    return {
      error: "The verified WordPress credential could not be stored.",
      status: 503,
    };
  }
  return {
    connected: true,
    providerMode: "wordpress_application_password",
    exactTargetId: target,
    siteUrl,
    authorId,
    authorName: String(user.name || user.slug || username).slice(0, 200),
    draftOnly: true,
  };
}

async function handleGet(req: Request) {
  const url = new URL(req.url);
  const action = url.searchParams.get("action") || "callback";
  const clientSecret = await loadCmsAppSecret(
    service,
    "wordpress_com_client_secret",
  );
  if (!CLIENT_ID || !clientSecret || !CALLBACK_URL.startsWith("https://")) {
    return redirectToApp({ wordpress: "configuration_required" });
  }
  if (action === "launch") {
    const state = url.searchParams.get("state") || "";
    if (!SAFE_STATE.test(state)) {
      return redirectToApp({ wordpress: "authorization_expired" });
    }
    const stateHash = await sha256Hex(state);
    const transaction = await service.from("cms_oauth_transactions")
      .select("state_hash,requested_site,expires_at,launched_at")
      .eq("state_hash", stateHash).eq("provider", "wordpress").maybeSingle();
    if (
      transaction.error || !transaction.data || transaction.data.launched_at ||
      new Date(transaction.data.expires_at).getTime() <= Date.now()
    ) {
      return redirectToApp({ wordpress: "authorization_expired" });
    }
    const launched = await service.from("cms_oauth_transactions").update({
      launched_at: new Date().toISOString(),
    }).eq("state_hash", stateHash).eq("provider", "wordpress").is(
      "launched_at",
      null,
    )
      .select("state_hash").maybeSingle();
    if (launched.error || !launched.data) {
      return redirectToApp({ wordpress: "authorization_already_started" });
    }
    return new Response(null, {
      status: 302,
      headers: {
        Location: authorizationUrl(
          state,
          String(transaction.data.requested_site || ""),
        ),
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
        "Set-Cookie": `mp_wordpress_oauth=${encodeURIComponent(state)}; Max-Age=600; Path=/; HttpOnly; Secure; SameSite=Lax`,
      },
    });
  }

  const state = url.searchParams.get("state") || "";
  const code = url.searchParams.get("code") || "";
  const providerError = (url.searchParams.get("error") || "").slice(0, 120);
  const browserState = cookieValue(req, "mp_wordpress_oauth");
  if (
    !SAFE_STATE.test(state) || !SAFE_STATE.test(browserState) ||
    state !== browserState
  ) {
    return redirectToApp({ wordpress: "same_browser_required" });
  }
  const stateHash = await sha256Hex(state);
  // DELETE ... RETURNING is the single-use state check. Concurrent callbacks
  // cannot both pass this point. Any later failure requires a new AAL2 start.
  const transaction = await service.from("cms_oauth_transactions").delete()
    .eq("state_hash", stateHash).eq("provider", "wordpress")
    .select("owner,ledger_id,requested_site,expires_at,launched_at")
    .maybeSingle();
  if (
    transaction.error || !transaction.data || !transaction.data.launched_at ||
    new Date(transaction.data.expires_at).getTime() <= Date.now()
  ) {
    return redirectToApp({ wordpress: "authorization_expired" });
  }
  if (providerError) {
    return redirectToApp({ wordpress: "access_denied", reason: providerError });
  }
  if (code.length < 4 || code.length > 4096) {
    return redirectToApp({ wordpress: "invalid_callback" });
  }
  const ledger = await ownedLedger(
    transaction.data.ledger_id,
    transaction.data.owner,
  );
  if (!ledger) return redirectToApp({ wordpress: "ledger_changed" });
  const token = await exchangeCode(code, clientSecret);
  const identity = token ? await wordpressComIdentity(String(token.access_token)) : null;
  if (!token || !identity) {
    return redirectToApp({ wordpress: "identity_verification_failed" });
  }
  const requestedSite = normalizeWordPressSiteUrl(
    String(transaction.data.requested_site || ""),
  );
  if (requestedSite && identity.siteUrl !== requestedSite) {
    return redirectToApp({ wordpress: "wrong_site_selected" });
  }
  const target = `wpcom:${identity.siteId}:${identity.authorId}`;
  const stored = await service.rpc("cms_store_credential_service", {
    p_ledger_id: transaction.data.ledger_id,
    p_owner: transaction.data.owner,
    p_provider: "wordpress",
    p_provider_mode: "wordpress_com_oauth",
    p_provider_subject: target,
    p_site_id: identity.siteId,
    p_site_url: identity.siteUrl,
    p_site_name: identity.siteName,
    p_author_id: identity.authorId,
    p_author_name: identity.authorName,
    p_secret: {
      access_token: token.access_token,
      token_type: "bearer",
      scope: identity.scopes.join(" "),
      stored_at: new Date().toISOString(),
    },
    p_granted_scopes: identity.scopes,
  });
  if (stored.error) {
    return redirectToApp({ wordpress: "credential_storage_failed" });
  }
  return redirectToApp({
    wordpress: "connected",
    ledger: transaction.data.ledger_id,
  });
}

serve(async (req) => {
  const origin = req.headers.get("Origin") || "";
  if (req.method === "OPTIONS") {
    return ALLOWED_ORIGINS.has(origin) ? new Response(null, { status: 204, headers: cors(origin) }) : new Response(null, { status: 403 });
  }
  if (req.method === "GET") return await handleGet(req);
  if (req.method !== "POST") {
    return json(origin, 405, { error: "GET or POST only" });
  }
  if (!ALLOWED_ORIGINS.has(origin)) {
    return json(origin, 403, { error: "Origin not allowed" });
  }
  const authorization = req.headers.get("Authorization") || "";
  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false },
  });
  const guard = await requireAal2(req, userClient);
  if (!guard.ok) {
    return json(origin, guard.status, { error: guard.error, code: guard.code });
  }
  let body: Record<string, unknown>;
  try {
    const raw = await req.text();
    if (new TextEncoder().encode(raw).byteLength > 32_768) {
      return json(origin, 413, { error: "Request is too large" });
    }
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return json(origin, 400, { error: "Invalid request body" });
  }
  const action = String(body.action || "capabilities");
  const ledgerId = String(body.ledgerId || "");
  if (ledgerId && !SAFE_UUID.test(ledgerId)) {
    return json(origin, 400, { error: "A valid ledgerId is required" });
  }
  if (action === "capabilities") {
    const wordpressComConfigured = await configured();
    const [connection, cms] = ledgerId
      ? await Promise.all([
        service.from("account_connections").select(
          "connection_state,error_code,provider_subject,verification_method,granted_scopes",
        ).eq("ledger_id", ledgerId).eq("owner", guard.user.id).eq(
          "provider",
          "wordpress",
        ).maybeSingle(),
        service.from("cms_credentials").select(
          "provider_mode,site_id,site_url,site_name,author_id,author_name",
        )
          .eq("ledger_id", ledgerId).eq("owner", guard.user.id).maybeSingle(),
      ])
      : [{ data: null }, { data: null }];
    return json(origin, 200, {
      wordpressComConfigured,
      selfHostedAvailable: true,
      draftOnly: true,
      publicPublishingEnabled: false,
      connection: connection.data || null,
      site: cms.data || null,
      setupLinks: {
        wordpressComApps: "https://developer.wordpress.com/apps/",
        wordpressComConnectedApps: "https://wordpress.com/me/security/connected-applications",
        applicationPasswords: "https://developer.wordpress.org/advanced-administration/security/application-passwords/",
      },
    });
  }
  if (!SAFE_UUID.test(ledgerId)) {
    return json(origin, 400, { error: "A valid ledgerId is required" });
  }
  const ledger = await ownedLedger(ledgerId, guard.user.id);
  if (!ledger) {
    return json(origin, 404, {
      error: "Owned WordPress ledger entry not found",
    });
  }
  if (["start", "connect-self-hosted"].includes(action)) {
    const existing = await service.from("cms_credentials").select(
      "provider_subject",
    )
      .eq("ledger_id", ledgerId).eq("owner", guard.user.id).maybeSingle();
    if (existing.error) {
      return json(origin, 503, {
        error: "The current WordPress connection could not be checked",
      });
    }
    if (existing.data) {
      return json(origin, 409, {
        error: "Disconnect the existing WordPress authorization before reconnecting or rebinding this account.",
      });
    }
  }
  if (action === "start") {
    if (!await configured()) {
      return json(origin, 503, {
        error: "WordPress.com OAuth credentials are not configured",
      });
    }
    const state = randomToken();
    const stateHash = await sha256Hex(state);
    // Preserve the normalized full URL, including a subdirectory path. Two
    // WordPress sites may share a hostname, so a hostname-only comparison is
    // not an exact site binding.
    const requestedBlog = normalizeWordPressSiteUrl(String(ledger.url || "")) ||
      "";
    await service.from("cms_oauth_transactions").delete().eq(
      "owner",
      guard.user.id,
    )
      .eq("ledger_id", ledgerId).eq("provider", "wordpress");
    const saved = await service.from("cms_oauth_transactions").insert({
      state_hash: stateHash,
      owner: guard.user.id,
      ledger_id: ledgerId,
      provider: "wordpress",
      browser_nonce_hash: stateHash,
      requested_site: requestedBlog,
      return_origin: origin,
      expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
    });
    if (saved.error) {
      return json(origin, 503, {
        error: "The WordPress.com authorization could not be started",
      });
    }
    return json(origin, 200, {
      launchUrl: `${CALLBACK_URL}?action=launch&state=${encodeURIComponent(state)}`,
      expiresInSeconds: 600,
      pkce: false,
      pkceNote: "WordPress.com's official production OAuth2 documentation does not advertise PKCE; single-use state, a same-browser HttpOnly cookie, AAL2 initiation, and server-side code exchange are enforced.",
      nextStep: "Open launchUrl in this browser and approve the exact WordPress.com site. The callback completes on the server.",
    });
  }
  if (action === "connect-self-hosted") {
    const requestedSite = normalizeWordPressSiteUrl(
      String(body.siteUrl || ledger.url || ""),
    );
    const recordedSite = normalizeWordPressSiteUrl(String(ledger.url || ""));
    if (recordedSite && requestedSite !== recordedSite) {
      return json(origin, 409, {
        error: "The WordPress site differs from this account record. Update the account URL before connecting.",
      });
    }
    const result = await connectSelfHosted(
      guard.user.id,
      ledgerId,
      requestedSite || "",
      String(body.username || ""),
      String(body.applicationPassword || ""),
    );
    if ("error" in result) {
      return json(origin, result.status || 409, { error: result.error });
    }
    return json(origin, 200, result as Record<string, unknown>);
  }
  if (action === "disconnect") {
    const activeDrafts = await service.from("cms_provider_drafts").select(
      "id",
      { count: "exact", head: true },
    )
      .eq("ledger_id", ledgerId).eq("owner", guard.user.id).eq(
        "provider_status",
        "draft",
      );
    if (activeDrafts.error || (activeDrafts.count || 0) > 0) {
      return json(origin, 409, {
        error: activeDrafts.error ? "Active WordPress draft safety could not be checked. Nothing was disconnected." : "Move every verified WordPress provider draft for this connection to Trash before disconnecting.",
      });
    }
    const credentialResult = await service.from("cms_credentials")
      .select("provider_mode,site_url").eq("ledger_id", ledgerId)
      .eq("owner", guard.user.id).maybeSingle();
    if (credentialResult.error || !credentialResult.data) {
      return json(origin, 404, {
        error: "No WordPress credential is connected",
      });
    }
    const providerMode = credentialResult.data.provider_mode;
    const providerRevocationUrl = providerMode === "wordpress_com_oauth" ? "https://wordpress.com/me/security/connected-applications" : `${String(credentialResult.data.site_url).replace(/\/+$/, "")}/wp-admin/profile.php`;
    if (body.confirmLocalDisconnect !== true) {
      return json(origin, 409, {
        confirmationRequired: true,
        error: "Remove the local credential, then revoke the connected app or Application Password at WordPress to end provider access.",
        providerRevocationUrl,
      });
    }
    const removed = await service.rpc("cms_delete_credential_service", {
      p_ledger_id: ledgerId,
      p_owner: guard.user.id,
    });
    if (removed.error) {
      return json(origin, 503, {
        error: "The local WordPress credential could not be removed",
      });
    }
    return json(origin, 200, {
      disconnectedLocally: true,
      providerRevocationRequired: true,
      providerRevocationUrl,
    });
  }
  return json(origin, 400, { error: "Unknown action" });
});
