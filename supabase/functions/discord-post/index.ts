// discord-post — owner-pressed exact-approved Discord channel publishing.
//
// POST with an AAL2 Supabase session:
//   { action:"prepare-publish", draftId }
//   { action:"publish", draftId, receiptId }
//   { action:"verify", draftId }
//   { action:"delete", draftId, confirmMessageId, confirmChannelId }
//
// Only generic public.drafts rows are accepted. The database atomically checks
// owner, canonical approval hash, durable platform preview target, current
// persona/account assignment, exact OAuth channel binding, connection scope,
// suspension, global pause, and prior provider outcomes before it creates an
// attempt and moves the draft to publishing.
//
// Discord execution always uses wait=true and allowed_mentions.parse=[] so the
// response contains a durable message id and approved text cannot trigger
// mentions. A lost/ambiguous provider response permanently blocks automatic
// retry until reconciliation. No scheduler or background worker calls this
// endpoint; Discord remains Publish-now only.
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import {
  createClient,
  type SupabaseClient,
} from "https://esm.sh/@supabase/supabase-js@2";
import { requireAal2 } from "../_shared/aal2.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const APP_ORIGIN = (Deno.env.get("DISCORD_OAUTH_APP_ORIGIN") ||
  "https://mypersonas.online").replace(/\/$/, "");
const API_BASE = "https://discord.com/api/v10";
const PROVIDER_TIMEOUT_MS = 20_000;
const DISCORD_CONTENT_LIMIT = 2000;
const SAFE_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SNOWFLAKE = /^[0-9]{10,25}$/;
const WEBHOOK_TOKEN = /^[A-Za-z0-9_.-]{30,255}$/;
const ALLOWED_ORIGINS = new Set([
  APP_ORIGIN,
  "https://www.mypersonas.online",
  "http://localhost:8000",
  "http://localhost:5500",
  "http://127.0.0.1:8000",
  "http://127.0.0.1:5500",
]);

type RequestBody = {
  action?: unknown;
  draftId?: unknown;
  receiptId?: unknown;
  confirmMessageId?: unknown;
  confirmChannelId?: unknown;
};

type ClaimedDraft = {
  attempt_id: string;
  draft_id: string;
  ledger_id: string;
  persona_id: string;
  title: string | null;
  body: string | null;
  tags: string | null;
  media_url: string | null;
  content_kind: string;
  approval_hash: string;
  webhook_id: string;
  channel_id: string;
};

type MessageReference = {
  attempt_id: string;
  ledger_id: string;
  webhook_id: string;
  channel_id: string;
  message_id: string;
  attempt_status: string;
};

type SecretBundle = {
  legacy?: unknown;
  webhook_url?: unknown;
  webhook_token?: unknown;
  webhook_id?: unknown;
  channel_id?: unknown;
};

function corsHeaders(origin: string): HeadersInit {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.has(origin)
      ? origin
      : APP_ORIGIN,
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
      ...corsHeaders(origin),
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function parseBundle(value: unknown): SecretBundle | null {
  let parsed = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return null;
    }
  }
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as SecretBundle
    : null;
}

function composeContent(draft: ClaimedDraft) {
  const title = String(draft.title || "").trim();
  const body = String(draft.body || "").trim();
  const tags = String(draft.tags || "").trim();
  const media = String(draft.media_url || "").trim();
  if (media && !isCredentialFreeHttpsUrl(media)) {
    return {
      error:
        "The approved Discord media link must be one credential-free HTTPS URL.",
      content: "",
    };
  }
  const parts: string[] = [];
  if (title) parts.push(`**${title}**`);
  if (body) parts.push(body);
  if (tags) parts.push(tags);
  if (media) parts.push(media);
  const content = parts.join("\n\n").trim();
  if (!content) {
    return { error: "This approved Discord draft is empty.", content: "" };
  }
  if (content.length > DISCORD_CONTENT_LIMIT) {
    return {
      error:
        `The approved Discord preview is ${content.length} characters; Discord allows ${DISCORD_CONTENT_LIMIT}. Edit and approve a new preview.`,
      content: "",
    };
  }
  return { error: "", content };
}

