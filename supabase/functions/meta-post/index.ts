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
  providerOutcomeIsUncertain,
  publishFacebook,
  publishInstagram,
  resolvePageContext,
} from "../_shared/meta-publish.ts";
import {
  type ApprovedMedia,
  approvedMediaDeliveryUrl,
  approvedMediaProviderUrl,
  stageApprovedMedia,
  stageApprovedPersonaMediaAsset,
  verifyApprovedMedia,
} from "../_shared/approved-media.ts";
import { loadMediaEnvironmentConfig } from "../_shared/public-media.ts";

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
  source_media_asset_id: string | null;
  fb_media_asset_id: string | null;
  ig_media_asset_id: string | null;
  fb_caption: string | null;
  ig_caption: string | null;
  fb_post_id: string | null;
  ig_media_id: string | null;
  approved_content_hash: string;
  approved_fb_media_sha256: string;
  approved_fb_media_mime: ApprovedMedia["mime"] | "";
  approved_fb_media_bytes: number;
  approved_fb_media_path: string;
  approved_fb_media_url: string;
  approved_fb_delivery_id: string | null;
  approved_ig_media_sha256: string;
  approved_ig_media_mime: ApprovedMedia["mime"] | "";
  approved_ig_media_bytes: number;
  approved_ig_media_path: string;
  approved_ig_media_url: string;
  approved_ig_delivery_id: string | null;
  publish_facebook_page_id: string;
  publish_instagram_business_id: string;
};

const DRAFT_COLUMNS = [
  "id", "owner", "persona_id", "facebook_ledger_id", "status", "targets",
  "source_image_url", "fb_image_url", "ig_image_url", "fb_caption", "ig_caption",
  "source_media_asset_id", "fb_media_asset_id", "ig_media_asset_id",
  "fb_post_id", "ig_media_id", "approved_content_hash",
  "approved_fb_media_sha256", "approved_fb_media_mime", "approved_fb_media_bytes",
  "approved_fb_media_path", "approved_fb_media_url", "approved_fb_delivery_id", "approved_ig_media_sha256",
  "approved_ig_media_mime", "approved_ig_media_bytes", "approved_ig_media_path",
  "approved_ig_media_url", "approved_ig_delivery_id", "publish_facebook_page_id",
  "publish_instagram_business_id",
].join(",");

function approvedMediaFor(
  draft: Draft,
  target: "facebook" | "instagram",
  publicMediaOrigin: string,
): ApprovedMedia {
  return target === "facebook"
    ? {
      sha256: draft.approved_fb_media_sha256,
      mime: draft.approved_fb_media_mime as ApprovedMedia["mime"],
      byteSize: draft.approved_fb_media_bytes,
      path: draft.approved_fb_media_path,
      url: draft.approved_fb_media_url,
      deliveryId: draft.approved_fb_delivery_id || "",
      deliveryUrl: draft.approved_fb_delivery_id
        ? approvedMediaDeliveryUrl(draft.approved_fb_delivery_id, publicMediaOrigin)
        : "",
    }
    : {
      sha256: draft.approved_ig_media_sha256,
      mime: draft.approved_ig_media_mime as ApprovedMedia["mime"],
      byteSize: draft.approved_ig_media_bytes,
      path: draft.approved_ig_media_path,
      url: draft.approved_ig_media_url,
      deliveryId: draft.approved_ig_delivery_id || "",
      deliveryUrl: draft.approved_ig_delivery_id
        ? approvedMediaDeliveryUrl(draft.approved_ig_delivery_id, publicMediaOrigin)
        : "",
    };
}

function hasApprovedMediaSnapshot(media: ApprovedMedia) {
  return Boolean(
    media.sha256 || media.mime || media.byteSize || media.path || media.url,
  );
}

class PublishingPauseError extends Error {
  override name = "PublishingPauseError";
}

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

async function ownerPauseState(owner: string) {
  const result = await admin.from("agent_owner_settings")
    .select("automation_paused").eq("owner", owner).maybeSingle();
  return {
    available: !result.error && !!result.data,
    paused: result.data?.automation_paused === true,
  };
}

function pauseMessage(state: { available: boolean; paused: boolean }) {
  return state.paused
    ? "Owner automation is paused."
    : "Owner automation settings are unavailable.";
}

async function requireOwnerPublishingUnpaused(owner: string) {
  const state = await ownerPauseState(owner);
  if (!state.available || state.paused) {
    throw new PublishingPauseError(pauseMessage(state));
  }
}

