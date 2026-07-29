// meta-oauth — Facebook Login connection foundation for Facebook Pages and
// Page-linked Instagram professional accounts.
//
// Frontend contract (POST requires a signed-in Supabase bearer token and an
// allowed Origin):
//   { action:"capabilities", ledgerId? }
//   { action:"start" }
//     -> { authorizationUrl, browserNonce }
//   { action:"complete", state, code, browserNonce, providerError? }
//     -> { selectionToken, metaUser, pages[] }
//   { action:"finalize", selectionToken, browserNonce, bindings:[
//       { pageId, facebookLedgerId, instagramLedgerId? }
//     ] }
//   { action:"cancel", selectionToken, browserNonce,
//       manualRevocationAcknowledged? }
//   { action:"cancel_pending", manualRevocationAcknowledged? }
//   { action:"disconnect", ledgerId }
//   { action:"reset", ledgerId, manualRevocationAcknowledged:true }
//
// Meta redirects to GET /meta-oauth. This function validates the hashed state
// record and redirects to the initiating app origin with:
//   meta=finish, state, code, provider_error
//
// "complete" exchanges the code server-side, verifies the immutable Meta user
// id, discovers only Facebook Pages returned by /me/accounts, and detects each
// Page's linked Instagram professional-account id. Provider tokens are placed
// in a short-lived Vault-backed candidate and are never returned to the page.
// "finalize" binds the selected provider ids to owned Facebook/Instagram ledger
// rows and moves the user/Page tokens to durable Vault-backed records.
//
// A Facebook Login grant is shared by all Pages managed through that Meta user.
// Disconnect therefore revokes and removes the complete grant rather than
// pretending that one Page can independently revoke it. If Meta cannot confirm
// revocation, credentials remain encrypted, every connected asset is marked as
// requiring manual revocation, and reset requires explicit acknowledgement.
//
// This connector intentionally requests no write scope, exposes no posting
// action, and reports postingEnabled:false. A future publisher must add scopes,
// approval gates, reconciliation, and live provider tests separately.
//
// Deploy without gateway JWT verification because the provider callback has no
// Supabase Authorization header. Every POST action validates the JWT manually.
// Deploy: supabase functions deploy meta-oauth --no-verify-jwt
// Required secrets: META_APP_ID, META_APP_SECRET
// Optional: META_LOGIN_CONFIG_ID, META_GRAPH_API_VERSION
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const META_APP_ID = Deno.env.get("META_APP_ID") || "";
const META_APP_SECRET = Deno.env.get("META_APP_SECRET") || "";
const META_LOGIN_CONFIG_ID = Deno.env.get("META_LOGIN_CONFIG_ID") || "";
const META_GRAPH_API_VERSION = Deno.env.get("META_GRAPH_API_VERSION") ||
  "v25.0";
const CALLBACK_URL = Deno.env.get("META_OAUTH_REDIRECT_URI") ||
  "https://nwsqyuucwzihruszocge.supabase.co/functions/v1/meta-oauth";
const APP_RETURN_URL = Deno.env.get("META_OAUTH_APP_URL") ||
  "https://mypersonas.online/#/studio";

const REQUIRED_SCOPES = [
  "pages_show_list",
  "pages_read_engagement",
  "instagram_basic",
] as const;
const MAX_DISCOVERED_PAGES = 100;
const MANUAL_REVOCATION_URL =
  "https://www.facebook.com/settings?tab=business_tools";
const ALLOWED_ORIGINS = new Set([
  "https://aliaspaces.com",
  "https://www.aliaspaces.com",
  "https://app.aliaspaces.com",
  "https://mypersonas.online",
]);

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

type OAuthActionBody = {
  action?: string;
  ledgerId?: string;
  state?: string;
  code?: string;
  browserNonce?: string;
  providerError?: string;
  selectionToken?: string;
  bindings?: unknown;
  manualRevocationAcknowledged?: boolean;
};

type OwnedLedger = {
  id: string;
  owner: string;
  provider: string;
};

type MetaIdentity = {
  id: string;
  name: string;
};

type InstagramAsset = {
  id: string;
  username: string;
  name: string;
  account_type: string;
};

type PageAsset = {
  page_id: string;
  page_name: string;
  page_access_token: string;
  page_tasks: string[];
  instagram: InstagramAsset | null;
};

type CandidateCredential = {
  user_access_token: string;
  token_type: "bearer";
  expires_at: string;
  pages: PageAsset[];
};

type CandidateRow = {
  meta_user_id: string;
  meta_user_name: string;
  granted_scopes: string[];
  token_expires_at: string;
  token_bundle: CandidateCredential;
};

type CandidateRevocationRow = {
  selection_hash: string;
  meta_user_id: string;
  revocation_state:
    | "pending"
    | "revoking"
    | "provider_revoked"
    | "manual_required";
  revocation_error_code: string;
  revocation_started_at: string | null;
  token_bundle: CandidateCredential | string;
};

type ClaimedCandidateRow = {
  selection_hash: string;
  meta_user_id: string;
  previous_revocation_state:
    | "pending"
    | "revoking"
    | "provider_revoked"
    | "manual_required";
  token_bundle: CandidateCredential | string;
};

type CleanupHoldRow = {
  error_code: string;
  cleanup_kind: "manual_revoke" | "ownership_investigation";
  meta_user_id: string | null;
};

type Binding = {
  pageId: string;
  facebookLedgerId: string;
  instagramLedgerId?: string;
};

type GrantAssetRow = {
  facebook_ledger_id: string;
  owner: string;
  grant_id: string;
  facebook_page_id: string;
  facebook_page_name: string;
  page_tasks: string[];
  instagram_ledger_id: string | null;
  instagram_business_id: string | null;
  instagram_username: string;
};

class MetaProviderError extends Error {
  ambiguous: boolean;
  providerCode: string;

  constructor(message: string, ambiguous = false, providerCode = "") {
    super(message);
    this.name = "MetaProviderError";
    this.ambiguous = ambiguous;
    this.providerCode = providerCode;
  }
}

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

async function sha256Hex(value: string) {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

async function appSecretProof(accessToken: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(META_APP_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(accessToken),
    ),
  );
  return [...signature].map((byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

function validLedgerId(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    .test(value);
}

function validProviderId(value: unknown) {
  return /^[0-9]{1,64}$/.test(String(value || ""));
}

function credentialsConfigured() {
  return Boolean(META_APP_ID && META_APP_SECRET);
}

function graphBase() {
  return `https://graph.facebook.com/${META_GRAPH_API_VERSION}`;
}

function facebookAuthorizationUrl() {
  return `https://www.facebook.com/${META_GRAPH_API_VERSION}/dialog/oauth`;
}

function normalizeScopes(value: unknown) {
  const values = Array.isArray(value)
    ? value
    : typeof value === "string"
    ? value.split(/[,\s]+/)
    : [];
  return [
    ...new Set(
      values.map((scope) => String(scope || "").trim()).filter(
        (scope) => /^[A-Za-z0-9_.:-]{1,128}$/.test(scope),
      ),
    ),
  ].sort();
}

function hasRequiredScopes(scopes: string[]) {
  const granted = new Set(scopes);
  return REQUIRED_SCOPES.every((scope) => granted.has(scope));
}

function safeExpiry(expiresAtSeconds: unknown, expiresInSeconds?: unknown) {
  const absolute = Number(expiresAtSeconds);
  if (
    Number.isFinite(absolute) &&
    absolute * 1000 > Date.now() + 60_000 &&
    absolute * 1000 < Date.now() + 400 * 24 * 60 * 60 * 1000
  ) {
    return new Date(absolute * 1000).toISOString();
  }
  const relative = Number(expiresInSeconds);
  if (
    Number.isFinite(relative) &&
    relative >= 60 &&
    relative <= 400 * 24 * 60 * 60
  ) {
    return new Date(Date.now() + relative * 1000).toISOString();
  }
  return "";
}

async function caller(req: Request) {
  const authorization = req.headers.get("Authorization") || "";
  if (!/^Bearer\s+\S+$/i.test(authorization)) return null;
  const token = authorization.replace(/^Bearer\s+/i, "");
  const { data, error } = await admin.auth.getUser(token);
  return error ? null : data.user;
}

async function ownedMetaLedger(
  ledgerId: string,
  owner: string,
): Promise<OwnedLedger | null> {
  const { data, error } = await admin.from("account_ledger")
    .select("id,owner,provider")
    .eq("id", ledgerId)
    .eq("owner", owner)
    .in("provider", ["facebook", "instagram"])
    .maybeSingle();
  return error || !data ? null : data as OwnedLedger;
}

async function fetchJson(
  url: URL,
  init: RequestInit = {},
  timeoutMs = 15_000,
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      redirect: "error",
      signal: controller.signal,
    });
  } catch {
    throw new MetaProviderError(
      "Meta did not confirm the request outcome.",
      true,
    );
  } finally {
    clearTimeout(timer);
  }

  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    // A provider HTML/error response is still handled by status below.
  }
  if (!response.ok) {
    const providerError = payload && typeof payload === "object" &&
        "error" in payload && payload.error &&
        typeof payload.error === "object"
      ? payload.error as Record<string, unknown>
      : {};
    const providerCode = [
      providerError.code,
      providerError.error_subcode,
    ].filter((value) => value !== undefined).join(":");
    throw new MetaProviderError(
      "Meta rejected the request.",
      response.status >= 500 || response.status === 429,
      providerCode,
    );
  }
  return payload;
}

async function graphGet(
  path: string,
  accessToken: string,
  params: Record<string, string> = {},
) {
  const url = new URL(`${graphBase()}${path}`);
  const query = new URLSearchParams(params);
  query.set("appsecret_proof", await appSecretProof(accessToken));
  url.search = query.toString();
  return await fetchJson(url, {
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "Accept": "application/json",
    },
  });
}

async function exchangeAuthorizationCode(code: string) {
  const url = new URL(`${graphBase()}/oauth/access_token`);
  url.search = new URLSearchParams({
    client_id: META_APP_ID,
    client_secret: META_APP_SECRET,
    redirect_uri: CALLBACK_URL,
    code,
  }).toString();
  const payload = await fetchJson(url);
  if (
    !payload || typeof payload !== "object" ||
    typeof (payload as Record<string, unknown>).access_token !== "string"
  ) {
    throw new MetaProviderError(
      "Meta returned an invalid authorization response.",
      true,
    );
  }
  return {
    accessToken: String((payload as Record<string, unknown>).access_token),
    expiresIn: (payload as Record<string, unknown>).expires_in,
  };
}

