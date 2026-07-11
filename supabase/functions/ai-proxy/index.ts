// ai-proxy — server-side AI proxy so model API keys never touch the browser.
// Roadmap v0.5. The browser sends { backendId, messages, max_tokens? } with the
// user's Supabase JWT; this function looks up the owner's backend (key stays
// server-side), calls the provider, and returns the completion.
//
// Deploy:  supabase functions deploy ai-proxy
// Secrets: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided automatically.
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "https://mypersonas.online",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const authHeader = req.headers.get("Authorization") || "";
  const jwt = authHeader.replace("Bearer ", "");
  if (!jwt) return json({ error: "missing auth" }, 401);

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // Identify the caller from their JWT.
  const { data: userData, error: userErr } = await admin.auth.getUser(jwt);
  if (userErr || !userData?.user) return json({ error: "invalid session" }, 401);
  const uid = userData.user.id;

  let payload: { backendId?: string; messages?: unknown[]; max_tokens?: number };
  try { payload = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const { backendId, messages, max_tokens } = payload;
  if (!Array.isArray(messages) || !messages.length) return json({ error: "messages required" }, 400);

  // Fetch the backend for THIS owner only (service role bypasses RLS; we scope by owner).
  let q = admin.from("ai_backends").select("*").eq("owner", uid);
  q = backendId ? q.eq("id", backendId) : q.order("created_at").limit(1);
  const { data: rows, error: beErr } = await q;
  if (beErr) return json({ error: beErr.message }, 500);
  const b = rows?.[0];
  if (!b) return json({ error: "no linked model for this account" }, 400);

  try {
    const r = await fetch(b.base_url.replace(/\/$/, "") + "/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + b.api_key },
      body: JSON.stringify({ model: b.model, messages, max_tokens: max_tokens ?? 2500 }),
    });
    const j = await r.json();
    if (!r.ok) return json({ error: j.error?.message || ("provider HTTP " + r.status) }, 502);
    // Return only the assistant text — the key never leaves the server.
    return json({ content: j.choices?.[0]?.message?.content ?? "" });
  } catch (e) {
    return json({ error: "provider request failed: " + (e as Error).message }, 502);
  }
});
