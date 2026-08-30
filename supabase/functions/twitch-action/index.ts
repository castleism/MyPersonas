// Owner-triggered Twitch Helix features. This is intentionally not a general
// feed/video publisher. Each write is bound to an approved migration-069
// destination preview plus an immutable, action-specific approval receipt.
//
// POST, AAL2:
//   {action:"capabilities"}
//   {action:"record-preview",draftId,actionType,actionPayload,
//     previewVersion:"twitch-action-preview-v1"}
//   {action:"acknowledge-preview",draftId,receiptId,receiptHash,previewVersion}
//   {action:"execute",draftId,approvalHash,receiptId}
//   {action:"reconcile",attemptId}
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { requireAal2 } from "../_shared/aal2.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const CLIENT_ID = Deno.env.get("TWITCH_CLIENT_ID") || "";
const CLIENT_SECRET = Deno.env.get("TWITCH_CLIENT_SECRET") || "";
const APP_ORIGIN = (Deno.env.get("TWITCH_OAUTH_APP_ORIGIN") ||
  "https://mypersonas.online").replace(/\/$/, "");
const TOKEN_URL = "https://id.twitch.tv/oauth2/token";
const VALIDATE_URL = "https://id.twitch.tv/oauth2/validate";
const CHANNELS_URL = "https://api.twitch.tv/helix/channels";
const SCHEDULE_URL = "https://api.twitch.tv/helix/schedule";
const SCHEDULE_SEGMENT_URL = `${SCHEDULE_URL}/segment`;
const ANNOUNCEMENT_URL = "https://api.twitch.tv/helix/chat/announcements";
const PREVIEW_VERSION = "twitch-action-preview-v1";
const SAFE_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_ID = /^[0-9]{1,30}$/;
const ALLOWED_ORIGINS = new Set([
  APP_ORIGIN,
  "https://www.mypersonas.online",
  "https://aliaspaces.com",
  "https://www.aliaspaces.com",
  "http://localhost:8000",
  "http://127.0.0.1:8000",
]);
const ACTION_SCOPES = {
  channel_update: "channel:manage:broadcast",
  schedule_segment_create: "channel:manage:schedule",
  chat_announcement: "moderator:manage:announcements",
} as const;
type ActionType = keyof typeof ACTION_SCOPES;
type Json = Record<string, unknown>;
type ClaimedAction = {
  attempt_id: string;
  draft_id: string;
  ledger_id: string;
  persona_id: string;
  broadcaster_id: string;
  action_type: ActionType;
  action_payload: Json;
  required_scope: string;
  approval_hash: string;
  attempt_status: string;
  is_new: boolean;
};
type Credential = {
  broadcasterId: string;
  login: string;
  name: string;
  scopes: string[];
  accessToken: string;
  refreshToken: string;
};
type Access = Credential & { expiresAt: string };

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
function normalizedScopes(value: unknown): string[] {
  const values = Array.isArray(value)
    ? value
    : String(value || "").split(/\s+/);
  return [...new Set(values.map(String).map((x) => x.trim()).filter(Boolean))]
    .sort();
}
function sameScopes(left: string[], right: string[]) {
  return left.length === right.length &&
    left.every((scope, index) => scope === right[index]);
}
function expiry(value: unknown) {
  const seconds = Number(value);
  const bounded = Number.isFinite(seconds)
    ? Math.max(60, Math.min(90 * 24 * 60 * 60, Math.floor(seconds)))
    : 4 * 60 * 60;
  return new Date(Date.now() + bounded * 1000).toISOString();
}
function providerMessage(payload: unknown, status: number) {
  if (payload && typeof payload === "object") {
    const row = payload as Json;
    for (const value of [row.message, row.error]) {
      if (typeof value === "string" && value.trim()) {
        return value.trim().slice(0, 500);
      }
    }
  }
  return `Twitch returned HTTP ${status}`;
}
function uncertainStatus(status: number) {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}
function asObject(value: unknown): Json | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Json;
}