async function exchangeLongLivedToken(shortToken: string) {
  const url = new URL(`${graphBase()}/oauth/access_token`);
  url.search = new URLSearchParams({
    grant_type: "fb_exchange_token",
    client_id: META_APP_ID,
    client_secret: META_APP_SECRET,
    fb_exchange_token: shortToken,
  }).toString();
  const payload = await fetchJson(url);
  if (
    !payload || typeof payload !== "object" ||
    typeof (payload as Record<string, unknown>).access_token !== "string"
  ) {
    throw new MetaProviderError(
      "Meta returned an invalid long-lived token response.",
      true,
    );
  }
  return {
    accessToken: String((payload as Record<string, unknown>).access_token),
    expiresIn: (payload as Record<string, unknown>).expires_in,
  };
}

async function fetchIdentity(accessToken: string): Promise<MetaIdentity> {
  const payload = await graphGet("/me", accessToken, { fields: "id,name" });
  const record = payload && typeof payload === "object"
    ? payload as Record<string, unknown>
    : {};
  if (!validProviderId(record.id)) {
    throw new MetaProviderError("Meta returned an invalid user identity.");
  }
  return {
    id: String(record.id),
    name: typeof record.name === "string"
      ? record.name.trim().slice(0, 255)
      : "",
  };
}

async function debugToken(accessToken: string) {
  const url = new URL(`${graphBase()}/debug_token`);
  url.search = new URLSearchParams({
    input_token: accessToken,
    access_token: `${META_APP_ID}|${META_APP_SECRET}`,
  }).toString();
  const payload = await fetchJson(url);
  const data = payload && typeof payload === "object" &&
      "data" in payload && payload.data && typeof payload.data === "object"
    ? payload.data as Record<string, unknown>
    : {};
  if (
    data.is_valid !== true ||
    String(data.app_id || "") !== META_APP_ID ||
    !validProviderId(data.user_id)
  ) {
    throw new MetaProviderError(
      "Meta did not validate this token for the configured app.",
    );
  }
  return {
    userId: String(data.user_id),
    scopes: normalizeScopes(data.scopes),
    expiresAt: safeExpiry(data.expires_at),
  };
}

async function fetchGrantedScopes(accessToken: string) {
  const payload = await graphGet("/me/permissions", accessToken);
  const rows = payload && typeof payload === "object" &&
      "data" in payload && Array.isArray(payload.data)
    ? payload.data
    : [];
  return normalizeScopes(
    rows.filter((row) =>
      row && typeof row === "object" &&
      String((row as Record<string, unknown>).status || "") === "granted"
    ).map((row) => (row as Record<string, unknown>).permission),
  );
}

async function discoverInstagram(
  instagramId: string,
  pageToken: string,
): Promise<InstagramAsset> {
  const payload = await graphGet(`/${instagramId}`, pageToken, {
    fields: "id,username,name,account_type",
  });
  const record = payload && typeof payload === "object"
    ? payload as Record<string, unknown>
    : {};
  if (!validProviderId(record.id) || String(record.id) !== instagramId) {
    throw new MetaProviderError(
      "Meta returned an invalid linked Instagram identity.",
    );
  }
  return {
    id: instagramId,
    username: typeof record.username === "string"
      ? record.username.trim().slice(0, 255)
      : "",
    name: typeof record.name === "string"
      ? record.name.trim().slice(0, 255)
      : "",
    account_type: typeof record.account_type === "string"
      ? record.account_type.trim().slice(0, 64)
      : "",
  };
}

async function discoverPages(userAccessToken: string): Promise<PageAsset[]> {
  const discovered: PageAsset[] = [];
  const seen = new Set<string>();
  let after = "";

  while (true) {
    const params: Record<string, string> = {
      fields: "id,name,access_token,tasks,instagram_business_account",
      limit: "100",
    };
    if (after) params.after = after;
    const payload = await graphGet("/me/accounts", userAccessToken, params);
    const record = payload && typeof payload === "object"
      ? payload as Record<string, unknown>
      : {};
    const rows = Array.isArray(record.data) ? record.data : [];

    for (const row of rows) {
      const page = row && typeof row === "object"
        ? row as Record<string, unknown>
        : {};
      const pageId = String(page.id || "");
      const pageToken = typeof page.access_token === "string"
        ? page.access_token.trim()
        : "";
      if (
        !validProviderId(pageId) ||
        !pageToken ||
        pageToken.length > 16_384 ||
        seen.has(pageId)
      ) {
        if (seen.has(pageId)) continue;
        throw new MetaProviderError(
          "Meta returned an invalid Facebook Page credential.",
        );
      }
      if (discovered.length >= MAX_DISCOVERED_PAGES) {
        throw new MetaProviderError(
          `This connector currently supports at most ${MAX_DISCOVERED_PAGES} Pages per Meta authorization.`,
        );
      }
      seen.add(pageId);

      const linked = page.instagram_business_account &&
          typeof page.instagram_business_account === "object"
        ? page.instagram_business_account as Record<string, unknown>
        : null;
      const instagramId = linked && validProviderId(linked.id)
        ? String(linked.id)
        : "";
      const instagram = instagramId
        ? await discoverInstagram(instagramId, pageToken)
        : null;
      discovered.push({
        page_id: pageId,
        page_name: typeof page.name === "string"
          ? page.name.trim().slice(0, 255)
          : "",
        page_access_token: pageToken,
        page_tasks: normalizeScopes(page.tasks).slice(0, 32),
        instagram,
      });
    }

    const paging = record.paging && typeof record.paging === "object"
      ? record.paging as Record<string, unknown>
      : {};
    const cursors = paging.cursors && typeof paging.cursors === "object"
      ? paging.cursors as Record<string, unknown>
      : {};
    const nextAfter = typeof cursors.after === "string"
      ? cursors.after.trim()
      : "";
    if (!nextAfter || nextAfter === after || !paging.next) break;
    if (discovered.length >= MAX_DISCOVERED_PAGES) {
      throw new MetaProviderError(
        `This connector currently supports at most ${MAX_DISCOVERED_PAGES} Pages per Meta authorization.`,
      );
    }
    after = nextAfter;
  }
  return discovered;
}

async function revokeMetaPermissions(
  metaUserId: string,
  accessToken: string,
) {
  const url = new URL(`${graphBase()}/${metaUserId}/permissions`);
  url.searchParams.set(
    "appsecret_proof",
    await appSecretProof(accessToken),
  );
  let payload: unknown;
  try {
    payload = await fetchJson(url, {
      method: "DELETE",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Accept": "application/json",
      },
    });
  } catch {
    return false;
  }
  return payload === true ||
    Boolean(
      payload && typeof payload === "object" &&
        (payload as Record<string, unknown>).success === true,
    );
}

function sanitizePages(
  pages: PageAsset[],
  existingAssets: GrantAssetRow[] = [],
) {
  const existingByPage = new Map(
    existingAssets.map((asset) => [asset.facebook_page_id, asset]),
  );
  return pages.map((page) => {
    const existing = existingByPage.get(page.page_id);
    return {
      pageId: page.page_id,
      pageName: page.page_name,
      tasks: page.page_tasks,
      linkedInstagram: page.instagram
        ? {
          id: page.instagram.id,
          username: page.instagram.username,
          name: page.instagram.name,
          accountType: page.instagram.account_type,
        }
        : null,
      connectedFacebookLedgerId: existing?.facebook_ledger_id || null,
      connectedInstagramLedgerId: existing?.instagram_ledger_id || null,
    };
  });
}

function parseBindings(value: unknown): Binding[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 50) {
    return null;
  }
  const result: Binding[] = [];
  const pages = new Set<string>();
  const ledgers = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== "object") return null;
    const record = item as Record<string, unknown>;
    const pageId = String(record.pageId || "").trim();
    const facebookLedgerId = String(record.facebookLedgerId || "").trim();
    const instagramLedgerId = String(record.instagramLedgerId || "").trim();
    if (
      !validProviderId(pageId) ||
      !validLedgerId(facebookLedgerId) ||
      (instagramLedgerId && !validLedgerId(instagramLedgerId)) ||
      pages.has(pageId) ||
      ledgers.has(facebookLedgerId) ||
      (instagramLedgerId && ledgers.has(instagramLedgerId)) ||
      instagramLedgerId === facebookLedgerId
    ) {
      return null;
    }
    pages.add(pageId);
    ledgers.add(facebookLedgerId);
    if (instagramLedgerId) ledgers.add(instagramLedgerId);
    result.push({
      pageId,
      facebookLedgerId,
      ...(instagramLedgerId ? { instagramLedgerId } : {}),
    });
  }
  return result;
}

async function getGrantAssets(grantId: string, owner: string) {
  const { data, error } = await admin.from("meta_page_connections")
    .select(
      "facebook_ledger_id,owner,grant_id,facebook_page_id,facebook_page_name,page_tasks,instagram_ledger_id,instagram_business_id,instagram_username",
    )
    .eq("grant_id", grantId)
    .eq("owner", owner)
    .order("created_at", { ascending: true });
  if (error) throw new Error("Could not inspect existing Meta assets.");
  return (data || []) as GrantAssetRow[];
}

async function findAssetForLedger(ledgerId: string, owner: string) {
  const { data, error } = await admin.from("meta_page_connections")
    .select(
      "facebook_ledger_id,owner,grant_id,facebook_page_id,facebook_page_name,page_tasks,instagram_ledger_id,instagram_business_id,instagram_username",
    )
    .eq("owner", owner)
    .or(
      `facebook_ledger_id.eq.${ledgerId},instagram_ledger_id.eq.${ledgerId}`,
    )
    .maybeSingle();
  if (error) throw new Error("Could not inspect the Meta connection.");
  return data as GrantAssetRow | null;
}

async function grantRecordedCleanupState(grantId: string, owner: string) {
  const assets = await getGrantAssets(grantId, owner);
  const ledgerIds = [
    ...new Set(
      assets.flatMap((asset) => [
        asset.facebook_ledger_id,
        asset.instagram_ledger_id,
      ]).filter((value): value is string => Boolean(value)),
    ),
  ];
  if (!ledgerIds.length) return "active";
  const { data, error } = await admin.from("account_connections")
    .select("error_code")
    .eq("owner", owner)
    .in("ledger_id", ledgerIds);
  if (error) throw new Error("Could not inspect Meta cleanup state.");
  const errors = new Set(
    (data || []).map((row) => String(row.error_code || "")),
  );
  if (errors.has("meta_provider_revoked_local_cleanup_failed")) {
    return "provider_revoked";
  }
  if (errors.has("meta_manual_revoke_required")) return "manual_required";
  return "active";
}

