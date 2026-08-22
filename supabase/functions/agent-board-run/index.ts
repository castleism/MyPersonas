// agent-board-run: Service-role runner for approved agent board requests.
// Claims one approved request, calls the ai-proxy to execute it, writes the result.
//
// SAFETY: Only runs when target persona has execution_enabled = true.
// The owner must explicitly opt in per persona. This function does NOT
// run on a schedule — it must be called manually or via an owner-triggered action.
//
// This is a SKELETON — the actual AI call shape needs to match ai-proxy's
// expected request format. Deploying this as a guarded skeleton for Phase 7 activation.
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

  // Verify service role or authenticated user
  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "");

  if (!token) {
    return new Response(JSON.stringify({ error: "Authentication required" }), {
      status: 401,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  // Parse optional owner filter
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* empty body is fine */ }
  const ownerFilter = body.owner ? String(body.owner) : null;

  // Step 1: Claim the next approved request
  const { data: claimed, error: claimError } = await admin.rpc(
    "claim_next_approved_agent_request",
    { p_owner: ownerFilter }
  );

  if (claimError) {
    return new Response(JSON.stringify({ error: claimError.message }), {
      status: 500,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  if (!claimed || claimed.length === 0) {
    return new Response(JSON.stringify({
      success: true,
      message: "No approved requests to run.",
      executed: 0,
    }), {
      status: 200,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  const request = claimed[0];

  // Step 2: Resolve the backend to use
  let backendId = request.target_backend_id;
  if (!backendId) {
    // Use the persona's default backend
    const { data: persona, error: personaError } = await admin
      .from("personas")
      .select("ai_backend")
      .eq("id", request.target_persona_id)
      .single();

    if (personaError || !persona?.ai_backend) {
      await admin.rpc("complete_agent_board_run", {
        p_request_id: request.request_id,
        p_run_id: null,
        p_status: "failed",
        p_error: "No backend configured for target persona",
      });
      return new Response(JSON.stringify({ error: "No backend configured" }), {
        status: 400,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }
    backendId = persona.ai_backend;
  }

  // Step 3: Get backend configuration
  const { data: backend, error: backendError } = await admin
    .from("ai_backends")
    .select("id, name, base_url, model, provider_kind")
    .eq("id", backendId)
    .single();

  if (backendError || !backend) {
    return new Response(JSON.stringify({ error: "Backend not found" }), {
      status: 404,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  // Step 4: Get API key from vault
  const { data: cred } = await admin
    .from("ai_backend_credentials")
    .select("secret_id")
    .eq("backend_id", backendId)
    .single();

  let apiKey = "";
  if (cred?.secret_id) {
    const { data: secret } = await admin
      .from("vault.decrypted_secrets")
      .select("decrypted_secret")
      .eq("id", cred.secret_id)
      .single();
    apiKey = secret?.decrypted_secret ?? "";
  }

  if (!apiKey) {
    return new Response(JSON.stringify({ error: "No API key found in vault" }), {
      status: 500,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  // Step 5: Build the prompt from the request
  // Fetch subject content if it's a post draft
  let subjectContent = "";
  if (request.subject_id) {
    if (request.subject_type === "post_draft") {
      const { data: draft } = await admin
        .from("post_drafts")
        .select("brief, fb_caption, ig_caption, x_caption")
        .eq("id", request.subject_id)
        .single();
      if (draft) {
        subjectContent = JSON.stringify(draft);
      }
    }
  }

  // Fetch target persona's context log for persona-aware prompting
  const { data: targetPersona } = await admin
    .from("personas")
    .select("name, handle, context_log")
    .eq("id", request.target_persona_id)
    .single();

  const prompt = `You are ${targetPersona?.name ?? "an AI persona"} (@${targetPersona?.handle ?? "unknown"}).\n\n` +
    `Persona context: ${targetPersona?.context_log ?? "N/A"}\n\n` +
    `Task: ${request.task_type}\n` +
    `Instructions: ${request.instructions}\n` +
    (subjectContent ? `Subject content: ${subjectContent}\n` : "") +
    `Additional context: ${JSON.stringify(request.context)}\n\n` +
    `Respond as this persona would.`;

  // Step 6: Call the AI provider
  // Determine endpoint based on provider kind
  const providerKind = backend.provider_kind ?? "openai";
  let endpoint = "";
  let headers: Record<string, string> = {};

  if (providerKind === "anthropic") {
    endpoint = `${backend.base_url}/messages`;
    headers = {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    };
  } else if (providerKind === "azure") {
    endpoint = `${backend.base_url}/chat/completions?api-version=2024-02-01`;
    headers = { "api-key": apiKey, "Content-Type": "application/json" };
  } else {
    // OpenAI-compatible (default)
    endpoint = `${backend.base_url}/chat/completions`;
    headers = { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" };
  }

  const requestBody = providerKind === "anthropic" ? {
    model: backend.model,
    max_tokens: 2500,
    messages: [{ role: "user", content: prompt }],
  } : {
    model: backend.model,
    max_tokens: 2500,
    messages: [{ role: "user", content: prompt }],
    temperature: 0.7,
  };

  let resultText = "";
  let resultJson: Record<string, unknown> = {};
  let runStatus = "completed";
  let errorMsg = "";

  try {
    const aiResponse = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(requestBody),
    });

    if (!aiResponse.ok) {
      const errBody = await aiResponse.text();
      runStatus = "failed";
      errorMsg = `AI provider returned ${aiResponse.status}: ${errBody}`;
    } else {
      const aiData = await aiResponse.json();
      resultText = aiData.choices?.[0]?.message?.content ??
                   aiData.content?.[0]?.text ??
                   JSON.stringify(aiData);
      resultJson = aiData;
    }
  } catch (e) {
    runStatus = "failed";
    errorMsg = e instanceof Error
      ? e.message
      : "Unknown error calling AI provider";
  }

  // Step 7: Get the run ID we created during claim
  const { data: runRecord } = await admin
    .from("agent_board_runs")
    .select("id")
    .eq("request_id", request.request_id)
    .eq("status", "running")
    .order("started_at", { ascending: false })
    .limit(1)
    .single();

  // Step 8: Complete the run
  await admin.rpc("complete_agent_board_run", {
    p_request_id: request.request_id,
    p_run_id: runRecord?.id,
    p_status: runStatus,
    p_result_text: resultText,
    p_result_json: resultJson,
    p_error: errorMsg,
  });

  return new Response(JSON.stringify({
    success: true,
    executed: 1,
    request_id: request.request_id,
    status: runStatus,
    result: runStatus === "completed" ? resultText.substring(0, 500) + "..." : undefined,
    error: runStatus === "failed" ? errorMsg : undefined,
  }), {
    status: 200,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
});
