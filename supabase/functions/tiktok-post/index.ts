// tiktok-post — preview-bound TikTok Content Posting API foundation.
//
// Owner/AAL2 actions:
//   prepare-preview   -> current identity/creator options + exact preview hash
//   acknowledge-preview -> AAL2 acknowledgement of the rendered server receipt
//   send-approved     -> consumes that unchanged one-shot receipt before send
//   reconcile-status  -> polls TikTok by the checkpointed publish_id
//
// The first-release write is Upload API/PULL_FROM_URL, which sends video media
// to the creator's TikTok inbox. It does not transfer the caption and is not
// marked published until TikTok reports PUBLISH_COMPLETE. Direct Post exists
// only when TIKTOK_DIRECT_POST_ENABLED=true and TIKTOK_CLIENT_AUDIT_STATE is
// explicitly "audited" or "unaudited". Un-audited Direct Post is SELF_ONLY.
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { requireAal2 } from "../_shared/aal2.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const TIKTOK_CLIENT_KEY = Deno.env.get("TIKTOK_CLIENT_KEY") || "";
const TIKTOK_CLIENT_SECRET = Deno.env.get("TIKTOK_CLIENT_SECRET") || "";
const DIRECT_POST_ENABLED =
  Deno.env.get("TIKTOK_DIRECT_POST_ENABLED") === "true";
const CLIENT_AUDIT_STATE = Deno.env.get("TIKTOK_CLIENT_AUDIT_STATE") || "";
const VERIFIED_MEDIA_PREFIXES =
  (Deno.env.get("TIKTOK_VERIFIED_MEDIA_PREFIXES") || "")
    .split(/[\n,]+/).map((value) => value.trim()).filter(Boolean);
const APP_ORIGIN = Deno.env.get("TIKTOK_OAUTH_APP_ORIGIN") ||
  "https://mypersonas.online";
const TOKEN_URL = "https://open.tiktokapis.com/v2/oauth/token/";
const USER_URL =
  "https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name,username";
const CREATOR_URL =
  "https://open.tiktokapis.com/v2/post/publish/creator_info/query/";
const UPLOAD_INIT_URL =
  "https://open.tiktokapis.com/v2/post/publish/inbox/video/init/";
const DIRECT_INIT_URL =
  "https://open.tiktokapis.com/v2/post/publish/video/init/";
const STATUS_URL = "https://open.tiktokapis.com/v2/post/publish/status/fetch/";
const PROVIDER_TIMEOUT_MS = 25_000;
const TOKEN_REFRESH_SKEW_MS = 120_000;
const PREVIEW_VERSION = "tiktok-platform-preview-v1";
const REQUIRED_IDENTITY_SCOPES = ["user.info.basic", "user.info.profile"];
const SAFE_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_OPEN_ID = /^[A-Za-z0-9._~-]{1,200}$/;
const SAFE_USERNAME = /^[A-Za-z0-9._]{2,64}$/;
const SAFE_PUBLISH_ID = /^[A-Za-z0-9._~-]{1,64}$/;
const SAFE_SHA256 = /^[0-9a-f]{64}$/;
const DRAFT_COLUMNS =
  "id,owner,persona_id,account_id,platform,title,body,tags,media_url,content_kind,publish_at,approval_state,approved_content_hash,approved_preview_version,approved_preview_hash,approved_preview_target_id,approved_previewed_at,publish_state,provider_post_id,generated_by_agent";
const ALLOWED_ORIGINS = new Set([
  APP_ORIGIN,
  "https://aliaspaces.com",
  "https://www.aliaspaces.com",
  "https://app.aliaspaces.com",
  "https://mypersonas.online",
  "http://localhost:8000",
  "http://127.0.0.1:8000",
]);

const service = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

type PublishMode = "upload_inbox" | "direct_post";

type PostBody = {
  action?: string;
  draftId?: string;
  publishMode?: PublishMode;
  mediaSha256?: string;
  mediaMime?: string;
  mediaBytes?: number;
  settings?: Record<string, unknown>;
  previewVersion?: string;
  previewHash?: string;
  previewConfirmed?: boolean;
  executeConfirmed?: boolean;
  receiptId?: string;
  receiptHash?: string;
};

type Draft = {
  id: string;
  owner: string;
  persona_id: string | null;
  account_id: string | null;
  platform: string;
  title: string;
  body: string;
  tags: string;
  media_url: string;
  content_kind: string;
  publish_at: string | null;
  approval_state: string;
  approved_content_hash: string;
  approved_preview_version: string;
  approved_preview_hash: string;
  approved_preview_target_id: string;
  approved_previewed_at: string | null;
  publish_state: string;
  provider_post_id: string;
  generated_by_agent: boolean;
};

type Ledger = {
  id: string;
  owner: string;
  provider: string;
  persona_id: string | null;
  username: string | null;
  suspended: boolean;
};

type Connection = {
  ledger_id: string;
  provider_subject: string;
  provider_email: string;
  connection_state: string;
  verification_method: string;
  granted_scopes: unknown;
};

type Approval = {
  draft_id: string;
  owner: string;
  ledger_id: string;
  provider_open_id: string;
  approved_content_hash: string;
  preview_version: string;
  preview_hash: string;
  publish_mode: PublishMode;
  approved_media_sha256: string;
  approved_media_mime: string;
  approved_media_bytes: number;
  approved_media_url: string;
  approved_settings: Record<string, unknown>;
  approved_at: string;
};

type Token = {
  accessToken: string;
  refreshToken: string;
  tokenType: string;
  scopes: string[];
  openId: string;
  username: string;
  expiresAt: string;
  refreshExpiresAt: string;
};

type CreatorInfo = {
  username: string;
  nickname: string;
  avatarUrl: string;
  privacyOptions: string[];
  commentDisabled: boolean;
  duetDisabled: boolean;
  stitchDisabled: boolean;
  maxVideoDurationSeconds: number;
};

class ProviderOutcomeUncertainError extends Error {
  override name = "ProviderOutcomeUncertainError";
}

