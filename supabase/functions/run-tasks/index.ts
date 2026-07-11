// run-tasks — auto-runs due scheduled tasks and lands results in drafts.
// Roadmap v0.5 ("Auto-running scheduled tasks ... results land in drafts each morning").
// Invoke on a schedule with pg_cron + pg_net (see DEPLOY.md), or manually.
//
// Security: requires a shared secret in the X-Cron-Secret header (set CRON_SECRET),
// so only your scheduler can trigger it. Uses the service role to read backends and
// write drafts on the owner's behalf.
//
// Deploy:  supabase functions deploy run-tasks --no-verify-jwt
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const JOB_PROMPTS: Record<string, string> = {
  newsplan: "Draft a short news-scan content plan for this persona: 3 timely topics with a one-line angle each.",
  original: "Write one original short post in this persona's voice.",
  repost: "Suggest one thing worth resharing for this persona and a 1-2 sentence commentary in their voice.",
  article: "Draft a short article outline (title + 4 bullet sections) in this persona's voice.",
  reel: "Write a 20-second vertical-video script (hook, 3 beats, CTA) in this persona's voice.",
  image: "Write one image prompt and a caption in this persona's voice.",
  newsletter: "Draft a short newsletter section in this persona's voice.",
  promo: "Write one promotional post for this persona's page in their voice.",
  custom: "Follow the extra instructions for this persona.",
};

function personaSystem(p: any): string {
  return `You are ${p.name} (@${p.handle}). Tagline: ${p.tagline || "n/a"}. Bio: ${p.bio || "n/a"}. ` +
    `Purpose: ${p.purpose || "n/a"}. Voice: ${p.voice || "n/a"}. Topics: ${p.topics || "n/a"}. ` +
    `Audience: ${p.audience || "n/a"}. Hashtags: ${p.hashtags || "n/a"}. Never do: ${p.dont || "n/a"}. ` +
    `Rating: ${p.nsfw ? "NSFW/18+" : "SFW"}.`;
}

function isDue(task: any, now: Date): boolean {
  if (task.cadence === "manual") return false;
  if (!task.last_run) return true;
  const last = new Date(task.last_run).getTime();
  const gap = now.getTime() - last;
  if (task.cadence === "daily") return gap >= 20 * 3600 * 1000;   // ~daily, tolerant
  if (task.cadence === "weekly") return gap >= 6.5 * 24 * 3600 * 1000;
  return false;
}

serve(async (req) => {
  if (req.headers.get("X-Cron-Secret") !== Deno.env.get("CRON_SECRET")) {
    return new Response("forbidden", { status: 403 });
  }
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const now = new Date();

  const { data: tasks, error } = await admin.from("ai_tasks").select("*");
  if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500 });

  let ran = 0;
  const results: string[] = [];
  for (const t of tasks || []) {
    if (!isDue(t, now)) continue;
    if (!t.persona_id) continue;

    const { data: pRows } = await admin.from("personas").select("*").eq("id", t.persona_id).limit(1);
    const p = pRows?.[0];
    if (!p) continue;

    // backend: task's backend, else the owner's first linked model
    let be = null;
    if (t.backend_id) {
      const { data } = await admin.from("ai_backends").select("*").eq("id", t.backend_id).limit(1);
      be = data?.[0] || null;
    }
    if (!be) {
      const { data } = await admin.from("ai_backends").select("*").eq("owner", t.owner).order("created_at").limit(1);
      be = data?.[0] || null;
    }
    if (!be) continue;

    const jobPrompt = (JOB_PROMPTS[t.task_type] || JOB_PROMPTS.custom) +
      (t.instructions ? "\nExtra instructions: " + t.instructions : "");
    try {
      const r = await fetch(be.base_url.replace(/\/$/, "") + "/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + be.api_key },
        body: JSON.stringify({
          model: be.model,
          messages: [{ role: "system", content: personaSystem(p) }, { role: "user", content: jobPrompt }],
          max_tokens: 1200,
        }),
      });
      const j = await r.json();
      if (!r.ok) { results.push(`task ${t.id}: provider error`); continue; }
      const body = j.choices?.[0]?.message?.content ?? "";
      await admin.from("drafts").insert({
        owner: t.owner, persona_id: t.persona_id, platform: "",
        title: `[auto] ${t.name} — ${now.toISOString().slice(0, 10)}`,
        body, status: "idea",
      });
      await admin.from("ai_tasks").update({ last_run: now.toISOString() }).eq("id", t.id);
      ran++;
      results.push(`task ${t.id}: drafted`);
    } catch (e) {
      results.push(`task ${t.id}: ${(e as Error).message}`);
    }
  }
  return new Response(JSON.stringify({ ran, results }), { headers: { "Content-Type": "application/json" } });
});
