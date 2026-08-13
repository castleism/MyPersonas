// meta-post — Facebook Page + Instagram publisher.
//
// Publishes an owner-approved image post to a paired Facebook Page and/or its
// linked Instagram professional account. It is owner-scoped and scope-gated:
//   • the caller must own the paired asset (meta_page_connections.owner),
//   • the grant must carry the publish scopes (pages_manage_posts,
//     instagram_content_publish, business_management) — these are standard-access
//     permissions granted through the Login-for-Business config, so posting to the
//     owner's OWN pages/IG works in development mode without App Review. App Review
//     is only needed to post on behalf of other people. See APP-REVIEW-META.md.
//
// It never stores Page tokens: it retrieves the durable user token for the grant
// (meta_get_grant_token_bundle, the same record meta-oauth writes at finalize) and
// derives a fresh Page token at publish time.
//
// Contract (POST, owner bearer token):
//   { action:"publish", facebookLedgerId, imageUrl, caption?, target? }
//     facebookLedgerId: the FB (or linked IG) ledger id of the paired asset
//     imageUrl:         a public https image URL (Meta fetches it server-side)
//     target:           "facebook" | "instagram" | "both" (default "both")
//   -> { facebook?: {postId}, instagram?: {mediaId} }  (only the targets that ran)
//
// Deploy: supabase functions deploy meta-post --project-ref nwsqyuucwzihruszocge
// Required secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, META_APP_SECRET
// Optional: META_GRAPH_API_VERSION

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const META_APP_SECRET = Deno.env.get("META_APP_SECRET") || "";
const GRAPH = `https://graph.facebook.com/${
  Deno.env.get("META_GRAPH_API_VERSION") || "v25.0"
}`;

// Standard-access publish scopes the grant must carry to post.
const PUBLISH_SCOPES = [
  "pages_manage_posts",
  "instagram_content_publish",
  "business_management",
] as const;

const IG_CAPTION_MAX = 2200;
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/; // ledger ids are uuids; guards the .or() filter

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

async function appSecretProof(token: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(META_APP_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(token)),
  );
  return [...sig].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function caller(req: Request) {
  const auth = req.headers.get("Authorization") || "";
  if (!/^Bearer\s+\S+$/i.test(auth)) return null;
  const { data, error } = await admin.auth.getUser(
    auth.replace(/^Bearer\s+/i, ""),
  );
  return error ? null : data.user;
}

async function graphGet(
  path: string,
  token: string,
  params: Record<string, string>,
) {
  const url = new URL(`${GRAPH}${path}`);
  const sp = new URLSearchParams(params);
  sp.set("access_token", token);
  sp.set("appsecret_proof", await appSecretProof(token));
  url.search = sp.toString();
  const r = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = (j as { error?: { message?: string } })?.error?.message ||
      `Meta rejected the request (HTTP ${r.status})`;
    throw new Error(msg);
  }
  return j as Record<string, unknown>;
}

