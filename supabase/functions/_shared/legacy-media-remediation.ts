export const MAX_LEGACY_MEDIA_BYTES = 15 * 1024 * 1024;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SAFE_PATH = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/[A-Za-z0-9_][A-Za-z0-9._-]{0,254}(?:\/[A-Za-z0-9_][A-Za-z0-9._-]{0,254}){0,7}$/;

export type LegacyMediaResolution = {
  bucket: "media";
  storage_path: string;
  object_id: string;
  object_updated_at: string;
  expected_byte_size: number;
};

export type DetectedLegacyMedia = {
  mime: "image/png" | "image/jpeg" | "image/webp" | "image/gif" |
    "video/mp4" | "video/webm";
  extension: "png" | "jpg" | "webp" | "gif" | "mp4" | "webm";
  mediaType: "image" | "video";
};

export type LegacyMediaImportResolution = LegacyMediaResolution & {
  source_sha256: string;
  detected_mime: DetectedLegacyMedia["mime"];
  ai_use: "none" | "assisted" | "generated" | "unknown";
  persona_id: string;
  purpose: string;
  rendition: "original" | "facebook" | "instagram" | "x";
};

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
}

export function safeLegacyStoragePath(path: string, owner: string) {
  if (!UUID.test(owner) || owner !== owner.toLowerCase() || path.length > 1024 ||
      /[\u0000-\u0020%?#<>\\]/.test(path)) return false;
  const match = SAFE_PATH.exec(path);
  if (!match || match[1] !== owner) return false;
  return path.split("/").every((segment) => segment !== "." && segment !== "..");
}

export function validateLegacyMediaResolution(
  value: unknown,
  owner: string,
): LegacyMediaResolution {
  if (!record(value) || !exactKeys(value, [
    "bucket",
    "storage_path",
    "object_id",
    "object_updated_at",
    "expected_byte_size",
  ])) throw new Error("Invalid legacy media resolution");
  const expectedByteSize = Number(value.expected_byte_size);
  if (value.bucket !== "media" || typeof value.storage_path !== "string" ||
      !safeLegacyStoragePath(value.storage_path, owner) ||
      typeof value.object_id !== "string" || !UUID.test(value.object_id) ||
      value.object_id !== value.object_id.toLowerCase() ||
      typeof value.object_updated_at !== "string" ||
      !Number.isFinite(Date.parse(value.object_updated_at)) ||
      !Number.isSafeInteger(expectedByteSize) || expectedByteSize < 0) {
    throw new Error("Invalid legacy media resolution");
  }
  return {
    bucket: "media",
    storage_path: value.storage_path,
    object_id: value.object_id,
    object_updated_at: value.object_updated_at,
    expected_byte_size: expectedByteSize,
  };
}

export function validateLegacyMediaImportResolution(
  value: unknown,
  owner: string,
): LegacyMediaImportResolution {
  if (!record(value) || !exactKeys(value, [
    "bucket",
    "storage_path",
    "object_id",
    "object_updated_at",
    "expected_byte_size",
    "source_sha256",
    "detected_mime",
    "ai_use",
    "persona_id",
    "purpose",
    "rendition",
  ])) throw new Error("Invalid legacy media import resolution");
  const base = validateLegacyMediaResolution({
    bucket: value.bucket,
    storage_path: value.storage_path,
    object_id: value.object_id,
    object_updated_at: value.object_updated_at,
    expected_byte_size: value.expected_byte_size,
  }, owner);
  const sha256 = typeof value.source_sha256 === "string" ? value.source_sha256 : "";
  const mime = typeof value.detected_mime === "string" ? value.detected_mime : "";
  const aiUse = typeof value.ai_use === "string" ? value.ai_use : "";
  const personaId = typeof value.persona_id === "string" ? value.persona_id : "";
  const purpose = typeof value.purpose === "string" ? value.purpose : "";
  const rendition = typeof value.rendition === "string" ? value.rendition : "";
  if (!/^[0-9a-f]{64}$/.test(sha256) ||
      !["image/png", "image/jpeg", "image/webp", "image/gif", "video/mp4", "video/webm"].includes(mime) ||
      !["none", "assisted", "generated", "unknown"].includes(aiUse) ||
      !UUID.test(personaId) || personaId !== personaId.toLowerCase() ||
      !/^[a-z0-9_-]{1,64}(?:\/[a-z0-9_-]{1,64}){0,4}$/.test(purpose) ||
      !["original", "facebook", "instagram", "x"].includes(rendition) ||
      base.expected_byte_size < 1 || base.expected_byte_size > MAX_LEGACY_MEDIA_BYTES) {
    throw new Error("Invalid legacy media import resolution");
  }
  return {
    ...base,
    source_sha256: sha256,
    detected_mime: mime as LegacyMediaImportResolution["detected_mime"],
    ai_use: aiUse as LegacyMediaImportResolution["ai_use"],
    persona_id: personaId,
    purpose,
    rendition: rendition as LegacyMediaImportResolution["rendition"],
  };
}

function starts(bytes: Uint8Array, signature: readonly number[], offset = 0) {
  return signature.every((value, index) => bytes[offset + index] === value);
}

function ascii(bytes: Uint8Array, offset: number, length: number) {
  if (offset < 0 || length < 0 || offset + length > bytes.byteLength) return "";
  return String.fromCharCode(...bytes.slice(offset, offset + length));
}

export function detectLegacyMedia(bytes: Uint8Array): DetectedLegacyMedia {
  if (bytes.byteLength >= 24 && starts(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) &&
      ascii(bytes, 12, 4) === "IHDR") {
    return { mime: "image/png", extension: "png", mediaType: "image" };
  }
  if (bytes.byteLength >= 4 && starts(bytes, [0xff, 0xd8, 0xff]) &&
      bytes[bytes.byteLength - 2] === 0xff && bytes[bytes.byteLength - 1] === 0xd9) {
    return { mime: "image/jpeg", extension: "jpg", mediaType: "image" };
  }
  if (bytes.byteLength >= 16 && ascii(bytes, 0, 4) === "RIFF" &&
      ascii(bytes, 8, 4) === "WEBP") {
    return { mime: "image/webp", extension: "webp", mediaType: "image" };
  }
  if (bytes.byteLength >= 13 && ["GIF87a", "GIF89a"].includes(ascii(bytes, 0, 6))) {
    return { mime: "image/gif", extension: "gif", mediaType: "image" };
  }
  if (bytes.byteLength >= 16 && ascii(bytes, 4, 4) === "ftyp") {
    return { mime: "video/mp4", extension: "mp4", mediaType: "video" };
  }
  if (bytes.byteLength >= 8 && starts(bytes, [0x1a, 0x45, 0xdf, 0xa3])) {
    return { mime: "video/webm", extension: "webm", mediaType: "video" };
  }
  throw new Error("Unsupported legacy media bytes");
}

export async function readBoundedLegacyMediaResponse(
  response: Response,
  expectedByteSize = 0,
) {
  if (!response.ok || response.redirected) throw new Error("Legacy media unavailable");
  const encoding = (response.headers.get("Content-Encoding") || "identity").toLowerCase();
  if (encoding !== "identity") throw new Error("Legacy media encoding changed");
  const statedValue = response.headers.get("Content-Length");
  const stated = statedValue && /^\d{1,18}$/.test(statedValue) ? Number(statedValue) : 0;
  if (stated > MAX_LEGACY_MEDIA_BYTES || expectedByteSize > MAX_LEGACY_MEDIA_BYTES) {
    throw new Error("Legacy media exceeds its byte limit");
  }
  if (expectedByteSize > 0 && stated > 0 && stated !== expectedByteSize) {
    throw new Error("Legacy media length changed");
  }
  if (!response.body) throw new Error("Legacy media unavailable");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_LEGACY_MEDIA_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error("Legacy media exceeds its byte limit");
    }
    chunks.push(value);
  }
  if (expectedByteSize > 0 && total !== expectedByteSize) {
    throw new Error("Legacy media length changed");
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function legacyMediaSha256(bytes: Uint8Array) {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy.buffer);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

export function legacyMediaPreviewHeaders(mime: string, byteSize: number) {
  const headers = new Headers({
    "Cache-Control": "no-store, max-age=0",
    "Content-Disposition": "inline",
    "Content-Length": String(byteSize),
    "Content-Security-Policy": "default-src 'none'",
    "Content-Type": mime,
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  });
  return headers;
}