class ProviderAccessError extends Error {
  override name = "ProviderAccessError";
  status: number;
  code: string;
  constructor(
    message: string,
    status = 409,
    code = "tiktok_access_unavailable",
  ) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function cors(origin: string): HeadersInit {
  return {
    ...(ALLOWED_ORIGINS.has(origin)
      ? { "Access-Control-Allow-Origin": origin }
      : {}),
    "Access-Control-Allow-Headers": "authorization, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
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

function normalizeUsername(value: unknown) {
  return String(value || "").normalize("NFKC").trim().replace(/^@+/, "")
    .toLowerCase();
}

function normalizeScopes(value: unknown): string[] {
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string"
    ? value.split(/[\s,]+/)
    : [];
  return [
    ...new Set(
      raw.map((scope) => String(scope).trim().toLowerCase())
        .filter((scope) => /^[a-z0-9._:-]{1,128}$/.test(scope)),
    ),
  ].sort();
}

function hasScopes(scopes: string[], required: readonly string[]) {
  return required.every((scope) => scopes.includes(scope));
}

function requiredScopes(mode: PublishMode) {
  return [
    ...REQUIRED_IDENTITY_SCOPES,
    mode === "direct_post" ? "video.publish" : "video.upload",
  ];
}

function directConfigurationExplicit() {
  return DIRECT_POST_ENABLED &&
    (CLIENT_AUDIT_STATE === "audited" || CLIENT_AUDIT_STATE === "unaudited");
}

function caption(draft: Draft) {
  const main = String(draft.body || "").trim() ||
    String(draft.title || "").trim();
  const tags = String(draft.tags || "").trim();
  return [main, tags].filter(Boolean).join("\n\n");
}

function safeProviderMessage(payload: unknown, status: number) {
  const row = payload && typeof payload === "object"
    ? payload as Record<string, unknown>
    : null;
  const error = row?.error && typeof row.error === "object"
    ? row.error as Record<string, unknown>
    : null;
  const message = typeof error?.message === "string"
    ? error.message
    : typeof row?.error_description === "string"
    ? row.error_description
    : "";
  return message.trim().slice(0, 400) || `TikTok returned HTTP ${status}`;
}

function validMediaUrl(value: string, sha256: string) {
  if (!SAFE_SHA256.test(sha256) || !value.toLowerCase().includes(sha256)) {
    return false;
  }
  let candidate: URL;
  try {
    candidate = new URL(value);
  } catch {
    return false;
  }
  if (
    candidate.protocol !== "https:" || candidate.username ||
    candidate.password ||
    candidate.hash || !candidate.hostname.includes(".") ||
    candidate.hostname === "localhost" ||
    /^\d+(?:\.\d+){3}$/.test(candidate.hostname)
  ) return false;
  return VERIFIED_MEDIA_PREFIXES.some((rawPrefix) => {
    try {
      const prefix = new URL(rawPrefix);
      return prefix.protocol === "https:" && !prefix.username &&
        !prefix.password &&
        !prefix.search && !prefix.hash && candidate.origin === prefix.origin &&
        candidate.pathname.startsWith(
          prefix.pathname.endsWith("/")
            ? prefix.pathname
            : `${prefix.pathname}/`,
        );
    } catch {
      return false;
    }
  });
}

function exactKeys(value: Record<string, unknown>, expected: string[]) {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length &&
    keys.every((key, index) => key === [...expected].sort()[index]);
}

function normalizedSettings(mode: PublishMode, input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const settings = input as Record<string, unknown>;
  if (mode === "upload_inbox") {
    const keys = [
      "caption_not_transferred_acknowledged",
      "completion_required_in_tiktok",
      "explicit_upload_consent",
      "video_duration_seconds",
    ];
    const duration = Number(settings.video_duration_seconds);
    if (
      !exactKeys(settings, keys) || settings.explicit_upload_consent !== true ||
      settings.completion_required_in_tiktok !== true ||
      settings.caption_not_transferred_acknowledged !== true ||
      !Number.isFinite(duration) || duration <= 0 || duration > 600
    ) return null;
    return { ...settings, video_duration_seconds: duration };
  }
  const keys = [
    "brand_content_toggle",
    "brand_organic_toggle",
    "branded_content_policy_confirmed",
    "disable_comment",
    "disable_duet",
    "disable_stitch",
    "explicit_direct_post_consent",
    "is_aigc",
    "music_usage_confirmed",
    "privacy_level",
    "video_cover_timestamp_ms",
    "video_duration_seconds",
  ];
  if (!exactKeys(settings, keys)) return null;
  const boolKeys = keys.filter((key) =>
    ![
      "privacy_level",
      "video_cover_timestamp_ms",
      "video_duration_seconds",
    ].includes(key)
  );
  if (boolKeys.some((key) => typeof settings[key] !== "boolean")) return null;
  const privacy = String(settings.privacy_level || "");
  if (
    ![
      "PUBLIC_TO_EVERYONE",
      "MUTUAL_FOLLOW_FRIENDS",
      "FOLLOWER_OF_CREATOR",
      "SELF_ONLY",
    ].includes(privacy)
  ) return null;
  const duration = Number(settings.video_duration_seconds);
  const cover = Number(settings.video_cover_timestamp_ms);
  if (
    !Number.isFinite(duration) || duration <= 0 || duration > 600 ||
    !Number.isSafeInteger(cover) || cover < 0 || cover > duration * 1000 ||
    settings.music_usage_confirmed !== true ||
    settings.explicit_direct_post_consent !== true ||
    settings.branded_content_policy_confirmed !==
      settings.brand_content_toggle ||
    (settings.brand_content_toggle === true && privacy === "SELF_ONLY")
  ) return null;
  return {
    ...settings,
    privacy_level: privacy,
    video_duration_seconds: duration,
    video_cover_timestamp_ms: cover,
  };
}

async function ownerPause(owner: string) {
  const result = await service.from("agent_owner_settings")
    .select("automation_paused").eq("owner", owner).maybeSingle();
  return {
    available: !result.error && Boolean(result.data),
    paused: result.data?.automation_paused === true,
  };
}

async function loadDraft(owner: string, draftId: string) {
  const result = await service.from("drafts").select(DRAFT_COLUMNS)
    .eq("id", draftId).eq("owner", owner).maybeSingle();
  return { draft: result.data as Draft | null, error: Boolean(result.error) };
}

async function loadLedger(owner: string, ledgerId: string) {
  const result = await service.from("account_ledger")
    .select("id,owner,provider,persona_id,username,suspended")
    .eq("id", ledgerId).eq("owner", owner).eq("provider", "tiktok")
    .maybeSingle();
  return { ledger: result.data as Ledger | null, error: Boolean(result.error) };
}

async function loadConnection(owner: string, ledgerId: string) {
  const result = await service.from("account_connections")
    .select(
      "ledger_id,provider_subject,provider_email,connection_state,verification_method,granted_scopes",
    )
    .eq("ledger_id", ledgerId).eq("owner", owner).eq("provider", "tiktok")
    .maybeSingle();
  return {
    connection: result.data as Connection | null,
    error: Boolean(result.error),
  };
}

function validConnection(connection: Connection | null, mode: PublishMode) {
  return Boolean(
    connection && connection.connection_state === "connected" &&
      connection.verification_method === "tiktok_oauth2_pkce" &&
      SAFE_OPEN_ID.test(connection.provider_subject) &&
      SAFE_USERNAME.test(normalizeUsername(connection.provider_email)) &&
      hasScopes(
        normalizeScopes(connection.granted_scopes),
        requiredScopes(mode),
      ),
  );
}

async function currentAssignment(draft: Draft, ledger: Ledger) {
  if (!draft.persona_id || draft.account_id !== ledger.id) return false;
  const assigned = ledger.persona_id === draft.persona_id ? true : Boolean(
    (await service.from("account_persona_links").select("ledger_id")
      .eq("ledger_id", ledger.id).eq("owner", draft.owner)
      .eq("persona_id", draft.persona_id).maybeSingle()).data,
  );
  if (!assigned) return false;
  const binding = await service.from("agent_bindings")
    .select("id,status,claim_state,autonomy_level")
    .eq("owner", draft.owner).eq("persona_id", draft.persona_id).maybeSingle();
  if (
    binding.error || !binding.data || binding.data.status !== "active" ||
    !["self_attested", "verified"].includes(binding.data.claim_state) ||
    Number(binding.data.autonomy_level) < 2
  ) return false;
  const destination = await service.from("agent_destinations")
    .select("enabled,mode,allowed_content_types")
    .eq("owner", draft.owner).eq("binding_id", binding.data.id)
    .eq("persona_id", draft.persona_id).eq("account_id", ledger.id)
    .eq("destination", "tiktok").maybeSingle();
  return !destination.error && destination.data?.enabled === true &&
    ["manual", "approval", "auto"].includes(destination.data.mode) &&
    Array.isArray(destination.data.allowed_content_types) &&
    destination.data.allowed_content_types.includes(draft.content_kind);
}

async function exactDraftHash(draft: Draft) {
  const result = await service.rpc("agent_draft_hash", {
    p_title: draft.title || "",
    p_body: draft.body || "",
    p_tags: draft.tags || "",
    p_media_url: draft.media_url || "",
    p_content_kind: draft.content_kind || "",
    p_persona_id: draft.persona_id,
    p_account_id: draft.account_id,
    p_platform: draft.platform || "",
    p_publish_at: draft.publish_at,
  });
  return result.error ? "" : String(result.data || "");
}

async function exactGenericPreview(draft: Draft, providerTargetId: string) {
  const previewedAt = Date.parse(String(draft.approved_previewed_at || ""));
  if (
    draft.approved_preview_version !== "platform-preview-v1" ||
    draft.approved_preview_target_id !== providerTargetId ||
    !SAFE_SHA256.test(draft.approved_preview_hash) ||
    !Number.isFinite(previewedAt) || previewedAt > Date.now()
  ) return false;
  const result = await service.rpc("agent_draft_preview_hash", {
    p_content_hash: draft.approved_content_hash,
    p_preview_version: draft.approved_preview_version,
    p_preview_target_id: draft.approved_preview_target_id,
  });
  return !result.error &&
    String(result.data || "") === draft.approved_preview_hash;
}

async function previewHash(
  draft: Draft,
  ledger: Ledger,
  connection: Connection,
  mode: PublishMode,
  mediaSha256: string,
  mediaMime: string,
  mediaBytes: number,
  settings: Record<string, unknown>,
) {
  const result = await service.rpc("tiktok_preview_hash", {
    p_content_hash: draft.approved_content_hash,
    p_preview_version: PREVIEW_VERSION,
    p_ledger_id: ledger.id,
    p_provider_open_id: connection.provider_subject,
    p_publish_mode: mode,
    p_media_sha256: mediaSha256,
    p_media_mime: mediaMime,
    p_media_bytes: mediaBytes,
    p_media_url: draft.media_url,
    p_settings: settings,
  });
  return result.error ? "" : String(result.data || "");
}

async function claimLease(ledger: Ledger, kind: "publish" | "status") {
  const leaseId = crypto.randomUUID();
  const result = await service.rpc("claim_tiktok_token_operation", {
    p_ledger_id: ledger.id,
    p_owner: ledger.owner,
    p_lease_id: leaseId,
    p_operation_kind: kind,
    p_ttl_seconds: 120,
  });
  if (result.error || result.data !== true) {
    throw new ProviderAccessError(
      "Another TikTok authorization or posting operation is in progress.",
      409,
      "tiktok_lease_busy",
    );
  }
  return leaseId;
}

async function releaseLease(ledger: Ledger, leaseId: string) {
  await service.rpc("release_tiktok_token_operation", {
    p_ledger_id: ledger.id,
    p_owner: ledger.owner,
    p_lease_id: leaseId,
  });
}

async function markConnectionError(ledger: Ledger, code: string) {
  const now = new Date().toISOString();
  await service.from("account_connections").update({
    connection_state: "error",
    error_code: code,
    last_checked_at: now,
    updated_at: now,
  }).eq("ledger_id", ledger.id).eq("owner", ledger.owner)
    .eq("provider", "tiktok");
}

async function readToken(ledger: Ledger): Promise<Token> {
  const result = await service.rpc("tiktok_get_token_bundle", {
    p_ledger_id: ledger.id,
    p_owner: ledger.owner,
  });
  const row = (Array.isArray(result.data) ? result.data[0] : result.data) as
    | Record<string, unknown>
    | null;
  let bundle = row?.token_bundle as Record<string, unknown> | string | null;
  if (typeof bundle === "string") {
    try {
      bundle = JSON.parse(bundle) as Record<string, unknown>;
    } catch {
      bundle = null;
    }
  }
  const token: Token = {
    accessToken: String(bundle && bundle.access_token || ""),
    refreshToken: String(bundle && bundle.refresh_token || ""),
    tokenType: String(bundle && bundle.token_type || ""),
    scopes: normalizeScopes(bundle && bundle.scopes),
    openId: String(row?.provider_open_id || ""),
    username: normalizeUsername(row?.provider_username),
    expiresAt: String(bundle && bundle.expires_at || ""),
    refreshExpiresAt: String(bundle && bundle.refresh_expires_at || ""),
  };
  if (
    result.error || !token.accessToken || !token.refreshToken ||
    token.tokenType !== "bearer" || !SAFE_OPEN_ID.test(token.openId) ||
    !SAFE_USERNAME.test(token.username) ||
    !Number.isFinite(Date.parse(token.expiresAt))
  ) {
    throw new ProviderAccessError(
      "Reconnect this TikTok account.",
      409,
      "tiktok_token_invalid",
    );
  }
  return token;
}

async function refreshAtProvider(token: Token) {
  try {
    const response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "application/json",
        "Cache-Control": "no-cache",
      },
      body: new URLSearchParams({
        client_key: TIKTOK_CLIENT_KEY,
        client_secret: TIKTOK_CLIENT_SECRET,
        grant_type: "refresh_token",
        refresh_token: token.refreshToken,
      }),
      redirect: "error",
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });
    const payload = await response.json().catch(() => null) as
      | Record<string, unknown>
      | null;
    if (
      !response.ok || !payload || typeof payload.access_token !== "string" ||
      typeof payload.refresh_token !== "string" ||
      String(payload.token_type || "").toLowerCase() !== "bearer" ||
      !SAFE_OPEN_ID.test(String(payload.open_id || ""))
    ) {
      if (
        response.status === 408 || response.status >= 500 ||
        (response.ok && !payload)
      ) {
        throw new ProviderOutcomeUncertainError(
          "TikTok token rotation had no durable result",
        );
      }
      throw new ProviderAccessError(
        "TikTok rejected the stored authorization. Reconnect.",
        401,
        "tiktok_refresh_rejected",
      );
    }
    const accessSeconds = Number(payload.expires_in);
    const refreshSeconds = Number(payload.refresh_expires_in);
    return {
      ...token,
      accessToken: payload.access_token,
      refreshToken: payload.refresh_token,
      openId: String(payload.open_id),
      scopes: normalizeScopes(payload.scope).length
        ? normalizeScopes(payload.scope)
        : token.scopes,
      expiresAt: new Date(
        Date.now() + Math.min(172_800, Math.max(60, accessSeconds)) * 1000,
      ).toISOString(),
      refreshExpiresAt: new Date(
        Date.now() +
          Math.min(400 * 86_400, Math.max(60, refreshSeconds)) * 1000,
      ).toISOString(),
    } as Token;
  } catch (error) {
    if (
      error instanceof ProviderAccessError ||
      error instanceof ProviderOutcomeUncertainError
    ) throw error;
    throw new ProviderOutcomeUncertainError(
      "TikTok token rotation had no durable result",
    );
  }
}

