// Owner-triggered Wix Blog draft creation only. There is intentionally no
// publish or scheduling action in this function.
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { requireAal2 } from "../_shared/aal2.ts";
import {
  claimCmsAttempt,
  claimCmsAttemptWithPreview,
  type CmsAttempt,
  type CmsDraftContext,
  cmsFingerprint,
  exactPlainText,
  extractRicosText,
  loadCmsAppSecret,
  loadExactCmsDraft,
  prepareCmsActionPreview,
  providerOutcomeUncertain,
  recordVerifiedCmsDraft,
  ricosPlainText,
  sha256Hex,
  updateCmsAttempt,
} from "../_shared/cms-drafts.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const APP_ID = Deno.env.get("WIX_APP_ID") || "";
const APP_ORIGIN = Deno.env.get("WIX_OAUTH_APP_ORIGIN") ||
  "https://mypersonas.online";
const TOKEN_URL = "https://www.wixapis.com/oauth2/token";
const BLOG_URL = "https://www.wixapis.com/blog/v3/draft-posts";
const SAFE_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_WIX_ID = /^[0-9A-Za-z_-]{8,100}$/;
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

async function wixAccessToken(instanceId: string, appSecret: string) {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      grant_type: "client_credentials",
      client_id: APP_ID,
      client_secret: appSecret,
      instance_id: instanceId,
    }),
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
  const outer = await response.json().catch(() => null) as
    | Record<string, unknown>
    | null;
  let payload = outer;
  if (outer && typeof outer.body === "string") {
    try {
      payload = JSON.parse(outer.body) as Record<string, unknown>;
    } catch {
      payload = null;
    }
  }
  const statusCode = Number(outer?.statusCode || response.status);
  const token = String(payload?.access_token || payload?.accessToken || "");
  return response.ok && statusCode < 400 && token && token.length <= 32768
    ? token
    : "";
}

function wixHeaders(accessToken: string, siteId: string) {
  return {
    Authorization: accessToken,
    "wix-site-id": siteId,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}
function wixSecret(context: CmsDraftContext) {
  const instanceId = String(context.credential.secret.instance_id || "");
  return SAFE_UUID.test(instanceId) &&
      SAFE_UUID.test(context.credential.site_id) &&
      SAFE_WIX_ID.test(context.credential.author_id)
    ? {
      instanceId,
      siteId: context.credential.site_id,
      memberId: context.credential.author_id,
    }
    : null;
}
function providerEditUrl(siteId: string) {
  // Wix documents this stable exact-site dashboard route. Its internal Blog
  // composer deep links are not a public API contract, so the owner continues
  // from Blog > Posts > Drafts and uses Wix's own preview there.
  return `https://manage.wix.com/dashboard/${encodeURIComponent(siteId)}`;
}
function draftObject(payload: Record<string, unknown> | null) {
  return payload?.draftPost && typeof payload.draftPost === "object"
    ? payload.draftPost as Record<string, unknown>
    : null;
}
function wixDraftMatches(
  context: CmsDraftContext,
  draft: Record<string, unknown>,
) {
  return String(draft.id || draft._id || "").length > 0 &&
    String(draft.title || "") === context.draft.title &&
    String(draft.memberId || "") === context.credential.author_id &&
    String(draft.status || "").toUpperCase() === "UNPUBLISHED" &&
    extractRicosText(draft.richContent) ===
      exactPlainText(context.draft.body, context.draft.tags);
}
async function getWixDraft(
  context: CmsDraftContext,
  accessToken: string,
  providerDraftId: string,
) {
  const response = await fetch(
    `${BLOG_URL}/${encodeURIComponent(providerDraftId)}?fieldsets=URL`,
    {
      headers: wixHeaders(accessToken, context.credential.site_id),
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    },
  );
  const payload = await response.json().catch(() => null) as
    | Record<string, unknown>
    | null;
  return { response, payload, draft: draftObject(payload) };
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
    .eq("exact_target_id", target).eq("provider", "wix").maybeSingle();
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
      provider: "wix",
      attempt_id: attempt.id,
      exact_target_id: context.connection.provider_subject,
      approved_content_hash: context.draft.approved_content_hash,
      publish: false,
    },
  });
  return !result.error;
}

