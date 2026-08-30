// Previewed Patreon copy package for owner completion in Patreon itself.
// This function never calls a Patreon post-create/edit/schedule endpoint.
// Patreon exposes no ordinary public post-write API, so the provider write is
// deliberately replaced by an immutable owner handoff.
//
// POST, AAL2:
//   {action:"capabilities"}
//   {action:"prepare-preview",draftId,publishMode,audience,scheduledFor?,timezone,
//     previewVersion:"patreon-native-preview-v1"}
//   {action:"acknowledge-preview",handoffId,receiptId,receiptHash,previewVersion}
//   {action:"open",handoffId,receiptId}
//   {action:"owner-completed",handoffId,ownerCompletionNote}
//   {action:"abandon",handoffId}
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { requireAal2 } from "../_shared/aal2.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const APP_ORIGIN = (Deno.env.get("PATREON_OAUTH_APP_ORIGIN") ||
  "https://mypersonas.online").replace(/\/$/, "");
const NATIVE_EDITOR_URL = "https://www.patreon.com/posts/new";
const CREATOR_HELP_URL =
  "https://support.patreon.com/hc/en-us/articles/115004048046-Posting-to-your-Patreon";
const SCHEDULING_HELP_URL =
  "https://support.patreon.com/hc/en-us/articles/360031956632-Scheduled-posts";
const PREVIEW_VERSION = "patreon-native-preview-v1";
const SAFE_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ALLOWED_ORIGINS = new Set([
  APP_ORIGIN,
  "https://www.mypersonas.online",
  "https://aliaspaces.com",
  "https://www.aliaspaces.com",
  "http://localhost:8000",
  "http://127.0.0.1:8000",
]);
type Json = Record<string, unknown>;

const service = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function cors(origin: string): HeadersInit {
  return {
    ...(ALLOWED_ORIGINS.has(origin)
      ? { "Access-Control-Allow-Origin": origin }
      : {}),
    "Access-Control-Allow-Headers":
      "authorization, content-type, apikey, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Cache-Control": "no-store",
    "Vary": "Origin",
  };
}
function json(origin: string, status: number, body: Json) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...cors(origin),
      "Content-Type": "application/json",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
