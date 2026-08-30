// Wix app-install connector for draft-only Wix Blog access.
//
// Wix's current app OAuth model uses a signed app instance plus short-lived
// client-credentials access tokens; it is not an authorization-code/refresh-
// token flow. Start requires an owner JWT + AAL2. The launch ticket is put in
// an HttpOnly same-site cookie before Wix installation so the fixed post-
// installation callback can be correlated without putting a Supabase JWT in a
// URL. Only the verified instance ID is persisted, inside Supabase Vault.
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { requireAal2 } from "../_shared/aal2.ts";
import { loadCmsAppSecret, sha256Hex } from "../_shared/cms-drafts.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const APP_ID = Deno.env.get("WIX_APP_ID") || "";
const SHARE_URL_ID = Deno.env.get("WIX_SHARE_URL_ID") || "";
const CALLBACK_URL = Deno.env.get("WIX_POST_INSTALL_URI") ||
  "https://nwsqyuucwzihruszocge.supabase.co/functions/v1/wix-oauth";
const APP_ORIGIN = Deno.env.get("WIX_OAUTH_APP_ORIGIN") ||
  "https://mypersonas.online";
const TOKEN_URL = "https://www.wixapis.com/oauth2/token";
const INSTANCE_URL = "https://www.wixapis.com/apps/v1/instance";
const MEMBERS_URL = "https://www.wixapis.com/members/v1/members?fieldsets=PUBLIC&paging.limit=100";
const BLOG_QUERY_URL = "https://www.wixapis.com/blog/v3/draft-posts/query";
const SAFE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_TOKEN = /^[A-Za-z0-9_-]{32,256}$/;
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
function appRedirect(params: Record<string, string>) {
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
      "Set-Cookie": "mp_wix_install=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax",
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
function decodeBase64Url(value: string) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
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
function constantTimeEqual(left: Uint8Array, right: Uint8Array) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}
async function verifySignedInstance(value: string, appSecret: string) {
  if (!appSecret || value.length > 8192) return null;
  const [signaturePart, dataPart, extra] = value.split(".");
  if (!signaturePart || !dataPart || extra) return null;
  let signature: Uint8Array;
  let data: Uint8Array;
  try {
    signature = decodeBase64Url(signaturePart);
    data = decodeBase64Url(dataPart);
  } catch {
    return null;
  }
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(appSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const expected = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(dataPart)),
  );
  if (!constantTimeEqual(signature, expected)) return null;
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(new TextDecoder().decode(data)) as Record<
      string,
      unknown
    >;
  } catch {
    return null;
  }
  const instanceId = String(payload.instanceId || "");
  if (!SAFE_UUID.test(instanceId) || payload.aid) return null;
  const signedAtRaw = payload.signDate;
  const numeric = Number(signedAtRaw);
  const signedAt = Number.isFinite(numeric) && numeric > 0 ? new Date(numeric > 1e12 ? numeric : numeric * 1000).getTime() : new Date(String(signedAtRaw || "")).getTime();
  if (
    !Number.isFinite(signedAt) || Math.abs(Date.now() - signedAt) > 20 * 60_000
  ) return null;
  return { instanceId, payload };
}
async function configured() {
  return Boolean(
    APP_ID && CALLBACK_URL.startsWith("https://") &&
      await loadCmsAppSecret(service, "wix_app_secret"),
  );
}
function installationUrl(ticket: string) {
  const postInstallationUrl = new URL(CALLBACK_URL);
  postInstallationUrl.searchParams.set("ticket", ticket);
  const installer = new URL("https://www.wix.com/app-installer");
  installer.searchParams.set("appId", APP_ID);
  installer.searchParams.set(
    "postInstallationUrl",
    postInstallationUrl.toString(),
  );
  if (SHARE_URL_ID) installer.searchParams.set("shareUrlId", SHARE_URL_ID);
  return installer.toString();
}

async function wixAccessToken(instanceId: string, appSecret: string) {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      grant_type: "client_credentials",
      client_id: APP_ID,
      client_secret: appSecret,
      instance_id: instanceId,
    }),
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
  const outer = await response.json().catch(() => null) as
    | Record<string, unknown>
    | null;
  let payload = outer;
  if (outer && typeof outer.body === "string") {
    try {
      payload = JSON.parse(outer.body) as Record<string, unknown>;
    } catch {
      payload = null;
    }
  }
  const accessToken = String(
    payload?.access_token || payload?.accessToken || "",
  );
  const statusCode = Number(outer?.statusCode || response.status);
  if (
    !response.ok || statusCode >= 400 || !accessToken ||
    accessToken.length > 32768
  ) return "";
  return accessToken;
}