async function fetchIdentity(accessToken: string, expectedOpenId: string) {
  try {
    const response = await fetch(USER_URL, {
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Accept": "application/json",
      },
      redirect: "error",
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });
    const payload = await response.json().catch(() => null) as
      | Record<string, unknown>
      | null;
    if (
      response.status === 408 || response.status >= 500 ||
      (response.ok && !payload)
    ) {
      throw new ProviderOutcomeUncertainError(
        "TikTok identity lookup had no durable result",
      );
    }
    const error = payload?.error as Record<string, unknown> | undefined;
    const data = payload?.data as Record<string, unknown> | undefined;
    const user = data?.user as Record<string, unknown> | undefined;
    const openId = String(user?.open_id || "");
    const username = normalizeUsername(user?.username);
    if (
      !response.ok || String(error?.code || "") !== "ok" ||
      openId !== expectedOpenId || !SAFE_USERNAME.test(username)
    ) {
      throw new ProviderAccessError(
        "The connected TikTok identity no longer matches.",
        409,
        "tiktok_identity_mismatch",
      );
    }
    return { openId, username };
  } catch (error) {
    if (
      error instanceof ProviderAccessError ||
      error instanceof ProviderOutcomeUncertainError
    ) throw error;
    throw new ProviderOutcomeUncertainError(
      "TikTok identity lookup had no durable result",
    );
  }
}

async function storeRefreshedToken(ledger: Ledger, token: Token) {
  return await service.rpc("tiktok_store_token_bundle", {
    p_ledger_id: ledger.id,
    p_owner: ledger.owner,
    p_expected_ledger_username: normalizeUsername(ledger.username),
    p_provider_open_id: token.openId,
    p_provider_username: token.username,
    p_access_token: token.accessToken,
    p_refresh_token: token.refreshToken,
    p_token_type: token.tokenType,
    p_scopes: token.scopes,
    p_expires_at: token.expiresAt,
    p_refresh_expires_at: token.refreshExpiresAt,
  });
}

