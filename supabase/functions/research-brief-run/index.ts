// ======================================================================
// research-brief-run Edge Function
// Calls Gemini API to generate a daily research brief for a persona
// Saves the brief + extracts findings into the database
// ======================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// --- Resolve API key: try table column first, then Vault RPC ---
async function resolveApiKey(supabase: any, backend: any, owner: string): Promise<string> {
  // 1. Try the legacy api_key column
  const legacyKey = typeof backend.api_key === "string" ? backend.api_key.trim() : "";
  if (legacyKey) return legacyKey;

  // 2. Try the Vault RPC (same pattern as ai-proxy)
  const { data, error } = await supabase.rpc("ai_backend_get_key", {
    p_backend_id: backend.id,
    p_owner: owner,
  });
  if (error) {
    console.error("Vault key lookup failed:", error.message);
    return "";
  }
  if (typeof data === "string") return data.trim();
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const record = data as Record<string, unknown>;
    const value = record.api_key ?? record.key ?? record.secret;
    return typeof value === "string" ? value.trim() : "";
  }
  if (Array.isArray(data) && data.length) {
    const first = data[0];
    if (typeof first === "string") return first.trim();
    if (first && typeof first === "object") {
      const record = first as Record<string, unknown>;
      const value = record.api_key ?? record.key ?? record.secret;
      return typeof value === "string" ? value.trim() : "";
    }
  }
  return "";
}

