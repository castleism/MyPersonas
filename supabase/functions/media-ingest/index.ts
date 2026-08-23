// Authenticated media intake for MyPersonas public assets.
//
// The browser submits original source bytes and a declaration; it cannot author
// the final derivative, provenance authority, or public-bucket record. This
// service validates and hashes the source, renders every required AI watermark
// after any crop, writes immutable final bytes with service_role, and registers
// the constrained provenance record. Site-generated inputs additionally require
// a short-lived generation event written by the generator service.

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  Channels,
  CompositeOperator,
  EvaluateOperator,
  ImageMagick,
  initializeImageMagick,
  MagickFormat,
  MagickGeometry,
  Point,
} from "npm:@imagemagick/magick-wasm@0.0.42";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const BUCKET = "persona-media";
const MAX_REQUEST_BYTES = 16 * 1024 * 1024;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_AI_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_VIDEO_BYTES = 15 * 1024 * 1024;
const MAX_SOURCE_PIXELS = 12_000_000;
const MAX_OUTPUT_PIXELS = 2_000_000;
const WATERMARK_VERSION = "mypersonas-ai-watermark-v1";
const WATERMARK_SHA256 = "c8ff9543374ab294ebf73ce0859581abf5e12251b7ce2735d86399d015e046b2";
const WATERMARK_CROP = Object.freeze({ x: 345, y: 204, width: 1481, height: 306 });
const WATERMARK_OPACITY = 0.22;
const WATERMARK_HALO_OPACITY = 0.10;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_SCOPE = /^[a-z0-9_-]{1,64}(?:\/[a-z0-9_-]{1,64}){0,5}$/i;
const AI_USES = new Set(["none", "assisted", "generated", "unknown"]);
const ORIGINS = new Set(["uploaded", "site_generated"]);
const SOCIAL_CROPS = Object.freeze({
  facebook: Object.freeze({ width: 1200, height: 628 }),
  instagram: Object.freeze({ width: 1080, height: 1080 }),
  x: Object.freeze({ width: 1080, height: 1350 }),
});
const ALLOWED_ORIGINS = new Set([
  "https://aliaspaces.com",
  "https://www.aliaspaces.com",
  "https://app.aliaspaces.com",
  "https://mypersonas.online",
]);

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
let magickReady: Promise<Uint8Array> | null = null;

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