async function verifiedAccess(
  ledger: Ledger,
  connection: Connection,
  mode: PublishMode,
) {
  if (!TIKTOK_CLIENT_KEY || !TIKTOK_CLIENT_SECRET) {
    throw new ProviderAccessError(
      "TikTok client credentials are not configured.",
      503,
      "tiktok_client_unconfigured",
    );
  }
  let token = await readToken(ledger);
  const required = requiredScopes(mode);
  if (
    token.openId !== connection.provider_subject ||
    token.username !== normalizeUsername(connection.provider_email) ||
    token.username !== normalizeUsername(ledger.username) ||
    !hasScopes(token.scopes, required)
  ) {
    throw new ProviderAccessError(
      "Reconnect the exact TikTok account with the required permission.",
      409,
      "tiktok_scope_or_identity_mismatch",
    );
  }
  if (Date.parse(token.expiresAt) <= Date.now() + TOKEN_REFRESH_SKEW_MS) {
    try {
      token = await refreshAtProvider(token);
    } catch (error) {
      await markConnectionError(
        ledger,
        error instanceof ProviderOutcomeUncertainError
          ? "tiktok_manual_revoke_required"
          : "tiktok_refresh_rejected",
      );
      throw error;
    }
    if (
      token.openId !== connection.provider_subject ||
      !hasScopes(token.scopes, required)
    ) {
      throw new ProviderAccessError(
        "The refreshed TikTok grant changed identity or scope.",
        409,
        "tiktok_refreshed_grant_invalid",
      );
    }
    const stored = await storeRefreshedToken(ledger, token);
    if (stored.error) {
      await markConnectionError(ledger, "tiktok_manual_revoke_required");
      throw new ProviderOutcomeUncertainError(
        "TikTok rotated the token but local storage failed; revoke manually",
      );
    }
  }
  const identity = await fetchIdentity(token.accessToken, token.openId);
  if (identity.username !== normalizeUsername(ledger.username)) {
    await markConnectionError(ledger, "tiktok_identity_mismatch");
    throw new ProviderAccessError(
      "The connected TikTok username no longer matches.",
      409,
      "tiktok_identity_mismatch",
    );
  }
  return token;
}

async function creatorInfo(accessToken: string): Promise<CreatorInfo> {
  try {
    const response = await fetch(CREATOR_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Content-Type": "application/json; charset=UTF-8",
        "Accept": "application/json",
      },
      body: "{}",
      redirect: "error",
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });
    const payload = await response.json().catch(() => null) as
      | Record<string, unknown>
      | null;
    if (
      response.status === 408 || response.status >= 500 ||
      (response.ok && !payload)
    ) {
      throw new ProviderOutcomeUncertainError(
        "TikTok creator-info lookup had no durable result",
      );
    }
    const error = payload?.error as Record<string, unknown> | undefined;
    const data = payload?.data as Record<string, unknown> | undefined;
    if (!response.ok || String(error?.code || "") !== "ok" || !data) {
      throw new ProviderAccessError(
        safeProviderMessage(payload, response.status),
        409,
        "tiktok_creator_info_failed",
      );
    }
    const result: CreatorInfo = {
      username: normalizeUsername(data.creator_username),
      nickname: String(data.creator_nickname || "").trim().slice(0, 160),
      avatarUrl: String(data.creator_avatar_url || "").trim().slice(0, 2048),
      privacyOptions: Array.isArray(data.privacy_level_options)
        ? data.privacy_level_options.map(String).filter((value) =>
          [
            "PUBLIC_TO_EVERYONE",
            "MUTUAL_FOLLOW_FRIENDS",
            "FOLLOWER_OF_CREATOR",
            "SELF_ONLY",
          ].includes(value)
        )
        : [],
      commentDisabled: data.comment_disabled === true,
      duetDisabled: data.duet_disabled === true,
      stitchDisabled: data.stitch_disabled === true,
      maxVideoDurationSeconds: Number(data.max_video_post_duration_sec),
    };
    if (
      !SAFE_USERNAME.test(result.username) || !result.privacyOptions.length ||
      !Number.isFinite(result.maxVideoDurationSeconds) ||
      result.maxVideoDurationSeconds <= 0
    ) {
      throw new ProviderAccessError(
        "TikTok returned incomplete creator posting options.",
        409,
        "tiktok_creator_info_invalid",
      );
    }
    return result;
  } catch (error) {
    if (
      error instanceof ProviderAccessError ||
      error instanceof ProviderOutcomeUncertainError
    ) throw error;
    throw new ProviderOutcomeUncertainError(
      "TikTok creator-info lookup had no durable result",
    );
  }
}

function directSettingsMatchCreator(
  settings: Record<string, unknown>,
  creator: CreatorInfo,
  ledger: Ledger,
) {
  return creator.username === normalizeUsername(ledger.username) &&
    creator.privacyOptions.includes(String(settings.privacy_level)) &&
    (!creator.commentDisabled || settings.disable_comment === true) &&
    (!creator.duetDisabled || settings.disable_duet === true) &&
    (!creator.stitchDisabled || settings.disable_stitch === true) &&
    Number(settings.video_duration_seconds) <=
      creator.maxVideoDurationSeconds &&
    (CLIENT_AUDIT_STATE !== "unaudited" ||
      settings.privacy_level === "SELF_ONLY");
}

async function loadContext(
  owner: string,
  draftId: string,
  mode: PublishMode,
) {
  const draftResult = await loadDraft(owner, draftId);
  const draft = draftResult.draft;
  if (draftResult.error) {
    throw new ProviderAccessError("The draft could not be verified.", 503);
  }
  if (!draft) throw new ProviderAccessError("Owned draft not found.", 404);
  if (
    draft.platform !== "tiktok" || !draft.account_id || !draft.persona_id ||
    !["video", "reel"].includes(
      String(draft.content_kind || "").toLowerCase(),
    ) ||
    !draft.media_url
  ) {
    throw new ProviderAccessError(
      "This is not a TikTok video draft assigned to an account.",
      409,
    );
  }
  if (
    draft.approval_state !== "approved" ||
    !SAFE_SHA256.test(draft.approved_content_hash)
  ) {
    throw new ProviderAccessError(
      "Approve the exact generic draft before its TikTok preview.",
      409,
    );
  }
  if (mode === "direct_post" && !directConfigurationExplicit()) {
    throw new ProviderAccessError(
      "TikTok Direct Post is not explicitly released for the configured audit state.",
      409,
    );
  }
  const [ledgerResult, connectionResult] = await Promise.all([
    loadLedger(owner, draft.account_id),
    loadConnection(owner, draft.account_id),
  ]);
  const ledger = ledgerResult.ledger;
  const connection = connectionResult.connection;
  if (ledgerResult.error || !ledger || ledger.suspended) {
    throw new ProviderAccessError(
      "The TikTok destination is missing or suspended.",
      409,
    );
  }
  if (connectionResult.error || !validConnection(connection, mode)) {
    throw new ProviderAccessError(
      "Reconnect this TikTok account with the required content permission.",
      409,
    );
  }
  if (!await exactGenericPreview(draft, connection!.provider_subject)) {
    throw new ProviderAccessError(
      "Approve the current TikTok platform preview for this exact connected account before continuing.",
      409,
    );
  }
  if (!await currentAssignment(draft, ledger)) {
    throw new ProviderAccessError(
      "The TikTok account or destination is no longer assigned and enabled for this persona.",
      409,
    );
  }
  const hash = await exactDraftHash(draft);
  if (!hash || hash !== draft.approved_content_hash) {
    throw new ProviderAccessError(
      "The generic approval no longer matches this exact draft.",
      409,
    );
  }
  return { draft, ledger, connection: connection! };
}

