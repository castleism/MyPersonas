// Authenticated owner/viewer media preview without exposing a Storage path.
//
// Owners may resolve an owned immutable asset id even while the persona is a
// draft. Other signed-in viewers may resolve only an opaque id that is present
// in the exact current reviewed page and visible to that account. The function
// returns hash-verified bytes directly; it never returns a signed/raw URL.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  loadMediaEnvironmentConfig,
  publicMediaIdFromRequestUrl,
  publicMediaResponseHeaders,
  readExactPublicMediaResponse,
  validatePublicMediaResolution,
  verifyResolvedPublicMedia,
} from "../_shared/public-media.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ORIGINS = new Set([
  "https://aliaspaces.com",
  "https://www.aliaspaces.com",
  "https://app.aliaspaces.com",
  "https://mypersonas.online",
]);

function cors(origin: string): Record<string, string> {
  return origin && ORIGINS.has(origin) ? {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  } : {};
}

function errorResponse(status: number, origin: string, message = "Media unavailable") {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: {
      ...cors(origin),
      "Cache-Control": "no-store, max-age=0",
      "Content-Type": "application/json; charset=utf-8",
      "Content-Security-Policy": "default-src 'none'",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

async function boundedJson(req: Request) {
  const stated = req.headers.get("content-length");
  if (stated && (!/^\d{1,5}$/.test(stated) || Number(stated) > 4096)) throw new Error("Request too large");
  if (!req.body) throw new Error("Missing request");
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > 4096) {
      await reader.cancel().catch(() => undefined);
      throw new Error("Request too large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset);offset += chunk.byteLength; }
  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid request");
  return value as Record<string, unknown>;
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("Origin") ?? "";
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origin) });
  if (req.method !== "POST") return errorResponse(405, origin, "Method not allowed");
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) return errorResponse(503, origin);
  const bearer = req.headers.get("Authorization") ?? "";
  if (!/^Bearer\s+\S+$/i.test(bearer)) return errorResponse(401, origin, "Authentication required");

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const authenticated = await admin.auth.getUser(bearer.replace(/^Bearer\s+/i, ""));
  if (authenticated.error || !authenticated.data.user) return errorResponse(401, origin, "Authentication required");
  let environment;
  try {
    environment = await loadMediaEnvironmentConfig(admin, SUPABASE_URL);
  } catch {
    return errorResponse(503, origin);
  }

  let body: Record<string, unknown>;
  try { body = await boundedJson(req); } catch { return errorResponse(400, origin, "Invalid request"); }
  const assetId = typeof body.assetId === "string" && UUID.test(body.assetId)
    ? body.assetId.toLowerCase() : null;
  const publicId = typeof body.publicUrl === "string"
    ? publicMediaIdFromRequestUrl(body.publicUrl, environment.publicMediaOrigin) : null;
  if ((assetId === null) === (publicId === null)) return errorResponse(400, origin, "Invalid request");

  const resolved = await admin.rpc("resolve_authenticated_media_preview_service", {
    p_viewer: authenticated.data.user.id,
    p_asset_id: assetId,
    p_public_id: publicId,
  });
  const raw = Array.isArray(resolved.data) ? resolved.data[0] : resolved.data;
  if (resolved.error || !raw) return errorResponse(404, origin);

  try {
    const resolution = validatePublicMediaResolution(raw);
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
    const bytes = await readExactPublicMediaResponse(storageResponse, resolution.byte_size);
    await verifyResolvedPublicMedia(bytes, resolution);
    const headers = publicMediaResponseHeaders(resolution);
    headers.delete("Access-Control-Allow-Origin");
    Object.entries(cors(origin)).forEach(([key, value]) => headers.set(key, value));
    const body = new Uint8Array(bytes);
    return new Response(body.buffer, { status: 200, headers });
  } catch (error) {
    console.error("owner-media-preview bounded verification failed", error);
    return errorResponse(502, origin);
  }
});