async function graphPost(
  path: string,
  token: string,
  params: Record<string, string>,
) {
  const url = new URL(`${GRAPH}${path}`);
  const body = new URLSearchParams(params);
  body.set("access_token", token);
  body.set("appsecret_proof", await appSecretProof(token));
  const r = await fetch(url, {
    method: "POST",
    body,
    signal: AbortSignal.timeout(30_000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = (j as { error?: { message?: string } })?.error?.message ||
      `Meta rejected the publish (HTTP ${r.status})`;
    throw new Error(msg);
  }
  return j as Record<string, unknown>;
}

// A Page token derived fresh from the durable user token (never stored here).
async function getPageToken(pageId: string, userToken: string) {
  const j = await graphGet(`/${pageId}`, userToken, { fields: "access_token" });
  const token = typeof j.access_token === "string" ? j.access_token.trim() : "";
  if (!token) throw new Error("Could not obtain a Page access token.");
  return token;
}

// Instagram content publishing: create a media container, then publish it.
// image_url must be a public https URL; the Page token manages the linked IG.
async function publishInstagram(
  igUserId: string,
  pageToken: string,
  imageUrl: string,
  caption: string,
) {
  const container = await graphPost(`/${igUserId}/media`, pageToken, {
    image_url: imageUrl,
    ...(caption ? { caption } : {}),
  });
  const creationId = String(container.id || "");
  if (!creationId) throw new Error("Instagram did not return a media container.");
  const published = await graphPost(`/${igUserId}/media_publish`, pageToken, {
    creation_id: creationId,
  });
  return { mediaId: String(published.id || "") };
}

// Facebook Page photo post.
async function publishFacebook(
  pageId: string,
  pageToken: string,
  imageUrl: string,
  caption: string,
) {
  const res = await graphPost(`/${pageId}/photos`, pageToken, {
    url: imageUrl,
    ...(caption ? { caption } : {}),
    published: "true",
  });
  return { postId: String(res.post_id || res.id || "") };
}

serve(async (req) => {
  const origin = req.headers.get("Origin") || "";
  if (req.method === "OPTIONS") return json(null, 204, origin);
  if (req.method !== "POST") return json({ error: "POST only" }, 405, origin);

  const user = await caller(req);
  if (!user) return json({ error: "Sign in first" }, 401, origin);

  const body = await req.json().catch(() => ({})) as Record<string, unknown>;
  if (body.action !== "publish") {
    return json({ error: "Unknown action" }, 400, origin);
  }

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

  // The paired asset must belong to the caller (owner-scoped).
  const { data: asset, error: assetErr } = await admin
    .from("meta_page_connections")
    .select(
      "owner,grant_id,facebook_page_id,facebook_page_name,instagram_business_id,instagram_username",
    )
    .eq("owner", user.id)
    .or(
      `facebook_ledger_id.eq.${facebookLedgerId},instagram_ledger_id.eq.${facebookLedgerId}`,
    )
    .maybeSingle();
  if (assetErr) {
    return json({ error: "Could not look up the Meta connection." }, 500, origin);
  }
  if (!asset) {
    return json(
      { error: "That paired Meta page was not found for your account." },
      404,
      origin,
    );
  }

  // The grant must carry every publish scope.
  const { data: grant } = await admin.from("meta_grants")
    .select("granted_scopes")
    .eq("id", asset.grant_id)
    .eq("owner", user.id)
    .maybeSingle();
  const granted = new Set(
    Array.isArray(grant?.granted_scopes) ? grant!.granted_scopes : [],
  );
  const missing = PUBLISH_SCOPES.filter((s) => !granted.has(s));
  if (missing.length) {
    return json({
      error:
        "Publishing isn't enabled for this account: the connection is missing " +
        "the publish permissions. Reconnect Meta to grant them.",
      postingNotEnabled: true,
      missingScopes: missing,
    }, 409, origin);
  }

  // Retrieve the durable user token (same record meta-oauth writes at finalize),
  // then derive a fresh Page token from it.
  const cred = await admin.rpc("meta_get_grant_token_bundle", {
    p_grant_id: asset.grant_id,
    p_owner: user.id,
  });
  const row = Array.isArray(cred.data)
    ? cred.data[0] as { token_bundle?: { access_token?: string } } | undefined
    : undefined;
  const userToken = String(row?.token_bundle?.access_token || "");
  if (cred.error || !userToken) {
    return json(
      { error: "Could not retrieve the Meta credential for this page." },
      502,
      origin,
    );
  }

  let pageToken: string;
  try {
    pageToken = await getPageToken(String(asset.facebook_page_id), userToken);
  } catch (e) {
    return json({ error: (e as Error).message }, 502, origin);
  }

  const out: { facebook?: unknown; instagram?: unknown } = {};
  try {
    if (target !== "facebook" && asset.instagram_business_id) {
      out.instagram = await publishInstagram(
        String(asset.instagram_business_id),
        pageToken,
        imageUrl,
        caption,
      );
    }
    if (target !== "instagram") {
      out.facebook = await publishFacebook(
        String(asset.facebook_page_id),
        pageToken,
        imageUrl,
        caption,
      );
    }
  } catch (e) {
    // Return whatever already published plus the failure (so a partial IG+FB
    // post isn't silently lost).
    return json(
      { error: (e as Error).message, ...out, partial: true },
      502,
      origin,
    );
  }

  if (out.facebook === undefined && out.instagram === undefined) {
    return json(
      { error: "Nothing was published (no eligible target for this asset)." },
      400,
      origin,
    );
  }
  return json(out, 200, origin);
});
