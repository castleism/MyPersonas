// Opaque, exact-reviewed public media delivery.
//
// The browser supplies only an unguessable public id. The service RPC performs
// the current publication/review/reference check and returns a private Storage
// target to this function only. Bytes are bounded and hash-verified before the
// proxy emits them; no redirect or backend Storage header can reveal owner or
// persona correlation.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  loadMediaEnvironmentConfig,
  PUBLIC_MEDIA_GATEWAY_HEADER,
  publicMediaIdFromOriginRequestUrl,
  publicMediaResponseHeaders,
  readExactPublicMediaResponse,
  validatePublicMediaResolution,
  verifyResolvedPublicMedia,
} from "../_shared/public-media.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const MEDIA_GATEWAY_SECRET = Deno.env.get("PUBLIC_MEDIA_GATEWAY_SECRET") ?? "";
const MEDIA_GATEWAY_PREVIOUS_SECRET = Deno.env.get("PUBLIC_MEDIA_GATEWAY_PREVIOUS_SECRET") ?? "";
const GATEWAY_SECRET = /^[A-Za-z0-9_-]{43,128}$/;
const CORS = Object.freeze({
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Cache-Control": "no-store, max-age=0",
  "Vary": "Origin",
});

function errorResponse(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: {
      ...CORS,
      "Content-Type": "application/json; charset=utf-8",
      "Content-Security-Policy": "default-src 'none'",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function constantTimeSecretMatch(supplied: string, expected: string): boolean {
  if (!GATEWAY_SECRET.test(expected) || supplied.length > 256) return false;
  let different = supplied.length ^ expected.length;
  for (let index = 0; index < 256; index += 1) {
    different |= (supplied.charCodeAt(index) || 0) ^ (expected.charCodeAt(index) || 0);
  }
  return different === 0;
}

Deno.serve(async (req: Request) => {
  // The canonical URL terminates at CloudFront/WAF. Its custom origin header is
  // overwritten by CloudFront and is never accepted from a direct viewer call.
  // A missing or malformed configured primary secret disables this origin.
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY || !GATEWAY_SECRET.test(MEDIA_GATEWAY_SECRET)) {
    return errorResponse(503, "Media unavailable");
  }
  const suppliedGatewaySecret = req.headers.get(PUBLIC_MEDIA_GATEWAY_HEADER) ?? "";
  if (!constantTimeSecretMatch(suppliedGatewaySecret, MEDIA_GATEWAY_SECRET) &&
      !constantTimeSecretMatch(suppliedGatewaySecret, MEDIA_GATEWAY_PREVIOUS_SECRET)) {
    return errorResponse(404, "Media not found");
  }
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "GET") return errorResponse(405, "Method not allowed");
  if (req.headers.has("range")) return errorResponse(416, "Range requests are unavailable");

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  let environment;
  try {
    environment = await loadMediaEnvironmentConfig(admin, SUPABASE_URL);
  } catch {
    return errorResponse(503, "Media unavailable");
  }
  const publicId = publicMediaIdFromOriginRequestUrl(req.url, SUPABASE_URL);
  if (!publicId) return errorResponse(404, "Media not found");

  const limited = await admin.rpc("consume_public_media_rate_limit_service", {
    p_public_id: publicId,
  });
  if (limited.error || limited.data !== true) {
    return errorResponse(limited.error ? 503 : 429, "Media temporarily unavailable");
  }

  const resolved = await admin.rpc("resolve_public_media_service", {
    p_public_id: publicId,
  });
  const raw = Array.isArray(resolved.data) ? resolved.data[0] : resolved.data;
  if (resolved.error || !raw) return errorResponse(404, "Media not found");

  let resolution;
  try {
    resolution = validatePublicMediaResolution(raw);
  } catch (error) {
    console.error("public-media unsafe resolver response", error);
    return errorResponse(502, "Media unavailable");
  }

  let bytes: Uint8Array;
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
    bytes = await readExactPublicMediaResponse(storageResponse, resolution.byte_size);
    await verifyResolvedPublicMedia(bytes, resolution);
  } catch (error) {
    console.error("public-media bounded Storage verification failed", error);
    return errorResponse(502, "Media unavailable");
  }

  const headers = publicMediaResponseHeaders(resolution);
  const body = new Uint8Array(bytes);
  return new Response(body.buffer, { status: 200, headers });
});