async function wixInstance(accessToken: string) {
  const response = await fetch(INSTANCE_URL, {
    headers: { Authorization: accessToken, Accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
  const payload = await response.json().catch(() => null) as
    | Record<string, unknown>
    | null;
  if (!response.ok || !payload) return null;
  const instance = payload.instance && typeof payload.instance === "object" ? payload.instance as Record<string, unknown> : payload;
  const site = payload.site && typeof payload.site === "object" ? payload.site as Record<string, unknown> : instance.site && typeof instance.site === "object" ? instance.site as Record<string, unknown> : {};
  const siteId = String(site.id || site.siteId || payload.siteId || "");
  if (!SAFE_UUID.test(siteId)) return null;
  const name = String(
    site.displayName || site.name || instance.appName || "Wix site",
  ).slice(0, 200);
  const candidateUrl = String(
    site.url || site.publishedUrl || site.siteUrl || "",
  );
  const siteUrl = /^https:\/\/[^\s]+$/i.test(candidateUrl) ? candidateUrl.replace(/\/+$/, "") : `https://manage.wix.com/dashboard/${siteId}`;
  return { siteId, siteUrl, name };
}

async function credential(ledgerId: string, owner: string) {
  const result = await service.rpc("cms_get_credential_service", {
    p_ledger_id: ledgerId,
    p_owner: owner,
  });
  const row = Array.isArray(result.data) ? result.data[0] : result.data;
  return result.error || !row ? null : row as Record<string, unknown>;
}

async function listMembers(ledgerId: string, owner: string, appSecret: string) {
  const stored = await credential(ledgerId, owner);
  if (!stored) return null;
  const secret = stored?.secret && typeof stored.secret === "object" ? stored.secret as Record<string, unknown> : {};
  const instanceId = String(secret.instance_id || "");
  const siteId = String(stored?.site_id || "");
  if (!SAFE_UUID.test(instanceId) || !SAFE_UUID.test(siteId)) return null;
  const accessToken = await wixAccessToken(instanceId, appSecret);
  if (!accessToken) return null;
  const response = await fetch(MEMBERS_URL, {
    headers: {
      Authorization: accessToken,
      "wix-site-id": siteId,
      Accept: "application/json",
    },
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
  const payload = await response.json().catch(() => null) as
    | Record<string, unknown>
    | null;
  if (!response.ok || !payload) return null;
  const source = Array.isArray(payload.members) ? payload.members : [];
  const members = source.map((item) => {
    const member = item && typeof item === "object" ? item as Record<string, unknown> : {};
    const profile = member.profile && typeof member.profile === "object" ? member.profile as Record<string, unknown> : {};
    const contact = member.contact && typeof member.contact === "object" ? member.contact as Record<string, unknown> : {};
    return {
      id: String(member.id || member._id || ""),
      name: String(
        profile.nickname || profile.title || contact.firstName || "Wix author",
      ).slice(0, 200),
    };
  }).filter((item) => /^[0-9A-Za-z_-]{8,100}$/.test(item.id));
  return { members, stored, accessToken, siteId };
}

// A configured permission and an actually granted permission are not the same
// thing in Wix. Prove the installed instance can perform a Manage Blog read
// before promoting the connection to `connected`; the first write remains the
// separately preview-approved provider Draft.
async function proveManageBlogRead(accessToken: string, siteId: string) {
  const response = await fetch(BLOG_QUERY_URL, {
    method: "POST",
    headers: {
      Authorization: accessToken,
      "wix-site-id": siteId,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ query: { paging: { limit: 1 } } }),
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) return false;
  const payload = await response.json().catch(() => null) as
    | Record<string, unknown>
    | null;
  return Boolean(payload && Array.isArray(payload.draftPosts));
}

async function ownedLedger(ledgerId: string, owner: string) {
  const result = await service.from("account_ledger").select(
    "id,owner,provider,url,suspended",
  )
    .eq("id", ledgerId).eq("owner", owner).eq("provider", "wix").maybeSingle();
  return result.error || !result.data || result.data.suspended ? null : result.data;
}

async function handleGet(req: Request) {
  const url = new URL(req.url);
  const action = url.searchParams.get("action") || "callback";
  if (action === "launch") {
    const ticket = url.searchParams.get("ticket") || "";
    if (!SAFE_TOKEN.test(ticket) || !await configured()) {
      return appRedirect({ wix: "configuration_required" });
    }
    const stateHash = await sha256Hex(ticket);
    const row = await service.from("cms_oauth_transactions")
      .select("state_hash,provider,expires_at,launched_at")
      .eq("state_hash", stateHash).eq("provider", "wix").maybeSingle();
    if (
      row.error || !row.data ||
      new Date(row.data.expires_at).getTime() <= Date.now()
    ) {
      return appRedirect({ wix: "install_expired" });
    }
    const launched = await service.from("cms_oauth_transactions").update({
      launched_at: new Date().toISOString(),
    }).eq("state_hash", stateHash).eq("provider", "wix").is("launched_at", null)
      .select("state_hash").maybeSingle();
    if (launched.error || !launched.data) {
      return appRedirect({ wix: "install_already_started" });
    }
    return new Response(null, {
      status: 302,
      headers: {
        Location: installationUrl(ticket),
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        "Set-Cookie": `mp_wix_install=${encodeURIComponent(ticket)}; Max-Age=600; Path=/; HttpOnly; Secure; SameSite=Lax`,
      },
    });
  }
  const signed = url.searchParams.get("signedInstance") || "";
  const callbackTicket = url.searchParams.get("ticket") || "";
  const ticket = cookieValue(req, "mp_wix_install");
  if (!SAFE_TOKEN.test(ticket) || callbackTicket !== ticket) {
    return appRedirect({ wix: "same_browser_required" });
  }
  const stateHash = await sha256Hex(ticket);
  const appSecret = await loadCmsAppSecret(service, "wix_app_secret");
  const verified = await verifySignedInstance(signed, appSecret);
  if (!verified) return appRedirect({ wix: "invalid_signed_instance" });
  if (
    url.searchParams.get("appId") !== APP_ID ||
    url.searchParams.get("instanceId") !== verified.instanceId
  ) {
    return appRedirect({ wix: "invalid_install_target" });
  }
  const accessToken = await wixAccessToken(verified.instanceId, appSecret);
  const instance = accessToken ? await wixInstance(accessToken) : null;
  if (!instance) return appRedirect({ wix: "instance_verification_failed" });
  if (url.searchParams.get("tenantId") !== instance.siteId) {
    return appRedirect({ wix: "site_verification_failed" });
  }
  // DELETE ... RETURNING is the single-use install-ticket check. A duplicate
  // callback may finish provider readback, but it cannot also mutate the local
  // credential binding.
  const consumed = await service.from("cms_oauth_transactions").delete()
    .eq("state_hash", stateHash).eq("provider", "wix")
    .select("owner,ledger_id,expires_at,launched_at").maybeSingle();
  if (
    consumed.error || !consumed.data || !consumed.data.launched_at ||
    new Date(consumed.data.expires_at).getTime() <= Date.now()
  ) {
    return appRedirect({ wix: "install_expired" });
  }
  const ledger = await ownedLedger(
    consumed.data.ledger_id,
    consumed.data.owner,
  );
  if (!ledger) return appRedirect({ wix: "ledger_changed" });
  const stored = await service.rpc("cms_store_credential_service", {
    p_ledger_id: consumed.data.ledger_id,
    p_owner: consumed.data.owner,
    p_provider: "wix",
    p_provider_mode: "wix_app_instance",
    p_provider_subject: "",
    p_site_id: instance.siteId,
    p_site_url: instance.siteUrl,
    p_site_name: instance.name,
    p_author_id: "",
    p_author_name: "",
    p_secret: {
      instance_id: verified.instanceId,
      stored_at: new Date().toISOString(),
    },
    p_granted_scopes: [],
  });
  if (stored.error) return appRedirect({ wix: "credential_storage_failed" });
  return appRedirect({
    wix: "author_required",
    ledger: consumed.data.ledger_id,
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
    if (new TextEncoder().encode(raw).byteLength > 16_384) {
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
    const isConfigured = await configured();
    const connection = ledgerId
      ? await service.from("account_connections").select(
        "connection_state,error_code,provider_subject,verification_method,granted_scopes",
      ).eq("ledger_id", ledgerId).eq("owner", guard.user.id).eq(
        "provider",
        "wix",
      ).maybeSingle()
      : null;
    return json(origin, 200, {
      configured: isConfigured,
      draftOnly: true,
      publicPublishingEnabled: false,
      requiresAuthorSelection: connection?.data?.error_code === "author_selection_required",
      connection: connection?.data || null,
      installUrl: "",
      unlistedShareLinkConfigured: Boolean(SHARE_URL_ID),
      setupLinks: {
        customApps: "https://manage.wix.com/account/custom-apps",
        permissions: "https://dev.wix.com/docs/build-apps/develop-your-app/app-dashboard/permissions/about-permissions",
        officialInstallHelp: "https://dev.wix.com/docs/build-apps/launch-your-app/app-distribution/install-your-app/set-up-the-external-install-flow",
      },
    });
  }
  if (!SAFE_UUID.test(ledgerId)) {
    return json(origin, 400, { error: "A valid ledgerId is required" });
  }
  const ledger = await ownedLedger(ledgerId, guard.user.id);
  if (!ledger) {
    return json(origin, 404, { error: "Owned Wix ledger entry not found" });
  }
  if (action === "start") {
    if (!await configured()) {
      return json(origin, 503, {
        error: "Wix app credentials and post-install URL are not configured",
      });
    }
    const existing = await service.from("cms_credentials").select(
      "provider_subject",
    )
      .eq("ledger_id", ledgerId).eq("owner", guard.user.id).maybeSingle();
    if (existing.error) {
      return json(origin, 503, {
        error: "The current Wix connection could not be checked",
      });
    }
    if (existing.data) {
      return json(origin, 409, {
        error: "Disconnect the existing Wix authorization before installing or rebinding this account.",
      });
    }
    const ticket = randomToken();
    const stateHash = await sha256Hex(ticket);
    await service.from("cms_oauth_transactions").delete().eq(
      "owner",
      guard.user.id,
    )
      .eq("ledger_id", ledgerId).eq("provider", "wix");
    const stored = await service.from("cms_oauth_transactions").insert({
      state_hash: stateHash,
      owner: guard.user.id,
      ledger_id: ledgerId,
      provider: "wix",
      browser_nonce_hash: stateHash,
      requested_site: String(ledger.url || "").slice(0, 500),
      return_origin: origin,
      expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
    });
    if (stored.error) {
      return json(origin, 503, {
        error: "The Wix install handoff could not be started",
      });
    }
    return json(origin, 200, {
      launchUrl: `${CALLBACK_URL}?action=launch&ticket=${encodeURIComponent(ticket)}`,
      expiresInSeconds: 600,
      nextStep: "Open launchUrl in this browser, choose the Wix site, approve Manage Blog, then return to select the exact author.",
    });
  }
  if (action === "list-authors") {
    const appSecret = await loadCmsAppSecret(service, "wix_app_secret");
    const result = appSecret ? await listMembers(ledgerId, guard.user.id, appSecret) : null;
    if (!result) {
      return json(origin, 409, {
        error: "Wix authors could not be read. Reinstall or reconnect the app.",
      });
    }
    return json(origin, 200, {
      siteId: String(result.stored.site_id || ""),
      siteName: String(result.stored.site_name || ""),
      authors: result.members,
    });
  }
  if (action === "select-author") {
    const memberId = String(body.memberId || "");
    const appSecret = await loadCmsAppSecret(service, "wix_app_secret");
    const result = appSecret ? await listMembers(ledgerId, guard.user.id, appSecret) : null;
    const selected = result?.members.find((member) => member.id === memberId);
    if (!result || !selected) {
      return json(origin, 409, {
        error: "Select an author returned by Wix for this exact site",
      });
    }
    if (!await proveManageBlogRead(result.accessToken, result.siteId)) {
      return json(origin, 409, {
        error: "This Wix installation did not prove Manage Blog access. Add Manage Blog to the released app version, approve the updated permission on this site, then reconnect.",
      });
    }
    const saved = await service.rpc("cms_set_wix_author_service", {
      p_ledger_id: ledgerId,
      p_owner: guard.user.id,
      p_member_id: selected.id,
      p_member_name: selected.name,
    });
    if (saved.error || typeof saved.data !== "string") {
      return json(origin, 503, {
        error: "The Wix author binding could not be saved",
      });
    }
    return json(origin, 200, {
      connected: true,
      exactTargetId: saved.data,
      siteId: String(result.stored.site_id || ""),
      siteName: String(result.stored.site_name || ""),
      author: selected,
      draftOnly: true,
    });
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
        error: activeDrafts.error ? "Active Wix draft safety could not be checked. Nothing was disconnected." : "Move every verified Wix provider draft for this connection to Trash before disconnecting.",
      });
    }
    if (body.confirmLocalDisconnect !== true) {
      return json(origin, 409, {
        confirmationRequired: true,
        error: "Disconnecting MyPersonas does not uninstall the Wix app. Confirm local disconnect, then remove the app in Wix Manage Apps to revoke provider access.",
        providerRevocationUrl: "https://manage.wix.com/account/sites",
      });
    }
    const removed = await service.rpc("cms_delete_credential_service", {
      p_ledger_id: ledgerId,
      p_owner: guard.user.id,
    });
    if (removed.error) {
      return json(origin, 503, {
        error: "The local Wix credential could not be removed",
      });
    }
    return json(origin, 200, {
      disconnectedLocally: true,
      providerRevocationRequired: true,
      providerRevocationUrl: "https://manage.wix.com/account/sites",
    });
  }
  return json(origin, 400, { error: "Unknown action" });
});
