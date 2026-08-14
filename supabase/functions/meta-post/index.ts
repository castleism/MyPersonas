// meta-post — interactive Facebook Page + Instagram publisher / manager.
//
// Thin owner-authenticated HTTP layer over _shared/meta-publish.ts (the same
// publish primitives the scheduled publisher uses). Owner-scoped + scope-gated:
// posting to the owner's OWN pages/IG works in development mode without App Review;
// App Review is only for posting on behalf of other people. See APP-REVIEW-META.md.
//
// Actions (POST, owner bearer token):
//   { action:"publish", facebookLedgerId, imageUrl, caption?, target? }
//     target: "facebook" | "instagram" | "both" (default "both")
//     -> { facebook?: {postId}, instagram?: {mediaId} }
//   { action:"delete", facebookLedgerId, postId }
//     -> { deleted:true }   (Facebook Page posts only — the IG API can't delete media.)
//
// Deploy: supabase functions deploy meta-post --project-ref nwsqyuucwzihruszocge
// Required secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, META_APP_SECRET

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  graphDelete,
  publishToMeta,
  resolvePageContext,
} from "../_shared/meta-publish.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const IG_CAPTION_MAX = 2200;
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const SAFE_POST_ID = /^[0-9_]{1,64}$/;

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

async function handlePublish(
  userId: string,
  body: Record<string, unknown>,
  origin: string,
) {
  const facebookLedgerId = String(body.facebookLedgerId || "");
  const imageUrl = String(body.imageUrl || "");
  const caption = typeof body.caption === "string"
    ? body.caption.slice(0, IG_CAPTION_MAX)
    : "";
  const target = ["facebook", "instagram", "both"].includes(String(body.target))
    ? String(body.target)
    : "both";

  if (!SAFE_ID.test(facebookLedgerId)) {
    return json({ error: "A valid facebookLedgerId is required." }, 400, origin);
  }
  if (!/^https:\/\/\S+$/i.test(imageUrl)) {
    return json({ error: "A public https imageUrl is required." }, 400, origin);
  }

  try {
    const { ctx, out } = await publishToMeta(
      admin,
      userId,
      facebookLedgerId,
      imageUrl,
      caption,
      target,
    );
    if (!ctx.ok) {
      return json({
        error: ctx.error,
        ...(ctx.missingScopes
          ? { postingNotEnabled: true, missingScopes: ctx.missingScopes }
          : {}),
      }, ctx.status, origin);
    }
    if (!out || (out.facebook === undefined && out.instagram === undefined)) {
      return json(
        { error: "Nothing was published (no eligible target for this asset)." },
        400,
        origin,
      );
    }
    return json(out, 200, origin);
  } catch (e) {
    return json({ error: (e as Error).message }, 502, origin);
  }
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

  const ctx = await resolvePageContext(admin, userId, facebookLedgerId);
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
  if (action === "publish") return await handlePublish(user.id, body, origin);
  if (action === "delete") return await handleDelete(user.id, body, origin);
  return json({ error: "Unknown action" }, 400, origin);
});
