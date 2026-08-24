(function (global) {
  "use strict";

  const MAX_SOURCE_PIXELS = 48_000_000;
  const MIN_SOURCE_EDGE = 32;
  const MAX_ZOOM = 3;
  const OUTPUT_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
  const SPECS = Object.freeze({
    avatar_url: Object.freeze({
      label: "Profile image",
      width: 768,
      height: 768,
      safe: Object.freeze({ x: 0, y: 0, width: 1, height: 1, round: true }),
      safeLabel: "The circle shows the visible profile-photo edge.",
      previews: Object.freeze([
        Object.freeze({ label: "Profile", width: 132, height: 132, round: true }),
        Object.freeze({ label: "Card", width: 64, height: 64, round: true }),
        Object.freeze({ label: "Rail", width: 52, height: 52, round: true }),
      ]),
    }),
    banner_url: Object.freeze({
      label: "Banner",
      width: 1152,
      height: 640,
      safe: Object.freeze({ x: 0, y: 0.3, width: 1, height: 0.4, round: false }),
      safeLabel: "Keep faces inside the dashed band so desktop and card banners do not cut them off.",
      previews: Object.freeze([
        Object.freeze({ label: "Desktop", width: 320, height: 68 }),
        Object.freeze({ label: "Persona card", width: 240, height: 92 }),
        Object.freeze({ label: "Phone", width: 240, height: 116 }),
      ]),
    }),
    bg_url: Object.freeze({
      label: "Page background",
      width: 1152,
      height: 768,
      safe: Object.freeze({ x: 0.25, y: 0.25, width: 0.5, height: 0.5, round: false }),
      safeLabel: "Keep the important subject inside the dashed center for both wide and tall screens.",
      previews: Object.freeze([
        Object.freeze({ label: "Desktop", width: 320, height: 180 }),
        Object.freeze({ label: "Phone", width: 120, height: 213 }),
      ]),
    }),
    feed_img_url: Object.freeze({
      label: "Feed header",
      width: 1152,
      height: 512,
      safe: Object.freeze({ x: 0.11, y: 0, width: 0.78, height: 1, round: false }),
      safeLabel: "Keep faces inside the dashed center so square feed boxes do not trim them.",
      previews: Object.freeze([
        Object.freeze({ label: "Feed header", width: 320, height: 142 }),
        Object.freeze({ label: "Wide post", width: 320, height: 180 }),
        Object.freeze({ label: "Square box", width: 180, height: 180 }),
      ]),
    }),
  });

  let active = null;
  let openGeneration = 0;

  function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
  }

  function finitePositive(value, name) {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) throw new Error(`${name} must be positive`);
    return number;
  }

  function cropGeometry({ sourceWidth, sourceHeight, targetWidth, targetHeight, zoom = 1, offsetX = 0, offsetY = 0 }) {
    const sw = finitePositive(sourceWidth, "Source width");
    const sh = finitePositive(sourceHeight, "Source height");
    const tw = finitePositive(targetWidth, "Target width");
    const th = finitePositive(targetHeight, "Target height");
    const normalizedZoom = clamp(Number(zoom) || 1, 1, MAX_ZOOM);
    const scale = Math.max(tw / sw, th / sh) * normalizedZoom;
    const drawWidth = sw * scale;
    const drawHeight = sh * scale;
    const maxOffsetX = Math.max(0, (drawWidth - tw) / 2);
    const maxOffsetY = Math.max(0, (drawHeight - th) / 2);
    const clampedOffsetX = clamp(Number(offsetX) || 0, -maxOffsetX, maxOffsetX);
    const clampedOffsetY = clamp(Number(offsetY) || 0, -maxOffsetY, maxOffsetY);
    return Object.freeze({
      zoom: normalizedZoom,
      scale,
      drawWidth,
      drawHeight,
      maxOffsetX,
      maxOffsetY,
      offsetX: clampedOffsetX,
      offsetY: clampedOffsetY,
      drawX: (tw - drawWidth) / 2 + clampedOffsetX,
      drawY: (th - drawHeight) / 2 + clampedOffsetY,
    });
  }

  function centeredCoverRect(sourceWidth, sourceHeight, targetWidth, targetHeight) {
    const sw = finitePositive(sourceWidth, "Source width");
    const sh = finitePositive(sourceHeight, "Source height");
    const tw = finitePositive(targetWidth, "Target width");
    const th = finitePositive(targetHeight, "Target height");
    const sourceRatio = sw / sh;
    const targetRatio = tw / th;
    if (sourceRatio > targetRatio) {
      const width = sh * targetRatio;
      return Object.freeze({ x: (sw - width) / 2, y: 0, width, height: sh });
    }
    const height = sw / targetRatio;
    return Object.freeze({ x: 0, y: (sh - height) / 2, width: sw, height });
  }

  function slotSpec(slot) {
    return SPECS[String(slot || "")] || null;
  }

  function allowedFile(file) {
    return !!file && OUTPUT_TYPES.has(String(file.type || "").trim().toLowerCase());
  }

  async function decodeFile(file) {
    if (!allowedFile(file)) throw new Error("Profile crops accept PNG, JPEG, or WebP images");
    if (typeof global.createImageBitmap === "function") {
      try {
        const bitmap = await global.createImageBitmap(file, { imageOrientation: "from-image" });
        return {
          source: bitmap,
          width: bitmap.width,
          height: bitmap.height,
          release() { if (typeof bitmap.close === "function") bitmap.close(); },
        };
      } catch (_) {
        // Fall back to an HTML image for browsers without the orientation option.
      }
    }
    const objectUrl = global.URL.createObjectURL(file);
    const image = new global.Image();
    image.decoding = "async";
    image.src = objectUrl;
    try {
      if (typeof image.decode === "function") await image.decode();
      else await new Promise((resolve, reject) => {
        image.onload = resolve;
        image.onerror = () => reject(new Error("The selected image could not be decoded"));
      });
      return {
        source: image,
        width: image.naturalWidth,
        height: image.naturalHeight,
        release() { global.URL.revokeObjectURL(objectUrl); image.removeAttribute("src"); },
      };
    } catch (error) {
      global.URL.revokeObjectURL(objectUrl);
      throw error;
    }
  }

  function validateDecoded(decoded, spec) {
    if (!Number.isSafeInteger(decoded.width) || !Number.isSafeInteger(decoded.height) ||
        decoded.width < MIN_SOURCE_EDGE || decoded.height < MIN_SOURCE_EDGE) {
      throw new Error("The selected image is too small or has invalid dimensions");
    }
    if (decoded.width * decoded.height > MAX_SOURCE_PIXELS) {
      throw new Error("The selected image is too large to crop safely (48 megapixels maximum)");
    }
    if (spec.width * spec.height > 2_000_000) throw new Error("The requested crop size is not allowed");
  }

  function currentGeometry(state) {
    return cropGeometry({
      sourceWidth: state.decoded.width,
      sourceHeight: state.decoded.height,
      targetWidth: state.spec.width,
      targetHeight: state.spec.height,
      zoom: state.zoom,
      offsetX: state.offsetX,
      offsetY: state.offsetY,
    });
  }

  function renderMiniPreview(sourceCanvas, previewCanvas) {
    const context = previewCanvas.getContext("2d", { alpha: true });
    const rect = centeredCoverRect(sourceCanvas.width, sourceCanvas.height, previewCanvas.width, previewCanvas.height);
    context.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
    context.drawImage(sourceCanvas, rect.x, rect.y, rect.width, rect.height, 0, 0, previewCanvas.width, previewCanvas.height);
  }

  function render(state) {
    if (!state || state.closed) return;
    const geometry = currentGeometry(state);
    state.offsetX = geometry.offsetX;
    state.offsetY = geometry.offsetY;
    const context = state.canvas.getContext("2d", { alpha: true });
    context.clearRect(0, 0, state.spec.width, state.spec.height);
    context.drawImage(state.decoded.source, geometry.drawX, geometry.drawY, geometry.drawWidth, geometry.drawHeight);
    state.previewCanvases.forEach((canvas) => renderMiniPreview(state.canvas, canvas));
    state.zoomOutput.textContent = `${Math.round(state.zoom * 100)}%`;
  }

  function moveImage(state, deltaX, deltaY) {
    if (!state || state.closed || state.busy) return;
    state.offsetX += deltaX;
    state.offsetY += deltaY;
    render(state);
  }

  function setZoom(state, nextZoom) {
    const before = currentGeometry(state);
    const relativeX = before.maxOffsetX ? before.offsetX / before.maxOffsetX : 0;
    const relativeY = before.maxOffsetY ? before.offsetY / before.maxOffsetY : 0;
    state.zoom = clamp(Number(nextZoom) || 1, 1, MAX_ZOOM);
    const after = cropGeometry({
      sourceWidth: state.decoded.width,
      sourceHeight: state.decoded.height,
      targetWidth: state.spec.width,
      targetHeight: state.spec.height,
      zoom: state.zoom,
    });
    state.offsetX = relativeX * after.maxOffsetX;
    state.offsetY = relativeY * after.maxOffsetY;
    render(state);
  }

  function outputName(originalName, mime) {
    const base = String(originalName || "profile-image")
      .replace(/\.[^.]+$/, "")
      .replace(/[^a-z0-9._-]+/gi, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 72) || "profile-image";
    const extension = mime === "image/jpeg" ? "jpg" : mime === "image/webp" ? "webp" : "png";
    return `${base}-cropped.${extension}`;
  }

  function canvasBlob(canvas, mime) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (!blob || !blob.size) reject(new Error("The browser could not encode this crop"));
        else resolve(blob);
      }, mime, mime === "image/png" ? undefined : 0.92);
    });
  }

  function setBusy(state, busy, message) {
    state.busy = !!busy;
    state.applyButton.disabled = !!busy;
    state.cancelButton.disabled = !!busy;
    state.resetButton.disabled = !!busy;
    state.zoomInput.disabled = !!busy;
    state.applyButton.textContent = busy ? "Preparing crop…" : "Use this crop";
    state.status.textContent = message || "";
  }

  function settle(state, value) {
    if (!state || state.closed) return;
    state.closed = true;
    state.abort.abort();
    state.overlay.remove();
    state.decoded.release();
    global.document.body.style.overflow = state.previousBodyOverflow;
    if (active === state) active = null;
    const focusTarget = state.previousFocus;
    state.resolve(value);
    if (focusTarget && typeof focusTarget.focus === "function" && focusTarget.isConnected) focusTarget.focus();
  }

  async function apply(state) {
    if (!state || state.closed || state.busy) return;
    setBusy(state, true, "Encoding the exact crop that will be uploaded…");
    try {
      const requestedMime = String(state.file.type || "").trim().toLowerCase();
      let blob = await canvasBlob(state.canvas, requestedMime);
      if (!OUTPUT_TYPES.has(blob.type)) blob = await canvasBlob(state.canvas, "image/png");
      if (!OUTPUT_TYPES.has(blob.type) || !blob.size) throw new Error("The crop did not produce an allowed image");
      if (blob.size > 10 * 1024 * 1024) throw new Error("The finished crop is larger than 10 MB");
      const cropped = new global.File([blob], outputName(state.file.name, blob.type), {
        type: blob.type,
        lastModified: Date.now(),
      });
      if (!state.closed) settle(state, cropped);
    } catch (error) {
      if (!state.closed) setBusy(state, false, error?.message || String(error));
    }
  }

  function trapFocus(state, event) {
    if (event.key === "Escape") {
      if (!state.busy) { event.preventDefault(); settle(state, null); }
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = [...state.dialog.querySelectorAll('button:not(:disabled),input:not(:disabled),[tabindex="0"]')];
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && global.document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && global.document.activeElement === last) { event.preventDefault(); first.focus(); }
  }

  function buildDialog(state) {
    const document = global.document;
    const overlay = document.createElement("div");
    overlay.className = "mp-crop-overlay";
    overlay.innerHTML = `<section class="mp-crop-dialog" role="dialog" aria-modal="true" aria-labelledby="mpCropTitle" aria-describedby="mpCropHelp">
      <header class="mp-crop-head">
        <div><h2 id="mpCropTitle">Place your ${state.spec.label.toLowerCase()}</h2><p id="mpCropHelp">Drag the image, use the zoom control, and check every preview before applying it.</p></div>
        <button class="mp-crop-close" type="button" aria-label="Cancel image crop">×</button>
      </header>
      <div class="mp-crop-body">
        <div class="mp-crop-source"><span>Selected file</span><strong class="mp-crop-filename"></strong><small>${state.decoded.width} × ${state.decoded.height} pixels</small></div>
        <div class="mp-crop-stage-wrap">
          <div class="mp-crop-stage">
            <canvas class="mp-crop-canvas" tabindex="0" aria-label="Crop canvas. Drag to reposition; use arrow keys for precise movement."></canvas>
            <div class="mp-crop-safe" aria-hidden="true"></div>
          </div>
        </div>
        <p class="mp-crop-safe-label"></p>
        <div class="mp-crop-controls">
          <label for="mpCropZoom">Zoom <output for="mpCropZoom">100%</output></label>
          <input id="mpCropZoom" type="range" min="100" max="300" step="1" value="100">
          <button class="btn sec sm mp-crop-reset" type="button">Reset position</button>
        </div>
        <section class="mp-crop-preview-section" aria-labelledby="mpCropPreviewTitle"><h3 id="mpCropPreviewTitle">How this placement looks</h3><div class="mp-crop-previews"></div></section>
        <p class="mp-crop-note">Only the approved crop leaves this browser; MyPersonas does not retain the original local file. If AI was used, the server adds the official watermark after cropping.</p>
        <p class="mp-crop-status" role="status" aria-live="polite"></p>
      </div>
      <footer class="mp-crop-actions"><button class="btn sec mp-crop-cancel" type="button">Cancel</button><button class="btn mp-crop-apply" type="button">Use this crop</button></footer>
    </section>`;
    document.body.appendChild(overlay);
    state.overlay = overlay;
    state.dialog = overlay.querySelector(".mp-crop-dialog");
    state.canvas = overlay.querySelector(".mp-crop-canvas");
    state.canvas.width = state.spec.width;
    state.canvas.height = state.spec.height;
    state.canvas.style.aspectRatio = `${state.spec.width} / ${state.spec.height}`;
    state.zoomInput = overlay.querySelector("#mpCropZoom");
    state.zoomOutput = overlay.querySelector("output");
    state.applyButton = overlay.querySelector(".mp-crop-apply");
    state.cancelButton = overlay.querySelector(".mp-crop-cancel");
    state.resetButton = overlay.querySelector(".mp-crop-reset");
    state.status = overlay.querySelector(".mp-crop-status");
    overlay.querySelector(".mp-crop-filename").textContent = state.file.name || "Selected image";
    overlay.querySelector(".mp-crop-safe-label").textContent = state.spec.safeLabel;
    const safe = overlay.querySelector(".mp-crop-safe");
    safe.style.left = `${state.spec.safe.x * 100}%`;
    safe.style.top = `${state.spec.safe.y * 100}%`;
    safe.style.width = `${state.spec.safe.width * 100}%`;
    safe.style.height = `${state.spec.safe.height * 100}%`;
    if (state.spec.safe.round) safe.classList.add("is-round");
    const previews = overlay.querySelector(".mp-crop-previews");
    state.previewCanvases = state.spec.previews.map((preview) => {
      const figure = document.createElement("figure");
      const canvas = document.createElement("canvas");
      canvas.width = preview.width;
      canvas.height = preview.height;
      canvas.setAttribute("aria-label", `${preview.label} crop preview`);
      if (preview.round) canvas.classList.add("is-round");
      const caption = document.createElement("figcaption");
      caption.textContent = preview.label;
      figure.append(canvas, caption);
      previews.appendChild(figure);
      return canvas;
    });
  }

  function bindDialog(state) {
    const signal = state.abort.signal;
    const cancelButtons = [state.cancelButton, state.overlay.querySelector(".mp-crop-close")];
    cancelButtons.forEach((button) => button.addEventListener("click", () => { if (!state.busy) settle(state, null); }, { signal }));
    state.applyButton.addEventListener("click", () => apply(state), { signal });
    state.resetButton.addEventListener("click", () => {
      state.zoom = 1; state.offsetX = 0; state.offsetY = 0; state.zoomInput.value = "100"; render(state); state.canvas.focus();
    }, { signal });
    state.zoomInput.addEventListener("input", () => setZoom(state, Number(state.zoomInput.value) / 100), { signal });
    state.dialog.addEventListener("keydown", (event) => trapFocus(state, event), { signal });
    state.canvas.addEventListener("keydown", (event) => {
      if (event.key === "+" || event.key === "=") {
        event.preventDefault();
        setZoom(state, state.zoom + 0.05);
        state.zoomInput.value = String(Math.round(state.zoom * 100));
        return;
      }
      if (event.key === "-" || event.key === "_") {
        event.preventDefault();
        setZoom(state, state.zoom - 0.05);
        state.zoomInput.value = String(Math.round(state.zoom * 100));
        return;
      }
      const step = event.shiftKey ? 28 : 8;
      const movement = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] }[event.key];
      if (!movement) return;
      event.preventDefault();
      moveImage(state, movement[0], movement[1]);
    }, { signal });
    state.canvas.addEventListener("pointerdown", (event) => {
      if (state.busy || (event.pointerType === "mouse" && event.button !== 0)) return;
      event.preventDefault();
      state.drag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
      state.canvas.setPointerCapture(event.pointerId);
      state.canvas.classList.add("is-dragging");
    }, { signal });
    state.canvas.addEventListener("pointermove", (event) => {
      if (!state.drag || state.drag.pointerId !== event.pointerId || state.busy) return;
      const rect = state.canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      moveImage(state,
        (event.clientX - state.drag.x) * state.spec.width / rect.width,
        (event.clientY - state.drag.y) * state.spec.height / rect.height);
      state.drag.x = event.clientX;
      state.drag.y = event.clientY;
    }, { signal });
    const endDrag = (event) => {
      if (!state.drag || state.drag.pointerId !== event.pointerId) return;
      state.drag = null;
      state.canvas.classList.remove("is-dragging");
    };
    state.canvas.addEventListener("pointerup", endDrag, { signal });
    state.canvas.addEventListener("pointercancel", endDrag, { signal });
    state.canvas.addEventListener("lostpointercapture", () => {
      state.drag = null; state.canvas.classList.remove("is-dragging");
    }, { signal });
  }

  function cancel() {
    openGeneration += 1;
    if (active && !active.closed) settle(active, null);
  }

  async function open({ file, slot }) {
    cancel();
    const generation = ++openGeneration;
    const spec = slotSpec(slot);
    if (!spec) throw new Error("This profile image slot cannot be cropped");
    if (!allowedFile(file)) throw new Error("Profile crops accept PNG, JPEG, or WebP images");
    const decoded = await decodeFile(file);
    if (generation !== openGeneration) { decoded.release(); return null; }
    try {
      validateDecoded(decoded, spec);
    } catch (error) {
      decoded.release();
      throw error;
    }
    return await new Promise((resolve, reject) => {
      const state = {
        file, slot, spec, decoded, generation, resolve, reject,
        zoom: 1, offsetX: 0, offsetY: 0, busy: false, closed: false, drag: null,
        abort: new AbortController(), previousFocus: global.document.activeElement,
        previousBodyOverflow: global.document.body.style.overflow,
        previewCanvases: [],
      };
      try {
        buildDialog(state);
        active = state;
        global.document.body.style.overflow = "hidden";
        bindDialog(state);
        render(state);
        state.canvas.focus();
      } catch (error) {
        state.closed = true;
        state.abort.abort();
        decoded.release();
        if (state.overlay) state.overlay.remove();
        if (active === state) active = null;
        global.document.body.style.overflow = state.previousBodyOverflow;
        reject(error);
      }
    });
  }

  global.MyPersonasProfileCrop = Object.freeze({
    specs: SPECS,
    maxSourcePixels: MAX_SOURCE_PIXELS,
    cropGeometry,
    centeredCoverRect,
    open,
    cancel,
  });
})(typeof window === "undefined" ? globalThis : window);