async function buildPreview(
  owner: string,
  body: PostBody,
) {
  const mode = body.publishMode === "direct_post"
    ? "direct_post"
    : body.publishMode === "upload_inbox"
    ? "upload_inbox"
    : null;
  if (!mode) {
    throw new ProviderAccessError(
      "Choose Upload to inbox or Direct Post.",
      400,
    );
  }
  const draftId = String(body.draftId || "");
  if (!SAFE_UUID.test(draftId)) {
    throw new ProviderAccessError("Invalid draft id.", 400);
  }
  const mediaSha256 = String(body.mediaSha256 || "").toLowerCase();
  const mediaMime = String(body.mediaMime || "").toLowerCase();
  const mediaBytes = Number(body.mediaBytes);
  if (
    !SAFE_SHA256.test(mediaSha256) ||
    !["video/mp4", "video/quicktime", "video/webm"].includes(mediaMime) ||
    !Number.isSafeInteger(mediaBytes) || mediaBytes < 1 ||
    mediaBytes > 4_294_967_296
  ) {
    throw new ProviderAccessError(
      "Exact TikTok video checksum, MIME, and byte size are required.",
      409,
    );
  }
  const settings = normalizedSettings(mode, body.settings);
  if (!settings) {
    throw new ProviderAccessError(
      "TikTok privacy, interaction, commercial, AI, music, duration, or consent choices are incomplete.",
      409,
    );
  }
  const context = await loadContext(owner, draftId, mode);
  if (!validMediaUrl(context.draft.media_url, mediaSha256)) {
    throw new ProviderAccessError(
      "The approved video URL must be content-addressed and under an exact TikTok-verified HTTPS prefix.",
      409,
    );
  }
  const leaseId = await claimLease(context.ledger, "status");
  try {
    const token = await verifiedAccess(
      context.ledger,
      context.connection,
      mode,
    );
    let creator: CreatorInfo | null = null;
    if (mode === "direct_post") {
      creator = await creatorInfo(token.accessToken);
      if (!directSettingsMatchCreator(settings, creator, context.ledger)) {
        throw new ProviderAccessError(
          "Refresh the TikTok creator options and choose valid privacy, interaction, and duration settings.",
          409,
        );
      }
      const text = caption(context.draft);
      if (text.length > 2200) {
        throw new ProviderAccessError(
          "The exact TikTok caption exceeds 2,200 UTF-16 code units.",
          409,
        );
      }
    }
    const hash = await previewHash(
      context.draft,
      context.ledger,
      context.connection,
      mode,
      mediaSha256,
      mediaMime,
      mediaBytes,
      settings,
    );
    if (!SAFE_SHA256.test(hash)) {
      throw new ProviderAccessError(
        "The TikTok preview proof could not be built.",
        503,
      );
    }
    return {
      ...context,
      mode,
      mediaSha256,
      mediaMime,
      mediaBytes,
      settings,
      creator,
      hash,
      platformPreview: {
        platform: "TikTok",
        previewVersion: PREVIEW_VERSION,
        previewHash: hash,
        account: {
          username: normalizeUsername(context.ledger.username),
          providerOpenId: context.connection.provider_subject,
        },
        mode,
        scheduledFor: context.draft.publish_at,
        video: {
          url: context.draft.media_url,
          sha256: mediaSha256,
          mime: mediaMime,
          bytes: mediaBytes,
          durationSeconds: settings.video_duration_seconds,
          displayAspectRatio: "9:16",
        },
        caption: mode === "direct_post"
          ? caption(context.draft)
          : "Not transferred by Upload API; finish the caption in TikTok.",
        settings,
        creator,
        completionRequiredInTikTok: mode === "upload_inbox",
        requiresExplicitAcknowledgement: true,
        editInvalidatesApproval: true,
      },
    };
  } finally {
    await releaseLease(context.ledger, leaseId);
  }
}

async function preparePreview(origin: string, owner: string, body: PostBody) {
  try {
    const preview = await buildPreview(owner, body);
    const saved = await service.rpc("store_tiktok_draft_approval_service", {
      p_draft_id: preview.draft.id,
      p_owner: owner,
      p_ledger_id: preview.ledger.id,
      p_provider_open_id: preview.connection.provider_subject,
      p_content_hash: preview.draft.approved_content_hash,
      p_preview_version: PREVIEW_VERSION,
      p_preview_hash: preview.hash,
      p_publish_mode: preview.mode,
      p_media_sha256: preview.mediaSha256,
      p_media_mime: preview.mediaMime,
      p_media_bytes: preview.mediaBytes,
      p_media_url: preview.draft.media_url,
      p_settings: preview.settings,
    });
    if (saved.error || !saved.data) {
      return json(origin, 409, {
        error: "The exact TikTok server preview snapshot could not be stored.",
      });
    }
    const action = `tiktok.${preview.mode}`;
    const targetLabel = preview.ledger.username
      ? `@${normalizeUsername(preview.ledger.username)}`
      : "Connected TikTok account";
    const receipt = await service.rpc(
      "prepare_provider_action_preview_service",
      {
        p_owner: owner,
        p_draft_id: preview.draft.id,
        p_ledger_id: preview.ledger.id,
        p_provider: "tiktok",
        p_action: action,
        p_target_id: preview.connection.provider_subject,
        p_content_hash: preview.draft.approved_content_hash,
        p_action_hash: preview.hash,
        p_preview_version: PREVIEW_VERSION,
        p_preview_payload: {
          rendererVersion: PREVIEW_VERSION,
          items: [{
            provider: "tiktok",
            account: targetLabel,
            accountId: preview.connection.provider_subject,
            placement: preview.mode === "direct_post"
              ? "TikTok For You vertical feed"
              : "TikTok inbox upload review",
            requiresExactTarget: true,
            exactTargetReady: true,
            title: "",
            text: preview.mode === "direct_post"
              ? caption(preview.draft)
              : "Caption is not transferred by Upload API; finish it in TikTok.",
            tags: "",
            mediaUrl: preview.draft.media_url,
            mediaKind: "video",
            mediaItems: [{
              url: preview.draft.media_url,
              kind: "video",
              label: "Exact verified TikTok video",
            }],
            requiresMedia: true,
            requiredMediaMissing: !preview.draft.media_url,
            scheduledFor: null,
            mode: preview.mode === "direct_post"
              ? "TikTok Direct Post"
              : "TikTok inbox upload",
            timingLabel: "Immediately after acknowledgement",
            platformDetails: [
              `Exact TikTok open_id: ${preview.connection.provider_subject}`,
              `Video SHA-256: ${preview.mediaSha256}`,
              `Visibility: ${
                String(
                  (preview.settings as Record<string, unknown>).privacy_level ||
                    "Chosen in TikTok",
                )
              }`,
              preview.mode === "upload_inbox"
                ? "Owner must finish the post in TikTok"
                : "Direct Post settings and consent are bound to this receipt",
            ],
          }],
          exactTikTokPreview: preview.platformPreview,
        },
      },
    );
    if (receipt.error || !receipt.data) {
      return json(origin, 409, {
        error: receipt.error?.message ||
          "The TikTok action receipt could not be prepared.",
      });
    }
    const prepared = receipt.data as Record<string, unknown>;
    return json(origin, 200, {
      prepared: true,
      receipt: prepared,
      preview: prepared.preview as Record<string, unknown>,
    });
  } catch (error) {
    if (error instanceof ProviderAccessError) {
      return json(origin, error.status, {
        error: error.message,
        code: error.code,
      });
    }
    return json(origin, 502, {
      error: "TikTok preview readiness could not be verified.",
    });
  }
}

async function acknowledgePreview(
  origin: string,
  userClient: typeof service,
  body: PostBody,
) {
  const receiptId = String(body.receiptId || "");
  const receiptHash = String(body.receiptHash || "");
  if (
    !SAFE_UUID.test(receiptId) || !SAFE_SHA256.test(receiptHash) ||
    body.previewVersion !== PREVIEW_VERSION
  ) {
    return json(origin, 409, {
      error:
        "The exact rendered TikTok server receipt is required for acknowledgement.",
    });
  }
  const acknowledged = await userClient.rpc(
    "acknowledge_provider_action_preview",
    {
      p_receipt_id: receiptId,
      p_receipt_hash: receiptHash,
      p_preview_version: PREVIEW_VERSION,
    },
  );
  if (acknowledged.error || !acknowledged.data) {
    return json(origin, 409, {
      error: acknowledged.error?.message ||
        "The TikTok preview could not be acknowledged.",
    });
  }
  return json(origin, 200, acknowledged.data as Record<string, unknown>);
}

