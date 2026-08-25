import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import path from "node:path";
import test from "node:test";

register("./npm-deno-loader.mjs", import.meta.url);

globalThis.Deno = {
  async readFile(url) {
    return new Uint8Array(await readFile(url));
  },
};

const root = path.resolve(import.meta.dirname, "..");
const raster = await import("../supabase/functions/_shared/legacy-media-raster.ts");
const {
  ImageMagick,
  MagickFormat,
} = await import("@imagemagick/magick-wasm");
const master = new Uint8Array(await readFile(path.join(
  root,
  "supabase/functions/media-ingest/MyPersonas-AI-Watermark.png",
)));

function withTrailer(bytes) {
  const output = new Uint8Array(bytes.byteLength + 1);
  output.set(bytes);
  output[output.byteLength - 1] = 0x41;
  return output;
}

function truncated(bytes) {
  return bytes.slice(0, Math.max(1, bytes.byteLength - 8));
}

function apngMarker(bytes) {
  const chunk = new Uint8Array([
    0, 0, 0, 8, 0x61, 0x63, 0x54, 0x4c,
    0, 0, 0, 1, 0, 0, 0, 0,
    0, 0, 0, 0,
  ]);
  const ihdrEnd = 8 + 12 + 13;
  const output = new Uint8Array(bytes.byteLength + chunk.byteLength);
  output.set(bytes.slice(0, ihdrEnd));
  output.set(chunk, ihdrEnd);
  output.set(bytes.slice(ihdrEnd), ihdrEnd + chunk.byteLength);
  return output;
}

function syntheticAnimatedWebp() {
  const bytes = new Uint8Array(30);
  bytes.set(new TextEncoder().encode("RIFF"), 0);
  bytes[4] = 22;
  bytes.set(new TextEncoder().encode("WEBPVP8X"), 8);
  bytes[16] = 10;
  bytes[20] = 0x02;
  return bytes;
}

function convert(source, format) {
  let output;
  ImageMagick.read(source, (image) => {
    image.resize(96, 64);
    image.write(format, (bytes) => {
      output = new Uint8Array(bytes);
    });
  });
  assert.ok(output instanceof Uint8Array && output.byteLength > 0);
  return output;
}

test("strict PNG validation fully decodes and rejects animation, truncation, and trailers", async () => {
  const dimensions = await raster.validateLegacyStaticRaster(master, "image/png");
  assert.deepEqual(dimensions, { width: 2172, height: 724 });
  await assert.rejects(raster.validateLegacyStaticRaster(apngMarker(master), "image/png"), /malformed/);
  await assert.rejects(raster.validateLegacyStaticRaster(truncated(master), "image/png"), /malformed/);
  await assert.rejects(raster.validateLegacyStaticRaster(withTrailer(master), "image/png"), /malformed/);
});

test("strict JPEG and WebP validation rejects truncated and polyglot containers", async () => {
  const jpeg = convert(master, MagickFormat.Jpeg);
  const webp = convert(master, MagickFormat.WebP);
  assert.deepEqual(await raster.validateLegacyStaticRaster(jpeg, "image/jpeg"), { width: 96, height: 32 });
  assert.deepEqual(await raster.validateLegacyStaticRaster(webp, "image/webp"), { width: 96, height: 32 });
  for (const [bytes, mime] of [[jpeg, "image/jpeg"], [webp, "image/webp"]]) {
    await assert.rejects(raster.validateLegacyStaticRaster(truncated(bytes), mime));
    await assert.rejects(raster.validateLegacyStaticRaster(withTrailer(bytes), mime));
  }
  await assert.rejects(
    raster.validateLegacyStaticRaster(syntheticAnimatedWebp(), "image/webp"),
    /malformed/,
  );
});

test("social derivatives have exact contract dimensions and no-AI originals stay byte-identical", async () => {
  const original = master.slice();
  const originalHash = await crypto.subtle.digest("SHA-256", original);
  assert.deepEqual(original, master);
  assert.deepEqual(originalHash, await crypto.subtle.digest("SHA-256", master));
  for (const [rendition, expected] of [
    ["facebook", { width: 1200, height: 628 }],
    ["instagram", { width: 1080, height: 1080 }],
    ["x", { width: 1080, height: 1350 }],
  ]) {
    const output = await raster.renderLegacyRasterDerivative(
      master,
      "image/png",
      rendition,
      false,
    );
    assert.deepEqual(await raster.validateLegacyStaticRaster(output, "image/png"), expected);
  }
});

test("AI-used legacy raster receives a distinct server-rendered watermark derivative", async () => {
  const output = await raster.renderLegacyRasterDerivative(
    master,
    "image/png",
    "original",
    true,
  );
  assert.notDeepEqual(output, master);
  await raster.validateLegacyStaticRaster(output, "image/png");
});
