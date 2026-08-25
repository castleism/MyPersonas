// Canonical static-raster validation and AI watermark rendering for the
// legacy-media remediation path. The constants and rendering sequence mirror
// media-ingest; legacy no-AI bytes never pass through this renderer.

import {
  Channels,
  CompositeOperator,
  EvaluateOperator,
  ImageMagick,
  initializeImageMagick,
  MagickColors,
  MagickFormat,
  MagickGeometry,
  MagickImage,
  MagickReadSettings,
  Point,
} from "npm:@imagemagick/magick-wasm@0.0.42";

export const LEGACY_AI_MAX_SOURCE_BYTES = 5 * 1024 * 1024;
export const LEGACY_FINAL_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const LEGACY_WATERMARK_VERSION = "mypersonas-ai-watermark-v1";
export const LEGACY_WATERMARK_SHA256 =
  "c8ff9543374ab294ebf73ce0859581abf5e12251b7ce2735d86399d015e046b2";

const MAX_SOURCE_PIXELS = 12_000_000;
const MAX_OUTPUT_PIXELS = 2_000_000;
const WATERMARK_CROP = Object.freeze({ x: 345, y: 204, width: 1481, height: 306 });
const WATERMARK_OPACITY = 0.22;
const WATERMARK_HALO_OPACITY = 0.10;
const SOCIAL_CROPS = Object.freeze({
  facebook: Object.freeze({ width: 1200, height: 628 }),
  instagram: Object.freeze({ width: 1080, height: 1080 }),
  x: Object.freeze({ width: 1080, height: 1350 }),
});

let magickRuntimeReady: Promise<void> | null = null;
let watermarkReady: Promise<Uint8Array> | null = null;

function starts(bytes: Uint8Array, values: readonly number[], offset = 0) {
  return values.every((value, index) => bytes[offset + index] === value);
}