async function loadApproval(owner: string, draftId: string) {
  const result = await service.from("tiktok_draft_approvals").select("*")
    .eq("draft_id", draftId).eq("owner", owner).maybeSingle();
  return {
    approval: result.data as Approval | null,
    error: Boolean(result.error),
  };
}

async function writeAudit(
  draft: Draft,
  action: string,
  outcome: "ok" | "error",
  detail: Record<string, unknown>,
) {
  const result = await service.rpc("insert_agent_action_service", {
    p_owner: draft.owner,
    p_persona_id: draft.persona_id,
    p_binding_id: null,
    p_action_type: action,
    p_entity_type: "draft",
    p_entity_id: draft.id,
    p_outcome: outcome,
    p_detail: {
      account_id: draft.account_id,
      approved_content_hash: draft.approved_content_hash,
      ...detail,
    },
  });
  return !result.error;
}

async function definitiveFailure(
  origin: string,
  draft: Draft,
  message: string,
  status = 502,
) {
  const saved = await service.from("drafts").update({
    publish_state: "failed",
    publish_error: message.slice(0, 500),
  }).eq("id", draft.id).eq("owner", draft.owner)
    .eq("publish_state", "publishing").eq("provider_post_id", "")
    .select("id").maybeSingle();
  const auditWritten = await writeAudit(
    draft,
    "publish_external_tiktok",
    "error",
    {
      error: message,
      retry_safe: !saved.error && Boolean(saved.data),
      reconciliation_required: saved.error || !saved.data,
    },
  );
  return json(origin, saved.error || !saved.data ? 500 : status, {
    status: saved.error || !saved.data ? "unknown" : "failed",
    error: saved.error || !saved.data
      ? "The safe TikTok failure could not be checkpointed. Reconcile before any retry."
      : message,
    reconciliationRequired: saved.error || !saved.data,
    ...(auditWritten ? {} : { auditMissing: true }),
  });
}

async function uncertain(
  origin: string,
  draft: Draft,
  message: string,
  providerPostId = "",
) {
  const note = `${message} Do not retry until this TikTok draft is reconciled.`
    .slice(0, 500);
  const saved = await service.from("drafts").update({ publish_error: note })
    .eq("id", draft.id).eq("owner", draft.owner)
    .eq("publish_state", "publishing").select("id").maybeSingle();
  const auditWritten = await writeAudit(
    draft,
    "publish_external_tiktok",
    "error",
    {
      error: note,
      retry_safe: false,
      reconciliation_required: true,
      ...(providerPostId ? { provider_publish_id: providerPostId } : {}),
    },
  );
  return json(origin, 202, {
    status: saved.error || !saved.data ? "unknown" : "publishing",
    error: note,
    reconciliationRequired: true,
    ...(providerPostId ? { providerPublishId: providerPostId } : {}),
    ...(auditWritten ? {} : { auditMissing: true }),
  });
}

function providerBody(draft: Draft, approval: Approval) {
  if (approval.publish_mode === "upload_inbox") {
    return {
      source_info: {
        source: "PULL_FROM_URL",
        video_url: approval.approved_media_url,
      },
    };
  }
  const settings = approval.approved_settings;
  return {
    post_info: {
      title: caption(draft),
      privacy_level: settings.privacy_level,
      disable_comment: settings.disable_comment,
      disable_duet: settings.disable_duet,
      disable_stitch: settings.disable_stitch,
      video_cover_timestamp_ms: settings.video_cover_timestamp_ms,
      brand_content_toggle: settings.brand_content_toggle,
      brand_organic_toggle: settings.brand_organic_toggle,
      is_aigc: settings.is_aigc,
    },
    source_info: {
      source: "PULL_FROM_URL",
      video_url: approval.approved_media_url,
    },
  };
}