async function markGrantError(
  grantId: string,
  owner: string,
  errorCode: string,
) {
  const { error } = await admin.rpc("meta_mark_grant_error", {
    p_grant_id: grantId,
    p_owner: owner,
    p_error_code: errorCode,
  });
  return !error;
}

function candidateTokenBundle(value: CandidateCredential | string | null) {
  let parsed: unknown = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== "object") return null;
  const record = parsed as Record<string, unknown>;
  const userAccessToken = typeof record.user_access_token === "string"
    ? record.user_access_token.trim()
    : "";
  if (!userAccessToken || userAccessToken.length > 16_384) return null;
  return {
    userAccessToken,
  };
}

async function getCandidateForRevocation(
  selectionHash: string,
  owner: string,
  browserNonceHash: string | null,
) {
  const { data, error } = await admin.rpc(
    "meta_get_oauth_candidate_for_revocation",
    {
      p_selection_hash: selectionHash,
      p_owner: owner,
      p_browser_nonce_hash: browserNonceHash,
    },
  );
  const candidate = Array.isArray(data)
    ? data[0] as CandidateRevocationRow | undefined
    : undefined;
  return { candidate, error };
}

async function markCandidateManualRevocation(
  selectionHash: string,
  owner: string,
  errorCode: string,
) {
  const { data, error } = await admin.rpc(
    "meta_mark_candidate_manual_revoke",
    {
      p_selection_hash: selectionHash,
      p_owner: owner,
      p_error_code: errorCode,
    },
  );
  return !error && data === true;
}

async function markCandidateProviderRevoked(
  selectionHash: string,
  owner: string,
) {
  const { data, error } = await admin.rpc(
    "meta_mark_candidate_provider_revoked",
    {
      p_selection_hash: selectionHash,
      p_owner: owner,
    },
  );
  return !error && data === true;
}

async function deleteCandidate(selectionHash: string, owner: string) {
  const { data, error } = await admin.rpc("meta_delete_oauth_candidate", {
    p_selection_hash: selectionHash,
    p_owner: owner,
  });
  return !error && data === true;
}

async function createCleanupHold(
  owner: string,
  errorCode: string,
  metaUserId: string | null,
  cleanupKind: "manual_revoke" | "ownership_investigation",
  transactionStateHash = "",
  browserNonceHash = "",
) {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const args: Record<string, unknown> = {
      p_owner: owner,
      p_error_code: errorCode,
      p_meta_user_id: metaUserId,
      p_cleanup_kind: cleanupKind,
    };
    if (transactionStateHash && browserNonceHash) {
      args.p_transaction_state_hash = transactionStateHash;
      args.p_browser_nonce_hash = browserNonceHash;
    }
    const { data, error } = await admin.rpc("meta_create_cleanup_hold", args);
    if (!error && typeof data === "string") {
      return { status: data, error: null };
    }
    lastError = error;
  }
  return { status: "", error: lastError };
}

async function deleteCleanupHold(owner: string, hold: CleanupHoldRow) {
  const { data, error } = await admin.rpc("meta_delete_cleanup_hold", {
    p_owner: owner,
    p_cleanup_kind: hold.cleanup_kind,
    p_meta_user_id: hold.meta_user_id,
    p_error_code: hold.error_code,
  });
  return !error && data === true;
}

async function finishOAuthTransaction(
  stateHash: string,
  owner: string,
  browserNonceHash: string,
  resolution: "no_exchange" | "provider_cancelled" | "identity_protected",
) {
  const { data, error } = await admin.rpc("meta_finish_oauth_transaction", {
    p_state_hash: stateHash,
    p_owner: owner,
    p_browser_nonce_hash: browserNonceHash,
    p_resolution: resolution,
    p_selection_hash: null,
  });
  return !error && data === true;
}

async function withGrantLease(
  grantId: string,
  owner: string,
  operation: "connect" | "disconnect" | "reset",
  origin: string,
  work: (leaseId: string) => Promise<Response>,
) {
  const leaseId = crypto.randomUUID();
  const { data: claimed, error } = await admin.rpc(
    "claim_meta_token_operation",
    {
      p_grant_id: grantId,
      p_owner: owner,
      p_lease_id: leaseId,
      p_operation_kind: operation,
      p_ttl_seconds: 120,
    },
  );
  if (error || claimed !== true) {
    return json(
      {
        error:
          "Another Meta connection operation is already running. Please wait a moment and try again.",
      },
      409,
      origin,
    );
  }
  try {
    return await work(leaseId);
  } finally {
    await admin.rpc("release_meta_token_operation", {
      p_grant_id: grantId,
      p_owner: owner,
      p_lease_id: leaseId,
    });
  }
}

async function capabilities(
  req: Request,
  origin: string,
  ledgerIdInput = "",
) {
  const user = await caller(req);
  if (!user) return json({ error: "Invalid or expired session" }, 401, origin);

  const result: Record<string, unknown> = {
    provider: "meta",
    configured: credentialsConfigured(),
    authenticationEnabled: credentialsConfigured(),
    postingEnabled: false,
    facebookProfilesSupported: false,
    facebookPagesSupported: true,
    linkedInstagramProfessionalAccountsSupported: true,
    requiredScopes: [...REQUIRED_SCOPES],
    callbackUrl: CALLBACK_URL,
    graphApiVersion: META_GRAPH_API_VERSION,
    loginConfigurationPresent: Boolean(META_LOGIN_CONFIG_ID),
    refreshSupported: false,
    reauthorizationSupported: true,
    revokeSupported: true,
    disconnectScope: "all_assets_for_meta_user",
    manualRevocationUrl: MANUAL_REVOCATION_URL,
  };
  const [pendingCandidate, cleanupHold, oauthTransaction, erasureLease] =
    await Promise.all([
      admin.from("meta_oauth_candidates")
        .select("revocation_state,expires_at")
        .eq("owner", user.id)
        .maybeSingle(),
      admin.from("meta_oauth_cleanup_holds")
        .select("error_code,cleanup_kind,meta_user_id")
        .eq("owner", user.id)
        .maybeSingle(),
      admin.from("meta_oauth_transactions")
        .select("transaction_state,processing_started_at,expires_at")
        .eq("owner", user.id)
        .maybeSingle(),
      admin.from("meta_owner_erasure_leases")
        .select("expires_at")
        .eq("owner", user.id)
        .gt("expires_at", new Date().toISOString())
        .maybeSingle(),
    ]);
  if (
    pendingCandidate.error || cleanupHold.error || oauthTransaction.error ||
    erasureLease.error
  ) {
    return json(
      { error: "Could not inspect pending Meta authorization cleanup" },
      500,
      origin,
    );
  }
  const processing = oauthTransaction.data?.transaction_state === "processing";
  result.pendingAuthorizationCleanupRequired = Boolean(
    pendingCandidate.data || cleanupHold.data || processing,
  );
  result.pendingAuthorizationExpired = Boolean(
    pendingCandidate.data &&
      new Date(pendingCandidate.data.expires_at).getTime() <= Date.now(),
  );
  result.pendingAuthorizationManualRevocationRequired =
    pendingCandidate.data?.revocation_state === "manual_required" ||
    cleanupHold.data?.cleanup_kind === "manual_revoke";
  result.pendingAuthorizationProviderRevoked =
    pendingCandidate.data?.revocation_state === "provider_revoked";
  result.pendingAuthorizationAmbiguousExchange = Boolean(
    cleanupHold.data || processing,
  );
  result.ownershipInvestigationRequired =
    cleanupHold.data?.cleanup_kind === "ownership_investigation" || processing;
  result.doNotRevokeProvider =
    cleanupHold.data?.cleanup_kind === "ownership_investigation" || processing;
  result.manualRevocationRequired =
    pendingCandidate.data?.revocation_state === "manual_required" ||
    cleanupHold.data?.cleanup_kind === "manual_revoke";
  result.manualRevocationSafe =
    pendingCandidate.data?.revocation_state === "manual_required" ||
    cleanupHold.data?.cleanup_kind === "manual_revoke";
  result.authorizationInProgress = Boolean(oauthTransaction.data);
  result.authorizationProcessing = processing;
  result.erasureInProgress = Boolean(erasureLease.data);

  const ledgerId = ledgerIdInput.trim();
  if (!ledgerId) return json(result, 200, origin);
  if (!validLedgerId(ledgerId)) {
    return json({ error: "Invalid account id" }, 400, origin);
  }
  const ledger = await ownedMetaLedger(ledgerId, user.id);
  if (!ledger) {
    return json(
      { error: "Owned Facebook or Instagram account record not found" },
      404,
      origin,
    );
  }

  const connectionResult = await admin.from("account_connections")
    .select("connection_state,error_code,expires_at,provider_subject")
    .eq("ledger_id", ledger.id)
    .eq("owner", ledger.owner)
    .maybeSingle();
  if (connectionResult.error) {
    return json(
      { error: "Could not inspect the Meta connection" },
      500,
      origin,
    );
  }

  let asset: GrantAssetRow | null = null;
  try {
    asset = await findAssetForLedger(ledger.id, ledger.owner);
  } catch {
    return json(
      { error: "Could not inspect the Meta connection" },
      500,
      origin,
    );
  }
  result.ledgerId = ledger.id;
  result.ledgerProvider = ledger.provider;
  result.connectionState = connectionResult.data?.connection_state ||
    "disconnected";
  result.errorCode = connectionResult.data?.error_code || "";
  result.expiresAt = connectionResult.data?.expires_at || null;
  result.providerSubject = connectionResult.data?.provider_subject || "";
  result.credentialPresent = false;
  if (
    connectionResult.data?.connection_state === "error" &&
    connectionResult.data.error_code === "meta_manual_revoke_required"
  ) {
    result.manualRevocationRequired = true;
    result.manualRevocationSafe = true;
  }

  if (asset) {
    const [grantResult, assets] = await Promise.all([
      admin.from("meta_grants")
        .select("id,meta_user_id,meta_user_name,granted_scopes,expires_at")
        .eq("id", asset.grant_id)
        .eq("owner", ledger.owner)
        .maybeSingle(),
      getGrantAssets(asset.grant_id, ledger.owner),
    ]);
    if (grantResult.error || !grantResult.data) {
      return json(
        { error: "Could not inspect the shared Meta grant" },
        500,
        origin,
      );
    }
    result.credentialPresent = true;
    result.grant = {
      id: grantResult.data.id,
      metaUserId: grantResult.data.meta_user_id,
      metaUserName: grantResult.data.meta_user_name,
      grantedScopes: grantResult.data.granted_scopes,
      expiresAt: grantResult.data.expires_at,
      assets: assets.map((item) => ({
        facebookLedgerId: item.facebook_ledger_id,
        facebookPageId: item.facebook_page_id,
        facebookPageName: item.facebook_page_name,
        pageTasks: item.page_tasks,
        instagramLedgerId: item.instagram_ledger_id,
        instagramBusinessId: item.instagram_business_id,
        instagramUsername: item.instagram_username,
      })),
    };
  }
  return json(result, 200, origin);
}