async function callGemini(baseUrl: string, apiKey: string, model: string, systemPrompt: string, userPrompt: string) {
  const url = `${baseUrl}/chat/completions`;
  const body = {
    model: model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    temperature: 0.7,
    max_tokens: 4000,
  };
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gemini API error ${response.status}: ${errorText}`);
  }
  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("Gemini returned no assistant text");
  }
  return content;
}

function extractJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlockMatch) {
      try {
        return JSON.parse(codeBlockMatch[1]);
      } catch {}
    }
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
  }
  throw new Error("Could not extract JSON from Gemini response");
}

function buildSystemPrompt(): string {
  return `You are a research analyst for a multi-persona content platform. Your job is to discover new, novel, exciting, and groundbreaking information in a specific domain, then summarize it into a daily brief that the platform owner can review in under 3 minutes per persona.

RULES:
- Focus on NEW discoveries, processes, research, and developments from the last 7-30 days
- Prioritize: breakthroughs, novel approaches, surprising findings, new processes, emerging trends
- NEVER fabricate sources. If you are not certain a source exists, mark it as "[needs verification]"
- Each brief must contain 3-5 distinct findings
- Each finding gets: title, 2-3 sentence summary, why it matters for this persona, novelty score (1-10), and source URLs if available
- Write in clear, non-academic language
- Flag anything that needs fact-checking before posting

OUTPUT FORMAT (strict JSON):
{
  "brief_date": "YYYY-MM-DD",
  "persona_handle": "castleborn.xxx",
  "persona_name": "Name",
  "executive_summary": "2-3 sentence overview of today's research landscape",
  "findings": [
    {
      "title": "Short headline for the finding",
      "summary": "2-3 sentences explaining what happened",
      "why_it_matters": "Why this is relevant to this persona's content pillars and audience",
      "novelty_score": 8,
      "relevance_score": 9,
      "source_urls": ["https://...", "https://..."],
      "source_type": "research_paper|news_article|industry_report|social_trend|product_launch",
      "needs_verification": false,
      "suggested_post_angle": "How this persona would cover this topic",
      "suggested_post_type": "new|repost|remix|thread"
    }
  ]
}`;
}

function buildUserPrompt(persona: any, contentPlan: any): string {
  const today = new Date().toISOString().split("T")[0];
  return `PERSONA: ${persona.name} (@${persona.handle})
DATE: ${today}

CONTENT STRATEGY:
- Primary Goal: ${contentPlan?.primary_goal || "Not specified"}
- Audience: ${contentPlan?.audience_focus || "Not specified"}
- Content Pillars: ${contentPlan?.content_pillars || "Not specified"}
- Current Campaign: ${contentPlan?.current_campaign || "Not specified"}

RESEARCH DIRECTIVE:
Find 3-5 NEW developments relevant to this persona's content pillars and audience. Focus on:
1. Breakthroughs or novel discoveries in the past 7-30 days
2. New processes, methods, or techniques that this persona would find exciting
3. Surprising findings that challenge conventional wisdom in this domain
4. Emerging trends that this persona's audience would care about
5. Tools, products, or platforms that could change how this persona creates content

For each finding, suggest how ${persona.name} would cover it as a post. Consider whether it's better to:
- NEW: Create original content about this finding
- REPOST: Share/repost existing coverage with attribution
- REMIX: Take the finding and add this persona's unique perspective
- THREAD: Break it into a multi-post thread

Return ONLY valid JSON matching the output format. Do not include any text before or after the JSON.`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  try {
    const { persona_id, backend_id } = await req.json();
    if (!persona_id) {
      return new Response(JSON.stringify({ error: "persona_id is required" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // 1. Load persona
    const { data: persona, error: personaError } = await supabase
      .from("personas").select("id, name, handle, owner").eq("id", persona_id).single();
    if (personaError || !persona) {
      return new Response(JSON.stringify({ error: "Persona not found", detail: personaError?.message }), { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // 2. Load content plan
    const { data: contentPlan } = await supabase
      .from("persona_content_plans").select("primary_goal, audience_focus, content_pillars, current_campaign").eq("persona_id", persona_id).single();

    // 3. Load research settings (for default backend)
    const { data: settings } = await supabase
      .from("persona_research_settings").select("preferred_backend_id, research_depth, max_findings_per_brief").eq("persona_id", persona_id).single();

    const effectiveBackendId = backend_id || settings?.preferred_backend_id;
    if (!effectiveBackendId) {
      return new Response(JSON.stringify({ error: "No backend ID configured" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // 4. Load AI backend
    const { data: backend, error: backendError } = await supabase
      .from("ai_backends").select("id, name, base_url, model, api_key, owner").eq("id", effectiveBackendId).single();
    if (backendError || !backend) {
      return new Response(JSON.stringify({ error: "AI backend not found", detail: backendError?.message }), { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // 5. Resolve API key (try table column, then Vault)
    const apiKey = await resolveApiKey(supabase, backend, backend.owner || persona.owner);
    if (!apiKey) {
      return new Response(JSON.stringify({ error: "No API key found (checked table + Vault)", backend: backend.name }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // 6. Build prompts
    const systemPrompt = buildSystemPrompt();
    const userPrompt = buildUserPrompt(persona, contentPlan);

    // 7. Call Gemini
    const rawResponse = await callGemini(backend.base_url, apiKey, backend.model, systemPrompt, userPrompt);

    // 8. Parse JSON from response
    let briefData;
    try {
      briefData = extractJson(rawResponse);
    } catch (parseError) {
      await supabase.rpc("save_research_brief", {
        p_persona_id: persona_id,
        p_brief_date: new Date().toISOString().split("T")[0],
        p_backend_id: effectiveBackendId,
        p_model: backend.model,
        p_executive_summary: "Brief parsing failed - raw response saved for review",
        p_key_findings: JSON.stringify([]),
        p_sources: JSON.stringify([]),
        p_raw_response: rawResponse,
      });
      return new Response(JSON.stringify({ error: "Failed to parse Gemini response", raw_saved: true }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // 9. Save brief + extract topics
    const { data: briefId, error: saveError } = await supabase.rpc("save_research_brief", {
      p_persona_id: persona_id,
      p_brief_date: briefData.brief_date || new Date().toISOString().split("T")[0],
      p_backend_id: effectiveBackendId,
      p_model: backend.model,
      p_executive_summary: briefData.executive_summary || "",
      p_key_findings: JSON.stringify(briefData.findings || []),
      p_sources: JSON.stringify(briefData.sources || []),
      p_raw_response: rawResponse,
    });

    if (saveError) {
      return new Response(JSON.stringify({ error: "Failed to save brief", detail: saveError.message }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // 10. Return success
    return new Response(JSON.stringify({
      success: true,
      brief_id: briefId,
      persona: persona.handle,
      finding_count: briefData.findings?.length || 0,
      executive_summary: briefData.executive_summary,
    }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
