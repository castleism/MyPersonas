// run-post-queue — scheduled publisher for 3-part post_drafts.
//
// Cron-invoked (X-Cron-Secret). Finds owner-approved drafts whose scheduled time
// has arrived, rechecks the owner pause + exact approval, atomically claims the
// current row (scheduled -> publishing), then publishes the platform-specific
// image+caption to Facebook and Instagram via the shared primitives. X is a hard
// failure until twitter-post is versioned and write-authorized. Successful provider
// ids are retained and skipped on retry to reduce duplicate-post risk. See
// POSTING-3PART-SPEC.md and POST-QUEUE-ACTIVATION.md.
//
// Deploy: supabase functions deploy run-post-queue --no-verify-jwt
// Required secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, META_APP_SECRET, CRON_SECRET
// Schedule (opt-in): see sql-updates/036-schedule-post-queue.sql

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  isRestrictedMetaPersona,
  publishFacebook,
  publishInstagram,
  resolvePageContext,
} from "../_shared/meta-publish.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CRON_SECRET = Deno.env.get("CRON_SECRET") || "";
const BATCH = 2;
const IG_ROLLING_LIMIT = 24; // conservative guard below the documented ~25/24h cap

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
  persona_id: string;
  facebook_ledger_id: string;
  scheduled_for: string;
  week_start: string;
  approved_at: string;
  approved_by: string;
  approved_content_hash: string;
  approved_timezone: string;
  approved_facebook_page_id: string;
  approved_instagram_business_id: string;
  targets: string[] | null;
  fb_caption: string | null;
  ig_caption: string | null;
  x_caption: string | null;
  fb_image_url: string | null;
  ig_image_url: string | null;
  x_image_url: string | null;
  source_image_url: string | null;
  fb_post_id: string | null;
  ig_media_id: string | null;
  x_tweet_id: string | null;
  fb_published_at: string | null;
  ig_published_at: string | null;
};

async function expectedHash(d: Draft) {
  return await admin.rpc("post_draft_hash", {
    p_persona_id: d.persona_id,
    p_facebook_ledger_id: d.facebook_ledger_id,
    p_targets: d.targets || [],
    p_scheduled_for: d.scheduled_for,
    p_week_start: d.week_start,
    p_timezone: d.approved_timezone,
    p_facebook_page_id: d.approved_facebook_page_id,
    p_instagram_business_id: d.approved_instagram_business_id,
    p_fb_caption: d.fb_caption || "",
    p_ig_caption: d.ig_caption || "",
    p_x_caption: d.x_caption || "",
    p_fb_image_url: d.fb_image_url || "",
    p_ig_image_url: d.ig_image_url || "",
    p_x_image_url: d.x_image_url || "",
    p_source_image_url: d.source_image_url || "",
  });
}

async function instagramPostsInWindow(d: Draft) {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  return await admin.from("post_drafts").select("id", { count: "exact", head: true })
    .eq("owner", d.owner)
    .eq("approved_instagram_business_id", d.approved_instagram_business_id)
    .not("ig_media_id", "is", null)
    .gte("ig_published_at", since);
}