async function startAuthorization(req: Request, origin: string) {
  if (!credentialsConfigured()) {
    return json(
      { error: "Meta authorization is not configured yet" },
      503,
      origin,
    );
  }
  const user = await caller(req);
  if (!user) return json({ error: "Invalid or expired session" }, 401, origin);

  const state = randomUrlSafe(32);
  const browserNonce = randomUrlSafe(32);
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  const stateHash = await sha256Hex(state);
  const browserNonceHash = await sha256Hex(browserNonce);

  const [pendingCandidate, cleanupHold] = await Promise.all([
    admin.from("meta_oauth_candidates")
      .select("revocation_state,expires_at")
      .eq("owner", user.id)
      .maybeSingle(),
    admin.from("meta_oauth_cleanup_holds")
      .select("error_code,cleanup_kind")
      .eq("owner", user.id)
      .maybeSingle(),
  ]);
  if (pendingCandidate.error || cleanupHold.error) {
    return json(
      { error: "Could not inspect pending Meta authorization cleanup" },
      500,
      origin,
    );
  }
  if (pendingCandidate.data || cleanupHold.data) {
    return json(
      {
        error:
          "Resolve the previous Meta authorization before starting another. Expired Page selections still retain the provider token needed for safe revocation.",
        pendingAuthorizationCleanupRequired: true,
        manualRevocationRequired:
          pendingCandidate.data?.revocation_state === "manual_required" ||
          cleanupHold.data?.cleanup_kind === "manual_revoke",
        manualRevocationSafe:
          pendingCandidate.data?.revocation_state === "manual_required" ||
          cleanupHold.data?.cleanup_kind === "manual_revoke",
        ownershipInvestigationRequired:
          cleanupHold.data?.cleanup_kind === "ownership_investigation",
        doNotRevokeProvider:
          cleanupHold.data?.cleanup_kind === "ownership_investigation",
        manualRevocationUrl:
          pendingCandidate.data?.revocation_state === "manual_required" ||
            cleanupHold.data?.cleanup_kind === "manual_revoke"
            ? MANUAL_REVOCATION_URL
            : undefined,
      },
      409,
      origin,
    );
  }
  const { data: transactionStatus, error } = await admin.rpc(
    "meta_create_oauth_transaction",
    {
      p_state_hash: stateHash,
      p_owner: user.id,
      p_browser_nonce_hash: browserNonceHash,
      p_return_origin: origin,
      p_expires_at: expiresAt,
    },
  );
  if (error) {
    return json({ error: "Could not start Meta authorization" }, 500, origin);
  }
  if (transactionStatus !== "created") {
    const processing = transactionStatus === "processing";
    const erasing = transactionStatus === "erasing";
    return json(
      {
        error: erasing
          ? "Account or content erasure is running. Wait for it to finish before connecting Meta."
          : processing
          ? "A previous Meta authorization is still being secured. Do not revoke provider access or start another connection; retry after support resolves the processing hold."
          : transactionStatus === "pending"
          ? "A Meta authorization is already open for this owner. Finish it in the original browser tab or wait for it to expire."
          : "Resolve the previous protected Meta authorization before starting another.",
        pendingAuthorizationCleanupRequired: processing ||
          transactionStatus === "protected_cleanup",
        ownershipInvestigationRequired: processing,
        doNotRevokeProvider: processing,
        erasureInProgress: erasing,
        authorizationInProgress: transactionStatus === "pending" || processing,
      },
      409,
      origin,
    );
  }

  const authorization = new URL(facebookAuthorizationUrl());
  const authorizationParams = new URLSearchParams({
    client_id: META_APP_ID,
    redirect_uri: CALLBACK_URL,
    response_type: "code",
    scope: REQUIRED_SCOPES.join(","),
    state,
    auth_type: "rerequest",
  });
  if (META_LOGIN_CONFIG_ID) {
    authorizationParams.set("config_id", META_LOGIN_CONFIG_ID);
    authorizationParams.set("override_default_response_type", "true");
  }
  authorization.search = authorizationParams.toString();
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
    return redirectToApp({ meta: "error", reason: "invalid_state" });
  }
  const { data: pending, error } = await admin.from(
    "meta_oauth_transactions",
  )
    .select("return_origin")
    .eq("state_hash", await sha256Hex(rawState))
    .eq("transaction_state", "pending")
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();
  const returnOrigin = !error && typeof pending?.return_origin === "string" &&
      ALLOWED_ORIGINS.has(pending.return_origin)
    ? pending.return_origin
    : "";
  if (!returnOrigin) {
    return redirectToApp({ meta: "error", reason: "invalid_state" });
  }
  if ((!code && !providerError) || code.length > 8192) {
    return redirectToApp(
      { meta: "error", reason: "missing_code" },
      returnOrigin,
    );
  }
  return redirectToApp({
    meta: "finish",
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
      { error: "Meta authorization is not configured yet" },
      503,
      origin,
    );
  }
  const user = await caller(req);
  if (!user) return json({ error: "Invalid or expired session" }, 401, origin);

  const rawState = String(body.state || "").trim();
  const browserNonce = String(body.browserNonce || "").trim();
  const code = String(body.code || "").trim();
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
      { error: "The Meta authorization expired. Please try again." },
      400,
      origin,
    );
  }

  const stateHash = await sha256Hex(rawState);
  const browserNonceHash = await sha256Hex(browserNonce);
  const { data: consumed, error: stateError } = await admin.rpc(
    "meta_claim_oauth_transaction",
    {
      p_state_hash: stateHash,
      p_owner: user.id,
      p_browser_nonce_hash: browserNonceHash,
    },
  );
  if (
    stateError || !Array.isArray(consumed) || consumed.length !== 1
  ) {
    return json(
      {
        error:
          "The Meta authorization expired or was opened in a different browser session.",
      },
      400,
      origin,
    );
  }
  if (providerError) {
    const finished = await finishOAuthTransaction(
      stateHash,
      user.id,
      browserNonceHash,
      "provider_cancelled",
    );
    return json(
      {
        error: !finished
          ? "Meta authorization was cancelled, but its local processing marker could not be cleared safely."
          : providerError === "access_denied"
          ? "Meta authorization was cancelled."
          : "Meta could not complete authorization.",
      },
      finished ? 400 : 500,
      origin,
    );
  }
  if (!code) {
    const finished = await finishOAuthTransaction(
      stateHash,
      user.id,
      browserNonceHash,
      "no_exchange",
    );
    return json(
      {
        error: finished
          ? "Meta did not return an authorization code."
          : "Meta returned no authorization code, and its local processing marker could not be cleared safely.",
      },
      finished ? 400 : 500,
      origin,
    );
  }

  let shortToken = "";
  let longToken = "";
  let identity: MetaIdentity | null = null;
  let candidateCreated = false;
  let selectionToken = "";
  let selectionHash = "";
  let existingGrant: { id: string; owner: string } | null = null;
  try {
    const exchanged = await exchangeAuthorizationCode(code);
    shortToken = exchanged.accessToken;
    identity = await fetchIdentity(shortToken);

    // Protect the first usable token and reserve the immutable Meta identity
    // before any additional provider or database work. A later discovery
    // failure therefore remains owner-cancellable instead of becoming a
    // browser-only warning with an untracked provider grant.
    selectionToken = randomUrlSafe(32);
    selectionHash = await sha256Hex(selectionToken);
    const candidateExpiresAt = new Date(
      Date.now() + 10 * 60 * 1000,
    ).toISOString();
    const initialTokenExpiry = safeExpiry(
      undefined,
      exchanged.expiresIn,
    ) || new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const initialBundle: CandidateCredential = {
      user_access_token: shortToken,
      token_type: "bearer",
      expires_at: initialTokenExpiry,
      pages: [],
    };
    const candidate = await admin.rpc("meta_create_oauth_candidate", {
      p_selection_hash: selectionHash,
      p_transaction_state_hash: stateHash,
      p_owner: user.id,
      p_browser_nonce_hash: browserNonceHash,
      p_meta_user_id: identity.id,
      p_meta_user_name: identity.name,
      p_granted_scopes: [],
      p_token_expires_at: initialTokenExpiry,
      p_token_bundle: JSON.stringify(initialBundle),
      p_expires_at: candidateExpiresAt,
    });
    if (candidate.error) {
      const reservation = await admin.from("meta_identity_reservations")
        .select("owner,candidate_selection_hash,grant_id")
        .eq("meta_user_id", identity.id)
        .maybeSingle();
      if (!reservation.error && reservation.data?.owner) {
        if (reservation.data.owner !== user.id) {
          const transactionResolved = await finishOAuthTransaction(
            stateHash,
            user.id,
            browserNonceHash,
            "identity_protected",
          );
          return json(
            {
              error: transactionResolved
                ? "That Meta identity is already reserved by another MyPersonas owner."
                : "That Meta identity is protected by another owner, but this authorization's processing marker could not be resolved safely.",
              identityOwnedByAnotherOwner: true,
              cleanupSkippedToProtectSharedGrant: true,
              pendingAuthorizationCleanupRequired: !transactionResolved,
              ownershipInvestigationRequired: !transactionResolved,
              doNotRevokeProvider: !transactionResolved,
              postingEnabled: false,
            },
            transactionResolved ? 409 : 500,
            origin,
          );
        }
        const protectedCandidate = Boolean(
          reservation.data.candidate_selection_hash,
        );
        const responseMayHaveBeenLost =
          reservation.data.candidate_selection_hash === selectionHash;
        const transactionResolved = responseMayHaveBeenLost ||
          await finishOAuthTransaction(
            stateHash,
            user.id,
            browserNonceHash,
            "identity_protected",
          );
        return json(
          {
            error: !transactionResolved
              ? "The Meta identity is protected, but this authorization's processing marker could not be resolved safely."
              : protectedCandidate
              ? "That Meta identity already has a protected pending authorization. Resolve it before trying again."
              : "That Meta identity already has a protected connection.",
            existingGrantUnchanged: Boolean(reservation.data.grant_id),
            cleanupSkippedToProtectSharedGrant: true,
            pendingAuthorizationCleanupRequired: protectedCandidate ||
              !transactionResolved,
            cancelAction: protectedCandidate ? "cancel_pending" : undefined,
            candidateResponseMayHaveBeenLost: responseMayHaveBeenLost,
            ownershipInvestigationRequired: !transactionResolved,
            doNotRevokeProvider: !transactionResolved,
            postingEnabled: false,
          },
          transactionResolved ? 409 : 500,
          origin,
        );
      }
      const hold = await createCleanupHold(
        user.id,
        "meta_candidate_storage_failed",
        identity.id,
        "manual_revoke",
        stateHash,
        browserNonceHash,
      );
      if (hold.status === "reserved_other_owner") {
        const transactionResolved = await finishOAuthTransaction(
          stateHash,
          user.id,
          browserNonceHash,
          "identity_protected",
        );
        return json(
          {
            error: transactionResolved
              ? "That Meta identity is reserved by another MyPersonas owner."
              : "That Meta identity is protected by another owner, but this authorization's processing marker could not be resolved safely.",
            identityOwnedByAnotherOwner: true,
            cleanupSkippedToProtectSharedGrant: true,
            pendingAuthorizationCleanupRequired: !transactionResolved,
            ownershipInvestigationRequired: !transactionResolved,
            doNotRevokeProvider: !transactionResolved,
            postingEnabled: false,
          },
          transactionResolved ? 409 : 500,
          origin,
        );
      }
      if (hold.status === "protected_same_owner") {
        const transactionResolved = await finishOAuthTransaction(
          stateHash,
          user.id,
          browserNonceHash,
          "identity_protected",
        );
        const protectedReservation = await admin.from(
          "meta_identity_reservations",
        )
          .select("candidate_selection_hash,grant_id")
          .eq("meta_user_id", identity.id)
          .eq("owner", user.id)
          .maybeSingle();
        const protectedCandidate = Boolean(
          protectedReservation.data?.candidate_selection_hash,
        );
        return json(
          {
            error: !transactionResolved
              ? "The Meta identity is protected, but this authorization's processing marker could not be resolved safely."
              : protectedCandidate
              ? "That Meta identity already has a protected pending authorization."
              : "That Meta identity already has a protected connection.",
            existingGrantUnchanged: Boolean(
              protectedReservation.data?.grant_id,
            ),
            cleanupSkippedToProtectSharedGrant: true,
            pendingAuthorizationCleanupRequired: protectedCandidate ||
              !transactionResolved,
            cancelAction: protectedCandidate ? "cancel_pending" : undefined,
            ownershipInvestigationRequired: !transactionResolved,
            doNotRevokeProvider: !transactionResolved,
            postingEnabled: false,
          },
          transactionResolved ? 409 : 500,
          origin,
        );
      }
      if (hold.status === "protected_existing_hold") {
        const transactionResolved = await finishOAuthTransaction(
          stateHash,
          user.id,
          browserNonceHash,
          "identity_protected",
        );
        return json(
          {
            error: transactionResolved
              ? "A different unresolved Meta authorization was recorded first. Do not revoke a provider integration or start another Meta connection; ownership review is required."
              : "A different unresolved Meta authorization was recorded first, and this processing marker could not be resolved safely. Do not revoke a provider integration.",
            ownershipInvestigationRequired: true,
            doNotRevokeProvider: true,
            manualRevocationRequired: false,
            pendingAuthorizationCleanupRequired: true,
            providerOutcomeAmbiguous: true,
            postingEnabled: false,
          },
          transactionResolved ? 409 : 500,
          origin,
        );
      }
      const holdRecorded = hold.status === "held" ||
        hold.status === "held_existing";
      return json(
        {
          error: holdRecorded
            ? "The Meta identity could not be protected locally. Revoke MyPersonas in Facebook Business Integrations, then confirm manual revocation."
            : "Meta identity ownership could not be resolved safely. Do not revoke or start another Meta connection; retry after the service recovers.",
          manualRevocationRequired: holdRecorded,
          manualRevocationSafe: holdRecorded,
          manualRevocationUrl: holdRecorded ? MANUAL_REVOCATION_URL : undefined,
          ownershipInvestigationRequired: !holdRecorded,
          pendingAuthorizationCleanupRequired: true,
          providerOutcomeAmbiguous: true,
        },
        holdRecorded ? 409 : 500,
        origin,
      );
    }
    candidateCreated = true;

    const extended = await exchangeLongLivedToken(shortToken);
    longToken = extended.accessToken;
    const [tokenDebug, grantedScopes] = await Promise.all([
      debugToken(longToken),
      fetchGrantedScopes(longToken),
    ]);
    if (
      tokenDebug.userId !== identity.id ||
      !hasRequiredScopes(grantedScopes)
    ) {
      throw new MetaProviderError(
        "Meta did not grant all required Page discovery permissions.",
      );
    }
    const expiresAt = tokenDebug.expiresAt ||
      safeExpiry(undefined, extended.expiresIn);
    if (!expiresAt) {
      throw new MetaProviderError(
        "Meta did not return a safe long-lived token expiry.",
      );
    }

    const protectedLongToken = await admin.rpc(
      "meta_update_oauth_candidate_bundle",
      {
        p_selection_hash: selectionHash,
        p_owner: user.id,
        p_browser_nonce_hash: browserNonceHash,
        p_granted_scopes: grantedScopes,
        p_token_expires_at: expiresAt,
        p_token_bundle: JSON.stringify(
          {
            user_access_token: longToken,
            token_type: "bearer",
            expires_at: expiresAt,
            pages: [],
          } satisfies CandidateCredential,
        ),
      },
    );
    if (protectedLongToken.error || protectedLongToken.data !== true) {
      throw new Error(
        "The long-lived Meta token could not be protected for cleanup.",
      );
    }

    const existingResult = await admin.from("meta_grants")
      .select("id,owner")
      .eq("meta_user_id", identity.id)
      .maybeSingle();
    if (existingResult.error) {
      throw new Error("Could not inspect the existing Meta grant.");
    }
    existingGrant = existingResult.data;
    if (existingGrant && existingGrant.owner !== user.id) {
      throw new Error(
        "The Meta identity reservation does not match its durable owner.",
      );
    }

    const pages = await discoverPages(longToken);
    if (pages.length === 0) {
      throw new MetaProviderError(
        "No eligible Facebook Pages were returned. Personal profiles are not supported.",
      );
    }

    const existingAssets = existingGrant
      ? await getGrantAssets(existingGrant.id, user.id)
      : [];
    if (
      existingGrant &&
      existingAssets.some((asset) =>
        !pages.some((page) => page.page_id === asset.facebook_page_id)
      )
    ) {
      throw new MetaProviderError(
        "The reauthorized Meta identity no longer exposes every connected Page. Disconnect the shared grant before changing its Page inventory.",
      );
    }

    const tokenBundle: CandidateCredential = {
      user_access_token: longToken,
      token_type: "bearer",
      expires_at: expiresAt,
      pages,
    };
    const discoveredCandidate = await admin.rpc(
      "meta_update_oauth_candidate_bundle",
      {
        p_selection_hash: selectionHash,
        p_owner: user.id,
        p_browser_nonce_hash: browserNonceHash,
        p_granted_scopes: grantedScopes,
        p_token_expires_at: expiresAt,
        p_token_bundle: JSON.stringify(tokenBundle),
      },
    );
    if (discoveredCandidate.error || discoveredCandidate.data !== true) {
      throw new Error("Could not protect the Meta Page discovery result.");
    }

    return json(
      {
        selectionToken,
        metaUser: { id: identity.id, name: identity.name },
        pages: sanitizePages(pages, existingAssets),
        expiresAt: candidateExpiresAt,
        postingEnabled: false,
      },
      200,
      origin,
    );
  } catch (error) {
    const providerFailure = error instanceof MetaProviderError;
    if (candidateCreated) {
      return json(
        {
          error: error instanceof Error
            ? error.message
            : "Meta authorization could not be completed.",
          pendingAuthorizationCleanupRequired: true,
          manualRevocationRequired: false,
          providerOutcomeAmbiguous: providerFailure && error.ambiguous,
          cancelAction: "cancel_pending",
          postingEnabled: false,
        },
        409,
        origin,
      );
    }

    const durableHoldRequired = Boolean(shortToken) ||
      (providerFailure && error.ambiguous);
    if (!durableHoldRequired) {
      const transactionResolved = await finishOAuthTransaction(
        stateHash,
        user.id,
        browserNonceHash,
        "no_exchange",
      );
      return json(
        {
          error: transactionResolved
            ? error instanceof Error
              ? error.message
              : "Meta authorization could not be completed."
            : "Meta rejected the authorization code, but its local processing marker could not be cleared safely.",
          pendingAuthorizationCleanupRequired: !transactionResolved,
          ownershipInvestigationRequired: !transactionResolved,
          doNotRevokeProvider: !transactionResolved,
          providerOutcomeAmbiguous: false,
          postingEnabled: false,
        },
        transactionResolved ? 400 : 500,
        origin,
      );
    }

    let holdStatus = "";
    const knownMetaUserId = identity?.id || null;
    const cleanupKind = knownMetaUserId
      ? "manual_revoke" as const
      : "ownership_investigation" as const;
    if (durableHoldRequired) {
      const hold = await createCleanupHold(
        user.id,
        shortToken
          ? "meta_identity_or_reservation_unavailable"
          : "meta_code_exchange_outcome_ambiguous",
        knownMetaUserId,
        cleanupKind,
        stateHash,
        browserNonceHash,
      );
      holdStatus = hold.status;
    }
    if (
      holdStatus === "reserved_other_owner" ||
      holdStatus === "protected_same_owner"
    ) {
      const transactionResolved = await finishOAuthTransaction(
        stateHash,
        user.id,
        browserNonceHash,
        "identity_protected",
      );
      return json(
        {
          error: !transactionResolved
            ? "The Meta identity is protected, but this authorization's processing marker could not be resolved safely."
            : holdStatus === "reserved_other_owner"
            ? "That Meta identity is already protected for another MyPersonas owner."
            : "That Meta identity already has a protected MyPersonas connection or pending authorization.",
          identityOwnedByAnotherOwner: holdStatus === "reserved_other_owner",
          cleanupSkippedToProtectSharedGrant: true,
          pendingAuthorizationCleanupRequired: !transactionResolved,
          ownershipInvestigationRequired: !transactionResolved,
          doNotRevokeProvider: !transactionResolved,
          providerOutcomeAmbiguous: providerFailure && error.ambiguous,
          postingEnabled: false,
        },
        transactionResolved ? 409 : 500,
        origin,
      );
    }
    if (holdStatus === "protected_existing_hold") {
      const transactionResolved = await finishOAuthTransaction(
        stateHash,
        user.id,
        browserNonceHash,
        "identity_protected",
      );
      return json(
        {
          error: transactionResolved
            ? "A different unresolved Meta authorization was recorded first. Do not revoke a provider integration or start another Meta connection; ownership review is required."
            : "A different unresolved Meta authorization was recorded first, and this processing marker could not be resolved safely. Do not revoke a provider integration.",
          ownershipInvestigationRequired: true,
          doNotRevokeProvider: true,
          manualRevocationRequired: false,
          pendingAuthorizationCleanupRequired: true,
          providerOutcomeAmbiguous: true,
          postingEnabled: false,
        },
        transactionResolved ? 409 : 500,
        origin,
      );
    }
    const holdRecorded = holdStatus === "held" ||
      holdStatus === "held_existing";
    const manualRevocationRequired = holdRecorded &&
      cleanupKind === "manual_revoke";
    const ownershipInvestigationRequired = !holdRecorded ||
      cleanupKind === "ownership_investigation";
    return json(
      {
        error: error instanceof Error
          ? error.message
          : "Meta authorization could not be completed.",
        manualRevocationRequired,
        manualRevocationSafe: manualRevocationRequired,
        manualRevocationUrl: manualRevocationRequired
          ? MANUAL_REVOCATION_URL
          : undefined,
        ownershipInvestigationRequired,
        doNotRevokeProvider: ownershipInvestigationRequired,
        pendingAuthorizationCleanupRequired: true,
        providerOutcomeAmbiguous: providerFailure && error.ambiguous,
        cleanupHoldRecorded: holdRecorded,
      },
      holdRecorded ? 409 : 500,
      origin,
    );
  }
}

