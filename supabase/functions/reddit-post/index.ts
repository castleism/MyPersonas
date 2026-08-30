// reddit-post — publish one approved draft through the owner's connected
// Reddit account (official OAuth API, scope "submit").
//
// Frontend contract (POST, signed-in user's Supabase bearer token required):
//   { action:"prepare-publish-draft", draftId } -> short-lived exact receipt
//   { action:"publish-draft", draftId, receiptId } -> provider result | error
//
// Destination rule: if the draft's tags contain "r/<subreddit>", the post goes
// to that subreddit; otherwise it posts to the account's own profile
// (u_<username>). Link posts are used when the draft has a media URL and no
// body text; otherwise a self/text post.
//
// Same guard order as discord-post: global pause → owned approved non-terminal
// draft → Discord/Reddit account + share-aware persona check → connected state
// → atomic publishing lease → provider call → published/failed with a
// human-readable reason. Tokens come from Vault via service-role RPCs and are
// refreshed once on expiry.
//
// Deploy with default gateway JWT verification:
//   supabase functions deploy reddit-post
// Required secrets: REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET (for refresh).
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { requireAal2 } from "../_shared/aal2.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const REDDIT_CLIENT_ID = Deno.env.get("REDDIT_CLIENT_ID") || "";
const REDDIT_CLIENT_SECRET = Deno.env.get("REDDIT_CLIENT_SECRET") || "";
const APP_ORIGIN = Deno.env.get("REDDIT_OAUTH_APP_ORIGIN") || "https://mypersonas.online";
const USER_AGENT = "web:online.mypersonas:v0.5 (MyPersonas publisher)";
const PROVIDER_TIMEOUT_MS = 30_000;
const SAFE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

class ProviderOutcomeUncertainError extends Error {
  override name = "ProviderOutcomeUncertainError";
}

class PreProviderSafetyError extends Error {
  override name = "PreProviderSafetyError";
  status: number;

  constructor(message: string, status = 409) {
    super(message);
    this.status = status;
  }
}

function providerOutcomeIsUncertain(error: unknown): boolean {
  const name = String((error as { name?: string })?.name || "");
  return error instanceof ProviderOutcomeUncertainError || error instanceof TypeError ||
    name === "AbortError" || name === "TimeoutError";
}

