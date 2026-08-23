// Authenticated media intake for MyPersonas public assets.
//
// The browser may prepare a raster derivative, but it cannot author provenance
// authority or write the public bucket. This boundary validates the exact bytes,
// writes an immutable content-addressed object with service_role, and registers a
// constrained provenance record. Site-generated inputs additionally require a
// short-lived generation event written by the generator service.

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const BUCKET = "persona-media";
const MAX_REQUEST_BYTES = 16 * 1024 * 1024;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_VIDEO_BYTES = 15 * 1024 * 1024;
const WATERMARK_VERSION = "mypersonas-ai-watermark-v1";
const WATERMARK_SHA256 = "c8ff9543374ab294ebf73ce0859581abf5e12251b7ce2735d86399d015e046b2";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_SCOPE = /^[a-z0-9_-]{1,64}(?:\/[a-z0-9_-]{1,64}){0,5}$/i;
const AI_USES = new Set(["none", "assisted", "generated", "unknown"]);
const ORIGINS = new Set(["uploaded", "site_generated"]);
const ALLOWED_ORIGINS = new Set([
  "https://aliaspaces.com",
  "https://www.aliaspaces.com",
  "https://app.aliaspaces.com",
  "https://mypersonas.online",
]);

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function json(body: unknown, status = 200, origin = "") {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: {
      ...(origin && ALLOWED_ORIGINS.has(origin)
        ? {
          "Access-Control-Allow-Origin": origin,
          "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Vary": "Origin",
        }
        : {}),
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

async function caller(req: Request) {
  const auth = req.headers.get("Authorization") || "";
  if (!/^Bearer\s+\S+$/i.test(auth)) return null;
  const { data, error } = await admin.auth.getUser(auth.replace(/^Bearer\s+/i, ""));
  return error ? null : data.user;
}

function starts(bytes: Uint8Array, values: readonly number[], offset = 0) {
  return values.every((value, index) => bytes[offset + index] === value);
}

function ascii(bytes: Uint8Array, start: number, length: number) {
  if (start < 0 || length < 0 || start + length > bytes.length) return "";
  return String.fromCharCode(...bytes.slice(start, start + length));
}

function detectedMedia(bytes: Uint8Array) {
  if (bytes.length >= 8 && starts(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { mime: "image/png", extension: "png", mediaType: "image" };
  }
  if (bytes.length >= 3 && starts(bytes, [0xff, 0xd8, 0xff])) {
    return { mime: "image/jpeg", extension: "jpg", mediaType: "image" };
  }
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") {
    return { mime: "image/webp", extension: "webp", mediaType: "image" };
  }
  if (bytes.length >= 6 && ["GIF87a", "GIF89a"].includes(ascii(bytes, 0, 6))) {
    return { mime: "image/gif", extension: "gif", mediaType: "image" };
  }
  if (bytes.length >= 16 && ascii(bytes, 4, 4) === "ftyp") {
    return { mime: "video/mp4", extension: "mp4", mediaType: "video" };
  }
  if (bytes.length >= 8 && starts(bytes, [0x1a, 0x45, 0xdf, 0xa3])) {
    return { mime: "video/webm", extension: "webm", mediaType: "video" };
  }
  throw new Error("Use a valid PNG, JPEG, WebP, GIF, MP4, or WebM file");
}

async function sha256Hex(bytes: Uint8Array) {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy.buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function verifyExisting(path: string, expected: Uint8Array, digest: string) {
  const downloaded = await admin.storage.from(BUCKET).download(path);
  if (downloaded.error || !downloaded.data) throw new Error("An existing immutable object could not be verified");
  const bytes = new Uint8Array(await downloaded.data.arrayBuffer());
  if (bytes.byteLength !== expected.byteLength || await sha256Hex(bytes) !== digest) {
    throw new Error("An immutable media path already contains different bytes");
  }
}

serve(async (req) => {
  const origin = req.headers.get("Origin") || "";
  if (req.method === "OPTIONS") return json(null, 204, origin);
  if (origin && !ALLOWED_ORIGINS.has(origin)) return json({ error: "Origin not allowed" }, 403);
  if (req.method !== "POST") return json({ error: "POST only" }, 405, origin);

  const user = await caller(req);
  if (!user) return json({ error: "Sign in first" }, 401, origin);
  const requestLength = Number(req.headers.get("content-length") || 0);
  if (!Number.isSafeInteger(requestLength) || requestLength < 1 || requestLength > MAX_REQUEST_BYTES) {
    return json({ error: "A bounded multipart request is required" }, 413, origin);
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return json({ error: "A valid multipart request is required" }, 400, origin);
  }
  const file = form.get("file");
  const personaId = String(form.get("personaId") || "").toLowerCase();
  const aiUse = String(form.get("aiUse") || "").toLowerCase();
  const assetOrigin = String(form.get("origin") || "").toLowerCase();
  const purpose = String(form.get("purpose") || "").toLowerCase();
  const sourceSha256 = String(form.get("sourceSha256") || "").toLowerCase();
  const generationEventId = String(form.get("generationEventId") || "").toLowerCase();
  const rendition = String(form.get("rendition") || "original").toLowerCase();
  if (!(file instanceof File) || !UUID.test(personaId) || !AI_USES.has(aiUse) ||
      !ORIGINS.has(assetOrigin) || !SAFE_SCOPE.test(purpose) || !SHA256.test(sourceSha256) ||
      !/^[a-z0-9_-]{1,64}$/.test(rendition)) {
    return json({ error: "Media intake metadata is invalid" }, 400, origin);
  }
  if (assetOrigin === "site_generated" && (!UUID.test(generationEventId) || aiUse !== "generated")) {
    return json({ error: "Site-generated media requires its generation event" }, 400, origin);
  }
  if (assetOrigin === "uploaded" && generationEventId) {
    return json({ error: "Uploaded media cannot claim a system generation event" }, 400, origin);
  }

  const persona = await admin.from("personas").select("id").eq("id", personaId).eq("owner", user.id).maybeSingle();
  if (persona.error) return json({ error: "Could not verify the persona" }, 500, origin);
  if (!persona.data) return json({ error: "Owned persona not found" }, 404, origin);

  if (file.size < 1 || file.size > MAX_VIDEO_BYTES) return json({ error: "Media file size is not allowed" }, 413, origin);
  const bytes = new Uint8Array(await file.arrayBuffer());
  let detected;
  try {
    detected = detectedMedia(bytes);
  } catch (error) {
    return json({ error: (error as Error).message }, 415, origin);
  }
  if (detected.mediaType === "image" && bytes.byteLength > MAX_IMAGE_BYTES) {
    return json({ error: "Images must be no larger than 10 MB" }, 413, origin);
  }
  const declaredMime = String(file.type || "").toLowerCase();
  if (declaredMime && declaredMime !== "application/octet-stream" && declaredMime !== detected.mime) {
    return json({ error: "The declared media type does not match the file bytes" }, 415, origin);
  }
  if (aiUse !== "none" && !["image/png", "image/jpeg", "image/webp"].includes(detected.mime)) {
    return json({ error: "AI-used GIF and video require frame-by-frame watermarking before public intake" }, 422, origin);
  }

  const contentSha256 = await sha256Hex(bytes);
  if (aiUse === "none" && sourceSha256 !== contentSha256) {
    return json({ error: "A no-AI upload must preserve the declared source bytes" }, 422, origin);
  }
  if (aiUse !== "none" && sourceSha256 === contentSha256) {
    return json({ error: "AI-used imagery must provide a distinct final watermarked derivative" }, 422, origin);
  }

  if (assetOrigin === "site_generated") {
    const claim = await admin.rpc("use_ai_media_generation_event_service", {
      p_event_id: generationEventId,
      p_owner: user.id,
      p_persona_id: personaId,
      p_source_sha256: sourceSha256,
      p_mime_type: detected.mime,
    });
    if (claim.error || claim.data !== true) {
      return json({ error: "The generation event is missing, expired, mismatched, or exhausted" }, 409, origin);
    }
  }

  const source = assetOrigin === "site_generated" ? "generated" : "uploaded";
  const path = `${user.id.toLowerCase()}/published/provenance/${aiUse}/${source}/${purpose}/${contentSha256}.${detected.extension}`;
  const upload = await admin.storage.from(BUCKET).upload(path, bytes, {
    contentType: detected.mime,
    cacheControl: "31536000",
    upsert: false,
  });
  if (upload.error) {
    if (/already exists|duplicate/i.test(upload.error.message || "")) {
      try {
        await verifyExisting(path, bytes, contentSha256);
      } catch (error) {
        return json({ error: (error as Error).message }, 409, origin);
      }
    } else {
      return json({ error: "The immutable media object could not be stored" }, 502, origin);
    }
  }
  const publicUrl = admin.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
  const watermarkState = aiUse === "none" ? "not_required" : "system_applied";
  const registered = await admin.rpc("register_persona_media_asset_service", {
    p_owner: user.id,
    p_persona_id: personaId,
    p_media_type: detected.mediaType,
    p_storage_path: path,
    p_public_url: publicUrl,
    p_mime_type: detected.mime,
    p_byte_size: bytes.byteLength,
    p_origin: assetOrigin,
    p_ai_use: aiUse,
    p_source_sha256: sourceSha256,
    p_content_sha256: contentSha256,
    p_watermark_state: watermarkState,
    p_watermark_version: aiUse === "none" ? "" : WATERMARK_VERSION,
    p_watermark_asset_sha256: aiUse === "none" ? "" : WATERMARK_SHA256,
    p_generation_event_id: assetOrigin === "site_generated" ? generationEventId : null,
    p_rendition: rendition,
  });
  if (registered.error || !UUID.test(String(registered.data || ""))) {
    return json({ error: "The bytes were stored but their provenance record failed closed" }, 500, origin);
  }
  return json({
    assetId: registered.data,
    publicUrl,
    path,
    sha256: contentSha256,
    sourceSha256,
    mime: detected.mime,
    byteSize: bytes.byteLength,
    aiUse,
    watermarkState,
    watermarkVersion: aiUse === "none" ? "" : WATERMARK_VERSION,
  }, 200, origin);
});