async function finalizeSelection(
  req: Request,
  origin: string,
  body: OAuthActionBody,
) {
  if (!credentialsConfigured()) {
    return json(
      { error: "Meta authorization is not configured yet" },
      503,
      origin,
    );
  }
  const user = await caller(req);
  if (!user) return json({ error: "Invalid or expired session" }, 401, origin);

  const selectionToken = String(body.selectionToken || "").trim();
  const browserNonce = String(body.browserNonce || "").trim();
  const requestedBindings = parseBindings(body.bindings);
  if (
    selectionToken.length < 32 || selectionToken.length > 512 ||
    browserNonce.length < 32 || browserNonce.length > 512 ||
    !requestedBindings
  ) {
    return json({ error: "Invalid Meta Page selection" }, 400, origin);
  }

  const selectionHash = await sha256Hex(selectionToken);
  const browserNonceHash = await sha256Hex(browserNonce);
  const candidateResult = await admin.rpc("meta_get_oauth_candidate", {
    p_selection_hash: selectionHash,
    p_owner: user.id,
    p_browser_nonce_hash: browserNonceHash,
  });
  const candidate = Array.isArray(candidateResult.data)
    ? candidateResult.data[0] as CandidateRow | undefined
    : undefined;
  if (candidateResult.error || !candidate) {
    return json(
      {
        error:
          "The Meta Page selection expired or belongs to another browser session.",
      },
      400,
      origin,
    );
  }

  const bundle = candidate.token_bundle;
  if (
    !bundle || typeof bundle.user_access_token !== "string" ||
    !Array.isArray(bundle.pages)
  ) {
    return json(
      { error: "The encrypted Meta Page selection is unavailable." },
      500,
      origin,
    );
  }

  const grantResult = await admin.from("meta_grants")
    .select("id,owner")
    .eq("meta_user_id", candidate.meta_user_id)
    .maybeSingle();
  if (grantResult.error) {
    return json(
      { error: "Could not inspect the existing Meta grant." },
      500,
      origin,
    );
  }
  if (grantResult.data && grantResult.data.owner !== user.id) {
    return json(
      {
        error: "That Meta identity is reserved or connected to another owner.",
        cleanupSkippedToProtectSharedGrant: true,
      },
      409,
      origin,
    );
  }

  const finalizeRevalidated = async (leaseId?: string) => {
    try {
      const [identity, tokenDebug, scopes, livePages] = await Promise.all([
        fetchIdentity(bundle.user_access_token),
        debugToken(bundle.user_access_token),
        fetchGrantedScopes(bundle.user_access_token),
        discoverPages(bundle.user_access_token),
      ]);
      if (
        identity.id !== candidate.meta_user_id ||
        tokenDebug.userId !== candidate.meta_user_id ||
        !hasRequiredScopes(scopes)
      ) {
        return json(
          { error: "The Meta identity or Page permissions changed." },
          409,
          origin,
        );
      }

      const liveById = new Map(livePages.map((page) => [page.page_id, page]));
      const candidateById = new Map(
        bundle.pages.map((page) => [page.page_id, page]),
      );
      for (const binding of requestedBindings) {
        const prior = candidateById.get(binding.pageId);
        const live = liveById.get(binding.pageId);
        if (!prior || !live) {
          return json(
            { error: "A selected Facebook Page is no longer available." },
            409,
            origin,
          );
        }
        const priorInstagramId = prior.instagram?.id || "";
        const liveInstagramId = live.instagram?.id || "";
        if (
          priorInstagramId !== liveInstagramId ||
          (binding.instagramLedgerId && !liveInstagramId)
        ) {
          return json(
            {
              error:
                "A selected Page's linked Instagram professional account changed.",
            },
            409,
            origin,
          );
        }
      }

      const effectiveBindings = [...requestedBindings];
      if (grantResult.data?.id) {
        const existingAssets = await getGrantAssets(
          grantResult.data.id,
          user.id,
        );
        for (const asset of existingAssets) {
          const selected = effectiveBindings.find((binding) =>
            binding.pageId === asset.facebook_page_id
          );
          if (selected) {
            if (
              selected.facebookLedgerId !== asset.facebook_ledger_id ||
              (selected.instagramLedgerId || "") !==
                (asset.instagram_ledger_id || "")
            ) {
              return json(
                {
                  error:
                    "Disconnect the existing immutable Meta asset binding before changing its ledger assignment.",
                },
                409,
                origin,
              );
            }
            continue;
          }
          const live = liveById.get(asset.facebook_page_id);
          if (
            !live ||
            (asset.instagram_business_id || "") !== (live.instagram?.id || "")
          ) {
            return json(
              {
                error:
                  "An existing connected Meta asset changed. Disconnect the shared grant before reconnecting.",
              },
              409,
              origin,
            );
          }
          effectiveBindings.push({
            pageId: asset.facebook_page_id,
            facebookLedgerId: asset.facebook_ledger_id,
            ...(asset.instagram_ledger_id
              ? { instagramLedgerId: asset.instagram_ledger_id }
              : {}),
          });
        }
      }

      const finalized = await admin.rpc("meta_finalize_assets", {
        p_selection_hash: selectionHash,
        p_owner: user.id,
        p_browser_nonce_hash: browserNonceHash,
        p_bindings: effectiveBindings.map((binding) => ({
          pageId: binding.pageId,
          facebookLedgerId: binding.facebookLedgerId,
          instagramLedgerId: binding.instagramLedgerId || "",
        })),
        p_lease_id: leaseId || null,
      });
      if (finalized.error || !finalized.data) {
        return json(
          {
            error: finalized.error?.message ||
              "The Meta assets could not be connected safely.",
          },
          409,
          origin,
        );
      }
      return json(
        {
          connected: true,
          ...finalized.data,
          postingEnabled: false,
        },
        200,
        origin,
      );
    } catch (error) {
      return json(
        {
          error: error instanceof Error
            ? error.message
            : "Meta could not revalidate the selected assets.",
        },
        error instanceof MetaProviderError && error.ambiguous ? 502 : 409,
        origin,
      );
    }
  };

  return grantResult.data?.id
    ? await withGrantLease(
      grantResult.data.id,
      user.id,
      "connect",
      origin,
      finalizeRevalidated,
    )
    : await finalizeRevalidated();
}