async function sendApproved(
  origin: string,
  owner: string,
  draftId: string,
  receiptId: string,
) {
  if (!SAFE_UUID.test(draftId) || !SAFE_UUID.test(receiptId)) {
    return json(origin, 400, {
      error: "Valid draft and acknowledged one-shot receipt ids are required",
    });
  }
  const [draftResult, approvalResult, pause] = await Promise.all([
    loadDraft(owner, draftId),
    loadApproval(owner, draftId),
    ownerPause(owner),
  ]);
  const draft = draftResult.draft;
  const approval = approvalResult.approval;
  if (!pause.available) {
    return json(origin, 503, {
      error:
        "The global automation pause could not be verified. Nothing was sent.",
    });
  }
  if (pause.paused) {
    return json(origin, 409, {
      error: "The global automation pause is on. Nothing was sent.",
    });
  }
  if (draftResult.error || approvalResult.error) {
    return json(origin, 503, {
      error: "The exact TikTok approval could not be verified.",
    });
  }
  if (!draft || !approval) {
    return json(origin, 409, {
      error: "Approve the exact TikTok platform preview before sending.",
    });
  }
  if (
    draft.approval_state !== "approved" ||
    draft.approved_content_hash !== approval.approved_content_hash ||
    draft.account_id !== approval.ledger_id || draft.platform !== "tiktok"
  ) {
    return json(origin, 409, {
      error: "The TikTok preview approval no longer matches this draft.",
    });
  }
  if (draft.provider_post_id) {
    return json(origin, 409, {
      error:
        "This draft already has a durable TikTok publish identifier. Reconcile it instead of retrying.",
      providerPublishId: draft.provider_post_id,
    });
  }
  if (["publishing", "published"].includes(draft.publish_state)) {
    return json(origin, 409, {
      error: "This TikTok draft is already publishing or published.",
    });
  }
  if (draft.publish_at && Date.parse(draft.publish_at) > Date.now()) {
    return json(origin, 409, {
      error:
        "This preview-approved TikTok handoff is scheduled for later. No unattended scheduler is enabled yet.",
      scheduledFor: draft.publish_at,
    });
  }
  if (!await exactGenericPreview(draft, approval.provider_open_id)) {
    return json(origin, 409, {
      error:
        "The durable TikTok platform preview no longer matches this exact connected account.",
    });
  }
  const claim = await service.rpc("claim_tiktok_publish_with_preview_service", {
    p_owner: owner,
    p_draft_id: draft.id,
    p_receipt_id: receiptId,
  });
  if (claim.error || !claim.data) {
    return json(origin, 409, {
      error: claim.error?.message ||
        "The TikTok preview receipt or exact draft could not be claimed atomically.",
    });
  }
  const claimPayload = claim.data as { claimId?: unknown; draft?: unknown };
  const claimed = claimPayload.draft as Draft | undefined;
  if (
    claimPayload.claimId !== draft.id || !claimed ||
    claimed.id !== draft.id || claimed.owner !== owner ||
    claimed.publish_state !== "publishing"
  ) {
    return json(origin, 503, {
      error:
        "The atomic TikTok claim returned an invalid durable checkpoint. Nothing was sent.",
    });
  }

  const exactHash = await exactDraftHash(claimed);
  const expectedPreview = await service.rpc("tiktok_preview_hash", {
    p_content_hash: claimed.approved_content_hash,
    p_preview_version: approval.preview_version,
    p_ledger_id: approval.ledger_id,
    p_provider_open_id: approval.provider_open_id,
    p_publish_mode: approval.publish_mode,
    p_media_sha256: approval.approved_media_sha256,
    p_media_mime: approval.approved_media_mime,
    p_media_bytes: approval.approved_media_bytes,
    p_media_url: approval.approved_media_url,
    p_settings: approval.approved_settings,
  });
  const settings = normalizedSettings(
    approval.publish_mode,
    approval.approved_settings,
  );
  if (
    exactHash !== claimed.approved_content_hash || expectedPreview.error ||
    !await exactGenericPreview(claimed, approval.provider_open_id) ||
    String(expectedPreview.data || "") !== approval.preview_hash ||
    approval.preview_version !== PREVIEW_VERSION || !settings ||
    claimed.media_url !== approval.approved_media_url ||
    !validMediaUrl(approval.approved_media_url, approval.approved_media_sha256)
  ) {
    return await definitiveFailure(
      origin,
      claimed,
      "The exact TikTok preview, settings, or approved video no longer match.",
      409,
    );
  }
  if (
    approval.publish_mode === "direct_post" && !directConfigurationExplicit()
  ) {
    return await definitiveFailure(
      origin,
      claimed,
      "TikTok Direct Post is no longer explicitly released for the configured audit state.",
      409,
    );
  }

  const [pauseAgain, ledgerResult, connectionResult] = await Promise.all([
    ownerPause(owner),
    loadLedger(owner, approval.ledger_id),
    loadConnection(owner, approval.ledger_id),
  ]);
  const ledger = ledgerResult.ledger;
  const connection = connectionResult.connection;
  if (!pauseAgain.available || pauseAgain.paused) {
    return await definitiveFailure(
      origin,
      claimed,
      "The global automation pause changed before the TikTok request. Nothing was sent.",
      409,
    );
  }
  if (
    ledgerResult.error || !ledger || ledger.suspended ||
    connectionResult.error ||
    !validConnection(connection, approval.publish_mode) ||
    connection?.provider_subject !== approval.provider_open_id ||
    !await currentAssignment(claimed, ledger)
  ) {
    return await definitiveFailure(
      origin,
      claimed,
      "The TikTok destination, assignment, identity, or scope changed. Nothing was sent.",
      409,
    );
  }

  let leaseId = "";
  try {
    leaseId = await claimLease(ledger, "publish");
    const token = await verifiedAccess(
      ledger,
      connection!,
      approval.publish_mode,
    );
    if (approval.publish_mode === "direct_post") {
      const creator = await creatorInfo(token.accessToken);
      if (!directSettingsMatchCreator(settings, creator, ledger)) {
        return await definitiveFailure(
          origin,
          claimed,
          "TikTok creator privacy, interaction, identity, or duration options changed. Refresh and approve a new preview.",
          409,
        );
      }
      if (caption(claimed).length > 2200) {
        return await definitiveFailure(
          origin,
          claimed,
          "The exact TikTok caption exceeds 2,200 UTF-16 code units.",
          409,
        );
      }
    }

    const [lastPause, lastLedger, lastConnection] = await Promise.all([
      ownerPause(owner),
      loadLedger(owner, ledger.id),
      loadConnection(owner, ledger.id),
    ]);
    if (
      !lastPause.available || lastPause.paused || lastLedger.error ||
      !lastLedger.ledger || lastLedger.ledger.suspended ||
      lastConnection.error ||
      !validConnection(lastConnection.connection, approval.publish_mode) ||
      lastConnection.connection?.provider_subject !== token.openId ||
      !await currentAssignment(claimed, lastLedger.ledger)
    ) {
      return await definitiveFailure(
        origin,
        claimed,
        "The TikTok safety state changed immediately before the provider request. Nothing was sent.",
        409,
      );
    }

    const audited = await writeAudit(claimed, "publish_external_tiktok", "ok", {
      phase: "provider_request_start",
      retry_safe: false,
      provider_open_id: token.openId,
      publish_mode: approval.publish_mode,
      preview_hash: approval.preview_hash,
      media_sha256: approval.approved_media_sha256,
      settings,
    });
    if (!audited) {
      return await definitiveFailure(
        origin,
        claimed,
        "The TikTok provider request could not be audited. Nothing was sent.",
        503,
      );
    }

    let response: Response;
    try {
      response = await fetch(
        approval.publish_mode === "direct_post"
          ? DIRECT_INIT_URL
          : UPLOAD_INIT_URL,
        {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${token.accessToken}`,
            "Content-Type": "application/json; charset=UTF-8",
            "Accept": "application/json",
          },
          body: JSON.stringify(providerBody(claimed, approval)),
          redirect: "error",
          signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
        },
      );
    } catch {
      return await uncertain(
        origin,
        claimed,
        "TikTok did not return a durable result for the initialize request.",
      );
    }
    if (response.status === 408 || response.status >= 500) {
      return await uncertain(
        origin,
        claimed,
        `TikTok returned HTTP ${response.status} after the initialize request.`,
      );
    }
    const payload = await response.json().catch(() => null) as
      | Record<string, unknown>
      | null;
    if (response.ok && !payload) {
      return await uncertain(
        origin,
        claimed,
        "TikTok accepted the initialize request but returned no readable result.",
      );
    }
    const providerError = payload?.error as Record<string, unknown> | undefined;
    if (!response.ok || String(providerError?.code || "") !== "ok") {
      if (response.status === 401) {
        await markConnectionError(ledger, "tiktok_access_rejected");
      }
      return await definitiveFailure(
        origin,
        claimed,
        safeProviderMessage(payload, response.status),
        response.status === 429 ? 429 : 502,
      );
    }
    const data = payload?.data as Record<string, unknown> | undefined;
    const publishId = String(data?.publish_id || "");
    if (!SAFE_PUBLISH_ID.test(publishId)) {
      return await uncertain(
        origin,
        claimed,
        "TikTok accepted the initialize request but returned no durable publish identifier.",
      );
    }

    const checkpoint = await service.from("drafts").update({
      provider_post_id: publishId,
      publish_error: approval.publish_mode === "upload_inbox"
        ? "TikTok accepted the video for inbox delivery; finish and post it in TikTok."
        : "TikTok accepted the Direct Post job; final status is pending.",
    }).eq("id", claimed.id).eq("owner", owner).eq("publish_state", "publishing")
      .eq("provider_post_id", "").select("provider_post_id").maybeSingle();
    if (checkpoint.error || checkpoint.data?.provider_post_id !== publishId) {
      const reread = await service.from("drafts").select("provider_post_id")
        .eq("id", claimed.id).eq("owner", owner).maybeSingle();
      if (reread.error || reread.data?.provider_post_id !== publishId) {
        return await uncertain(
          origin,
          claimed,
          `TikTok accepted ${publishId}, but its durable identifier could not be verified locally.`,
          publishId,
        );
      }
    }
    await writeAudit(claimed, "publish_external_tiktok", "ok", {
      phase: "provider_id_checkpointed",
      provider_publish_id: publishId,
      publish_mode: approval.publish_mode,
      status: approval.publish_mode === "upload_inbox"
        ? "awaiting_tiktok_completion"
        : "processing",
    });
    return json(origin, 202, {
      status: approval.publish_mode === "upload_inbox"
        ? "awaiting_tiktok_completion"
        : "processing",
      providerPublishId: publishId,
      publishMode: approval.publish_mode,
      completionRequiredInTikTok: approval.publish_mode === "upload_inbox",
      reconciliationRequired: true,
      message: approval.publish_mode === "upload_inbox"
        ? "TikTok is preparing the video. Open the TikTok inbox notification to edit and complete the post."
        : "TikTok accepted the Direct Post job. Check status before treating it as published.",
    });
  } catch (error) {
    if (error instanceof ProviderOutcomeUncertainError) {
      return await uncertain(origin, claimed, error.message);
    }
    if (error instanceof ProviderAccessError) {
      return await definitiveFailure(
        origin,
        claimed,
        error.message,
        error.status,
      );
    }
    return await uncertain(
      origin,
      claimed,
      "The TikTok request ended without a durable result.",
    );
  } finally {
    if (leaseId) await releaseLease(ledger, leaseId);
  }
}

async function reconcileStatus(origin: string, owner: string, draftId: string) {
  if (!SAFE_UUID.test(draftId)) {
    return json(origin, 400, { error: "Invalid draft id" });
  }
  const [draftResult, approvalResult] = await Promise.all([
    loadDraft(owner, draftId),
    loadApproval(owner, draftId),
  ]);
  const draft = draftResult.draft;
  const approval = approvalResult.approval;
  if (draftResult.error || approvalResult.error) {
    return json(origin, 503, {
      error: "TikTok status context could not be verified",
    });
  }
  if (!draft || !approval || !SAFE_PUBLISH_ID.test(draft.provider_post_id)) {
    return json(origin, 409, {
      error: "No checkpointed TikTok publish identifier is available",
    });
  }
  if (
    draft.account_id !== approval.ledger_id ||
    draft.approved_content_hash !== approval.approved_content_hash
  ) {
    return json(origin, 409, {
      error: "The checkpointed TikTok approval no longer matches this draft",
    });
  }
  const [ledgerResult, connectionResult] = await Promise.all([
    loadLedger(owner, approval.ledger_id),
    loadConnection(owner, approval.ledger_id),
  ]);
  const ledger = ledgerResult.ledger;
  const connection = connectionResult.connection;
  if (
    ledgerResult.error || !ledger || ledger.suspended ||
    connectionResult.error ||
    !validConnection(connection, approval.publish_mode) ||
    connection?.provider_subject !== approval.provider_open_id
  ) {
    return json(origin, 409, {
      error: "Reconnect the exact TikTok account before status reconciliation",
    });
  }
  let leaseId = "";
  try {
    leaseId = await claimLease(ledger, "status");
    const token = await verifiedAccess(
      ledger,
      connection!,
      approval.publish_mode,
    );
    let response: Response;
    try {
      response = await fetch(STATUS_URL, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${token.accessToken}`,
          "Content-Type": "application/json; charset=UTF-8",
          "Accept": "application/json",
        },
        body: JSON.stringify({ publish_id: draft.provider_post_id }),
        redirect: "error",
        signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
      });
    } catch {
      return json(origin, 202, {
        status: "unknown",
        reconciliationRequired: true,
        error:
          "TikTok status lookup ended without a durable result. The publish identifier remains locked.",
      });
    }
    if (response.status === 408 || response.status >= 500) {
      return json(origin, 202, {
        status: "unknown",
        reconciliationRequired: true,
        error:
          `TikTok returned HTTP ${response.status} during status reconciliation.`,
      });
    }
    const payload = await response.json().catch(() => null) as
      | Record<string, unknown>
      | null;
    const providerError = payload?.error as Record<string, unknown> | undefined;
    if (
      !response.ok || !payload || String(providerError?.code || "") !== "ok"
    ) {
      return json(origin, response.status === 429 ? 429 : 502, {
        status: "unknown",
        reconciliationRequired: true,
        error: safeProviderMessage(payload, response.status),
      });
    }
    const data = payload.data as Record<string, unknown> | undefined;
    const status = String(data?.status || "");
    const failReason = String(data?.fail_reason || "").slice(0, 300);
    const publicIds = Array.isArray(data?.publicaly_available_post_id)
      ? data.publicaly_available_post_id.map(String)
        .filter((id) => /^\d{1,30}$/.test(id)).slice(0, 20)
      : [];
    if (
      ![
        "PROCESSING_UPLOAD",
        "PROCESSING_DOWNLOAD",
        "SEND_TO_USER_INBOX",
        "PUBLISH_COMPLETE",
        "FAILED",
      ].includes(status)
    ) {
      return json(origin, 202, {
        status: "unknown",
        providerStatus: status,
        providerPublishId: draft.provider_post_id,
        reconciliationRequired: true,
      });
    }
    if (status === "FAILED") {
      const message = `TikTok reported failure${
        failReason ? `: ${failReason}` : "."
      }`.slice(0, 500);
      await service.from("drafts").update({
        publish_state: "failed",
        publish_error: message,
      }).eq("id", draft.id).eq("owner", owner)
        .eq("provider_post_id", draft.provider_post_id);
      await writeAudit(draft, "tiktok.status", "error", {
        provider_publish_id: draft.provider_post_id,
        provider_status: status,
        fail_reason: failReason,
        retry_safe: false,
      });
      return json(origin, 200, {
        status: "failed",
        providerStatus: status,
        providerPublishId: draft.provider_post_id,
        failReason,
        retryAllowed: false,
      });
    }
    if (status === "PUBLISH_COMPLETE") {
      const postedAt = new Date().toISOString();
      const saved = await service.from("drafts").update({
        status: "posted",
        publish_state: "published",
        posted_at: postedAt,
        publish_error: "",
      }).eq("id", draft.id).eq("owner", owner)
        .eq("provider_post_id", draft.provider_post_id)
        .in("publish_state", ["publishing", "published"])
        .select("publish_state").maybeSingle();
      if (saved.error || saved.data?.publish_state !== "published") {
        return json(origin, 202, {
          status: "unknown",
          providerStatus: status,
          providerPublishId: draft.provider_post_id,
          reconciliationRequired: true,
          error:
            "TikTok confirmed completion, but local completion could not be checkpointed.",
        });
      }
      await writeAudit(draft, "tiktok.status", "ok", {
        provider_publish_id: draft.provider_post_id,
        provider_status: status,
        publicly_available_post_ids: publicIds,
      });
      return json(origin, 200, {
        status: "published",
        providerStatus: status,
        providerPublishId: draft.provider_post_id,
        publiclyAvailablePostIds: publicIds,
        postedAt,
      });
    }
    const pendingMessage = status === "SEND_TO_USER_INBOX"
      ? "TikTok delivered the video to the creator inbox. Finish and post it in TikTok."
      : "TikTok is still processing the approved video.";
    await service.from("drafts").update({ publish_error: pendingMessage })
      .eq("id", draft.id).eq("owner", owner)
      .eq("provider_post_id", draft.provider_post_id);
    return json(origin, 200, {
      status: status === "SEND_TO_USER_INBOX"
        ? "awaiting_tiktok_completion"
        : "processing",
      providerStatus: status,
      providerPublishId: draft.provider_post_id,
      completionRequiredInTikTok: approval.publish_mode === "upload_inbox",
      reconciliationRequired: true,
      message: pendingMessage,
    });
  } catch (error) {
    if (error instanceof ProviderAccessError) {
      return json(origin, error.status, {
        error: error.message,
        code: error.code,
      });
    }
    return json(origin, 202, {
      status: "unknown",
      reconciliationRequired: true,
      error: "TikTok status reconciliation ended without a durable result.",
    });
  } finally {
    if (leaseId) await releaseLease(ledger, leaseId);
  }
}

