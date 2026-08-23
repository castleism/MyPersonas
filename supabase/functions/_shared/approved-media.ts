// Immutable approved media for the post_drafts publishing pipeline.
//
// Scheduling copies the exact remote bytes into a dedicated content-addressed
// Storage bucket. A separate opaque delivery id is the only URL providers use;
// the owner-correlating Storage path remains internal and becomes private after
// the separately gated migration-063 finalizer.

import {
  readExactPublicMediaResponse,
  validatePublicMediaResolution,
  verifyResolvedPublicMedia,
} from "./public-media.ts";

export const APPROVED_MEDIA_BUCKET = "post-approved-media";
export const APPROVED_MEDIA_MAX_BYTES = 10 * 1024 * 1024;
export const APPROVED_MEDIA_DELIVERY_ORIGIN = "https://media.mypersonas.online";

export type ApprovedMedia = {
  sha256: string;
  mime: "image/jpeg" | "image/png" | "image/webp";
  byteSize: number;
  path: string;
  url: string;
  deliveryId: string;
  deliveryUrl: string;
};

type StorageApi = {
  from(bucket: string): {
    upload(
      path: string,
      body: Uint8Array,
      options: Record<string, unknown>,
    ): Promise<{ error: { message?: string } | null }>;
    download(path: string): Promise<{
      data: Blob | null;
      error: { message?: string } | null;
    }>;
  };
};

type RpcApi = {
  rpc(
    name: string,
    args: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: { message?: string } | null }>;
};

const SHA256 = /^[0-9a-f]{64}$/;
const OWNER = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OPAQUE_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PATH = /^owners\/([0-9a-f-]{36})\/sha256\/([0-9a-f]{2})\/([0-9a-f]{64})\.(jpg|png|webp)$/;

function bytesEqualPrefix(
  bytes: Uint8Array,
  prefix: readonly number[],
  offset = 0,
) {
  return prefix.every((value, index) => bytes[offset + index] === value);
}

export function detectImageMime(bytes: Uint8Array): ApprovedMedia["mime"] {
  if (bytes.length >= 3 && bytesEqualPrefix(bytes, [0xff, 0xd8, 0xff])) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 8 &&
    bytesEqualPrefix(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  ) {
    return "image/png";
  }
  if (
    bytes.length >= 12 &&
    bytesEqualPrefix(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    bytesEqualPrefix(bytes, [0x57, 0x45, 0x42, 0x50], 8)
  ) {
    return "image/webp";
  }
  throw new Error("Approved media must be a JPEG, PNG, or WebP image.");
}

export async function sha256Hex(bytes: Uint8Array) {
  // Copy into an ArrayBuffer-backed view. Deno's WebCrypto types correctly
  // reject a Uint8Array that could be backed by SharedArrayBuffer.
  const ownedBytes = new Uint8Array(bytes.byteLength);
  ownedBytes.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", ownedBytes.buffer);
  return Array.from(new Uint8Array(digest))
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

function extensionFor(mime: ApprovedMedia["mime"]) {
  if (mime === "image/jpeg") return "jpg";
  if (mime === "image/png") return "png";
  return "webp";
}

export function approvedMediaPath(
  owner: string,
  sha256: string,
  mime: ApprovedMedia["mime"],
) {
  if (!OWNER.test(owner)) throw new Error("Invalid approved-media owner.");
  if (!SHA256.test(sha256)) throw new Error("Invalid approved-media digest.");
  return `owners/${owner.toLowerCase()}/sha256/${sha256.slice(0, 2)}/${sha256}.${extensionFor(mime)}`;
}

export function approvedMediaUrl(supabaseUrl: string, path: string) {
  const base = new URL(supabaseUrl);
  if (base.protocol !== "https:") {
    throw new Error("SUPABASE_URL must use HTTPS for public approved media.");
  }
  return `${base.origin}/storage/v1/object/public/${APPROVED_MEDIA_BUCKET}/${path}`;
}

export function approvedMediaDeliveryUrl(publicId: string) {
  const normalized = String(publicId || "").toLowerCase();
  if (!OPAQUE_V4.test(normalized)) {
    throw new Error("Invalid approved-media delivery id.");
  }
  return `${APPROVED_MEDIA_DELIVERY_ORIGIN}/approved/v1/${normalized}`;
}

export function approvedMediaDeliveryIdFromUrl(value: string) {
  const match = String(value || "").match(
    /^https:\/\/media[.]mypersonas[.]online\/approved\/v1\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/,
  );
  return match?.[1] || null;
}

export function approvedMediaProviderUrl(media: ApprovedMedia) {
  return media.deliveryUrl || media.url;
}

function isBlockedIpv4(hostname: string) {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)) return false;
  const octets = hostname.split(".").map(Number);
  if (octets.some((value) => value < 0 || value > 255)) return true;
  const [a, b, c] = octets;
  return a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 0 || b === 168)) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113);
}

