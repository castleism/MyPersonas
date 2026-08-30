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
  type MetaPublishTarget,
  providerOutcomeIsUncertain,
  publishFacebook,
  publishInstagram,
  resolvePageContext,
} from "../_shared/meta-publish.ts";
import {
  type ApprovedMedia,
  verifyApprovedMedia,
} from "../_shared/approved-media.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CRON_SECRET = Deno.env.get("CRON_SECRET") || "";
const BATCH = 1;

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
  approved_preview_version: string;
  approved_preview_hash: string;
  approved_timezone: string;
  approved_facebook_page_id: string;
  approved_instagram_business_id: string;
  approved_fb_media_sha256: string;
  approved_fb_media_mime: ApprovedMedia["mime"] | "";
  approved_fb_media_bytes: number;
  approved_fb_media_path: string;
  approved_fb_media_url: string;
  approved_ig_media_sha256: string;
  approved_ig_media_mime: ApprovedMedia["mime"] | "";
  approved_ig_media_bytes: number;
  approved_ig_media_path: string;
  approved_ig_media_url: string;
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
  publish_facebook_page_id: string;
  publish_instagram_business_id: string;
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
    p_fb_media_sha256: d.approved_fb_media_sha256 || "",
    p_fb_media_mime: d.approved_fb_media_mime || "",
    p_fb_media_bytes: d.approved_fb_media_bytes || 0,
    p_fb_media_path: d.approved_fb_media_path || "",
    p_fb_media_url: d.approved_fb_media_url || "",
    p_ig_media_sha256: d.approved_ig_media_sha256 || "",
    p_ig_media_mime: d.approved_ig_media_mime || "",
    p_ig_media_bytes: d.approved_ig_media_bytes || 0,
    p_ig_media_path: d.approved_ig_media_path || "",
    p_ig_media_url: d.approved_ig_media_url || "",
  });
}

