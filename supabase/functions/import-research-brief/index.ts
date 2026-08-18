// ======================================================================
// import-research-brief Edge Function
// Accepts Gemini JSON output (pasted from Gemini web interface) and
// saves it to the database using the save_research_brief RPC.
// This lets you run research in Gemini's free web UI and import results.
// ======================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { persona_id, brief_json, backend_id, model } = await req.json();

    if (!persona_id || !brief_json) {
      return new Response(
        JSON.stringify({ error: "persona_id and brief_json are required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Create service-role client
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // Parse the brief JSON (what Gemini output)
    let briefData;
    if (typeof brief_json === "string") {
      try {
        briefData = JSON.parse(brief_json);
      } catch {
        // Try to extract from code blocks
        const match = brief_json.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (match) {
          briefData = JSON.parse(match[1]);
        } else {
          const objMatch = brief_json.match(/\{[\s\S]*\}/);
          if (objMatch) {
            briefData = JSON.parse(objMatch[0]);
          } else {
            throw new Error("Could not parse brief_json");
          }
        }
      }
    } else {
      briefData = brief_json;
    }

    // Validate structure
    if (!briefData.findings || !Array.isArray(briefData.findings)) {
      return new Response(
        JSON.stringify({ error: "Invalid brief format: 'findings' array is required", received: Object.keys(briefData) }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Use provided backend_id or default to Gemini
    const effectiveBackendId = backend_id || "ab285482-91cc-48ea-b67f-956179dea432";
    const effectiveModel = model || "gemini-flash-latest";

    // Save via the RPC (handles brief + topic extraction)
    const { data: briefId, error: saveError } = await supabase.rpc("save_research_brief", {
      p_persona_id: persona_id,
      p_brief_date: briefData.brief_date || new Date().toISOString().split("T")[0],
      p_backend_id: effectiveBackendId,
      p_model: effectiveModel,
      p_executive_summary: briefData.executive_summary || "",
      p_key_findings: JSON.stringify(briefData.findings),
      p_sources: JSON.stringify(briefData.sources || []),
      p_raw_response: typeof brief_json === "string" ? brief_json : JSON.stringify(briefData),
    });

    if (saveError) {
      return new Response(
        JSON.stringify({ error: "Failed to save brief", detail: saveError.message }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({
        success: true,
        brief_id: briefId,
        finding_count: briefData.findings.length,
        executive_summary: briefData.executive_summary || "",
        message: "Brief imported successfully. Topics are ready for review.",
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error) {
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
