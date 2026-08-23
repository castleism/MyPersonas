// agent-board-propose: authenticated, owner-scoped proposal intake.
// This endpoint can only add a bounded item to the human review queue. It
// never approves or executes a request.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const MAX_REQUEST_CHARS = 64_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TYPE_RE = /^[a-z0-9][a-z0-9_:-]{0,63}$/;
const ALLOWED_ORIGINS = new Set([
  "https://aliaspaces.com",
  "https://www.aliaspaces.com",
  "https://app.aliaspaces.com",
  "https://mypersonas.online",
]);

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function cors(origin: string) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
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
  return (req.headers.get("Authorization") ?? "")
    .match(/^Bearer\s+(\S+)$/i)?.[1] ?? "";
}

function text(value: unknown, max: number) {
  const result = typeof value === "string" ? value : String(value ?? "");
  return result.replaceAll("\0", "").trim().slice(0, max);
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("Origin") ?? "";
  if (req.method === "OPTIONS") {
    return ALLOWED_ORIGINS.has(origin)
      ? new Response(null, { status: 204, headers: cors(origin) })
      : new Response("Forbidden", { status: 403 });
  }
  if (req.method !== "POST") return json({ error: "POST only" }, 405, origin);
  if (origin && !ALLOWED_ORIGINS.has(origin)) {
    return json({ error: "Origin not allowed" }, 403);
  }

  const declaredLength = Number(req.headers.get("Content-Length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_CHARS) {
    return json({ error: "Request is too large" }, 413, origin);
  }
  const token = bearerToken(req);
  if (!token) return json({ error: "Missing bearer session" }, 401, origin);
  const { data: userData, error: userError } = await admin.auth.getUser(token);
  if (userError || !userData?.user) {
    return json({ error: "Invalid or expired session" }, 401, origin);
  }

  const rawBody = await req.text();
  if (rawBody.length > MAX_REQUEST_CHARS) {
    return json({ error: "Request is too large" }, 413, origin);
  }
  let body: Record<string, unknown>;
  try {
    const parsed = JSON.parse(rawBody);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("invalid object");
    }
    body = parsed as Record<string, unknown>;
  } catch {
    return json({ error: "A JSON object is required" }, 400, origin);
  }

  const sourcePersonaId = text(body.source_persona_id, 80);
  const targetPersonaId = text(body.target_persona_id, 80);
  const taskType = text(body.task_type || "review_draft", 64).toLowerCase();
  const instructions = text(body.instructions, 12_000);
  const subjectType = text(body.subject_type || "post_draft", 64).toLowerCase();
  const subjectId = body.subject_id ? text(body.subject_id, 80) : null;
  const riskLevel = text(body.risk_level || "low", 10).toLowerCase();
  const parentRequestId = body.parent_request_id
    ? text(body.parent_request_id, 80)
    : null;
  const targetBackendId = body.target_backend_id
    ? text(body.target_backend_id, 80)
    : null;
  const context = body.context ?? {};

  if (!UUID_RE.test(sourcePersonaId) || !UUID_RE.test(targetPersonaId) ||
    (subjectId && !UUID_RE.test(subjectId)) ||
    (parentRequestId && !UUID_RE.test(parentRequestId)) ||
    (targetBackendId && !UUID_RE.test(targetBackendId))) {
    return json({ error: "One or more identifiers are invalid" }, 400, origin);
  }
  if (!TYPE_RE.test(taskType) || !TYPE_RE.test(subjectType)) {
    return json({ error: "Task and subject types are invalid" }, 400, origin);
  }
  if (!["low", "medium", "high"].includes(riskLevel)) {
    return json({ error: "Risk level is invalid" }, 400, origin);
  }
  if (!context || typeof context !== "object" || Array.isArray(context) ||
    JSON.stringify(context).length > 20_000) {
    return json({ error: "Context must be an object no larger than 20,000 characters" }, 400, origin);
  }

  // Use the caller's JWT for the RPC. The previous service-client call erased
  // auth.uid(), which made the owner-only database function fail closed.
  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await userClient.rpc("propose_agent_board_request", {
    p_source_persona_id: sourcePersonaId,
    p_target_persona_id: targetPersonaId,
    p_task_type: taskType,
    p_instructions: instructions,
    p_subject_type: subjectType,
    p_subject_id: subjectId,
    p_context: context,
    p_risk_level: riskLevel,
    p_parent_request_id: parentRequestId,
    p_target_backend_id: targetBackendId,
  });

  if (error) {
    const message = error.message ?? "Failed to create proposal";
    const status = message.includes("not found") ? 404
      : message.includes("not enabled") || message.includes("does not belong") ? 403
      : message.includes("limit") ? 429
      : message.includes("required") || message.includes("Invalid") ||
          message.includes("invalid") || message.includes("too long") ? 422
      : 500;
    return json({ error: message }, status, origin);
  }

  return json({
    success: true,
    request_id: data,
    message: "Proposal created. Awaiting owner review.",
  }, 201, origin);
});
