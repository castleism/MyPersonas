import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (value) => readFile(path.join(root, value), "utf8");

async function cropApi() {
  const source = await read("MyPersonas.Online_v0/profile-image-crop.js");
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: "profile-image-crop.js" });
  return sandbox.MyPersonasProfileCrop;
}

test("crop geometry covers the target and clamps every edge", async () => {
  const crop = await cropApi();
  const centered = crop.cropGeometry({ sourceWidth: 2000, sourceHeight: 1000, targetWidth: 1000, targetHeight: 1000 });
  assert.equal(centered.scale, 1);
  assert.equal(centered.drawWidth, 2000);
  assert.equal(centered.drawHeight, 1000);
  assert.equal(centered.maxOffsetX, 500);
  assert.equal(centered.maxOffsetY, 0);

  const upperRight = crop.cropGeometry({ sourceWidth: 2000, sourceHeight: 1000, targetWidth: 1000, targetHeight: 1000, offsetX: 9999, offsetY: -9999 });
  assert.equal(upperRight.offsetX, 500);
  assert.equal(Math.abs(upperRight.offsetY), 0);
  assert.equal(upperRight.drawX, 0);
  assert.equal(Math.abs(upperRight.drawY), 0);

  const lowerLeft = crop.cropGeometry({ sourceWidth: 1000, sourceHeight: 2000, targetWidth: 1000, targetHeight: 1000, offsetX: -9999, offsetY: 9999 });
  assert.equal(Math.abs(lowerLeft.offsetX), 0);
  assert.equal(lowerLeft.offsetY, 500);
  assert.equal(lowerLeft.drawX, 0);
  assert.equal(lowerLeft.drawY, 0);
});

test("zoom is bounded and cannot expose empty crop space", async () => {
  const crop = await cropApi();
  const minimum = crop.cropGeometry({ sourceWidth: 1200, sourceHeight: 800, targetWidth: 600, targetHeight: 600, zoom: 0 });
  const maximum = crop.cropGeometry({ sourceWidth: 1200, sourceHeight: 800, targetWidth: 600, targetHeight: 600, zoom: 99, offsetX: 99999, offsetY: -99999 });
  assert.equal(minimum.zoom, 1);
  assert.equal(maximum.zoom, 3);
  assert.equal(maximum.offsetX, maximum.maxOffsetX);
  assert.equal(maximum.offsetY, -maximum.maxOffsetY);
  assert.ok(maximum.drawX <= 0);
  assert.ok(maximum.drawY <= 0);
  assert.ok(maximum.drawX + maximum.drawWidth >= 600);
  assert.ok(maximum.drawY + maximum.drawHeight >= 600);
});

test("downstream preview masks use centered cover crops", async () => {
  const crop = await cropApi();
  const desktop = crop.centeredCoverRect(1152, 640, 320, 68);
  assert.equal(desktop.x, 0);
  assert.ok(Math.abs(desktop.y - 197.6) < 1e-9);
  assert.equal(desktop.width, 1152);
  assert.ok(Math.abs(desktop.height - 244.8) < 1e-9);
  assert.deepEqual(
    { ...crop.centeredCoverRect(1152, 512, 180, 180) },
    { x: 320, y: 0, width: 512, height: 512 },
  );
});

test("all four persona image slots have bounded outputs and responsive previews", async () => {
  const crop = await cropApi();
  assert.deepEqual(Object.keys(crop.specs), ["avatar_url", "banner_url", "bg_url", "feed_img_url"]);
  for (const spec of Object.values(crop.specs)) {
    assert.ok(spec.width >= 768 && spec.width <= 1152);
    assert.ok(spec.height >= 512 && spec.height <= 768);
    assert.ok(spec.width * spec.height <= 2_000_000);
    assert.ok(spec.previews.length >= 2);
    assert.ok(spec.safe.width > 0 && spec.safe.width <= 1);
    assert.ok(spec.safe.height > 0 && spec.safe.height <= 1);
  }
});

test("profile uploads crop exact bytes before hashing and server watermarking", async () => {
  const [html, cropSource, cropCss, pages] = await Promise.all([
    read("MyPersonas.Online_v0/index.html"),
    read("MyPersonas.Online_v0/profile-image-crop.js"),
    read("MyPersonas.Online_v0/profile-image-crop.css"),
    read(".github/workflows/pages.yml"),
  ]);
  const upload = html.split("function uploadTo(inputId){")[1]?.split("// ================= ACCOUNT:")[0] || "";
  assert.match(html, /profile-image-crop\.css\?v=20260823-1/);
  assert.match(html, /profile-image-crop\.js\?v=20260823-1/);
  assert.match(html, /Choose &amp; crop/);
  assert.match(html, /if\(window\.MyPersonasProfileCrop\)window\.MyPersonasProfileCrop\.cancel\(\)/);
  assert.match(upload, /f\.accept="image\/png,image\/jpeg,image\/webp,image\/gif,video\/mp4,video\/webm";if\(profileSlot\)f\.accept="image\/png,image\/jpeg,image\/webp"/);
  assert.match(upload, /prepared=await window\.MyPersonasProfileCrop\.open\(\{file:source,slot:inputId\.slice\(2\)\}\)/);
  assert.match(upload, /askAiUse\(\{filename:source\.name\}\)/);
  assert.match(upload, /sha256Hex\(prepared\)/);
  assert.doesNotMatch(upload, /sha256Hex\(source\)/);
  assert.match(upload, /uploadImmutablePersonaMedia\(prepared,ownerId/);
  assert.match(upload, /if\(!stillCurrent\(\)\)throw new Error\("The image uploaded safely/);
  assert.match(cropSource, /createImageBitmap\(file, \{ imageOrientation: "from-image" \}\)/);
  assert.match(cropSource, /MAX_SOURCE_PIXELS = 48_000_000/);
  assert.match(cropSource, /global\.File\(\[blob\]/);
  assert.match(cropSource, /state\.decoded\.release\(\)/);
  assert.match(cropSource, /role="dialog" aria-modal="true"/);
  assert.match(cropSource, /pointerdown/);
  assert.match(cropSource, /ArrowLeft/);
  assert.match(cropSource, /event\.key === "\+"/);
  assert.match(cropSource, /global\.document\.body\.style\.overflow = state\.previousBodyOverflow/);
  assert.match(cropCss, /touch-action:none/);
  assert.match(pages, /--include '\/profile-image-crop\.css'/);
  assert.match(pages, /--include '\/profile-image-crop\.js'/);
  assert.doesNotMatch(upload, /cropWidth|cropHeight/);
});

test("registered Gemini assets remain outside the upload crop path", async () => {
  const html = await read("MyPersonas.Online_v0/index.html");
  const generated = html.match(/async function sdUse\(k\)\{[\s\S]*?\n\}/)?.[0] || "";
  assert.match(generated, /setPrev\(k,publicUrl\)/);
  assert.doesNotMatch(generated, /MyPersonasProfileCrop|uploadTo/);
});
