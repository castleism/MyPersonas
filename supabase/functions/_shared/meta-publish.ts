// _shared/meta-publish.ts — Facebook Page + Instagram publish primitives.
//
// Shared by the interactive publisher (meta-post) and the scheduled publisher
// (run-post-queue) so both use the exact same owner-scoped, scope-gated logic.
// The caller passes a service-role Supabase client and the owner id; nothing here
// trusts a browser. Page tokens are never stored — derived fresh from the durable
// user token (meta_get_grant_token_bundle) at publish time.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

const META_APP_SECRET = Deno.env.get("META_APP_SECRET") || "";
const GRAPH = `https://graph.facebook.com/${
  Deno.env.get("META_GRAPH_API_VERSION") || "v25.0"
}`;

export type MetaPublishTarget = "facebook" | "instagram";

export const TARGET_PUBLISH_SCOPES: Record<
  MetaPublishTarget,
  readonly string[]
> = {
  facebook: ["pages_manage_posts"],
  instagram: [
    "pages_show_list",
    "pages_read_engagement",
    "instagram_basic",
    "instagram_content_publish",
  ],
};

// Page access is a second provider-side authority check beyond OAuth scopes.
// CREATE_CONTENT is the current publishing task; MANAGE is accepted for older
// all-access Page grants that Meta still returns during migration.
export const PAGE_WRITE_TASKS = ["CREATE_CONTENT", "MANAGE"] as const;

export class ProviderOutcomeUncertainError extends Error {
  override name = "ProviderOutcomeUncertainError";
}

export function providerOutcomeIsUncertain(error: unknown) {
  const name = String((error as { name?: string })?.name || "");
  return error instanceof ProviderOutcomeUncertainError || error instanceof TypeError ||
    name === "AbortError" || name === "TimeoutError";
}

const RESTRICTED_META_PERSONAS = new Set([
  "56ebe05e-78c0-4dad-8e61-bcb7d245ab7b", // Chomes / Classwoods
  "288a472a-b286-43ae-b941-1731f406c23b", // Sherlock / CannaCandidz
  "a997734c-9e47-4c05-bf55-0537a1c0ad97", // Sherlock Chomes
]);
const RESTRICTED_META_DESTINATIONS = [
  "cannacandidz",
  "cannacandids",
  "sherlockchomes",
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
  page_tasks: string[];
};

