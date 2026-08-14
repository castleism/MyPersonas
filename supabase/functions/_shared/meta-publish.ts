// _shared/meta-publish.ts — Facebook Page + Instagram publish primitives.
//
// Shared by the interactive publisher (meta-post) and the scheduled publisher
// (run-post-queue) so both use the exact same owner-scoped, scope-gated logic.
// The caller passes a service-role Supabase client and the owner id; nothing here
// trusts a browser. Page tokens are never stored — derived fresh from the durable
// user token (meta_get_grant_token_bundle) at publish time.

import { type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

const META_APP_SECRET = Deno.env.get("META_APP_SECRET") || "";
const GRAPH = `https://graph.facebook.com/${
  Deno.env.get("META_GRAPH_API_VERSION") || "v25.0"
}`;

export const PUBLISH_SCOPES = [
  "pages_manage_posts",
  "instagram_content_publish",
  "business_management",
] as const;

const RESTRICTED_META_PERSONAS = new Set([
  "56ebe05e-78c0-4dad-8e61-bcb7d245ab7b", // Chomes / Classwoods
  "288a472a-b286-43ae-b941-1731f406c23b", // Sherlock / CannaCandidz
  "a997734c-9e47-4c05-bf55-0537a1c0ad97", // Sherlock Chomes
]);
const RESTRICTED_META_DESTINATIONS = [
  "cannacandidz",
  "cannacandids",
  "sherlockchomes",
  "traditionalfamilyvalues",
  "tradfamilyvalues",
];

function policyKey(value: unknown) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export function isRestrictedMetaPersona(personaId: unknown) {
  return RESTRICTED_META_PERSONAS.has(String(personaId || ""));
}

export type Admin = SupabaseClient;

export type PageAsset = {
  owner: string;
  grant_id: string;
  facebook_page_id: string;
  instagram_business_id: string | null;
};

export type Resolved =
  | { ok: true; asset: PageAsset; pageToken: string }
  | { ok: false; status: number; error: string; missingScopes?: string[] };

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
    throw new Error(
      (j as { error?: { message?: string } })?.error?.message ||
        `Meta rejected the request (HTTP ${r.status})`,
    );
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
    throw new Error(
      (j as { error?: { message?: string } })?.error?.message ||
        `Meta rejected the publish (HTTP ${r.status})`,
    );
  }
  return j as Record<string, unknown>;
}

export async function graphDelete(path: string, token: string) {
  const url = new URL(`${GRAPH}${path}`);
  url.searchParams.set("access_token", token);
  url.searchParams.set("appsecret_proof", await appSecretProof(token));
  const r = await fetch(url, {
    method: "DELETE",
    signal: AbortSignal.timeout(30_000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    throw new Error(
      (j as { error?: { message?: string } })?.error?.message ||
        `Meta rejected the delete (HTTP ${r.status})`,
    );
  }
  return j as Record<string, unknown>;
}

async function getPageToken(pageId: string, userToken: string) {
  const j = await graphGet(`/${pageId}`, userToken, { fields: "access_token" });
  const token = typeof j.access_token === "string" ? j.access_token.trim() : "";
  if (!token) throw new Error("Could not obtain a Page access token.");
  return token;
}

export async function publishInstagram(
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
  const mediaId = String(published.id || "").trim();
  if (!mediaId) throw new Error("Instagram accepted the container but did not return a media ID.");
  return { mediaId };
}

export async function publishFacebook(
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
  const postId = String(res.post_id || res.id || "").trim();
  if (!postId) throw new Error("Facebook accepted the request but did not return a post ID.");
  return { postId };
}

// Resolve the owner's paired asset, verify publish scopes, derive a fresh Page
// token. Uses the service-role client + explicit owner (no RLS reliance).
export async function resolvePageContext(
  admin: Admin,
  owner: string,
  facebookLedgerId: string,
  enforcePublishPolicy = true,
): Promise<Resolved> {
  // Fail closed for project-policy destinations before obtaining any provider
  // token. The UUIDs are stable; destination labels provide a second guard for
  // legacy/unassigned ledger rows.
  let ledgerQuery = admin.from("account_ledger")
    .select("persona_id,username,login_email,aliases")
    .eq("owner", owner)
    .eq("id", facebookLedgerId)
    .eq("provider", "facebook");
  if (enforcePublishPolicy) ledgerQuery = ledgerQuery.eq("suspended", false);
  const { data: ledger, error: ledgerErr } = await ledgerQuery.maybeSingle();
  if (ledgerErr) {
    return { ok: false, status: 500, error: "Could not verify the Meta destination policy." };
  }
  if (!ledger) {
    return { ok: false, status: 404, error: "That active Facebook destination was not found for your account." };
  }
  if (enforcePublishPolicy && ledger) {
    const key = policyKey(
      [ledger.username, ledger.login_email, ledger.aliases].filter(Boolean).join(" "),
    );
    if (
      isRestrictedMetaPersona(ledger.persona_id) ||
      RESTRICTED_META_DESTINATIONS.some((blocked) => key.includes(blocked))
    ) {
      return {
        ok: false,
        status: 409,
        error: "This persona or destination is blocked from Meta publishing by project policy.",
      };
    }
  }

  const { data: asset, error: assetErr } = await admin
    .from("meta_page_connections")
    .select("owner,grant_id,facebook_page_id,instagram_business_id")
    .eq("owner", owner)
    .or(
      `facebook_ledger_id.eq.${facebookLedgerId},instagram_ledger_id.eq.${facebookLedgerId}`,
    )
    .maybeSingle();
  if (assetErr) return { ok: false, status: 500, error: "Could not look up the Meta connection." };
  if (!asset) {
    return { ok: false, status: 404, error: "That paired Meta page was not found for your account." };
  }

  const { data: grant, error: grantError } = await admin.from("meta_grants")
    .select("granted_scopes")
    .eq("id", asset.grant_id)
    .eq("owner", owner)
    .maybeSingle();
  if (grantError) {
    return { ok: false, status: 500, error: "Could not verify the Meta publish permissions." };
  }
  const granted = new Set(
    Array.isArray(grant?.granted_scopes) ? grant!.granted_scopes : [],
  );
  const missing = PUBLISH_SCOPES.filter((s) => !granted.has(s));
  if (missing.length) {
    return {
      ok: false,
      status: 409,
      error: "Publishing isn't enabled: the connection is missing the publish permissions.",
      missingScopes: missing,
    };
  }

  const cred = await admin.rpc("meta_get_grant_token_bundle", {
    p_grant_id: asset.grant_id,
    p_owner: owner,
  });
  const row = Array.isArray(cred.data)
    ? cred.data[0] as { token_bundle?: { access_token?: string } } | undefined
    : undefined;
  const userToken = String(row?.token_bundle?.access_token || "");
  if (cred.error || !userToken) {
    return { ok: false, status: 502, error: "Could not retrieve the Meta credential for this page." };
  }

  try {
    const pageToken = await getPageToken(String(asset.facebook_page_id), userToken);
    return { ok: true, asset: asset as PageAsset, pageToken };
  } catch (e) {
    return { ok: false, status: 502, error: (e as Error).message };
  }
}