async function ensureImmutableAttemptMedia(
  draft: Draft,
  targets: string[],
  publicMediaOrigin: string,
): Promise<Draft> {
  const patch: Record<string, unknown> = {};
  for (const target of targets) {
    if (target !== "facebook" && target !== "instagram") continue;
    let media = approvedMediaFor(draft, target, publicMediaOrigin);
    const hasSnapshot = hasApprovedMediaSnapshot(media);
    const providerId = target === "facebook" ? draft.fb_post_id : draft.ig_media_id;
    if (!hasSnapshot) {
      if (draft.approved_content_hash) {
        throw new Error(`${target}: exact approval has no immutable media snapshot.`);
      }
      if (providerId) {
        throw new Error(`${target}: a provider result has no immutable media snapshot; reconciliation is required.`);
      }
      const source = target === "facebook"
        ? draft.fb_image_url || draft.source_image_url || ""
        : draft.ig_image_url || draft.source_image_url || "";
      const assetId = target === "facebook"
        ? draft.fb_media_asset_id || draft.source_media_asset_id || ""
        : draft.ig_media_asset_id || draft.source_media_asset_id || "";
      media = assetId
        ? await stageApprovedPersonaMediaAsset(
          admin, SUPABASE_URL, SERVICE_ROLE_KEY, assetId, draft.owner,
        )
        : await stageApprovedMedia(
          admin, SUPABASE_URL, source, draft.owner,
        );
    }
    await verifyApprovedMedia(admin, SUPABASE_URL, media, draft.owner, publicMediaOrigin);
    const prefix = target === "facebook" ? "approved_fb_media" : "approved_ig_media";
    patch[`${prefix}_sha256`] = media.sha256;
    patch[`${prefix}_mime`] = media.mime;
    patch[`${prefix}_bytes`] = media.byteSize;
    patch[`${prefix}_path`] = media.path;
    patch[`${prefix}_url`] = media.url;
    patch[`${prefix.replace("media", "delivery")}_id`] = media.deliveryId || null;
    patch[target === "facebook" ? "fb_image_url" : "ig_image_url"] = media.url;
  }

  const saved = await admin.from("post_drafts").update({
    ...patch,
    updated_at: new Date().toISOString(),
  }).eq("id", draft.id).eq("owner", draft.owner).eq("status", "publishing")
    .select(DRAFT_COLUMNS).maybeSingle();
  if (saved.error || !saved.data) {
    throw new Error("The immutable publish-attempt media snapshot could not be saved.");
  }
  const persisted = saved.data as unknown as Draft;
  for (const target of targets) {
    if (target !== "facebook" && target !== "instagram") continue;
    const media = approvedMediaFor(persisted, target, publicMediaOrigin);
    await verifyApprovedMedia(admin, SUPABASE_URL, media, draft.owner, publicMediaOrigin);
    const rowUrl = target === "facebook"
      ? persisted.fb_image_url
      : persisted.ig_image_url;
    if (rowUrl !== media.url) {
      throw new Error(`${target}: the immutable publish-attempt URL was not persisted.`);
    }
  }
  return persisted;
}

async function finishClaim(
  userId: string,
  draftId: string,
  status: "posted" | "failed",
  lastError: string,
  detail: Record<string, unknown>,
) {
  return await admin.rpc("finalize_post_draft_publish", {
    p_draft_id: draftId,
    p_owner: userId,
    p_status: status,
    p_last_error: lastError,
    p_action_type: "post_draft.manual_publish",
    p_detail: detail,
  });
}

async function noteReconciliation(
  userId: string,
  draftId: string,
  note: string,
  detail: Record<string, unknown>,
) {
  return await admin.rpc("note_post_draft_reconciliation", {
    p_draft_id: draftId,
    p_owner: userId,
    p_note: note,
    p_action_type: "post_draft.manual_publish",
    p_detail: detail,
  });
}