function isCredentialFreeHttpsUrl(value: string) {
  if (/\s/.test(value)) return false;
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "https:" || !parsed.hostname || parsed.username ||
      parsed.password
    ) return false;
    for (const [rawKey] of parsed.searchParams) {
      const key = rawKey.toLowerCase();
      if (
        key.startsWith("x-amz-") || key.startsWith("x-goog-") ||
        [
          "access_token",
          "api_key",
          "apikey",
          "auth",
          "authorization",
          "credential",
          "jwt",
          "key",
          "key-pair-id",
          "policy",
          "secret",
          "sig",
          "signature",
          "token",
        ].includes(key)
      ) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function expectedWebhookUrl(webhookId: string, token: string) {
  return `https://discord.com/api/webhooks/${webhookId}/${token}`;
}

type DbClient = SupabaseClient;

async function claimOperation(
  admin: DbClient,
  ledgerId: string,
  owner: string,
) {
  const leaseId = crypto.randomUUID();
  const { data, error } = await admin.rpc("claim_discord_operation_service", {
    p_ledger_id: ledgerId,
    p_owner: owner,
    p_lease_id: leaseId,
    p_operation_kind: "publish",
    p_ttl_seconds: 180,
  });
  return { leaseId, claimed: !error && data === true };
}

async function releaseOperation(
  admin: DbClient,
  ledgerId: string,
  owner: string,
  leaseId: string,
) {
  const { data, error } = await admin.rpc("release_discord_operation_service", {
    p_ledger_id: ledgerId,
    p_owner: owner,
    p_lease_id: leaseId,
  });
  return !error && data === true;
}

async function getExactSecret(
  admin: DbClient,
  ledgerId: string,
  owner: string,
  webhookId: string,
  channelId: string,
) {
  const { data, error } = await admin.rpc(
    "discord_get_connection_secret_service",
    {
      p_ledger_id: ledgerId,
      p_owner: owner,
    },
  );
  if (error) return null;
  const bundle = parseBundle(data);
  if (!bundle || bundle.legacy === true) return null;
  const storedWebhookId = String(bundle.webhook_id || "");
  const storedChannelId = String(bundle.channel_id || "");
  const token = String(bundle.webhook_token || "");
  const url = String(bundle.webhook_url || "");
  if (
    storedWebhookId !== webhookId || storedChannelId !== channelId ||
    !SNOWFLAKE.test(storedWebhookId) || !SNOWFLAKE.test(storedChannelId) ||
    !WEBHOOK_TOKEN.test(token) ||
    url !== expectedWebhookUrl(storedWebhookId, token)
  ) return null;
  return { webhookId: storedWebhookId, channelId: storedChannelId, token };
}

async function markDefinitiveFailure(
  admin: DbClient,
  owner: string,
  attemptId: string,
  httpStatus: number | null,
  code: string,
  message: string,
) {
  const { data, error } = await admin.rpc(
    "discord_mark_publish_failed_service",
    {
      p_attempt_id: attemptId,
      p_owner: owner,
      p_http_status: httpStatus,
      p_error_code: code,
      p_error_message: message,
    },
  );
  return !error && data === true;
}

async function markUncertain(
  admin: DbClient,
  owner: string,
  attemptId: string,
  httpStatus: number | null,
  message: string,
  messageId = "",
  channelId = "",
) {
  const { data, error } = await admin.rpc(
    "discord_mark_publish_uncertain_service",
    {
      p_attempt_id: attemptId,
      p_owner: owner,
      p_http_status: httpStatus,
      p_error_code: "discord_provider_outcome_unknown",
      p_error_message: message,
      p_message_id: messageId,
      p_channel_id: channelId,
    },
  );
  return !error && data === true;
}

async function loadOwnedDraftTarget(
  admin: DbClient,
  draftId: string,
  owner: string,
) {
  const { data, error } = await admin.from("drafts")
    .select("id,account_id,platform")
    .eq("id", draftId).eq("owner", owner).maybeSingle();
  if (
    error || !data || data.platform !== "discord" ||
    !SAFE_UUID.test(String(data.account_id || ""))
  ) return null;
  return { draftId: String(data.id), ledgerId: String(data.account_id) };
}

async function publish(
  origin: string,
  owner: string,
  draftId: string,
  receiptId: string,
  admin: DbClient,
) {
  if (!SAFE_UUID.test(receiptId)) {
    return json(origin, 409, {
      error:
        "Open and approve the current server-generated Discord preview before publishing.",
    });
  }
  const target = await loadOwnedDraftTarget(admin, draftId, owner);
  if (!target) {
    return json(origin, 404, { error: "Owned Discord draft not found." });
  }
  const operation = await claimOperation(admin, target.ledgerId, owner);
  if (!operation.claimed) {
    return json(origin, 409, {
      error: "Another Discord operation is active. Wait and try again.",
    });
  }
  const attemptId = crypto.randomUUID();
  try {
    const { data, error } = await admin.rpc(
      "claim_discord_draft_publish_with_preview_service",
      {
        p_draft_id: draftId,
        p_owner: owner,
        p_attempt_id: attemptId,
        p_lease_id: operation.leaseId,
        p_receipt_id: receiptId,
      },
    );
    const claimed = (Array.isArray(data) ? data[0] : data) as
      | ClaimedDraft
      | null;
    if (error || !claimed) {
      return json(origin, 409, {
        error: error?.message ||
          "This Discord draft changed, lost exact approval/preview, or already has a provider outcome.",
      });
    }
    const composed = composeContent(claimed);
    if (composed.error) {
      await markDefinitiveFailure(
        admin,
        owner,
        attemptId,
        null,
        "discord_content_invalid",
        composed.error,
      );
      return json(origin, 409, { error: composed.error });
    }
    const secret = await getExactSecret(
      admin,
      claimed.ledger_id,
      owner,
      claimed.webhook_id,
      claimed.channel_id,
    );
    if (!secret) {
      const message =
        "The exact approved Discord channel credential could not be verified. Reconnect before publishing.";
      await markDefinitiveFailure(
        admin,
        owner,
        attemptId,
        null,
        "discord_credential_mismatch",
        message,
      );
      return json(origin, 409, { error: message });
    }

    let response: Response;
    try {
      response = await fetch(
        `${API_BASE}/webhooks/${secret.webhookId}/${secret.token}?wait=true`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Accept": "application/json",
          },
          body: JSON.stringify({
            content: composed.content,
            allowed_mentions: { parse: [], replied_user: false },
          }),
          redirect: "error",
          signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
        },
      );
    } catch {
      const message =
        "Discord did not return a durable message result. This draft is locked for reconciliation and will not retry automatically.";
      await markUncertain(admin, owner, attemptId, null, message);
      return json(origin, 502, {
        error: message,
        providerOutcome: "unknown",
        reconciliationRequired: true,
      });
    }

    if (response.status === 408 || response.status >= 500) {
      const message =
        `Discord returned HTTP ${response.status} without a durable message result. This draft is locked for reconciliation.`;
      await markUncertain(admin, owner, attemptId, response.status, message);
      return json(origin, 502, {
        error: message,
        providerOutcome: "unknown",
        reconciliationRequired: true,
      });
    }
    if (!response.ok) {
      const message = response.status === 429
        ? "Discord rate-limited this channel. Review the unchanged draft before trying again."
        : response.status === 401 || response.status === 404
        ? "Discord rejected or no longer recognizes this webhook. Reconnect the channel."
        : response.status === 403
        ? "Discord no longer allows this webhook to post in the selected channel. Reconnect a permitted channel."
        : response.status === 400
        ? "Discord rejected this message. Forum/media channels require a thread and are not supported by this connector; select a text channel."
        : `Discord rejected the message with HTTP ${response.status}.`;
      await markDefinitiveFailure(
        admin,
        owner,
        attemptId,
        response.status,
        `discord_http_${response.status}`,
        message,
      );
      return json(origin, response.status === 429 ? 429 : 409, {
        error: message,
        providerOutcome: "not_published",
      });
    }
    const providerMessage = await response.json().catch(() => null) as
      | Record<string, unknown>
      | null;
    const messageId = String(providerMessage?.id || "");
    const channelId = String(providerMessage?.channel_id || "");
    if (!SNOWFLAKE.test(messageId) || channelId !== claimed.channel_id) {
      const message =
        "Discord accepted the request but returned no exact message/channel checkpoint. This draft is locked for reconciliation.";
      await markUncertain(
        admin,
        owner,
        attemptId,
        response.status,
        message,
        SNOWFLAKE.test(messageId) ? messageId : "",
        channelId === claimed.channel_id ? channelId : "",
      );
      return json(origin, 502, {
        error: message,
        providerOutcome: "unknown",
        reconciliationRequired: true,
      });
    }

    const checkpoint = await admin.rpc("discord_checkpoint_publish_service", {
      p_attempt_id: attemptId,
      p_owner: owner,
      p_message_id: messageId,
      p_channel_id: channelId,
      p_http_status: response.status,
    });
    if (checkpoint.error || checkpoint.data !== true) {
      const readback = await admin.from("discord_publish_attempts")
        .select("status,message_id,channel_id")
        .eq("id", attemptId).eq("owner", owner).maybeSingle();
      const durable = !readback.error &&
        ["provider_accepted", "completed"].includes(
          String(readback.data?.status || ""),
        ) &&
        readback.data?.message_id === messageId &&
        readback.data?.channel_id === channelId;
      if (!durable) {
        const message =
          `Discord published message ${messageId}, but the local durable checkpoint could not be verified. The draft is locked.`;
        await markUncertain(
          admin,
          owner,
          attemptId,
          response.status,
          message,
          messageId,
          channelId,
        );
        return json(origin, 502, {
          error: message,
          providerOutcome: "published_checkpoint_unknown",
          messageId,
          channelId,
          reconciliationRequired: true,
        });
      }
    }

    const finalized = await admin.rpc("discord_finalize_publish_service", {
      p_attempt_id: attemptId,
      p_owner: owner,
    });
    if (finalized.error || finalized.data !== true) {
      const readback = await admin.from("discord_publish_attempts")
        .select("status,message_id,channel_id")
        .eq("id", attemptId).eq("owner", owner).maybeSingle();
      if (
        readback.error || readback.data?.status !== "completed" ||
        readback.data?.message_id !== messageId ||
        readback.data?.channel_id !== channelId
      ) {
        return json(origin, 202, {
          accepted: true,
          published: true,
          messageId,
          channelId,
          localFinalizationRequired: true,
        });
      }
    }
    return json(origin, 200, {
      published: true,
      messageId,
      channelId,
      providerOutcome: "published",
      scheduled: false,
    });
  } finally {
    if (
      !await releaseOperation(admin, target.ledgerId, owner, operation.leaseId)
    ) {
      console.error(
        "Discord publish lease release could not be verified",
        target.ledgerId,
      );
    }
  }
}