export type Resolved =
  | { ok: true; asset: PageAsset; pageToken: string }
  | {
    ok: false;
    status: number;
    error: string;
    missingScopes?: string[];
    missingScopesByTarget?: Partial<Record<MetaPublishTarget, string[]>>;
    missingPageTask?: boolean;
    liveScopeMismatch?: boolean;
  };

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
  timeoutMs = 30_000,
) {
  const url = new URL(`${GRAPH}${path}`);
  const sp = new URLSearchParams(params);
  sp.set("access_token", token);
  sp.set("appsecret_proof", await appSecretProof(token));
  url.search = sp.toString();
  const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
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
  beforeProviderPost?: () => Promise<void>,
) {
  const url = new URL(`${GRAPH}${path}`);
  const body = new URLSearchParams(params);
  body.set("access_token", token);
  body.set("appsecret_proof", await appSecretProof(token));
  // The caller's last-moment policy check belongs immediately beside fetch.
  // Instagram uses this hook for both container creation and media_publish so
  // a pause raised between those calls still prevents the second provider POST.
  await beforeProviderPost?.();
  const r = await fetch(url, {
    method: "POST",
    body,
    signal: AbortSignal.timeout(30_000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const message = (j as { error?: { message?: string } })?.error?.message ||
      `Meta rejected the publish (HTTP ${r.status})`;
    if (r.status >= 500 || r.status === 408) {
      throw new ProviderOutcomeUncertainError(
        `Meta returned HTTP ${r.status}; verify the account before retrying. ${message}`,
      );
    }
    throw new Error(message);
  }
  return j as Record<string, unknown>;
}

function finiteNonnegative(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

export type InstagramPublishingQuota = {
  usage: number;
  total: number;
  durationSeconds: number | null;
};

// Meta owns this limit and can change it. Read the account's current quota
// instead of baking a historical 24-hour post count into the scheduler.
export async function getInstagramPublishingQuota(
  igUserId: string,
  pageToken: string,
): Promise<InstagramPublishingQuota> {
  const payload = await graphGet(
    `/${igUserId}/content_publishing_limit`,
    pageToken,
    { fields: "config,quota_usage" },
  );
  const rows = Array.isArray(payload.data) ? payload.data : [];
  const row = rows[0] && typeof rows[0] === "object"
    ? rows[0] as Record<string, unknown>
    : payload;
  const config = row.config && typeof row.config === "object"
    ? row.config as Record<string, unknown>
    : {};
  const usage = finiteNonnegative(row.quota_usage);
  const total = finiteNonnegative(config.quota_total);
  const durationSeconds = finiteNonnegative(config.quota_duration);
  if (usage === null || total === null || total <= 0) {
    throw new Error(
      "Instagram did not return a usable content-publishing quota; no media was created.",
    );
  }
  return { usage, total, durationSeconds };
}

async function requireInstagramPublishingCapacity(
  igUserId: string,
  pageToken: string,
) {
  const quota = await getInstagramPublishingQuota(igUserId, pageToken);
  if (quota.usage >= quota.total) {
    const window = quota.durationSeconds
      ? ` during the current ${quota.durationSeconds}-second quota window`
      : " during the current provider quota window";
    throw new Error(
      `Instagram's content-publishing quota is full (${quota.usage}/${quota.total})${window}; no media was created.`,
    );
  }
  return quota;
}

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function waitForInstagramContainer(
  creationId: string,
  pageToken: string,
  beforeProviderPost?: () => Promise<void>,
) {
  const maxAttempts = 15;
  const deadline = Date.now() + 45_000;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    await beforeProviderPost?.();
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    let container: Record<string, unknown>;
    try {
      container = await graphGet(`/${creationId}`, pageToken, {
        fields: "status_code,status",
      }, Math.max(1_000, Math.min(5_000, remaining)));
    } catch (error) {
      throw new Error(
        `Instagram media status could not be checked; no publish request was sent. ${
          error instanceof Error ? error.message : ""
        }`.trim(),
      );
    }
    const statusCode = String(container.status_code || "").toUpperCase();
    const detail = String(container.status || "").trim().slice(0, 300);
    if (statusCode === "FINISHED") return;
    if (statusCode === "ERROR" || statusCode === "EXPIRED") {
      throw new Error(
        `Instagram media processing ${statusCode.toLowerCase()}${
          detail ? `: ${detail}` : "."
        }`,
      );
    }
    if (statusCode === "PUBLISHED") {
      throw new ProviderOutcomeUncertainError(
        "Instagram reports that this container is already published, but no media ID was recorded; reconcile the account before retrying.",
      );
    }
    if (statusCode !== "IN_PROGRESS") {
      throw new Error(
        "Instagram returned an unknown media-container status; no publish request was sent.",
      );
    }
    if (attempt < maxAttempts && Date.now() < deadline) {
      await delay(Math.min(2_000, Math.max(0, deadline - Date.now())));
    }
  }
  throw new Error(
    "Instagram media is still processing; no publish request was sent.",
  );
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

function normalizedPageTasks(value: unknown) {
  return Array.isArray(value)
    ? value.map((task) => String(task).toUpperCase()).filter(Boolean)
    : [];
}

async function getLiveGrantedScopes(userToken: string) {
  const payload = await graphGet("/me/permissions", userToken, {});
  const rows = Array.isArray(payload.data) ? payload.data : [];
  return new Set(
    rows.flatMap((row) => {
      if (!row || typeof row !== "object") return [];
      const record = row as Record<string, unknown>;
      const permission = String(record.permission || "").trim();
      return permission && String(record.status || "").toLowerCase() === "granted"
        ? [permission]
        : [];
    }),
  );
}

function missingScopesForTargets(
  targets: readonly MetaPublishTarget[],
  granted: ReadonlySet<string>,
) {
  const missingByTarget: Partial<Record<MetaPublishTarget, string[]>> = {};
  for (const target of targets) {
    const missing = TARGET_PUBLISH_SCOPES[target].filter((scope) =>
      !granted.has(scope)
    );
    if (missing.length) missingByTarget[target] = missing;
  }
  return missingByTarget;
}

function hasPageWriteTask(tasks: readonly string[]) {
  return tasks.some((task) =>
    PAGE_WRITE_TASKS.some((allowed) => allowed === task)
  );
}

async function getLivePageAuthority(pageId: string, userToken: string) {
  const j = await graphGet(`/${pageId}`, userToken, {
    fields: "access_token,tasks",
  });
  const token = typeof j.access_token === "string" ? j.access_token.trim() : "";
  if (!token) throw new Error("Could not obtain a Page access token.");
  return { pageToken: token, pageTasks: normalizedPageTasks(j.tasks) };
}

export async function publishInstagram(
  igUserId: string,
  pageToken: string,
  imageUrl: string,
  caption: string,
  beforeProviderPost?: () => Promise<void>,
) {
  // This is an advisory provider preflight. Meta remains the final authority
  // and may reject a race between this read and the subsequent container write.
  await beforeProviderPost?.();
  await requireInstagramPublishingCapacity(igUserId, pageToken);
  const container = await graphPost(`/${igUserId}/media`, pageToken, {
    image_url: imageUrl,
    ...(caption ? { caption } : {}),
  }, beforeProviderPost);
  const creationId = String(container.id || "");
  if (!creationId) {
    throw new ProviderOutcomeUncertainError(
      "Instagram returned success without a media container ID; verify the account before retrying.",
    );
  }
  await waitForInstagramContainer(
    creationId,
    pageToken,
    beforeProviderPost,
  );
  const published = await graphPost(`/${igUserId}/media_publish`, pageToken, {
    creation_id: creationId,
  }, beforeProviderPost);
  const mediaId = String(published.id || "").trim();
  if (!mediaId) {
    throw new ProviderOutcomeUncertainError(
      "Instagram accepted the publish but did not return a media ID; verify the account before retrying.",
    );
  }
  return { mediaId };
}

export async function publishFacebook(
  pageId: string,
  pageToken: string,
  imageUrl: string,
  caption: string,
  beforeProviderPost?: () => Promise<void>,
) {
  const res = await graphPost(`/${pageId}/photos`, pageToken, {
    url: imageUrl,
    ...(caption ? { caption } : {}),
    published: "true",
  }, beforeProviderPost);
  const postId = String(res.post_id || res.id || "").trim();
  if (!postId) {
    throw new ProviderOutcomeUncertainError(
      "Facebook accepted the publish but did not return a post ID; verify the Page before retrying.",
    );
  }
  return { postId };
}

// Resolve the owner's paired asset, verify publish scopes, derive a fresh Page
// token. Uses the service-role client + explicit owner (no RLS reliance).
export async function resolvePageContext(
  admin: Admin,
  owner: string,
  facebookLedgerId: string,
  enforcePublishPolicy = true,
  publishTargets: readonly MetaPublishTarget[] = ["facebook", "instagram"],
): Promise<Resolved> {
  const targets = [...new Set(publishTargets)];
  if (
    targets.length < 1 ||
    targets.some((target) => target !== "facebook" && target !== "instagram")
  ) {
    return {
      ok: false,
      status: 400,
      error: "A Facebook and/or Instagram publish target is required.",
    };
  }
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
    .select("owner,grant_id,facebook_page_id,instagram_business_id,page_tasks")
    .eq("owner", owner)
    .or(
      `facebook_ledger_id.eq.${facebookLedgerId},instagram_ledger_id.eq.${facebookLedgerId}`,
    )
    .maybeSingle();
  if (assetErr) return { ok: false, status: 500, error: "Could not look up the Meta connection." };
  if (!asset) {
    return { ok: false, status: 404, error: "That paired Meta page was not found for your account." };
  }
  if (targets.includes("instagram") && !asset.instagram_business_id) {
    return {
      ok: false,
      status: 409,
      error: "The selected Page has no linked Instagram professional account.",
    };
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
    Array.isArray(grant?.granted_scopes)
      ? grant!.granted_scopes.map((scope: unknown) => String(scope))
      : [],
  );
  const missingScopesByTarget = missingScopesForTargets(targets, granted);
  const missing = [...new Set(Object.values(missingScopesByTarget).flat())];
  if (missing.length) {
    return {
      ok: false,
      status: 409,
      error: "Publishing isn't enabled: the connection is missing the publish permissions.",
      missingScopes: missing,
      missingScopesByTarget,
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
    const [authority, liveGranted] = await Promise.all([
      getLivePageAuthority(String(asset.facebook_page_id), userToken),
      getLiveGrantedScopes(userToken),
    ]);
    const liveMissingScopesByTarget = missingScopesForTargets(
      targets,
      liveGranted,
    );
    const liveMissing = [
      ...new Set(Object.values(liveMissingScopesByTarget).flat()),
    ];
    if (liveMissing.length) {
      return {
        ok: false,
        status: 409,
        error:
          "Publishing isn't enabled: Meta no longer reports the required publish permissions. Reauthorize this connection.",
        missingScopes: liveMissing,
        missingScopesByTarget: liveMissingScopesByTarget,
        liveScopeMismatch: true,
      };
    }
    if (!hasPageWriteTask(authority.pageTasks)) {
      return {
        ok: false,
        status: 409,
        error:
          "Publishing isn't enabled: the Meta user must currently have the CREATE_CONTENT Page task (or a legacy MANAGE task).",
        missingPageTask: true,
      };
    }
    return {
      ok: true,
      asset: { ...(asset as PageAsset), page_tasks: authority.pageTasks },
      pageToken: authority.pageToken,
    };
  } catch (e) {
    return { ok: false, status: 502, error: (e as Error).message };
  }
}
