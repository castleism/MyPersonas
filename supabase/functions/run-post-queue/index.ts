// run-post-queue — scheduled publisher for 3-part post_drafts.
//
// Cron-invoked (X-Cron-Secret). Finds owner-approved drafts whose scheduled time
// has arrived, atomically claims each (scheduled -> publishing) so overlapping runs
// can't double-post, then publishes the platform-specific image+caption to Facebook
// and Instagram via the shared meta-publish primitives. X is deferred until
// twitter-post is wired. Results (fb_post_id / ig_media_id) and any error are
// written back; a draft with any failure is marked 'failed' (successful ids kept)
// so the owner can retry the rest. See POSTING-3PART-SPEC.md.
//
// Deploy: supabase functions deploy run-post-queue --no-verify-jwt
// Required secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, META_APP_SECRET, CRON_SECRET
// Schedule (opt-in): see sql-updates/035-schedule-post-queue.sql

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  publishFacebook,
  publishInstagram,
  resolvePageContext,
} from "../_shared/meta-publish.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CRON_SECRET = Deno.env.get("CRON_SECRET") || "";
const BATCH = 15; // bounded per run; well under IG's ~25 posts/24h/account

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

type Draft = {
  id: string;
  owner: string;
  facebook_ledger_id: string;
  targets: string[] | null;
  fb_caption: string | null;
  ig_caption: string | null;
  fb_image_url: string | null;
  ig_image_url: string | null;
  source_image_url: string | null;
};

serve(async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  if (!CRON_SECRET || req.headers.get("X-Cron-Secret") !== CRON_SECRET) {
    return json({ error: "forbidden" }, 403);
  }

  const now = new Date().toISOString();
  const { data: due, error } = await admin.from("post_drafts")
    .select(
      "id,owner,facebook_ledger_id,targets,fb_caption,ig_caption,fb_image_url,ig_image_url,source_image_url",
    )
    .eq("status", "scheduled")
    .lte("scheduled_for", now)
    .neq("facebook_ledger_id", "")
    .order("scheduled_for", { ascending: true })
    .limit(BATCH);
  if (error) return json({ error: error.message }, 500);

  const results: unknown[] = [];
  for (const d of (due || []) as Draft[]) {
    // Atomic claim: only proceed if we flip scheduled -> publishing.
    const { data: claimed } = await admin.from("post_drafts")
      .update({ status: "publishing", updated_at: new Date().toISOString() })
      .eq("id", d.id)
      .eq("status", "scheduled")
      .select("id");
    if (!claimed || !claimed.length) {
      results.push({ id: d.id, skipped: "already-claimed" });
      continue;
    }

    const targets = Array.isArray(d.targets) ? d.targets : [];
    const ctx = await resolvePageContext(admin, d.owner, d.facebook_ledger_id);
    if (!ctx.ok) {
      await admin.from("post_drafts").update({
        status: "failed",
        last_error: ctx.error,
        updated_at: new Date().toISOString(),
      }).eq("id", d.id);
      results.push({ id: d.id, status: "failed", error: ctx.error });
      continue;
    }

    const upd: { fb_post_id?: string; ig_media_id?: string } = {};
    const errs: string[] = [];

    if (targets.includes("facebook")) {
      const img = d.fb_image_url || d.source_image_url || "";
      if (!img) errs.push("facebook: no image");
      else {
        try {
          const r = await publishFacebook(
            ctx.asset.facebook_page_id,
            ctx.pageToken,
            img,
            d.fb_caption || "",
          );
          upd.fb_post_id = r.postId;
        } catch (e) {
          errs.push("facebook: " + (e as Error).message);
        }
      }
    }

    if (targets.includes("instagram") && ctx.asset.instagram_business_id) {
      const img = d.ig_image_url || d.source_image_url || "";
      if (!img) errs.push("instagram: no image");
      else {
        try {
          const r = await publishInstagram(
            String(ctx.asset.instagram_business_id),
            ctx.pageToken,
            img,
            d.ig_caption || "",
          );
          upd.ig_media_id = r.mediaId;
        } catch (e) {
          errs.push("instagram: " + (e as Error).message);
        }
      }
    }

    const xDeferred = targets.includes("twitter");
    const note = [
      ...errs,
      xDeferred ? "x: publisher not wired yet" : "",
    ].filter(Boolean).join(" | ");

    await admin.from("post_drafts").update({
      ...upd,
      status: errs.length ? "failed" : "posted",
      last_error: note || null,
      updated_at: new Date().toISOString(),
    }).eq("id", d.id);
    results.push({
      id: d.id,
      status: errs.length ? "failed" : "posted",
      ...upd,
      note: note || undefined,
    });
  }

  return json({ processed: (due || []).length, results });
});
