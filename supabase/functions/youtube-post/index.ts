// YouTube exact-approved, preview-gated, private-first video uploader.
//
// POST (owner JWT + AAL2):
//   {action:"preview-draft",draftId,madeForKids,containsSyntheticMedia,privacyStatus?}
//   {action:"acknowledge-preview",draftId,receiptId,receiptHash,previewVersion}
//   {action:"publish-draft",draftId,receiptId}
//   {action:"verify-processing",draftId}
//
// The browser never supplies provider metadata during publish. It selects one
// verified media asset during preview approval; the server stores a hash-bound
// receipt and later rebuilds every provider input from that receipt. Uploads use
// Google's resumable protocol and checkpoint the session URI in Vault and the
// returned video ID before local completion. Community posts are unsupported.
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { requireAal2 } from "../_shared/aal2.ts";
import { sha256Hex } from "../_shared/approved-media.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const CLIENT_ID = Deno.env.get("YOUTUBE_CLIENT_ID") || "";
const CLIENT_SECRET = Deno.env.get("YOUTUBE_CLIENT_SECRET") || "";
const APP_ORIGIN = Deno.env.get("YOUTUBE_OAUTH_APP_ORIGIN") ||
  "https://mypersonas.online";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const UPLOAD_START_URL =
  "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status,processingDetails";
const CHANNELS_URL =
  "https://www.googleapis.com/youtube/v3/channels?part=id&mine=true&maxResults=1";
const UPLOAD_SCOPE = "https://www.googleapis.com/auth/youtube.upload";
const DEFAULT_CATEGORY_ID = "22"; // People & Blogs; fixed and preview-bound for the first private proof.
const MAX_VIDEO_BYTES = 15 * 1024 * 1024;
const PROVIDER_TIMEOUT_MS = 45_000;
const SAFE_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_CHANNEL = /^UC[A-Za-z0-9_-]{22}$/;
const SAFE_VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const SAFE_SESSION_URL =
  /^https:\/\/www\.googleapis\.com\/upload\/youtube\/v3\/videos\?/;
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

type Draft = {
  id: string;
  owner: string;
  persona_id: string | null;
  account_id: string;
  platform: string;
  title: string;
  body: string;
  tags: string;
  media_url: string;
  content_kind: string;
  publish_at: string | null;
  approval_state: string;
  approved_content_hash: string;
  publish_state: string;
  provider_post_id: string;
  approved_preview_version: string;
  approved_preview_hash: string;
  approved_preview_target_id: string;
  approved_previewed_at: string | null;
};
type Approval = {
  draft_id: string;
  owner: string;
  ledger_id: string;
  channel_id: string;
  video_asset_id: string;
  video_sha256: string;
  video_byte_size: number;
  video_mime: string;
  title: string;
  description: string;
  made_for_kids: boolean;
  category_id: "22";
  contains_synthetic_media: boolean;
  privacy_status: "private" | "unlisted" | "public";
  preview_version: string;
  draft_content_hash: string;
  approval_hash: string;
  preview_hash: string;
};
type PreviewReceipt = {
  receiptId: string;
  receiptHash: string;
  previewVersion: string;
  preparedAt: string;
  expiresAt: string;
  preview: Record<string, unknown>;
};
type Credential = {
  googleSubject: string;
  providerEmail: string;
  channelId: string;
  channelTitle: string;
  accessToken: string;
  refreshToken: string;
  scopes: string[];
  expiresAt: string;
};

class PreProviderSafetyError extends Error {
  override name = "PreProviderSafetyError";
  status: number;
  constructor(message: string, status = 409) {
    super(message);
    this.status = status;
  }
}

