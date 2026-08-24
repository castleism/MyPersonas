// Persona Source Library -- private image intake, preview, download, and deletion.
//
// Source images are private evidence/reference material. This endpoint never
// creates a public media handle, never returns a Storage path or content hash,
// and never sends bytes to an AI provider. A separate, consent-gated worker
// may later consume queued study jobs.

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { requireAal2 } from "../_shared/aal2.ts";
import { loadAppOrigins } from "../_shared/app-origin.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const BUCKET = "persona-source-library";
const MAX_REQUEST_BYTES = 12 * 1024 * 1024;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_SOURCE_PIXELS = 40_000_000;
const MAX_JSON_BYTES = 4_096;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const INTENTS = new Set(["research", "content_later", "unsorted", "archive"]);
const AI_USES = new Set(["none", "assisted", "generated", "unknown"]);
const RIGHTS = new Set(["owner_created", "licensed", "reference_only", "unknown"]);
const REUSE = new Set(["reference_only", "derivative_allowed", "publish_allowed"]);
const SENSITIVITY = new Set(["standard", "sensitive", "restricted"]);
const ALLOWED_ORIGINS = loadAppOrigins((name) => Deno.env.get(name));

type DetectedImage = {
  mime: "image/png" | "image/jpeg" | "image/webp";
  extension: "png" | "jpg" | "webp";
  width: number;
  height: number;
};

type SourceResolution = {
  storage_path: string;
  source_sha256: string;
  mime_type: string;
  byte_size: number;
  original_filename: string;
};

type StorageEntry = {
  id?: string | null;
  metadata?: unknown;
  name?: string | null;
};

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function cors(origin: string): Record<string, string> {
  return origin && ALLOWED_ORIGINS.has(origin)
    ? {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Vary": "Origin",
    }
    : {};
}