async function preparePublish(
  origin: string,
  owner: string,
  draftId: string,
  admin: DbClient,
) {
  const target = await loadOwnedDraftTarget(admin, draftId, owner);
  if (!target) {
    return json(origin, 404, { error: "Owned Discord draft not found." });
  }
  const issued = await admin.rpc(
    "issue_immediate_agent_preview_receipt_service",
    {
      p_owner: owner,
      p_draft_id: draftId,
      p_provider: "discord",
      p_action: "discord.publish_now",
    },
  );
  const receipt = (Array.isArray(issued.data) ? issued.data[0] : issued.data) as
    | Record<string, unknown>
    | null;
  if (issued.error || !receipt) {
    return json(origin, 409, {
      error: issued.error?.message ||
        "The server could not create an exact Discord preview receipt. Nothing was published.",
    });
  }
  return json(origin, 200, { receipt });
}

async function messageReference(
  admin: DbClient,
  draftId: string,
  owner: string,
) {
  const { data, error } = await admin.rpc(
    "discord_get_message_reference_service",
    {
      p_draft_id: draftId,
      p_owner: owner,
    },
  );
  const row = (Array.isArray(data) ? data[0] : data) as MessageReference | null;
  return error || !row ? null : row;
}

async function verifyMessage(
  origin: string,
  owner: string,
  draftId: string,
  admin: DbClient,
) {
  const target = await loadOwnedDraftTarget(admin, draftId, owner);
  if (!target) {
    return json(origin, 404, { error: "Owned Discord draft not found." });
  }
  const operation = await claimOperation(admin, target.ledgerId, owner);
  if (!operation.claimed) {
    return json(origin, 409, { error: "Another Discord operation is active." });
  }
  try {
    const reference = await messageReference(admin, draftId, owner);
    if (!reference || !SNOWFLAKE.test(reference.message_id)) {
      return json(origin, 409, {
        error:
          "No exact Discord message identifier is available for verification.",
      });
    }
    const secret = await getExactSecret(
      admin,
      reference.ledger_id,
      owner,
      reference.webhook_id,
      reference.channel_id,
    );
    if (!secret) {
      return json(origin, 409, {
        error:
          "Reconnect the exact Discord channel before verifying this message.",
      });
    }
    let response: Response;
    try {
      response = await fetch(
        `${API_BASE}/webhooks/${secret.webhookId}/${secret.token}/messages/${reference.message_id}`,
        {
          headers: { "Accept": "application/json" },
          redirect: "error",
          signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
        },
      );
    } catch {
      return json(origin, 502, {
        error:
          "Discord did not return a verifiable message result. Nothing was changed.",
      });
    }
    if (response.status === 404) {
      const recorded = await admin.rpc(
        "discord_record_message_deleted_service",
        {
          p_attempt_id: reference.attempt_id,
          p_owner: owner,
          p_message_id: reference.message_id,
          p_channel_id: reference.channel_id,
        },
      );
      return json(
        origin,
        recorded.error || recorded.data !== true ? 500 : 200,
        {
          exists: false,
          deleted: true,
          messageId: reference.message_id,
          channelId: reference.channel_id,
          ...(recorded.error || recorded.data !== true
            ? {
              error:
                "Discord confirmed absence, but the local reconciliation record could not be updated.",
            }
            : {}),
        },
      );
    }
    if (!response.ok) {
      return json(origin, 502, {
        error:
          `Discord verification returned HTTP ${response.status}. Nothing was changed.`,
      });
    }
    const message = await response.json().catch(() => null) as
      | Record<string, unknown>
      | null;
    if (
      String(message?.id || "") !== reference.message_id ||
      String(message?.channel_id || "") !== reference.channel_id
    ) {
      return json(origin, 502, {
        error:
          "Discord returned a different message/channel than the exact local checkpoint.",
      });
    }
    const verified = await admin.rpc(
      "discord_record_message_verified_service",
      {
        p_attempt_id: reference.attempt_id,
        p_owner: owner,
        p_message_id: reference.message_id,
        p_channel_id: reference.channel_id,
      },
    );
    if (verified.error || verified.data !== true) {
      return json(origin, 500, {
        error:
          "Discord verified the message, but the local verification checkpoint failed.",
      });
    }
    if (
      ["provider_accepted", "outcome_unknown"].includes(
        reference.attempt_status,
      )
    ) {
      const checkpoint = await admin.rpc("discord_checkpoint_publish_service", {
        p_attempt_id: reference.attempt_id,
        p_owner: owner,
        p_message_id: reference.message_id,
        p_channel_id: reference.channel_id,
        p_http_status: 200,
      });
      if (!checkpoint.error && checkpoint.data === true) {
        await admin.rpc("discord_finalize_publish_service", {
          p_attempt_id: reference.attempt_id,
          p_owner: owner,
        });
      }
    }
    return json(origin, 200, {
      exists: true,
      verified: true,
      messageId: reference.message_id,
      channelId: reference.channel_id,
    });
  } finally {
    if (
      !await releaseOperation(admin, target.ledgerId, owner, operation.leaseId)
    ) {
      console.error(
        "Discord verify lease release could not be verified",
        target.ledgerId,
      );
    }
  }
}

