// gemini-image — AAL2-gated generation/editing with an owner's Vault key.
// Google requests always use the pinned native Gemini endpoint and model. A
// stored owner base URL, request provider, or request model can never redirect
// the credential or image bytes to another host.
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  loadMediaEnvironmentConfig,
  publicMediaIdFromRequestUrl,
} from "../_shared/public-media.ts";
import { requireAal2 } from "../_shared/aal2.ts";
import {
  GEMINI_IMAGE_MODEL,
  geminiGenerateContentUrl,
  isGoogleImageProvider,
  MAX_GEMINI_IMAGE_REQUEST_BYTES,
  parseGeminiBaseImage,
  pinnedGeminiImageModel,
} from "../_shared/gemini-image.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const MAX_PROVIDER_RESPONSE_BYTES = 32 * 1024 * 1024;
const MAX_GENERATED_SOURCE_BYTES = 5 * 1024 * 1024;
const IMAGE_BUDGET_RESERVATION_TOKENS = 32_768;
const MAX_PROMPT_CHARS = 5_000;
const MAX_KEY_CHARS = 32_768;
const GOOGLE_PROVIDERS = ["google", "google_legacy"];
const ALLOWED_ORIGINS = new Set([
  "https://aliaspaces.com",
  "https://www.aliaspaces.com",
  "https://app.aliaspaces.com",
  "https://mypersonas.online",
]);

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false,
  },
});

async function sha256Hex(bytes: Uint8Array) {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy.buffer);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

class BodyTooLargeError extends Error {}

function cors(origin: string) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

