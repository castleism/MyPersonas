// agent-board-propose: JWT-required endpoint for creating agent board proposals.
// This NEVER executes anything — it only creates proposals for owner review.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  // Extract JWT from Authorization header
  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "");

  if (!token) {
    return new Response(JSON.stringify({ error: "Authentication required" }), {
      status: 401,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  // Verify the JWT and get the user
  const { data: { user }, error: authError } = await admin.auth.getUser(token);
  if (authError || !user) {
    return new Response(JSON.stringify({ error: "Invalid or expired token" }), {
      status: 401,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  // Parse body
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  const sourcePersonaId = String(body.source_persona_id ?? "");
  const targetPersonaId = String(body.target_persona_id ?? "");
  const taskType = String(body.task_type ?? "review_draft");
  const instructions = String(body.instructions ?? "");
  const subjectType = String(body.subject_type ?? "post_draft");
  const subjectId = body.subject_id ? String(body.subject_id) : null;
  const riskLevel = String(body.risk_level ?? "low");
  const parentRequestId = body.parent_request_id ? String(body.parent_request_id) : null;
  const targetBackendId = body.target_backend_id ? String(body.target_backend_id) : null;
  const context = body.context ?? {};

  if (!sourcePersonaId || !targetPersonaId) {
    return new Response(JSON.stringify({ error: "source_persona_id and target_persona_id are required" }), {
      status: 400,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  // Call the RPC (runs as the authenticated user via RLS)
  const { data, error } = await admin.rpc("propose_agent_board_request", {
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
      : message.includes("not enabled") || message.includes("not belong") ? 403
      : message.includes("limit") ? 429
      : message.includes("required") || message.includes("Invalid") ? 422
      : 500;

    return new Response(JSON.stringify({ error: message }), {
      status,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  return new Response(JSON.stringify({
    success: true,
    request_id: data,
    message: "Proposal created. Awaiting owner review.",
  }), {
    status: 201,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
});
