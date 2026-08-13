// meta-post — Facebook Page + Instagram publisher (SCAFFOLD, gated OFF).
//
// STATUS: not production-ready and NOT wired live. It is shape-correct (the real
// IG two-step publish + FB feed/photo calls) but will refuse to post until:
//   1) meta-oauth requests the publish scopes (pages_manage_posts,
//      instagram_content_publish, business_management) — see APP-REVIEW-META.md,
//   2) Meta App Review approves those scopes for this app,
//   3) the grant actually carries them (checked at runtime below), and
//   4) it's integration-tested against a real Page/IG and wired into
//      run-publish-queue as the "meta" destination.
// Until then every call returns 409 postingNotEnabled, so deploying it is safe.
//
// Contract (POST, owner bearer token):
//   { action:"publish", facebookLedgerId, imageUrl, caption?, target? }
//     target: "facebook" | "instagram" | "both" (default "both" where paired)
//   -> { facebook?: {postId}, instagram?: {mediaId}, skipped?: [...] }
//
// Deploy (later): supabase functions deploy meta-post
// Requires secrets: M="MENV" MENV: SUPABASE_URL, SERVICE_ROLE_KEY, META_APP_ID, META_APP_SECRET

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const META_APP_SECRET = Deno.env.get("META_APP_SECRET") || "";
const GRAPH = `https://graph.facebook.com/${
  Deno.env.get("META_GRAPH_API_VERSION") || "v25.0"
}`;

// Advanced-access scopes that must be granted (post App Review) for publishing.
const PUBLISH_SCOPES = [
  "pages_manage_posts",
  "instagram_content_publish",
  "business_management",
] as const;

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
  return new Response(JSON.stringify(body), {
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

// Instagram Content Publishing is a two step flow: create a media container,
// then publish it. Requires instagram_content_publish + a Page token that manages
// the linked IG professional account. image_url must be a public https URL.
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

// Facebook Page photo post. Requires pages_manage_posts + the Page token.
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

  // ── GATE: publishing is not enabled until App Review + publish scopes land. ──
  // The grant's granted_scopes must include every PUBLISH_SCOPE. We look up the
  // paired page's grant and its scopes; if any are missing we refuse (safely).
  const facebookLedgerId = String(body.facebookLedgerId || "");
  const { data: conn } = await admin.from("meta_page_connections")
    .select("facebook_page_id, instagram_business_id, grant_id, owner")
    .eq("owner", user.id)
    .eq("facebook_ledger_id", facebookLedgerId)
    .maybeSingle();
  if (!conn) return json({ error: "That paired Meta page was not found." }, 404, origin);

  const { data: grant } = await admin.from("meta_grants")
    .select("granted_scopes")
    .eq("id", conn.grant_id)
    .eq("owner", user.id)
    .maybeSingle();
  const granted = new Set(
    Array.isArray(grant?.granted_scopes) ? grant!.granted_scopes : [],
  );
  const missing = PUBLISH_SCOPES.filter((s) => !granted.has(s));
  if (missing.length) {
    return json({
      error:
        "Publishing to Meta is not enabled for this account yet. It requires Meta " +
        "App Review approval and the publish permissions, then reconnecting. See " +
        "APP-REVIEW-META.md.",
      postingNotEnabled: true,
      missingScopes: missing,
    }, 409, origin);
  }

  // Beyond this point is the real publish path (only reachable once approved).
  // TODO before go-live: fetch the decrypted Page token from Vault for this grant
  // (mirror meta-oauth's candidate/grant token handling), enforce per-account
  // caps + owner approval, and record the result for reconciliation.
  return json({
    error:
      "meta-post scaffold: token retrieval + publish wiring is intentionally not " +
      "implemented until App Review is approved. See APP-REVIEW-META.md.",
    postingNotEnabled: true,
    scaffold: true,
  }, 501, origin);

  // Reference implementation the go-live wiring will call (kept for review):
  //   const pageToken = await getDecryptedPageToken(conn.grant_id, conn.facebook_page_id);
  //   const out: Record<string, unknown> = {};
  //   if (target !== "facebook" && conn.instagram_business_id) {
  //     out.instagram = await publishInstagram(conn.instagram_business_id, pageToken, imageUrl, caption);
  //   }
  //   if (target !== "instagram") {
  //     out.facebook = await publishFacebook(conn.facebook_page_id, pageToken, imageUrl, caption);
  //   }
  //   return json(out, 200, origin);
});

// Silence "declared but never used" for the reference helpers in scaffold state.
void publishInstagram;
void publishFacebook;
