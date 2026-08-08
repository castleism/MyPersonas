// gemini-image — generate or edit a persona image with Gemini's image model
// ("nano banana", gemini-2.5-flash-image) using the owner's own Gemini key from
// the Vault. Text-to-image, or image editing when a base image is supplied.
// The browser never sees the key: it POSTs { prompt, target?, baseImage?, backendId? }
// with the owner's bearer token; this function reads the key server-side and calls
// the native generateContent endpoint. Deploy like the other functions
// (Supabase CLI: `supabase functions deploy gemini-image`, or the dashboard editor).
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const U = Deno.env.get("SUPABASE_URL")!, S = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, A = Deno.env.get("SUPABASE_ANON_KEY")!;
const H = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "https://mypersonas.online",
  "Access-Control-Allow-Headers": "authorization,content-type",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
};
const J = (s: number, b: unknown) => new Response(JSON.stringify(b), { status: s, headers: H });

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: H });
  if (req.method !== "POST") return J(405, { error: "POST only" });

  const auth = req.headers.get("Authorization") || "";
  if (!auth.startsWith("Bearer ")) return J(401, { error: "Sign in first" });
  const uc = createClient(U, A, { global: { headers: { Authorization: auth } }, auth: { persistSession: false } });
  const { data: ud } = await uc.auth.getUser();
  const uid = ud?.user?.id || "";
  if (!uid) return J(401, { error: "Sign in first" });

  let body: any = {};
  try { body = await req.json(); } catch { /**/ }
  const prompt = String(body.prompt || "").slice(0, 5000).trim();
  if (!prompt) return J(400, { error: "A prompt is required" });

  const svc = createClient(U, S, { auth: { persistSession: false } });
  let backend: any = null;
  if (body.backendId) {
    const r = await svc.from("ai_backends").select("id,model,base_url,api_key,provider").eq("owner", uid).eq("id", body.backendId).maybeSingle();
    backend = r.data;
  }
  if (!backend) {
    const r = await svc.from("ai_backends").select("id,model,base_url,api_key,provider").eq("owner", uid).in("provider", ["google", "google_legacy"]).order("created_at").limit(1).maybeSingle();
    backend = r.data;
  }
  if (!backend) return J(400, { error: "No Gemini model is linked. Add one in Matrix -> AI Models." });

  let key = String(backend.api_key || "");
  if (!key) {
    const { data: k } = await svc.rpc("ai_backend_get_key", { p_backend_id: backend.id, p_owner: uid });
    key = String(k || "");
  }
  if (!key) return J(400, { error: "Could not read the Gemini API key" });

  const nb = String(backend.base_url || "https://generativelanguage.googleapis.com/v1beta").replace(/\/openai\/?$/, "").replace(/\/+$/, "");
  const model = String(body.model || "gemini-2.5-flash-image").trim();

  const parts: any[] = [{ text: prompt }];
  const bi = String(body.baseImage || "");
  const m = bi.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (m) parts.push({ inline_data: { mime_type: m[1], data: m[2] } });

  const url = `${nb}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`;
  const call = async (modalities: string[]) => {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts }], generationConfig: { responseModalities: modalities } }),
      signal: AbortSignal.timeout(90000),
    }).catch(() => null);
    if (!r) return { ok: false, status: 502, j: { error: { message: "Could not reach Gemini" } } as any };
    const j = await r.json().catch(() => ({} as any));
    return { ok: r.ok, status: r.status, j };
  };

  // gemini-2.5-flash-image accepts IMAGE-only; older preview models require TEXT+IMAGE.
  let res = await call(["IMAGE"]);
  if (!res.ok && /modal|responseModalities|only supports|must (be|include)/i.test(JSON.stringify(res.j))) {
    res = await call(["TEXT", "IMAGE"]);
  }
  if (!res.ok) {
    return J(res.status, { error: String(res.j?.error?.message || ("Gemini image error (HTTP " + res.status + ")")).slice(0, 400) });
  }

  const outParts = res.j?.candidates?.[0]?.content?.parts || [];
  const img = outParts.find((p: any) => p?.inlineData?.data || p?.inline_data?.data);
  const data = img?.inlineData?.data || img?.inline_data?.data;
  const mime = img?.inlineData?.mimeType || img?.inline_data?.mime_type || "image/png";
  if (!data) {
    return J(502, { error: "Gemini returned no image. This Gemini key may not have image generation enabled (it is a paid Google model)." });
  }
  return J(200, { image: `data:${mime};base64,${data}`, mime });
});