async function handlePublishDraft(
  userId: string,
  body: Record<string, unknown>,
  origin: string,
) {
  const draftId = String(body.draftId || "");
  if (!SAFE_UUID.test(draftId)) return json({ error: "A valid draftId is required." }, 400, origin);
  let mediaEnvironment;
  try {
    mediaEnvironment = await loadMediaEnvironmentConfig(admin, SUPABASE_URL);
  } catch {
    return json({ error: "Secure media delivery is unavailable." }, 503, origin);
  }

  // The global owner stop applies to interactive publishing too. Check once
  // before taking the row and again after the atomic claim to close the race.
  const pauseBeforeClaim = await ownerPauseState(userId);
  if (!pauseBeforeClaim.available || pauseBeforeClaim.paused) {
    return json({ error: pauseMessage(pauseBeforeClaim), paused: pauseBeforeClaim.paused },
      pauseBeforeClaim.paused ? 409 : 503, origin);
  }

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
  let draft = claim.data as unknown as Draft;
  const pauseAfterClaim = await ownerPauseState(userId);
  if (!pauseAfterClaim.available || pauseAfterClaim.paused) {
    const message = pauseMessage(pauseAfterClaim);
    const finished = await finishClaim(
      userId, draftId, "failed", message,
      { phase: "pause_after_claim", errors: [message] },
    );
    if (finished.error || !finished.data) {
      return json({ status: "publishing", reconciliationRequired: true, error: message }, 500, origin);
    }
    return json({ status: "failed", error: message, paused: pauseAfterClaim.paused },
      pauseAfterClaim.paused ? 409 : 503, origin);
  }
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
  if (targets.includes("facebook") && !draft.fb_media_asset_id && !draft.source_media_asset_id &&
    !/^https:\/\/\S+$/i.test(draft.fb_image_url || draft.source_image_url || "")) {
    validationErrors.push("Facebook needs a public HTTPS image.");
  }
  if (targets.includes("instagram") && !draft.ig_media_asset_id && !draft.source_media_asset_id &&
    !/^https:\/\/\S+$/i.test(draft.ig_image_url || draft.source_image_url || "")) {
    validationErrors.push("Instagram needs a public HTTPS image.");
  }
  if (validationErrors.length) {
    const finished = await finishClaim(
      userId, draftId, "failed", validationErrors.join(" | "),
      { targets, errors: validationErrors, phase: "validation" },
    );
    if (finished.error || !finished.data) {
      return json({ status: "publishing", reconciliationRequired: true,
        error: "Validation failed and the claimed row could not be finalized." }, 500, origin);
    }
    return json({ status: "failed", errors: validationErrors }, 409, origin);
  }

  // Every interactive attempt gets an immutable, content-addressed media
  // snapshot before destination credentials or providers are touched. A retry
  // with an existing snapshot verifies and reuses it, ignoring mutable source
  // URLs. The platform URL columns are pinned to the canonical snapshot too.
  try {
    draft = await ensureImmutableAttemptMedia(
      draft,
      targets,
      mediaEnvironment.publicMediaOrigin,
    );
  } catch (error) {
    validationErrors.push((error as Error).message);
    const finished = await finishClaim(
      userId, draftId, "failed", validationErrors.join(" | "),
      { targets, errors: validationErrors, phase: "attempt_media" },
    );
    if (finished.error || !finished.data) {
      return json({ status: "publishing", reconciliationRequired: true,
        error: "Attempt media failed verification and the claim could not be finalized." }, 500, origin);
    }
    return json({ status: "failed", errors: validationErrors }, 409, origin);
  }

  const ctx = await resolvePageContext(admin, userId, draft.facebook_ledger_id!);
  if (!ctx.ok) {
    const finished = await finishClaim(
      userId, draftId, "failed", ctx.error,
      { targets, errors: [ctx.error], phase: "destination" },
    );
    if (finished.error || !finished.data) {
      return json({ status: "publishing", reconciliationRequired: true,
        error: "The Meta check failed and the claimed row could not be finalized." }, 500, origin);
    }
    return json({
      error: ctx.error,
      ...(ctx.missingScopes ? { postingNotEnabled: true, missingScopes: ctx.missingScopes } : {}),
    }, ctx.status, origin);
  }

  const errors: string[] = [];
  const out: { facebook?: { postId: string }; instagram?: { mediaId: string } } = {};
  let reconciliationRequired = false;
  let publishingBlocked = false;

  const resolvedFacebookId = String(ctx.asset.facebook_page_id);
  const resolvedInstagramId = targets.includes("instagram")
    ? String(ctx.asset.instagram_business_id || "")
    : "";
  if (draft.publish_facebook_page_id && draft.publish_facebook_page_id !== resolvedFacebookId) {
    errors.push("The Facebook destination changed after this publish attempt began.");
  }
  if (draft.publish_instagram_business_id &&
    draft.publish_instagram_business_id !== resolvedInstagramId) {
    errors.push("The Instagram destination changed after this publish attempt began.");
  }
  if ((draft.fb_post_id || draft.ig_media_id) &&
    (!draft.publish_facebook_page_id ||
      (targets.includes("instagram") && !draft.publish_instagram_business_id))) {
    reconciliationRequired = true;
    errors.push("A legacy provider result has no immutable destination snapshot.");
  }
  if (errors.length && !reconciliationRequired) {
    const finished = await finishClaim(
      userId, draftId, "failed", errors.join(" | "),
      { targets, errors, phase: "destination_snapshot" },
    );
    if (finished.error || !finished.data) {
      return json({ status: "publishing", reconciliationRequired: true, errors }, 500, origin);
    }
    return json({ status: "failed", errors }, 409, origin);
  }
  if (!reconciliationRequired && !draft.publish_facebook_page_id) {
    const snap = await admin.from("post_drafts").update({
      publish_facebook_page_id: resolvedFacebookId,
      publish_instagram_business_id: resolvedInstagramId,
      updated_at: new Date().toISOString(),
    }).eq("id", draftId).eq("owner", userId).eq("status", "publishing")
      .eq("publish_facebook_page_id", "").eq("publish_instagram_business_id", "")
      .select("id").maybeSingle();
    if (snap.error || !snap.data) {
      reconciliationRequired = true;
      errors.push("The immutable destination snapshot could not be saved.");
    } else {
      draft.publish_facebook_page_id = resolvedFacebookId;
      draft.publish_instagram_business_id = resolvedInstagramId;
    }
  }

  if (!reconciliationRequired && targets.includes("facebook") && !draft.fb_post_id) {
    try {
      await requireOwnerPublishingUnpaused(userId);
      const result = await publishFacebook(
        ctx.asset.facebook_page_id,
        ctx.pageToken,
        approvedMediaProviderUrl(approvedMediaFor(
          draft,
          "facebook",
          mediaEnvironment.publicMediaOrigin,
        )),
        draft.fb_caption || "",
        () => requireOwnerPublishingUnpaused(userId),
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
      if (error instanceof PublishingPauseError) publishingBlocked = true;
      reconciliationRequired = providerOutcomeIsUncertain(error);
      errors.push(`Facebook: ${(error as Error).message}`);
    }
  }

  if (!reconciliationRequired && !publishingBlocked && targets.includes("instagram") && !draft.ig_media_id) {
    if (!ctx.asset.instagram_business_id) {
      errors.push("Instagram: the selected Page has no linked professional account.");
    } else {
      try {
        await requireOwnerPublishingUnpaused(userId);
        const result = await publishInstagram(
          ctx.asset.instagram_business_id,
          ctx.pageToken,
          approvedMediaProviderUrl(approvedMediaFor(
            draft,
            "instagram",
            mediaEnvironment.publicMediaOrigin,
          )),
          draft.ig_caption || "",
          () => requireOwnerPublishingUnpaused(userId),
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
        if (error instanceof PublishingPauseError) publishingBlocked = true;
        reconciliationRequired = providerOutcomeIsUncertain(error);
        errors.push(`Instagram: ${(error as Error).message}`);
      }
    }
  }

  if (reconciliationRequired) {
    const note = `Reconciliation required before retry. ${errors.join(" | ")}`;
    const noted = await noteReconciliation(userId, draftId, note, {
      targets, ...out, errors,
      facebookPageId: draft.publish_facebook_page_id || resolvedFacebookId,
      instagramBusinessId: draft.publish_instagram_business_id || resolvedInstagramId,
    });
    return json({
      status: "publishing", reconciliationRequired: true, ...out,
      errors: noted.error || !noted.data ? [...errors, "The reconciliation audit could not be saved."] : errors,
    }, 502, origin);
  }

  const complete = (!targets.includes("facebook") || !!draft.fb_post_id) &&
    (!targets.includes("instagram") || !!draft.ig_media_id);
  const status = complete ? "posted" : "failed";
  const finished = await finishClaim(
    userId, draftId, status, errors.join(" | "),
    { targets, ...out, errors, facebookPageId: resolvedFacebookId, instagramBusinessId: resolvedInstagramId },
  );
  if (finished.error || !finished.data) {
    return json({ status: "publishing", reconciliationRequired: true, ...out, errors: [
      ...errors, "Provider work finished, but the draft could not be finalized.",
    ] }, 500, origin);
  }
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
