// approve-post-draft — owner-authenticated immutable-media scheduling boundary.
//
// The browser sends captions, targets, and a future time. This function reads
// the owner's current draft, fetches each exact target image, stores the bytes
// in the service-role-only content-addressed bucket, then invokes the internal
// scheduling RPC with the verified digest/MIME/size/path/URL metadata.
//
// Contract (POST, owner bearer token):
//   prepare-schedule: exact proposal -> immutable server-authored receipt
//   commit-schedule: { action, draftId, receiptId } -> scheduled draft
// The AAL2 owner acknowledgement between those calls is a separate SQL RPC.

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  type ApprovedMedia,
  stageApprovedMedia,
} from "../_shared/approved-media.ts";
import { requireAal2 } from "../_shared/aal2.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SAFE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

function sourceFor(draft: Record<string, unknown>, target: "facebook" | "instagram") {
  const targetUrl = target === "facebook"
    ? String(draft.fb_image_url || "")
    : String(draft.ig_image_url || "");
  return targetUrl || String(draft.source_image_url || "");
}

function mediaArgs(prefix: "fb" | "ig", media?: ApprovedMedia) {
  return {
    [`p_${prefix}_media_sha256`]: media?.sha256 || "",
    [`p_${prefix}_media_mime`]: media?.mime || "",
    [`p_${prefix}_media_bytes`]: media?.byteSize || 0,
    [`p_${prefix}_media_path`]: media?.path || "",
    [`p_${prefix}_media_url`]: media?.url || "",
  };
}

serve(async (req) => {
  const origin = req.headers.get("Origin") || "";
  if (req.method === "OPTIONS") return json(null, 204, origin);
  if (req.method !== "POST") return json({ error: "POST only" }, 405, origin);

  const contentLength = Number(req.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > 64 * 1024) {
    return json({ error: "Request body is too large." }, 413, origin);
  }
  const guard = await requireAal2(req, admin);
  if (!guard.ok) {
    return json({ error: guard.error, code: guard.code }, guard.status, origin);
  }
  const user = guard.user;

  const body = await req.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return json({ error: "A JSON request body is required." }, 400, origin);
  const action = String(body.action || "").trim();
  const draftId = String(body.draftId || "");
  if (!SAFE_UUID.test(draftId)) {
    return json({ error: "A valid draftId is required." }, 400, origin);
  }
  if (["previewConfirmed", "previewVersion", "previewFacebookPageId",
    "previewInstagramBusinessId"].some((key) => key in body)) {
    return json({
      error: "Raw preview confirmations and browser-supplied provider targets are not accepted.",
    }, 400, origin);
  }
  if (action === "commit-schedule") {
    const receiptId = String(body.receiptId || "");
    if (!SAFE_UUID.test(receiptId)) {
      return json({ error: "A valid acknowledged receiptId is required." }, 400, origin);
    }
    const committed = await admin.rpc(
      "consume_acknowledged_post_draft_schedule_preview_service",
      { p_owner: user.id, p_draft_id: draftId, p_receipt_id: receiptId },
    );
    const draft = Array.isArray(committed.data) ? committed.data[0] : committed.data;
    if (committed.error || !draft) {
      return json({
        error: committed.error?.message ||
          "The acknowledged preview expired, was used, or no longer matches. Nothing was scheduled.",
      }, 409, origin);
    }
    return json({ draft }, 200, origin);
  }
  if (action !== "prepare-schedule") {
    return json({ error: "Choose prepare-schedule or commit-schedule." }, 400, origin);
  }
  const scheduledFor = String(body.scheduledFor || "");
  const timezone = String(body.timezone || "").trim();
  const fbCaption = String(body.fbCaption || "");
  const igCaption = String(body.igCaption || "");
  const xCaption = String(body.xCaption || "");
  if (!scheduledFor || !Number.isFinite(Date.parse(scheduledFor))) {
    return json({ error: "A valid scheduledFor timestamp is required." }, 400, origin);
  }
  if (!timezone || timezone.length > 128) {
    return json({ error: "A valid timezone is required." }, 400, origin);
  }
  if (fbCaption.length > 5000 || igCaption.length > 2200 || xCaption.length > 280) {
    return json({ error: "One or more captions exceed the platform limit." }, 400, origin);
  }
  const targets = [...new Set(
    (Array.isArray(body.targets) ? body.targets : [])
      .map((target) => String(target).trim().toLowerCase())
      .filter(Boolean),
  )].sort();
  if (!targets.length || targets.some((target) => !["facebook", "instagram"].includes(target))) {
    return json({ error: "Scheduling requires Facebook and/or Instagram only." }, 400, origin);
  }

  const loaded = await admin.from("post_drafts")
    .select("id,status,owner,source_image_url,fb_image_url,ig_image_url,fb_post_id,ig_media_id,x_tweet_id")
    .eq("id", draftId).eq("owner", user.id).maybeSingle();
  if (loaded.error) return json({ error: "Could not load the draft." }, 500, origin);
  if (!loaded.data) return json({ error: "Draft not found." }, 404, origin);
  const draft = loaded.data as Record<string, unknown>;
  if (!["draft", "approved", "failed"].includes(String(draft.status)) ||
    draft.fb_post_id || draft.ig_media_id || draft.x_tweet_id) {
    return json({ error: "This draft can no longer be scheduled." }, 409, origin);
  }

  const facebookSource = targets.includes("facebook")
    ? sourceFor(draft, "facebook")
    : "";
  const instagramSource = targets.includes("instagram")
    ? sourceFor(draft, "instagram")
    : "";
  if (targets.includes("facebook") && !facebookSource) {
    return json({ error: "Facebook needs an image before approval." }, 409, origin);
  }
  if (targets.includes("instagram") && !instagramSource) {
    return json({ error: "Instagram needs an image before approval." }, 409, origin);
  }

  try {
    const staged = new Map<string, Promise<ApprovedMedia>>();
    const stage = (source: string) => {
      let pending = staged.get(source);
      if (!pending) {
        pending = stageApprovedMedia(admin.storage, SUPABASE_URL, source, user.id);
        staged.set(source, pending);
      }
      return pending;
    };
    const [facebookMedia, instagramMedia] = await Promise.all([
      facebookSource ? stage(facebookSource) : Promise.resolve(undefined),
      instagramSource ? stage(instagramSource) : Promise.resolve(undefined),
    ]);

    const issued = await admin.rpc("issue_post_draft_schedule_preview_receipt_service", {
      p_owner: user.id,
      p_draft_id: draftId,
      p_scheduled_for: scheduledFor,
      p_timezone: timezone,
      p_fb_caption: fbCaption,
      p_ig_caption: igCaption,
      p_x_caption: xCaption,
      p_targets: targets,
      p_fb_source_url: facebookSource,
      p_ig_source_url: instagramSource,
      ...mediaArgs("fb", facebookMedia),
      ...mediaArgs("ig", instagramMedia),
    });
    const receipt = Array.isArray(issued.data) ? issued.data[0] : issued.data;
    if (issued.error || !receipt) {
      const message = issued.error?.message || "The exact staged preview could not be created.";
      const status = /no longer|changed|future|unavailable|not found/i.test(message) ? 409 : 422;
      return json({ error: message }, status, origin);
    }
    return json({ receipt }, 200, origin);
  } catch (error) {
    return json({ error: (error as Error).message }, 422, origin);
  }
});