async function verifyAndRecord(
  context: CmsDraftContext,
  attempt: CmsAttempt,
  accessToken: string,
  providerDraftId: string,
) {
  let readback;
  try {
    readback = await getWixDraft(context, accessToken, providerDraftId);
  } catch {
    await updateCmsAttempt(service, context.draft.owner, attempt.id, {
      status: "provider_created",
      provider_draft_id: providerDraftId,
      last_error:
        "Wix returned a draft ID, but readback did not complete. Reconcile before retrying.",
    });
    return {
      error: "Wix created a draft, but readback needs reconciliation.",
      status: 202,
    };
  }
  if (
    !readback.response.ok || !readback.draft ||
    !wixDraftMatches(context, readback.draft)
  ) {
    await updateCmsAttempt(service, context.draft.owner, attempt.id, {
      status: "provider_created",
      provider_draft_id: providerDraftId,
      provider_http_status: readback.response.status,
      last_error:
        "Wix readback did not match the exact approved title, text, site, and author.",
    });
    return {
      error:
        "Wix returned a draft, but exact readback did not match. Reconcile before retrying.",
      status: 202,
    };
  }
  // Wix returns the future public URL shape for a draft, not an authenticated
  // active-theme draft-preview deep link. Do not mislabel or expose it as a
  // provider preview. The exact site's Blog Drafts dashboard is returned as
  // the edit/review handoff instead.
  const previewUrl = "";
  const recorded = await recordVerifiedCmsDraft(
    service,
    context,
    attempt,
    providerDraftId,
    await sha256Hex(exactPlainText(context.draft.body, context.draft.tags)),
    previewUrl,
    providerEditUrl(context.credential.site_id),
  );
  if (recorded.error) return { error: recorded.error, status: 202 };
  return {
    data: {
      staged: true,
      published: false,
      provider: "wix",
      providerDraftId,
      providerStatus: "draft",
      providerPreviewUrl: previewUrl,
      providerEditUrl: providerEditUrl(context.credential.site_id),
      exactTargetId: context.connection.provider_subject,
      siteId: context.credential.site_id,
      siteName: context.credential.site_name,
      authorId: context.credential.author_id,
      authorName: context.credential.author_name,
    },
    status: 200,
  };
}

