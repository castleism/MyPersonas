// AAL2 owner inventory, exact-byte preview, explicit AI-use declaration, and
// canonical import/clear for references to the historical public `media`
// bucket. This endpoint never privatizes or purges either Storage bucket.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { requireAal2 } from "../_shared/aal2.ts";
import { loadAppOrigins } from "../_shared/app-origin.ts";
import {
  detectLegacyMedia,
  legacyMediaPreviewHeaders,
  legacyMediaSha256,
  MAX_LEGACY_MEDIA_BYTES,
  readBoundedLegacyMediaResponse,
  validateLegacyMediaImportResolution,
  validateLegacyMediaResolution,
} from "../_shared/legacy-media-remediation.ts";
import {
  LEGACY_AI_MAX_SOURCE_BYTES,
  LEGACY_FINAL_IMAGE_MAX_BYTES,
  LEGACY_WATERMARK_SHA256,
  LEGACY_WATERMARK_VERSION,
  legacyMediaExtension,
  renderLegacyRasterDerivative,
  validateLegacyStaticRaster,
} from "../_shared/legacy-media-raster.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ALLOWED_ORIGINS = loadAppOrigins((name) => Deno.env.get(name));
const LEGACY_MEDIA_065_ACTIONS_ENABLED =
  Deno.env.get("LEGACY_MEDIA_065_ACTIONS_ENABLED") === "OWNER_APPROVED_AFTER_MIGRATION_065";
const ACTIONS = new Set([
  "inventory",
  "list",
  "preview",
  ...(LEGACY_MEDIA_065_ACTIONS_ENABLED ? ["declare", "import", "clear"] : []),
]);
const SAFE_STATES = new Set([
  "pending",
  "missing",
  "blocked_cross_owner",
  "blocked_persona",
  "blocked_shared_product",
  "stale",
  "imported",
  "cleared",
]);
const AI_USES = new Set(["none", "assisted", "generated", "unknown"]);

type JsonRecord = Record<string, unknown>;

function cors(origin: string): Record<string, string> {
  return ALLOWED_ORIGINS.has(origin) ? {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  } : {};
}

function securityHeaders(origin: string) {
  return {
    ...cors(origin),
    "Cache-Control": "no-store, max-age=0",
    "Content-Security-Policy": "default-src 'none'",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  };
}

function json(body: unknown, status: number, origin: string) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...securityHeaders(origin),
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

function errorResponse(
  status: number,
  origin: string,
  code: string,
  message: string,
) {
  return json({ error: { code, message } }, status, origin);
}

async function boundedJson(req: Request) {
  const stated = req.headers.get("content-length");
  if (stated && (!/^\d{1,5}$/.test(stated) || Number(stated) > 4096)) {
    throw new Error("invalid request");
  }
  const contentType = (req.headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json" || !req.body) throw new Error("invalid request");
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > 4096) {
      await reader.cancel().catch(() => undefined);
      throw new Error("invalid request");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid request");
  return value as JsonRecord;
}

function exactKeys(body: JsonRecord, required: readonly string[], optional: readonly string[] = []) {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.prototype.hasOwnProperty.call(body, key)) &&
    Object.keys(body).every((key) => allowed.has(key));
}

function integer(value: unknown, fallback: number, minimum: number, maximum: number) {
  if (value === undefined) return fallback;
  return Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= maximum
    ? Number(value)
    : null;
}

function safeCount(value: unknown) {
  const count = Number(value);
  return Number.isSafeInteger(count) && count >= 0 && count <= 1_000_000 ? count : 0;
}

function safeText(value: unknown, maximum: number) {
  return typeof value === "string" ? value.slice(0, maximum) : "";
}

function safeUuid(value: unknown) {
  return typeof value === "string" && UUID.test(value) ? value : null;
}

