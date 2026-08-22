// import-research-brief — authenticated manual import for owner-generated JSON.
// The bearer owner must own the target persona. No default persona/model UUIDs.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const ALLOWED_ORIGINS = new Set([
  "https://aliaspaces.com",
  "https://www.aliaspaces.com",
  "https://app.aliaspaces.com",
  "https://mypersonas.online",
]);
const MAX_REQUEST_CHARS = 250_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function cors(origin: string) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Cache-Control": "no-store",
    "Vary": "Origin",
  };
}
function json(body: unknown, status = 200, origin = "") {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...(origin && ALLOWED_ORIGINS.has(origin) ? cors(origin) : {}),
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}
function bearerToken(req: Request) {
  return (req.headers.get("Authorization") || "").match(/^Bearer\s+(.+)$/i)?.[1]?.trim() || "";
}
function safeText(value: unknown, max: number) {
  return (typeof value === "string" ? value : String(value ?? ""))
    .replaceAll("\0", "").trim().slice(0, max);
}
function extractObject(value: unknown) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  const text = safeText(value, 220_000);
  const candidates = [text, text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1], text.match(/\{[\s\S]*\}/)?.[0]];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      // Continue through bounded candidates.
    }
  }
  throw new Error("Could not parse the imported JSON object");
}
function safeUrls(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => safeText(item, 2_048)).filter((item) => {
    try {
      return new URL(item).protocol === "https:";
    } catch {
      return false;
    }
  }).slice(0, 8);
}
function findings(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 12).map((item) => {
    const row = item && typeof item === "object" ? item as Record<string, unknown> : {};
    const sourceType = safeText(row.source_type, 40);
    const postType = safeText(row.suggested_post_type, 20);
    return {
      title: safeText(row.title, 300) || "Untitled finding",
      summary: safeText(row.summary, 4_000),
      why_it_matters: safeText(row.why_it_matters, 4_000),
      novelty_score: Math.max(1, Math.min(10, Number(row.novelty_score) || 5)),
      relevance_score: Math.max(1, Math.min(10, Number(row.relevance_score) || 5)),
      source_urls: safeUrls(row.source_urls),
      source_type: ["research_paper", "news_article", "industry_report", "social_trend", "product_launch"].includes(sourceType) ? sourceType : "",
      needs_verification: row.needs_verification !== false,
      suggested_post_angle: safeText(row.suggested_post_angle, 2_000),
      suggested_post_type: ["new", "repost", "remix", "thread"].includes(postType) ? postType : "new",
    };
  }).filter((row) => row.summary);
}

Deno.serve(async (req) => {
  const origin = req.headers.get("Origin") || "";
  if (req.method === "OPTIONS") {
    return ALLOWED_ORIGINS.has(origin)
      ? new Response("ok", { headers: cors(origin) })
      : new Response("Forbidden", { status: 403 });
  }
  if (req.method !== "POST") return json({ error: "POST only" }, 405, origin);
  if (origin && !ALLOWED_ORIGINS.has(origin)) return json({ error: "Origin not allowed" }, 403);

  const token = bearerToken(req);
  if (!token) return json({ error: "Missing bearer session" }, 401, origin);
  const { data: userData, error: userError } = await admin.auth.getUser(token);
  if (userError || !userData?.user) return json({ error: "Invalid or expired session" }, 401, origin);
  const owner = userData.user.id;

  const rawBody = await req.text();
  if (rawBody.length > MAX_REQUEST_CHARS) return json({ error: "Request is too large" }, 413, origin);
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    return json({ error: "Invalid JSON request" }, 400, origin);
  }
  const personaId = safeText(payload.persona_id, 80);
  const backendId = safeText(payload.backend_id, 80);
  if (!UUID_RE.test(personaId) || (backendId && !UUID_RE.test(backendId))) {
    return json({ error: "A valid persona and optional model id are required" }, 400, origin);
  }

  try {
    const { data: persona, error: personaError } = await admin.from("personas")
      .select("id,owner,handle").eq("id", personaId).eq("owner", owner).maybeSingle();
    if (personaError) throw new Error("The persona could not be read");
    if (!persona) return json({ error: "Owned persona not found" }, 404, origin);

    let model = safeText(payload.model, 300) || "manual-import";
    let effectiveBackendId: string | null = null;
    if (backendId) {
      const { data: backend, error: backendError } = await admin.from("ai_backends")
        .select("id,owner,model").eq("id", backendId).eq("owner", owner).maybeSingle();
      if (backendError) throw new Error("The selected model could not be read");
      if (!backend) return json({ error: "The selected model is not owned by this account" }, 404, origin);
      effectiveBackendId = backend.id;
      model = safeText(backend.model, 300) || model;
    }

    const brief = extractObject(payload.brief_json);
    const normalizedFindings = findings(brief.findings);
    if (!normalizedFindings.length) {
      return json({ error: "The import needs at least one usable finding" }, 400, origin);
    }
    const briefDate = /^\d{4}-\d{2}-\d{2}$/.test(safeText(brief.brief_date, 10))
      ? safeText(brief.brief_date, 10)
      : new Date().toISOString().slice(0, 10);
    const sources = [...new Set(normalizedFindings.flatMap((finding) => finding.source_urls))]
      .map((url) => ({ url, verification: "owner_review_required" }));
    const { data: briefId, error: saveError } = await admin.rpc("save_research_brief", {
      p_persona_id: personaId,
      p_brief_date: briefDate,
      p_backend_id: effectiveBackendId,
      p_model: model,
      p_executive_summary: safeText(brief.executive_summary, 6_000),
      p_key_findings: normalizedFindings,
      p_sources: sources,
      p_raw_response: safeText(payload.brief_json, 220_000),
    });
    if (saveError) throw new Error("The imported briefing could not be saved");
    return json({
      success: true,
      brief_id: briefId,
      finding_count: normalizedFindings.length,
      verification_required: normalizedFindings.some((finding) => finding.needs_verification),
    }, 200, origin);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Brief import failed" }, 500, origin);
  }
});