function ascii(bytes: Uint8Array, start: number, length: number) {
  if (start < 0 || length < 0 || start + length > bytes.length) return "";
  return String.fromCharCode(...bytes.slice(start, start + length));
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

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

async function sha256Hex(bytes: Uint8Array) {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy.buffer);
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

export function legacyRasterIsAnimated(bytes: Uint8Array, mime: string) {
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

type RasterDimensions = Readonly<{ width: number; height: number }>;

function malformed(): never {
  throw new Error("Static raster container is malformed");
}

function inspectPng(bytes: Uint8Array): RasterDimensions {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.byteLength < 45 || !starts(bytes, signature)) malformed();
  let offset = 8;
  let count = 0;
  let sawHeader = false;
  let sawData = false;
  let dataEnded = false;
  let dimensions: RasterDimensions | null = null;
  while (offset < bytes.byteLength) {
    if (++count > 4096 || offset + 12 > bytes.byteLength) malformed();
    const length = uint32be(bytes, offset);
    const type = ascii(bytes, offset + 4, 4);
    const next = offset + 12 + length;
    if (!/^[A-Za-z]{4}$/.test(type) || next > bytes.byteLength) malformed();
    if (count === 1 && (type !== "IHDR" || length !== 13)) malformed();
    if (type === "IHDR") {
      if (sawHeader || length !== 13) malformed();
      sawHeader = true;
      dimensions = { width: uint32be(bytes, offset + 8), height: uint32be(bytes, offset + 12) };
    }
    if (type === "acTL" || type === "fcTL" || type === "fdAT") malformed();
    if (type === "IDAT") {
      if (!sawHeader || dataEnded) malformed();
      sawData = true;
    } else if (sawData && type !== "IEND") {
      dataEnded = true;
    }
    if (type === "IEND") {
      if (length !== 0 || !sawHeader || !sawData || next !== bytes.byteLength || !dimensions) {
        malformed();
      }
      return dimensions;
    }
    offset = next;
  }
  return malformed();
}

function inspectJpeg(bytes: Uint8Array): RasterDimensions {
  if (bytes.byteLength < 20 || !starts(bytes, [0xff, 0xd8])) malformed();
  const allSof = new Set([
    0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7,
    0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
  ]);
  const allowedSof = new Set([0xc0, 0xc1, 0xc2]);
  let offset = 2;
  let inScan = false;
  let segmentCount = 0;
  let sofCount = 0;
  let scanCount = 0;
  let dimensions: RasterDimensions | null = null;
  while (offset < bytes.byteLength) {
    if (inScan) {
      while (offset < bytes.byteLength && bytes[offset] !== 0xff) offset++;
      if (offset >= bytes.byteLength) malformed();
    } else if (bytes[offset] !== 0xff) {
      malformed();
    }
    while (offset < bytes.byteLength && bytes[offset] === 0xff) offset++;
    if (offset >= bytes.byteLength) malformed();
    const marker = bytes[offset++];
    if (inScan) {
      if (marker === 0x00 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      inScan = false;
    } else if (marker === 0x00 || (marker >= 0xd0 && marker <= 0xd7)) {
      malformed();
    }
    if (marker === 0xd9) {
      if (!dimensions || scanCount < 1 || offset !== bytes.byteLength) malformed();
      return dimensions;
    }
    if (marker === 0xd8) malformed();
    if (marker === 0x01) continue;
    if (++segmentCount > 4096 || offset + 2 > bytes.byteLength) malformed();
    const length = uint16be(bytes, offset);
    const data = offset + 2;
    if (length < 2 || offset + length > bytes.byteLength) malformed();
    if (allSof.has(marker)) {
      if (!allowedSof.has(marker) || ++sofCount !== 1 || length < 11) malformed();
      const components = bytes[data + 5];
      if (bytes[data] !== 8 || ![1, 3, 4].includes(components) || length !== 8 + 3 * components) {
        malformed();
      }
      dimensions = {
        width: uint16be(bytes, data + 3),
        height: uint16be(bytes, data + 1),
      };
    }
    if (marker === 0xda) {
      const components = bytes[data];
      if (sofCount !== 1 || ++scanCount > 64 || components < 1 || components > 4 ||
          length !== 6 + 2 * components) malformed();
      offset += length;
      inScan = true;
      continue;
    }
    if (marker === 0xdc) malformed();
    offset += length;
  }
  return malformed();
}

function inspectWebp(bytes: Uint8Array): RasterDimensions {
  if (bytes.byteLength < 20 || ascii(bytes, 0, 4) !== "RIFF" ||
      ascii(bytes, 8, 4) !== "WEBP" || uint32le(bytes, 4) + 8 !== bytes.byteLength) {
    malformed();
  }
  let offset = 12;
  let count = 0;
  let primaryCount = 0;
  let extended = false;
  let flags = 0;
  let sawAlpha = false;
  let primaryType = "";
  let losslessAlpha = false;
  let canvas: RasterDimensions | null = null;
  let payload: RasterDimensions | null = null;
  while (offset < bytes.byteLength) {
    if (++count > 4096 || offset + 8 > bytes.byteLength) malformed();
    const type = ascii(bytes, offset, 4);
    const length = uint32le(bytes, offset + 4);
    const data = offset + 8;
    const end = data + length;
    const next = end + (length & 1);
    if (next > bytes.byteLength || ((length & 1) !== 0 && bytes[end] !== 0)) malformed();
    if (type === "ANIM" || type === "ANMF") malformed();
    if (type === "VP8X") {
      if (count !== 1 || extended || length !== 10) malformed();
      extended = true;
      flags = bytes[data];
      if ((flags & ~0x3e) !== 0 || (flags & 0x02) !== 0 ||
          bytes[data + 1] || bytes[data + 2] || bytes[data + 3]) malformed();
      canvas = { width: uint24le(bytes, data + 4) + 1, height: uint24le(bytes, data + 7) + 1 };
    } else if (type === "VP8 " || type === "VP8L") {
      if (++primaryCount !== 1) malformed();
      primaryType = type;
      if (type === "VP8 ") {
        if (length < 10 || !starts(bytes, [0x9d, 0x01, 0x2a], data + 3)) malformed();
        payload = {
          width: (bytes[data + 6] | (bytes[data + 7] << 8)) & 0x3fff,
          height: (bytes[data + 8] | (bytes[data + 9] << 8)) & 0x3fff,
        };
      } else {
        if (length < 5 || bytes[data] !== 0x2f || (bytes[data + 4] & 0xe0) !== 0) malformed();
        payload = {
          width: 1 + bytes[data + 1] + ((bytes[data + 2] & 0x3f) << 8),
          height: 1 + ((bytes[data + 2] & 0xc0) >> 6) + (bytes[data + 3] << 2) +
            ((bytes[data + 4] & 0x0f) << 10),
        };
        losslessAlpha = (bytes[data + 4] & 0x10) !== 0;
      }
    } else if (type === "ALPH") {
      if (!extended || sawAlpha || primaryCount !== 0) malformed();
      sawAlpha = true;
    } else if (!["ICCP", "EXIF", "XMP "].includes(type) || !extended) {
      malformed();
    }
    offset = next;
  }
  if (offset !== bytes.byteLength || primaryCount !== 1 || !payload) malformed();
  if (!extended && count !== 1) malformed();
  if (extended && (!canvas || canvas.width !== payload.width || canvas.height !== payload.height ||
      Boolean(flags & 0x10) !== Boolean(sawAlpha || (primaryType === "VP8L" && losslessAlpha)))) {
    malformed();
  }
  return canvas ?? payload;
}

function inspectStaticContainer(bytes: Uint8Array, mime: string) {
  if (mime === "image/png") return inspectPng(bytes);
  if (mime === "image/jpeg") return inspectJpeg(bytes);
  if (mime === "image/webp") return inspectWebp(bytes);
  throw new Error("Legacy canonical import requires a supported static raster");
}

export async function validateLegacyStaticRaster(bytes: Uint8Array, mime: string) {
  const dimensions = inspectStaticContainer(bytes, mime);
  if (!Number.isSafeInteger(dimensions.width) || !Number.isSafeInteger(dimensions.height) ||
      dimensions.width < 32 || dimensions.height < 32 ||
      dimensions.width > 8192 || dimensions.height > 8192 ||
      dimensions.width * dimensions.height > MAX_SOURCE_PIXELS) {
    throw new Error("Static raster dimensions are unsafe");
  }
  await initializeMagickRuntime();
  const format = magickFormat(mime);
  const image = MagickImage.create(MagickColors.Transparent, 1, 1);
  const warnings: string[] = [];
  image.onWarning = (event) => {
    warnings.push(event.error.message);
    return 0;
  };
  try {
    image.read(bytes, new MagickReadSettings({ format }));
    if (warnings.length !== 0 || image.format !== format ||
        image.width !== dimensions.width || image.height !== dimensions.height ||
        image.width > 8192 || image.height > 8192 ||
        image.width * image.height > MAX_SOURCE_PIXELS) {
      throw new Error("Decoded static raster identity changed");
    }
  } finally {
    image.dispose();
  }
  return dimensions;
}

function magickFormat(mime: string) {
  if (mime === "image/png") return MagickFormat.Png;
  if (mime === "image/jpeg") return MagickFormat.Jpeg;
  if (mime === "image/webp") return MagickFormat.WebP;
  throw new Error("AI-used legacy media requires a supported static raster");
}

async function initializeMagickRuntime() {
  if (!magickRuntimeReady) {
    magickRuntimeReady = (async () => {
      const wasmBytes = await Deno.readFile(new URL(
        "magick.wasm",
        import.meta.resolve("npm:@imagemagick/magick-wasm@0.0.42"),
      ));
      await initializeImageMagick(wasmBytes);
    })().catch((error) => {
      magickRuntimeReady = null;
      throw error;
    });
  }
  await magickRuntimeReady;
}

async function watermarkMaster() {
  await initializeMagickRuntime();
  if (!watermarkReady) {
    watermarkReady = (async () => {
      const master = await Deno.readFile(new URL(
        "../media-ingest/MyPersonas-AI-Watermark.png",
        import.meta.url,
      ));
      if (master.byteLength !== 168751 ||
          await sha256Hex(master) !== LEGACY_WATERMARK_SHA256) {
        throw new Error("The canonical AI watermark failed integrity verification");
      }
      return master;
    })().catch((error) => {
      watermarkReady = null;
      throw error;
    });
  }
  return await watermarkReady;
}

export async function renderLegacyRasterDerivative(
  sourceBytes: Uint8Array,
  mime: string,
  rendition: "original" | "facebook" | "instagram" | "x",
  applyWatermark: boolean,
) {
  const sourceDimensions = await validateLegacyStaticRaster(sourceBytes, mime);
  await initializeMagickRuntime();
  const master = applyWatermark ? await watermarkMaster() : null;
  const crop = rendition === "original" ? null : SOCIAL_CROPS[rendition];
  const format = magickFormat(mime);
  const output = ImageMagick.read(sourceBytes, format, (image) => {
    image.autoOrient();
    if (image.width * image.height > MAX_SOURCE_PIXELS ||
        image.width * image.height !== sourceDimensions.width * sourceDimensions.height) {
      throw new Error("Decoded raster dimensions changed");
    }
    image.strip();
    if (crop) {
      const scale = Math.max(crop.width / image.width, crop.height / image.height);
      image.resize(
        Math.max(crop.width, Math.ceil(image.width * scale)),
        Math.max(crop.height, Math.ceil(image.height * scale)),
      );
      image.crop(new MagickGeometry(
        Math.floor((image.width - crop.width) / 2),
        Math.floor((image.height - crop.height) / 2),
        crop.width,
        crop.height,
      ));
      image.resetPage();
    } else if (image.width * image.height > MAX_OUTPUT_PIXELS) {
      const scale = Math.sqrt(MAX_OUTPUT_PIXELS / (image.width * image.height));
      image.resize(
        Math.max(32, Math.floor(image.width * scale)),
        Math.max(32, Math.floor(image.height * scale)),
      );
      image.resetPage();
    }
    if (master) {
      const margin = clamp(Math.round(Math.min(image.width, image.height) * 0.025), 8, 48);
      const markWidth = Math.floor(Math.min(
        clamp(Math.round(image.width * 0.24), 96, 640),
        Math.round(image.height * 0.55),
        image.width - margin * 2,
      ));
      if (markWidth < 24) throw new Error("Raster is too small for the AI watermark");
      const markHeight = Math.max(
        1,
        Math.round(markWidth * WATERMARK_CROP.height / WATERMARK_CROP.width),
      );
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
        const geometry = new MagickGeometry(markWidth, markHeight);
        geometry.ignoreAspectRatio = true;
        watermark.resize(geometry);
        const haloOffset = clamp(
          Math.round(Math.min(image.width, image.height) / 700),
          1,
          2,
        );
        watermark.clone((halo) => {
          halo.evaluate(Channels.RGB, EvaluateOperator.Set, 0);
          halo.evaluate(Channels.Alpha, EvaluateOperator.Multiply, WATERMARK_HALO_OPACITY);
          image.composite(
            halo,
            CompositeOperator.Over,
            new Point(x + haloOffset, y + haloOffset),
          );
        });
        watermark.evaluate(Channels.Alpha, EvaluateOperator.Multiply, WATERMARK_OPACITY);
        image.composite(watermark, CompositeOperator.Over, new Point(x, y));
      });
    }
    if (mime !== "image/png") image.quality = 92;
    return image.write(format, (data) => new Uint8Array(data));
  });
  if (output.byteLength < 1 || output.byteLength > LEGACY_FINAL_IMAGE_MAX_BYTES) {
    throw new Error("Final AI-watermarked raster exceeds its byte limit");
  }
  const outputDimensions = await validateLegacyStaticRaster(output, mime);
  if (crop && (outputDimensions.width !== crop.width || outputDimensions.height !== crop.height)) {
    throw new Error("Social rendition dimensions changed");
  }
  return output;
}

export async function renderLegacyAiWatermark(sourceBytes: Uint8Array, mime: string) {
  return await renderLegacyRasterDerivative(sourceBytes, mime, "original", true);
}

export function legacyMediaExtension(mime: string) {
  if (mime === "image/png") return "png";
  if (mime === "image/jpeg") return "jpg";
  if (mime === "image/webp") return "webp";
  if (mime === "image/gif") return "gif";
  if (mime === "video/mp4") return "mp4";
  if (mime === "video/webm") return "webm";
  throw new Error("Unsupported legacy media type");
}
