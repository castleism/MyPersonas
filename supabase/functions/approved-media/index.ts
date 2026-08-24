// Opaque, origin-gated provider delivery for immutable approved post images.
//
// Public providers receive only:
//   https://media.mypersonas.online/approved/v1/<unguessable-v4>
// The trusted origin gateway maps that URL to this function and adds the
// required secret header. Direct Supabase function traffic fails closed.

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  APPROVED_MEDIA_BUCKET,
  APPROVED_MEDIA_MAX_BYTES,
  approvedMediaDeliveryIdFromUrl,
  detectImageMime,
  readBoundedBytes,
  sha256Hex,
} from "../_shared/approved-media.ts";
import {
  canonicalSupabaseOrigin,
  loadMediaEnvironmentConfig,
  PUBLIC_MEDIA_GATEWAY_HEADER,
} from "../_shared/public-media.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const MEDIA_GATEWAY_SECRET = Deno.env.get("PUBLIC_MEDIA_GATEWAY_SECRET") || "";
const MEDIA_GATEWAY_PREVIOUS_SECRET =
  Deno.env.get("PUBLIC_MEDIA_GATEWAY_PREVIOUS_SECRET") || "";
const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const GATEWAY_SECRET = /^[A-Za-z0-9_-]{43,128}$/;

function empty(status: number) {
  return new Response(null, {
    status,
    headers: {
      "Cache-Control": "no-store, max-age=0",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function constantTimeSecretMatch(supplied: string, expected: string) {
  if (!GATEWAY_SECRET.test(expected) || supplied.length > 256) return false;
  let different = supplied.length ^ expected.length;
  for (let index = 0; index < 256; index++) {
    different |= (supplied.charCodeAt(index) || 0) ^
      (expected.charCodeAt(index) || 0);
  }
  return different === 0;
}

function gatewayAuthorized(req: Request) {
  const supplied = req.headers.get(PUBLIC_MEDIA_GATEWAY_HEADER) || "";
  return constantTimeSecretMatch(supplied, MEDIA_GATEWAY_SECRET) ||
    constantTimeSecretMatch(supplied, MEDIA_GATEWAY_PREVIOUS_SECRET);
}

export function approvedMediaIdFromGatewayRequestUrl(
  requestUrl: string,
  supabaseUrl: string,
  publicMediaOrigin?: string,
) {
  const publicId = publicMediaOrigin
    ? approvedMediaDeliveryIdFromUrl(requestUrl, publicMediaOrigin)
    : null;
  if (publicId) return publicId;
  const base = canonicalSupabaseOrigin(supabaseUrl);
  if (!base) return null;
  const prefix = `${base}/functions/v1/approved-media/`;
  if (!requestUrl.startsWith(prefix)) return null;
  const id = requestUrl.slice(prefix.length);
  if (!V4.test(id) || requestUrl !== prefix + id) return null;
  return id;
}

function validateResolution(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid resolution");
  }
  const row = value as Record<string, unknown>;
  if (Object.keys(row).sort().join(",") !==
      "bucket,byte_size,content_sha256,mime_type,storage_path" ||
    row.bucket !== APPROVED_MEDIA_BUCKET ||
    typeof row.storage_path !== "string" ||
    !/^owners\/[0-9a-f-]{36}\/sha256\/[0-9a-f]{2}\/[0-9a-f]{64}\.(jpg|png|webp)$/.test(row.storage_path) ||
    !["image/jpeg", "image/png", "image/webp"].includes(String(row.mime_type)) ||
    !Number.isSafeInteger(Number(row.byte_size)) || Number(row.byte_size) < 1 ||
    Number(row.byte_size) > APPROVED_MEDIA_MAX_BYTES ||
    !/^[0-9a-f]{64}$/.test(String(row.content_sha256))) {
    throw new Error("invalid resolution");
  }
  return {
    bucket: APPROVED_MEDIA_BUCKET,
    storagePath: row.storage_path,
    mime: row.mime_type as "image/jpeg" | "image/png" | "image/webp",
    byteSize: Number(row.byte_size),
    sha256: String(row.content_sha256),
  };
}

serve(async (req) => {
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY ||
    !GATEWAY_SECRET.test(MEDIA_GATEWAY_SECRET)) {
    return empty(503);
  }
  if (req.method !== "GET" && req.method !== "HEAD") return empty(405);
  if (req.headers.has("range")) return empty(416);
  if (!gatewayAuthorized(req)) return empty(404);
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  let environment;
  try {
    environment = await loadMediaEnvironmentConfig(admin, SUPABASE_URL);
  } catch {
    return empty(503);
  }
  const publicId = approvedMediaIdFromGatewayRequestUrl(
    req.url,
    SUPABASE_URL,
    environment.publicMediaOrigin,
  );
  if (!publicId) return empty(404);

  try {
    const resolved = await admin.rpc("resolve_post_approved_media_delivery_service", {
      p_public_id: publicId,
    });
    const row = Array.isArray(resolved.data) ? resolved.data[0] : resolved.data;
    if (resolved.error || !row) return empty(404);
    const media = validateResolution(row);
    const encodedPath = media.storagePath.split("/").map(encodeURIComponent).join("/");
    const response = await fetch(
      `${SUPABASE_URL.replace(/\/$/, "")}/storage/v1/object/${media.bucket}/${encodedPath}`,
      {
        method: "GET",
        redirect: "error",
        headers: {
          "Authorization": `Bearer ${SERVICE_ROLE_KEY}`,
          "apikey": SERVICE_ROLE_KEY,
          "Accept": "image/jpeg,image/png,image/webp",
          "Accept-Encoding": "identity",
        },
        signal: AbortSignal.timeout(20_000),
      },
    );
    if (response.status !== 200 || response.redirected || !response.body) {
      await response.body?.cancel().catch(() => undefined);
      return empty(404);
    }
    const declaredLength = response.headers.get("content-length");
    if (declaredLength !== null && declaredLength !== String(media.byteSize)) {
      await response.body.cancel().catch(() => undefined);
      return empty(409);
    }
    const bytes = await readBoundedBytes(response, media.byteSize);
    if (bytes.byteLength !== media.byteSize || detectImageMime(bytes) !== media.mime ||
      await sha256Hex(bytes) !== media.sha256) {
      console.error("approved-media delivery integrity failure");
      return empty(409);
    }
    const headers = new Headers({
      "Content-Type": media.mime,
      "Content-Length": String(media.byteSize),
      "Content-Disposition": "inline",
      "Cache-Control": "no-store, max-age=0",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Cross-Origin-Resource-Policy": "cross-origin",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    });
    return new Response(req.method === "HEAD" ? null : bytes, {
      status: 200,
      headers,
    });
  } catch {
    console.error("approved-media delivery failed closed");
    return empty(404);
  }
});
