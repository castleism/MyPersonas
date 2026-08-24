// Private, owner-only Persona Source Library.
// Raw files stay behind the authenticated persona-source-library Edge endpoint.
(function () {
  "use strict";

  const SOURCE_LIBRARY_ENDPOINT = "/functions/v1/persona-source-library";
  const SOURCE_LIBRARY_PAGE_SIZE = 60;
  const SOURCE_LIBRARY_MAX_FILES = 100;
  const SOURCE_LIBRARY_MAX_FILE_BYTES = 10 * 1024 * 1024;
  const SOURCE_LIBRARY_MAX_PREVIEW_BYTES = 10 * 1024 * 1024;
  const SOURCE_LIBRARY_MAX_BLOB_BYTES = 72 * 1024 * 1024;
  const SOURCE_LIBRARY_MAX_BLOB_URLS = 24;
  const SOURCE_LIBRARY_UPLOAD_CONCURRENCY = 2;
  const SOURCE_LIBRARY_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const SOURCE_LIBRARY_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
  const SOURCE_LIBRARY_INTENTS = Object.freeze(["research", "content_later", "unsorted", "archive"]);
  const SOURCE_LIBRARY_AI_USE = Object.freeze(["none", "assisted", "generated", "unknown"]);
  const SOURCE_LIBRARY_RIGHTS = Object.freeze(["owner_created", "licensed", "reference_only", "unknown"]);
  const SOURCE_LIBRARY_REUSE = Object.freeze(["reference_only", "derivative_allowed", "publish_allowed"]);
  const SOURCE_LIBRARY_SENSITIVITY = Object.freeze(["standard", "sensitive", "restricted"]);
  const SOURCE_LIBRARY_NOTE_KINDS = Object.freeze(["description", "research", "content_idea", "visual_reference", "warning"]);

  const sourceLibraryState = {
    ownerId: "", personaId: "", routeGeneration: 0, requestGeneration: 0,
    assets: [], notes: [], jobs: [], loading: false, loadingMore: false, error: "",
    cursor: null, done: false, queue: [], activeUploads: 0, uploadRefreshPending: false,
    controllers: new Set(), xhr: new Set(), previewUrls: new Map(), previewBytes: 0,
    previewRequests: new Map(), observer: null, modalAssetId: "",
    filterIntent: "all", filterStatus: "all", filterSearch: "",
  };

  function sourceLibraryEsc(value) {
    if (typeof esc === "function") return esc(value == null ? "" : String(value));
    return String(value == null ? "" : value).replace(/[&<>"']/g, (character) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[character]);
  }
  function sourceLibraryToast(message) { if (typeof toast === "function") toast(message); }
  function sourceLibraryNormalize(value, allowed, fallback) {
    const normalized = String(value || "").trim().toLowerCase();
    return allowed.includes(normalized) ? normalized : fallback;
  }
  function sourceLibraryNormalizeIntent(value) { return sourceLibraryNormalize(value, SOURCE_LIBRARY_INTENTS, "unsorted"); }
  function sourceLibraryNormalizeAiUse(value) { return sourceLibraryNormalize(value, SOURCE_LIBRARY_AI_USE, "unknown"); }
  function sourceLibraryNormalizeRights(value) { return sourceLibraryNormalize(value, SOURCE_LIBRARY_RIGHTS, "unknown"); }
  function sourceLibraryNormalizeReuse(value) { return sourceLibraryNormalize(value, SOURCE_LIBRARY_REUSE, "reference_only"); }
  function sourceLibraryNormalizeSensitivity(value) { return sourceLibraryNormalize(value, SOURCE_LIBRARY_SENSITIVITY, "standard"); }
  function sourceLibraryNormalizeNoteKind(value) { return sourceLibraryNormalize(value, SOURCE_LIBRARY_NOTE_KINDS, "description"); }
  function sourceLibraryParseTags(value) {
    const seen = new Set();
    for (const part of String(value || "").split(",").slice(0, 40)) {
      const tag = part.normalize("NFKC").replace(/[\u0000-\u001f\u007f<>]/gu, "").trim().replace(/\s+/g, " ").slice(0, 48);
      if (tag) seen.add(tag);
      if (seen.size >= 20) break;
    }
    return [...seen];
  }

  function sourceLibraryValidPersona(personaId) {
    return SOURCE_LIBRARY_UUID.test(String(personaId || ""))
      && Array.isArray(typeof myPersonas === "undefined" ? null : myPersonas)
      && myPersonas.some((persona) => persona.id === personaId);
  }
  function sourceLibraryRouteParts() {
    const raw = location.hash.replace(/^#\/?/, "");
    const pieces = raw.split("/");
    let personaId = "";
    try { personaId = decodeURIComponent(pieces.slice(1).join("/") || ""); } catch (_) {}
    return { view: pieces[0] || "", personaId };
  }
  function sourceLibrarySnapshot(personaId = sourceLibraryState.personaId) {
    return {
      ownerId: typeof session !== "undefined" && session?.user?.id ? session.user.id : "",
      authGeneration: typeof authLoadGeneration === "number" ? authLoadGeneration : -1,
      routeGeneration: sourceLibraryState.routeGeneration,
      personaId: String(personaId || ""),
    };
  }
  function sourceLibrarySnapshotCurrent(snapshot, requireRoute = true) {
    if (!snapshot?.ownerId || typeof session === "undefined" || session?.user?.id !== snapshot.ownerId) return false;
    if (typeof privateSessionReady !== "undefined" && !privateSessionReady) return false;
    if (typeof authLoadGeneration === "number" && snapshot.authGeneration !== authLoadGeneration) return false;
    if (snapshot.routeGeneration !== sourceLibraryState.routeGeneration) return false;
    if (snapshot.personaId !== sourceLibraryState.personaId || !sourceLibraryValidPersona(snapshot.personaId)) return false;
    if (!requireRoute) return true;
    const route = sourceLibraryRouteParts();
    return route.view === "library" && route.personaId === snapshot.personaId;
  }
  function sourceLibraryRequireContext(personaId = sourceLibraryState.personaId) {
    const snapshot = sourceLibrarySnapshot(personaId);
    if (!sourceLibrarySnapshotCurrent(snapshot)) throw new Error("The account, route, or selected persona changed. Nothing was sent.");
    return snapshot;
  }

  function sourceLibraryTrackController() {
    const controller = new AbortController();
    sourceLibraryState.controllers.add(controller);
    return controller;
  }
  function sourceLibraryReleaseController(controller) { sourceLibraryState.controllers.delete(controller); }
  function sourceLibraryAbortRequests() {
    for (const controller of sourceLibraryState.controllers) controller.abort();
    sourceLibraryState.controllers.clear();
    for (const xhr of sourceLibraryState.xhr) { try { xhr.abort(); } catch (_) {} }
    sourceLibraryState.xhr.clear();
    sourceLibraryState.activeUploads = 0;
    sourceLibraryState.previewRequests.clear();
    sourceLibraryState.observer?.disconnect();
    sourceLibraryState.observer = null;
  }
  function sourceLibraryRevokePreview(assetId) {
    const cached = sourceLibraryState.previewUrls.get(assetId);
    if (!cached) return;
    URL.revokeObjectURL(cached.url);
    sourceLibraryState.previewBytes = Math.max(0, sourceLibraryState.previewBytes - cached.bytes);
    sourceLibraryState.previewUrls.delete(assetId);
  }
  function sourceLibraryRevokeAllPreviews() {
    for (const assetId of [...sourceLibraryState.previewUrls.keys()]) sourceLibraryRevokePreview(assetId);
    sourceLibraryState.previewBytes = 0;
  }
  function sourceLibraryCloseDetail(restoreFocus = true) {
    sourceLibraryState.modalAssetId = "";
    if (typeof releaseOwnerModal === "function" && document.getElementById("personaSourceLibraryModal")) {
      releaseOwnerModal("personaSourceLibraryModal");
    } else {
      document.getElementById("personaSourceLibraryModal")?.remove();
    }
    if (!restoreFocus) document.activeElement?.blur?.();
  }
  function sourceLibraryReset() {
    sourceLibraryAbortRequests();
    sourceLibraryCloseDetail(false);
    sourceLibraryRevokeAllPreviews();
    sourceLibraryState.ownerId = "";
    sourceLibraryState.personaId = "";
    sourceLibraryState.routeGeneration += 1;
    sourceLibraryState.requestGeneration += 1;
    sourceLibraryState.assets = [];
    sourceLibraryState.notes = [];
    sourceLibraryState.jobs = [];
    sourceLibraryState.loading = false;
    sourceLibraryState.loadingMore = false;
    sourceLibraryState.error = "";
    sourceLibraryState.cursor = null;
    sourceLibraryState.done = false;
    sourceLibraryState.queue = [];
    sourceLibraryState.activeUploads = 0;
    sourceLibraryState.uploadRefreshPending = false;
    sourceLibraryState.filterIntent = "all";
    sourceLibraryState.filterStatus = "all";
    sourceLibraryState.filterSearch = "";
  }
  function sourceLibraryRouteChanged(view, personaId) {
    if (view !== "library" || String(personaId || "") !== sourceLibraryState.personaId) sourceLibraryReset();
  }

  function sourceLibraryEndpoint() {
    if (typeof CONFIG === "undefined" || !CONFIG?.SUPABASE_URL) throw new Error("The private media service is not configured.");
    return CONFIG.SUPABASE_URL.replace(/\/$/, "") + SOURCE_LIBRARY_ENDPOINT;
  }
  async function sourceLibraryFreshToken(snapshot) {
    const current = await sb.auth.getSession();
    if (current.error) throw current.error;
    const fresh = current.data?.session;
    if (!fresh?.access_token || fresh.user?.id !== snapshot.ownerId || !sourceLibrarySnapshotCurrent(snapshot)) {
      throw new Error("The signed-in account changed. Nothing was sent.");
    }
    return fresh.access_token;
  }
  async function sourceLibraryJsonRequest(action, payload, snapshot = sourceLibraryRequireContext()) {
    const controller = sourceLibraryTrackController();
    try {
      const token = await sourceLibraryFreshToken(snapshot);
      const response = await fetch(sourceLibraryEndpoint(), {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ action, ...payload }),
        credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store", signal: controller.signal,
      });
      if (!sourceLibrarySnapshotCurrent(snapshot)) throw new DOMException("Account changed", "AbortError");
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result?.error?.message || result?.error || `Private library service returned ${response.status}.`);
      return result;
    } finally { sourceLibraryReleaseController(controller); }
  }

  function sourceLibraryImageMagicMatches(bytes, type) {
    if (type === "image/png") return bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value);
    if (type === "image/jpeg") return bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
    if (type === "image/webp") return bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP";
    return false;
  }
  async function sourceLibraryBoundedImageBlob(response, maxBytes = SOURCE_LIBRARY_MAX_PREVIEW_BYTES) {
    const stated = Number(response.headers.get("content-length") || 0);
    const type = String(response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (!SOURCE_LIBRARY_IMAGE_TYPES.has(type)) throw new Error("The private service did not return a supported inert image.");
    if (stated > maxBytes) throw new Error("This private image is too large to open in the browser.");
    let blob;
    if (!response.body) {
      blob = await response.blob();
      if (blob.size > maxBytes) throw new Error("This private image is too large to open in the browser.");
      blob = new Blob([blob], { type });
    } else {
      const reader = response.body.getReader(), chunks = [];
      let total = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) { await reader.cancel(); throw new Error("This private image is too large to open in the browser."); }
        chunks.push(value);
      }
      blob = new Blob(chunks, { type });
    }
    const probe = new Uint8Array(await blob.slice(0, 32).arrayBuffer());
    if (!sourceLibraryImageMagicMatches(probe, type)) throw new Error("The private image bytes do not match their declared type.");
    return blob;
  }
  async function sourceLibraryBlobRequest(action, assetId, maxBytes = SOURCE_LIBRARY_MAX_PREVIEW_BYTES) {
    if (!SOURCE_LIBRARY_UUID.test(String(assetId || ""))) throw new Error("This source item is no longer valid.");
    const snapshot = sourceLibraryRequireContext();
    const controller = sourceLibraryTrackController();
    try {
      const token = await sourceLibraryFreshToken(snapshot);
      const response = await fetch(sourceLibraryEndpoint(), {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ action, assetId }),
        credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store", signal: controller.signal,
      });
      if (!sourceLibrarySnapshotCurrent(snapshot)) throw new DOMException("Account changed", "AbortError");
      if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        throw new Error(result?.error?.message || result?.error || "This private image is unavailable.");
      }
      return await sourceLibraryBoundedImageBlob(response, maxBytes);
    } finally { sourceLibraryReleaseController(controller); }
  }
  function sourceLibraryCachePreview(assetId, blob) {
    sourceLibraryRevokePreview(assetId);
    const entry = { url: URL.createObjectURL(blob), bytes: blob.size, usedAt: Date.now() };
    sourceLibraryState.previewUrls.set(assetId, entry);
    sourceLibraryState.previewBytes += blob.size;
    while (sourceLibraryState.previewUrls.size > SOURCE_LIBRARY_MAX_BLOB_URLS || sourceLibraryState.previewBytes > SOURCE_LIBRARY_MAX_BLOB_BYTES) {
      const oldest = [...sourceLibraryState.previewUrls.entries()].filter(([id]) => id !== assetId).sort((left, right) => left[1].usedAt - right[1].usedAt)[0];
      if (!oldest) break;
      sourceLibraryRevokePreview(oldest[0]);
    }
    return entry.url;
  }
  async function sourceLibraryPreviewUrl(assetId) {
    const cached = sourceLibraryState.previewUrls.get(assetId);
    if (cached) { cached.usedAt = Date.now(); return cached.url; }
    const pending = sourceLibraryState.previewRequests.get(assetId);
    if (pending) return pending;
    const snapshot = sourceLibraryRequireContext();
    const request = sourceLibraryBlobRequest("preview", assetId).then((blob) => {
      if (!sourceLibrarySnapshotCurrent(snapshot)) throw new DOMException("Account changed", "AbortError");
      return sourceLibraryCachePreview(assetId, blob);
    }).finally(() => sourceLibraryState.previewRequests.delete(assetId));
    sourceLibraryState.previewRequests.set(assetId, request);
    return request;
  }

  function sourceLibraryAsset(assetId) { return sourceLibraryState.assets.find((asset) => asset.id === assetId) || null; }
  function sourceLibraryAssetNotes(assetId) { return sourceLibraryState.notes.filter((note) => note.asset_id === assetId); }
  function sourceLibraryAssetJob(assetId) {
    return sourceLibraryState.jobs.filter((job) => job.asset_id === assetId)
      .sort((left, right) => Date.parse(right.created_at || 0) - Date.parse(left.created_at || 0))[0] || null;
  }
  function sourceLibrarySafeFilename(asset, type = "") {
    const extension = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" }[type || asset?.mime_type] || "image";
    const base = String(asset?.original_filename || asset?.title || "persona-source").replace(/\.[a-z0-9]{1,8}$/i, "")
      .replace(/[^a-z0-9 ._()'-]+/gi, "_").replace(/\s+/g, " ").trim().slice(0, 100) || "persona-source";
    return `${base}.${extension}`;
  }
  function sourceLibraryFileValidation(file) {
    if (!(file instanceof Blob)) return { ok: false, error: "This item is not a file." };
    const type = String(file.type || "").toLowerCase();
    if (!type.startsWith("image/") || type === "image/svg+xml" || !SOURCE_LIBRARY_IMAGE_TYPES.has(type)) {
      return { ok: false, error: "Use a PNG, JPEG, or WebP image. SVG and unknown file types are not accepted." };
    }
    if (!file.size) return { ok: false, error: "This file is empty." };
    if (file.size > SOURCE_LIBRARY_MAX_FILE_BYTES) return { ok: false, error: "Each private source image must be 10 MB or smaller." };
    return { ok: true, error: "" };
  }
  function sourceLibraryFormatBytes(value) {
    const bytes = Math.max(0, Number(value) || 0);
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024).toLocaleString()} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
  }
  function sourceLibraryFormatDate(value) {
    if (!value || !Number.isFinite(Date.parse(value))) return "Date not recorded";
    return new Date(value).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
  }
  function sourceLibraryLabel(value) { return String(value || "").replace(/_/g, " ").replace(/\b\w/g, (character) => character.toUpperCase()); }
  function sourceLibraryStatus(asset) {
    const job = sourceLibraryAssetJob(asset.id);
    if (job?.cancel_requested === true && ["queued", "claimed"].includes(job.status)) return "cancellation_requested";
    if (job && ["queued", "claimed"].includes(job.status)) return job.status;
    return String(asset.lifecycle_state || "ready");
  }

  async function sourceLibraryRelatedRows(assetIds, snapshot) {
    if (!assetIds.length) return { notes: [], jobs: [] };
    const notes = [], jobs = [];
    for (let offset = 0; offset < assetIds.length; offset += 100) {
      const ids = assetIds.slice(offset, offset + 100);
      const controller = sourceLibraryTrackController();
      try {
        let noteQuery = sb.from("persona_source_notes")
          .select("id,owner,persona_id,asset_id,author_kind,note_kind,body,review_state,provider_label,model_label,created_at,updated_at")
          .eq("owner", snapshot.ownerId).eq("persona_id", snapshot.personaId).in("asset_id", ids).order("created_at", { ascending: true });
        let jobQuery = sb.from("persona_source_analysis_jobs")
          .select("id,owner,persona_id,asset_id,execution_mode,status,cancel_requested,provider_label,model_label,created_at,started_at,completed_at,failure_code")
          .eq("owner", snapshot.ownerId).eq("persona_id", snapshot.personaId).in("asset_id", ids).order("created_at", { ascending: false });
        if (typeof noteQuery.abortSignal === "function") noteQuery = noteQuery.abortSignal(controller.signal);
        if (typeof jobQuery.abortSignal === "function") jobQuery = jobQuery.abortSignal(controller.signal);
        const [noteResult, jobResult] = await Promise.all([noteQuery, jobQuery]);
        if (noteResult.error) throw noteResult.error;
        if (jobResult.error) throw jobResult.error;
        notes.push(...(noteResult.data || []));
        jobs.push(...(jobResult.data || []));
      } finally { sourceLibraryReleaseController(controller); }
      if (!sourceLibrarySnapshotCurrent(snapshot)) throw new DOMException("Account changed", "AbortError");
    }
    return { notes, jobs };
  }
  function sourceLibraryCursorFilter(query, cursor) {
    if (!cursor?.created_at || !SOURCE_LIBRARY_UUID.test(String(cursor.id || ""))) return query;
    return query.or(`created_at.lt.${cursor.created_at},and(created_at.eq.${cursor.created_at},id.lt.${cursor.id})`);
  }
  async function sourceLibraryLoad(reset = true) {
    const snapshot = sourceLibraryRequireContext();
    if (sourceLibraryState.loading || sourceLibraryState.loadingMore) return;
    const requestGeneration = ++sourceLibraryState.requestGeneration;
    if (reset) {
      sourceLibraryState.loading = true; sourceLibraryState.error = ""; sourceLibraryState.assets = [];
      sourceLibraryState.notes = []; sourceLibraryState.jobs = []; sourceLibraryState.cursor = null; sourceLibraryState.done = false;
      sourceLibraryRevokeAllPreviews();
    } else {
      if (sourceLibraryState.done) return;
      sourceLibraryState.loadingMore = true;
    }
    sourceLibraryRenderGrid();
    const controller = sourceLibraryTrackController();
    try {
      let query = sb.from("persona_source_assets")
        .select("id,owner,persona_id,intent,storage_mode,title,owner_notes,original_filename,mime_type,byte_size,pixel_width,pixel_height,captured_at,lifecycle_state,publication_state,ai_use,rights_basis,reuse_policy,sensitivity,hosted_analysis_consent,owner_tags,created_at,updated_at")
        .eq("owner", snapshot.ownerId).eq("persona_id", snapshot.personaId)
        .order("created_at", { ascending: false }).order("id", { ascending: false }).limit(SOURCE_LIBRARY_PAGE_SIZE);
      if (!reset) query = sourceLibraryCursorFilter(query, sourceLibraryState.cursor);
      if (typeof query.abortSignal === "function") query = query.abortSignal(controller.signal);
      const result = await query;
      if (result.error) throw result.error;
      if (!sourceLibrarySnapshotCurrent(snapshot) || requestGeneration !== sourceLibraryState.requestGeneration) return;
      const rows = result.data || [], existing = new Set(reset ? [] : sourceLibraryState.assets.map((asset) => asset.id));
      sourceLibraryState.assets = (reset ? [] : sourceLibraryState.assets).concat(rows.filter((asset) => !existing.has(asset.id)));
      if (rows.length) {
        const last = rows[rows.length - 1];
        sourceLibraryState.cursor = { created_at: last.created_at, id: last.id };
      }
      sourceLibraryState.done = rows.length < SOURCE_LIBRARY_PAGE_SIZE;
      const related = await sourceLibraryRelatedRows(sourceLibraryState.assets.map((asset) => asset.id), snapshot);
      if (!sourceLibrarySnapshotCurrent(snapshot) || requestGeneration !== sourceLibraryState.requestGeneration) return;
      sourceLibraryState.notes = related.notes;
      sourceLibraryState.jobs = related.jobs;
      sourceLibraryState.error = "";
    } catch (error) {
      if (error?.name !== "AbortError" && sourceLibrarySnapshotCurrent(snapshot, false)) sourceLibraryState.error = error?.message || "The private source library could not be loaded.";
    } finally {
      sourceLibraryReleaseController(controller);
      if (requestGeneration === sourceLibraryState.requestGeneration) {
        sourceLibraryState.loading = false; sourceLibraryState.loadingMore = false;
        sourceLibraryRenderStats(); sourceLibraryRenderGrid();
        if (sourceLibraryState.modalAssetId && sourceLibraryAsset(sourceLibraryState.modalAssetId)) sourceLibraryRenderDetail(sourceLibraryState.modalAssetId);
      }
    }
  }

  function sourceLibraryCurrentIntake() {
    return {
      intent: sourceLibraryNormalizeIntent(document.getElementById("sourceLibraryIntent")?.value),
      aiUse: sourceLibraryNormalizeAiUse(document.getElementById("sourceLibraryAiUse")?.value),
      rights: sourceLibraryNormalizeRights(document.getElementById("sourceLibraryRights")?.value),
      reusePolicy: sourceLibraryNormalizeReuse(document.getElementById("sourceLibraryReuse")?.value),
      sensitivity: sourceLibraryNormalizeSensitivity(document.getElementById("sourceLibrarySensitivity")?.value),
      analysisConsent: document.getElementById("sourceLibraryAnalysisConsent")?.checked === true,
      ownerTags: sourceLibraryParseTags(document.getElementById("sourceLibraryTags")?.value),
    };
  }
  function sourceLibraryQueueId() {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
    if (typeof crypto === "undefined" || typeof crypto.getRandomValues !== "function") {
      throw new Error("A secure browser context is required to stage private source images.");
    }
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    const hex = [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  function sourceLibraryAddFiles(fileList, source = "picker") {
    sourceLibraryRequireContext();
    const files = [...(fileList || [])].slice(0, SOURCE_LIBRARY_MAX_FILES);
    if (!files.length) return;
    const remaining = Math.max(0, SOURCE_LIBRARY_MAX_FILES - sourceLibraryState.queue.length);
    const options = sourceLibraryCurrentIntake();
    for (const file of files.slice(0, remaining)) {
      const validation = sourceLibraryFileValidation(file);
      let id;
      try { id = sourceLibraryQueueId(); } catch (error) { sourceLibraryToast(error?.message || "Secure private intake is unavailable in this browser."); return; }
      sourceLibraryState.queue.push({
        id, file, name: String(file.name || `pasted-${Date.now()}.png`).slice(0, 180),
        source, options: { ...options }, status: validation.ok ? "ready" : "error", error: validation.error,
        progress: 0, retryable: validation.ok, xhr: null,
      });
    }
    if (files.length > remaining) sourceLibraryToast(`Only ${SOURCE_LIBRARY_MAX_FILES} files can be staged at once.`);
    sourceLibraryRenderQueue();
  }
  function sourceLibraryFilesChosen(input, source = "picker") {
    sourceLibraryAddFiles(input?.files, source);
    if (input) input.value = "";
  }
  function sourceLibraryRemoveQueueItem(queueId) {
    const item = sourceLibraryState.queue.find((row) => row.id === queueId);
    if (!item) return;
    if (item.status === "uploading" && item.xhr) { try { item.xhr.abort(); } catch (_) {} return; }
    sourceLibraryState.queue = sourceLibraryState.queue.filter((row) => row.id !== queueId);
    sourceLibraryRenderQueue();
  }
  function sourceLibraryRetryUpload(queueId) {
    const item = sourceLibraryState.queue.find((row) => row.id === queueId);
    if (!item || !item.retryable) return;
    item.status = "ready"; item.error = ""; item.progress = 0;
    sourceLibraryRenderQueue(); sourceLibraryStartUploads();
  }
  async function sourceLibraryUploadItem(item, snapshot) {
    const token = await sourceLibraryFreshToken(snapshot);
    if (!sourceLibrarySnapshotCurrent(snapshot)) throw new DOMException("Account changed", "AbortError");
    const form = new FormData();
    form.append("action", "upload"); form.append("file", item.file, item.name); form.append("personaId", snapshot.personaId);
    form.append("intent", item.options.intent); form.append("aiUse", item.options.aiUse); form.append("rightsBasis", item.options.rights);
    form.append("reusePolicy", item.options.reusePolicy); form.append("sensitivity", item.options.sensitivity);
    form.append("analysisConsent", String(item.options.analysisConsent)); form.append("idempotencyKey", item.id);
    form.append("tags", JSON.stringify(item.options.ownerTags));
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      item.xhr = xhr; sourceLibraryState.xhr.add(xhr);
      xhr.open("POST", sourceLibraryEndpoint(), true); xhr.withCredentials = false; xhr.timeout = 120000;
      xhr.setRequestHeader("Authorization", `Bearer ${token}`);
      xhr.upload.onprogress = (event) => {
        if (!sourceLibrarySnapshotCurrent(snapshot) || !event.lengthComputable) return;
        item.progress = Math.max(1, Math.min(99, Math.round((event.loaded / event.total) * 100)));
        sourceLibraryRenderQueue();
      };
      xhr.onload = () => {
        let result = {};
        try { result = JSON.parse(xhr.responseText || "{}"); } catch (_) {}
        if (!sourceLibrarySnapshotCurrent(snapshot)) reject(new DOMException("Account changed", "AbortError"));
        else if (xhr.status < 200 || xhr.status >= 300 || !SOURCE_LIBRARY_UUID.test(String(result.assetId || ""))) reject(new Error(result?.error?.message || result?.error || `Private upload returned ${xhr.status}.`));
        else resolve(result);
      };
      xhr.onerror = () => reject(new Error("The private upload connection failed."));
      xhr.ontimeout = () => reject(new Error("The private upload timed out. Retry when the connection is stable."));
      xhr.onabort = () => reject(new DOMException("Upload cancelled", "AbortError"));
      xhr.onloadend = () => { sourceLibraryState.xhr.delete(xhr); item.xhr = null; };
      xhr.send(form);
    });
  }
  function sourceLibraryPumpUploads() {
    const snapshot = sourceLibrarySnapshot();
    if (!sourceLibrarySnapshotCurrent(snapshot)) return;
    while (sourceLibraryState.activeUploads < SOURCE_LIBRARY_UPLOAD_CONCURRENCY) {
      const item = sourceLibraryState.queue.find((row) => row.status === "ready");
      if (!item) break;
      item.status = "uploading"; item.error = ""; item.progress = 1; sourceLibraryState.activeUploads += 1; sourceLibraryRenderQueue();
      sourceLibraryUploadItem(item, snapshot).then(() => {
        if (!sourceLibrarySnapshotCurrent(snapshot)) return;
        item.status = "complete"; item.progress = 100; sourceLibraryState.uploadRefreshPending = true;
      }).catch((error) => {
        if (!sourceLibrarySnapshotCurrent(snapshot, false)) return;
        item.status = error?.name === "AbortError" ? "cancelled" : "error";
        item.error = error?.name === "AbortError" ? "Upload cancelled." : (error?.message || "Upload failed.");
        item.retryable = error?.name !== "AbortError";
      }).finally(() => {
        sourceLibraryState.activeUploads = Math.max(0, sourceLibraryState.activeUploads - 1);
        if (!sourceLibrarySnapshotCurrent(snapshot, false)) return;
        sourceLibraryRenderQueue(); sourceLibraryPumpUploads();
        const waiting = sourceLibraryState.queue.some((row) => row.status === "ready" || row.status === "uploading");
        if (!waiting && sourceLibraryState.uploadRefreshPending) {
          sourceLibraryState.uploadRefreshPending = false; sourceLibraryLoad(true);
        }
      });
    }
  }
  function sourceLibraryStartUploads() {
    sourceLibraryRequireContext();
    if (!sourceLibraryState.queue.some((item) => item.status === "ready")) { sourceLibraryToast("Choose images or retry a failed upload first."); return; }
    sourceLibraryPumpUploads();
  }
  function sourceLibraryQueueHtml(item) {
    const status = item.status === "ready" ? "Ready" : item.status === "uploading" ? `Uploading ${item.progress}%`
      : item.status === "complete" ? "Stored privately" : item.status === "cancelled" ? "Cancelled" : "Needs attention";
    return `<li class="psl-queue-item ${sourceLibraryEsc(item.status)}">
      <div class="psl-queue-copy"><b>${sourceLibraryEsc(item.name)}</b><span>${sourceLibraryEsc(sourceLibraryFormatBytes(item.file?.size))} · ${sourceLibraryEsc(sourceLibraryLabel(item.options.intent))}</span>${item.error ? `<small role="alert">${sourceLibraryEsc(item.error)}</small>` : ""}</div>
      <div class="psl-queue-progress" aria-label="${sourceLibraryEsc(status)}"><span style="width:${Math.max(0, Math.min(100, item.progress))}%"></span></div>
      <span class="psl-queue-status">${sourceLibraryEsc(status)}</span>
      <div class="psl-queue-actions">${item.status === "error" && item.retryable ? `<button type="button" onclick="sourceLibraryRetryUpload('${item.id}')">Retry</button>` : ""}
        ${["ready", "error", "cancelled", "uploading"].includes(item.status) ? `<button type="button" onclick="sourceLibraryRemoveQueueItem('${item.id}')">${item.status === "uploading" ? "Cancel" : "Remove"}</button>` : ""}</div></li>`;
  }
  function sourceLibraryRenderQueue() {
    const root = document.getElementById("sourceLibraryQueue");
    if (!root) return;
    root.innerHTML = sourceLibraryState.queue.length
      ? `<div class="psl-queue-head"><b>Upload queue</b><button class="psl-primary" type="button" onclick="sourceLibraryStartUploads()" ${sourceLibraryState.queue.some((item) => item.status === "ready") ? "" : "disabled"}>Upload ready files</button></div><ul>${sourceLibraryState.queue.map(sourceLibraryQueueHtml).join("")}</ul>`
      : '<div class="psl-empty compact"><b>No files staged</b><span>Choose, drop, or paste images. Nothing uploads until you press Upload ready files.</span></div>';
  }

  function sourceLibraryFilterAssets() {
    const needle = sourceLibraryState.filterSearch.trim().toLowerCase();
    return sourceLibraryState.assets.filter((asset) => {
      const intent = sourceLibraryNormalizeIntent(asset.intent);
      if (sourceLibraryState.filterIntent !== "all" && intent !== sourceLibraryState.filterIntent) return false;
      const status = sourceLibraryStatus(asset);
      if (sourceLibraryState.filterStatus !== "all" && status !== sourceLibraryState.filterStatus) return false;
      if (!needle) return true;
      const tags = Array.isArray(asset.owner_tags) ? asset.owner_tags.join(" ") : "";
      return [asset.title, asset.original_filename, asset.owner_notes, tags].some((value) => String(value || "").toLowerCase().includes(needle));
    });
  }
  function sourceLibraryCardHtml(asset) {
    const notes = sourceLibraryAssetNotes(asset.id), job = sourceLibraryAssetJob(asset.id), status = sourceLibraryStatus(asset);
    const tags = Array.isArray(asset.owner_tags) ? asset.owner_tags.slice(0, 4) : [];
    return `<article class="psl-card" data-source-asset-id="${asset.id}">
      <button class="psl-card-open" type="button" onclick="sourceLibraryOpenDetail('${asset.id}')" aria-label="Open ${sourceLibraryEsc(asset.title || asset.original_filename || "private source image")}">
        <span class="psl-thumb"><span class="psl-thumb-loading">Private preview</span><img hidden alt="" data-source-library-thumb="${asset.id}"></span>
        <span class="psl-card-copy"><b>${sourceLibraryEsc(asset.title || asset.original_filename || "Untitled source")}</b><span>${sourceLibraryEsc(sourceLibraryFormatBytes(asset.byte_size))} · ${sourceLibraryEsc(sourceLibraryFormatDate(asset.captured_at || asset.created_at))}</span></span>
      </button>
      <div class="psl-card-meta"><span class="psl-pill ${sourceLibraryEsc(status)}">${sourceLibraryEsc(sourceLibraryLabel(status))}</span><span>${notes.length} note${notes.length === 1 ? "" : "s"}</span>${job ? `<span>study ${sourceLibraryEsc(sourceLibraryLabel(job.cancel_requested === true && ["queued", "claimed"].includes(job.status) ? "cancellation_requested" : job.status))}</span>` : ""}</div>
      ${tags.length ? `<div class="psl-tags">${tags.map((tag) => `<span>${sourceLibraryEsc(tag)}</span>`).join("")}</div>` : ""}</article>`;
  }
  function sourceLibraryLaneHtml(intent, filtered) {
    const all = sourceLibraryState.assets.filter((asset) => sourceLibraryNormalizeIntent(asset.intent) === intent);
    const visible = filtered.filter((asset) => sourceLibraryNormalizeIntent(asset.intent) === intent);
    return `<section class="psl-lane" data-lane="${intent}"><header><div><span>${sourceLibraryEsc(sourceLibraryLabel(intent))}</span><b>${all.length}</b></div>
      <small>${intent === "research" ? "Study and annotate" : intent === "content_later" ? "Edit or post later" : intent === "archive" ? "Retained, out of active work" : "Classify when ready"}</small></header>
      <div class="psl-card-grid">${visible.map(sourceLibraryCardHtml).join("") || '<div class="psl-empty compact"><span>No matching private sources.</span></div>'}</div></section>`;
  }
  function sourceLibraryRenderStats() {
    const root = document.getElementById("sourceLibraryStats");
    if (!root) return;
    const count = (intent) => sourceLibraryState.assets.filter((asset) => sourceLibraryNormalizeIntent(asset.intent) === intent).length;
    const studying = sourceLibraryState.jobs.filter((job) => ["queued", "claimed"].includes(job.status)).length;
    root.innerHTML = `<div><b>${sourceLibraryState.assets.length.toLocaleString()}</b><span>loaded sources</span></div><div><b>${count("research").toLocaleString()}</b><span>research</span></div>
      <div><b>${count("content_later").toLocaleString()}</b><span>content later</span></div><div><b>${studying.toLocaleString()}</b><span>study jobs active</span></div>`;
  }
  function sourceLibraryHydrateThumbnail(image) {
    const assetId = image?.dataset?.sourceLibraryThumb;
    if (!SOURCE_LIBRARY_UUID.test(String(assetId || "")) || image.dataset.loading === "true") return;
    image.dataset.loading = "true";
    const snapshot = sourceLibrarySnapshot();
    sourceLibraryPreviewUrl(assetId).then((url) => {
      if (!sourceLibrarySnapshotCurrent(snapshot) || !image.isConnected) return;
      image.src = url; image.hidden = false; image.closest(".psl-thumb")?.classList.add("ready");
    }).catch((error) => {
      if (error?.name === "AbortError" || !image.isConnected) return;
      const loading = image.closest(".psl-thumb")?.querySelector(".psl-thumb-loading");
      if (loading) loading.textContent = "Preview unavailable";
    }).finally(() => { if (image.isConnected) image.dataset.loading = "false"; });
  }
  function sourceLibraryObserveThumbnails() {
    sourceLibraryState.observer?.disconnect();
    const images = [...document.querySelectorAll("[data-source-library-thumb]")];
    if (!("IntersectionObserver" in window)) { images.forEach(sourceLibraryHydrateThumbnail); return; }
    sourceLibraryState.observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        sourceLibraryState.observer?.unobserve(entry.target); sourceLibraryHydrateThumbnail(entry.target);
      }
    }, { rootMargin: "240px" });
    images.forEach((image) => sourceLibraryState.observer.observe(image));
  }
  function sourceLibraryRenderGrid() {
    const root = document.getElementById("sourceLibraryGrid");
    if (!root) return;
    if (sourceLibraryState.loading && !sourceLibraryState.assets.length) {
      root.innerHTML = '<div class="psl-empty"><b>Opening the private source library…</b><span>No public media URLs or storage paths are loaded.</span></div>'; return;
    }
    if (sourceLibraryState.error && !sourceLibraryState.assets.length) {
      root.innerHTML = `<div class="psl-error" role="alert"><b>Private library unavailable</b><span>${sourceLibraryEsc(sourceLibraryState.error)}</span><button type="button" onclick="sourceLibraryLoad(true)">Try again</button></div>`; return;
    }
    const filtered = sourceLibraryFilterAssets();
    const intents = sourceLibraryState.filterIntent === "all" ? SOURCE_LIBRARY_INTENTS : [sourceLibraryState.filterIntent];
    root.innerHTML = `${sourceLibraryState.error ? `<div class="psl-error inline" role="alert">${sourceLibraryEsc(sourceLibraryState.error)}</div>` : ""}
      <div class="psl-lanes">${intents.map((intent) => sourceLibraryLaneHtml(intent, filtered)).join("")}</div>
      ${sourceLibraryState.done ? "" : `<button class="psl-secondary psl-load-more" type="button" onclick="sourceLibraryLoad(false)" ${sourceLibraryState.loadingMore ? "disabled" : ""}>${sourceLibraryState.loadingMore ? "Loading…" : "Load more private sources"}</button>`}`;
    sourceLibraryObserveThumbnails();
  }
  function sourceLibrarySetFilter(kind, value) {
    if (kind === "intent") sourceLibraryState.filterIntent = value === "all" ? "all" : sourceLibraryNormalizeIntent(value);
    if (kind === "status") sourceLibraryState.filterStatus = String(value || "all");
    if (kind === "search") sourceLibraryState.filterSearch = String(value || "").slice(0, 120);
    document.querySelectorAll("[data-source-library-intent]").forEach((button) => {
      button.classList.toggle("on", button.dataset.sourceLibraryIntent === sourceLibraryState.filterIntent);
      button.setAttribute("aria-pressed", String(button.dataset.sourceLibraryIntent === sourceLibraryState.filterIntent));
    });
    sourceLibraryRenderGrid();
  }
  function sourceLibraryDropSetup() {
    const drop = document.getElementById("sourceLibraryDrop");
    if (!drop) return;
    for (const eventName of ["dragenter", "dragover"]) drop.addEventListener(eventName, (event) => {
      event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = "copy"; drop.classList.add("dragging");
    });
    for (const eventName of ["dragleave", "drop"]) drop.addEventListener(eventName, (event) => { event.preventDefault(); drop.classList.remove("dragging"); });
    drop.addEventListener("drop", (event) => sourceLibraryAddFiles(event.dataTransfer?.files, "drop"));
  }

  function sourceLibraryRenderShell(persona) {
    app.innerHTML = `<div class="psl-shell">
      <header class="psl-top"><div><span class="psl-eyebrow">Private owner workspace</span><h1>Persona Source Library</h1>
        <p>Offload screenshots and everyday photos for ${sourceLibraryEsc(persona.name)} to study, classify, or prepare as content later.</p></div>
        <label class="psl-persona-picker"><span>Library for</span><select onchange="openPersonaSourceLibrary(this.value)">${myPersonas.map((row) => `<option value="${row.id}" ${row.id === persona.id ? "selected" : ""}>${sourceLibraryEsc(row.name)} · @${sourceLibraryEsc(row.handle)}</option>`).join("")}</select></label></header>
      <div class="psl-private-notice"><b>Managed private cloud · first release</b><span>Originals are owner-only and never become profile media, AI training data, or published posts from this screen. Hosted study requires the consent switch below. Public use remains a separate review and media-intake step.</span></div>
      <div id="sourceLibraryStats" class="psl-stats"></div>
      <section class="psl-intake"><div class="psl-section-head"><div><span class="psl-eyebrow">Private intake</span><h2>Drop the whole camera-roll batch</h2><p>Choose a lane and provenance controls once, then stage up to ${SOURCE_LIBRARY_MAX_FILES} images.</p></div></div>
        <div class="psl-intake-grid"><div id="sourceLibraryDrop" class="psl-drop" tabindex="0" role="button" onclick="document.getElementById('sourceLibraryFiles').click()" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();document.getElementById('sourceLibraryFiles').click()}">
          <span class="psl-drop-icon" aria-hidden="true">⇧</span><b>Choose, drop, or paste images</b><span>PNG, JPEG, or WebP · 10 MB each</span>
          <div class="psl-drop-actions"><label class="psl-primary" onclick="event.stopPropagation()">Choose images<input id="sourceLibraryFiles" hidden type="file" accept="image/png,image/jpeg,image/webp" multiple onchange="sourceLibraryFilesChosen(this,'picker')"></label>
            <label class="psl-secondary" onclick="event.stopPropagation()">Use camera<input id="sourceLibraryCamera" hidden type="file" accept="image/jpeg,image/png,image/webp" capture="environment" onchange="sourceLibraryFilesChosen(this,'camera')"></label></div></div>
          <div class="psl-intake-options"><label><span>Put in lane</span><select id="sourceLibraryIntent"><option value="unsorted">Unsorted</option><option value="research">Research</option><option value="content_later">Content later</option><option value="archive">Archive</option></select></label>
            <label><span>Was AI used?</span><select id="sourceLibraryAiUse"><option value="unknown">Unknown</option><option value="none">No AI used</option><option value="assisted">AI assisted</option><option value="generated">AI generated</option></select></label>
            <label><span>Rights</span><select id="sourceLibraryRights"><option value="unknown">Unknown</option><option value="owner_created">I created it</option><option value="licensed">Licensed for my use</option><option value="reference_only">Reference only</option></select></label>
            <label><span>Reuse policy</span><select id="sourceLibraryReuse"><option value="reference_only">Reference only</option><option value="derivative_allowed">Derivatives allowed</option><option value="publish_allowed">May publish after review</option></select></label>
            <label><span>Sensitivity</span><select id="sourceLibrarySensitivity"><option value="standard">Standard</option><option value="sensitive">Sensitive</option><option value="restricted">Restricted</option></select></label>
            <label class="psl-tags-field"><span>Owner tags (comma separated)</span><input id="sourceLibraryTags" maxlength="980" placeholder="meal, pasta, weeknight dinner, plating reference"></label>
            <label class="psl-consent"><input id="sourceLibraryAnalysisConsent" type="checkbox"><span><b>Allow hosted AI study for this batch</b><small>Off means the files can be stored and manually noted, but no hosted model may receive a study derivative.</small></span></label></div></div>
        <div id="sourceLibraryQueue" class="psl-queue"></div></section>
      <section class="psl-library"><div class="psl-section-head psl-library-head"><div><span class="psl-eyebrow">Private collection</span><h2>Working lanes</h2></div>
        <div class="psl-filters"><label><span class="sr-only">Search sources</span><input type="search" maxlength="120" placeholder="Search title, note, or tag" oninput="sourceLibrarySetFilter('search',this.value)"></label>
          <label><span class="sr-only">Filter study status</span><select onchange="sourceLibrarySetFilter('status',this.value)"><option value="all">All statuses</option><option value="ready">Ready</option><option value="queued">Study queued</option><option value="claimed">Study claimed</option><option value="cancellation_requested">Cancellation requested</option><option value="review_required">Review required</option><option value="analysis_failed">Failed</option><option value="archived">Archived</option></select></label></div></div>
        <div class="psl-lane-tabs" role="group" aria-label="Source lanes">${["all", ...SOURCE_LIBRARY_INTENTS].map((intent) => `<button type="button" data-source-library-intent="${intent}" aria-pressed="${intent === "all"}" class="${intent === "all" ? "on" : ""}" onclick="sourceLibrarySetFilter('intent','${intent}')">${sourceLibraryEsc(sourceLibraryLabel(intent))}</button>`).join("")}</div>
        <div id="sourceLibraryGrid"></div></section></div>`;
    sourceLibraryRenderStats(); sourceLibraryRenderQueue(); sourceLibraryRenderGrid(); sourceLibraryDropSetup();
  }
  function openPersonaSourceLibrary(personaId = "") {
    const preferred = String(personaId || (typeof ownerAppPersona === "function" ? ownerAppPersona()?.id : "") || myPersonas?.[0]?.id || "");
    if (!sourceLibraryValidPersona(preferred)) {
      sourceLibraryToast("Create or select an owned persona first.");
      if (!myPersonas?.length && typeof go === "function") go("edit/new");
      return;
    }
    if (typeof go === "function") go(`library/${preferred}`);
  }
  function renderPersonaSourceLibrary(personaId = "") {
    if (!session) { renderSignin(); return; }
    const preferred = String(personaId || (typeof ownerAppPersona === "function" ? ownerAppPersona()?.id : "") || myPersonas?.[0]?.id || "");
    const persona = myPersonas.find((row) => row.id === preferred);
    if (!persona) {
      app.innerHTML = '<div class="psl-empty"><b>No owned persona selected</b><span>Create a persona before adding private sources.</span><button class="psl-primary" onclick="go(\'edit/new\')">Create persona</button></div>'; return;
    }
    const canonical = `#/library/${encodeURIComponent(persona.id)}`;
    if (location.hash !== canonical) history.replaceState({}, "", canonical);
    sourceLibraryReset();
    sourceLibraryState.ownerId = session.user.id; sourceLibraryState.personaId = persona.id; sourceLibraryState.routeGeneration += 1;
    sourceLibraryRenderShell(persona); sourceLibraryLoad(true);
  }

  function sourceLibraryNoteHtml(note) {
    const ai = note.author_kind === "ai", suggested = ai && note.review_state === "suggested";
    return `<article class="psl-note ${ai ? "ai" : "owner"} ${sourceLibraryEsc(note.review_state || "")}"><div><b>${ai ? "AI suggestion" : "Owner note"}</b><span>${sourceLibraryEsc(sourceLibraryLabel(note.note_kind))} · ${sourceLibraryEsc(sourceLibraryLabel(note.review_state || "accepted"))}</span></div>
      <p>${sourceLibraryEsc(note.body || "")}</p>${ai && (note.provider_label || note.model_label) ? `<small>${sourceLibraryEsc([note.provider_label, note.model_label].filter(Boolean).join(" · "))}</small>` : ""}
      ${suggested ? `<div class="psl-note-actions"><button class="psl-primary" onclick="sourceLibraryReviewNote('${note.id}','accepted')">Accept for persona context</button><button class="psl-secondary" onclick="sourceLibraryReviewNote('${note.id}','rejected')">Reject</button></div>` : ""}</article>`;
  }
  function sourceLibraryDetailHtml(asset) {
    const notes = sourceLibraryAssetNotes(asset.id), job = sourceLibraryAssetJob(asset.id);
    const activeJob = job && ["queued", "claimed"].includes(job.status);
    const studyStatus = activeJob && job.cancel_requested === true ? "cancellation_requested" : (job?.status || "not queued");
    const tags = Array.isArray(asset.owner_tags) ? asset.owner_tags : [];
    return `<div class="psl-modal-dialog" role="dialog" aria-modal="true" aria-labelledby="personaSourceLibraryTitle" tabindex="-1">
      <header><div><span class="psl-eyebrow">Private source</span><h2 id="personaSourceLibraryTitle">${sourceLibraryEsc(asset.title || asset.original_filename || "Untitled source")}</h2></div><button class="psl-close" type="button" onclick="sourceLibraryCloseDetail()" aria-label="Close source detail">×</button></header>
      <div class="psl-detail-grid"><section class="psl-detail-preview"><div class="psl-detail-stage"><span>Loading authenticated original…</span><img hidden alt="${sourceLibraryEsc(asset.title || "Private source image")}" data-source-library-detail="${asset.id}"></div>
        <button class="psl-primary" type="button" onclick="sourceLibraryDownloadOriginal('${asset.id}')">Save original</button><p>Download is authenticated and no-store. This screen never exposes the storage location or integrity hash.</p></section>
        <section class="psl-detail-meta"><div class="psl-detail-facts"><span><b>Type</b>${sourceLibraryEsc(asset.mime_type || "image")}</span><span><b>Size</b>${sourceLibraryEsc(sourceLibraryFormatBytes(asset.byte_size))}</span>
          <span><b>AI use</b>${sourceLibraryEsc(sourceLibraryLabel(asset.ai_use || "unknown"))}</span><span><b>Rights</b>${sourceLibraryEsc(sourceLibraryLabel(asset.rights_basis || "unknown"))}</span>
          <span><b>Dimensions</b>${Number(asset.pixel_width) > 0 && Number(asset.pixel_height) > 0 ? `${Number(asset.pixel_width).toLocaleString()} × ${Number(asset.pixel_height).toLocaleString()}` : "Not recorded"}</span>
          <span><b>Added</b>${sourceLibraryEsc(sourceLibraryFormatDate(asset.created_at))}</span><span><b>Study</b>${sourceLibraryEsc(sourceLibraryLabel(studyStatus))}</span></div>
          <label><span>Title</span><input id="sourceLibraryEditTitle" maxlength="160" value="${sourceLibraryEsc(asset.title || "")}" placeholder="Private working title"></label>
          <label><span>Owner notes</span><textarea id="sourceLibraryEditOwnerNotes" maxlength="4000" placeholder="Why this matters, what to remember, or how it might be used">${sourceLibraryEsc(asset.owner_notes || "")}</textarea></label>
          <label><span>Owner tags (up to 20)</span><input id="sourceLibraryEditTags" maxlength="980" value="${sourceLibraryEsc(tags.join(", "))}" placeholder="meal, pasta, plating reference"></label>
          <div class="psl-detail-fields"><label><span>Lane</span><select id="sourceLibraryEditIntent">${SOURCE_LIBRARY_INTENTS.map((value) => `<option value="${value}" ${sourceLibraryNormalizeIntent(asset.intent) === value ? "selected" : ""}>${sourceLibraryEsc(sourceLibraryLabel(value))}</option>`).join("")}</select></label>
            <label><span>Reuse policy</span><select id="sourceLibraryEditReuse">${SOURCE_LIBRARY_REUSE.map((value) => `<option value="${value}" ${sourceLibraryNormalizeReuse(asset.reuse_policy) === value ? "selected" : ""}>${sourceLibraryEsc(sourceLibraryLabel(value))}</option>`).join("")}</select></label>
            <label><span>Sensitivity</span><select id="sourceLibraryEditSensitivity">${SOURCE_LIBRARY_SENSITIVITY.map((value) => `<option value="${value}" ${sourceLibraryNormalizeSensitivity(asset.sensitivity) === value ? "selected" : ""}>${sourceLibraryEsc(sourceLibraryLabel(value))}</option>`).join("")}</select></label></div>
          <label class="psl-consent"><input id="sourceLibraryEditConsent" type="checkbox" ${asset.hosted_analysis_consent === true ? "checked" : ""}><span><b>Allow hosted AI study</b><small>Changing this does not queue a job by itself.</small></span></label>
          ${tags.length ? `<div class="psl-tags">${tags.map((tag) => `<span>${sourceLibraryEsc(tag)}</span>`).join("")}</div>` : ""}
          <div class="psl-detail-actions"><button class="psl-primary" type="button" onclick="sourceLibrarySaveMetadata('${asset.id}')">Save metadata</button>
            ${activeJob ? `<button class="psl-secondary" type="button" onclick="sourceLibraryCancelStudy('${asset.id}')" ${job.cancel_requested ? "disabled" : ""}>${job.cancel_requested ? "Cancellation requested" : "Cancel study"}</button>` : `<button class="psl-secondary" type="button" onclick="sourceLibraryQueueStudy('${asset.id}')" ${asset.hosted_analysis_consent === true ? "" : "disabled"}>Queue persona study</button>`}
            <button class="psl-secondary" type="button" onclick="sourceLibraryArchive('${asset.id}')" ${activeJob ? "disabled title=\"Cancel the active study before archiving\"" : ""}>${sourceLibraryNormalizeIntent(asset.intent) === "archive" || asset.lifecycle_state === "archived" ? "Move to unsorted" : "Archive"}</button><button class="psl-danger" type="button" onclick="sourceLibraryDelete('${asset.id}')">Delete private source</button></div>
          <div class="psl-study-truth"><b>${activeJob ? `Study ${sourceLibraryEsc(sourceLibraryLabel(studyStatus))}` : "No active study job"}</b><span>${activeJob && job.cancel_requested === true ? "Cancellation has been requested, but the job remains active until a real worker records it as cancelled. " : ""}MyPersonas only shows analysis after a real worker writes a reviewable note. Queuing never publishes this image or silently adds a suggestion to persona memory.</span></div></section></div>
      <section class="psl-notes"><div class="psl-section-head"><div><h3>Notes and study suggestions</h3><p>AI notes remain suggestions until you accept them.</p></div></div>
        <div class="psl-note-list">${notes.map(sourceLibraryNoteHtml).join("") || '<div class="psl-empty compact"><span>No notes yet.</span></div>'}</div>
        <div class="psl-note-compose"><select id="sourceLibraryNoteKind">${SOURCE_LIBRARY_NOTE_KINDS.map((kind) => `<option value="${kind}">${sourceLibraryEsc(sourceLibraryLabel(kind))}</option>`).join("")}</select>
          <textarea id="sourceLibraryNoteBody" maxlength="4000" placeholder="Add a private observation, research note, content idea, visual reference, or warning"></textarea><button class="psl-primary" type="button" onclick="sourceLibraryAddNote('${asset.id}')">Add owner note</button></div></section>
      <footer><span>Promoting this source to public content is intentionally outside this private library and still requires publication review.</span><button class="psl-secondary" type="button" onclick="sourceLibraryCloseDetail()">Close</button></footer></div>`;
  }
  function sourceLibraryModalKeydown(event) {
    if (event.key === "Escape") { event.preventDefault(); sourceLibraryCloseDetail(); return; }
    if (event.key !== "Tab") return;
    const dialog = event.currentTarget.querySelector(".psl-modal-dialog");
    const focusable = [...dialog.querySelectorAll('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])')];
    if (!focusable.length) { event.preventDefault(); dialog.focus(); return; }
    const first = focusable[0], last = focusable[focusable.length - 1];
    if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }
  function sourceLibraryRenderDetail(assetId) {
    const modal = document.getElementById("personaSourceLibraryModal"), asset = sourceLibraryAsset(assetId);
    if (!modal || !asset) return;
    modal.innerHTML = sourceLibraryDetailHtml(asset);
    const image = modal.querySelector("[data-source-library-detail]"), snapshot = sourceLibrarySnapshot();
    sourceLibraryPreviewUrl(assetId).then((url) => {
      if (!sourceLibrarySnapshotCurrent(snapshot) || !image?.isConnected || sourceLibraryState.modalAssetId !== assetId) return;
      image.src = url; image.hidden = false; image.closest(".psl-detail-stage")?.classList.add("ready");
    }).catch((error) => {
      if (error?.name === "AbortError" || !image?.isConnected) return;
      const status = image.closest(".psl-detail-stage")?.querySelector("span");
      if (status) status.textContent = "Authenticated preview unavailable. Saving the original may still work.";
    });
  }
  function sourceLibraryOpenDetail(assetId) {
    sourceLibraryRequireContext();
    const asset = sourceLibraryAsset(assetId);
    if (!asset) { sourceLibraryToast("That private source is no longer loaded."); return; }
    sourceLibraryCloseDetail(false);
    const modal = document.createElement("div");
    modal.id = "personaSourceLibraryModal"; modal.className = "psl-modal";
    modal.addEventListener("click", (event) => { if (event.target === modal) sourceLibraryCloseDetail(); });
    modal.addEventListener("keydown", sourceLibraryModalKeydown);
    document.body.appendChild(modal); sourceLibraryState.modalAssetId = assetId; sourceLibraryRenderDetail(assetId);
    if (typeof activateOwnerModal === "function") activateOwnerModal(modal); else setTimeout(() => modal.querySelector(".psl-close")?.focus(), 0);
  }
  async function sourceLibraryRpc(name, args, snapshot = sourceLibraryRequireContext()) {
    const controller = sourceLibraryTrackController();
    try {
      let request = sb.rpc(name, args);
      if (typeof request.abortSignal === "function") request = request.abortSignal(controller.signal);
      const result = await request;
      if (!sourceLibrarySnapshotCurrent(snapshot)) throw new DOMException("Account changed", "AbortError");
      if (result.error) throw result.error;
      return result.data;
    } finally { sourceLibraryReleaseController(controller); }
  }
  async function sourceLibrarySaveMetadata(assetId) {
    const asset = sourceLibraryAsset(assetId);
    if (!asset) return;
    const snapshot = sourceLibraryRequireContext();
    try {
      await sourceLibraryRpc("update_persona_source_asset", {
        p_asset_id: assetId,
        p_patch: {
          intent: sourceLibraryNormalizeIntent(document.getElementById("sourceLibraryEditIntent")?.value),
          title: String(document.getElementById("sourceLibraryEditTitle")?.value || "").trim().slice(0, 160),
          owner_notes: String(document.getElementById("sourceLibraryEditOwnerNotes")?.value || "").trim().slice(0, 4000),
          owner_tags: sourceLibraryParseTags(document.getElementById("sourceLibraryEditTags")?.value),
          reuse_policy: sourceLibraryNormalizeReuse(document.getElementById("sourceLibraryEditReuse")?.value),
          sensitivity: sourceLibraryNormalizeSensitivity(document.getElementById("sourceLibraryEditSensitivity")?.value),
          hosted_analysis_consent: document.getElementById("sourceLibraryEditConsent")?.checked === true,
        },
      }, snapshot);
      sourceLibraryToast("Private source metadata saved."); await sourceLibraryLoad(true);
    } catch (error) { if (error?.name !== "AbortError") sourceLibraryToast(error?.message || "Metadata could not be saved."); }
  }
  async function sourceLibraryAddNote(assetId) {
    const body = String(document.getElementById("sourceLibraryNoteBody")?.value || "").trim();
    if (!body) { sourceLibraryToast("Write a note first."); return; }
    const snapshot = sourceLibraryRequireContext();
    try {
      await sourceLibraryRpc("add_persona_source_note", { p_asset_id: assetId, p_note_kind: sourceLibraryNormalizeNoteKind(document.getElementById("sourceLibraryNoteKind")?.value), p_body: body.slice(0, 4000) }, snapshot);
      sourceLibraryToast("Private owner note added."); await sourceLibraryLoad(true);
    } catch (error) { if (error?.name !== "AbortError") sourceLibraryToast(error?.message || "The note could not be added."); }
  }
  async function sourceLibraryReviewNote(noteId, decision) {
    if (!SOURCE_LIBRARY_UUID.test(String(noteId || "")) || !["accepted", "rejected"].includes(decision)) return;
    const snapshot = sourceLibraryRequireContext();
    try {
      await sourceLibraryRpc("review_persona_source_note", { p_note_id: noteId, p_review_state: decision }, snapshot);
      sourceLibraryToast(decision === "accepted" ? "Suggestion accepted for persona context." : "Suggestion rejected."); await sourceLibraryLoad(true);
    } catch (error) { if (error?.name !== "AbortError") sourceLibraryToast(error?.message || "The suggestion could not be reviewed."); }
  }
  async function sourceLibraryQueueStudy(assetId) {
    const asset = sourceLibraryAsset(assetId);
    if (!asset?.hosted_analysis_consent) { sourceLibraryToast("Save hosted AI study consent before queuing this source."); return; }
    const snapshot = sourceLibraryRequireContext();
    try {
      await sourceLibraryRpc("queue_persona_source_study", { p_asset_id: assetId, p_execution_mode: "hosted" }, snapshot);
      sourceLibraryToast("A real persona study job was queued for owner review."); await sourceLibraryLoad(true);
    } catch (error) { if (error?.name !== "AbortError") sourceLibraryToast(error?.message || "The study job could not be queued."); }
  }
  async function sourceLibraryCancelStudy(assetId) {
    const snapshot = sourceLibraryRequireContext();
    try {
      await sourceLibraryRpc("cancel_persona_source_study", { p_asset_id: assetId }, snapshot);
      sourceLibraryToast("Study cancellation requested."); await sourceLibraryLoad(true);
    } catch (error) { if (error?.name !== "AbortError") sourceLibraryToast(error?.message || "The study job could not be cancelled."); }
  }
  async function sourceLibraryArchive(assetId) {
    const asset = sourceLibraryAsset(assetId);
    if (!asset) return;
    const snapshot = sourceLibraryRequireContext();
    try {
      await sourceLibraryRpc("update_persona_source_asset", {
        p_asset_id: assetId,
        p_patch: sourceLibraryNormalizeIntent(asset.intent) === "archive" || asset.lifecycle_state === "archived"
          ? { archived: false, intent: "unsorted" }
          : { archived: true, intent: "archive" },
      }, snapshot);
      sourceLibraryToast(sourceLibraryNormalizeIntent(asset.intent) === "archive" || asset.lifecycle_state === "archived" ? "Moved to Unsorted." : "Private source archived."); await sourceLibraryLoad(true);
    } catch (error) { if (error?.name !== "AbortError") sourceLibraryToast(error?.message || "The source could not be archived."); }
  }
  async function sourceLibraryDelete(assetId) {
    const asset = sourceLibraryAsset(assetId);
    if (!asset || !confirm(`Permanently delete “${asset.title || asset.original_filename || "this private source"}” and its notes? This cannot be undone.`)) return;
    if (typeof requireAal2ForSensitiveAction === "function" && !await requireAal2ForSensitiveAction("delete this private persona source")) return;
    const snapshot = sourceLibraryRequireContext();
    try {
      await sourceLibraryJsonRequest("delete", { assetId }, snapshot);
      sourceLibraryCloseDetail(); sourceLibraryRevokePreview(assetId);
      sourceLibraryState.assets = sourceLibraryState.assets.filter((row) => row.id !== assetId);
      sourceLibraryState.notes = sourceLibraryState.notes.filter((row) => row.asset_id !== assetId);
      sourceLibraryState.jobs = sourceLibraryState.jobs.filter((row) => row.asset_id !== assetId);
      sourceLibraryRenderStats(); sourceLibraryRenderGrid(); sourceLibraryToast("Private source and its retained notes were deleted.");
    } catch (error) { if (error?.name !== "AbortError") sourceLibraryToast(error?.message || "The private source could not be deleted."); }
  }
  async function sourceLibraryDownloadOriginal(assetId) {
    const asset = sourceLibraryAsset(assetId);
    if (!asset) return;
    const snapshot = sourceLibraryRequireContext();
    try {
      const blob = await sourceLibraryBlobRequest("download", assetId, SOURCE_LIBRARY_MAX_FILE_BYTES);
      if (!sourceLibrarySnapshotCurrent(snapshot)) return;
      const url = URL.createObjectURL(blob), link = document.createElement("a");
      link.href = url; link.download = sourceLibrarySafeFilename(asset, blob.type); link.rel = "noopener";
      document.body.appendChild(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 0);
      sourceLibraryToast("Private original downloaded.");
    } catch (error) { if (error?.name !== "AbortError") sourceLibraryToast(error?.message || "The private original could not be downloaded."); }
  }

  async function sourceLibraryDeleteForPersona(personaId) {
    if (!sourceLibraryValidPersona(personaId) || !session?.user?.id) throw new Error("Owned persona not found.");
    const ownerId = session.user.id;
    const generation = typeof authLoadGeneration === "number" ? authLoadGeneration : -1;
    const controller = sourceLibraryTrackController();
    try {
      const current = await sb.auth.getSession();
      const fresh = current.data?.session;
      if (current.error || !fresh?.access_token || fresh.user?.id !== ownerId ||
          session?.user?.id !== ownerId ||
          (typeof authLoadGeneration === "number" && authLoadGeneration !== generation)) {
        throw new Error("The signed-in account changed. Nothing was deleted.");
      }
      const response = await fetch(sourceLibraryEndpoint(), {
        method: "POST",
        headers: { Authorization: `Bearer ${fresh.access_token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ action: "deletePersonaLibrary", personaId }),
        credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store", signal: controller.signal,
      });
      const result = await response.json().catch(() => ({}));
      if (session?.user?.id !== ownerId ||
          (typeof authLoadGeneration === "number" && authLoadGeneration !== generation)) {
        throw new DOMException("Account changed", "AbortError");
      }
      if (!response.ok || result?.deleted !== true || result?.personaId !== personaId) {
        throw new Error(result?.error?.message || result?.error || "Private persona sources could not be deleted.");
      }
      return result;
    } finally { sourceLibraryReleaseController(controller); }
  }

  document.addEventListener("paste", (event) => {
    const route = sourceLibraryRouteParts();
    if (route.view !== "library" || route.personaId !== sourceLibraryState.personaId) return;
    if (event.target?.closest?.("input,textarea,select,[contenteditable='true']")) return;
    const files = [...(event.clipboardData?.items || [])].filter((item) => item.kind === "file" && String(item.type || "").startsWith("image/"))
      .map((item) => item.getAsFile()).filter(Boolean);
    if (!files.length) return;
    event.preventDefault(); sourceLibraryAddFiles(files, "clipboard");
  });
  window.addEventListener("pagehide", () => { sourceLibraryAbortRequests(); sourceLibraryRevokeAllPreviews(); });
  Object.assign(window, {
    renderPersonaSourceLibrary, openPersonaSourceLibrary, sourceLibraryRouteChanged, sourceLibraryReset, sourceLibraryLoad,
    sourceLibrarySetFilter, sourceLibraryFilesChosen, sourceLibraryStartUploads, sourceLibraryRemoveQueueItem,
    sourceLibraryRetryUpload, sourceLibraryOpenDetail, sourceLibraryCloseDetail, sourceLibrarySaveMetadata,
    sourceLibraryAddNote, sourceLibraryReviewNote, sourceLibraryQueueStudy, sourceLibraryCancelStudy,
    sourceLibraryArchive, sourceLibraryDelete, sourceLibraryDownloadOriginal, sourceLibraryDeleteForPersona,
  });
  window.MyPersonasSourceLibrary = Object.freeze({
    normalizeIntent: sourceLibraryNormalizeIntent, normalizeAiUse: sourceLibraryNormalizeAiUse,
    normalizeRights: sourceLibraryNormalizeRights, normalizeReuse: sourceLibraryNormalizeReuse,
    normalizeSensitivity: sourceLibraryNormalizeSensitivity, parseTags: sourceLibraryParseTags, validateFile: sourceLibraryFileValidation,
    safeFilename: sourceLibrarySafeFilename,
    limits: Object.freeze({ maxFiles: SOURCE_LIBRARY_MAX_FILES, maxFileBytes: SOURCE_LIBRARY_MAX_FILE_BYTES, maxBlobBytes: SOURCE_LIBRARY_MAX_BLOB_BYTES, maxBlobUrls: SOURCE_LIBRARY_MAX_BLOB_URLS }),
  });
})();