function cors(origin: string): HeadersInit {
  const allowed = ALLOWED_ORIGINS.has(origin) ? origin : APP_ORIGIN;
  return {
    "Access-Control-Allow-Origin": allowed,
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
      ...cors(origin),
      "Content-Type": "application/json",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
function normalizeScopes(value: unknown) {
  const values = Array.isArray(value)
    ? value
    : String(value || "").split(/\s+/);
  return [...new Set(values.map((v) => String(v).trim()).filter(Boolean))]
    .sort();
}
function studioUrl(videoId: string) {
  return `https://studio.youtube.com/video/${videoId}/edit`;
}
function providerUncertain(error: unknown) {
  const name = String((error as { name?: string })?.name || "");
  return error instanceof TypeError || name === "AbortError" ||
    name === "TimeoutError";
}
function detectVideoMime(bytes: Uint8Array): "video/mp4" | "video/webm" {
  if (
    bytes.length >= 12 && String.fromCharCode(...bytes.slice(4, 8)) === "ftyp"
  ) return "video/mp4";
  if (
    bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 &&
    bytes[2] === 0xdf && bytes[3] === 0xa3
  ) return "video/webm";
  throw new Error("Video bytes are not a supported MP4 or WebM container");
}
function uploadOffset(response: Response) {
  const range = response.headers.get("Range") ||
    response.headers.get("range") || "";
  const match = range.match(/^bytes=0-(\d+)$/i);
  return match ? Number(match[1]) : -1;
}
async function exactDraftHash(draft: Draft) {
  return await service.rpc("agent_draft_hash", {
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
}
async function exactGenericPreviewHash(draft: Draft) {
  return await service.rpc("agent_draft_preview_hash", {
    p_content_hash: draft.approved_content_hash,
    p_preview_version: draft.approved_preview_version,
    p_preview_target_id: draft.approved_preview_target_id,
  });
}
async function genericPlatformPreviewIsCurrent(draft: Draft, targetId: string) {
  if (
    draft.approved_preview_version !== "platform-preview-v1" ||
    draft.approved_preview_target_id !== targetId ||
    !draft.approved_previewed_at ||
    Date.parse(draft.approved_previewed_at) > Date.now() ||
    !draft.approved_preview_hash
  ) return false;
  const hash = await exactGenericPreviewHash(draft);
  return !hash.error && hash.data === draft.approved_preview_hash;
}
async function exactApprovalHash(approval: Approval) {
  return await service.rpc("youtube_upload_approval_hash", {
    p_draft_content_hash: approval.draft_content_hash,
    p_channel_id: approval.channel_id,
    p_video_asset_id: approval.video_asset_id,
    p_video_sha256: approval.video_sha256,
    p_video_byte_size: approval.video_byte_size,
    p_video_mime: approval.video_mime,
    p_title: approval.title,
    p_description: approval.description,
    p_category_id: approval.category_id,
    p_made_for_kids: approval.made_for_kids,
    p_contains_synthetic_media: approval.contains_synthetic_media,
    p_privacy_status: approval.privacy_status,
    p_preview_version: approval.preview_version,
  });
}
async function storedCredential(
  ledgerId: string,
  owner: string,
): Promise<Credential | null> {
  const result = await service.rpc("youtube_get_token_bundle", {
    p_ledger_id: ledgerId,
    p_owner: owner,
  });
  const row = (Array.isArray(result.data) ? result.data[0] : result.data) as
    | Record<string, unknown>
    | null;
  const bundle = row?.token_bundle as Record<string, unknown> | null;
  if (result.error || !row || !bundle) return null;
  return {
    googleSubject: String(row.google_subject || ""),
    providerEmail: String(row.provider_email || ""),
    channelId: String(row.channel_id || ""),
    channelTitle: String(row.channel_title || ""),
    accessToken: String(bundle.access_token || ""),
    refreshToken: String(bundle.refresh_token || ""),
    scopes: normalizeScopes(bundle.scope),
    expiresAt: String(bundle.expires_at || ""),
  };
}
async function refreshCredential(
  ledgerId: string,
  owner: string,
  prior: Credential,
) {
  if (!CLIENT_ID || !CLIENT_SECRET || !prior.refreshToken) return null;
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: prior.refreshToken,
      grant_type: "refresh_token",
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
    String(payload.token_type || "").toLowerCase() !== "bearer"
  ) return null;
  const scopes = normalizeScopes(payload.scope);
  const nextScopes = scopes.length ? scopes : prior.scopes;
  const expires = new Date(
    Date.now() +
      Math.max(60, Math.min(86_400, Number(payload.expires_in || 3600))) * 1000,
  ).toISOString();
  const stored = await service.rpc("youtube_store_token_bundle", {
    p_ledger_id: ledgerId,
    p_owner: owner,
    p_google_subject: prior.googleSubject,
    p_provider_email: prior.providerEmail,
    p_channel_id: prior.channelId,
    p_channel_title: prior.channelTitle,
    p_access_token: payload.access_token,
    p_refresh_token: prior.refreshToken,
    p_token_type: "bearer",
    p_scope: nextScopes.join(" "),
    p_expires_at: expires,
  });
  if (stored.error) return null;
  return {
    ...prior,
    accessToken: payload.access_token,
    scopes: nextScopes,
    expiresAt: expires,
  } as Credential;
}
async function usableCredential(ledgerId: string, owner: string) {
  let credential = await storedCredential(ledgerId, owner);
  if (
    !credential || !credential.scopes.includes(UPLOAD_SCOPE) ||
    credential.channelId === ""
  ) return null;
  if (Date.parse(credential.expiresAt) <= Date.now() + 5 * 60_000) {
    credential = await refreshCredential(ledgerId, owner, credential);
  }
  return credential;
}
async function providerChannel(accessToken: string) {
  const response = await fetch(CHANNELS_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
  const payload = await response.json().catch(() => ({})) as {
    items?: Array<{ id?: unknown }>;
  };
  const id = Array.isArray(payload.items) && payload.items.length === 1
    ? String(payload.items[0]?.id || "")
    : "";
  return response.ok && SAFE_CHANNEL.test(id) ? id : "";
}
async function audit(
  owner: string,
  draft: Draft,
  outcome: "ok" | "error" | "approved",
  detail: Record<string, unknown>,
) {
  const result = await service.rpc("insert_agent_action_service", {
    p_owner: owner,
    p_persona_id: draft.persona_id,
    p_binding_id: null,
    p_action_type: "publish_external_youtube",
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
async function globalPause(owner: string) {
  return await service.from("agent_owner_settings").select("automation_paused")
    .eq("owner", owner).maybeSingle();
}
async function setFailure(
  origin: string,
  owner: string,
  draft: Draft,
  message: string,
  status = 502,
) {
  const update = await service.from("drafts").update({
    publish_state: "failed",
    publish_error: message.slice(0, 500),
  }).eq("id", draft.id).eq("owner", owner).eq("publish_state", "publishing")
    .eq("provider_post_id", "").select("id").maybeSingle();
  await audit(owner, draft, "error", { error: message, retry_safe: true });
  if (update.error || !update.data) {
    return json(origin, 500, {
      status: "unknown",
      reconciliationRequired: true,
      error:
        "The safe failure could not be checkpointed. Reconcile this draft before retrying.",
    });
  }
  return json(origin, status, { status: "failed", error: message });
}
async function setUncertain(
  origin: string,
  owner: string,
  draft: Draft,
  message: string,
) {
  const note =
    `${message} Do not create a new upload session until this one is reconciled.`
      .slice(0, 500);
  await service.from("drafts").update({ publish_error: note })
    .eq("id", draft.id).eq("owner", owner).eq("publish_state", "publishing");
  await service.from("youtube_upload_sessions").update({
    state: "reconciliation_required",
    last_error: note,
    last_checked_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq("draft_id", draft.id).eq("owner", owner);
  await audit(owner, draft, "error", {
    error: note,
    retry_safe: false,
    reconciliation_required: true,
  });
  return json(origin, 202, {
    status: "publishing",
    reconciliationRequired: true,
    error: note,
  });
}
async function verifiedVideoBytes(
  owner: string,
  draft: Draft,
  approval: Approval,
) {
  const assetResult = await service.from("persona_media_assets")
    .select(
      "id,owner,persona_id,media_type,storage_path,public_url,status,declaration_source,content_sha256,provenance_sha256,mime_type,byte_size",
    )
    .eq("id", approval.video_asset_id).eq("owner", owner).eq(
      "persona_id",
      draft.persona_id,
    ).maybeSingle();
  const asset = assetResult.data;
  if (
    assetResult.error || !asset || asset.media_type !== "video" ||
    asset.status !== "active" ||
    asset.declaration_source === "legacy" ||
    asset.public_url !== draft.media_url ||
    asset.content_sha256 !== approval.video_sha256 ||
    Number(asset.byte_size) !== approval.video_byte_size ||
    asset.mime_type !== approval.video_mime ||
    !/^[0-9a-f]{64}$/.test(asset.provenance_sha256 || "") ||
    !String(asset.storage_path || "").startsWith(owner.toLowerCase() + "/") ||
    String(asset.storage_path || "").includes("..") ||
    approval.video_byte_size > MAX_VIDEO_BYTES
  ) {
    throw new PreProviderSafetyError(
      "The exact approved YouTube video asset is unavailable or changed",
    );
  }
  const downloaded = await service.storage.from("persona-media").download(
    asset.storage_path,
  );
  if (downloaded.error || !downloaded.data) {
    throw new PreProviderSafetyError(
      "The approved video could not be read from private media storage",
      503,
    );
  }
  const bytes = new Uint8Array(await downloaded.data.arrayBuffer());
  if (
    bytes.byteLength !== approval.video_byte_size ||
    detectVideoMime(bytes) !== approval.video_mime ||
    await sha256Hex(bytes) !== approval.video_sha256
  ) {
    throw new PreProviderSafetyError(
      "The video bytes no longer match the exact owner approval",
    );
  }
  return bytes;
}
async function session(owner: string, draftId: string) {
  const result = await service.rpc("youtube_get_upload_session_service", {
    p_owner: owner,
    p_draft_id: draftId,
  });
  return (Array.isArray(result.data) ? result.data[0] : result.data) as
    | Record<string, unknown>
    | null;
}
async function queryUploadSession(
  url: string,
  accessToken: string,
  total: number,
) {
  return await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Length": "0",
      "Content-Range": `bytes */${total}`,
    },
    body: new Uint8Array(),
    redirect: "error",
    signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
  });
}
async function readVideoResource(response: Response) {
  const payload = await response.json().catch(() => null) as
    | Record<string, unknown>
    | null;
  const id = String(payload?.id || "");
  const snippet = payload?.snippet as Record<string, unknown> | undefined;
  const status = payload?.status as Record<string, unknown> | undefined;
  const processing = payload?.processingDetails as
    | Record<string, unknown>
    | undefined;
  return {
    id,
    channelId: String(snippet?.channelId || ""),
    categoryId: String(snippet?.categoryId || ""),
    privacyStatus: String(status?.privacyStatus || ""),
    madeForKids: status?.selfDeclaredMadeForKids,
    containsSynthetic: status?.containsSyntheticMedia,
    processingStatus: String(processing?.processingStatus || ""),
  };
}
async function checkpointVideo(
  owner: string,
  draft: Draft,
  approval: Approval,
  videoId: string,
  processingStatus: string,
) {
  if (!SAFE_VIDEO_ID.test(videoId)) return false;
  const checkpoint = await service.from("drafts").update({
    provider_post_id: videoId,
    publish_error:
      "YouTube accepted the private-first video; processing verification is in progress.",
  }).eq("id", draft.id).eq("owner", owner).eq("publish_state", "publishing")
    .eq("provider_post_id", "").select("id,provider_post_id").maybeSingle();
  if (checkpoint.error || checkpoint.data?.provider_post_id !== videoId) {
    const reread = await service.from("drafts").select("provider_post_id").eq(
      "id",
      draft.id,
    ).eq("owner", owner).maybeSingle();
    if (reread.error || reread.data?.provider_post_id !== videoId) return false;
  }
  await service.from("youtube_upload_sessions").update({
    provider_video_id: videoId,
    state: "processing",
    processing_status:
      ["processing", "succeeded", "failed", "terminated"].includes(
          processingStatus,
        )
        ? processingStatus
        : "processing",
    uploaded_through: approval.video_byte_size - 1,
    last_error: "",
    last_checked_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq("draft_id", draft.id).eq("owner", owner).eq(
    "approval_hash",
    approval.approval_hash,
  );
  return true;
}
async function verifyProcessing(
  accessToken: string,
  videoId: string,
  channelId: string,
  categoryId: string,
) {
  const url = new URL("https://www.googleapis.com/youtube/v3/videos");
  url.search = new URLSearchParams({
    part: "snippet,status,processingDetails",
    id: videoId,
  }).toString();
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
  const payload = await response.json().catch(() => ({})) as {
    items?: Array<Record<string, unknown>>;
  };
  const item = Array.isArray(payload.items) && payload.items.length === 1
    ? payload.items[0]
    : null;
  const snippet = item?.snippet as Record<string, unknown> | undefined;
  const processing = item?.processingDetails as
    | Record<string, unknown>
    | undefined;
  const status = String(processing?.processingStatus || "");
  if (
    !response.ok || !item || String(item.id || "") !== videoId ||
    String(snippet?.channelId || "") !== channelId ||
    String(snippet?.categoryId || "") !== categoryId ||
    !["processing", "succeeded", "failed", "terminated"].includes(status)
  ) return null;
  return { status, video: item };
}

serve(async (req: Request): Promise<Response> => {
  const origin = req.headers.get("Origin") || "";
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors(origin) });
  }
  if (req.method !== "POST") return json(origin, 405, { error: "POST only" });
  if (!ALLOWED_ORIGINS.has(origin)) {
    return json(origin, 403, { error: "Origin not allowed" });
  }
  const authClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: {
      headers: { Authorization: req.headers.get("Authorization") || "" },
    },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const guard = await requireAal2(req, authClient);
  if (!guard.ok) {
    return json(origin, guard.status, { error: guard.error, code: guard.code });
  }
  const owner = guard.user.id;
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json(origin, 400, { error: "Invalid request body" });
  }
  const action = String(body.action || "");
  const draftId = String(body.draftId || "");
  if (!SAFE_UUID.test(draftId)) {
    return json(origin, 400, { error: "A valid draft id is required" });
  }
  const draftResult = await service.from("drafts")
    .select(
      "id,owner,persona_id,account_id,platform,title,body,tags,media_url,content_kind,publish_at,approval_state,approved_content_hash,publish_state,provider_post_id,approved_preview_version,approved_preview_hash,approved_preview_target_id,approved_previewed_at",
    )
    .eq("id", draftId).eq("owner", owner).maybeSingle();
  const draft = draftResult.data as Draft | null;
  if (draftResult.error) {
    return json(origin, 503, {
      error: "The YouTube draft could not be verified",
    });
  }
  if (
    !draft || !draft.account_id || !draft.persona_id ||
    !SAFE_UUID.test(draft.persona_id) ||
    String(draft.platform || "").toLowerCase() !== "youtube"
  ) {
    return json(origin, 404, { error: "Owned YouTube draft not found" });
  }
  const ledgerResult = await service.from("account_ledger")
    .select("id,owner,provider,persona_id,suspended")
    .eq("id", draft.account_id).eq("owner", owner).eq("provider", "youtube")
    .maybeSingle();
  const ledger = ledgerResult.data;
  if (ledgerResult.error || !ledger || ledger.suspended) {
    return json(origin, 409, {
      error: "YouTube destination is unavailable or suspended",
    });
  }
  if (draft.persona_id && ledger.persona_id !== draft.persona_id) {
    const shared = await service.from("account_persona_links").select(
      "ledger_id",
    )
      .eq("ledger_id", ledger.id).eq("persona_id", draft.persona_id).eq(
        "owner",
        owner,
      ).maybeSingle();
    if (shared.error || !shared.data) {
      return json(origin, 409, {
        error: "YouTube destination is no longer assigned to this persona",
      });
    }
  }
  const connectionResult = await service.from("account_connections")
    .select(
      "connection_state,verification_method,granted_scopes,provider_subject",
    )
    .eq("ledger_id", ledger.id).eq("owner", owner).eq("provider", "youtube")
    .maybeSingle();
  const connection = connectionResult.data;
  const scopes = normalizeScopes(connection?.granted_scopes);
  if (
    connectionResult.error || !connection ||
    connection.connection_state !== "connected" ||
    connection.verification_method !== "youtube_oauth2_pkce" ||
    !scopes.includes(UPLOAD_SCOPE) ||
    !SAFE_CHANNEL.test(connection.provider_subject || "")
  ) {
    return json(origin, 409, {
      error: "Connect this exact YouTube channel with upload permission first",
    });
  }

  if (action === "acknowledge-preview") {
    const receiptId = String(body.receiptId || "");
    const receiptHash = String(body.receiptHash || "");
    const previewVersion = String(body.previewVersion || "");
    if (
      !SAFE_UUID.test(receiptId) || !/^[0-9a-f]{64}$/.test(receiptHash) ||
      previewVersion !== "youtube-preview-v1"
    ) {
      return json(origin, 400, {
        error: "The exact server-prepared YouTube preview receipt is required",
      });
    }
    const acknowledged = await authClient.rpc(
      "acknowledge_provider_action_preview",
      {
        p_receipt_id: receiptId,
        p_receipt_hash: receiptHash,
        p_preview_version: previewVersion,
      },
    );
    if (acknowledged.error || !acknowledged.data) {
      return json(origin, 409, {
        error: acknowledged.error?.message ||
          "The YouTube preview could not be acknowledged",
      });
    }
    return json(origin, 200, acknowledged.data as Record<string, unknown>);
  }
  if (
    action === "approve-preview" || body.previewConfirmed !== undefined ||
    body.executeConfirmed !== undefined
  ) {
    return json(origin, 400, {
      error:
        "Raw preview confirmation is not accepted. Prepare, render, and acknowledge the server receipt.",
    });
  }

  const privacy = String(body.privacyStatus || "private");
  const hasAudience = typeof body.madeForKids === "boolean";
  const hasSynthetic = typeof body.containsSyntheticMedia === "boolean";
  if (action === "preview-draft") {
    if (!hasAudience || !hasSynthetic || privacy !== "private") {
      return json(origin, 400, {
        error:
          "Choose the YouTube audience and synthetic-media disclosure; the first connector proof must remain Private",
      });
    }
    const videoAssetId = String(body.videoAssetId || "");
    if (!SAFE_UUID.test(videoAssetId)) {
      return json(origin, 400, { error: "Choose one verified video asset" });
    }
    if (
      !(draft.title || "").trim() || !(draft.body || "").trim() ||
      draft.title.length > 100 ||
      new TextEncoder().encode(draft.body).byteLength > 5000 ||
      /[<>]/.test(draft.title) || /[<>]/.test(draft.body)
    ) {
      return json(origin, 409, {
        error:
          "YouTube requires an approved title and description within its platform limits",
      });
    }
    const assetResult = await service.from("persona_media_assets")
      .select(
        "id,owner,persona_id,media_type,public_url,status,declaration_source,content_sha256,provenance_sha256,mime_type,byte_size",
      )
      .eq("id", videoAssetId).eq("owner", owner).eq(
        "persona_id",
        draft.persona_id,
      ).maybeSingle();
    const asset = assetResult.data;
    if (
      assetResult.error || !asset || asset.media_type !== "video" ||
      asset.status !== "active" ||
      asset.declaration_source === "legacy" ||
      asset.public_url !== draft.media_url ||
      !/^[0-9a-f]{64}$/.test(asset.content_sha256 || "") ||
      !/^[0-9a-f]{64}$/.test(asset.provenance_sha256 || "") ||
      !["video/mp4", "video/webm"].includes(asset.mime_type) ||
      Number(asset.byte_size) < 1 || Number(asset.byte_size) > MAX_VIDEO_BYTES
    ) {
      return json(origin, 409, {
        error:
          "Use the exact verified owner-scoped MP4 or WebM asset shown in this draft",
      });
    }
    const preview = {
      rendererVersion: "youtube-preview-v1",
      channelId: connection.provider_subject,
      channelTitle: "Bound YouTube channel",
      title: draft.title || "",
      description: draft.body || "",
      videoUrl: draft.media_url,
      videoSha256: asset.content_sha256,
      videoBytes: Number(asset.byte_size),
      videoMime: asset.mime_type,
      madeForKids: body.madeForKids,
      categoryId: DEFAULT_CATEGORY_ID,
      categoryLabel: "People & Blogs",
      containsSyntheticMedia: body.containsSyntheticMedia,
      privacyStatus: privacy,
      scheduledFor: draft.publish_at,
      placement: "YouTube video upload",
    };
    if (draft.approval_state !== "approved" || !draft.approved_content_hash) {
      return json(origin, 409, {
        error:
          "Approve the exact generic draft before preparing this YouTube platform preview",
      });
    }
    if (
      !await genericPlatformPreviewIsCurrent(draft, connection.provider_subject)
    ) {
      return json(origin, 409, {
        error:
          "Approve the current exact YouTube platform rendering through the general preview gate first",
      });
    }
    const saved = await service.rpc("youtube_record_preview_approval_service", {
      p_owner: owner,
      p_draft_id: draft.id,
      p_video_asset_id: videoAssetId,
      p_made_for_kids: body.madeForKids,
      p_contains_synthetic_media: body.containsSyntheticMedia,
      p_privacy_status: privacy,
      p_preview_version: "youtube-preview-v1",
    });
    const approval = (Array.isArray(saved.data) ? saved.data[0] : saved.data) as
      | Approval
      | null;
    if (saved.error || !approval) {
      return json(origin, 409, {
        error: saved.error?.message ||
          "The exact YouTube preview snapshot could not be prepared",
      });
    }
    const receipt = await service.rpc(
      "prepare_provider_action_preview_service",
      {
        p_owner: owner,
        p_draft_id: draft.id,
        p_ledger_id: ledger.id,
        p_provider: "youtube",
        p_action: "youtube.publish_private",
        p_target_id: connection.provider_subject,
        p_content_hash: draft.approved_content_hash,
        p_action_hash: approval.approval_hash,
        p_preview_version: "youtube-preview-v1",
        p_preview_payload: {
          rendererVersion: "youtube-preview-v1",
          items: [{
            provider: "youtube",
            account: "Bound YouTube channel",
            accountId: connection.provider_subject,
            placement: "YouTube watch page",
            requiresExactTarget: true,
            exactTargetReady: true,
            title: preview.title,
            text: preview.description,
            tags: "",
            mediaUrl: preview.videoUrl,
            mediaKind: "video",
            mediaItems: [{
              url: preview.videoUrl,
              kind: "video",
              label: "Exact verified video",
            }],
            requiresMedia: true,
            requiredMediaMissing: !preview.videoUrl,
            scheduledFor: null,
            mode: "Private verification upload",
            timingLabel: "Immediately after acknowledgement",
            platformDetails: [
              `Exact channel ID: ${connection.provider_subject}`,
              `Video SHA-256: ${asset.content_sha256}`,
              "Visibility: Private",
              `Audience: ${
                body.madeForKids ? "Made for kids" : "Not made for kids"
              }`,
              `Synthetic-media disclosure: ${
                body.containsSyntheticMedia ? "Yes" : "No"
              }`,
              "Category: People & Blogs (22)",
            ],
          }],
          exactYouTubePreview: preview,
        },
      },
    );
    const prepared = receipt.data as PreviewReceipt | null;
    if (receipt.error || !prepared) {
      return json(origin, 409, {
        error: receipt.error?.message ||
          "The YouTube action receipt could not be prepared",
      });
    }
    return json(origin, 200, {
      prepared: true,
      receipt: prepared,
      preview: prepared.preview,
      warning: "Only you can see this verification upload.",
    });
  }

  const approvalResult = await service.from("youtube_upload_approvals").select(
    "*",
  )
    .eq("draft_id", draft.id).eq("owner", owner).maybeSingle();
  const approval = approvalResult.data as Approval | null;
  if (approvalResult.error || !approval) {
    return json(origin, 409, {
      error: "Review and approve the current YouTube platform preview first",
    });
  }
  const [draftHash, approvalHash] = await Promise.all([
    exactDraftHash(draft),
    exactApprovalHash(approval),
  ]);
  if (
    draftHash.error || draftHash.data !== draft.approved_content_hash ||
    draft.approval_state !== "approved" ||
    approval.draft_content_hash !== draft.approved_content_hash ||
    approvalHash.error || approvalHash.data !== approval.approval_hash ||
    approval.preview_hash !== approval.approval_hash ||
    approval.preview_version !== "youtube-preview-v1" ||
    approval.ledger_id !== ledger.id ||
    approval.channel_id !== connection.provider_subject ||
    approval.title !== draft.title ||
    approval.description !== (draft.body || "") ||
    approval.category_id !== DEFAULT_CATEGORY_ID
  ) {
    return json(origin, 409, {
      error:
        "Draft, destination, media, or YouTube preview changed; approve the current preview again",
    });
  }
  if (
    !await genericPlatformPreviewIsCurrent(draft, connection.provider_subject)
  ) {
    return json(origin, 409, {
      error:
        "The durable general YouTube platform preview is missing, stale, or bound to another channel",
    });
  }

  if (action === "verify-processing") {
    if (!SAFE_VIDEO_ID.test(draft.provider_post_id || "")) {
      return json(origin, 409, {
        error: "This draft has no checkpointed YouTube video",
      });
    }
    const credential = await usableCredential(ledger.id, owner);
    if (!credential || credential.channelId !== approval.channel_id) {
      return json(origin, 409, {
        error: "Reconnect this exact YouTube channel",
      });
    }
    const check = await verifyProcessing(
      credential.accessToken,
      draft.provider_post_id,
      approval.channel_id,
      approval.category_id,
    ).catch(() => null);
    if (!check) {
      return json(origin, 502, {
        verified: false,
        error: "YouTube processing could not be verified yet",
        studioUrl: studioUrl(draft.provider_post_id),
        manualCleanup:
          "Delete the test video in YouTube Studio if you no longer need it.",
      });
    }
    const nextState = check.status === "succeeded"
      ? "processed"
      : check.status === "processing"
      ? "processing"
      : "failed";
    await service.from("youtube_upload_sessions").update({
      state: nextState,
      processing_status: check.status,
      last_checked_at: new Date().toISOString(),
      last_error: check.status === "failed" ? "YouTube processing failed" : "",
      updated_at: new Date().toISOString(),
    }).eq("draft_id", draft.id).eq("owner", owner).eq(
      "provider_video_id",
      draft.provider_post_id,
    );
    await audit(owner, draft, check.status === "failed" ? "error" : "ok", {
      phase: "processing_verified",
      provider_video_id: draft.provider_post_id,
      processing_status: check.status,
    });
    return json(origin, 200, {
      verified: true,
      processingStatus: check.status,
      videoId: draft.provider_post_id,
      studioUrl: studioUrl(draft.provider_post_id),
      manualCleanup:
        "Delete the test video in YouTube Studio if you no longer need it.",
    });
  }

  if (action !== "publish-draft") {
    return json(origin, 400, { error: "Unsupported YouTube publisher action" });
  }
  const receiptId = String(body.receiptId || "");
  if (!SAFE_UUID.test(receiptId)) {
    return json(origin, 409, {
      error:
        "A current acknowledged one-shot YouTube preview receipt is required",
    });
  }
  const pause = await globalPause(owner);
  if (pause.error || !pause.data) {
    return json(origin, 503, {
      error: "The owner-wide automation safety setting could not be verified",
    });
  }
  if (pause.data.automation_paused) {
    return json(origin, 409, { error: "The global automation pause is on" });
  }
  if (draft.publish_at && Date.parse(draft.publish_at) > Date.now() + 60_000) {
    return json(origin, 409, {
      error: "This exact preview-approved draft is scheduled for later",
    });
  }
  if (draft.provider_post_id) {
    return json(origin, 409, {
      error:
        "This draft already has a durable YouTube video ID and cannot be uploaded again",
      studioUrl: SAFE_VIDEO_ID.test(draft.provider_post_id)
        ? studioUrl(draft.provider_post_id)
        : undefined,
    });
  }
  const existingSession = await session(owner, draft.id);
  const claim = await service.rpc("claim_youtube_upload_with_preview_service", {
    p_owner: owner,
    p_draft_id: draft.id,
    p_receipt_id: receiptId,
  });
  if (claim.error || !claim.data) {
    return json(origin, 409, {
      error: claim.error?.message ||
        "The YouTube preview receipt or exact draft could not be claimed atomically",
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
        "The atomic YouTube claim returned an invalid durable checkpoint. Nothing was sent.",
    });
  }
  if (
    existingSession && existingSession.approval_hash !== approval.approval_hash
  ) {
    return await setFailure(
      origin,
      owner,
      claimed,
      "The saved YouTube upload session belongs to a different approval. Nothing was sent.",
      409,
    );
  }

  let bytes: Uint8Array;
  try {
    bytes = await verifiedVideoBytes(owner, claimed, approval);
  } catch (error) {
    if (error instanceof PreProviderSafetyError) {
      return await setFailure(
        origin,
        owner,
        claimed,
        error.message,
        error.status,
      );
    }
    return await setFailure(
      origin,
      owner,
      claimed,
      "The exact approved video could not be verified",
      503,
    );
  }

  const currentPause = await globalPause(owner);
  const currentConnection = await service.from("account_connections")
    .select(
      "connection_state,verification_method,granted_scopes,provider_subject",
    )
    .eq("ledger_id", ledger.id).eq("owner", owner).eq("provider", "youtube")
    .maybeSingle();
  if (
    currentPause.error || !currentPause.data ||
    currentPause.data.automation_paused ||
    currentConnection.error ||
    currentConnection.data?.connection_state !== "connected" ||
    currentConnection.data?.verification_method !== "youtube_oauth2_pkce" ||
    !normalizeScopes(currentConnection.data?.granted_scopes).includes(
      UPLOAD_SCOPE,
    ) ||
    currentConnection.data?.provider_subject !== approval.channel_id
  ) {
    return await setFailure(
      origin,
      owner,
      claimed,
      "YouTube authorization or the global safety state changed before upload",
      409,
    );
  }
  const leaseId = crypto.randomUUID();
  const lease = await service.rpc("claim_youtube_token_operation", {
    p_ledger_id: ledger.id,
    p_owner: owner,
    p_lease_id: leaseId,
    p_operation_kind: "publish",
    p_ttl_seconds: 300,
  });
  if (lease.error || lease.data !== true) {
    return await setFailure(
      origin,
      owner,
      claimed,
      "Another YouTube operation is in progress",
      409,
    );
  }

  try {
    const credential = await usableCredential(ledger.id, owner);
    if (!credential || credential.channelId !== approval.channel_id) {
      return await setFailure(
        origin,
        owner,
        claimed,
        "Reconnect this exact YouTube channel before uploading",
        409,
      );
    }
    const channel = await providerChannel(credential.accessToken).catch(() =>
      ""
    );
    if (channel !== approval.channel_id) {
      return await setFailure(
        origin,
        owner,
        claimed,
        "Google no longer confirms the exact approved YouTube channel",
        409,
      );
    }
    let savedSession = existingSession || await session(owner, claimed.id);
    if (!savedSession) {
      const recheck = await globalPause(owner);
      if (recheck.error || !recheck.data || recheck.data.automation_paused) {
        return await setFailure(
          origin,
          owner,
          claimed,
          "The global automation pause changed before YouTube session creation",
          409,
        );
      }
      const audited = await audit(owner, claimed, "ok", {
        phase: "resumable_session_start",
        approval_hash: approval.approval_hash,
        channel_id: approval.channel_id,
        category_id: approval.category_id,
        privacy_status: approval.privacy_status,
        retry_safe: true,
      });
      if (!audited) {
        return await setFailure(
          origin,
          owner,
          claimed,
          "The provider request could not be audited",
          503,
        );
      }
      let start: Response;
      try {
        start = await fetch(UPLOAD_START_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${credential.accessToken}`,
            "Content-Type": "application/json; charset=UTF-8",
            "X-Upload-Content-Length": String(bytes.byteLength),
            "X-Upload-Content-Type": approval.video_mime,
          },
          body: JSON.stringify({
            snippet: {
              title: approval.title,
              description: approval.description,
              categoryId: approval.category_id,
            },
            status: {
              privacyStatus: approval.privacy_status,
              selfDeclaredMadeForKids: approval.made_for_kids,
              containsSyntheticMedia: approval.contains_synthetic_media,
            },
          }),
          redirect: "error",
          signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
        });
      } catch (error) {
        if (providerUncertain(error)) {
          return await setFailure(
            origin,
            owner,
            claimed,
            "YouTube session creation did not complete; no video bytes were sent",
            502,
          );
        }
        return await setFailure(
          origin,
          owner,
          claimed,
          "YouTube session creation failed before video upload",
          502,
        );
      }
      const location = start.headers.get("Location") || "";
      if (
        !start.ok || !SAFE_SESSION_URL.test(location) || location.length > 4096
      ) {
        return await setFailure(
          origin,
          owner,
          claimed,
          `YouTube rejected resumable session creation (HTTP ${start.status})`,
        );
      }
      const stored = await service.rpc("youtube_store_upload_session_service", {
        p_owner: owner,
        p_draft_id: claimed.id,
        p_approval_hash: approval.approval_hash,
        p_session_url: location,
      });
      if (stored.error) {
        return await setFailure(
          origin,
          owner,
          claimed,
          "YouTube created an empty session, but its resumable checkpoint could not be stored",
          503,
        );
      }
      savedSession = await session(owner, claimed.id);
    }
    const sessionUrl = String(savedSession?.session_url || "");
    if (
      !SAFE_SESSION_URL.test(sessionUrl) ||
      savedSession?.approval_hash !== approval.approval_hash
    ) {
      return await setUncertain(
        origin,
        owner,
        claimed,
        "The resumable YouTube session checkpoint is invalid",
      );
    }

    let offset = -1;
    try {
      const status = await queryUploadSession(
        sessionUrl,
        credential.accessToken,
        bytes.byteLength,
      );
      if (status.status === 200 || status.status === 201) {
        const resource = await readVideoResource(status);
        if (
          !SAFE_VIDEO_ID.test(resource.id) ||
          resource.channelId !== approval.channel_id ||
          resource.categoryId !== approval.category_id
        ) {
          return await setUncertain(
            origin,
            owner,
            claimed,
            "YouTube reports a completed session without the exact channel-bound video ID",
          );
        }
        if (
          !await checkpointVideo(
            owner,
            claimed,
            approval,
            resource.id,
            resource.processingStatus,
          )
        ) {
          return await setUncertain(
            origin,
            owner,
            claimed,
            `YouTube accepted ${resource.id}, but its provider ID could not be checkpointed`,
          );
        }
      } else if (status.status === 308) {
        offset = uploadOffset(status);
      } else if (status.status === 404 || status.status === 410) {
        await service.from("youtube_upload_sessions").delete().eq(
          "draft_id",
          claimed.id,
        ).eq("owner", owner);
        return await setFailure(
          origin,
          owner,
          claimed,
          "The empty or incomplete YouTube upload session expired; retry will create a new session",
          409,
        );
      } else if (status.status === 401) {
        return await setFailure(
          origin,
          owner,
          claimed,
          "YouTube access expired; refresh or reconnect before resuming",
          409,
        );
      } else if (status.status === 408 || status.status >= 500) {
        return await setUncertain(
          origin,
          owner,
          claimed,
          `YouTube could not confirm resumable progress (HTTP ${status.status})`,
        );
      } else {
        return await setFailure(
          origin,
          owner,
          claimed,
          `YouTube rejected the resumable status check (HTTP ${status.status})`,
        );
      }
    } catch (error) {
      if (providerUncertain(error)) {
        return await setUncertain(
          origin,
          owner,
          claimed,
          "YouTube did not return resumable upload status",
        );
      }
      return await setUncertain(
        origin,
        owner,
        claimed,
        "YouTube upload status could not be reconciled",
      );
    }

    let afterCheckpoint = await service.from("drafts").select(
      "provider_post_id",
    ).eq("id", claimed.id).eq("owner", owner).maybeSingle();
    if (!afterCheckpoint.data?.provider_post_id) {
      const startAt = offset + 1;
      const remaining = bytes.slice(startAt);
      const recheck = await globalPause(owner);
      if (recheck.error || !recheck.data || recheck.data.automation_paused) {
        return await setFailure(
          origin,
          owner,
          claimed,
          "The global automation pause changed before video bytes were sent",
          409,
        );
      }
      const audited = await audit(owner, claimed, "ok", {
        phase: "video_bytes_upload_start",
        approval_hash: approval.approval_hash,
        first_byte: startAt,
        last_byte: bytes.byteLength - 1,
        total_bytes: bytes.byteLength,
        retry_safe: false,
      });
      if (!audited) {
        return await setFailure(
          origin,
          owner,
          claimed,
          "The video-byte request could not be audited",
          503,
        );
      }
      let upload: Response;
      try {
        upload = await fetch(sessionUrl, {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${credential.accessToken}`,
            "Content-Type": approval.video_mime,
            "Content-Length": String(remaining.byteLength),
            "Content-Range": `bytes ${startAt}-${
              bytes.byteLength - 1
            }/${bytes.byteLength}`,
          },
          body: remaining,
          redirect: "error",
          signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
        });
      } catch (error) {
        if (providerUncertain(error)) {
          try {
            const reconcile = await queryUploadSession(
              sessionUrl,
              credential.accessToken,
              bytes.byteLength,
            );
            if (reconcile.status === 200 || reconcile.status === 201) {
              upload = reconcile;
            } else if (reconcile.status === 308) {
              const through = uploadOffset(reconcile);
              await service.from("youtube_upload_sessions").update({
                state: "uploading",
                uploaded_through: through,
                last_checked_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
              }).eq("draft_id", claimed.id).eq("owner", owner);
              return json(origin, 202, {
                status: "uploading",
                resumeRequired: true,
                uploadedThrough: through,
              });
            } else {return await setUncertain(
                origin,
                owner,
                claimed,
                "YouTube upload outcome could not be reconciled after interruption",
              );}
          } catch {
            return await setUncertain(
              origin,
              owner,
              claimed,
              "YouTube upload was interrupted and status verification also failed",
            );
          }
        } else {return await setUncertain(
            origin,
            owner,
            claimed,
            "YouTube video upload ended without a durable result",
          );}
      }
      if (upload!.status === 308) {
        const through = uploadOffset(upload!);
        await service.from("youtube_upload_sessions").update({
          state: "uploading",
          uploaded_through: through,
          last_checked_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }).eq("draft_id", claimed.id).eq("owner", owner);
        return json(origin, 202, {
          status: "uploading",
          resumeRequired: true,
          uploadedThrough: through,
        });
      }
      if (upload!.status === 408 || upload!.status >= 500) {
        return await setUncertain(
          origin,
          owner,
          claimed,
          `YouTube returned HTTP ${upload!.status} after video bytes were sent`,
        );
      }
      if (!upload!.ok) {
        return await setFailure(
          origin,
          owner,
          claimed,
          `YouTube rejected the video upload (HTTP ${upload!.status})`,
        );
      }
      const resource = await readVideoResource(upload!);
      if (
        !SAFE_VIDEO_ID.test(resource.id) ||
        resource.channelId !== approval.channel_id ||
        resource.categoryId !== approval.category_id
      ) {
        return await setUncertain(
          origin,
          owner,
          claimed,
          "YouTube accepted the bytes without the exact channel-bound video ID",
        );
      }
      if (
        !await checkpointVideo(
          owner,
          claimed,
          approval,
          resource.id,
          resource.processingStatus,
        )
      ) {
        return await setUncertain(
          origin,
          owner,
          claimed,
          `YouTube accepted ${resource.id}, but its provider ID could not be checkpointed`,
        );
      }
      afterCheckpoint = await service.from("drafts").select("provider_post_id")
        .eq("id", claimed.id).eq("owner", owner).maybeSingle();
    }

    const videoId = String(afterCheckpoint.data?.provider_post_id || "");
    if (!SAFE_VIDEO_ID.test(videoId)) {
      return await setUncertain(
        origin,
        owner,
        claimed,
        "The YouTube provider ID checkpoint could not be verified",
      );
    }
    const processing = await verifyProcessing(
      credential.accessToken,
      videoId,
      approval.channel_id,
      approval.category_id,
    ).catch(() => null);
    const processingStatus = processing?.status || "processing";
    await service.from("youtube_upload_sessions").update({
      state: processingStatus === "succeeded"
        ? "processed"
        : processingStatus === "failed"
        ? "failed"
        : "processing",
      processing_status: processingStatus,
      last_checked_at: new Date().toISOString(),
      last_error: processingStatus === "failed"
        ? "YouTube processing failed"
        : "",
      updated_at: new Date().toISOString(),
    }).eq("draft_id", claimed.id).eq("owner", owner).eq(
      "provider_video_id",
      videoId,
    );
    const final = await service.from("drafts").update({
      status: "posted",
      publish_state: "published",
      publish_error: processing
        ? ""
        : "YouTube accepted the video; processing verification is still pending.",
      posted_at: new Date().toISOString(),
    }).eq("id", claimed.id).eq("owner", owner).eq("publish_state", "publishing")
      .eq("provider_post_id", videoId).select(
        "id,provider_post_id,publish_state",
      ).maybeSingle();
    if (final.error || final.data?.provider_post_id !== videoId) {
      const reread = await service.from("drafts").select(
        "provider_post_id,publish_state",
      ).eq("id", claimed.id).eq("owner", owner).maybeSingle();
      if (
        reread.data?.provider_post_id !== videoId ||
        reread.data?.publish_state !== "published"
      ) {
        return await setUncertain(
          origin,
          owner,
          claimed,
          `YouTube accepted ${videoId}, but local completion could not be verified`,
        );
      }
    }
    await audit(owner, claimed, "ok", {
      phase: "completed",
      provider_video_id: videoId,
      processing_status: processingStatus,
      category_id: approval.category_id,
      privacy_status: approval.privacy_status,
      approval_hash: approval.approval_hash,
    });
    return json(origin, 200, {
      status: "published",
      uploaded: true,
      videoId,
      categoryId: approval.category_id,
      privacyStatus: approval.privacy_status,
      processingVerified: Boolean(processing),
      processingStatus,
      studioUrl: studioUrl(videoId),
      manualCleanup:
        "No delete scope was requested. Delete the test video manually in YouTube Studio if you no longer need it.",
    });
  } finally {
    await service.rpc("release_youtube_token_operation", {
      p_ledger_id: ledger.id,
      p_owner: owner,
      p_lease_id: leaseId,
    });
  }
});