async function credentials(
  owner: string,
  ledgerId: string,
): Promise<Credential | null> {
  const result = await service.rpc("twitch_get_token_bundle", {
    p_ledger_id: ledgerId,
    p_owner: owner,
  });
  const row = (Array.isArray(result.data) ? result.data[0] : result.data) as
    | Json
    | null;
  let bundle = row?.token_bundle as Json | string | undefined;
  if (typeof bundle === "string") {
    try {
      bundle = JSON.parse(bundle) as Json;
    } catch {
      return null;
    }
  }
  if (result.error || !row || !bundle || typeof bundle !== "object") {
    return null;
  }
  const resultValue: Credential = {
    broadcasterId: String(row.broadcaster_id || ""),
    login: String(row.broadcaster_login || ""),
    name: String(row.broadcaster_name || ""),
    scopes: normalizedScopes(bundle.granted_scopes),
    accessToken: String(bundle.access_token || ""),
    refreshToken: String(bundle.refresh_token || ""),
  };
  return SAFE_ID.test(resultValue.broadcasterId) && resultValue.accessToken &&
      resultValue.refreshToken
    ? resultValue
    : null;
}
async function validate(accessToken: string) {
  try {
    const response = await fetch(VALIDATE_URL, {
      headers: { Authorization: `OAuth ${accessToken}` },
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
    const payload = await response.json().catch(() => ({})) as Json;
    if (!response.ok) return null;
    return {
      clientId: String(payload.client_id || ""),
      broadcasterId: String(payload.user_id || ""),
      login: String(payload.login || "").toLowerCase(),
      scopes: normalizedScopes(payload.scopes),
      expiresAt: expiry(payload.expires_in),
    };
  } catch {
    return null;
  }
}
async function refresh(refreshToken: string) {
  try {
    const response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
    const payload = await response.json().catch(() => ({})) as Json;
    if (
      !response.ok || typeof payload.access_token !== "string" ||
      typeof payload.refresh_token !== "string"
    ) return null;
    return {
      accessToken: payload.access_token,
      refreshToken: payload.refresh_token,
      scopes: normalizedScopes(payload.scope),
      expiresAt: expiry(payload.expires_in),
    };
  } catch {
    return null;
  }
}
async function markConnectionError(
  owner: string,
  ledgerId: string,
  code: string,
) {
  const now = new Date().toISOString();
  await service.from("account_connections").update({
    connection_state: "error",
    error_code: code,
    last_checked_at: now,
    updated_at: now,
  }).eq("owner", owner).eq("ledger_id", ledgerId).eq("provider", "twitch");
}
async function verifiedAccess(
  owner: string,
  claim: ClaimedAction,
): Promise<Access | null> {
  if (!CLIENT_ID || !CLIENT_SECRET) return null;
  const stored = await credentials(owner, claim.ledger_id);
  if (
    !stored || stored.broadcasterId !== claim.broadcaster_id ||
    !stored.scopes.includes(claim.required_scope)
  ) return null;
  let token = {
    accessToken: stored.accessToken,
    refreshToken: stored.refreshToken,
    scopes: stored.scopes,
    expiresAt: "",
  };
  let wasRotated = false;
  let proof = await validate(token.accessToken);
  if (!proof) {
    const rotated = await refresh(stored.refreshToken);
    if (!rotated) {
      await markConnectionError(
        owner,
        claim.ledger_id,
        "twitch_reconnect_required",
      );
      return null;
    }
    token = rotated;
    wasRotated = true;
    proof = await validate(token.accessToken);
  }
  if (
    !proof || proof.clientId !== CLIENT_ID ||
    proof.broadcasterId !== stored.broadcasterId ||
    proof.login !== stored.login ||
    !proof.scopes.includes(claim.required_scope) ||
    !sameScopes(stored.scopes, proof.scopes)
  ) {
    await markConnectionError(
      owner,
      claim.ledger_id,
      "twitch_identity_or_scope_changed",
    );
    return null;
  }
  const saved = await service.rpc("twitch_store_token_bundle", {
    p_ledger_id: claim.ledger_id,
    p_owner: owner,
    p_broadcaster_id: stored.broadcasterId,
    p_broadcaster_login: stored.login,
    p_broadcaster_name: stored.name,
    p_access_token: token.accessToken,
    p_refresh_token: token.refreshToken,
    p_expires_at: proof.expiresAt,
    p_granted_scopes: proof.scopes,
  });
  if (saved.error) {
    await markConnectionError(
      owner,
      claim.ledger_id,
      wasRotated
        ? "twitch_manual_revoke_required"
        : "twitch_token_checkpoint_failed",
    );
    return null;
  }
  return {
    ...stored,
    ...token,
    scopes: proof.scopes,
    expiresAt: proof.expiresAt,
  };
}

async function stillSafe(owner: string, claim: ClaimedAction) {
  const [pause, ledger, connection] = await Promise.all([
    service.from("agent_owner_settings").select("automation_paused")
      .eq("owner", owner).maybeSingle(),
    service.from("account_ledger").select("id,persona_id,suspended,provider")
      .eq("id", claim.ledger_id).eq("owner", owner).maybeSingle(),
    service.from("account_connections")
      .select("provider_subject,granted_scopes,connection_state")
      .eq("ledger_id", claim.ledger_id).eq("owner", owner).eq(
        "provider",
        "twitch",
      )
      .maybeSingle(),
  ]);
  if (
    pause.error || !pause.data || pause.data.automation_paused ||
    ledger.error ||
    !ledger.data || ledger.data.provider !== "twitch" ||
    ledger.data.suspended ||
    connection.error || !connection.data ||
    connection.data.connection_state !== "connected" ||
    connection.data.provider_subject !== claim.broadcaster_id ||
    !normalizedScopes(connection.data.granted_scopes).includes(
      claim.required_scope,
    )
  ) return false;
  if (ledger.data.persona_id === claim.persona_id) return true;
  const link = await service.from("account_persona_links").select("ledger_id")
    .eq("ledger_id", claim.ledger_id).eq("owner", owner)
    .eq("persona_id", claim.persona_id).maybeSingle();
  return !link.error && Boolean(link.data);
}

async function finish(
  owner: string,
  attemptId: string,
  status:
    | "provider_accepted"
    | "completed"
    | "definitive_failure"
    | "outcome_unknown",
  httpStatus: number | null,
  reference: string,
  result: Json,
  errorCode = "",
  errorMessage = "",
) {
  const saved = await service.rpc("twitch_finish_action_service", {
    p_attempt_id: attemptId,
    p_owner: owner,
    p_status: status,
    p_http_status: httpStatus,
    p_provider_reference: reference,
    p_provider_result: result,
    p_error_code: errorCode,
    p_error_message: errorMessage,
  });
  if (saved.error || saved.data !== true) {
    throw new Error("The durable Twitch action checkpoint could not be saved");
  }
  return true;
}
function helixHeaders(accessToken: string, jsonBody = false): HeadersInit {
  return {
    Authorization: `Bearer ${accessToken}`,
    "Client-Id": CLIENT_ID,
    Accept: "application/json",
    ...(jsonBody ? { "Content-Type": "application/json" } : {}),
  };
}
async function channelState(accessToken: string, broadcasterId: string) {
  const url = new URL(CHANNELS_URL);
  url.searchParams.set("broadcaster_id", broadcasterId);
  try {
    const response = await fetch(url, {
      headers: helixHeaders(accessToken),
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
    const payload = await response.json().catch(() => ({})) as {
      data?: Json[];
    };
    return response.ok && Array.isArray(payload.data) &&
        payload.data.length === 1
      ? payload.data[0]
      : null;
  } catch {
    return null;
  }
}
function channelMatches(expected: Json, actual: Json) {
  for (const key of Object.keys(expected)) {
    if (key === "tags") {
      const left = Array.isArray(expected.tags)
        ? expected.tags.map(String).sort()
        : [];
      const right = Array.isArray(actual.tags)
        ? actual.tags.map(String).sort()
        : [];
      if (JSON.stringify(left) !== JSON.stringify(right)) return false;
    } else if (actual[key] !== expected[key]) return false;
  }
  return true;
}
async function scheduleMatches(
  accessToken: string,
  broadcasterId: string,
  expected: Json,
  providerId = "",
) {
  const url = new URL(SCHEDULE_URL);
  url.searchParams.set("broadcaster_id", broadcasterId);
  if (providerId) url.searchParams.set("id", providerId);
  else {
    url.searchParams.set("start_time", String(expected.start_time));
    url.searchParams.set("first", "25");
  }
  try {
    const response = await fetch(url, {
      headers: helixHeaders(accessToken),
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
    const payload = await response.json().catch(() => ({})) as {
      data?: { segments?: Json[] };
    };
    if (!response.ok || !Array.isArray(payload.data?.segments)) {
      return [] as Json[];
    }
    const expectedStart = Date.parse(String(expected.start_time));
    const expectedDuration = Number(expected.duration) * 60_000;
    return payload.data!.segments!.filter((segment) => {
      const starts = Date.parse(String(segment.start_time || ""));
      const ends = Date.parse(String(segment.end_time || ""));
      const titleOk = !Object.hasOwn(expected, "title") ||
        String(segment.title || "") === String(expected.title || "");
      const category = asObject(segment.category);
      const categoryOk = !Object.hasOwn(expected, "category_id") ||
        String(category?.id || "") === String(expected.category_id || "");
      const recurringOk = !Object.hasOwn(expected, "is_recurring") ||
        Boolean(segment.is_recurring) === Boolean(expected.is_recurring);
      return Number.isFinite(starts) && Number.isFinite(ends) &&
        starts === expectedStart && ends - starts === expectedDuration &&
        titleOk && categoryOk && recurringOk &&
        (!providerId || String(segment.id || "") === providerId);
    });
  } catch {
    return [] as Json[];
  }
}

async function executeProvider(
  owner: string,
  claim: ClaimedAction,
  access: Access,
) {
  if (!await stillSafe(owner, claim)) {
    await finish(
      owner,
      claim.attempt_id,
      "definitive_failure",
      null,
      "",
      {},
      "safety_state_changed",
      "Owner pause, assignment, destination, or scope changed before the provider request.",
    );
    return {
      status: 409,
      body: { error: "Twitch safety state changed; nothing was sent" },
    };
  }
  const payload = claim.action_payload;
  try {
    if (claim.action_type === "channel_update") {
      const url = new URL(CHANNELS_URL);
      url.searchParams.set("broadcaster_id", claim.broadcaster_id);
      const response = await fetch(url, {
        method: "PATCH",
        headers: helixHeaders(access.accessToken, true),
        body: JSON.stringify(payload),
        redirect: "error",
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        if (uncertainStatus(response.status)) {
          await finish(
            owner,
            claim.attempt_id,
            "outcome_unknown",
            response.status,
            "",
            asObject(result) || {},
            "twitch_channel_outcome_unknown",
            providerMessage(result, response.status),
          );
          return {
            status: 202,
            body: { status: "outcome_unknown", reconciliationRequired: true },
          };
        }
        await finish(
          owner,
          claim.attempt_id,
          "definitive_failure",
          response.status,
          "",
          asObject(result) || {},
          "twitch_rejected",
          providerMessage(result, response.status),
        );
        return {
          status: 502,
          body: { error: providerMessage(result, response.status) },
        };
      }
      const current = await channelState(
        access.accessToken,
        claim.broadcaster_id,
      );
      if (!current || !channelMatches(payload, current)) {
        await finish(
          owner,
          claim.attempt_id,
          "provider_accepted",
          response.status,
          "",
          current || {},
          "twitch_readback_pending",
          "Twitch accepted the edit, but exact readback is not yet confirmed.",
        );
        return {
          status: 202,
          body: { status: "provider_accepted", reconciliationRequired: true },
        };
      }
      await finish(
        owner,
        claim.attempt_id,
        "completed",
        response.status,
        claim.broadcaster_id,
        current,
      );
      return {
        status: 200,
        body: { completed: true, verified: true, channel: current },
      };
    }
    if (claim.action_type === "schedule_segment_create") {
      const url = new URL(SCHEDULE_SEGMENT_URL);
      url.searchParams.set("broadcaster_id", claim.broadcaster_id);
      const response = await fetch(url, {
        method: "POST",
        headers: helixHeaders(access.accessToken, true),
        body: JSON.stringify(payload),
        redirect: "error",
        signal: AbortSignal.timeout(20_000),
      });
      const result = await response.json().catch(() => ({})) as Json;
      if (!response.ok) {
        if (uncertainStatus(response.status)) {
          await finish(
            owner,
            claim.attempt_id,
            "outcome_unknown",
            response.status,
            "",
            result,
            "twitch_schedule_outcome_unknown",
            providerMessage(result, response.status),
          );
          return {
            status: 202,
            body: { status: "outcome_unknown", reconciliationRequired: true },
          };
        }
        await finish(
          owner,
          claim.attempt_id,
          "definitive_failure",
          response.status,
          "",
          result,
          "twitch_rejected",
          providerMessage(result, response.status),
        );
        return {
          status: 502,
          body: { error: providerMessage(result, response.status) },
        };
      }
      const segment = Array.isArray((result.data as Json | undefined)?.segments)
        ? ((result.data as Json).segments as Json[])[0]
        : null;
      const segmentId = String(segment?.id || "");
      if (!segmentId) {
        await finish(
          owner,
          claim.attempt_id,
          "outcome_unknown",
          response.status,
          "",
          result,
          "twitch_schedule_id_missing",
          "Twitch accepted the request without a durable segment id.",
        );
        return {
          status: 202,
          body: { status: "outcome_unknown", reconciliationRequired: true },
        };
      }
      const matches = await scheduleMatches(
        access.accessToken,
        claim.broadcaster_id,
        payload,
        segmentId,
      );
      if (matches.length !== 1) {
        await finish(
          owner,
          claim.attempt_id,
          "provider_accepted",
          response.status,
          segmentId,
          result,
          "twitch_schedule_readback_pending",
          "Twitch returned a segment id, but exact readback is pending.",
        );
        return {
          status: 202,
          body: {
            status: "provider_accepted",
            segmentId,
            reconciliationRequired: true,
          },
        };
      }
      await finish(
        owner,
        claim.attempt_id,
        "completed",
        response.status,
        segmentId,
        matches[0],
      );
      return {
        status: 200,
        body: { completed: true, verified: true, segment: matches[0] },
      };
    }
    const url = new URL(ANNOUNCEMENT_URL);
    url.searchParams.set("broadcaster_id", claim.broadcaster_id);
    url.searchParams.set("moderator_id", claim.broadcaster_id);
    const response = await fetch(url, {
      method: "POST",
      headers: helixHeaders(access.accessToken, true),
      body: JSON.stringify(payload),
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      const result = await response.json().catch(() => ({}));
      if (uncertainStatus(response.status)) {
        await finish(
          owner,
          claim.attempt_id,
          "outcome_unknown",
          response.status,
          "",
          asObject(result) || {},
          "twitch_announcement_outcome_unknown",
          providerMessage(result, response.status),
        );
        return {
          status: 202,
          body: { status: "outcome_unknown", reconciliationRequired: true },
        };
      }
      await finish(
        owner,
        claim.attempt_id,
        "definitive_failure",
        response.status,
        "",
        asObject(result) || {},
        "twitch_rejected",
        providerMessage(result, response.status),
      );
      return {
        status: 502,
        body: { error: providerMessage(result, response.status) },
      };
    }
    await finish(
      owner,
      claim.attempt_id,
      "completed",
      response.status,
      claim.broadcaster_id,
      {
        accepted: true,
        readback_available: false,
      },
    );
    return {
      status: 200,
      body: { completed: true, accepted: true, readbackAvailable: false },
    };
  } catch {
    try {
      await finish(
        owner,
        claim.attempt_id,
        "outcome_unknown",
        null,
        "",
        {},
        "twitch_network_outcome_unknown",
        "Twitch did not return a durable result; never retry this approval blindly.",
      );
    } catch {
      // The unique approval/attempt claim still blocks blind reuse. Surface the
      // missing local checkpoint so an operator can reconcile it directly.
    }
    return {
      status: 202,
      body: {
        status: "outcome_unknown",
        reconciliationRequired: true,
        localCheckpointNeedsAttention: true,
      },
    };
  }
}

async function handleReconcile(
  origin: string,
  owner: string,
  attemptId: string,
) {
  const result = await service.from("twitch_action_attempts")
    .select(
      "id,ledger_id,broadcaster_id,action_type,action_payload,status,provider_reference",
    )
    .eq("id", attemptId).eq("owner", owner).maybeSingle();
  const attempt = result.data as Json | null;
  if (result.error || !attempt) {
    return json(origin, 404, { error: "Twitch attempt not found" });
  }
  if (
    attempt.status === "completed" || attempt.status === "definitive_failure"
  ) {
    return json(origin, 200, { status: attempt.status, alreadyFinal: true });
  }
  if (attempt.action_type === "chat_announcement") {
    return json(origin, 409, {
      status: attempt.status,
      reconciliationRequired: true,
      automaticReconciliationSupported: false,
      instruction:
        "Review the Twitch chat/moderation record. Do not resend this approval.",
    });
  }
  const synthetic: ClaimedAction = {
    attempt_id: attemptId,
    draft_id: "",
    ledger_id: String(attempt.ledger_id || ""),
    persona_id: "",
    broadcaster_id: String(attempt.broadcaster_id || ""),
    action_type: attempt.action_type as ActionType,
    action_payload: asObject(attempt.action_payload) || {},
    required_scope: ACTION_SCOPES[attempt.action_type as ActionType],
    approval_hash: "",
    attempt_status: String(attempt.status || ""),
    is_new: false,
  };
  const access = await verifiedAccess(owner, synthetic);
  if (!access) {
    return json(origin, 409, {
      error: "Reconnect Twitch before reconciliation",
    });
  }
  if (synthetic.action_type === "channel_update") {
    const current = await channelState(
      access.accessToken,
      synthetic.broadcaster_id,
    );
    if (current && channelMatches(synthetic.action_payload, current)) {
      try {
        await finish(
          owner,
          attemptId,
          "completed",
          200,
          synthetic.broadcaster_id,
          current,
        );
      } catch {
        return json(origin, 503, {
          error:
            "Twitch matched the channel state, but its durable reconciliation checkpoint failed",
          reconciliationRequired: true,
        });
      }
      return json(origin, 200, {
        completed: true,
        verified: true,
        channel: current,
      });
    }
  } else {
    const matches = await scheduleMatches(
      access.accessToken,
      synthetic.broadcaster_id,
      synthetic.action_payload,
      String(attempt.provider_reference || ""),
    );
    if (matches.length === 1) {
      const id = String(matches[0].id || attempt.provider_reference || "");
      try {
        await finish(owner, attemptId, "completed", 200, id, matches[0]);
      } catch {
        return json(origin, 503, {
          error:
            "Twitch matched the schedule segment, but its durable reconciliation checkpoint failed",
          reconciliationRequired: true,
        });
      }
      return json(origin, 200, {
        completed: true,
        verified: true,
        segment: matches[0],
      });
    }
  }
  return json(origin, 202, {
    status: attempt.status,
    reconciliationRequired: true,
    instruction:
      "No exact provider match is currently visible. Do not resend this approval.",
  });
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
  if (new TextEncoder().encode(raw).byteLength > 32_768) {
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
      generalFeedPostingSupported: false,
      videoUploadSupported: false,
      supportedActions: [
        {
          id: "channel_update",
          scope: ACTION_SCOPES.channel_update,
          scheduled: false,
        },
        {
          id: "schedule_segment_create",
          scope: ACTION_SCOPES.schedule_segment_create,
          scheduled: true,
          eligibility:
            "Non-recurring segments require Twitch Affiliate or Partner status",
        },
        {
          id: "chat_announcement",
          scope: ACTION_SCOPES.chat_announcement,
          scheduled: false,
          note:
            "Immediate only; broadcaster must be a moderator and Twitch rate limits apply",
        },
      ],
      previewRequired: true,
      actionReceiptRequired: true,
      aal2Required: true,
    });
  }
  if (action === "reconcile") {
    const attemptId = String(body.attemptId || "");
    if (!SAFE_UUID.test(attemptId)) {
      return json(origin, 400, { error: "Valid attemptId required" });
    }
    return await handleReconcile(origin, owner, attemptId);
  }
  const draftId = String(body.draftId || "");
  if (!SAFE_UUID.test(draftId)) {
    return json(origin, 400, { error: "Valid draftId required" });
  }
  if (action === "acknowledge-preview") {
    const receiptId = String(body.receiptId || "");
    const receiptHash = String(body.receiptHash || "");
    if (!SAFE_UUID.test(receiptId) || !/^[0-9a-f]{64}$/.test(receiptHash) ||
      body.previewVersion !== PREVIEW_VERSION) {
      return json(origin, 400, {
        error: "The exact rendered Twitch server receipt is required",
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
          "The Twitch preview could not be acknowledged",
      });
    }
    return json(origin, 200, acknowledged.data as Json);
  }
  if (action === "record-preview") {
    const actionType = String(body.actionType || "") as ActionType;
    const payload = asObject(body.actionPayload);
    if (
      !(actionType in ACTION_SCOPES) || !payload ||
      body.previewVersion !== PREVIEW_VERSION
    ) {
      return json(origin, 400, {
        error: "Choose the exact Twitch action before preparing its server preview",
      });
    }
    const receipt = await service.rpc("twitch_record_action_preview_service", {
      p_owner: owner,
      p_draft_id: draftId,
      p_action_type: actionType,
      p_action_payload: payload,
      p_preview_version: PREVIEW_VERSION,
    });
    const approval = (Array.isArray(receipt.data) ? receipt.data[0] : receipt.data) as Json | null;
    if (receipt.error || !approval) {
      return json(origin, 409, {
        error: receipt.error?.message || "Twitch preview could not be prepared",
      });
    }
    const actionHash = String(approval.approval_hash || "");
    const broadcasterId = String(approval.broadcaster_id || "");
    const contentHash = String(approval.draft_content_hash || "");
    if (!/^[0-9a-f]{64}$/.test(actionHash) ||
      !/^[0-9a-f]{64}$/.test(contentHash) || !broadcasterId) {
      return json(origin, 503, {
        error: "The Twitch server preview snapshot is incomplete",
      });
    }
    const scheduledFor = actionType === "schedule_segment_create"
      ? String(payload.start_time || "")
      : null;
    const visibleText = actionType === "chat_announcement"
      ? String(payload.message || "")
      : actionType === "channel_update"
      ? String(payload.title || "Channel information update")
      : String(payload.title || "Twitch schedule segment");
    const prepared = await service.rpc("prepare_provider_action_preview_service", {
      p_owner: owner,
      p_draft_id: draftId,
      p_ledger_id: String(approval.ledger_id || ""),
      p_provider: "twitch",
      p_action: `twitch.${actionType}`,
      p_target_id: broadcasterId,
      p_content_hash: contentHash,
      p_action_hash: actionHash,
      p_preview_version: PREVIEW_VERSION,
      p_preview_payload: {
        rendererVersion: PREVIEW_VERSION,
        items: [{
          provider: "twitch",
          account: "Exact connected Twitch broadcaster",
          accountId: broadcasterId,
          placement: actionType === "schedule_segment_create"
            ? "Twitch channel schedule"
            : actionType === "chat_announcement"
            ? "Twitch live chat announcement"
            : "Twitch channel information",
          requiresExactTarget: true,
          exactTargetReady: true,
          title: actionType === "schedule_segment_create"
            ? String(payload.title || "")
            : "",
          text: visibleText,
          tags: actionType === "channel_update" && Array.isArray(payload.tags)
            ? payload.tags.join(" ")
            : "",
          mediaUrl: "",
          mediaKind: "text",
          mediaItems: [],
          requiresMedia: false,
          scheduledFor,
          mode: actionType,
          timingLabel: scheduledFor
            ? `Create Twitch schedule segment for ${scheduledFor}`
            : "Immediately after acknowledgement",
          platformDetails: [
            `Exact Twitch broadcaster ID: ${broadcasterId}`,
            `Required scope: ${String(approval.required_scope || "")}`,
            `Exact action payload: ${JSON.stringify(payload)}`,
            actionType === "schedule_segment_create"
              ? "Creates a Twitch schedule segment; it does not publish a feed post"
              : "Owner-triggered Twitch feature mutation",
          ],
        }],
      },
    });
    const serverReceipt = prepared.data as Json | null;
    if (prepared.error || !serverReceipt) {
      return json(origin, 409, {
        error: prepared.error?.message ||
          "The Twitch action receipt could not be prepared",
      });
    }
    return json(origin, 200, {
      prepared: true,
      approvalId: approval.id,
      approvalHash: actionHash,
      broadcasterId,
      actionType: approval.action_type,
      actionPayload: approval.action_payload,
      previewVersion: approval.preview_version,
      receipt: serverReceipt,
      preview: serverReceipt.preview,
    });
  }
  if (
    action !== "execute" ||
    !/^[0-9a-f]{64}$/.test(String(body.approvalHash || "")) ||
    !SAFE_UUID.test(String(body.receiptId || ""))
  ) {
    return json(origin, 400, {
      error: "An acknowledged one-shot Twitch preview receipt is required",
    });
  }
  const draft = await service.from("drafts").select("account_id")
    .eq("id", draftId).eq("owner", owner).eq("platform", "twitch")
    .maybeSingle();
  const ledgerId = String(draft.data?.account_id || "");
  if (draft.error || !SAFE_UUID.test(ledgerId)) {
    return json(origin, 409, {
      error: "The approved Twitch destination is unavailable",
    });
  }
  const leaseId = crypto.randomUUID();
  const claimedLease = await service.rpc("claim_twitch_operation", {
    p_ledger_id: ledgerId,
    p_owner: owner,
    p_lease_id: leaseId,
    p_operation_kind: "action",
    p_ttl_seconds: 180,
  });
  if (claimedLease.error || claimedLease.data !== true) {
    return json(origin, 409, { error: "Another Twitch operation is active" });
  }
  try {
    const attemptId = crypto.randomUUID();
    const claimed = await service.rpc("claim_twitch_action_service", {
      p_owner: owner,
      p_draft_id: draftId,
      p_approval_hash: String(body.approvalHash),
      p_attempt_id: attemptId,
      p_lease_id: leaseId,
      p_receipt_id: String(body.receiptId),
    });
    const row =
      (Array.isArray(claimed.data) ? claimed.data[0] : claimed.data) as
        | ClaimedAction
        | null;
    if (claimed.error || !row) {
      return json(origin, 409, {
        error: claimed.error?.message || "Twitch approval could not be claimed",
      });
    }
    if (!row.is_new) {
      const final = ["completed", "definitive_failure"].includes(
        row.attempt_status,
      );
      return json(origin, final ? 200 : 202, {
        status: row.attempt_status,
        attemptId: row.attempt_id,
        alreadyClaimed: true,
        reconciliationRequired: !final,
        instruction: final
          ? "This exact Twitch action receipt already has a final durable outcome."
          : "This exact Twitch action receipt was already claimed. Reconcile it; never resend it blindly.",
      });
    }
    const access = await verifiedAccess(owner, row);
    if (!access) {
      try {
        await finish(
          owner,
          attemptId,
          "definitive_failure",
          null,
          "",
          {},
          "twitch_reconnect_required",
          "The exact Twitch identity or permission could not be verified.",
        );
      } catch {
        return json(origin, 503, {
          error:
            "Twitch access was rejected before any provider action, but the durable failure checkpoint needs attention",
          attemptId,
        });
      }
      return json(origin, 409, {
        error:
          "Reconnect the exact Twitch broadcaster and permission before retrying",
      });
    }
    const result = await executeProvider(owner, row, access);
    return json(origin, result.status, { ...result.body, attemptId });
  } finally {
    await service.rpc("release_twitch_operation", {
      p_ledger_id: ledgerId,
      p_owner: owner,
      p_lease_id: leaseId,
    });
  }
});