function canonicalProjectStorageHost(supabaseUrl: string) {
  let base: URL;
  try {
    base = new URL(supabaseUrl);
  } catch {
    throw new Error("SUPABASE_URL must be a valid public HTTPS project URL.");
  }
  const hostname = base.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    base.protocol !== "https:" || base.username || base.password || base.port ||
    base.pathname !== "/" || base.search || base.hash || !hostname ||
    hostname === "localhost" || hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") || hostname.endsWith(".internal") ||
    hostname.endsWith(".home") || hostname.includes(":") ||
    (!hostname.includes(".") && !/^\d/.test(hostname)) ||
    isBlockedIpv4(hostname)
  ) {
    throw new Error("SUPABASE_URL must be a valid public HTTPS project URL.");
  }
  return hostname;
}

export function validatedRemoteImageUrl(
  value: string,
  supabaseUrl: string,
  owner: string,
) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Approved media source must be a project Storage HTTPS URL.");
  }
  if (!OWNER.test(owner)) throw new Error("Invalid approved-media owner.");
  const projectHost = canonicalProjectStorageHost(supabaseUrl);
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const authority = value.match(/^https:\/\/([^/?#]*)/i)?.[1]?.toLowerCase() || "";
  let decodedPath = "";
  try {
    decodedPath = decodeURIComponent(url.pathname);
  } catch {
    throw new Error("Approved media source has an invalid Storage object path.");
  }
  const ownerPrefix = owner.toLowerCase() + "/";
  const objectPrefix = "/storage/v1/object/public/persona-media/" + ownerPrefix;
  const renderPrefix = "/storage/v1/render/image/public/persona-media/" + ownerPrefix;
  const pathSegments = decodedPath.split("/");
  if (
    url.protocol !== "https:" || url.username || url.password || url.port ||
    hostname !== projectHost || authority !== projectHost ||
    (!url.pathname.startsWith(objectPrefix) &&
      !url.pathname.startsWith(renderPrefix)) ||
    (!decodedPath.startsWith(objectPrefix) &&
      !decodedPath.startsWith(renderPrefix)) ||
    decodedPath === objectPrefix.slice(0, -1) ||
    decodedPath === renderPrefix.slice(0, -1) ||
    decodedPath.includes("\\") || decodedPath.includes("\0") ||
    pathSegments.some((segment) => segment === "." || segment === "..")
  ) {
    throw new Error(
      "Approved media source must be an owner-scoped persona-media URL on this project.",
    );
  }
  url.hash = "";
  return url;
}

export async function readBoundedBytes(
  response: Response,
  maxBytes = APPROVED_MEDIA_MAX_BYTES,
) {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error(`Approved media exceeds the ${maxBytes}-byte limit.`);
  }
  if (!response.body) throw new Error("Approved media response had no body.");

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error(`Approved media exceeds the ${maxBytes}-byte limit.`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (!total) throw new Error("Approved media is empty.");
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

async function fetchRemoteImage(
  sourceUrl: string,
  supabaseUrl: string,
  owner: string,
  fetcher: typeof fetch = fetch,
) {
  const source = validatedRemoteImageUrl(sourceUrl, supabaseUrl, owner);
  const response = await fetcher(source, {
    redirect: "manual",
    headers: { Accept: "image/jpeg,image/png,image/webp" },
    signal: AbortSignal.timeout(20_000),
  });
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("Approved media source must not redirect.");
  }
  if (!response.ok) {
    throw new Error(`Approved media could not be fetched (HTTP ${response.status}).`);
  }
  const bytes = await readBoundedBytes(response);
  const mime = detectImageMime(bytes);
  const declared = (response.headers.get("content-type") || "")
    .split(";", 1)[0].trim().toLowerCase();
  if (
    declared && declared !== "application/octet-stream" &&
    declared !== mime
  ) {
    throw new Error("Approved media response MIME does not match its bytes.");
  }
  return { bytes, mime };
}

export function validateApprovedMediaRecord(
  media: ApprovedMedia,
  supabaseUrl: string,
  owner: string,
) {
  if (!SHA256.test(media.sha256)) throw new Error("Invalid approved-media digest.");
  if (!Number.isSafeInteger(media.byteSize) || media.byteSize < 1 ||
    media.byteSize > APPROVED_MEDIA_MAX_BYTES) {
    throw new Error("Invalid approved-media byte size.");
  }
  const expectedPath = approvedMediaPath(owner, media.sha256, media.mime);
  if (media.path !== expectedPath || !PATH.test(media.path)) {
    throw new Error("Approved-media path does not match its digest and MIME.");
  }
  if (media.url !== approvedMediaUrl(supabaseUrl, media.path)) {
    throw new Error("Approved-media internal URL is not canonical.");
  }
  const deliveryId = String(media.deliveryId || "").toLowerCase();
  const deliveryUrl = String(media.deliveryUrl || "");
  if (deliveryId || deliveryUrl) {
    if (!OPAQUE_V4.test(deliveryId) ||
      deliveryUrl !== approvedMediaDeliveryUrl(deliveryId) ||
      approvedMediaDeliveryIdFromUrl(deliveryUrl) !== deliveryId) {
      throw new Error("Approved-media opaque delivery is not canonical.");
    }
  }
}

export async function verifyApprovedMedia(
  admin: RpcApi & { storage: StorageApi },
  supabaseUrl: string,
  media: ApprovedMedia,
  owner: string,
) {
  validateApprovedMediaRecord(media, supabaseUrl, owner);
  const downloaded = await admin.storage.from(APPROVED_MEDIA_BUCKET).download(media.path);
  if (downloaded.error || !downloaded.data) {
    throw new Error("The approved-media object is missing from Storage.");
  }
  const bytes = new Uint8Array(await downloaded.data.arrayBuffer());
  if (bytes.byteLength !== media.byteSize) {
    throw new Error("The approved-media object size no longer matches approval.");
  }
  const mime = detectImageMime(bytes);
  if (mime !== media.mime) {
    throw new Error("The approved-media object MIME no longer matches approval.");
  }
  const digest = await sha256Hex(bytes);
  if (digest !== media.sha256) {
    throw new Error("The approved-media object checksum no longer matches approval.");
  }
  if (media.deliveryId || media.deliveryUrl) {
    const resolved = await admin.rpc("resolve_post_approved_media_service", {
      p_public_id: media.deliveryId,
    });
    const row = Array.isArray(resolved.data) ? resolved.data[0] : resolved.data;
    if (resolved.error || !row || typeof row !== "object") {
      throw new Error("The approved-media opaque delivery is unavailable.");
    }
    const record = row as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    if (keys.join(",") !== "bucket,byte_size,content_sha256,mime_type,storage_path" ||
      record.bucket !== APPROVED_MEDIA_BUCKET || record.storage_path !== media.path ||
      record.mime_type !== media.mime || Number(record.byte_size) !== media.byteSize ||
      record.content_sha256 !== media.sha256) {
      throw new Error("The approved-media opaque delivery no longer matches approval.");
    }
  }
  return true;
}

export async function stageApprovedMedia(
  admin: RpcApi & { storage: StorageApi },
  supabaseUrl: string,
  sourceUrl: string,
  owner: string,
  fetcher: typeof fetch = fetch,
): Promise<ApprovedMedia> {
  const { bytes, mime } = await fetchRemoteImage(
    sourceUrl,
    supabaseUrl,
    owner,
    fetcher,
  );
  return await stageApprovedMediaBytes(admin, supabaseUrl, bytes, mime, owner);
}

export async function stageApprovedMediaBytes(
  admin: RpcApi & { storage: StorageApi },
  supabaseUrl: string,
  bytes: Uint8Array,
  mime: ApprovedMedia["mime"],
  owner: string,
): Promise<ApprovedMedia> {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 ||
    bytes.byteLength > APPROVED_MEDIA_MAX_BYTES || detectImageMime(bytes) !== mime) {
    throw new Error("Approved media bytes are invalid.");
  }
  const sha256 = await sha256Hex(bytes);
  const path = approvedMediaPath(owner, sha256, mime);
  const media: ApprovedMedia = {
    sha256,
    mime,
    byteSize: bytes.byteLength,
    path,
    url: approvedMediaUrl(supabaseUrl, path),
    deliveryId: "",
    deliveryUrl: "",
  };
  const bucket = admin.storage.from(APPROVED_MEDIA_BUCKET);
  const uploaded = await bucket.upload(path, bytes, {
    contentType: mime,
    cacheControl: "31536000",
    upsert: false,
  });
  // An existing object is expected when two drafts approve identical bytes.
  // Any upload error is accepted only if the exact expected object already
  // exists and independently verifies; all other errors fail closed.
  try {
    await verifyApprovedMedia(admin, supabaseUrl, media, owner);
  } catch (error) {
    if (uploaded.error) {
      throw new Error(
        `Approved media could not be stored: ${uploaded.error.message || "Storage upload failed"}. ${(error as Error).message}`,
      );
    }
    throw error;
  }
  const issued = await admin.rpc("issue_post_approved_media_handle_service", {
    p_owner: owner.toLowerCase(),
    p_storage_path: media.path,
    p_sha256: media.sha256,
    p_mime_type: media.mime,
    p_byte_size: media.byteSize,
  });
  const deliveryId = String(issued.data || "").toLowerCase();
  if (issued.error || !OPAQUE_V4.test(deliveryId)) {
    throw new Error("Approved media could not receive an opaque provider delivery.");
  }
  media.deliveryId = deliveryId;
  media.deliveryUrl = approvedMediaDeliveryUrl(deliveryId);
  await verifyApprovedMedia(admin, supabaseUrl, media, owner);
  return media;
}

/**
 * Resolve an immutable registry asset using a service-only owner boundary,
 * download the exact private Storage bytes, and stage the verified image into
 * the immutable publisher bucket. Neither its owner-correlating Storage path
 * nor a service credential is returned to a caller.
 */
export async function stageApprovedPersonaMediaAsset(
  admin: RpcApi & { storage: StorageApi },
  supabaseUrl: string,
  serviceRoleKey: string,
  assetId: string,
  owner: string,
  fetcher: typeof fetch = fetch,
): Promise<ApprovedMedia> {
  if (!OWNER.test(owner) || !OWNER.test(assetId) || !serviceRoleKey) {
    throw new Error("Invalid persona-media approval boundary.");
  }
  const resolved = await admin.rpc("resolve_persona_media_asset_service", {
    p_owner: owner.toLowerCase(),
    p_asset_id: assetId.toLowerCase(),
  });
  const row = Array.isArray(resolved.data) ? resolved.data[0] : resolved.data;
  if (resolved.error || !row) {
    throw new Error("The bound persona media asset is unavailable.");
  }
  const resolution = validatePublicMediaResolution(row);
  if (resolution.byte_size > APPROVED_MEDIA_MAX_BYTES ||
    !["image/jpeg", "image/png", "image/webp"].includes(resolution.mime_type)) {
    throw new Error("The bound persona media asset is not a supported publish image.");
  }
  const base = new URL(supabaseUrl);
  if (base.protocol !== "https:" || base.username || base.password || base.port ||
    base.pathname !== "/" || base.search || base.hash) {
    throw new Error("SUPABASE_URL must be a canonical HTTPS project URL.");
  }
  const encodedPath = resolution.storage_path.split("/").map(encodeURIComponent).join("/");
  const response = await fetcher(
    `${base.origin}/storage/v1/object/${resolution.bucket}/${encodedPath}`,
    {
      method: "GET",
      redirect: "error",
      headers: {
        "Authorization": `Bearer ${serviceRoleKey}`,
        "apikey": serviceRoleKey,
        "Accept": "image/jpeg,image/png,image/webp",
        "Accept-Encoding": "identity",
      },
      signal: AbortSignal.timeout(20_000),
    },
  );
  const bytes = await readExactPublicMediaResponse(response, resolution.byte_size);
  await verifyResolvedPublicMedia(bytes, resolution);
  const mime = detectImageMime(bytes);
  if (mime !== resolution.mime_type) {
    throw new Error("The bound persona media MIME no longer matches its bytes.");
  }
  return await stageApprovedMediaBytes(admin, base.origin, bytes, mime, owner);
}