function json(body: unknown, status = 200, origin = "") {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: {
      ...(origin && ALLOWED_ORIGINS.has(origin) ? cors(origin) : {}),
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

async function readBoundedText(
  source: Request | Response,
  maxBytes: number,
  label: string,
) {
  const rawLength = source.headers.get("content-length");
  if (rawLength) {
    const declared = Number(rawLength);
    if (
      !Number.isSafeInteger(declared) || declared < 0 || declared > maxBytes
    ) {
      await source.body?.cancel().catch(() => undefined);
      throw new BodyTooLargeError(`${label} exceeded the safe limit`);
    }
  }
  if (!source.body) return "";
  const reader = source.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new BodyTooLargeError(`${label} exceeded the safe limit`);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function requestObject(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function requestBackendId(value: unknown) {
  if (value === undefined || value === null || value === "") return "";
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(value.trim())
  ) {
    throw new Error("A valid model connection id is required");
  }
  return value.trim();
}

async function ownerGoogleBackend(owner: string, backendId: string) {
  if (backendId) {
    const result = await admin.from("ai_backends").select("id,provider")
      .eq("owner", owner).eq("id", backendId).maybeSingle();
    if (result.error) throw new Error("Could not inspect the model connection");
    return result.data as { id: string; provider?: unknown } | null;
  }
  const result = await admin.from("ai_backends").select("id,provider")
    .eq("owner", owner).in("provider", GOOGLE_PROVIDERS)
    .order("created_at", { ascending: true }).limit(1).maybeSingle();
  if (result.error) throw new Error("Could not inspect Gemini connections");
  return result.data as { id: string; provider?: unknown } | null;
}

async function ownerBackendKey(backendId: string, owner: string) {
  const result = await admin.rpc("ai_backend_get_key", {
    p_backend_id: backendId,
    p_owner: owner,
  });
  if (
    result.error || typeof result.data !== "string" ||
    !result.data.trim() || result.data.length > MAX_KEY_CHARS
  ) {
    return "";
  }
  return result.data.trim();
}

serve(async (req: Request) => {
  const origin = req.headers.get("Origin") || "";
  if (req.method === "OPTIONS") return json(null, 204, origin);
  if (origin && !ALLOWED_ORIGINS.has(origin)) {
    return json({ error: "Origin not allowed" }, 403);
  }
  if (req.method !== "POST") return json({ error: "POST only" }, 405, origin);

  const guard = await requireAal2(req, admin);
  if (!guard.ok) {
    return json({ error: guard.error, code: guard.code }, guard.status, origin);
  }
  let mediaEnvironment;
  try {
    mediaEnvironment = await loadMediaEnvironmentConfig(admin, SUPABASE_URL);
  } catch {
    return json({ error: "Secure media delivery is unavailable" }, 503, origin);
  }

  let rawBody = "";
  try {
    rawBody = await readBoundedText(
      req,
      MAX_GEMINI_IMAGE_REQUEST_BYTES,
      "Request body",
    );
  } catch (error) {
    return error instanceof BodyTooLargeError
      ? json({ error: "Request body is too large" }, 413, origin)
      : json({ error: "Could not read the request body" }, 400, origin);
  }
  const body = requestObject(rawBody);
  if (!body) {
    return json({ error: "A JSON request body is required" }, 400, origin);
  }

  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt) return json({ error: "A prompt is required" }, 400, origin);
  if (prompt.length > MAX_PROMPT_CHARS) {
    return json({ error: "The prompt is too long" }, 400, origin);
  }
  const personaId = typeof body.personaId === "string"
    ? body.personaId.trim()
    : "";
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(personaId)
  ) {
    return json(
      { error: "An owned persona is required for generated-media provenance" },
      400,
      origin,
    );
  }
  const persona = await admin.from("personas").select("id")
    .eq("id", personaId).eq("owner", guard.user.id).maybeSingle();
  if (persona.error) {
    return json({ error: "Could not verify the persona" }, 500, origin);
  }
  if (!persona.data) {
    return json({ error: "Owned persona not found" }, 404, origin);
  }
  const target = typeof body.target === "string" ? body.target.trim().toLowerCase() : "";
  if (!["avatar_url", "banner_url", "bg_url", "feed_img_url"].includes(target)) {
    return json({ error: "A supported persona image target is required" }, 400, origin);
  }

  if (body.provider !== undefined && !isGoogleImageProvider(body.provider)) {
    return json(
      { error: "Only a Google Gemini backend is supported" },
      400,
      origin,
    );
  }
  let model = "";
  let backendId = "";
  let baseImage: ReturnType<typeof parseGeminiBaseImage> = null;
  try {
    model = pinnedGeminiImageModel(body.model);
    backendId = requestBackendId(body.backendId);
    baseImage = parseGeminiBaseImage(body.baseImage);
  } catch (error) {
    return json(
      { error: error instanceof Error ? error.message : "Invalid request" },
      400,
      origin,
    );
  }

  let backend: { id: string; provider?: unknown } | null = null;
  try {
    backend = await ownerGoogleBackend(guard.user.id, backendId);
  } catch {
    return json({ error: "Could not inspect Gemini connections" }, 500, origin);
  }
  if (!backend) {
    return json(
      {
        error: backendId
          ? "Owned model connection not found"
          : "No Gemini model is linked. Add one in Matrix → AI Models.",
      },
      400,
      origin,
    );
  }
  if (!isGoogleImageProvider(backend.provider)) {
    return json(
      { error: "That model connection is not a Google Gemini backend" },
      400,
      origin,
    );
  }

  const key = await ownerBackendKey(backend.id, guard.user.id);
  if (!key) {
    return json({ error: "Could not read the Gemini API key" }, 400, origin);
  }

  const parts: Array<Record<string, unknown>> = [{ text: prompt }];
  if (baseImage) {
    parts.push({
      inline_data: { mime_type: baseImage.mimeType, data: baseImage.data },
    });
  }

  const budgetClaim = await admin.rpc("claim_ai_backend_budget", {
    p_owner: guard.user.id,
    p_backend_id: backend.id,
    p_mode: "persona_builder",
    p_reserved_tokens: IMAGE_BUDGET_RESERVATION_TOKENS,
    p_request_key: crypto.randomUUID(),
  });
  const rawBudget = Array.isArray(budgetClaim.data) ? budgetClaim.data[0] : budgetClaim.data;
  const budgetRow = rawBudget && typeof rawBudget === "object" ? rawBudget as Record<string, unknown> : null;
  const budgetLeaseId = typeof budgetRow?.lease_id === "string" ? budgetRow.lease_id : null;
  if (budgetClaim.error || !budgetRow || budgetRow.allowed !== true) {
    const code = typeof budgetRow?.denial_code === "string" ? budgetRow.denial_code : "budget_claim_unavailable";
    return json({ error: code.includes("limit") || code.includes("concurrency") ? "This Gemini connection has reached its owner-configured budget ceiling" : "Gemini image generation is unavailable until its budget policy allows this request", code }, budgetClaim.error ? 503 : 429, origin);
  }
  let budgetFinalized = false;
  const finalizeBudget = async (outcome: "completed" | "provider_error" | "request_failed", actualTokens: number | null, code: string) => {
    if (!budgetLeaseId) return true;
    if (budgetFinalized) return false;
    budgetFinalized = true;
    const result = await admin.rpc("finalize_ai_backend_budget", {
      p_lease_id: budgetLeaseId,
      p_outcome: outcome,
      p_actual_tokens: actualTokens,
      p_provider_usage_reported: actualTokens !== null,
      p_outcome_code: code,
    });
    return !result.error && result.data === true;
  };

  let providerResponse: Response;
  try {
    providerResponse = await fetch(geminiGenerateContentUrl(model), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": key,
      },
      body: JSON.stringify({
        contents: [{ role: "user", parts }],
        generationConfig: { responseModalities: ["IMAGE"] },
      }),
      redirect: "error",
      signal: AbortSignal.timeout(90_000),
    });
  } catch {
    await finalizeBudget("provider_error", null, "gemini_image_unreachable");
    return json(
      { error: "Could not reach the pinned Gemini endpoint" },
      502,
      origin,
    );
  }

  let providerBody: Record<string, unknown> = {};
  try {
    const raw = await readBoundedText(
      providerResponse,
      MAX_PROVIDER_RESPONSE_BYTES,
      "Gemini response",
    );
    providerBody = requestObject(raw) || {};
  } catch {
    await finalizeBudget("provider_error", null, "gemini_image_invalid_response");
    return json(
      { error: "Gemini returned an invalid or oversized response" },
      502,
      origin,
    );
  }
  if (!providerResponse.ok) {
    await finalizeBudget("provider_error", null, `gemini_http_${providerResponse.status}`);
    const providerStatus =
      providerResponse.status >= 400 && providerResponse.status <= 599
        ? providerResponse.status
        : 502;
    return json(
      {
        error: `Gemini image request failed (HTTP ${providerResponse.status})`,
      },
      providerStatus,
      origin,
    );
  }

  const candidates = Array.isArray(providerBody.candidates)
    ? providerBody.candidates as Array<Record<string, unknown>>
    : [];
  const content = candidates[0]?.content as Record<string, unknown> | undefined;
  const outputParts = Array.isArray(content?.parts)
    ? content.parts as Array<Record<string, unknown>>
    : [];
  const imagePart = outputParts.find((part) => {
    const inline = (part.inlineData || part.inline_data) as
      | Record<string, unknown>
      | undefined;
    return typeof inline?.data === "string" && !!inline.data;
  });
  const inline = (imagePart?.inlineData || imagePart?.inline_data) as
    | Record<string, unknown>
    | undefined;
  const imageData = typeof inline?.data === "string" ? inline.data : "";
  const mime = typeof inline?.mimeType === "string"
    ? inline.mimeType
    : typeof inline?.mime_type === "string"
    ? inline.mime_type
    : "";
  if (!imageData || !["image/jpeg", "image/png", "image/webp"].includes(mime)) {
    await finalizeBudget("provider_error", null, "gemini_image_missing");
    return json(
      {
        error:
          `Gemini returned no supported image for ${GEMINI_IMAGE_MODEL}. Confirm that image generation is enabled for this key.`,
      },
      502,
      origin,
    );
  }
  let outputBytes: Uint8Array;
  try {
    const decoded = atob(imageData);
    outputBytes = Uint8Array.from(
      decoded,
      (character) => character.charCodeAt(0),
    );
  } catch {
    await finalizeBudget("provider_error", null, "gemini_image_invalid_bytes");
    return json({ error: "Gemini returned invalid image bytes" }, 502, origin);
  }
  if (outputBytes.byteLength < 1 || outputBytes.byteLength > MAX_GENERATED_SOURCE_BYTES) {
    await finalizeBudget("provider_error", null, "gemini_image_oversized");
    return json({ error: "Gemini returned an image too large for secure server watermarking" }, 502, origin);
  }
  const usage = providerBody.usageMetadata as Record<string, unknown> | undefined;
  const reportedTokens = Number(usage?.totalTokenCount ?? usage?.total_token_count);
  const actualTokens = Number.isSafeInteger(reportedTokens) && reportedTokens >= 0 ? reportedTokens : null;
  if (!await finalizeBudget("completed", actualTokens, actualTokens === null ? "gemini_image_usage_unreported" : "gemini_image_completed")) {
    return json({ error: "The image was generated but budget accounting could not be finalized" }, 503, origin);
  }
  const [outputSha256, promptSha256] = await Promise.all([
    sha256Hex(outputBytes),
    sha256Hex(new TextEncoder().encode(prompt)),
  ]);
  const generation = await admin.from("ai_media_generation_events").insert({
    owner: guard.user.id,
    persona_id: personaId,
    backend_id: backend.id,
    provider: "google",
    model,
    prompt_sha256: promptSha256,
    output_sha256: outputSha256,
    output_mime: mime,
  }).select("id,expires_at").single();
  if (generation.error || !generation.data) {
    return json(
      { error: "The image was generated but its server provenance event could not be recorded" },
      500,
      origin,
    );
  }
  const authorization = req.headers.get("Authorization") || "";
  const extension = mime === "image/jpeg" ? "jpg" : mime === "image/webp" ? "webp" : "png";
  const intakeForm = new FormData();
  const outputArrayBuffer = new ArrayBuffer(outputBytes.byteLength);
  new Uint8Array(outputArrayBuffer).set(outputBytes);
  intakeForm.append("file", new File([outputArrayBuffer], `generated-${target}.${extension}`, { type: mime }));
  intakeForm.append("personaId", personaId);
  intakeForm.append("aiUse", "generated");
  intakeForm.append("origin", "site_generated");
  intakeForm.append("purpose", `generation-preview/${target}/${generation.data.id}`);
  intakeForm.append("sourceSha256", outputSha256);
  intakeForm.append("generationEventId", generation.data.id);
  intakeForm.append("rendition", target);
  let intakeResponse: Response;
  let intake: Record<string, unknown> = {};
  try {
    intakeResponse = await fetch(`${SUPABASE_URL.replace(/\/$/, "")}/functions/v1/media-ingest`, {
      method: "POST",
      headers: { "Authorization": authorization },
      body: intakeForm,
      redirect: "error",
      signal: AbortSignal.timeout(45_000),
    });
    intake = requestObject(await readBoundedText(intakeResponse, 64 * 1024, "Media intake response")) || {};
  } catch (error) {
    return json({ error: "The image was generated but secure watermarking did not complete" }, 502, origin);
  }
  if (!intakeResponse.ok || typeof intake.publicUrl !== "string" ||
      !publicMediaIdFromRequestUrl(intake.publicUrl, mediaEnvironment.publicMediaOrigin) ||
      typeof intake.assetId !== "string") {
    return json({ error: typeof intake.error === "string" ? intake.error : "The image was generated but secure watermarking failed closed" }, 502, origin);
  }
  return json({
    publicUrl: intake.publicUrl,
    assetId: intake.assetId,
    mime: intake.mime,
    contentSha256: intake.sha256,
    sourceSha256: outputSha256,
    generationEventId: generation.data.id,
    watermarkState: intake.watermarkState,
    watermarkVersion: intake.watermarkVersion,
  }, 200, origin);
});