async function deleteMessage(
  origin: string,
  owner: string,
  draftId: string,
  confirmMessageId: string,
  confirmChannelId: string,
  admin: DbClient,
) {
  if (!SNOWFLAKE.test(confirmMessageId) || !SNOWFLAKE.test(confirmChannelId)) {
    return json(origin, 400, {
      error:
        "Confirm the exact Discord message and channel identifiers before deletion.",
    });
  }
  const target = await loadOwnedDraftTarget(admin, draftId, owner);
  if (!target) {
    return json(origin, 404, { error: "Owned Discord draft not found." });
  }
  const operation = await claimOperation(admin, target.ledgerId, owner);
  if (!operation.claimed) {
    return json(origin, 409, { error: "Another Discord operation is active." });
  }
  try {
    const reference = await messageReference(admin, draftId, owner);
    if (
      !reference || reference.message_id !== confirmMessageId ||
      reference.channel_id !== confirmChannelId
    ) {
      return json(origin, 409, {
        error:
          "The deletion confirmation does not match the exact durable Discord checkpoint.",
      });
    }
    const secret = await getExactSecret(
      admin,
      reference.ledger_id,
      owner,
      reference.webhook_id,
      reference.channel_id,
    );
    if (!secret) {
      return json(origin, 409, {
        error:
          "Reconnect the exact Discord channel before deleting this message.",
      });
    }
    let response: Response;
    try {
      response = await fetch(
        `${API_BASE}/webhooks/${secret.webhookId}/${secret.token}/messages/${reference.message_id}`,
        {
          method: "DELETE",
          redirect: "error",
          signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
        },
      );
    } catch {
      return json(origin, 502, {
        error:
          "Discord did not confirm deletion. The local message checkpoint was retained.",
      });
    }
    if (response.status !== 204 && response.status !== 404) {
      return json(origin, 502, {
        error:
          `Discord did not confirm deletion (HTTP ${response.status}). The local checkpoint was retained.`,
      });
    }
    const recorded = await admin.rpc("discord_record_message_deleted_service", {
      p_attempt_id: reference.attempt_id,
      p_owner: owner,
      p_message_id: reference.message_id,
      p_channel_id: reference.channel_id,
    });
    if (recorded.error || recorded.data !== true) {
      return json(origin, 500, {
        error:
          "Discord confirmed the message is absent, but the local deletion checkpoint could not be recorded.",
      });
    }
    return json(origin, 200, {
      deleted: true,
      alreadyAbsent: response.status === 404,
      messageId: reference.message_id,
      channelId: reference.channel_id,
    });
  } finally {
    if (
      !await releaseOperation(admin, target.ledgerId, owner, operation.leaseId)
    ) {
      console.error(
        "Discord delete-message lease release could not be verified",
        target.ledgerId,
      );
    }
  }
}