async function rememberProviderResult(
  d: Draft,
  field: "fb_post_id" | "ig_media_id",
  value: string,
) {
  const publishedField = field === "fb_post_id" ? "fb_published_at" : "ig_published_at";
  const { data, error } = await admin.from("post_drafts")
    .update({
      [field]: value,
      [publishedField]: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", d.id)
    .eq("owner", d.owner)
    .eq("status", "publishing")
    .select("id")
    .maybeSingle();
  return { saved: !error && !!data, error };
}

function uncertainProviderOutcome(error: unknown) {
  const name = String((error as { name?: string })?.name || "");
  return error instanceof TypeError || name === "AbortError" || name === "TimeoutError";
}

async function ownerPauseState(owner: string) {
  const result = await admin.from("agent_owner_settings")
    .select("automation_paused").eq("owner", owner).maybeSingle();
  return {
    available: !result.error && !!result.data,
    paused: result.data?.automation_paused === true,
  };
}

async function transitionClaim(d: Draft, patch: Record<string, unknown>) {
  const result = await admin.from("post_drafts").update({
    ...patch,
    updated_at: new Date().toISOString(),
  }).eq("id", d.id).eq("owner", d.owner).eq("status", "publishing")
    .select("id").maybeSingle();
  return !result.error && !!result.data;
}

serve(async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  if (!CRON_SECRET || req.headers.get("X-Cron-Secret") !== CRON_SECRET) {
    return json({ error: "forbidden" }, 403);
  }

  const { data: due, error } = await admin.rpc("claim_due_post_drafts", { p_limit: BATCH });
  if (error) return json({ error: error.message }, 500);

  const results: unknown[] = [];
  for (const d of (due || []) as Draft[]) {
    try {
      const [pause, persona] = await Promise.all([
        ownerPauseState(d.owner),
        admin.from("personas").select("id").eq("id", d.persona_id)
          .eq("owner", d.owner).maybeSingle(),
      ]);
      if (!pause.available || pause.paused) {
        const message = pause.paused
          ? "Owner automation is paused."
          : "Owner automation settings became unavailable.";
        const restored = await transitionClaim(d, {
          status: "scheduled", last_error: message, publish_claimed_at: null,
        });
        results.push({ id: d.id, status: restored ? "deferred" : "reconciliation_required", error: message });
        continue;
      }
      if (persona.error || !persona.data || isRestrictedMetaPersona(d.persona_id)) {
        const message = persona.data
          ? "This adult cannabis persona is not eligible for Meta publishing."
          : "The draft persona is missing or not owned.";
        const failed = await transitionClaim(d, {
          status: "failed", last_error: message, publish_claimed_at: null,
        });
        results.push({ id: d.id, status: failed ? "failed" : "reconciliation_required", error: message });
        continue;
      }

      const targets = Array.isArray(d.targets) ? d.targets : [];
      const errs: string[] = [];
      if (!targets.length) errs.push("draft: no publish targets");
      if (targets.some((target) => !["facebook", "instagram"].includes(target))) {
        errs.push("draft: scheduled publishing is Meta-only; X or an unknown target is present");
      }
      if (!d.approved_at || d.approved_by !== d.owner || !d.approved_content_hash) {
        errs.push("approval: exact owner approval is missing");
      } else {
        const hash = await expectedHash(d);
        if (hash.error || hash.data !== d.approved_content_hash) {
          errs.push("approval: content, target, image, destination, or schedule changed after approval");
        }
      }
      if (errs.length) {
        const failed = await transitionClaim(d, {
          status: "failed", last_error: errs.join(" | "), publish_claimed_at: null,
        });
        results.push({ id: d.id, status: failed ? "failed" : "reconciliation_required", error: errs.join(" | ") });
        continue;
      }

      const upd: { fb_post_id?: string; ig_media_id?: string } = {};
      let safeToContinue = true;
      let reconciliationRequired = false;
      const needsMeta = (targets.includes("facebook") && !d.fb_post_id) ||
        (targets.includes("instagram") && !d.ig_media_id);
      const ctx = needsMeta && d.facebook_ledger_id
        ? await resolvePageContext(admin, d.owner, d.facebook_ledger_id)
        : null;
      if (needsMeta && !d.facebook_ledger_id) errs.push("meta: no target Facebook page");
      else if (ctx && !ctx.ok) errs.push("meta: " + ctx.error);
      else if (ctx?.ok) {
        if (String(ctx.asset.facebook_page_id) !== d.approved_facebook_page_id) {
          errs.push("approval: the paired Facebook Page changed after approval");
        }
        if (targets.includes("instagram") &&
          String(ctx.asset.instagram_business_id || "") !== d.approved_instagram_business_id) {
          errs.push("approval: the paired Instagram account changed after approval");
        }
      }

      if (errs.length) {
        const failed = await transitionClaim(d, {
          status: "failed", last_error: errs.join(" | "), publish_claimed_at: null,
        });
        results.push({ id: d.id, status: failed ? "failed" : "reconciliation_required", error: errs.join(" | ") });
        continue;
      }

      if (targets.includes("facebook") && !d.fb_post_id && ctx?.ok) {
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
            const saved = await rememberProviderResult(d, "fb_post_id", r.postId);
            if (saved.saved) {
              upd.fb_post_id = r.postId;
              d.fb_post_id = r.postId;
            } else {
              safeToContinue = false;
              reconciliationRequired = true;
              errs.push(`facebook: provider accepted ${r.postId}, but its result was not saved`);
            }
          } catch (e) {
            if (uncertainProviderOutcome(e)) {
              safeToContinue = false;
              reconciliationRequired = true;
            }
            errs.push("facebook: " + (e as Error).message);
          }
        }
      }

      if (safeToContinue && targets.includes("instagram") && !d.ig_media_id && ctx?.ok) {
        const pauseBeforeInstagram = await ownerPauseState(d.owner);
        if (!pauseBeforeInstagram.available || pauseBeforeInstagram.paused) {
          errs.push(pauseBeforeInstagram.paused
            ? "instagram: owner automation paused after the Facebook step"
            : "instagram: owner automation settings became unavailable");
        } else if (!ctx.asset.instagram_business_id) {
          errs.push("instagram: no linked professional account");
        } else {
          // This local counter is an advisory guard only; activation still
          // requires an atomic provider-account reservation and reconciliation.
          const recent = await instagramPostsInWindow(d);
          if (recent.error) errs.push("instagram: could not verify the rolling publish guard");
          else if ((recent.count || 0) >= IG_ROLLING_LIMIT) errs.push("instagram: rolling 24-hour safety guard reached");
          else {
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
                const saved = await rememberProviderResult(d, "ig_media_id", r.mediaId);
                if (saved.saved) {
                  upd.ig_media_id = r.mediaId;
                  d.ig_media_id = r.mediaId;
                } else {
                  reconciliationRequired = true;
                  errs.push(`instagram: provider accepted ${r.mediaId}, but its result was not saved`);
                }
              } catch (e) {
                if (uncertainProviderOutcome(e)) reconciliationRequired = true;
                errs.push("instagram: " + (e as Error).message);
              }
            }
          }
        }
      }

      const note = errs.join(" | ");
      if (reconciliationRequired) {
        await admin.from("post_drafts").update({
          last_error: `Reconciliation required before retry. ${note}`,
          updated_at: new Date().toISOString(),
        }).eq("id", d.id).eq("owner", d.owner).eq("status", "publishing");
        results.push({ id: d.id, status: "reconciliation_required", ...upd, error: note });
        continue;
      }

      const status = errs.length ? "failed" : "posted";
      const finalized = await transitionClaim(d, {
        ...upd,
        status,
        last_error: note || null,
        posted_at: status === "posted" ? new Date().toISOString() : null,
        publish_claimed_at: null,
      });
      if (!finalized) {
        results.push({
          id: d.id,
          status: "reconciliation_required",
          ...upd,
          error: "The publishing result state changed before finalization.",
        });
        continue;
      }
      await admin.from("agent_actions").insert({
        owner: d.owner,
        persona_id: d.persona_id,
        action_type: "post_draft.scheduled_publish",
        entity_type: "post_draft",
        entity_id: d.id,
        outcome: status,
        detail: { targets, ...upd, errors: errs },
      });
      results.push({ id: d.id, status, ...upd, note: note || undefined });
    } catch (error) {
      const note = `Reconciliation required after an unexpected worker error: ${(error as Error).message}`;
      await admin.from("post_drafts").update({
        last_error: note, updated_at: new Date().toISOString(),
      }).eq("id", d.id).eq("owner", d.owner).eq("status", "publishing");
      results.push({ id: d.id, status: "reconciliation_required", error: note });
    }
  }

  return json({ processed: (due || []).length, results });
});