async function cancelAuthorization(
  req: Request,
  origin: string,
  body: OAuthActionBody,
  ownerPendingCandidate = false,
) {
  const user = await caller(req);
  if (!user) return json({ error: "Invalid or expired session" }, 401, origin);

  let selectionHash = "";
  let browserNonceHash: string | null = null;
  if (ownerPendingCandidate) {
    const pending = await admin.from("meta_oauth_candidates")
      .select("selection_hash")
      .eq("owner", user.id)
      .maybeSingle();
    if (pending.error) {
      return json(
        { error: "Could not inspect pending Meta authorization cleanup" },
        500,
        origin,
      );
    }
    if (!pending.data) {
      const hold = await admin.from("meta_oauth_cleanup_holds")
        .select("error_code,cleanup_kind,meta_user_id")
        .eq("owner", user.id)
        .maybeSingle();
      if (hold.error) {
        return json(
          { error: "Could not inspect ambiguous Meta authorization cleanup" },
          500,
          origin,
        );
      }
      if (hold.data) {
        if (hold.data.cleanup_kind === "ownership_investigation") {
          return json(
            {
              error:
                "Meta may have consumed the authorization code, but no identity was returned. Do not revoke a provider integration or start another Meta connection. This hold requires support review.",
              ownershipInvestigationRequired: true,
              doNotRevokeProvider: true,
              manualRevocationRequired: false,
              pendingAuthorizationCleanupRequired: true,
              pendingAuthorizationAmbiguousExchange: true,
            },
            409,
            origin,
          );
        }
        if (body.manualRevocationAcknowledged !== true) {
          return json(
            {
              error:
                "Meta may have consumed the authorization code without returning a safely revocable credential. Revoke MyPersonas in Facebook Business Integrations, then explicitly confirm manual revocation.",
              manualRevocationRequired: true,
              manualRevocationSafe: true,
              manualRevocationUrl: MANUAL_REVOCATION_URL,
              pendingAuthorizationCleanupRequired: true,
              pendingAuthorizationAmbiguousExchange: true,
            },
            409,
            origin,
          );
        }
        const removed = await deleteCleanupHold(
          user.id,
          hold.data as CleanupHoldRow,
        );
        return json(
          removed
            ? {
              cancelled: true,
              manualRevocationAcknowledged: true,
              providerRevocationConfirmed: false,
              pendingAuthorizationAmbiguousExchange: false,
              disconnectScope: "ambiguous_authorization_hold",
              postingEnabled: false,
            }
            : {
              error:
                "Manual Meta revocation was acknowledged, but the ambiguous authorization hold could not be cleared.",
              pendingAuthorizationCleanupRequired: true,
            },
          removed ? 200 : 500,
          origin,
        );
      }
      return json(
        { cancelled: true, alreadyResolved: true, postingEnabled: false },
        200,
        origin,
      );
    }
    selectionHash = String(pending.data.selection_hash || "");
  } else {
    const selectionToken = String(body.selectionToken || "").trim();
    const browserNonce = String(body.browserNonce || "").trim();
    if (
      selectionToken.length < 32 || selectionToken.length > 512 ||
      browserNonce.length < 32 || browserNonce.length > 512
    ) {
      return json({ error: "Invalid Meta Page selection" }, 400, origin);
    }
    selectionHash = await sha256Hex(selectionToken);
    browserNonceHash = await sha256Hex(browserNonce);
  }

  const inspected = await getCandidateForRevocation(
    selectionHash,
    user.id,
    browserNonceHash,
  );
  if (inspected.error) {
    return json(
      { error: "Could not inspect the pending Meta authorization" },
      500,
      origin,
    );
  }
  const candidate = inspected.candidate;
  if (!candidate) {
    return json(
      { cancelled: true, alreadyResolved: true, postingEnabled: false },
      200,
      origin,
    );
  }
  const manualAcknowledged = body.manualRevocationAcknowledged === true &&
    candidate.revocation_state === "manual_required";
  if (
    candidate.revocation_state === "manual_required" &&
    !manualAcknowledged
  ) {
    return json(
      {
        error:
          "Meta did not confirm revocation. Revoke MyPersonas in Facebook Business Integrations, then explicitly confirm manual revocation.",
        manualRevocationRequired: true,
        manualRevocationSafe: true,
        manualRevocationUrl: MANUAL_REVOCATION_URL,
        pendingAuthorizationCleanupRequired: true,
      },
      409,
      origin,
    );
  }
  const revocationStartedAt = candidate.revocation_started_at
    ? new Date(candidate.revocation_started_at).getTime()
    : 0;
  if (
    candidate.revocation_state === "revoking" &&
    revocationStartedAt > Date.now() - 3 * 60 * 1000
  ) {
    return json(
      {
        error:
          "Another Meta authorization cleanup is already running. Please wait a moment and try again.",
        pendingAuthorizationCleanupRequired: true,
      },
      409,
      origin,
    );
  }

  const grantResult = await admin.from("meta_grants")
    .select("id,owner")
    .eq("meta_user_id", candidate.meta_user_id)
    .maybeSingle();
  if (grantResult.error) {
    return json(
      { error: "Could not inspect the existing shared Meta grant" },
      500,
      origin,
    );
  }
  if (grantResult.data && grantResult.data.owner !== user.id) {
    const removed = await deleteCandidate(selectionHash, user.id);
    return json(
      removed
        ? {
          cancelled: true,
          providerRevocationConfirmed: false,
          providerRevocationSkipped: "identity_owned_by_another_owner",
          cleanupSkippedToProtectSharedGrant: true,
          sharedGrantDisconnected: false,
          postingEnabled: false,
        }
        : {
          error:
            "The cross-owner Meta candidate could not be discarded locally without touching the other owner's shared provider grant.",
          cleanupSkippedToProtectSharedGrant: true,
        },
      removed ? 200 : 500,
      origin,
    );
  }
  const reservationResult = await admin.from("meta_identity_reservations")
    .select("owner,candidate_selection_hash,grant_id")
    .eq("meta_user_id", candidate.meta_user_id)
    .maybeSingle();
  if (reservationResult.error) {
    return json(
      { error: "Could not verify Meta identity ownership for cleanup" },
      500,
      origin,
    );
  }
  if (
    reservationResult.data &&
    reservationResult.data.owner !== user.id
  ) {
    const removed = await deleteCandidate(selectionHash, user.id);
    return json(
      removed
        ? {
          cancelled: true,
          providerRevocationConfirmed: false,
          providerRevocationSkipped: "identity_reserved_by_another_owner",
          cleanupSkippedToProtectSharedGrant: true,
          postingEnabled: false,
        }
        : {
          error:
            "The cross-owner Meta candidate could not be discarded locally.",
          cleanupSkippedToProtectSharedGrant: true,
        },
      removed ? 200 : 500,
      origin,
    );
  }
  const reservationMatches = reservationResult.data?.owner === user.id &&
    reservationResult.data.candidate_selection_hash === selectionHash;
  if (!reservationMatches) {
    const hold = await createCleanupHold(
      user.id,
      "meta_identity_reservation_unavailable",
      candidate.meta_user_id,
      "ownership_investigation",
    );
    if (hold.status === "reserved_other_owner") {
      const removed = await deleteCandidate(selectionHash, user.id);
      return json(
        removed
          ? {
            cancelled: true,
            providerRevocationConfirmed: false,
            providerRevocationSkipped: "identity_reserved_by_another_owner",
            cleanupSkippedToProtectSharedGrant: true,
            postingEnabled: false,
          }
          : {
            error:
              "The cross-owner Meta candidate could not be discarded locally.",
            cleanupSkippedToProtectSharedGrant: true,
          },
        removed ? 200 : 500,
        origin,
      );
    }
    if (hold.status === "protected_existing_hold") {
      return json(
        {
          error:
            "A different unresolved Meta authorization was recorded first. Do not revoke Meta access; ownership review is required.",
          ownershipInvestigationRequired: true,
          doNotRevokeProvider: true,
          manualRevocationRequired: false,
          pendingAuthorizationCleanupRequired: true,
        },
        409,
        origin,
      );
    }
    return json(
      {
        error:
          "The Meta identity reservation cannot prove which shared provider integration is safe to revoke. Do not revoke Meta access. This authorization requires ownership review.",
        ownershipInvestigationRequired: true,
        doNotRevokeProvider: true,
        manualRevocationRequired: false,
        pendingAuthorizationCleanupRequired: hold.status === "held",
      },
      hold.status === "held" ? 409 : 500,
      origin,
    );
  }

  const cancelClaimed = async (leaseId?: string) => {
    const claimedResult = await admin.rpc(
      "meta_claim_oauth_candidate_for_revocation",
      {
        p_selection_hash: selectionHash,
        p_owner: user.id,
        p_browser_nonce_hash: browserNonceHash,
        p_allow_manual_required: manualAcknowledged,
      },
    );
    const claimed = Array.isArray(claimedResult.data)
      ? claimedResult.data[0] as ClaimedCandidateRow | undefined
      : undefined;
    if (claimedResult.error) {
      return json(
        { error: "Could not lock the Meta authorization for cleanup" },
        500,
        origin,
      );
    }
    if (!claimed) {
      return json(
        {
          error:
            "The Meta authorization was already finalized or another cleanup is running.",
          pendingAuthorizationCleanupRequired: true,
        },
        409,
        origin,
      );
    }

    const protectedBundle = candidateTokenBundle(claimed.token_bundle);
    const providerAlreadyRevoked =
      claimed.previous_revocation_state === "provider_revoked";
    let providerRevocationConfirmed = providerAlreadyRevoked;
    if (
      !providerAlreadyRevoked &&
      claimed.previous_revocation_state !== "manual_required" &&
      credentialsConfigured() &&
      validProviderId(claimed.meta_user_id) &&
      protectedBundle
    ) {
      providerRevocationConfirmed = await revokeMetaPermissions(
        claimed.meta_user_id,
        protectedBundle.userAccessToken,
      );
    }
    const manualRevocationAccepted = !providerRevocationConfirmed &&
      manualAcknowledged &&
      claimed.previous_revocation_state === "manual_required";

    if (!providerRevocationConfirmed && !manualRevocationAccepted) {
      const candidateRecorded = await markCandidateManualRevocation(
        selectionHash,
        user.id,
        credentialsConfigured() && protectedBundle
          ? "meta_candidate_revoke_unconfirmed"
          : "meta_candidate_credential_unavailable",
      );
      let grantRecorded = true;
      if (grantResult.data?.id) {
        grantRecorded = await markGrantError(
          grantResult.data.id,
          user.id,
          "meta_manual_revoke_required",
        );
      }
      return json(
        {
          error: candidateRecorded && grantRecorded
            ? "Meta did not confirm revocation. Revoke MyPersonas in Facebook Business Integrations, then confirm manual revocation."
            : "Meta did not confirm revocation, and the fail-closed cleanup state could not be recorded. Do not clear local records or revoke a provider integration based on this response; retry or report the problem.",
          manualRevocationRequired: candidateRecorded && grantRecorded,
          manualRevocationSafe: candidateRecorded && grantRecorded,
          manualRevocationUrl: candidateRecorded && grantRecorded
            ? MANUAL_REVOCATION_URL
            : undefined,
          pendingAuthorizationCleanupRequired: true,
        },
        candidateRecorded && grantRecorded ? 409 : 500,
        origin,
      );
    }

    if (
      providerRevocationConfirmed &&
      !await markCandidateProviderRevoked(selectionHash, user.id)
    ) {
      return json(
        {
          error:
            "Meta access was revoked, but the local cleanup checkpoint could not be recorded.",
          providerRevocationConfirmed: true,
          pendingAuthorizationCleanupRequired: true,
        },
        500,
        origin,
      );
    }

    let disconnectedLedgerIds: string[] = [];
    if (grantResult.data?.id) {
      const deletedGrant = await admin.rpc(
        "meta_delete_grant_and_mark_disconnected",
        {
          p_grant_id: grantResult.data.id,
          p_owner: user.id,
          p_lease_id: leaseId,
        },
      );
      if (deletedGrant.error) {
        await markGrantError(
          grantResult.data.id,
          user.id,
          providerRevocationConfirmed
            ? "meta_provider_revoked_local_cleanup_failed"
            : "meta_manual_revoke_required",
        );
        if (!providerRevocationConfirmed) {
          await markCandidateManualRevocation(
            selectionHash,
            user.id,
            "meta_manual_revoke_cleanup_failed",
          );
        }
        return json(
          {
            error:
              "Meta access was revoked or manually acknowledged, but the existing shared connection records could not be cleared.",
            providerRevocationConfirmed,
            manualRevocationAcknowledged: manualRevocationAccepted,
            pendingAuthorizationCleanupRequired: true,
          },
          500,
          origin,
        );
      }
      disconnectedLedgerIds = Array.isArray(
          deletedGrant.data?.disconnectedLedgerIds,
        )
        ? deletedGrant.data.disconnectedLedgerIds
        : [];
    }

    if (!await deleteCandidate(selectionHash, user.id)) {
      if (!providerRevocationConfirmed) {
        await markCandidateManualRevocation(
          selectionHash,
          user.id,
          "meta_manual_revoke_cleanup_failed",
        );
      }
      return json(
        {
          error:
            "Meta access was revoked or manually acknowledged, but the pending local authorization could not be cleared.",
          providerRevocationConfirmed,
          manualRevocationAcknowledged: manualRevocationAccepted,
          pendingAuthorizationCleanupRequired: true,
        },
        500,
        origin,
      );
    }

    return json(
      {
        cancelled: true,
        providerRevocationConfirmed,
        manualRevocationAcknowledged: manualRevocationAccepted,
        sharedGrantDisconnected: Boolean(grantResult.data?.id),
        disconnectedLedgerIds,
        disconnectScope: grantResult.data?.id
          ? "all_assets_for_meta_user"
          : "pending_authorization",
        postingEnabled: false,
      },
      200,
      origin,
    );
  };

  return grantResult.data?.id
    ? await withGrantLease(
      grantResult.data.id,
      user.id,
      "disconnect",
      origin,
      cancelClaimed,
    )
    : await cancelClaimed();
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
  const ledger = await ownedMetaLedger(ledgerId, user.id);
  if (!ledger) {
    return json(
      { error: "Owned Facebook or Instagram account record not found" },
      404,
      origin,
    );
  }
  let asset: GrantAssetRow | null;
  try {
    asset = await findAssetForLedger(ledger.id, ledger.owner);
  } catch (error) {
    return json(
      { error: error instanceof Error ? error.message : "Lookup failed" },
      500,
      origin,
    );
  }
  if (!asset) {
    return json({ disconnected: true, alreadyDisconnected: true }, 200, origin);
  }
  let recordedCleanupState = "active";
  try {
    recordedCleanupState = await grantRecordedCleanupState(
      asset.grant_id,
      ledger.owner,
    );
  } catch (error) {
    return json(
      {
        error: error instanceof Error
          ? error.message
          : "Could not inspect Meta cleanup state.",
      },
      500,
      origin,
    );
  }
  if (recordedCleanupState === "provider_revoked") {
    return withGrantLease(
      asset.grant_id,
      ledger.owner,
      "disconnect",
      origin,
      async (leaseId) => {
        const deleted = await admin.rpc(
          "meta_delete_grant_and_mark_disconnected",
          {
            p_grant_id: asset!.grant_id,
            p_owner: ledger.owner,
            p_lease_id: leaseId,
          },
        );
        if (deleted.error) {
          return json(
            {
              error:
                "Meta access was already revoked, but local connection records still could not be cleared.",
              providerRevocationConfirmed: true,
            },
            500,
            origin,
          );
        }
        return json(
          {
            disconnected: true,
            providerRevocationConfirmed: true,
            recoveredLocalCleanup: true,
            disconnectScope: "all_assets_for_meta_user",
            ...deleted.data,
          },
          200,
          origin,
        );
      },
    );
  }
  if (!credentialsConfigured()) {
    return withGrantLease(
      asset.grant_id,
      ledger.owner,
      "disconnect",
      origin,
      async () => {
        const recorded = await markGrantError(
          asset!.grant_id,
          ledger.owner,
          "meta_manual_revoke_required",
        );
        return json(
          {
            error: recorded
              ? "Meta credentials are unavailable. Revoke MyPersonas in Facebook Business Integrations, then use manual reset."
              : "Meta credentials are unavailable, and the shared manual-revocation state could not be recorded. Do not clear local records or revoke a provider integration based on this response; retry or report the problem.",
            manualRevocationRequired: recorded,
            manualRevocationSafe: recorded,
            manualRevocationUrl: recorded ? MANUAL_REVOCATION_URL : undefined,
            pendingAuthorizationCleanupRequired: recorded,
          },
          recorded ? 409 : 500,
          origin,
        );
      },
    );
  }

  return withGrantLease(
    asset.grant_id,
    ledger.owner,
    "disconnect",
    origin,
    async (leaseId) => {
      const credentialResult = await admin.rpc(
        "meta_get_grant_token_bundle",
        {
          p_grant_id: asset!.grant_id,
          p_owner: ledger.owner,
        },
      );
      const credential = Array.isArray(credentialResult.data)
        ? credentialResult.data[0] as {
          meta_user_id?: string;
          token_bundle?: { access_token?: string };
        } | undefined
        : undefined;
      const metaUserId = String(credential?.meta_user_id || "");
      const accessToken = String(
        credential?.token_bundle?.access_token || "",
      );
      if (
        credentialResult.error ||
        !validProviderId(metaUserId) ||
        !accessToken
      ) {
        const recorded = await markGrantError(
          asset!.grant_id,
          ledger.owner,
          "meta_manual_revoke_required",
        );
        return json(
          {
            error: recorded
              ? "The local Meta credential cannot prove provider revocation. Revoke MyPersonas in Facebook Business Integrations, then use manual reset."
              : "The local Meta credential cannot prove provider revocation, and the fail-closed cleanup state could not be recorded. Do not clear local records until the service recovers.",
            manualRevocationRequired: recorded,
            manualRevocationSafe: recorded,
            manualRevocationUrl: recorded ? MANUAL_REVOCATION_URL : undefined,
            pendingAuthorizationCleanupRequired: recorded,
          },
          recorded ? 409 : 500,
          origin,
        );
      }

      const revoked = await revokeMetaPermissions(metaUserId, accessToken);
      if (!revoked) {
        const recorded = await markGrantError(
          asset!.grant_id,
          ledger.owner,
          "meta_manual_revoke_required",
        );
        return json(
          {
            error: recorded
              ? "Meta did not confirm revocation. Revoke MyPersonas in Facebook Business Integrations, then use manual reset."
              : "Meta did not confirm revocation, and the local safety state could not be recorded. Do not clear local records or revoke a provider integration based on this response; retry or report the problem.",
            manualRevocationRequired: recorded,
            manualRevocationSafe: recorded,
            manualRevocationUrl: recorded ? MANUAL_REVOCATION_URL : undefined,
            pendingAuthorizationCleanupRequired: recorded,
          },
          recorded ? 409 : 500,
          origin,
        );
      }

      const deleted = await admin.rpc(
        "meta_delete_grant_and_mark_disconnected",
        {
          p_grant_id: asset!.grant_id,
          p_owner: ledger.owner,
          p_lease_id: leaseId,
        },
      );
      if (deleted.error) {
        await markGrantError(
          asset!.grant_id,
          ledger.owner,
          "meta_provider_revoked_local_cleanup_failed",
        );
        return json(
          {
            error:
              "Meta access was revoked, but local connection records could not be cleared.",
            providerRevocationConfirmed: true,
          },
          500,
          origin,
        );
      }
      return json(
        {
          disconnected: true,
          providerRevocationConfirmed: true,
          disconnectScope: "all_assets_for_meta_user",
          ...deleted.data,
        },
        200,
        origin,
      );
    },
  );
}

