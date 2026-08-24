// AAL2 owner inventory and exact-byte preview for references to the historical
// public `media` bucket. This first slice cannot declare, import, rewrite,
// delete, finalize, or change Storage policies.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { requireAal2 } from "../_shared/aal2.ts";
import { loadAppOrigins } from "../_shared/app-origin.ts";
import {
  detectLegacyMedia,
  legacyMediaPreviewHeaders,
  legacyMediaSha256,
  MAX_LEGACY_MEDIA_BYTES,
  readBoundedLegacyMediaResponse,
  validateLegacyMediaResolution,
} from "../_shared/legacy-media-remediation.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ALLOWED_ORIGINS = loadAppOrigins((name) => Deno.env.get(name));
const ACTIONS = new Set(["inventory", "list", "preview"]);
const SAFE_STATES = new Set([
  "pending",
  "missing",
  "blocked_cross_owner",
  "blocked_persona",
  "blocked_shared_product",
  "stale",
]);

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