function corsHeaders(origin: string): HeadersInit {
  const allowed = new Set([APP_ORIGIN, "http://localhost:8000", "http://127.0.0.1:8000"]);
  return {
    "Access-Control-Allow-Origin": allowed.has(origin) ? origin : APP_ORIGIN,
    "Access-Control-Allow-Headers": "authorization, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}
function json(origin: string, status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(origin),
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
function normalizeUsername(v: string): string {
  return (v || "").normalize("NFKC").trim().toLowerCase().replace(/^\/?u\//, "").replace(/^@/, "");
}
function pickSubreddit(tags: string, username: string): string {
  const match = (tags || "").match(/(?:^|[\s,])r\/([A-Za-z0-9_]{2,21})/);
  return match ? match[1] : `u_${username}`;
}

serve(async (req: Request): Promise<Response> => {
  const origin = req.headers.get("Origin") || "";
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(origin) });
  if (req.method !== "POST") return json(origin, 405, { error: "POST only" });

  const authorization = req.headers.get("Authorization") || "";
  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authorization } }, auth: { persistSession: false },
  });
  const guard = await requireAal2(req, userClient);
  if (!guard.ok) {
    return json(origin, guard.status, { error: guard.error, code: guard.code });
  }
  const uid = guard.user.id;

  let body: Record<string, unknown> = {};
  let draftId = "";
  try {
    body = await req.json() as Record<string, unknown>;
    draftId = String(body?.draftId || "");
  }
  catch (_e) { return json(origin, 400, { error: "Invalid request body" }); }
  if (!SAFE_UUID.test(draftId)) return json(origin, 400, { error: "A draft id is required" });
  const action = String(body.action || "publish-draft");
  if (!["prepare-publish-draft", "publish-draft"].includes(action)) {
    return json(origin, 400, { error: "Unknown action" });
  }
  const receiptId = String(body.receiptId || "");
  if (action === "publish-draft" && !SAFE_UUID.test(receiptId)) {
    return json(origin, 409, {
      error: "Open and approve the current server-generated Reddit preview before publishing.",
    });
  }

  const service = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  const { data: settings, error: settingsError } = await service.from("agent_owner_settings")
    .select("automation_paused").eq("owner", uid).maybeSingle();
  if (settingsError || !settings) {
    return json(origin, 503, { error: "The owner-wide automation safety setting could not be verified. Nothing was published." });
  }
  if (settings?.automation_paused) return json(origin, 409, { error: "The global automation pause is on. Resume it before publishing." });

  const { data: draft, error: draftError } = await service.from("drafts")
    .select("id,owner,persona_id,account_id,platform,title,body,tags,media_url,content_kind,publish_at,approval_state,approved_content_hash,publish_state,provider_post_id")
    .eq("id", draftId).eq("owner", uid).maybeSingle();
  if (draftError) return json(origin, 503, { error: "The approved draft could not be verified. Nothing was published." });
  if (!draft) return json(origin, 404, { error: "Owned draft not found" });
  if (!draft.account_id || draft.platform !== "reddit") return json(origin, 409, { error: "This draft is not assigned to a Reddit account" });
  if ((draft.approval_state || "draft") !== "approved" || !draft.approved_content_hash) {
    return json(origin, 409, { error: "Approve this exact draft before publishing it to Reddit" });
  }
  if (draft.provider_post_id) {
    return json(origin, 409, { error: "This draft already has a durable Reddit post identifier and cannot be submitted again" });
  }
  if (["publishing", "published"].includes(draft.publish_state || "")) return json(origin, 409, { error: "This draft is already publishing or published" });

  const { data: ledger, error: ledgerError } = await service.from("account_ledger")
    .select("id,owner,provider,persona_id,username,suspended")
    .eq("id", draft.account_id).eq("owner", uid).eq("provider", "reddit").maybeSingle();
  if (ledgerError) return json(origin, 503, { error: "The Reddit destination could not be verified. Nothing was published." });
  if (!ledger) return json(origin, 409, { error: "The Reddit account for this draft is no longer in your ledger" });
  if (ledger.suspended) return json(origin, 409, { error: "This Reddit destination is suspended. Resume it before publishing." });
  if (draft.persona_id && ledger.persona_id !== draft.persona_id) {
    const { data: shareLink, error: shareError } = await service.from("account_persona_links").select("ledger_id")
      .eq("ledger_id", ledger.id).eq("persona_id", draft.persona_id).eq("owner", uid).maybeSingle();
    if (shareError || !shareLink) return json(origin, 409, { error: "That Reddit account is no longer assigned to this draft's persona" });
  }
  const username = normalizeUsername(ledger.username || "");
  if (!username) return json(origin, 409, { error: "This Reddit record has no username" });

  const { data: connection, error: connectionError } = await service.from("account_connections")
    .select("ledger_id,connection_state,verification_method,granted_scopes")
    .eq("ledger_id", ledger.id).eq("owner", uid).maybeSingle();
  if (connectionError || !connection || connection.connection_state !== "connected" || connection.verification_method !== "reddit_oauth") {
    return json(origin, 409, { error: "Connect this Reddit account with the official authorization first" });
  }
  const scopes = Array.isArray(connection.granted_scopes) ? connection.granted_scopes : [];
  if (!scopes.includes("submit")) return json(origin, 409, { error: "This Reddit grant has no submit permission. Reconnect the account." });

  if (action === "prepare-publish-draft") {
    const issued = await service.rpc(
      "issue_immediate_agent_preview_receipt_service",
      {
        p_owner: uid,
        p_draft_id: draft.id,
        p_provider: "reddit",
        p_action: "reddit.publish_now",
      },
    );
    const receipt = (Array.isArray(issued.data) ? issued.data[0] : issued.data) as
      | Record<string, unknown>
      | null;
    if (issued.error || !receipt) {
      return json(origin, 409, {
        error: issued.error?.message ||
          "The server could not create an exact Reddit preview receipt. Nothing was published.",
      });
    }
    return json(origin, 200, { receipt });
  }

  // Atomically claim the same exact approved row that was validated above.
  // Protected draft fields cannot change once publishing begins, and every
  // provider input below comes from the claimed row rather than the stale read.
  // Receipt consumption and the state transition occur in one DB transaction.
  const claim = await service.rpc(
    "claim_immediate_agent_draft_with_preview_service",
    {
      p_owner: uid,
      p_draft_id: draft.id,
      p_provider: "reddit",
      p_action: "reddit.publish_now",
      p_receipt_id: receiptId,
    },
  );
  const claimed = (Array.isArray(claim.data) ? claim.data[0] : claim.data) as
    | typeof draft
    | null;
  if (claim.error) {
    return json(origin, 409, {
      error: claim.error.message ||
        "The server preview expired, was used, or no longer matches. Nothing was published.",
    });
  }
  if (!claimed) return json(origin, 409, { error: "This draft changed, lost approval, or is already being published" });
  // Preserve the successful narrowing inside the nested audit/reconciliation
  // helpers below; they execute only after the atomic claim succeeded.
  const claimedDraft = claimed;

  const title = (claimed.title || "").trim() || (claimed.body || "").trim().slice(0, 250) || "Untitled post";
  const media = (claimed.media_url || "").trim();
  const bodyText = [(claimed.body || "").trim(), (claimed.tags || "").trim()].filter(Boolean).join("\n\n");
  const isLink = Boolean(media && /^https:\/\/[^\s]+$/i.test(media) && !(claimed.body || "").trim());
  let subreddit = pickSubreddit(claimed.tags || "", username);

  async function writeAttemptAudit(outcome: "ok" | "error", detail: Record<string, unknown>) {
    const { error } = await service.rpc("insert_agent_action_service", {
      p_owner: uid,
      p_persona_id: claimedDraft.persona_id || null,
      p_binding_id: null,
      p_action_type: "publish_external_reddit",
      p_entity_type: "draft",
      p_entity_id: claimedDraft.id,
      p_outcome: outcome,
      p_detail: {
        account_id: claimedDraft.account_id,
        subreddit,
        approved_content_hash: claimedDraft.approved_content_hash,
        ...detail,
      },
    });
    return !error;
  }

  async function recordDefinitiveFailure(message: string, status = 502): Promise<Response> {
    const { data, error } = await service.from("drafts")
      .update({ publish_state: "failed", publish_error: message.slice(0, 500) })
      .eq("id", claimedDraft.id).eq("owner", uid).eq("publish_state", "publishing")
      .eq("provider_post_id", "")
      .select("id").maybeSingle();
    if (error || !data) {
      const auditWritten = await writeAttemptAudit("error", {
        error: message,
        retry_safe: false,
        reconciliation_required: true,
        state_checkpoint_missing: true,
      });
      return json(origin, 500, {
        status: "unknown",
        reconciliationRequired: true,
        error: "The safe pre-provider or rejected result could not be recorded. Reload and reconcile the draft before taking any action.",
        ...(auditWritten ? {} : { auditMissing: true }),
      });
    }
    const auditWritten = await writeAttemptAudit("error", {
      error: message,
      retry_safe: true,
    });
    return json(origin, status, {
      status: "failed",
      error: message,
      ...(auditWritten ? {} : { auditMissing: true }),
    });
  }

  async function recordUncertain(message: string, providerPostId = ""): Promise<Response> {
    const note = `${message} Do not retry until the Reddit account is reconciled.`.slice(0, 500);
    const { data, error } = await service.from("drafts")
      .update({ publish_error: note })
      .eq("id", claimedDraft.id).eq("owner", uid).eq("publish_state", "publishing")
      .select("id").maybeSingle();
    const auditWritten = await writeAttemptAudit("error", {
      error: note,
      retry_safe: false,
      reconciliation_required: true,
      ...(providerPostId ? { provider_post_id: providerPostId } : {}),
    });
    const common = {
      reconciliationRequired: true,
      ...(providerPostId ? { providerPostId } : {}),
      ...(auditWritten ? {} : { auditMissing: true }),
    };
    if (!error && data) {
      return json(origin, 202, {
        status: "publishing",
        ...common,
        error: note,
      });
    }
    const current = await service.from("drafts")
      .select("provider_post_id,publish_state").eq("id", claimedDraft.id)
      .eq("owner", uid).maybeSingle();
    if (!current.error && providerPostId &&
      current.data?.publish_state === "published" &&
      current.data.provider_post_id === providerPostId) {
      const completionAudit = await writeAttemptAudit("ok", {
        phase: "completion_verified_after_ambiguity",
        provider_post_id: providerPostId,
      });
      return json(origin, 200, {
        status: "published",
        published: true,
        fullname: providerPostId,
        ...(completionAudit ? {} : { auditMissing: true }),
      });
    }
    if (!current.error && current.data?.publish_state === "publishing") {
      return json(origin, 202, {
        status: "publishing",
        ...common,
        error: "Reddit's outcome is uncertain and the reconciliation note could not be persisted. Do not retry.",
      });
    }
    return json(origin, 202, {
      status: "unknown",
      ...common,
      error: "Reddit's outcome is uncertain and local state could not be verified. Do not retry.",
    });
  }

  // Recompute the canonical database hash from the exact row returned by the
  // compare-and-set claim. A non-empty/stable-looking hash is not enough.
  const { data: exactHash, error: hashError } = await service.rpc("agent_draft_hash", {
    p_title: claimed.title || "",
    p_body: claimed.body || "",
    p_tags: claimed.tags || "",
    p_media_url: claimed.media_url || "",
    p_content_kind: claimed.content_kind || "",
    p_persona_id: claimed.persona_id,
    p_account_id: claimed.account_id,
    p_platform: claimed.platform || "",
    p_publish_at: claimed.publish_at,
  });
  if (hashError || exactHash !== claimed.approved_content_hash) {
    return await recordDefinitiveFailure(
      "The approval no longer matches this exact Reddit draft. Approve it again before publishing.",
      409,
    );
  }

  // Re-read every mutable safety/destination record after the claim. Provider
  // inputs stay on the claimed row; mutable external authorization must still
  // be current immediately before a provider call.
  const [currentSettings, currentLedger, currentConnection] = await Promise.all([
    service.from("agent_owner_settings").select("automation_paused")
      .eq("owner", uid).maybeSingle(),
    service.from("account_ledger")
      .select("id,owner,provider,persona_id,username,suspended")
      .eq("id", claimed.account_id).eq("owner", uid).eq("provider", "reddit").maybeSingle(),
    service.from("account_connections")
      .select("ledger_id,connection_state,verification_method,granted_scopes")
      .eq("ledger_id", claimed.account_id).eq("owner", uid).maybeSingle(),
  ]);
  if (currentSettings.error || !currentSettings.data) {
    return await recordDefinitiveFailure(
      "The owner-wide automation safety setting became unavailable. Nothing was published.",
      503,
    );
  }
  if (currentSettings.data.automation_paused) {
    return await recordDefinitiveFailure(
      "The global automation pause turned on before the Reddit request. Nothing was published.",
      409,
    );
  }
  const activeLedger = currentLedger.data;
  if (currentLedger.error || !activeLedger || activeLedger.suspended) {
    return await recordDefinitiveFailure(
      "The Reddit destination became unavailable or suspended. Nothing was published.",
      409,
    );
  }
  if (claimed.persona_id && activeLedger.persona_id !== claimed.persona_id) {
    const share = await service.from("account_persona_links").select("ledger_id")
      .eq("ledger_id", activeLedger.id).eq("persona_id", claimed.persona_id)
      .eq("owner", uid).maybeSingle();
    if (share.error || !share.data) {
      return await recordDefinitiveFailure(
        "The Reddit destination is no longer assigned to this draft's persona. Nothing was published.",
        409,
      );
    }
  }
  const activeConnection = currentConnection.data;
  const activeScopes = Array.isArray(activeConnection?.granted_scopes)
    ? activeConnection.granted_scopes
    : [];
  if (currentConnection.error || !activeConnection ||
    activeConnection.connection_state !== "connected" ||
    activeConnection.verification_method !== "reddit_oauth" ||
    !activeScopes.includes("submit")) {
    return await recordDefinitiveFailure(
      "The official Reddit submit authorization became unavailable. Nothing was published.",
      409,
    );
  }
  const activeUsername = normalizeUsername(activeLedger.username || "");
  if (!activeUsername) {
    return await recordDefinitiveFailure(
      "The Reddit destination no longer has a valid username. Nothing was published.",
      409,
    );
  }
  subreddit = pickSubreddit(claimed.tags || "", activeUsername);

  const { data: tokenRows, error: tokenError } = await service.rpc(
    "reddit_get_tokens_service",
    { p_ledger_id: activeLedger.id },
  );
  const tokenRow = Array.isArray(tokenRows) ? tokenRows[0] : tokenRows;
  let accessToken = String(tokenRow?.access_token || "");
  const refreshToken = String(tokenRow?.refresh_token || "");
  if (tokenError || !accessToken) {
    return await recordDefinitiveFailure(
      "Stored Reddit access could not be read. Reconnect the account before publishing.",
      409,
    );
  }

  async function submit(
    token: string,
    attempt: "initial" | "after_refresh",
  ): Promise<Response> {
    const pause = await service.from("agent_owner_settings")
      .select("automation_paused").eq("owner", uid).maybeSingle();
    if (pause.error || !pause.data) {
      throw new PreProviderSafetyError(
        "The owner-wide automation safety setting could not be rechecked. Nothing was published.",
        503,
      );
    }
    if (pause.data.automation_paused) {
      throw new PreProviderSafetyError(
        "The global automation pause turned on before the Reddit request. Nothing was published.",
      );
    }
    const audited = await writeAttemptAudit("ok", {
      phase: "provider_request_start",
      attempt,
      retry_safe: false,
    });
    if (!audited) {
      throw new PreProviderSafetyError(
        "The Reddit provider request could not be audited. Nothing was published.",
        503,
      );
    }
    const form = new URLSearchParams({
      api_type: "json", sr: subreddit, title: title.slice(0, 300),
      kind: isLink ? "link" : "self", sendreplies: "true",
    });
    if (isLink) form.set("url", media); else form.set("text", bodyText);
    return fetch("https://oauth.reddit.com/api/submit", {
      method: "POST",
      headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/x-www-form-urlencoded", "User-Agent": USER_AGENT },
      body: form,
      redirect: "error",
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });
  }

  let response: Response;
  try {
    response = await submit(accessToken, "initial");
  } catch (error) {
    if (error instanceof PreProviderSafetyError) {
      return await recordDefinitiveFailure(error.message, error.status);
    }
    if (providerOutcomeIsUncertain(error)) {
      return await recordUncertain("Reddit did not return a durable result for the submit request.");
    }
    return await recordUncertain("Reddit's submit request ended without a durable result.");
  }
  if (response.status === 408 || response.status >= 500) {
    return await recordUncertain(`Reddit returned HTTP ${response.status} after the submit request.`);
  }
  if (response.status === 401 && refreshToken && REDDIT_CLIENT_ID && REDDIT_CLIENT_SECRET) {
    let refreshResponse: Response;
    try {
      refreshResponse = await fetch("https://www.reddit.com/api/v1/access_token", {
        method: "POST",
        headers: {
          "Authorization": "Basic " + btoa(`${REDDIT_CLIENT_ID}:${REDDIT_CLIENT_SECRET}`),
          "Content-Type": "application/x-www-form-urlencoded", "User-Agent": USER_AGENT,
        },
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }),
        redirect: "error",
        signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
      });
    } catch {
      return await recordDefinitiveFailure("Reddit access expired and the refresh request failed. Reconnect the account.", 409);
    }
    const refreshed = await refreshResponse.json().catch(() => ({}));
    if (refreshResponse.ok && refreshed.access_token) {
      accessToken = String(refreshed.access_token);
      const expiresAt = new Date(Date.now() + Math.max(60, Number(refreshed.expires_in || 3600)) * 1000).toISOString();
      const { error: rotateError } = await service.rpc("reddit_update_access_token_service", {
        p_ledger_id: activeLedger.id, p_access_token: accessToken, p_expires_at: expiresAt,
      });
      if (rotateError) {
        return await recordDefinitiveFailure("Reddit access refreshed, but the rotated token could not be stored. Reconnect before publishing.", 409);
      }
      try {
        response = await submit(accessToken, "after_refresh");
      } catch (error) {
        if (error instanceof PreProviderSafetyError) {
          return await recordDefinitiveFailure(error.message, error.status);
        }
        if (providerOutcomeIsUncertain(error)) {
          return await recordUncertain("Reddit did not return a durable result for the retried submit request.");
        }
        return await recordUncertain("Reddit's retried submit request ended without a durable result.");
      }
      if (response.status === 408 || response.status >= 500) {
        return await recordUncertain(`Reddit returned HTTP ${response.status} after the retried submit request.`);
      }
    } else {
      return await recordDefinitiveFailure("Reddit access expired and could not refresh. Reconnect the account.", 409);
    }
  }

  let failure = "", postUrl = "", fullname = "";
  if (!response.ok) {
    failure = response.status === 401
      ? "Reddit access expired and could not refresh. Reconnect the account."
      : response.status === 429
        ? "Reddit rate-limited this account. Try again later."
        : `Reddit returned HTTP ${response.status}`;
  } else {
    const result = await response.json().catch(() => null);
    if (!result) return await recordUncertain("Reddit accepted the submit request but returned no readable result.");
    const errors = result?.json?.errors;
    if (Array.isArray(errors) && errors.length) {
      failure = errors.map((e: unknown[]) => (Array.isArray(e) ? e.slice(0, 2).join(": ") : String(e))).join("; ").slice(0, 400);
    } else {
      postUrl = String(result?.json?.data?.url || "");
      fullname = String(result?.json?.data?.name || "");
      if (!/^t3_[A-Za-z0-9]+$/.test(fullname)) {
        return await recordUncertain("Reddit accepted the submit request but returned no durable post identifier.");
      }
    }
  }

  if (failure) {
    return await recordDefinitiveFailure(failure);
  }

  // Persist the durable provider identifier before the broader completion
  // transition. Once this checkpoint exists, every retry path is blocked even
  // if finalization or its response is interrupted.
  const { data: checkpointed, error: checkpointError } = await service.from("drafts")
    .update({
      provider_post_id: fullname,
      publish_error: "Reddit accepted the post; local finalization is in progress.",
    })
    .eq("id", claimed.id).eq("owner", uid).eq("publish_state", "publishing")
    .eq("provider_post_id", "")
    .select("id,provider_post_id,publish_state").maybeSingle();
  if (checkpointError || !checkpointed || checkpointed.provider_post_id !== fullname) {
    const checkpointRead = await service.from("drafts")
      .select("provider_post_id,publish_state").eq("id", claimed.id)
      .eq("owner", uid).maybeSingle();
    if (checkpointRead.error || checkpointRead.data?.provider_post_id !== fullname) {
      return await recordUncertain(
        `Reddit published ${fullname}, but its durable provider identifier could not be verified locally.`,
        fullname,
      );
    }
  }

  const postedAt = new Date().toISOString();
  const { data: finalized, error: finalizeError } = await service.from("drafts")
    .update({
      status: "posted",
      publish_state: "published",
      publish_error: "",
      posted_at: postedAt,
    })
    .eq("id", claimed.id).eq("owner", uid).eq("publish_state", "publishing")
    .eq("provider_post_id", fullname)
    .select("id,provider_post_id,publish_state").maybeSingle();
  if (finalizeError || !finalized || finalized.provider_post_id !== fullname) {
    const { data: reread } = await service.from("drafts")
      .select("provider_post_id,publish_state").eq("id", claimed.id).eq("owner", uid).maybeSingle();
    if (reread?.publish_state !== "published" || reread?.provider_post_id !== fullname) {
      return await recordUncertain(
        `Reddit published ${fullname}, but the local completion checkpoint could not be verified.`,
        fullname,
      );
    }
  }
  const auditWritten = await writeAttemptAudit("ok", {
    phase: "completed",
    provider_post_id: fullname,
    provider_url: postUrl,
    posted_at: postedAt,
  });
  return json(origin, 200, {
    status: "published",
    published: true,
    url: postUrl,
    fullname,
    ...(auditWritten ? {} : { auditMissing: true }),
  });
});