async function resetAfterManualRevocation(
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
  const ledger = await ownedMetaLedger(ledgerId, user.id);
  if (!ledger) {
    return json(
      { error: "Owned Facebook or Instagram account record not found" },
      404,
      origin,
    );
  }
  let asset: GrantAssetRow | null;
  try {
    asset = await findAssetForLedger(ledger.id, ledger.owner);
  } catch (error) {
    return json(
      { error: error instanceof Error ? error.message : "Lookup failed" },
      500,
      origin,
    );
  }
  if (!asset) {
    return json({ reset: true, alreadyDisconnected: true }, 200, origin);
  }

  return withGrantLease(
    asset.grant_id,
    ledger.owner,
    "reset",
    origin,
    async (leaseId) => {
      let recordedCleanupState = "active";
      try {
        recordedCleanupState = await grantRecordedCleanupState(
          asset!.grant_id,
          ledger.owner,
        );
      } catch {
        return json(
          { error: "Could not verify the durable Meta cleanup marker." },
          500,
          origin,
        );
      }
      if (recordedCleanupState !== "manual_required") {
        return json(
          {
            error:
              "This Meta grant must be disconnected through the provider, not locally reset.",
          },
          409,
          origin,
        );
      }
      if (!manualRevocationAcknowledged) {
        return json(
          {
            error:
              "Revoke MyPersonas in Facebook Business Integrations, then explicitly confirm manual revocation.",
            manualRevocationRequired: true,
            manualRevocationSafe: true,
            manualRevocationUrl: MANUAL_REVOCATION_URL,
          },
          409,
          origin,
        );
      }

      const deleted = await admin.rpc(
        "meta_delete_grant_and_mark_disconnected",
        {
          p_grant_id: asset!.grant_id,
          p_owner: ledger.owner,
          p_lease_id: leaseId,
        },
      );
      if (deleted.error) {
        return json(
          { error: "Could not clear the manually revoked Meta grant." },
          500,
          origin,
        );
      }
      return json(
        {
          reset: true,
          manualRevocationAcknowledged: true,
          disconnectScope: "all_assets_for_meta_user",
          ...deleted.data,
        },
        200,
        origin,
      );
    },
  );
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
  if (Number.isFinite(contentLength) && contentLength > 65_536) {
    return json({ error: "Request is too large" }, 413, origin);
  }
  let body: OAuthActionBody;
  try {
    const rawBody = await req.text();
    if (new TextEncoder().encode(rawBody).byteLength > 65_536) {
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
    return startAuthorization(req, origin);
  }
  if (body.action === "complete") {
    return completeAuthorization(req, origin, body);
  }
  if (body.action === "finalize") {
    return finalizeSelection(req, origin, body);
  }
  if (body.action === "cancel") {
    return cancelAuthorization(req, origin, body);
  }
  if (body.action === "cancel_pending") {
    return cancelAuthorization(req, origin, body, true);
  }
  if (body.action === "disconnect") {
    return disconnect(req, origin, body.ledgerId);
  }
  if (body.action === "reset") {
    return resetAfterManualRevocation(
      req,
      origin,
      body.ledgerId,
      body.manualRevocationAcknowledged === true,
    );
  }
  return json({ error: "Unknown action" }, 400, origin);
});