serve(async (req) => {
  const origin = req.headers.get("Origin") || "";
  if (req.method === "OPTIONS") {
    return ALLOWED_ORIGINS.has(origin)
      ? new Response(null, { status: 204, headers: cors(origin) })
      : new Response(null, { status: 403 });
  }
  if (req.method !== "POST") {
    return json(origin, 405, { error: "Method not allowed" });
  }
  if (!ALLOWED_ORIGINS.has(origin)) {
    return json(origin, 403, { error: "Origin not allowed" });
  }
  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: {
      headers: { Authorization: req.headers.get("Authorization") || "" },
    },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const guard = await requireAal2(req, userClient);
  if (!guard.ok) {
    return json(origin, guard.status, { error: guard.error, code: guard.code });
  }
  let body: PostBody;
  try {
    body = await req.json() as PostBody;
  } catch {
    return json(origin, 400, { error: "Invalid JSON" });
  }
  const action = String(body.action || "");
  if (
    body.previewConfirmed !== undefined || body.executeConfirmed !== undefined
  ) {
    return json(origin, 400, {
      error:
        "Raw confirmation booleans are not accepted. Render and acknowledge the server receipt.",
    });
  }
  if (action === "prepare-preview") {
    return await preparePreview(origin, guard.user.id, body);
  }
  if (action === "acknowledge-preview") {
    return await acknowledgePreview(origin, userClient, body);
  }
  if (action === "send-approved") {
    return await sendApproved(
      origin,
      guard.user.id,
      String(body.draftId || ""),
      String(body.receiptId || ""),
    );
  }
  if (action === "reconcile-status") {
    return await reconcileStatus(
      origin,
      guard.user.id,
      String(body.draftId || ""),
    );
  }
  return json(origin, 400, { error: "Unknown TikTok posting action" });
});