async function createDraft(context: CmsDraftContext, attempt: CmsAttempt) {
  const secret = wixSecret(context);
  const appSecret = await loadCmsAppSecret(service, "wix_app_secret");
  if (!secret || !APP_ID || !appSecret) {
    await updateCmsAttempt(service, context.draft.owner, attempt.id, {
      status: "definitive_failure",
      last_error:
        "Wix configuration or the exact credential was unavailable. Nothing was sent.",
    });
    return { error: "Reconnect Wix before staging a draft.", status: 409 };
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
  const accessToken = await wixAccessToken(secret.instanceId, appSecret);
  if (!accessToken) {
    await updateCmsAttempt(service, context.draft.owner, attempt.id, {
      status: "definitive_failure",
      last_error: "Wix access could not be generated. Reinstall the app.",
    });
    return {
      error: "Wix access could not be generated. Reinstall the app.",
      status: 409,
    };
  }
  let response: Response;
  try {
    response = await fetch(BLOG_URL, {
      method: "POST",
      headers: wixHeaders(accessToken, secret.siteId),
      body: JSON.stringify({
        draftPost: {
          title: context.draft.title,
          memberId: secret.memberId,
          richContent: ricosPlainText(context.draft.body, context.draft.tags),
        },
        fieldsets: ["URL"],
        publish: false,
      }),
      redirect: "error",
      signal: AbortSignal.timeout(25_000),
    });
  } catch (error) {
    const uncertain = providerOutcomeUncertain(error);
    await updateCmsAttempt(service, context.draft.owner, attempt.id, {
      status: uncertain ? "outcome_unknown" : "definitive_failure",
      last_error: uncertain
        ? "Wix did not return a durable result. Reconcile before retrying."
        : "The Wix request failed before a provider result.",
    });
    return {
      error: uncertain
        ? "Wix's outcome is unknown. Reconcile before retrying."
        : "The Wix request failed before a provider result.",
      status: uncertain ? 202 : 502,
    };
  }
  const payload = await response.json().catch(() => null) as
    | Record<string, unknown>
    | null;
  if (response.status === 408 || response.status >= 500) {
    await updateCmsAttempt(service, context.draft.owner, attempt.id, {
      status: "outcome_unknown",
      provider_http_status: response.status,
      last_error:
        `Wix returned HTTP ${response.status}. Reconcile before retrying.`,
    });
    return {
      error: `Wix returned HTTP ${response.status}. Reconcile before retrying.`,
      status: 202,
    };
  }
  if (!response.ok) {
    await updateCmsAttempt(service, context.draft.owner, attempt.id, {
      status: "definitive_failure",
      provider_http_status: response.status,
      last_error:
        `Wix rejected the draft request with HTTP ${response.status}.`,
    });
    return {
      error: `Wix rejected the draft request with HTTP ${response.status}.`,
      status: 502,
    };
  }
  const draft = draftObject(payload);
  const providerDraftId = String(draft?.id || draft?._id || "");
  if (!SAFE_WIX_ID.test(providerDraftId)) {
    await updateCmsAttempt(service, context.draft.owner, attempt.id, {
      status: "outcome_unknown",
      provider_http_status: response.status,
      last_error:
        "Wix accepted the request without a durable draft ID. Reconcile before retrying.",
    });
    return {
      error:
        "Wix accepted the request without a durable draft ID. Reconcile before retrying.",
      status: 202,
    };
  }
  await updateCmsAttempt(service, context.draft.owner, attempt.id, {
    status: "provider_created",
    provider_draft_id: providerDraftId,
    provider_http_status: response.status,
    provider_accepted_at: new Date().toISOString(),
    last_error: "Wix accepted the draft; exact readback is in progress.",
  });
  return await verifyAndRecord(context, attempt, accessToken, providerDraftId);
}

async function reconcileDraft(context: CmsDraftContext, attempt: CmsAttempt) {
  const secret = wixSecret(context);
  const appSecret = await loadCmsAppSecret(service, "wix_app_secret");
  if (!secret || !APP_ID || !appSecret) {
    return { error: "Reconnect Wix before reconciliation.", status: 409 };
  }
  const accessToken = await wixAccessToken(secret.instanceId, appSecret);
  if (!accessToken) {
    return { error: "Wix access could not be generated.", status: 409 };
  }
  if (attempt.provider_draft_id) {
    return await verifyAndRecord(
      context,
      attempt,
      accessToken,
      attempt.provider_draft_id,
    );
  }
  let response: Response;
  try {
    response = await fetch(`${BLOG_URL}/query`, {
      method: "POST",
      headers: wixHeaders(accessToken, secret.siteId),
      body: JSON.stringify({
        query: {
          filter: { title: { "$eq": context.draft.title } },
          paging: { limit: 100 },
        },
        fieldsets: ["URL"],
      }),
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    return {
      error:
        "Wix reconciliation could not complete. Do not retry the create request.",
      status: 202,
    };
  }
  const payload = await response.json().catch(() => null) as
    | Record<string, unknown>
    | null;
  const rows = response.ok && Array.isArray(payload?.draftPosts)
    ? payload.draftPosts
    : [];
  const paging = payload?.pagingMetadata as Record<string, unknown> | undefined;
  const total = paging?.total;
  if (
    !response.ok || typeof total !== "number" || !Number.isSafeInteger(total) ||
    total < 0 || total !== rows.length
  ) {
    return {
      error:
        "Wix did not return complete, trustworthy result-count evidence for this reconciliation. Review the Wix Drafts workspace; do not retry creation.",
      status: 202,
    };
  }
  const attemptStart = new Date(attempt.started_at || "").getTime();
  const matches = rows.filter((row) => {
    if (
      !row || typeof row !== "object" ||
      !wixDraftMatches(context, row as Record<string, unknown>)
    ) return false;
    const createdAt = new Date(
      String((row as Record<string, unknown>).createdDate || ""),
    ).getTime();
    return Number.isFinite(attemptStart) && Number.isFinite(createdAt) &&
      createdAt >= attemptStart - 120_000 && createdAt <= Date.now() + 60_000;
  })
    .map((row) =>
      String(
        (row as Record<string, unknown>).id ||
          (row as Record<string, unknown>)._id || "",
      )
    )
    .filter((id) => SAFE_WIX_ID.test(id));
  if (matches.length !== 1) {
    return {
      error: matches.length > 1
        ? "More than one matching Wix draft exists. Review the Wix dashboard before taking any action."
        : "No exact matching Wix draft is visible yet. Do not retry creation; reconcile again later.",
      status: 202,
    };
  }
  await updateCmsAttempt(service, context.draft.owner, attempt.id, {
    status: "provider_created",
    provider_draft_id: matches[0],
    provider_accepted_at: new Date().toISOString(),
    last_error:
      "Wix reconciliation found one exact draft; readback is in progress.",
  });
  return await verifyAndRecord(context, attempt, accessToken, matches[0]);
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
      "wix",
    );
    if (!loaded.context) {
      return json(origin, loaded.status || 409, {
        error: loaded.error || "Wix draft preview is unavailable",
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
          "The Wix server preview receipt could not be prepared",
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
      "wix",
    );
    if (!loaded.context) {
      return json(origin, loaded.status || 409, {
        error: loaded.error || "Wix draft is unavailable",
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
        provider: "wix",
        ...prior,
      });
    }
    const receiptId = String(body.receiptId || "");
    if (action === "create-draft" && !SAFE_UUID.test(receiptId)) {
      return json(origin, 409, {
        error:
          "A current acknowledged one-shot Wix preview receipt is required",
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
        error: claimed.blocked || "The Wix attempt is unavailable",
      });
    }
    if (claimed.attempt.status === "verified") {
      return json(origin, 409, {
        error:
          "The verified Wix draft checkpoint could not be read. Reconcile before any retry.",
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
      "wix",
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
          "The Wix destination changed after the provider operation was claimed",
      });
    }
    const result = action === "reconcile"
      ? await reconcileDraft(fresh.context, claimed.attempt)
      : await createDraft(fresh.context, claimed.attempt);
    return json(
      origin,
      result.status || 200,
      result.data || { error: result.error || "Wix draft operation failed" },
    );
  }

  const storedResult = await service.from("cms_provider_drafts")
    .select(
      "id,ledger_id,attempt_id,provider_draft_id,provider_status,provider_preview_url,provider_edit_url,title,provider_content_hash,exact_target_id",
    )
    .eq("owner", guard.user.id).eq("draft_id", draftId).eq("provider", "wix")
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (storedResult.error || !storedResult.data) {
    return json(origin, 404, {
      error: "No verified Wix provider draft exists",
    });
  }
  const stored = storedResult.data;
  const credentialResult = await service.rpc("cms_get_credential_service", {
    p_ledger_id: stored.ledger_id,
    p_owner: guard.user.id,
  });
  const credential = (Array.isArray(credentialResult.data)
    ? credentialResult.data[0]
    : credentialResult.data) as Record<string, unknown> | undefined;
  const secret = credential?.secret && typeof credential.secret === "object"
    ? credential.secret as Record<string, unknown>
    : {};
  const instanceId = String(secret.instance_id || "");
  const siteId = String(credential?.site_id || "");
  if (
    credentialResult.error || !credential ||
    credential.provider_subject !== stored.exact_target_id ||
    !SAFE_UUID.test(instanceId) || !SAFE_UUID.test(siteId)
  ) {
    return json(origin, 409, {
      error:
        "The Wix site binding changed. Reconnect before verification or deletion.",
    });
  }
  if (action === "finalize-trash-checkpoint") {
    if (
      body.confirmProviderTrash !== true ||
      String(body.expectedProviderDraftId || "") !== stored.provider_draft_id ||
      String(body.expectedTargetId || "") !== stored.exact_target_id
    ) {
      return json(origin, 400, {
        error:
          "Confirm the exact Wix draft ID and site/author target after visually verifying it is in Wix Trash.",
      });
    }
    const checkpoint = await service.rpc(
      "cms_mark_provider_draft_trashed_service",
      {
        p_owner: guard.user.id,
        p_record_id: stored.id,
        p_attempt_id: stored.attempt_id,
        p_provider: "wix",
        p_provider_draft_id: stored.provider_draft_id,
        p_exact_target_id: stored.exact_target_id,
      },
    );
    if (checkpoint.error || checkpoint.data !== true) {
      return json(origin, 503, {
        error:
          "The Wix Trash checkpoint is still pending. No provider request was sent.",
      });
    }
    return json(origin, 200, {
      checkpointFinalized: true,
      deleted: true,
      permanent: false,
      providerStatus: "trash",
    });
  }
  const appSecret = await loadCmsAppSecret(service, "wix_app_secret");
  const accessToken = appSecret
    ? await wixAccessToken(instanceId, appSecret)
    : "";
  if (!accessToken) {
    return json(origin, 409, { error: "Wix access could not be generated" });
  }
  if (action === "verify-draft") {
    if (stored.provider_status !== "draft") {
      return json(origin, 409, {
        verified: false,
        error: "This Wix checkpoint is no longer a draft",
      });
    }
    const response = await getWixDraft(
      { credential } as CmsDraftContext,
      accessToken,
      stored.provider_draft_id,
    );
    if (
      !response.response.ok || !response.draft ||
      String(response.draft.status || "").toUpperCase() !== "UNPUBLISHED" ||
      String(response.draft.memberId || "") !==
        String(credential.author_id || "") ||
      String(response.draft.title || "") !== stored.title ||
      await sha256Hex(extractRicosText(response.draft.richContent)) !==
        stored.provider_content_hash
    ) {
      return json(origin, 409, {
        verified: false,
        error:
          "Wix no longer reports this exact site, author, title, and content as an unpublished draft",
      });
    }
    await service.from("cms_provider_drafts").update({
      verified_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).eq("id", stored.id).eq("owner", guard.user.id);
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
        error: "This Wix checkpoint is no longer a draft",
      });
    }
    if (body.confirmDelete !== true) {
      return json(origin, 400, {
        error:
          "Explicit confirmDelete:true is required to move the Wix draft to trash",
      });
    }
    if (
      String(body.expectedProviderDraftId || "") !== stored.provider_draft_id ||
      String(body.expectedTargetId || "") !== stored.exact_target_id
    ) {
      return json(origin, 409, {
        error:
          "The Wix draft or exact site/author target changed after confirmation. Nothing was sent.",
      });
    }
    const audited = await service.rpc("insert_agent_action_service", {
      p_owner: guard.user.id,
      p_persona_id: null,
      p_binding_id: null,
      p_action_type: "delete_external_cms_draft_start",
      p_entity_type: "draft",
      p_entity_id: draftId,
      p_outcome: "ok",
      p_detail: {
        provider: "wix",
        provider_draft_id: stored.provider_draft_id,
        permanent: false,
      },
    });
    if (audited.error) {
      return json(origin, 503, {
        error: "The delete request could not be audited. Nothing was sent.",
      });
    }
    const claim = await service.rpc("cms_claim_provider_draft_trash_service", {
      p_owner: guard.user.id,
      p_record_id: stored.id,
      p_attempt_id: stored.attempt_id,
      p_provider: "wix",
      p_provider_draft_id: stored.provider_draft_id,
      p_exact_target_id: stored.exact_target_id,
    });
    if (claim.error || claim.data !== true) {
      return json(origin, 409, {
        error:
          "This Wix Trash request is already pending or changed. No duplicate provider delete was sent.",
      });
    }
    let response: Response;
    try {
      response = await fetch(
        `${BLOG_URL}/${
          encodeURIComponent(stored.provider_draft_id)
        }?permanent=false`,
        {
          method: "DELETE",
          headers: wixHeaders(accessToken, siteId),
          redirect: "error",
          signal: AbortSignal.timeout(20_000),
        },
      );
    } catch (error) {
      const uncertain = providerOutcomeUncertain(error);
      await updateCmsAttempt(service, guard.user.id, stored.attempt_id, {
        status: uncertain ? "delete_outcome_unknown" : "verified",
        last_error: uncertain
          ? "Wix Trash outcome is unknown; do not send another provider DELETE."
          : "Wix Trash request failed before a provider outcome was possible.",
      });
      return json(origin, uncertain ? 202 : 502, {
        deleted: false,
        outcomeUnknown: uncertain,
        error: uncertain
          ? "Wix did not return a durable delete result. Do not retry provider deletion; verify Trash and finalize only the local checkpoint."
          : "Wix Trash failed before a provider outcome was possible.",
      });
    }
    if (response.status === 408 || response.status >= 500) {
      await updateCmsAttempt(service, guard.user.id, stored.attempt_id, {
        status: "delete_outcome_unknown",
        provider_http_status: response.status,
        last_error:
          `Wix Trash returned HTTP ${response.status}; do not send another provider DELETE.`,
      });
      return json(origin, 202, {
        deleted: false,
        outcomeUnknown: true,
        error:
          `Wix returned HTTP ${response.status}; do not retry provider deletion. Verify Trash and finalize only the local checkpoint.`,
      });
    }
    if (!response.ok) {
      await updateCmsAttempt(service, guard.user.id, stored.attempt_id, {
        status: "verified",
        provider_http_status: response.status,
        last_error:
          `Wix rejected the reversible Trash request with HTTP ${response.status}.`,
      });
      return json(origin, 502, {
        deleted: false,
        error: `Wix returned HTTP ${response.status}`,
      });
    }
    const checkpoint = await service.rpc(
      "cms_mark_provider_draft_trashed_service",
      {
        p_owner: guard.user.id,
        p_record_id: stored.id,
        p_attempt_id: stored.attempt_id,
        p_provider: "wix",
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
          "Wix confirmed Trash, but the durable local checkpoint is pending. Do not retry provider deletion; reload and reconcile the local checkpoint.",
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
        provider: "wix",
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
