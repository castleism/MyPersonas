(function attachMyPersonasAiProvenance(global) {
  "use strict";

  const SCRIPT_BASE = global.document?.currentScript?.src || global.location?.href || "https://mypersonas.online/";
  const WATERMARK_SHA256 = "c8ff9543374ab294ebf73ce0859581abf5e12251b7ce2735d86399d015e046b2";
  const CONFIG = Object.freeze({
    version: "mypersonas-ai-watermark-v1",
    assetUrl: new URL(`./assets/MyPersonas-AI-Watermark.png?sha256=${WATERMARK_SHA256}`, SCRIPT_BASE).href,
    assetSha256: WATERMARK_SHA256,
    sourceCrop: Object.freeze({ x: 345, y: 204, width: 1481, height: 306 }),
    opacity: 0.22,
    haloOpacity: 0.10,
    maxSourcePixels: 12_000_000,
    maxOutputPixels: 2_000_000,
  });
  const AI_USES = new Set(["none", "assisted", "generated", "unknown"]);
  const SOURCES = new Set(["uploaded", "generated"]);
  const RASTER_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
  const CANONICAL_STORAGE_HOSTS = new Set(["nwsqyuucwzihruszocge.supabase.co"]);
  const LABELS = Object.freeze({
    none: "No generative AI declared",
    assisted: "AI-assisted content",
    generated: "AI-generated content",
    unknown: "AI use not known",
  });
  let watermarkBitmapPromise = null;

  function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
  }

  function normalizeAiUse(value) {
    const normalized = String(value || "").trim().toLowerCase();
    if (!AI_USES.has(normalized)) throw new Error("A valid AI-use declaration is required");
    return normalized;
  }

  function normalizeSource(value) {
    const normalized = String(value || "").trim().toLowerCase();
    if (!SOURCES.has(normalized)) throw new Error("A valid media source is required");
    return normalized;
  }

  function requiresVisibleMark(aiUse) {
    return normalizeAiUse(aiUse) !== "none";
  }

  function declarationLabel(aiUse) {
    return LABELS[normalizeAiUse(aiUse)];
  }

  function provenancePathPrefix(aiUse, source) {
    return `provenance/${normalizeAiUse(aiUse)}/${normalizeSource(source)}`;
  }

  function provenanceFromUrl(value) {
    let path = "";
    const raw = String(value || "").trim();
    try {
      const parsed = new URL(raw, global.location?.href || "https://mypersonas.online/");
      if (!CANONICAL_STORAGE_HOSTS.has(parsed.hostname.toLowerCase())) {
        if (/^https:\/\//i.test(raw)) {
          return Object.freeze({
            aiUse: "unknown",source: "sourced",embedded: false,legacy: true,external: true,
          });
        }
        return null;
      }
      path = decodeURIComponent(parsed.pathname).toLowerCase();
    } catch {
      return null;
    }
    const current = path.match(/\/persona-media\/[^/]+\/published\/provenance\/(none|assisted|generated|unknown)\/(uploaded|generated)\//);
    if (current) {
      return Object.freeze({ aiUse: current[1], source: current[2], embedded: current[1] !== "none", legacy: false });
    }
    if (/\/persona-media\/[^/]+\/published\/generated\//.test(path)) {
      return Object.freeze({ aiUse: "unknown", source: "generated", embedded: false, legacy: true });
    }
    return null;
  }

  function publicMarkerHtml(value, kind = "image") {
    const provenance = provenanceFromUrl(value);
    if (!provenance || provenance.aiUse === "none") return "";
    const safeKind = ["image", "video", "audio", "document", "file"].includes(kind) ? kind : "file";
    const needsLogoOverlay = safeKind !== "image" || !provenance.embedded;
    const label = declarationLabel(provenance.aiUse);
    return `<span class="ai-content-disclosure ai-use-${provenance.aiUse} ai-kind-${safeKind}${needsLogoOverlay ? " needs-logo-overlay" : " embedded-logo"}" role="img" aria-label="${label}"><span class="ai-content-watermark" aria-hidden="true"></span><span class="ai-content-label">${label}</span></span>`;
  }

  function imagePresentationClass(value) {
    const provenance = provenanceFromUrl(value);
    return provenance && provenance.aiUse !== "none" ? "ai-content-image" : "";
  }

  async function sha256Hex(blob) {
    const bytes = await blob.arrayBuffer();
    const digest = await global.crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  async function loadWatermarkBitmap() {
    if (!watermarkBitmapPromise) {
      watermarkBitmapPromise = (async () => {
        const response = await fetch(CONFIG.assetUrl, { cache: "force-cache", credentials: "same-origin" });
        if (!response.ok) throw new Error("The MyPersonas AI watermark asset could not be loaded");
        const blob = await response.blob();
        if ((await sha256Hex(blob)) !== CONFIG.assetSha256) {
          throw new Error("The MyPersonas AI watermark master failed its integrity check");
        }
        return await createImageBitmap(blob);
      })().catch((error) => {
        watermarkBitmapPromise = null;
        throw error;
      });
    }
    return await watermarkBitmapPromise;
  }

  function drawCover(ctx, bitmap, width, height) {
    const scale = Math.max(width / bitmap.width, height / bitmap.height);
    const sourceWidth = width / scale;
    const sourceHeight = height / scale;
    const sourceX = (bitmap.width - sourceWidth) / 2;
    const sourceY = (bitmap.height - sourceHeight) / 2;
    ctx.drawImage(bitmap, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, width, height);
  }

  function drawWatermark(ctx, width, height, watermark) {
    const crop = CONFIG.sourceCrop;
    const margin = clamp(Math.round(Math.min(width, height) * 0.025), 8, 48);
    const markWidth = Math.floor(Math.min(
      clamp(Math.round(width * 0.24), 96, 640),
      Math.round(height * 0.55),
      width - margin * 2,
    ));
    if (markWidth < 24) throw new Error("This image is too small for a readable AI watermark");
    const markHeight = Math.max(1, Math.round(markWidth * crop.height / crop.width));
    const x = width - margin - markWidth;
    const y = height - margin - markHeight;
    const mask = document.createElement("canvas");
    mask.width = markWidth;
    mask.height = markHeight;
    const maskContext = mask.getContext("2d", { alpha: true });
    if (!maskContext) throw new Error("This browser cannot prepare the AI watermark");
    maskContext.drawImage(watermark, crop.x, crop.y, crop.width, crop.height, 0, 0, markWidth, markHeight);
    maskContext.globalCompositeOperation = "source-in";
    maskContext.fillStyle = "#000";
    maskContext.fillRect(0, 0, markWidth, markHeight);

    ctx.save();
    ctx.globalAlpha = CONFIG.haloOpacity;
    const offset = clamp(Math.round(Math.min(width, height) / 700), 1, 2);
    ctx.drawImage(mask, x + offset, y + offset);
    ctx.globalAlpha = CONFIG.opacity;
    ctx.drawImage(watermark, crop.x, crop.y, crop.width, crop.height, x, y, markWidth, markHeight);
    ctx.restore();
  }

  function outputName(file, mime, suffix = "mypersonas-ai") {
    const extension = mime === "image/jpeg" ? "jpg" : mime === "image/webp" ? "webp" : "png";
    const stem = String(file?.name || "image").replace(/\.[^.]+$/, "").replace(/[^a-z0-9._-]+/gi, "-").slice(0, 100) || "image";
    return `${stem}-${suffix}.${extension}`;
  }

  async function watermarkRaster(file, options = {}) {
    const mime = String(file?.type || "").trim().toLowerCase();
    if (mime === "image/gif") {
      throw new Error("AI-used animated GIFs need frame-by-frame watermarking. Convert this file to a supported static image before publishing.");
    }
    if (!RASTER_TYPES.has(mime)) throw new Error("AI image watermarking supports PNG, JPEG, and WebP files");
    const source = await createImageBitmap(file);
    try {
      if (!source.width || !source.height || source.width * source.height > CONFIG.maxSourcePixels) {
        throw new Error("This image has unsafe or unsupported pixel dimensions");
      }
      const requestedCrop = options.crop && Number.isInteger(options.crop.width) && Number.isInteger(options.crop.height)
        ? options.crop
        : null;
      const outputScale = !requestedCrop && source.width * source.height > CONFIG.maxOutputPixels
        ? Math.sqrt(CONFIG.maxOutputPixels / (source.width * source.height))
        : 1;
      const width = requestedCrop ? requestedCrop.width : Math.max(32, Math.floor(source.width * outputScale));
      const height = requestedCrop ? requestedCrop.height : Math.max(32, Math.floor(source.height * outputScale));
      if (width < 32 || height < 32 || width * height > CONFIG.maxOutputPixels) {
        throw new Error("The requested watermarked image size is not supported");
      }
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d", { alpha: true, willReadFrequently: false });
      if (!ctx) throw new Error("This browser cannot prepare a watermarked image");
      if (requestedCrop) drawCover(ctx, source, width, height);
      else ctx.drawImage(source, 0, 0, width, height);
      drawWatermark(ctx, width, height, await loadWatermarkBitmap());
      const quality = mime === "image/png" ? undefined : 0.92;
      const blob = await new Promise((resolve, reject) => {
        canvas.toBlob((result) => result ? resolve(result) : reject(new Error("The browser could not encode the watermarked image")), mime, quality);
      });
      return new File([blob], outputName(file, mime, options.suffix), { type: mime, lastModified: Date.now() });
    } finally {
      source.close?.();
    }
  }

  function askAiUse(options = {}) {
    return new Promise((resolve) => {
      const previousFocus = document.activeElement;
      const old = document.getElementById("aiUseDeclarationOverlay");
      if (old) old.remove();
      const overlay = document.createElement("div");
      overlay.id = "aiUseDeclarationOverlay";
      overlay.className = "ai-declaration-overlay";
      overlay.innerHTML = `<div class="ai-declaration-dialog" role="dialog" aria-modal="true" aria-labelledby="aiDeclarationTitle" aria-describedby="aiDeclarationHelp" tabindex="-1">
        <h2 id="aiDeclarationTitle">Was generative AI used?</h2>
        <p id="aiDeclarationFile" class="ai-declaration-file"></p>
        <p id="aiDeclarationHelp">Choose the most accurate answer. MyPersonas visibly marks AI-assisted, AI-generated, and uncertain media. The declaration is saved with the asset.</p>
        <div class="ai-declaration-choices">
          <button type="button" data-ai-use="none"><b>No AI</b><span>Made without generative AI.</span></button>
          <button type="button" data-ai-use="assisted"><b>AI-assisted</b><span>AI edited, extended, or materially helped create it.</span></button>
          <button type="button" data-ai-use="generated"><b>AI-generated</b><span>The asset was primarily generated by AI.</span></button>
          <button type="button" data-ai-use="unknown"><b>Not sure</b><span>The source does not make AI use clear.</span></button>
        </div>
        <button class="btn sec sm ai-declaration-cancel" type="button">Cancel upload</button>
      </div>`;
      const filename = String(options.filename || "").slice(0, 160);
      const fileNode = overlay.querySelector("#aiDeclarationFile");
      if (fileNode) fileNode.textContent = filename ? `File: ${filename}` : "This choice is required before upload.";
      const background = Array.from(document.body.children).filter((element) => element !== overlay);
      const priorInert = background.map((element) => ({ element, inert: element.inert }));
      const finish = (value) => {
        document.removeEventListener("keydown", onKeydown, true);
        priorInert.forEach(({ element, inert }) => { element.inert = inert; });
        overlay.remove();
        previousFocus?.focus?.();
        resolve(value);
      };
      const onKeydown = (event) => {
        if (event.key === "Escape") { event.preventDefault(); finish(null); }
        if (event.key === "Tab") {
          const focusable = Array.from(overlay.querySelectorAll("button:not([disabled]),[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex='-1'])"));
          if (!focusable.length) { event.preventDefault(); return; }
          const first = focusable[0], last = focusable[focusable.length - 1];
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
        }
      };
      overlay.querySelectorAll("[data-ai-use]").forEach((button) => button.addEventListener("click", () => finish(button.dataset.aiUse)));
      overlay.querySelector(".ai-declaration-cancel")?.addEventListener("click", () => finish(null));
      overlay.addEventListener("click", (event) => { if (event.target === overlay) finish(null); });
      document.addEventListener("keydown", onKeydown, true);
      document.body.appendChild(overlay);
      priorInert.forEach(({ element }) => { element.inert = true; });
      overlay.querySelector("[data-ai-use]")?.focus();
    });
  }

  global.MyPersonasAiProvenance = Object.freeze({
    config: CONFIG,
    normalizeAiUse,
    normalizeSource,
    requiresVisibleMark,
    declarationLabel,
    provenancePathPrefix,
    provenanceFromUrl,
    publicMarkerHtml,
    imagePresentationClass,
    sha256Hex,
    watermarkRaster,
    askAiUse,
  });
})(window);
