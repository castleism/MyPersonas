// Owner-triggered WordPress draft creation only. No action in this function
// can publish or schedule a post.
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { requireAal2 } from "../_shared/aal2.ts";
import {
  claimCmsAttempt,
  claimCmsAttemptWithPreview,
  type CmsAttempt,
  type CmsDraftContext,
  cmsFingerprint,
  loadExactCmsDraft,
  plainTextToHtml,
  prepareCmsActionPreview,
  providerOutcomeUncertain,
  recordVerifiedCmsDraft,
  sha256Hex,
  updateCmsAttempt,
} from "../_shared/cms-drafts.ts";
import { safeWordPressFetch } from "../_shared/wordpress-safe-url.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const APP_ORIGIN = Deno.env.get("WORDPRESS_OAUTH_APP_ORIGIN") ||
  "https://mypersonas.online";
const SAFE_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_NUMERIC_ID = /^\d{1,32}$/;
const ALLOWED_ORIGINS = new Set([
  APP_ORIGIN,
  "https://mypersonas.online",
  "https://aliaspaces.com",
  "https://www.aliaspaces.com",
  "https://app.aliaspaces.com",
  "http://localhost:8000",
  "http://127.0.0.1:8000",
]);
const service = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function cors(origin: string): HeadersInit {
  const allowed = ALLOWED_ORIGINS.has(origin) ? origin : APP_ORIGIN;
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Cache-Control": "no-store",
    "Vary": "Origin",
  };
}
function json(origin: string, status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...cors(origin),
      "Content-Type": "application/json",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
function wordpressSecret(context: CmsDraftContext) {
  const mode = context.credential.provider_mode;
  const authorId = context.credential.author_id;
  if (!SAFE_NUMERIC_ID.test(authorId)) return null;
  if (mode === "wordpress_com_oauth") {
    const accessToken = String(context.credential.secret.access_token || "");
    return accessToken.length >= 16 && accessToken.length <= 32768
      ? { mode, authorId, accessToken, username: "", applicationPassword: "" }
      : null;
  }
  if (mode === "wordpress_application_password") {
    const username = String(context.credential.secret.username || "");
    const applicationPassword = String(
      context.credential.secret.application_password || "",
    );
    return username.length >= 1 && username.length <= 100 &&
        applicationPassword.length >= 16 && applicationPassword.length <= 256
      ? { mode, authorId, accessToken: "", username, applicationPassword }
      : null;
  }
  return null;
}
function basicAuth(username: string, applicationPassword: string) {
  const bytes = new TextEncoder().encode(`${username}:${applicationPassword}`);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `Basic ${btoa(binary)}`;
}
async function wordpressFetch(
  context: CmsDraftContext,
  path: string,
  init: RequestInit = {},
) {
  const secret = wordpressSecret(context);
  if (!secret) throw new Error("Invalid WordPress credential");
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  if (init.body) headers.set("Content-Type", "application/json");
  if (secret.mode === "wordpress_com_oauth") {
    headers.set("Authorization", `Bearer ${secret.accessToken}`);
    return await fetch(
      `https://public-api.wordpress.com/wp/v2/sites/${
        encodeURIComponent(context.credential.site_id)
      }${path}`,
      {
        ...init,
        headers,
        redirect: "error",
        signal: init.signal || AbortSignal.timeout(20_000),
      },
    );
  }
  headers.set(
    "Authorization",
    basicAuth(secret.username, secret.applicationPassword),
  );
  return await safeWordPressFetch(
    context.credential.site_url,
    `/wp-json/wp/v2${path}`,
    {
      ...init,
      headers,
      signal: init.signal || AbortSignal.timeout(20_000),
    },
  );
}
function nestedRaw(value: unknown) {
  return value && typeof value === "object"
    ? String((value as Record<string, unknown>).raw || "")
    : "";
}
function wordpressPostMatches(
  context: CmsDraftContext,
  post: Record<string, unknown>,
) {
  return SAFE_NUMERIC_ID.test(String(post.id || "")) &&
    String(post.status || "") === "draft" &&
    String(post.author || "") === context.credential.author_id &&
    nestedRaw(post.title) === context.draft.title &&
    nestedRaw(post.content) ===
      plainTextToHtml(context.draft.body, context.draft.tags);
}
function providerLinks(
  context: CmsDraftContext,
  _post: Record<string, unknown>,
  providerDraftId: string,
) {
  const site = context.credential.site_url.replace(/\/+$/, "");
  const previewUrl = `${site}/?p=${
    encodeURIComponent(providerDraftId)
  }&preview=true`;
  if (context.credential.provider_mode === "wordpress_com_oauth") {
    return {
      previewUrl,
      editUrl: `https://wordpress.com/post/${
        encodeURIComponent(context.credential.site_id)
      }/${encodeURIComponent(providerDraftId)}`,
    };
  }
  return {
    previewUrl,
    editUrl: `${site}/wp-admin/post.php?post=${
      encodeURIComponent(providerDraftId)
    }&action=edit`,
  };
}
async function getWordPressPost(
  context: CmsDraftContext,
  providerDraftId: string,
) {
  const response = await wordpressFetch(
    context,
    `/posts/${encodeURIComponent(providerDraftId)}?context=edit`,
    { signal: AbortSignal.timeout(20_000) },
  );
  const post = await response.json().catch(() => null) as
    | Record<string, unknown>
    | null;
  return { response, post };
}
async function existingVerified(
  owner: string,
  draftId: string,
  hash: string,
  target: string,
) {
  const result = await service.from("cms_provider_drafts")
    .select(
      "provider_draft_id,provider_preview_url,provider_edit_url,provider_status,verified_at",
    )
    .eq("owner", owner).eq("draft_id", draftId).eq("draft_content_hash", hash)
    .eq("exact_target_id", target).eq("provider", "wordpress").maybeSingle();
  return result.error ? null : result.data;
}
async function auditStart(context: CmsDraftContext, attempt: CmsAttempt) {
  const result = await service.rpc("insert_agent_action_service", {
    p_owner: context.draft.owner,
    p_persona_id: context.draft.persona_id,
    p_binding_id: null,
    p_action_type: "stage_external_cms_draft_start",
    p_entity_type: "draft",
    p_entity_id: context.draft.id,
    p_outcome: "ok",
    p_detail: {
      provider: "wordpress",
      provider_mode: context.credential.provider_mode,
      attempt_id: attempt.id,
      exact_target_id: context.connection.provider_subject,
      approved_content_hash: context.draft.approved_content_hash,
      status: "draft",
    },
  });
  return !result.error;
}
async function verifyAndRecord(
  context: CmsDraftContext,
  attempt: CmsAttempt,
  providerDraftId: string,
) {
  let readback;
  try {
    readback = await getWordPressPost(context, providerDraftId);
  } catch {
    await updateCmsAttempt(service, context.draft.owner, attempt.id, {
      status: "provider_created",
      provider_draft_id: providerDraftId,
      last_error:
        "WordPress returned a draft ID, but readback did not complete. Reconcile before retrying.",
    });
    return {
      error: "WordPress created a draft, but readback needs reconciliation.",
      status: 202,
    };
  }
  if (
    !readback.response.ok || !readback.post ||
    !wordpressPostMatches(context, readback.post)
  ) {
    await updateCmsAttempt(service, context.draft.owner, attempt.id, {
      status: "provider_created",
      provider_draft_id: providerDraftId,
      provider_http_status: readback.response.status,
      last_error:
        "WordPress readback did not match the exact approved title, text, site, author, and draft status.",
    });
    return {
      error:
        "WordPress returned a post, but exact draft readback did not match. Reconcile before retrying.",
      status: 202,
    };
  }
  const links = providerLinks(context, readback.post, providerDraftId);
  const recorded = await recordVerifiedCmsDraft(
    service,
    context,
    attempt,
    providerDraftId,
    await sha256Hex(plainTextToHtml(context.draft.body, context.draft.tags)),
    links.previewUrl,
    links.editUrl,
  );
  if (recorded.error) return { error: recorded.error, status: 202 };
  return {
    data: {
      staged: true,
      published: false,
      provider: "wordpress",
      providerMode: context.credential.provider_mode,
      providerDraftId,
      providerStatus: "draft",
      providerPreviewUrl: links.previewUrl,
      providerEditUrl: links.editUrl,
      exactTargetId: context.connection.provider_subject,
      siteId: context.credential.site_id,
      siteUrl: context.credential.site_url,
      siteName: context.credential.site_name,
      authorId: context.credential.author_id,
      authorName: context.credential.author_name,
    },
    status: 200,
  };
}
async function createDraft(context: CmsDraftContext, attempt: CmsAttempt) {
  if (!wordpressSecret(context)) {
    await updateCmsAttempt(service, context.draft.owner, attempt.id, {
      status: "definitive_failure",
      last_error:
        "The exact WordPress credential was unavailable. Nothing was sent.",
    });
    return {
      error: "Reconnect WordPress before staging a draft.",
      status: 409,
    };
  }
  if (!await auditStart(context, attempt)) {
    await updateCmsAttempt(service, context.draft.owner, attempt.id, {
      status: "definitive_failure",
      last_error:
        "The provider request could not be audited. Nothing was sent.",
    });
    return {
      error: "The provider request could not be audited. Nothing was sent.",
      status: 503,
    };
  }
  let response: Response;
  try {
    response = await wordpressFetch(context, "/posts", {
      method: "POST",
      body: JSON.stringify({
        title: context.draft.title,
        content: plainTextToHtml(context.draft.body, context.draft.tags),
        status: "draft",
        author: Number(context.credential.author_id),
        comment_status: "closed",
        ping_status: "closed",
      }),
      signal: AbortSignal.timeout(25_000),
    });
  } catch (error) {
    const uncertain = providerOutcomeUncertain(error);
    await updateCmsAttempt(service, context.draft.owner, attempt.id, {
      status: uncertain ? "outcome_unknown" : "definitive_failure",
      last_error: uncertain
        ? "WordPress did not return a durable result. Reconcile before retrying."
        : "The WordPress request failed before a provider result.",
    });
    return {
      error: uncertain
        ? "WordPress's outcome is unknown. Reconcile before retrying."
        : "The WordPress request failed before a provider result.",
      status: uncertain ? 202 : 502,
    };
  }
  const post = await response.json().catch(() => null) as
    | Record<string, unknown>
    | null;
  if (response.status === 408 || response.status >= 500) {
    await updateCmsAttempt(service, context.draft.owner, attempt.id, {
      status: "outcome_unknown",
      provider_http_status: response.status,
      last_error:
        `WordPress returned HTTP ${response.status}. Reconcile before retrying.`,
    });
    return {
      error:
        `WordPress returned HTTP ${response.status}. Reconcile before retrying.`,
      status: 202,
    };
  }
  if (!response.ok) {
    await updateCmsAttempt(service, context.draft.owner, attempt.id, {
      status: "definitive_failure",
      provider_http_status: response.status,
      last_error:
        `WordPress rejected the draft request with HTTP ${response.status}.`,
    });
    return {
      error:
        `WordPress rejected the draft request with HTTP ${response.status}.`,
      status: 502,
    };
  }
  const providerDraftId = String(post?.id || "");
  if (!SAFE_NUMERIC_ID.test(providerDraftId)) {
    await updateCmsAttempt(service, context.draft.owner, attempt.id, {
      status: "outcome_unknown",
      provider_http_status: response.status,
      last_error:
        "WordPress accepted the request without a durable post ID. Reconcile before retrying.",
    });
    return {
      error:
        "WordPress accepted the request without a durable post ID. Reconcile before retrying.",
      status: 202,
    };
  }
  await updateCmsAttempt(service, context.draft.owner, attempt.id, {
    status: "provider_created",
    provider_draft_id: providerDraftId,
    provider_http_status: response.status,
    provider_accepted_at: new Date().toISOString(),
    last_error: "WordPress accepted the draft; exact readback is in progress.",
  });
  return await verifyAndRecord(context, attempt, providerDraftId);
}
async function reconcileDraft(context: CmsDraftContext, attempt: CmsAttempt) {
  if (!wordpressSecret(context)) {
    return { error: "Reconnect WordPress before reconciliation.", status: 409 };
  }
  if (attempt.provider_draft_id) {
    return await verifyAndRecord(context, attempt, attempt.provider_draft_id);
  }
  const query = new URLSearchParams({
    context: "edit",
    status: "draft",
    author: context.credential.author_id,
    search: context.draft.title,
    per_page: "100",
    orderby: "date",
    order: "desc",
  });
  if (attempt.started_at) {
    query.set(
      "after",
      new Date(new Date(attempt.started_at).getTime() - 120_000).toISOString(),
    );
  }
  let response: Response;
  try {
    response = await wordpressFetch(context, `/posts?${query.toString()}`, {
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    return {
      error:
        "WordPress reconciliation could not complete. Do not retry the create request.",
      status: 202,
    };
  }
  const payload = await response.json().catch(() => null) as unknown;
  const rows = response.ok && Array.isArray(payload) ? payload : [];
  const totalHeader = response.headers.get("X-WP-Total") || "";
  const total = /^\d+$/.test(totalHeader) ? Number(totalHeader) : Number.NaN;
  if (
    !response.ok || !Number.isSafeInteger(total) || total < 0 ||
    total !== rows.length
  ) {
    return {
      error:
        "WordPress did not return complete, trustworthy result-count evidence for this reconciliation. Review the provider Drafts workspace; do not retry creation.",
      status: 202,
    };
  }
  const matches = rows.filter((row) =>
    row && typeof row === "object" &&
    wordpressPostMatches(context, row as Record<string, unknown>)
  ) as Record<string, unknown>[];
  if (matches.length !== 1) {
    return {
      error: matches.length > 1
        ? "More than one matching WordPress draft exists. Review the provider dashboard before taking any action."
        : "No exact matching WordPress draft is visible yet. Do not retry creation; reconcile again later.",
      status: 202,
    };
  }
  const providerDraftId = String(matches[0].id || "");
  await updateCmsAttempt(service, context.draft.owner, attempt.id, {
    status: "provider_created",
    provider_draft_id: providerDraftId,
    provider_accepted_at: new Date().toISOString(),
    last_error:
      "WordPress reconciliation found one exact draft; readback is in progress.",
  });
  return await verifyAndRecord(context, attempt, providerDraftId);
}
async function auditDelete(
  owner: string,
  draftId: string,
  providerDraftId: string,
) {
  const result = await service.rpc("insert_agent_action_service", {
    p_owner: owner,
    p_persona_id: null,
    p_binding_id: null,
    p_action_type: "delete_external_cms_draft_start",
    p_entity_type: "draft",
    p_entity_id: draftId,
    p_outcome: "ok",
    p_detail: {
      provider: "wordpress",
      provider_draft_id: providerDraftId,
      permanent: false,
    },
  });
  return !result.error;
}

serve(async (req) => {
  const origin = req.headers.get("Origin") || "";
  if (req.method === "OPTIONS") {
    return ALLOWED_ORIGINS.has(origin)
      ? new Response(null, { status: 204, headers: cors(origin) })
      : new Response(null, { status: 403 });
  }
  if (req.method !== "POST") return json(origin, 405, { error: "POST only" });
  if (!ALLOWED_ORIGINS.has(origin)) {
    return json(origin, 403, { error: "Origin not allowed" });
  }
  const authorization = req.headers.get("Authorization") || "";
  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false },
  });
  const guard = await requireAal2(req, userClient);
  if (!guard.ok) {
    return json(origin, guard.status, { error: guard.error, code: guard.code });
  }
  let body: Record<string, unknown>;
  try {
    const raw = await req.text();
    if (new TextEncoder().encode(raw).byteLength > 16_384) {
      return json(origin, 413, { error: "Request is too large" });
    }
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return json(origin, 400, { error: "Invalid request body" });
  }
  const action = String(body.action || "create-draft");
  const draftId = String(body.draftId || "");
  if (!SAFE_UUID.test(draftId)) {
    return json(origin, 400, { error: "A valid draftId is required" });
  }
  if (
    body.previewConfirmed !== undefined || body.executeConfirmed !== undefined
  ) {
    return json(origin, 400, {
      error:
        "Raw confirmation booleans are not accepted. Render and acknowledge the server receipt.",
    });
  }

  if (action === "prepare-preview") {
    const loaded = await loadExactCmsDraft(
      service,
      guard.user.id,
      draftId,
      "wordpress",
    );
    if (!loaded.context) {
      return json(origin, loaded.status || 409, {
        error: loaded.error || "WordPress draft preview is unavailable",
      });
    }
    const fingerprint = await cmsFingerprint(loaded.context);
    const prepared = await prepareCmsActionPreview(
      service,
      loaded.context,
      fingerprint,
    );
    if (prepared.error || !prepared.receipt) {
      return json(origin, 409, {
        error: prepared.error?.message ||
          "The WordPress server preview receipt could not be prepared",
      });
    }
    return json(origin, 200, {
      prepared: true,
      receipt: prepared.receipt,
      preview: prepared.receipt.preview,
    });
  }

  if (["create-draft", "reconcile"].includes(action)) {
    const loaded = await loadExactCmsDraft(
      service,
      guard.user.id,
      draftId,
      "wordpress",
    );
    if (!loaded.context) {
      return json(origin, loaded.status || 409, {
        error: loaded.error || "WordPress draft is unavailable",
      });
    }
    const context = loaded.context;
    const fingerprint = await cmsFingerprint(context);
    const prior = await existingVerified(
      guard.user.id,
      draftId,
      context.draft.approved_content_hash,
      context.connection.provider_subject,
    );
    if (prior?.provider_status === "draft") {
      return json(origin, 200, {
        staged: true,
        published: false,
        provider: "wordpress",
        ...prior,
      });
    }
    const receiptId = String(body.receiptId || "");
    if (action === "create-draft" && !SAFE_UUID.test(receiptId)) {
      return json(origin, 409, {
        error:
          "A current acknowledged one-shot WordPress preview receipt is required",
      });
    }
    const claimed = action === "create-draft"
      ? await claimCmsAttemptWithPreview(
        service,
        context,
        fingerprint,
        receiptId,
      )
      : await claimCmsAttempt(service, context, fingerprint);
    if (!claimed.attempt) {
      return json(origin, claimed.status || 503, {
        error: claimed.blocked || "The WordPress attempt is unavailable",
      });
    }
    if (claimed.attempt.status === "verified") {
      return json(origin, 409, {
        error:
          "The verified WordPress checkpoint could not be read. Reconcile before any retry.",
      });
    }
    if (action === "create-draft" && claimed.blocked) {
      return json(origin, claimed.status || 409, {
        error: claimed.blocked,
        reconciliationRequired: true,
      });
    }
    const fresh = await loadExactCmsDraft(
      service,
      guard.user.id,
      draftId,
      "wordpress",
    );
    const freshFingerprint = fresh.context
      ? await cmsFingerprint(fresh.context)
      : "";
    if (
      !fresh.context || freshFingerprint !== fingerprint ||
      fresh.context.connection.provider_subject !==
        context.connection.provider_subject
    ) {
      if (action === "create-draft") {
        await updateCmsAttempt(service, guard.user.id, claimed.attempt.id, {
          status: "definitive_failure",
          last_error:
            "The exact preview or destination changed before the provider call. Nothing was sent.",
        });
      }
      return json(origin, 409, {
        error:
          "The WordPress destination changed after the provider operation was claimed",
      });
    }
    const result = action === "reconcile"
      ? await reconcileDraft(fresh.context, claimed.attempt)
      : await createDraft(fresh.context, claimed.attempt);
    return json(
      origin,
      result.status || 200,
      result.data ||
        { error: result.error || "WordPress draft operation failed" },
    );
  }

  const storedResult = await service.from("cms_provider_drafts")
    .select(
      "id,ledger_id,attempt_id,provider_draft_id,provider_status,provider_preview_url,provider_edit_url,title,provider_content_hash,exact_target_id",
    )
    .eq("owner", guard.user.id).eq("draft_id", draftId).eq(
      "provider",
      "wordpress",
    )
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (storedResult.error || !storedResult.data) {
    return json(origin, 404, {
      error: "No verified WordPress provider draft exists",
    });
  }
  const stored = storedResult.data;
  const credentialResult = await service.rpc("cms_get_credential_service", {
    p_ledger_id: stored.ledger_id,
    p_owner: guard.user.id,
  });
  const credential = (Array.isArray(credentialResult.data)
    ? credentialResult.data[0]
    : credentialResult.data) as
      | CmsDraftContext["credential"]
      | undefined;
  if (
    credentialResult.error || !credential ||
    credential.provider !== "wordpress" ||
    credential.provider_subject !== stored.exact_target_id ||
    !SAFE_NUMERIC_ID.test(credential.author_id)
  ) {
    return json(origin, 409, {
      error:
        "The WordPress site or author binding changed. Reconnect before verification or deletion.",
    });
  }
  const credentialContext = { credential } as CmsDraftContext;
  if (action === "finalize-trash-checkpoint") {
    if (
      body.confirmProviderTrash !== true ||
      String(body.expectedProviderDraftId || "") !== stored.provider_draft_id ||
      String(body.expectedTargetId || "") !== stored.exact_target_id
    ) {
      return json(origin, 400, {
        error:
          "Confirm the exact WordPress draft ID and site/author target after visually verifying it is in WordPress Trash.",
      });
    }
    const checkpoint = await service.rpc(
      "cms_mark_provider_draft_trashed_service",
      {
        p_owner: guard.user.id,
        p_record_id: stored.id,
        p_attempt_id: stored.attempt_id,
        p_provider: "wordpress",
        p_provider_draft_id: stored.provider_draft_id,
        p_exact_target_id: stored.exact_target_id,
      },
    );
    if (checkpoint.error || checkpoint.data !== true) {
      return json(origin, 503, {
        error:
          "The WordPress Trash checkpoint is still pending. No provider request was sent.",
      });
    }
    return json(origin, 200, {
      checkpointFinalized: true,
      deleted: true,
      permanent: false,
      providerStatus: "trash",
    });
  }
  if (action === "verify-draft") {
    if (stored.provider_status !== "draft") {
      return json(origin, 409, {
        verified: false,
        error: "This WordPress checkpoint is no longer a draft",
      });
    }
    let readback;
    try {
      readback = await getWordPressPost(
        credentialContext,
        stored.provider_draft_id,
      );
    } catch {
      return json(origin, 503, {
        verified: false,
        error: "WordPress readback could not complete",
      });
    }
    if (
      !readback.response.ok || !readback.post ||
      String(readback.post.status || "") !== "draft" ||
      String(readback.post.author || "") !== credential.author_id ||
      nestedRaw(readback.post.title) !== stored.title ||
      await sha256Hex(nestedRaw(readback.post.content)) !==
        stored.provider_content_hash
    ) {
      return json(origin, 409, {
        verified: false,
        error:
          "WordPress no longer reports this exact site, author, title, and content as a provider draft",
      });
    }
    const now = new Date().toISOString();
    await service.from("cms_provider_drafts").update({
      verified_at: now,
      updated_at: now,
    })
      .eq("id", stored.id).eq("owner", guard.user.id);
    return json(origin, 200, {
      verified: true,
      published: false,
      providerDraftId: stored.provider_draft_id,
      providerStatus: "draft",
      providerPreviewUrl: stored.provider_preview_url,
      providerEditUrl: stored.provider_edit_url,
    });
  }
  if (action === "delete-draft") {
    if (stored.provider_status !== "draft") {
      return json(origin, 409, {
        error: "This WordPress checkpoint is no longer a draft",
      });
    }
    if (body.confirmDelete !== true) {
      return json(origin, 400, {
        error:
          "Explicit confirmDelete:true is required to move the WordPress draft to trash",
      });
    }
    if (
      String(body.expectedProviderDraftId || "") !== stored.provider_draft_id ||
      String(body.expectedTargetId || "") !== stored.exact_target_id
    ) {
      return json(origin, 409, {
        error:
          "The WordPress draft or exact site/author target changed after confirmation. Nothing was sent.",
      });
    }
    if (!await auditDelete(guard.user.id, draftId, stored.provider_draft_id)) {
      return json(origin, 503, {
        error: "The delete request could not be audited. Nothing was sent.",
      });
    }
    const claim = await service.rpc("cms_claim_provider_draft_trash_service", {
      p_owner: guard.user.id,
      p_record_id: stored.id,
      p_attempt_id: stored.attempt_id,
      p_provider: "wordpress",
      p_provider_draft_id: stored.provider_draft_id,
      p_exact_target_id: stored.exact_target_id,
    });
    if (claim.error || claim.data !== true) {
      return json(origin, 409, {
        error:
          "This WordPress Trash request is already pending or changed. No duplicate provider delete was sent.",
      });
    }
    let response: Response;
    try {
      response = await wordpressFetch(
        credentialContext,
        `/posts/${encodeURIComponent(stored.provider_draft_id)}?force=false`,
        { method: "DELETE", signal: AbortSignal.timeout(20_000) },
      );
    } catch (error) {
      const uncertain = providerOutcomeUncertain(error);
      await updateCmsAttempt(service, guard.user.id, stored.attempt_id, {
        status: uncertain ? "delete_outcome_unknown" : "verified",
        last_error: uncertain
          ? "WordPress Trash outcome is unknown; do not send another provider DELETE."
          : "WordPress Trash request failed before a provider outcome was possible.",
      });
      return json(origin, uncertain ? 202 : 502, {
        deleted: false,
        outcomeUnknown: uncertain,
        error: uncertain
          ? "WordPress did not return a durable delete result. Do not retry provider deletion; verify Trash and finalize only the local checkpoint."
          : "WordPress Trash failed before a provider outcome was possible.",
      });
    }
    const payload = await response.json().catch(() =>
      null
    ) as Record<string, unknown> | null;
    if (response.status === 408 || response.status >= 500) {
      await updateCmsAttempt(service, guard.user.id, stored.attempt_id, {
        status: "delete_outcome_unknown",
        provider_http_status: response.status,
        last_error:
          `WordPress Trash returned HTTP ${response.status}; do not send another provider DELETE.`,
      });
      return json(origin, 202, {
        deleted: false,
        outcomeUnknown: true,
        error:
          `WordPress returned HTTP ${response.status}; do not retry provider deletion. Verify Trash and finalize only the local checkpoint.`,
      });
    }
    if (!response.ok) {
      await updateCmsAttempt(service, guard.user.id, stored.attempt_id, {
        status: "verified",
        provider_http_status: response.status,
        last_error:
          `WordPress rejected reversible Trash with HTTP ${response.status}.`,
      });
      return json(origin, 502, {
        deleted: false,
        error:
          `WordPress did not confirm a reversible trash result (HTTP ${response.status}).`,
      });
    }
    if (String(payload?.status || "") !== "trash") {
      await updateCmsAttempt(service, guard.user.id, stored.attempt_id, {
        status: "delete_outcome_unknown",
        provider_http_status: response.status,
        last_error:
          "WordPress returned success without durable status=trash proof; do not send another provider DELETE.",
      });
      return json(origin, 202, {
        deleted: false,
        outcomeUnknown: true,
        error:
          "WordPress returned success without durable Trash proof. Do not retry provider deletion; verify Trash and finalize only the local checkpoint.",
      });
    }
    const checkpoint = await service.rpc(
      "cms_mark_provider_draft_trashed_service",
      {
        p_owner: guard.user.id,
        p_record_id: stored.id,
        p_attempt_id: stored.attempt_id,
        p_provider: "wordpress",
        p_provider_draft_id: stored.provider_draft_id,
        p_exact_target_id: stored.exact_target_id,
      },
    );
    if (checkpoint.error || checkpoint.data !== true) {
      return json(origin, 202, {
        deleted: true,
        permanent: false,
        providerTrashed: true,
        localCheckpointPending: true,
        error:
          "WordPress confirmed Trash, but the durable local checkpoint is pending. Do not retry provider deletion; reload and reconcile the local checkpoint.",
      });
    }
    await service.rpc("insert_agent_action_service", {
      p_owner: guard.user.id,
      p_persona_id: null,
      p_binding_id: null,
      p_action_type: "delete_external_cms_draft",
      p_entity_type: "draft",
      p_entity_id: draftId,
      p_outcome: "ok",
      p_detail: {
        provider: "wordpress",
        provider_draft_id: stored.provider_draft_id,
        permanent: false,
      },
    });
    return json(origin, 200, {
      deleted: true,
      permanent: false,
      providerStatus: "trash",
    });
  }
  return json(origin, 400, { error: "Unknown action" });
});