function json(body: unknown, status = 200, origin = "") {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: {
      ...cors(origin),
      "Cache-Control": "no-store, max-age=0",
      "Content-Type": "application/json; charset=utf-8",
      "Content-Security-Policy": "default-src 'none'",
      "Cross-Origin-Resource-Policy": "same-origin",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function starts(bytes: Uint8Array, values: readonly number[], offset = 0) {
  return values.every((value, index) => bytes[offset + index] === value);
}

function ascii(bytes: Uint8Array, start: number, length: number) {
  if (start < 0 || length < 0 || start + length > bytes.byteLength) return "";
  return String.fromCharCode(...bytes.slice(start, start + length));
}

function uint16be(bytes: Uint8Array, offset: number) {
  return (bytes[offset] << 8) | bytes[offset + 1];
}

function uint16le(bytes: Uint8Array, offset: number) {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function uint24le(bytes: Uint8Array, offset: number) {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function uint32be(bytes: Uint8Array, offset: number) {
  return ((bytes[offset] * 0x1000000) + (bytes[offset + 1] << 16) +
    (bytes[offset + 2] << 8) + bytes[offset + 3]) >>> 0;
}

function uint32le(bytes: Uint8Array, offset: number) {
  return (bytes[offset] + (bytes[offset + 1] << 8) + (bytes[offset + 2] << 16) +
    (bytes[offset + 3] * 0x1000000)) >>> 0;
}

function pngDimensions(bytes: Uint8Array) {
  if (bytes.byteLength < 24 || ascii(bytes, 12, 4) !== "IHDR") return null;
  return { width: uint32be(bytes, 16), height: uint32be(bytes, 20) };
}

function jpegDimensions(bytes: Uint8Array) {
  const frames = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  for (let offset = 2; offset + 8 < bytes.byteLength;) {
    if (bytes[offset] !== 0xff) { offset += 1; continue; }
    while (offset < bytes.byteLength && bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++];
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 1 >= bytes.byteLength) break;
    const length = uint16be(bytes, offset);
    if (length < 2 || offset + length > bytes.byteLength) break;
    if (frames.has(marker) && length >= 7) {
      return { width: uint16be(bytes, offset + 5), height: uint16be(bytes, offset + 3) };
    }
    offset += length;
  }
  return null;
}

function webpDimensions(bytes: Uint8Array) {
  if (bytes.byteLength < 30) return null;
  const chunk = ascii(bytes, 12, 4);
  if (chunk === "VP8X") return { width: uint24le(bytes, 24) + 1, height: uint24le(bytes, 27) + 1 };
  if (chunk === "VP8L" && bytes[20] === 0x2f) {
    return {
      width: 1 + bytes[21] + ((bytes[22] & 0x3f) << 8),
      height: 1 + ((bytes[22] & 0xc0) >> 6) + (bytes[23] << 2) + ((bytes[24] & 0x0f) << 10),
    };
  }
  if (chunk === "VP8 " && starts(bytes, [0x9d, 0x01, 0x2a], 23)) {
    return { width: uint16le(bytes, 26) & 0x3fff, height: uint16le(bytes, 28) & 0x3fff };
  }
  return null;
}

export function detectPersonaSourceImage(bytes: Uint8Array): DetectedImage {
  let mime: DetectedImage["mime"];
  let extension: DetectedImage["extension"];
  let dimensions: { width: number; height: number } | null;
  if (bytes.byteLength >= 24 && starts(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    mime = "image/png"; extension = "png"; dimensions = pngDimensions(bytes);
  } else if (bytes.byteLength >= 10 && starts(bytes, [0xff, 0xd8, 0xff])) {
    mime = "image/jpeg"; extension = "jpg"; dimensions = jpegDimensions(bytes);
  } else if (bytes.byteLength >= 30 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") {
    mime = "image/webp"; extension = "webp"; dimensions = webpDimensions(bytes);
  } else {
    throw new Error("Use a PNG, JPEG, or WebP image");
  }
  if (!dimensions || !Number.isSafeInteger(dimensions.width) || !Number.isSafeInteger(dimensions.height) ||
      dimensions.width < 16 || dimensions.height < 16 ||
      dimensions.width * dimensions.height > MAX_SOURCE_PIXELS) {
    throw new Error("The image dimensions are unsafe or unsupported");
  }
  return { mime, extension, ...dimensions };
}

export function safeSourceFilename(value: unknown, extension = "img") {
  const raw = typeof value === "string" ? value.normalize("NFKC") : "";
  const withoutPath = raw.split(/[\\/]/).pop() || "source";
  const stem = withoutPath.replace(/\.[^.]{1,10}$/u, "").replace(/[\u0000-\u001f\u007f<>:"|?*]+/gu, " ")
    .replace(/\s+/g, " ").trim().slice(0, 100) || "source";
  const ext = /^[a-z0-9]{1,8}$/i.test(extension) ? extension.toLowerCase() : "img";
  return `${stem}.${ext}`;
}

export function parseSourceTags(value: unknown) {
  let candidate: unknown = value;
  if (typeof value === "string") {
    try { candidate = JSON.parse(value); } catch { candidate = value.split(","); }
  }
  if (!Array.isArray(candidate)) return [];
  const seen = new Set<string>();
  for (const item of candidate.slice(0, 40)) {
    const tag = String(item ?? "").normalize("NFKC").replace(/[\u0000-\u001f\u007f]/gu, "")
      .trim().replace(/\s+/g, " ").slice(0, 48);
    if (tag) seen.add(tag);
    if (seen.size >= 20) break;
  }
  return [...seen];
}

async function sha256Hex(bytes: Uint8Array) {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy.buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function caller(req: Request) {
  const bearer = (req.headers.get("Authorization") ?? "").match(/^Bearer\s+([^\s]+)$/i)?.[1] ?? "";
  if (!bearer) return null;
  const result = await admin.auth.getUser(bearer);
  return result.error ? null : result.data.user;
}

async function boundedJson(req: Request) {
  const stated = req.headers.get("content-length");
  if (stated && (!/^\d{1,5}$/.test(stated) || Number(stated) > MAX_JSON_BYTES)) throw new Error("invalid size");
  if (!req.body) throw new Error("missing body");
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_JSON_BYTES) { await reader.cancel().catch(() => undefined); throw new Error("too large"); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid body");
  return parsed as Record<string, unknown>;
}

async function consumeRateLimit(owner: string, action: "upload" | "byte_read" | "delete") {
  const result = await admin.rpc("consume_persona_source_rate_limit_service", {
    p_owner: owner,
    p_action: action,
  });
  const receipt = result.data && typeof result.data === "object" && !Array.isArray(result.data)
    ? result.data as Record<string, unknown>
    : null;
  return !result.error && receipt?.allowed === true && receipt.action === action;
}

function normalizeResolution(value: unknown): SourceResolution | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const storagePath = typeof row.storage_path === "string" ? row.storage_path : "";
  const sha = typeof row.source_sha256 === "string" ? row.source_sha256.toLowerCase() : "";
  const mime = typeof row.mime_type === "string" ? row.mime_type : "";
  const size = Number(row.byte_size);
  const filename = typeof row.original_filename === "string" ? row.original_filename : "source";
  if (!storagePath || !SHA256.test(sha) || !["image/png", "image/jpeg", "image/webp"].includes(mime) ||
      !Number.isSafeInteger(size) || size < 1 || size > MAX_IMAGE_BYTES) return null;
  return { storage_path: storagePath, source_sha256: sha, mime_type: mime, byte_size: size, original_filename: filename };
}

async function resolveSource(owner: string, assetId: string) {
  const result = await admin.rpc("resolve_persona_source_asset_service", {
    p_owner: owner,
    p_asset_id: assetId,
  });
  return result.error ? null : normalizeResolution(result.data);
}

async function verifiedSourceBytes(client: SupabaseClient, source: SourceResolution) {
  const downloaded = await client.storage.from(BUCKET).download(source.storage_path);
  if (downloaded.error || !downloaded.data) throw new Error("unavailable");
  const bytes = new Uint8Array(await downloaded.data.arrayBuffer());
  if (bytes.byteLength !== source.byte_size || await sha256Hex(bytes) !== source.source_sha256) {
    throw new Error("integrity");
  }
  const detected = detectPersonaSourceImage(bytes);
  if (detected.mime !== source.mime_type) throw new Error("type mismatch");
  return bytes;
}

async function listPrivatePrefixFiles(
  prefix: string,
  visited = new Set<string>(),
  files: string[] = [],
): Promise<string[]> {
  if (visited.has(prefix)) return files;
  if (visited.size >= 12_000 || files.length >= 12_000) throw new Error("private prefix is unexpectedly large");
  visited.add(prefix);
  let offset = 0;
  for (;;) {
    const listed = await admin.storage.from(BUCKET).list(prefix, {
      limit: 1_000,
      offset,
      sortBy: { column: "name", order: "asc" },
    });
    if (listed.error) throw new Error("private prefix could not be listed");
    const entries = (listed.data ?? []) as StorageEntry[];
    for (const entry of entries) {
      const name = typeof entry.name === "string" ? entry.name : "";
      if (!name || name === "." || name === ".." || /[\\/\u0000-\u001f\u007f]/u.test(name)) {
        throw new Error("private prefix contained an unsafe entry");
      }
      const path = `${prefix}/${name}`;
      if (entry.id || entry.metadata) files.push(path);
      else await listPrivatePrefixFiles(path, visited, files);
      if (files.length > 12_000) throw new Error("private prefix is unexpectedly large");
    }
    if (entries.length < 1_000) return files;
    offset += entries.length;
  }
}

async function erasePrivatePrefix(prefix: string) {
  for (let pass = 0; pass < 3; pass += 1) {
    const files = await listPrivatePrefixFiles(prefix);
    if (!files.length) return true;
    for (let start = 0; start < files.length; start += 500) {
      const removed = await admin.storage.from(BUCKET).remove(files.slice(start, start + 500));
      if (removed.error) return false;
    }
  }
  return (await listPrivatePrefixFiles(prefix)).length === 0;
}

async function handleUpload(req: Request, origin: string, owner: string) {
  const stated = req.headers.get("content-length") ?? "";
  if (!/^\d{1,9}$/.test(stated) || Number(stated) < 1 || Number(stated) > MAX_REQUEST_BYTES) {
    return json({ error: "A bounded multipart upload is required" }, 413, origin);
  }
  if (!await consumeRateLimit(owner, "upload")) return json({ error: "Upload rate limit reached" }, 429, origin);
  let form: FormData;
  try { form = await req.formData(); } catch { return json({ error: "Invalid multipart upload" }, 400, origin); }
  const file = form.get("file");
  const personaId = String(form.get("personaId") ?? "").toLowerCase();
  const intent = String(form.get("intent") ?? "").toLowerCase();
  const aiUse = String(form.get("aiUse") ?? "").toLowerCase();
  const rights = String(form.get("rightsBasis") ?? "").toLowerCase();
  const reuse = String(form.get("reusePolicy") ?? "").toLowerCase();
  const sensitivity = String(form.get("sensitivity") ?? "").toLowerCase();
  const analysisConsent = String(form.get("analysisConsent") ?? "false").toLowerCase() === "true";
  const title = String(form.get("title") ?? "").replace(/\0/g, "").trim().slice(0, 160);
  const ownerNotes = String(form.get("ownerNotes") ?? "").replace(/\0/g, "").trim().slice(0, 4_000);
  const capturedAtRaw = String(form.get("capturedAt") ?? "").trim();
  const capturedAt = capturedAtRaw && Number.isFinite(Date.parse(capturedAtRaw))
    ? new Date(capturedAtRaw).toISOString()
    : null;
  const idempotencyKey = String(form.get("idempotencyKey") ?? "").toLowerCase();
  const tags = parseSourceTags(form.get("tags"));
  if (!(file instanceof File) || !UUID.test(personaId) || !INTENTS.has(intent) || !AI_USES.has(aiUse) ||
      !RIGHTS.has(rights) || !REUSE.has(reuse) || !SENSITIVITY.has(sensitivity) || !UUID.test(idempotencyKey)) {
    return json({ error: "Source metadata is invalid" }, 400, origin);
  }
  if (file.size < 1 || file.size > MAX_IMAGE_BYTES) return json({ error: "Images must be 10 MB or smaller" }, 413, origin);
  const persona = await admin.from("personas").select("id").eq("id", personaId).eq("owner", owner).maybeSingle();
  if (persona.error) return json({ error: "Persona ownership could not be verified" }, 503, origin);
  if (!persona.data) return json({ error: "Owned persona not found" }, 404, origin);
  const bytes = new Uint8Array(await file.arrayBuffer());
  let detected: DetectedImage;
  try { detected = detectPersonaSourceImage(bytes); }
  catch (error) { return json({ error: (error as Error).message }, 415, origin); }
  const declared = String(file.type ?? "").toLowerCase();
  if (declared && declared !== "application/octet-stream" && declared !== detected.mime) {
    return json({ error: "The declared image type does not match its bytes" }, 415, origin);
  }
  const digest = await sha256Hex(bytes);
  const path = `${owner.toLowerCase()}/personas/${personaId}/source/${idempotencyKey}-${digest}.${detected.extension}`;
  const removeUnregisteredDuplicate = async () => {
    try {
      const removed = await admin.storage.from(BUCKET).remove([path]);
      if (removed.error) return false;
      return true;
    } catch {
      return false;
    }
  };
  const reserved = await admin.rpc("reserve_persona_source_upload_service", {
    p_owner: owner,
    p_persona_id: personaId,
    p_byte_size: bytes.byteLength,
    p_source_sha256: digest,
    p_idempotency_key: idempotencyKey,
  });
  const reservation = reserved.data && typeof reserved.data === "object" && !Array.isArray(reserved.data)
    ? reserved.data as Record<string, unknown>
    : null;
  if (reserved.error || !reservation || !["reserved", "registered"].includes(String(reservation.status ?? ""))) {
    return json({ error: "The private-library quota reservation was denied" }, 409, origin);
  }
  if (reservation.status === "registered") {
    const existingAssetId = String(reservation.asset_id ?? "");
    if (!UUID.test(existingAssetId)) return json({ error: "The upload retry state is invalid" }, 503, origin);
    if (reservation.duplicate === true && !await removeUnregisteredDuplicate()) {
      return json({ error: "An unregistered duplicate object still requires private cleanup" }, 503, origin);
    }
    return json({
      assetId: existingAssetId.toLowerCase(), duplicate: true, mime: detected.mime,
      byteSize: bytes.byteLength, width: detected.width, height: detected.height,
      filename: safeSourceFilename(file.name, detected.extension), intent,
      analysisState: "not_requested",
    }, 200, origin);
  }
  let reservationActive = true;
  const releaseReservation = async () => {
    if (!reservationActive) return;
    reservationActive = false;
    try {
      const released = await admin.rpc("release_persona_source_upload_service", {
        p_owner: owner,
        p_idempotency_key: idempotencyKey,
      });
      if (released.error) console.error("persona source reservation release failed");
    } catch {
      console.error("persona source reservation release failed");
    }
  };
  const existing = await admin.storage.from(BUCKET).download(path);
  let createdObject = false;
  let storageWriteRequired = true;
  if (existing.data && !existing.error) {
    const oldBytes = new Uint8Array(await existing.data.arrayBuffer());
    if (oldBytes.byteLength !== bytes.byteLength || await sha256Hex(oldBytes) !== digest) {
      await releaseReservation();
      return json({ error: "An immutable source path failed verification" }, 409, origin);
    }
    storageWriteRequired = false;
  }
  // This service-only transition is the deletion/upload race boundary. A
  // reservation is not permission to write: immediately before any possible
  // Storage write it must become `writing`, which deletion guards can deny.
  const begunWrite = await admin.rpc("begin_persona_source_storage_write_service", {
    p_owner: owner,
    p_idempotency_key: idempotencyKey,
  });
  const writeReceipt = begunWrite.data && typeof begunWrite.data === "object" && !Array.isArray(begunWrite.data)
    ? begunWrite.data as Record<string, unknown>
    : null;
  const writeStatus = String(writeReceipt?.status ?? "");
  const writeGuardConflict = /PERSONA_SOURCE_(?:PERSONA|ACCOUNT)_DELETING/.test([
    begunWrite.error?.code,
    begunWrite.error?.message,
    begunWrite.error?.details,
    begunWrite.error?.hint,
  ].filter(Boolean).join(" "));
  if (begunWrite.error || !writeReceipt || writeReceipt.persona_id !== personaId) {
    await releaseReservation();
    return writeGuardConflict
      ? json({ error: "Private source uploads are paused while deletion is in progress" }, 409, origin)
      : json({ error: "The private source write guard could not be verified" }, 503, origin);
  }
  if (writeStatus !== "writing") {
    await releaseReservation();
    return json({ error: "Private source uploads are paused while deletion is in progress" }, 409, origin);
  }
  if (storageWriteRequired) {
    const upload = await admin.storage.from(BUCKET).upload(path, bytes, {
      contentType: detected.mime,
      cacheControl: "0",
      upsert: false,
    });
    if (upload.error) {
      if (!/already exists|duplicate/i.test(upload.error.message ?? "")) {
        await releaseReservation();
        return json({ error: "The private source could not be stored" }, 502, origin);
      }
      const retry = await admin.storage.from(BUCKET).download(path);
      if (retry.error || !retry.data) {
        await releaseReservation();
        return json({ error: "A duplicate source could not be verified" }, 409, origin);
      }
      const oldBytes = new Uint8Array(await retry.data.arrayBuffer());
      if (oldBytes.byteLength !== bytes.byteLength || await sha256Hex(oldBytes) !== digest) {
        await releaseReservation();
        return json({ error: "A duplicate source failed integrity verification" }, 409, origin);
      }
    } else createdObject = true;
  }
  const filename = safeSourceFilename(file.name, detected.extension);
  const registered = await admin.rpc("register_persona_source_asset_service", {
    p_owner: owner,
    p_persona_id: personaId,
    p_storage_path: path,
    p_source_sha256: digest,
    p_mime_type: detected.mime,
    p_byte_size: bytes.byteLength,
    p_width: detected.width,
    p_height: detected.height,
    p_original_filename: filename,
    p_intent: intent,
    p_ai_use: aiUse,
    p_rights_basis: rights,
    p_reuse_policy: reuse,
    p_sensitivity: sensitivity,
    p_analysis_consent: analysisConsent,
    p_title: title,
    p_owner_notes: ownerNotes,
    p_owner_tags: tags,
    p_captured_at: capturedAt,
    p_idempotency_key: idempotencyKey,
  });
  const registration = Array.isArray(registered.data) ? registered.data[0] : registered.data;
  const assetId = registration && typeof registration === "object"
    ? String((registration as Record<string, unknown>).asset_id ?? "")
    : String(registration ?? "");
  const duplicate = registration && typeof registration === "object"
    ? (registration as Record<string, unknown>).duplicate === true
    : !createdObject;
  if (registered.error || !UUID.test(assetId)) {
    if (createdObject) {
      try {
        const removed = await admin.storage.from(BUCKET).remove([path]);
        if (removed.error) console.error("persona source registration rollback failed");
      } catch {
        console.error("persona source registration rollback failed");
      }
    }
    await releaseReservation();
    return json({ error: "The source bytes were not registered safely" }, 500, origin);
  }
  if (duplicate && !await removeUnregisteredDuplicate()) {
    return json({ error: "An unregistered duplicate object still requires private cleanup" }, 503, origin);
  }
  reservationActive = false;
  return json({
    assetId: assetId.toLowerCase(),
    duplicate,
    mime: detected.mime,
    byteSize: bytes.byteLength,
    width: detected.width,
    height: detected.height,
    filename,
    intent,
    analysisState: "not_requested",
  }, 200, origin);
}

async function handleBytes(origin: string, owner: string, assetId: string, download: boolean) {
  if (!await consumeRateLimit(owner, "byte_read")) return json({ error: "Source read rate limit reached" }, 429, origin);
  const source = await resolveSource(owner, assetId);
  if (!source) return json({ error: "Source unavailable" }, 404, origin);
  try {
    const bytes = await verifiedSourceBytes(admin, source);
    const extension = ({ "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" } as Record<string, string>)[source.mime_type] ?? "img";
    const filename = safeSourceFilename(source.original_filename, extension).replace(/["\\]/g, "_");
    return new Response(bytes.buffer, {
      status: 200,
      headers: {
        ...cors(origin),
        "Cache-Control": "no-store, max-age=0",
        "Content-Disposition": `${download ? "attachment" : "inline"}; filename="${filename}"`,
        "Content-Length": String(bytes.byteLength),
        "Content-Security-Policy": "default-src 'none'",
        "Content-Type": source.mime_type,
        "Cross-Origin-Resource-Policy": "same-origin",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    console.error("persona source exact-byte verification failed", error instanceof Error ? error.name : "unknown");
    return json({ error: "Source integrity could not be verified" }, 502, origin);
  }
}

async function handleDelete(origin: string, owner: string, assetId: string) {
  if (!await consumeRateLimit(owner, "delete")) return json({ error: "Source delete rate limit reached" }, 429, origin);
  const begun = await admin.rpc("begin_persona_source_asset_deletion_service", {
    p_owner: owner,
    p_asset_id: assetId,
  });
  const receipt = begun.data && typeof begun.data === "object" && !Array.isArray(begun.data)
    ? begun.data as Record<string, unknown>
    : null;
  const activeStudies = typeof receipt?.active_studies === "number"
    ? receipt.active_studies
    : Number.NaN;
  const bulkGuardConflict = /PERSONA_SOURCE_(?:PERSONA|ACCOUNT)_DELETING/.test([
    begun.error?.code,
    begun.error?.message,
    begun.error?.details,
    begun.error?.hint,
  ].filter(Boolean).join(" "));
  if (begun.error) {
    return bulkGuardConflict
      ? json({
        error: "This source cannot be deleted while persona or account deletion is in progress.",
        retryable: true,
      }, 409, origin)
      : json({ error: "Private source deletion could not be prepared" }, 503, origin);
  }
  if (!receipt || receipt.status !== "deleting" || receipt.asset_id !== assetId ||
      !Number.isSafeInteger(activeStudies) || activeStudies < 0) {
    return json({ error: "Private source deletion could not be verified" }, 503, origin);
  }
  if (activeStudies > 0) {
    return json({
      error: "A claimed source study is still cancelling. Retry deletion after it reaches a terminal state.",
      activeStudies,
      retryable: true,
    }, 409, origin);
  }
  const source = await resolveSource(owner, assetId);
  if (!source) return json({ error: "Source unavailable" }, 404, origin);
  const removed = await admin.storage.from(BUCKET).remove([source.storage_path]);
  if (removed.error) return json({ error: "The private bytes could not be deleted" }, 502, origin);
  const deleted = await admin.rpc("delete_persona_source_asset_metadata_service", {
    p_owner: owner,
    p_asset_id: assetId,
    p_expected_storage_path: source.storage_path,
    p_expected_sha256: source.source_sha256,
  });
  const deletion = deleted.data && typeof deleted.data === "object"
    ? deleted.data as { deleted?: unknown; status?: unknown }
    : null;
  if (deleted.error || deletion?.deleted !== true || deletion.status !== "deleted") {
    return json({ error: "The bytes were removed, but metadata cleanup requires retry" }, 503, origin);
  }
  return json({ deleted: true }, 200, origin);
}

async function handlePersonaLibraryDelete(origin: string, owner: string, personaId: string) {
  if (!await consumeRateLimit(owner, "delete")) return json({ error: "Source delete rate limit reached" }, 429, origin);
  const persona = await admin.from("personas").select("id").eq("id", personaId).eq("owner", owner).maybeSingle();
  if (persona.error) return json({ error: "Persona ownership could not be verified" }, 503, origin);
  if (!persona.data) return json({ error: "Owned persona not found" }, 404, origin);
  const begun = await admin.rpc("begin_persona_source_deletion_service", {
    p_owner: owner,
    p_persona_id: personaId,
  });
  const receipt = begun.data && typeof begun.data === "object" && !Array.isArray(begun.data)
    ? begun.data as Record<string, unknown>
    : null;
  const expectedPrefix = `${owner.toLowerCase()}/personas/${personaId}/`;
  const state = String(receipt?.status ?? "");
  const activeWrites = typeof receipt?.active_writes === "number"
    ? receipt.active_writes
    : Number.NaN;
  const activeStudies = typeof receipt?.active_studies === "number"
    ? receipt.active_studies
    : Number.NaN;
  if (begun.error || !receipt || !["active", "metadata_deleted"].includes(state) ||
      receipt.persona_prefix !== expectedPrefix || !Number.isSafeInteger(activeWrites) || activeWrites < 0 ||
      !Number.isSafeInteger(activeStudies) || activeStudies < 0) {
    return json({ error: "Persona source deletion could not be prepared" }, 503, origin);
  }
  if (activeWrites > 0 || activeStudies > 0) {
    return json({
      error: "Private source uploads or claimed studies are still finishing. Retry persona deletion after they settle.",
      activeWrites,
      activeStudies,
      retryable: true,
    }, 409, origin);
  }
  try {
    if (!await erasePrivatePrefix(expectedPrefix)) {
      return json({ error: "Persona private bytes could not be deleted" }, 502, origin);
    }
  } catch {
    return json({ error: "Persona private-byte deletion could not be verified" }, 502, origin);
  }
  if (state === "metadata_deleted") {
    return json({ deleted: true, personaId, assetsDeleted: 0, resumed: true }, 200, origin);
  }
  const finalized = await admin.rpc("delete_persona_source_library_for_persona_service", {
    p_owner: owner,
    p_persona_id: personaId,
  });
  const result = finalized.data && typeof finalized.data === "object" && !Array.isArray(finalized.data)
    ? finalized.data as Record<string, unknown>
    : null;
  const assetsDeleted = Number(result?.assets_deleted);
  if (finalized.error || !result || result.persona_id !== personaId ||
      !Number.isSafeInteger(assetsDeleted) || assetsDeleted < 0) {
    return json({ error: "Persona source metadata deletion requires retry" }, 503, origin);
  }
  return json({ deleted: true, personaId, assetsDeleted }, 200, origin);
}

serve(async (req) => {
  const origin = req.headers.get("Origin") ?? "";
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origin) });
  if (origin && !ALLOWED_ORIGINS.has(origin)) return json({ error: "Origin not allowed" }, 403);
  if (req.method !== "POST") return json({ error: "POST only" }, 405, origin);
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) return json({ error: "Source Library unavailable" }, 503, origin);
  const user = await caller(req);
  if (!user) return json({ error: "Sign in first" }, 401, origin);
  const contentType = (req.headers.get("content-type") ?? "").toLowerCase();
  if (contentType.startsWith("multipart/form-data")) return handleUpload(req, origin, user.id);
  if (!contentType.startsWith("application/json")) return json({ error: "Unsupported request type" }, 415, origin);
  let payload: Record<string, unknown>;
  try { payload = await boundedJson(req); } catch { return json({ error: "Invalid request" }, 400, origin); }
  const action = typeof payload.action === "string" ? payload.action : "";
  const personaId = typeof payload.personaId === "string" && UUID.test(payload.personaId)
    ? payload.personaId.toLowerCase()
    : "";
  const assetId = typeof payload.assetId === "string" && UUID.test(payload.assetId)
    ? payload.assetId.toLowerCase()
    : "";
  if (action === "delete" || action === "deletePersonaLibrary") {
    const assurance = await requireAal2(req, admin);
    if (!assurance.ok) {
      return json({ error: assurance.error, code: assurance.code }, assurance.status, origin);
    }
    if (assurance.user.id !== user.id) return json({ error: "Sign in again" }, 401, origin);
    if (action === "deletePersonaLibrary") {
      if (!personaId) return json({ error: "Invalid request" }, 400, origin);
      return handlePersonaLibraryDelete(origin, user.id, personaId);
    }
    if (!assetId) return json({ error: "Invalid request" }, 400, origin);
    return handleDelete(origin, user.id, assetId);
  }
  if (!assetId || !["preview", "download"].includes(action)) return json({ error: "Invalid request" }, 400, origin);
  return handleBytes(origin, user.id, assetId, action === "download");
});
