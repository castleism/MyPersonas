// meta-post — interactive Facebook Page + Instagram publisher / manager.
//
// Owner-authenticated HTTP layer over _shared/meta-publish.ts (the same publish
// primitives the scheduled publisher uses). Owner-scoped + scope-gated:
// posting to the owner's OWN pages/IG works in development mode without App Review;
// App Review is only for posting on behalf of other people. See APP-REVIEW-META.md.
//
// Actions (POST, owner bearer token):
//   { action:"publish-draft", draftId }
//     atomically claims one editable post_drafts row, publishes every selected
//     Meta target, checkpoints each provider ID, then finalizes the row.
//     -> { status, facebook?: {postId}, instagram?: {mediaId}, errors?: string[] }
//   { action:"delete", facebookLedgerId, postId }
//     -> { deleted:true }   (Facebook Page posts only — the IG API can't delete media.)
//
// Deploy: supabase functions deploy meta-post --project-ref nwsqyuucwzihruszocge
// Required secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, META_APP_SECRET

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  graphDelete,
  isRestrictedMetaPersona,
  publishFacebook,
  publishInstagram,
  resolvePageContext,
} from "../_shared/meta-publish.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const SAFE_POST_ID = /^[0-9_]{1,64}$/;
const SAFE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type Draft = {
  id: string;
  owner: string;
  persona_id: string | null;
  facebook_ledger_id: string | null;
  status: string;
  targets: string[] | null;
  source_image_url: string | null;
  fb_image_url: string | null;
  ig_image_url: string | null;
  fb_caption: string | null;
  ig_caption: string | null;
  fb_post_id: string | null;
  ig_media_id: string | null;
};

const DRAFT_COLUMNS = [
  "id", "owner", "persona_id", "facebook_ledger_id", "status", "targets",
  "source_image_url", "fb_image_url", "ig_image_url", "fb_caption", "ig_caption",
  "fb_post_id", "ig_media_id",
].join(",");

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const ORIGINS = new Set([
  "https://aliaspaces.com",
  "https://www.aliaspaces.com",
  "https://app.aliaspaces.com",
  "https://mypersonas.online",
]);