function row(value: unknown): Json | null {
  const item = Array.isArray(value) ? value[0] : value;
  return item && typeof item === "object" && !Array.isArray(item)
    ? item as Json
    : null;
}
function publicHandoff(item: Json, includeEditor = false) {
  return {
    handoffId: item.id,
    draftId: item.draft_id,
    ledgerId: item.ledger_id,
    campaignId: item.campaign_id,
    packageHash: item.package_hash,
    previewVersion: item.preview_version,
    publishMode: item.publish_mode,
    audience: item.audience,
    scheduledFor: item.scheduled_for,
    timezone: item.timezone,
    status: item.status,
    ...(includeEditor ? { nativeEditorUrl: item.native_editor_url } : {}),
    copyPackage: {
      title: item.title,
      body: item.body,
      tags: item.tags,
      mediaUrl: item.media_url,
    },
    providerWritePerformed: false,
    providerCompletionVerified: false,
  };
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
  const auth = createClient(SUPABASE_URL, ANON_KEY, {
    global: {
      headers: { Authorization: req.headers.get("Authorization") || "" },
    },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const guard = await requireAal2(req, auth);
  if (!guard.ok) {
    return json(origin, guard.status, { error: guard.error, code: guard.code });
  }
  const raw = await req.text();
  if (new TextEncoder().encode(raw).byteLength > 16_384) {
    return json(origin, 413, { error: "Request is too large" });
  }
  let body: Json;
  try {
    body = JSON.parse(raw) as Json;
  } catch {
    return json(origin, 400, { error: "Invalid request body" });
  }
  const action = String(body.action || "");
  const owner = guard.user.id;
  if (body.previewConfirmed !== undefined || body.executeConfirmed !== undefined) {
    return json(origin, 400, {
      error:
        "Raw confirmation booleans are not accepted. Render and acknowledge the server receipt.",
    });
  }
  if (action === "capabilities") {
    return json(origin, 200, {
      providerPostWriteSupported: false,
      providerPostSchedulingSupported: false,
      nativeHandoffSupported: true,
      previewRequired: true,
      aal2Required: true,
      editorLinkReturnedAfterAcknowledgement: true,
      creatorHelpUrl: CREATOR_HELP_URL,
      schedulingHelpUrl: SCHEDULING_HELP_URL,
      ownerMustCompleteInPatreon: true,
    });
  }
  if (action === "prepare-preview") {
    const draftId = String(body.draftId || "");
    const publishMode = String(body.publishMode || "");
    const audience = String(body.audience || "");
    const scheduledFor = body.scheduledFor == null || body.scheduledFor === ""
      ? null
      : String(body.scheduledFor);
    const timezone = String(body.timezone || "").trim();
    if (
      !SAFE_UUID.test(draftId) || body.previewVersion !== PREVIEW_VERSION ||
      !/^[A-Za-z0-9_+\/-]{1,80}$/.test(timezone)
    ) {
      return json(origin, 400, {
        error: "Choose the exact Patreon handoff settings before preparing its preview",
      });
    }
    if (scheduledFor && !Number.isFinite(Date.parse(scheduledFor))) {
      return json(origin, 400, {
        error: "Use an exact date and time for the Patreon schedule preview",
      });
    }
    const prepared = await service.rpc(
      "prepare_patreon_native_handoff_service",
      {
        p_owner: owner,
        p_draft_id: draftId,
        p_publish_mode: publishMode,
        p_audience: audience,
        p_scheduled_for: scheduledFor,
        p_timezone: timezone,
        p_preview_version: PREVIEW_VERSION,
      },
    );
    const item = row(prepared.data);
    if (prepared.error || !item) {
      return json(origin, 409, {
        error: prepared.error?.message ||
          "Patreon handoff could not be prepared",
      });
    }
    const receipt = await service.rpc("prepare_provider_action_preview_service", {
      p_owner: owner,
      p_draft_id: String(item.draft_id || ""),
      p_ledger_id: String(item.ledger_id || ""),
      p_provider: "patreon",
      p_action: `patreon.${String(item.publish_mode || "")}`,
      p_target_id: String(item.campaign_id || ""),
      p_content_hash: String(item.draft_content_hash || ""),
      p_action_hash: String(item.package_hash || ""),
      p_preview_version: PREVIEW_VERSION,
      p_preview_payload: {
        rendererVersion: PREVIEW_VERSION,
        items: [{
          provider: "patreon",
          account: "Exact connected Patreon campaign",
          accountId: String(item.campaign_id || ""),
          placement: "Patreon native post editor",
          requiresExactTarget: true,
          exactTargetReady: true,
          title: String(item.title || ""),
          text: String(item.body || ""),
          tags: String(item.tags || ""),
          mediaUrl: String(item.media_url || ""),
          mediaKind: String(item.media_url || "") ? "attachment" : "article",
          mediaItems: String(item.media_url || "")
            ? [{
              url: String(item.media_url || ""),
              kind: "attachment",
              label: "Exact Patreon package attachment",
            }]
            : [],
          requiresMedia: Boolean(item.media_url),
          requiredMediaMissing: false,
          scheduledFor: item.scheduled_for || null,
          timezone: String(item.timezone || ""),
          mode: `Native Patreon ${String(item.publish_mode || "")}`,
          timingLabel: item.publish_mode === "schedule"
            ? `Owner will schedule in Patreon for ${String(item.scheduled_for || "")} · ${String(item.timezone || "")}`
            : "Owner completes this in Patreon after acknowledgement",
          platformDetails: [
            `Exact Patreon campaign: ${String(item.campaign_id || "")}`,
            `Audience: ${String(item.audience || "")}`,
            `Native action: ${String(item.publish_mode || "")}`,
            `Immutable schedule time zone: ${String(item.timezone || "")}`,
            "MyPersonas does not call a Patreon post-write API",
            "Patreon's own final preview must still be reviewed",
          ],
        }],
      },
    });
    const serverReceipt = row(receipt.data);
    if (receipt.error || !serverReceipt) {
      return json(origin, 409, {
        error: receipt.error?.message ||
          "The Patreon one-shot preview receipt could not be prepared",
      });
    }
    return json(origin, 200, {
      prepared: true,
      ...publicHandoff(item, false),
      receipt: serverReceipt,
      preview: serverReceipt.preview,
      instruction: publishMode === "schedule"
        ? "Render and acknowledge this exact package before MyPersonas opens the Patreon scheduling handoff."
        : "Render and acknowledge this exact package before MyPersonas opens the Patreon handoff.",
      fallbackInstruction:
        "The editor link is returned only after the acknowledged receipt is consumed.",
    });
  }
  const handoffId = String(body.handoffId || "");
  if (!SAFE_UUID.test(handoffId)) {
    return json(origin, 400, { error: "Valid handoffId required" });
  }
  if (action === "acknowledge-preview") {
    const receiptId = String(body.receiptId || "");
    const receiptHash = String(body.receiptHash || "");
    if (!SAFE_UUID.test(receiptId) || !/^[0-9a-f]{64}$/.test(receiptHash) ||
      body.previewVersion !== PREVIEW_VERSION) {
      return json(origin, 400, {
        error: "The exact rendered Patreon server receipt is required",
      });
    }
    const acknowledged = await auth.rpc("acknowledge_provider_action_preview", {
      p_receipt_id: receiptId,
      p_receipt_hash: receiptHash,
      p_preview_version: PREVIEW_VERSION,
    });
    if (acknowledged.error || !acknowledged.data) {
      return json(origin, 409, {
        error: acknowledged.error?.message ||
          "The Patreon preview could not be acknowledged",
      });
    }
    return json(origin, 200, acknowledged.data as Json);
  }
  if (action === "open") {
    const receiptId = String(body.receiptId || "");
    if (!SAFE_UUID.test(receiptId)) {
      return json(origin, 409, {
        error: "A current acknowledged one-shot Patreon preview receipt is required",
      });
    }
    const opened = await service.rpc(
      "open_patreon_native_handoff_with_preview_service",
      { p_owner: owner, p_handoff_id: handoffId, p_receipt_id: receiptId },
    );
    const item = row(opened.data);
    if (opened.error || !item) {
      return json(origin, 409, {
        error: opened.error?.message ||
          "The Patreon handoff is expired, unacknowledged, used, or changed",
      });
    }
    return json(origin, 200, {
      opened: true,
      ...publicHandoff(item, true),
      instruction:
        "Paste the exact package, review Patreon's final native preview, then complete the chosen action.",
    });
  }
  const status = action === "owner-completed"
    ? "owner_completed"
    : action === "abandon"
    ? "abandoned"
    : "";
  if (!status) {
    return json(origin, 400, { error: "Unsupported Patreon handoff action" });
  }
  const note = status === "owner_completed"
    ? String(body.ownerCompletionNote || "").trim()
    : "";
  if (status === "owner_completed" && !note) {
    return json(origin, 400, {
      error:
        "Record what you completed in Patreon. This is owner-attested, not API-verified.",
    });
  }
  const updated = await service.rpc("update_patreon_native_handoff_service", {
    p_owner: owner,
    p_handoff_id: handoffId,
    p_status: status,
    p_owner_completion_note: note,
  });
  const item = row(updated.data);
  if (updated.error || !item) {
    return json(origin, 409, {
      error: updated.error?.message || "Patreon handoff state changed",
    });
  }
  return json(origin, 200, {
    updated: true,
    ...publicHandoff(item, false),
    ...(status === "owner_completed"
      ? { ownerAttested: true, apiVerified: false }
      : {}),
  });
});