serve(async (req: Request) => {
  const origin = req.headers.get("Origin") || "";
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }
  if (req.method !== "POST") return json(origin, 405, { error: "POST only" });

  const authClient = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const guard = await requireAal2(req, authClient);
  if (!guard.ok) {
    return json(origin, guard.status, { error: guard.error, code: guard.code });
  }
  let body: RequestBody;
  try {
    body = await req.json();
  } catch {
    return json(origin, 400, { error: "Invalid request body" });
  }
  const draftId = String(body.draftId || "");
  if (!SAFE_UUID.test(draftId)) {
    return json(origin, 400, { error: "A draft id is required." });
  }
  const action = String(body.action || "publish");
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  if (action === "prepare-publish") {
    return await preparePublish(origin, guard.user.id, draftId, admin);
  }
  if (action === "publish") {
    return await publish(
      origin,
      guard.user.id,
      draftId,
      String(body.receiptId || ""),
      admin,
    );
  }
  if (action === "verify") {
    return await verifyMessage(origin, guard.user.id, draftId, admin);
  }
  if (action === "delete") {
    return await deleteMessage(
      origin,
      guard.user.id,
      draftId,
      String(body.confirmMessageId || ""),
      String(body.confirmChannelId || ""),
      admin,
    );
  }
  return json(origin, 400, { error: "Unknown action" });
});