function json(body: unknown, status = 200, origin = "") {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: {
      ...(origin && ORIGINS.has(origin)
        ? {
          "Access-Control-Allow-Origin": origin,
          "Access-Control-Allow-Headers":
            "authorization, x-client-info, apikey, content-type",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Vary": "Origin",
        }
        : {}),
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

async function caller(req: Request) {
  const auth = req.headers.get("Authorization") || "";
  if (!/^Bearer\s+\S+$/i.test(auth)) return null;
  const { data, error } = await admin.auth.getUser(
    auth.replace(/^Bearer\s+/i, ""),
  );
  return error ? null : data.user;
}

function uncertainProviderOutcome(error: unknown) {
  const name = String((error as { name?: string })?.name || "");
  return error instanceof TypeError || name === "AbortError" || name === "TimeoutError";
}

async function finishClaim(
  userId: string,
  draftId: string,
  patch: Record<string, unknown>,
) {
  return await admin.from("post_drafts").update({
    ...patch,
    publish_claimed_at: null,
    updated_at: new Date().toISOString(),
  }).eq("id", draftId).eq("owner", userId).eq("status", "publishing")
    .select("id,status,fb_post_id,ig_media_id").maybeSingle();
}

async function handlePublishDraft(
  userId: string,
  body: Record<string, unknown>,
  origin: string,
) {
  const draftId = String(body.draftId || "");
  if (!SAFE_UUID.test(draftId)) return json({ error: "A valid draftId is required." }, 400, origin);

  // The state transition is the concurrency guard. A second click/tab and the
  // scheduled worker both lose this compare-and-set before any provider call.
  const claimedAt = new Date().toISOString();
  const claim = await admin.from("post_drafts").update({
    status: "publishing", publish_claimed_at: claimedAt, updated_at: claimedAt,
  }).eq("id", draftId).eq("owner", userId)
    .in("status", ["draft", "approved", "failed"])
    .select(DRAFT_COLUMNS).maybeSingle();
  if (claim.error) return json({ error: "Could not claim the draft for publishing." }, 500, origin);
  if (!claim.data) {
    return json({ error: "This draft is scheduled, already publishing, or read-only. Reload it first." }, 409, origin);
  }
  const draft = claim.data as Draft;
  const targets = [...new Set((Array.isArray(draft.targets) ? draft.targets : []).map((v) => String(v).toLowerCase()))];
  const validationErrors: string[] = [];
  if (!targets.length || targets.some((target) => !["facebook", "instagram"].includes(target))) {
    validationErrors.push("Immediate publishing requires Facebook and/or Instagram only; remove X first.");
  }
  if (!draft.persona_id || isRestrictedMetaPersona(draft.persona_id)) {
    validationErrors.push("This persona is not eligible for Meta publishing.");
  } else {
    const persona = await admin.from("personas").select("id")
      .eq("id", draft.persona_id).eq("owner", userId).maybeSingle();
    if (persona.error || !persona.data) validationErrors.push("The draft persona is missing or not owned.");
  }
  if (!draft.facebook_ledger_id || !SAFE_ID.test(draft.facebook_ledger_id)) {
    validationErrors.push("The draft has no valid Facebook destination.");
  }
  if (targets.includes("facebook") && !/^https:\/\/\S+$/i.test(draft.fb_image_url || draft.source_image_url || "")) {
    validationErrors.push("Facebook needs a public HTTPS image.");
  }
  if (targets.includes("instagram") && !/^https:\/\/\S+$/i.test(draft.ig_image_url || draft.source_image_url || "")) {
    validationErrors.push("Instagram needs a public HTTPS image.");
  }
  if (validationErrors.length) {
    const finished = await finishClaim(userId, draftId, {
      status: "failed", last_error: validationErrors.join(" | "),
    });
    if (finished.error || !finished.data) {
      return json({ error: "Validation failed and the claimed row needs reconciliation." }, 500, origin);
    }
    return json({ status: "failed", errors: validationErrors }, 409, origin);
  }

  const ctx = await resolvePageContext(admin, userId, draft.facebook_ledger_id!);
  if (!ctx.ok) {
    const finished = await finishClaim(userId, draftId, { status: "failed", last_error: ctx.error });
    if (finished.error || !finished.data) {
      return json({ error: "The Meta check failed and the claimed row needs reconciliation." }, 500, origin);
    }
    return json({
      error: ctx.error,
      ...(ctx.missingScopes ? { postingNotEnabled: true, missingScopes: ctx.missingScopes } : {}),
    }, ctx.status, origin);
  }

  const errors: string[] = [];
  const out: { facebook?: { postId: string }; instagram?: { mediaId: string } } = {};
  let reconciliationRequired = false;

  if (targets.includes("facebook") && !draft.fb_post_id) {
    try {
      const result = await publishFacebook(
        ctx.asset.facebook_page_id,
        ctx.pageToken,
        draft.fb_image_url || draft.source_image_url || "",
        draft.fb_caption || "",
      );
      const saved = await admin.from("post_drafts").update({
        fb_post_id: result.postId,
        fb_published_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).eq("id", draftId).eq("owner", userId).eq("status", "publishing")
        .is("fb_post_id", null).select("id").maybeSingle();
      if (saved.error || !saved.data) {
        reconciliationRequired = true;
        errors.push(`Facebook accepted ${result.postId}, but the result was not saved.`);
      } else {
        draft.fb_post_id = result.postId;
        out.facebook = result;
      }
    } catch (error) {
      reconciliationRequired = uncertainProviderOutcome(error);
      errors.push(`Facebook: ${(error as Error).message}`);
    }
  }

  if (!reconciliationRequired && targets.includes("instagram") && !draft.ig_media_id) {
    if (!ctx.asset.instagram_business_id) {
      errors.push("Instagram: the selected Page has no linked professional account.");
    } else {
      try {
        const result = await publishInstagram(
          ctx.asset.instagram_business_id,
          ctx.pageToken,
          draft.ig_image_url || draft.source_image_url || "",
          draft.ig_caption || "",
        );
        const saved = await admin.from("post_drafts").update({
          ig_media_id: result.mediaId,
          ig_published_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }).eq("id", draftId).eq("owner", userId).eq("status", "publishing")
          .is("ig_media_id", null).select("id").maybeSingle();
        if (saved.error || !saved.data) {
          reconciliationRequired = true;
          errors.push(`Instagram accepted ${result.mediaId}, but the result was not saved.`);
        } else {
          draft.ig_media_id = result.mediaId;
          out.instagram = result;
        }
      } catch (error) {
        reconciliationRequired = uncertainProviderOutcome(error);
        errors.push(`Instagram: ${(error as Error).message}`);
      }
    }
  }

  if (reconciliationRequired) {
    const note = `Reconciliation required before retry. ${errors.join(" | ")}`;
    await admin.from("post_drafts").update({ last_error: note, updated_at: new Date().toISOString() })
      .eq("id", draftId).eq("owner", userId).eq("status", "publishing");
    return json({ status: "reconciliation_required", ...out, errors }, 502, origin);
  }

  const complete = (!targets.includes("facebook") || !!draft.fb_post_id) &&
    (!targets.includes("instagram") || !!draft.ig_media_id);
  const status = complete ? "posted" : "failed";
  const finished = await finishClaim(userId, draftId, {
    status,
    last_error: errors.join(" | ") || null,
    posted_at: complete ? new Date().toISOString() : null,
  });
  if (finished.error || !finished.data) {
    return json({ status: "reconciliation_required", ...out, errors: [
      ...errors, "Provider work finished, but the draft could not be finalized.",
    ] }, 500, origin);
  }
  await admin.from("agent_actions").insert({
    owner: userId,
    persona_id: draft.persona_id,
    action_type: "post_draft.manual_publish",
    entity_type: "post_draft",
    entity_id: draftId,
    outcome: status,
    detail: { targets, ...out, errors },
  });
  return json({ status, ...out, ...(errors.length ? { errors } : {}) }, complete ? 200 : 502, origin);
}

async function handleDelete(
  userId: string,
  body: Record<string, unknown>,
  origin: string,
) {
  const facebookLedgerId = String(body.facebookLedgerId || "");
  const postId = String(body.postId || "");
  if (!SAFE_ID.test(facebookLedgerId)) {
    return json({ error: "A valid facebookLedgerId is required." }, 400, origin);
  }
  if (!SAFE_POST_ID.test(postId)) {
    return json({ error: "A valid Facebook postId is required." }, 400, origin);
  }
  const pageIdFromPost = postId.includes("_") ? postId.split("_")[0] : "";

  // Cleanup remains available even when new publishing is policy-blocked.
  const ctx = await resolvePageContext(admin, userId, facebookLedgerId, false);
  if (!ctx.ok) return json({ error: ctx.error }, ctx.status, origin);
  if (pageIdFromPost && pageIdFromPost !== String(ctx.asset.facebook_page_id)) {
    return json({ error: "That post does not belong to the specified Page." }, 403, origin);
  }

  try {
    await graphDelete(`/${postId}`, ctx.pageToken);
  } catch (e) {
    return json({ error: (e as Error).message }, 502, origin);
  }
  return json({ deleted: true, postId }, 200, origin);
}

serve(async (req) => {
  const origin = req.headers.get("Origin") || "";
  if (req.method === "OPTIONS") return json(null, 204, origin);
  if (req.method !== "POST") return json({ error: "POST only" }, 405, origin);

  const user = await caller(req);
  if (!user) return json({ error: "Sign in first" }, 401, origin);

  const body = await req.json().catch(() => ({})) as Record<string, unknown>;
  const action = String(body.action || "");
  if (action === "publish-draft") return await handlePublishDraft(user.id, body, origin);
  if (action === "publish") {
    return json({ error: "Direct image publishing is retired; publish an owner-scoped draft instead." }, 410, origin);
  }
  if (action === "delete") return await handleDelete(user.id, body, origin);
  return json({ error: "Unknown action" }, 400, origin);
});