function approvedMediaFor(d: Draft, target: "facebook" | "instagram"): ApprovedMedia {
  return target === "facebook"
    ? {
      sha256: d.approved_fb_media_sha256,
      mime: d.approved_fb_media_mime as ApprovedMedia["mime"],
      byteSize: d.approved_fb_media_bytes,
      path: d.approved_fb_media_path,
      url: d.approved_fb_media_url,
    }
    : {
      sha256: d.approved_ig_media_sha256,
      mime: d.approved_ig_media_mime as ApprovedMedia["mime"],
      byteSize: d.approved_ig_media_bytes,
      path: d.approved_ig_media_path,
      url: d.approved_ig_media_url,
    };
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
    .is(field, null)
    .select("id")
    .maybeSingle();
  if (!error && data) return { saved: true, error: null };
  const current = await admin.from("post_drafts").select(field)
    .eq("id", d.id).eq("owner", d.owner).eq("status", "publishing")
    .maybeSingle();
  const same = !current.error && current.data &&
    String((current.data as Record<string, unknown>)[field] || "") === value;
  return { saved: !!same, error: error || current.error };
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

async function finalizeClaim(
  d: Draft,
  status: "posted" | "failed",
  lastError: string,
  detail: Record<string, unknown>,
) {
  const result = await admin.rpc("finalize_post_draft_publish", {
    p_draft_id: d.id,
    p_owner: d.owner,
    p_status: status,
    p_last_error: lastError,
    p_action_type: "post_draft.scheduled_publish",
    p_detail: detail,
  });
  return !result.error && !!result.data;
}

async function noteReconciliation(
  d: Draft,
  note: string,
  detail: Record<string, unknown>,
) {
  const result = await admin.rpc("note_post_draft_reconciliation", {
    p_draft_id: d.id,
    p_owner: d.owner,
    p_note: note,
    p_action_type: "post_draft.scheduled_publish",
    p_detail: detail,
  });
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
        results.push({ id: d.id, status: restored ? "deferred" : "publishing",
          ...(!restored ? { reconciliationRequired: true } : {}), error: message });
        continue;
      }
      if (persona.error || !persona.data || isRestrictedMetaPersona(d.persona_id)) {
        const message = persona.data
          ? "This adult cannabis persona is not eligible for Meta publishing."
          : "The draft persona is missing or not owned.";
        const failed = await finalizeClaim(d, "failed", message, {
          phase: "persona_policy", errors: [message],
        });
        results.push({ id: d.id, status: failed ? "failed" : "publishing",
          ...(!failed ? { reconciliationRequired: true } : {}), error: message });
        continue;
      }

      const targets = Array.isArray(d.targets) ? d.targets : [];
      const errs: string[] = [];
      let approvalPhase = "approval";
      if (!targets.length) errs.push("draft: no publish targets");
      if (targets.some((target) => !["facebook", "instagram"].includes(target))) {
        errs.push("draft: scheduled publishing is Meta-only; X or an unknown target is present");
      }
      if (!d.approved_at || d.approved_by !== d.owner || !d.approved_content_hash) {
        errs.push("approval: exact owner approval is missing");
      } else if (
        !String(d.approved_preview_version || "").trim() ||
        !String(d.approved_preview_hash || "").trim()
      ) {
        errs.push("approval: the exact owner-approved preview evidence is missing");
      } else {
        const hash = await expectedHash(d);
        if (hash.error || hash.data !== d.approved_content_hash) {
          errs.push("approval: content, target, image, destination, or schedule changed after approval");
        }
      }
      if (!errs.length) {
        for (const target of targets) {
          if (target !== "facebook" && target !== "instagram") continue;
          const media = approvedMediaFor(d, target);
          const rowUrl = target === "facebook" ? d.fb_image_url : d.ig_image_url;
          if (!media.url || rowUrl !== media.url) {
            approvalPhase = "approved_media";
            errs.push(`${target}: immutable approved-media URL is missing or changed`);
            continue;
          }
          try {
            await verifyApprovedMedia(admin.storage, SUPABASE_URL, media, d.owner);
          } catch (error) {
            approvalPhase = "approved_media";
            errs.push(`${target}: ${(error as Error).message}`);
          }
        }
      }
      if (errs.length) {
        const failed = await finalizeClaim(d, "failed", errs.join(" | "), {
          phase: approvalPhase, targets, errors: errs,
        });
        results.push({ id: d.id, status: failed ? "failed" : "publishing",
          ...(!failed ? { reconciliationRequired: true } : {}), error: errs.join(" | ") });
        continue;
      }

      const upd: { fb_post_id?: string; ig_media_id?: string } = {};
      let safeToContinue = true;
      let reconciliationRequired = false;
      const pendingMetaTargets = [
        ...(targets.includes("facebook") && !d.fb_post_id
          ? ["facebook" as const]
          : []),
        ...(targets.includes("instagram") && !d.ig_media_id
          ? ["instagram" as const]
          : []),
      ] satisfies MetaPublishTarget[];
      const needsMeta = pendingMetaTargets.length > 0;
      const ctx = needsMeta && d.facebook_ledger_id
        ? await resolvePageContext(
          admin,
          d.owner,
          d.facebook_ledger_id,
          true,
          pendingMetaTargets,
        )
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
        const failed = await finalizeClaim(d, "failed", errs.join(" | "), {
          phase: "destination", targets, errors: errs,
        });
        results.push({ id: d.id, status: failed ? "failed" : "publishing",
          ...(!failed ? { reconciliationRequired: true } : {}), error: errs.join(" | ") });
        continue;
      }

      if (d.publish_facebook_page_id || d.publish_instagram_business_id) {
        if (d.publish_facebook_page_id !== d.approved_facebook_page_id ||
          d.publish_instagram_business_id !== d.approved_instagram_business_id) {
          reconciliationRequired = true;
          errs.push("publish attempt destination snapshot does not match the approval");
        }
      } else {
        const snap = await admin.from("post_drafts").update({
          publish_facebook_page_id: d.approved_facebook_page_id,
          publish_instagram_business_id: d.approved_instagram_business_id,
          updated_at: new Date().toISOString(),
        }).eq("id", d.id).eq("owner", d.owner).eq("status", "publishing")
          .eq("publish_facebook_page_id", "").eq("publish_instagram_business_id", "")
          .select("id").maybeSingle();
        if (snap.error || !snap.data) {
          reconciliationRequired = true;
          errs.push("publish attempt destination snapshot could not be saved");
        } else {
          d.publish_facebook_page_id = d.approved_facebook_page_id;
          d.publish_instagram_business_id = d.approved_instagram_business_id;
        }
      }

      if (!reconciliationRequired && targets.includes("facebook") && !d.fb_post_id && ctx?.ok) {
        const img = d.approved_fb_media_url;
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
            if (providerOutcomeIsUncertain(e)) {
              safeToContinue = false;
              reconciliationRequired = true;
            }
            errs.push("facebook: " + (e as Error).message);
          }
        }
      }

      if (!reconciliationRequired && safeToContinue && targets.includes("instagram") && !d.ig_media_id && ctx?.ok) {
        const pauseBeforeInstagram = await ownerPauseState(d.owner);
        if (!pauseBeforeInstagram.available || pauseBeforeInstagram.paused) {
          errs.push(pauseBeforeInstagram.paused
            ? "instagram: owner automation paused after the Facebook step"
            : "instagram: owner automation settings became unavailable");
        } else if (!ctx.asset.instagram_business_id) {
          errs.push("instagram: no linked professional account");
        } else {
          const img = d.approved_ig_media_url;
          if (!img) errs.push("instagram: no image");
          else {
            try {
              // publishInstagram reads Meta's current account-specific content
              // publishing quota before creating a container; no stale local
              // hard limit is used here.
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
              if (providerOutcomeIsUncertain(e)) reconciliationRequired = true;
              errs.push("instagram: " + (e as Error).message);
            }
          }
        }
      }

      const note = errs.join(" | ");
      if (reconciliationRequired) {
        const noted = await noteReconciliation(
          d,
          `Reconciliation required before retry. ${note}`,
          { targets, ...upd, errors: errs, facebookPageId: d.publish_facebook_page_id,
            instagramBusinessId: d.publish_instagram_business_id },
        );
        results.push({
          id: d.id, status: "publishing", reconciliationRequired: true, ...upd,
          error: noted ? note : `${note} | reconciliation audit could not be saved`,
        });
        continue;
      }

      const status = errs.length ? "failed" : "posted";
      const finalized = await finalizeClaim(d, status, note, {
        targets, ...upd, errors: errs, facebookPageId: d.publish_facebook_page_id,
        instagramBusinessId: d.publish_instagram_business_id,
      });
      if (!finalized) {
        results.push({
          id: d.id,
          status: "publishing",
          reconciliationRequired: true,
          ...upd,
          error: "The publishing result state changed before finalization.",
        });
        continue;
      }
      results.push({ id: d.id, status, ...upd, note: note || undefined });
    } catch (error) {
      const note = `Reconciliation required after an unexpected worker error: ${(error as Error).message}`;
      const noted = await noteReconciliation(d, note, { phase: "unexpected", error: (error as Error).message });
      results.push({
        id: d.id, status: "publishing", reconciliationRequired: true,
        error: noted ? note : `${note} | reconciliation audit could not be saved`,
      });
    }
  }

  return json({ processed: (due || []).length, results });
});