function uint16be(bytes: Uint8Array, offset: number) {
  return (bytes[offset] << 8) | bytes[offset + 1];
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

function hasUnsupportedAnimation(bytes: Uint8Array, mime: string) {
  if (mime === "image/png") {
    for (let offset = 8; offset + 12 <= bytes.byteLength;) {
      const length = uint32be(bytes, offset);
      if (length > bytes.byteLength - offset - 12) return true;
      const type = ascii(bytes, offset + 4, 4);
      if (type === "acTL") return true;
      offset += length + 12;
      if (type === "IEND") break;
    }
  }
  if (mime === "image/webp") {
    if (ascii(bytes, 12, 4) === "VP8X" && (bytes[20] & 0x02) !== 0) return true;
    for (let offset = 12; offset + 8 <= bytes.byteLength;) {
      const type = ascii(bytes, offset, 4);
      const length = uint32le(bytes, offset + 4);
      if (type === "ANIM" || type === "ANMF") return true;
      if (length > bytes.byteLength - offset - 8) return true;
      offset += 8 + length + (length % 2);
    }
  }
  return false;
}

function staticImageDimensions(bytes: Uint8Array, mime: string) {
  if (mime === "image/png" && bytes.byteLength >= 24 && ascii(bytes, 12, 4) === "IHDR") {
    return { width: uint32be(bytes, 16), height: uint32be(bytes, 20) };
  }
  if (mime === "image/jpeg") {
    const startOfFrame = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
    for (let offset = 2; offset + 8 < bytes.byteLength;) {
      if (bytes[offset] !== 0xff) {
        offset++;
        continue;
      }
      while (offset < bytes.byteLength && bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 1 >= bytes.byteLength) break;
      const length = uint16be(bytes, offset);
      if (length < 2 || offset + length > bytes.byteLength) break;
      if (startOfFrame.has(marker) && length >= 7) {
        return { width: uint16be(bytes, offset + 5), height: uint16be(bytes, offset + 3) };
      }
      offset += length;
    }
  }
  if (mime === "image/webp" && bytes.byteLength >= 30) {
    const chunk = ascii(bytes, 12, 4);
    if (chunk === "VP8X") {
      return { width: uint24le(bytes, 24) + 1, height: uint24le(bytes, 27) + 1 };
    }
    if (chunk === "VP8L" && bytes[20] === 0x2f) {
      return {
        width: 1 + bytes[21] + ((bytes[22] & 0x3f) << 8),
        height: 1 + ((bytes[22] & 0xc0) >> 6) + (bytes[23] << 2) + ((bytes[24] & 0x0f) << 10),
      };
    }
    if (chunk === "VP8 " && starts(bytes, [0x9d, 0x01, 0x2a], 23)) {
      return { width: uint16be(new Uint8Array([bytes[27], bytes[26]]), 0) & 0x3fff, height: uint16be(new Uint8Array([bytes[29], bytes[28]]), 0) & 0x3fff };
    }
  }
  throw new Error("The static image dimensions could not be validated safely");
}

function validatedDimensions(bytes: Uint8Array, mime: string) {
  const dimensions = staticImageDimensions(bytes, mime);
  if (!Number.isSafeInteger(dimensions.width) || !Number.isSafeInteger(dimensions.height) ||
      dimensions.width < 32 || dimensions.height < 32 ||
      dimensions.width * dimensions.height > MAX_SOURCE_PIXELS) {
    throw new Error("The image pixel dimensions are unsafe or unsupported");
  }
  return dimensions;
}

function requestedCrop(form: FormData, rendition: string, aiUse: string) {
  const widthValue = String(form.get("cropWidth") || "");
  const heightValue = String(form.get("cropHeight") || "");
  if (!widthValue && !heightValue) return null;
  if (!/^\d{2,5}$/.test(widthValue) || !/^\d{2,5}$/.test(heightValue) || aiUse === "none") {
    throw new Error("Only AI-used final renditions may request a server crop");
  }
  const expected = SOCIAL_CROPS[rendition as keyof typeof SOCIAL_CROPS];
  const width = Number(widthValue);
  const height = Number(heightValue);
  if (!expected || width !== expected.width || height !== expected.height || width * height > MAX_OUTPUT_PIXELS) {
    throw new Error("The requested social rendition dimensions are not allowed");
  }
  return expected;
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function magickFormat(mime: string) {
  if (mime === "image/png") return MagickFormat.Png;
  if (mime === "image/jpeg") return MagickFormat.Jpeg;
  if (mime === "image/webp") return MagickFormat.WebP;
  throw new Error("Secure AI watermarking supports PNG, JPEG, and WebP images");
}

async function watermarkMaster() {
  if (!magickReady) {
    magickReady = (async () => {
      const wasmBytes = await Deno.readFile(new URL(
        "magick.wasm",
        import.meta.resolve("npm:@imagemagick/magick-wasm@0.0.42"),
      ));
      await initializeImageMagick(wasmBytes);
      const master = await Deno.readFile(new URL("./MyPersonas-AI-Watermark.png", import.meta.url));
      if (master.byteLength !== 168751 || await sha256Hex(master) !== WATERMARK_SHA256) {
        throw new Error("The canonical MyPersonas AI watermark master failed its integrity check");
      }
      return master;
    })().catch((error) => {
      magickReady = null;
      throw error;
    });
  }
  return await magickReady;
}

async function renderWatermarkedRaster(
  sourceBytes: Uint8Array,
  mime: string,
  crop: { width: number; height: number } | null,
) {
  const sourceDimensions = validatedDimensions(sourceBytes, mime);
  const master = await watermarkMaster();
  const format = magickFormat(mime);
  return ImageMagick.read(sourceBytes, format, (image) => {
    image.autoOrient();
    if (image.width * image.height > MAX_SOURCE_PIXELS ||
        image.width * image.height !== sourceDimensions.width * sourceDimensions.height) {
      throw new Error("The decoded image dimensions did not match the validated source header");
    }
    image.strip();
    if (crop) {
      const scale = Math.max(crop.width / image.width, crop.height / image.height);
      const resizedWidth = Math.max(crop.width, Math.ceil(image.width * scale));
      const resizedHeight = Math.max(crop.height, Math.ceil(image.height * scale));
      image.resize(resizedWidth, resizedHeight);
      image.crop(new MagickGeometry(
        Math.floor((image.width - crop.width) / 2),
        Math.floor((image.height - crop.height) / 2),
        crop.width,
        crop.height,
      ));
      image.resetPage();
    } else if (image.width * image.height > MAX_OUTPUT_PIXELS) {
      const scale = Math.sqrt(MAX_OUTPUT_PIXELS / (image.width * image.height));
      const resizedWidth = Math.max(32, Math.floor(image.width * scale));
      const resizedHeight = Math.max(32, Math.floor(image.height * scale));
      image.resize(resizedWidth, resizedHeight);
      image.resetPage();
    }
    const margin = clamp(Math.round(Math.min(image.width, image.height) * 0.025), 8, 48);
    const markWidth = Math.floor(Math.min(
      clamp(Math.round(image.width * 0.24), 96, 640),
      Math.round(image.height * 0.55),
      image.width - margin * 2,
    ));
    if (markWidth < 24) throw new Error("This image is too small for a readable AI watermark");
    const markHeight = Math.max(1, Math.round(markWidth * WATERMARK_CROP.height / WATERMARK_CROP.width));
    const x = image.width - margin - markWidth;
    const y = image.height - margin - markHeight;
    ImageMagick.read(master, MagickFormat.Png, (watermark) => {
      watermark.crop(new MagickGeometry(
        WATERMARK_CROP.x,
        WATERMARK_CROP.y,
        WATERMARK_CROP.width,
        WATERMARK_CROP.height,
      ));
      watermark.resetPage();
      const markGeometry = new MagickGeometry(markWidth, markHeight);
      markGeometry.ignoreAspectRatio = true;
      watermark.resize(markGeometry);
      const haloOffset = clamp(Math.round(Math.min(image.width, image.height) / 700), 1, 2);
      watermark.clone((halo) => {
        halo.evaluate(Channels.RGB, EvaluateOperator.Set, 0);
        halo.evaluate(Channels.Alpha, EvaluateOperator.Multiply, WATERMARK_HALO_OPACITY);
        image.composite(halo, CompositeOperator.Over, new Point(x + haloOffset, y + haloOffset));
      });
      watermark.evaluate(Channels.Alpha, EvaluateOperator.Multiply, WATERMARK_OPACITY);
      image.composite(watermark, CompositeOperator.Over, new Point(x, y));
    });
    if (mime !== "image/png") image.quality = 92;
    return image.write(format, (data) => new Uint8Array(data));
  });
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
  let crop: { width: number; height: number } | null;
  try {
    crop = requestedCrop(form, rendition, aiUse);
  } catch (error) {
    return json({ error: (error as Error).message }, 400, origin);
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
  if (["image/png", "image/jpeg", "image/webp"].includes(detected.mime)) {
    try {
      validatedDimensions(bytes, detected.mime);
    } catch (error) {
      return json({ error: (error as Error).message }, 422, origin);
    }
  }
  const declaredMime = String(file.type || "").toLowerCase();
  if (declaredMime && declaredMime !== "application/octet-stream" && declaredMime !== detected.mime) {
    return json({ error: "The declared media type does not match the file bytes" }, 415, origin);
  }
  if (aiUse !== "none" && !["image/png", "image/jpeg", "image/webp"].includes(detected.mime)) {
    return json({ error: "AI-used GIF and video require frame-by-frame watermarking before public intake" }, 422, origin);
  }
  if (aiUse !== "none" && hasUnsupportedAnimation(bytes, detected.mime)) {
    return json({ error: "AI-used APNG and animated WebP require frame-by-frame watermarking before public intake" }, 422, origin);
  }
  if (aiUse !== "none" && bytes.byteLength > MAX_AI_IMAGE_BYTES) {
    return json({ error: "AI-used static images must be no larger than 5 MB for secure watermarking" }, 413, origin);
  }

  const actualSourceSha256 = await sha256Hex(bytes);
  if (sourceSha256 !== actualSourceSha256) {
    return json({ error: "The uploaded source bytes do not match their declared integrity hash" }, 422, origin);
  }
  let finalBytes = bytes;
  if (aiUse !== "none") {
    try {
      finalBytes = await renderWatermarkedRaster(bytes, detected.mime, crop);
    } catch (error) {
      console.error("media-ingest secure watermark failure", error);
      return json({ error: "The server could not create a verified watermarked derivative" }, 422, origin);
    }
  }
  const contentSha256 = await sha256Hex(finalBytes);
  if (aiUse !== "none" && sourceSha256 === contentSha256) {
    return json({ error: "Secure watermarking did not produce a distinct final derivative" }, 500, origin);
  }
  if (finalBytes.byteLength > MAX_IMAGE_BYTES) {
    return json({ error: "The final rendered image exceeds the 10 MB public-asset limit" }, 413, origin);
  }

  const source = assetOrigin === "site_generated" ? "generated" : "uploaded";
  const path = `${user.id.toLowerCase()}/published/provenance/${aiUse}/${source}/${personaId}/${purpose}/${contentSha256}.${detected.extension}`;
  const upload = await admin.storage.from(BUCKET).upload(path, finalBytes, {
    contentType: detected.mime,
    cacheControl: "31536000",
    upsert: false,
  });
  let createdObject = !upload.error;
  if (upload.error) {
    if (/already exists|duplicate/i.test(upload.error.message || "")) {
      try {
        await verifyExisting(path, finalBytes, contentSha256);
      } catch (error) {
        return json({ error: (error as Error).message }, 409, origin);
      }
      createdObject = false;
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
    p_byte_size: finalBytes.byteLength,
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
    if (createdObject) {
      const cleanup = await admin.storage.from(BUCKET).remove([path]);
      if (cleanup.error) console.error("media-ingest orphan cleanup failed", cleanup.error);
    }
    return json({ error: "The bytes were stored but their provenance record failed closed" }, 500, origin);
  }
  return json({
    assetId: registered.data,
    publicUrl,
    path,
    sha256: contentSha256,
    sourceSha256,
    mime: detected.mime,
    byteSize: finalBytes.byteLength,
    sourceByteSize: bytes.byteLength,
    aiUse,
    watermarkState,
    watermarkVersion: aiUse === "none" ? "" : WATERMARK_VERSION,
    watermarkAuthority: aiUse === "none" ? "not_required" : "server_generated",
    crop,
  }, 200, origin);
});