async function fetchLegacyBytes(
  resolution: { bucket: string; storage_path: string; expected_byte_size: number },
) {
  const encodedPath = resolution.storage_path.split("/").map(encodeURIComponent).join("/");
  const response = await fetch(
    `${SUPABASE_URL.replace(/\/$/, "")}/storage/v1/object/${resolution.bucket}/${encodedPath}`,
    {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${SERVICE_ROLE_KEY}`,
        "apikey": SERVICE_ROLE_KEY,
        "Accept-Encoding": "identity",
      },
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    },
  );
  return await readBoundedLegacyMediaResponse(response, resolution.expected_byte_size);
}

async function verifyExistingCanonicalObject(
  admin: {
    storage: {
      from(bucket: string): {
        download(path: string): PromiseLike<{
          data: Blob | null;
          error: { message: string } | null;
        }>;
      };
    };
  },
  path: string,
  expected: Uint8Array,
  expectedSha256: string,
) {
  const downloaded = await admin.storage.from("persona-media").download(path);
  if (downloaded.error || !downloaded.data || downloaded.data.size !== expected.byteLength ||
      downloaded.data.size > MAX_LEGACY_MEDIA_BYTES) {
    throw new Error("immutable object mismatch");
  }
  const bytes = new Uint8Array(await downloaded.data.arrayBuffer());
  if (bytes.byteLength !== expected.byteLength ||
      await legacyMediaSha256(bytes) !== expectedSha256) {
    throw new Error("immutable object mismatch");
  }
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("Origin") ?? "";
  if (!ALLOWED_ORIGINS.has(origin)) {
    return errorResponse(403, "", "origin_not_allowed", "This origin is not allowed");
  }
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: securityHeaders(origin) });
  }
  if (req.method !== "POST") {
    return errorResponse(405, origin, "invalid_request", "POST is required");
  }
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    return errorResponse(503, origin, "media_unavailable", "Legacy media service unavailable");
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const assurance = await requireAal2(req, admin);
  if (!assurance.ok) {
    return errorResponse(assurance.status, origin, assurance.code, assurance.error);
  }
  const owner = assurance.user.id.toLowerCase();
  if (!UUID.test(owner)) {
    return errorResponse(401, origin, "authentication_required", "Sign in again");
  }

  let body: JsonRecord;
  try {
    body = await boundedJson(req);
  } catch {
    return errorResponse(400, origin, "invalid_request", "Invalid request");
  }
  const action = typeof body.action === "string" ? body.action : "";
  if (!ACTIONS.has(action)) {
    return errorResponse(400, origin, "invalid_request", "Invalid request");
  }
  const rate = await admin.rpc("consume_legacy_media_remediation_rate_service", {
    p_owner: owner,
    p_action: action,
  });
  if (rate.error) {
    return errorResponse(503, origin, "media_unavailable", "Legacy media service unavailable");
  }
  if (rate.data !== true) {
    return errorResponse(429, origin, "rate_limited", "Try again in a minute");
  }

  if (action === "declare") {
    if (!exactKeys(body, ["action", "itemId", "aiUse"]) ||
        !safeUuid(body.itemId) || typeof body.aiUse !== "string" ||
        !AI_USES.has(body.aiUse)) {
      return errorResponse(400, origin, "invalid_request", "Invalid request");
    }
    const declared = await admin.rpc("declare_legacy_media_reference_service", {
      p_owner: owner,
      p_item_id: body.itemId,
      p_ai_use: body.aiUse,
    });
    const declarationId = safeUuid(declared.data);
    if (declared.error || !declarationId) {
      return errorResponse(409, origin, "declaration_failed", "The exact preview could not be declared");
    }
    return json({
      action: "declare",
      declarationId,
      aiUse: body.aiUse,
      state: "declared",
    }, 200, origin);
  }

  if (action === "clear") {
    if (!exactKeys(body, ["action", "itemId"]) || !safeUuid(body.itemId)) {
      return errorResponse(400, origin, "invalid_request", "Invalid request");
    }
    const cleared = await admin.rpc("clear_legacy_media_reference_service_065", {
      p_owner: owner,
      p_item_id: body.itemId,
    });
    if (cleared.error || cleared.data !== true) {
      return errorResponse(409, origin, "clear_failed", "The exact reference could not be cleared");
    }
    return json({ action: "clear", state: "cleared" }, 200, origin);
  }

  if (action === "import") {
    if (!exactKeys(body, ["action", "declarationId"]) ||
        !safeUuid(body.declarationId)) {
      return errorResponse(400, origin, "invalid_request", "Invalid request");
    }
    const declarationId = String(body.declarationId);
    const priorStatus = await admin.rpc("legacy_media_import_status_service", {
      p_owner: owner,
      p_declaration_id: declarationId,
    });
    const prior = Array.isArray(priorStatus.data) ? priorStatus.data[0] : priorStatus.data;
    if (!priorStatus.error && prior && typeof prior === "object" &&
        (prior as JsonRecord).state === "applied") {
      const importId = safeUuid((prior as JsonRecord).import_id);
      if (importId) return json({ action: "import", importId, state: "imported" }, 200, origin);
    }
    const resolved = await admin.rpc("resolve_legacy_media_import_service", {
      p_owner: owner,
      p_declaration_id: declarationId,
    });
    const rawResolution = Array.isArray(resolved.data) ? resolved.data[0] : resolved.data;
    if (resolved.error || !rawResolution) {
      return errorResponse(409, origin, "import_failed", "The declaration is no longer current");
    }
    let resolution;
    try {
      resolution = validateLegacyMediaImportResolution(rawResolution, owner);
    } catch {
      return errorResponse(409, origin, "import_failed", "The declaration is no longer current");
    }
    let sourceBytes: Uint8Array;
    try {
      sourceBytes = await fetchLegacyBytes(resolution);
    } catch {
      return errorResponse(502, origin, "media_unavailable", "Legacy media unavailable");
    }
    let detected;
    let sourceSha256: string;
    try {
      detected = detectLegacyMedia(sourceBytes);
      sourceSha256 = await legacyMediaSha256(sourceBytes);
    } catch {
      return errorResponse(422, origin, "unsupported_media", "Legacy media format is unsupported");
    }
    if (detected.mime !== resolution.detected_mime ||
        sourceBytes.byteLength !== resolution.expected_byte_size ||
        sourceSha256 !== resolution.source_sha256) {
      return errorResponse(409, origin, "media_changed", "The previewed bytes changed");
    }
    try {
      await validateLegacyStaticRaster(sourceBytes, resolution.detected_mime);
    } catch {
      return errorResponse(
        422,
        origin,
        "unsupported_media",
        "Legacy canonical import requires a static PNG, JPEG, or WebP image",
      );
    }
    if (resolution.ai_use !== "none" && sourceBytes.byteLength > LEGACY_AI_MAX_SOURCE_BYTES) {
      return errorResponse(413, origin, "media_too_large", "AI-used legacy media is too large to watermark");
    }
    let finalBytes = sourceBytes;
    if (resolution.ai_use !== "none" || resolution.rendition !== "original") {
      try {
        finalBytes = await renderLegacyRasterDerivative(
          sourceBytes,
          resolution.detected_mime,
          resolution.rendition,
          resolution.ai_use !== "none",
        );
      } catch {
        return errorResponse(
          422,
          origin,
          "unsupported_media",
          "This legacy media cannot be converted to its canonical rendition",
        );
      }
    }
    if (finalBytes.byteLength < 1 ||
        finalBytes.byteLength > LEGACY_FINAL_IMAGE_MAX_BYTES ||
        finalBytes.byteLength > MAX_LEGACY_MEDIA_BYTES) {
      return errorResponse(413, origin, "media_too_large", "The canonical media exceeds its byte limit");
    }
    const contentSha256 = await legacyMediaSha256(finalBytes);
    if (resolution.ai_use !== "none" && contentSha256 === sourceSha256 ||
        resolution.ai_use === "none" && resolution.rendition === "original" &&
        (contentSha256 !== sourceSha256 || finalBytes.byteLength !== sourceBytes.byteLength)) {
      return errorResponse(500, origin, "import_failed", "Canonical byte invariants were not satisfied");
    }
    const extension = legacyMediaExtension(resolution.detected_mime);
    const path = `${owner}/published/provenance/${resolution.ai_use}/imported/${resolution.persona_id}/${resolution.purpose}/legacy_${resolution.rendition}/${contentSha256}.${extension}`;
    const uploadLeaseId = crypto.randomUUID();
    const claimed = await admin.rpc("claim_persona_media_upload_service_065", {
      p_owner: owner,
      p_lease_id: uploadLeaseId,
      p_storage_path: path,
      p_operation: "legacy_import",
      p_ttl_seconds: 180,
    });
    if (claimed.error || claimed.data !== "claimed") {
      return errorResponse(
        claimed.data === "busy" ? 409 : 423,
        origin,
        "import_failed",
        "A conflicting upload or account erasure is in progress",
      );
    }
    let createdObject = false;
    let canonicalRegistered = false;
    try {
      const upload = await admin.storage.from("persona-media").upload(path, finalBytes, {
        contentType: resolution.detected_mime,
        cacheControl: "31536000",
        upsert: false,
      });
      createdObject = !upload.error;
      if (upload.error) {
        if (!/already exists|duplicate/i.test(upload.error.message || "")) {
          return errorResponse(502, origin, "import_failed", "Canonical media could not be stored");
        }
      }
      const destination = await admin.rpc("resolve_legacy_media_destination_service_065", {
        p_owner: owner,
        p_declaration_id: declarationId,
        p_storage_path: path,
        p_content_sha256: contentSha256,
        p_content_byte_size: finalBytes.byteLength,
        p_mime_type: resolution.detected_mime,
        p_upload_lease_id: uploadLeaseId,
      });
      const rawDestination = Array.isArray(destination.data) ? destination.data[0] : destination.data;
      const destinationRow = rawDestination && typeof rawDestination === "object"
        ? rawDestination as JsonRecord
        : null;
      const destinationObjectId = safeUuid(destinationRow?.object_id);
      const destinationUpdatedAt = typeof destinationRow?.object_updated_at === "string" &&
          Number.isFinite(Date.parse(destinationRow.object_updated_at))
        ? destinationRow.object_updated_at
        : null;
      if (destination.error || !destinationObjectId || !destinationUpdatedAt) {
        return errorResponse(409, origin, "import_failed", "The immutable destination could not be bound");
      }
      try {
        // Re-download every destination, including a newly-created object. The
        // destination identity/timestamp above is re-locked by the commit RPC.
        await verifyExistingCanonicalObject(admin, path, finalBytes, contentSha256);
      } catch {
        return errorResponse(409, origin, "import_failed", "An immutable canonical object conflicts");
      }
      const renewed = await requireAal2(req, admin);
      if (!renewed.ok || renewed.user.id.toLowerCase() !== owner) {
        return errorResponse(401, origin, "authentication_required", "Sign in again");
      }
      const registryUrl = admin.storage.from("persona-media").getPublicUrl(path).data.publicUrl;
      const committed = await admin.rpc("commit_legacy_media_import_service_065", {
        p_owner: owner,
        p_declaration_id: declarationId,
        p_storage_path: path,
        p_public_url: registryUrl,
        p_content_sha256: contentSha256,
        p_content_byte_size: finalBytes.byteLength,
        p_mime_type: resolution.detected_mime,
        p_watermark_state: resolution.ai_use === "none" ? "not_required" : "system_applied",
        p_watermark_version: resolution.ai_use === "none" ? "" : LEGACY_WATERMARK_VERSION,
        p_watermark_asset_sha256: resolution.ai_use === "none" ? "" : LEGACY_WATERMARK_SHA256,
        p_destination_object_id: destinationObjectId,
        p_destination_updated_at: destinationUpdatedAt,
        p_upload_lease_id: uploadLeaseId,
      });
      let importId = safeUuid(committed.data);
      if (committed.error || !importId) {
        const retryStatus = await admin.rpc("legacy_media_import_status_service", {
          p_owner: owner,
          p_declaration_id: declarationId,
        });
        const retry = Array.isArray(retryStatus.data) ? retryStatus.data[0] : retryStatus.data;
        if (!retryStatus.error && retry && typeof retry === "object" &&
            (retry as JsonRecord).state === "applied") {
          importId = safeUuid((retry as JsonRecord).import_id);
        }
        if (!importId) {
          return errorResponse(409, origin, "import_failed", "The exact reference changed before import");
        }
      }
      canonicalRegistered = true;
      return json({ action: "import", importId, state: "imported" }, 200, origin);
    } finally {
      if (createdObject && !canonicalRegistered) {
        const cleanupAllowed = await admin.rpc("persona_media_upload_cleanup_allowed_065", {
          p_owner: owner,
          p_lease_id: uploadLeaseId,
          p_storage_path: path,
        });
        if (!cleanupAllowed.error && cleanupAllowed.data === true) {
          await admin.storage.from("persona-media").remove([path]);
        }
      }
      const released = await admin.rpc("release_persona_media_upload_service_065", {
        p_owner: owner,
        p_lease_id: uploadLeaseId,
      });
      void released;
    }
  }

  if (action === "inventory") {
    if (!exactKeys(body, ["action"], ["limit"])) {
      return errorResponse(400, origin, "invalid_request", "Invalid request");
    }
    const limit = integer(body.limit, 250, 1, 500);
    if (limit === null) return errorResponse(400, origin, "invalid_request", "Invalid request");
    const inventory = await admin.rpc("inventory_legacy_media_references_service", {
      p_owner: owner,
      p_limit: limit,
    });
    if (inventory.error || !inventory.data || typeof inventory.data !== "object") {
      return errorResponse(409, origin, "inventory_failed", "Inventory could not be completed safely");
    }
    const summary = inventory.data as JsonRecord;
    return json({
      action: "inventory",
      summary: {
        references: safeCount(summary.references),
        previewable: safeCount(summary.previewable),
        blocked: safeCount(summary.blocked),
        missing: safeCount(summary.missing),
        stale: safeCount(summary.stale),
        limit,
      },
    }, 200, origin);
  }

  if (action === "list") {
    if (!exactKeys(body, ["action"], ["after", "limit"])) {
      return errorResponse(400, origin, "invalid_request", "Invalid request");
    }
    const limit = integer(body.limit, 50, 1, 50);
    const after = body.after === undefined || body.after === null ? null : safeUuid(body.after);
    if (limit === null || (body.after !== undefined && body.after !== null && after === null)) {
      return errorResponse(400, origin, "invalid_request", "Invalid request");
    }
    const listed = await admin.rpc("list_legacy_media_references_service", {
      p_owner: owner,
      p_after: after,
      p_limit: limit,
    });
    if (listed.error || !Array.isArray(listed.data)) {
      return errorResponse(409, origin, "list_failed", "Legacy media could not be listed safely");
    }
    const items = listed.data.flatMap((raw: unknown) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
      const row = raw as JsonRecord;
      const itemId = safeUuid(row.item_id);
      if (!itemId) return [];
      const state = typeof row.state === "string" && SAFE_STATES.has(row.state) ? row.state : "stale";
      return [{
        itemId,
        sourceItemId: safeUuid(row.source_item_id),
        personaId: safeUuid(row.persona_id),
        personaLabel: safeText(row.persona_label, 160),
        personaHandle: safeText(row.persona_handle, 30),
        consumer: safeText(row.consumer, 32),
        slot: safeText(row.slot, 32),
        purpose: safeText(row.purpose, 160),
        rendition: safeText(row.rendition, 32),
        state,
        canPreview: row.can_preview === true,
        previewed: row.previewed === true,
        detectedMime: safeText(row.detected_mime, 32),
        byteSize: safeCount(row.byte_size),
        sharedReferenceCount: safeCount(row.shared_reference_count),
      }];
    });
    return json({
      action: "list",
      items,
      nextCursor: items.length === limit ? items[items.length - 1]?.itemId ?? null : null,
    }, 200, origin);
  }

  if (!exactKeys(body, ["action", "itemId"]) || !safeUuid(body.itemId)) {
    return errorResponse(400, origin, "invalid_request", "Invalid request");
  }
  const itemId = String(body.itemId);
  const resolved = await admin.rpc("resolve_legacy_media_preview_service", {
    p_owner: owner,
    p_item_id: itemId,
  });
  const rawResolution = Array.isArray(resolved.data) ? resolved.data[0] : resolved.data;
  if (resolved.error || !rawResolution) {
    return errorResponse(404, origin, "media_not_found", "Legacy media not found");
  }

  let resolution;
  try {
    resolution = validateLegacyMediaResolution(rawResolution, owner);
  } catch {
    return errorResponse(409, origin, "media_changed", "Inventory is out of date");
  }
  if (resolution.expected_byte_size > MAX_LEGACY_MEDIA_BYTES) {
    return errorResponse(413, origin, "media_too_large", "Legacy media is too large to preview");
  }

  try {
    const encodedPath = resolution.storage_path.split("/").map(encodeURIComponent).join("/");
    const storageResponse = await fetch(
      `${SUPABASE_URL.replace(/\/$/, "")}/storage/v1/object/${resolution.bucket}/${encodedPath}`,
      {
        method: "GET",
        headers: {
          "Authorization": `Bearer ${SERVICE_ROLE_KEY}`,
          "apikey": SERVICE_ROLE_KEY,
          "Accept-Encoding": "identity",
        },
        redirect: "error",
        signal: AbortSignal.timeout(20_000),
      },
    );
    const bytes = await readBoundedLegacyMediaResponse(
      storageResponse,
      resolution.expected_byte_size,
    );
    const detected = detectLegacyMedia(bytes);
    const sourceSha256 = await legacyMediaSha256(bytes);
    const recorded = await admin.rpc("record_legacy_media_preview_service", {
      p_owner: owner,
      p_item_id: itemId,
      p_object_id: resolution.object_id,
      p_object_updated_at: resolution.object_updated_at,
      p_source_sha256: sourceSha256,
      p_byte_size: bytes.byteLength,
      p_detected_mime: detected.mime,
    });
    if (recorded.error || recorded.data !== true) {
      return errorResponse(409, origin, "media_changed", "Inventory is out of date");
    }
    const headers = legacyMediaPreviewHeaders(detected.mime, bytes.byteLength);
    Object.entries(cors(origin)).forEach(([key, value]) => headers.set(key, value));
    const responseBody = new Uint8Array(bytes);
    return new Response(responseBody.buffer, { status: 200, headers });
  } catch (error) {
    const reason = error instanceof Error ? error.message : "";
    if (reason.includes("byte limit")) {
      return errorResponse(413, origin, "media_too_large", "Legacy media is too large to preview");
    }
    if (reason.includes("Unsupported")) {
      return errorResponse(422, origin, "unsupported_media", "Legacy media format is unsupported");
    }
    return errorResponse(502, origin, "media_unavailable", "Legacy media unavailable");
  }
});
