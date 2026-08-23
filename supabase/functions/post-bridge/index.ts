// post-bridge — owner-authenticated publication of one approved draft.
//
// The only implemented publishing destination is the native AliaSpaces feed.
// External records, ownership verification, read-only OAuth grants, and generic
// "connected" states are never treated as external write authorization.
// Deploy: supabase functions deploy post-bridge
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { requireAal2 } from "../_shared/aal2.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const ALLOWED_ORIGINS = new Set([
  "https://aliaspaces.com",
  "https://www.aliaspaces.com",
  "https://app.aliaspaces.com",
  "https://mypersonas.online",
]);

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

type ZonedParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

type DraftRow = {
  id: string;
  owner: string;
  persona_id: string;
  account_id: string | null;
  platform: string | null;
  content_kind: string;
  title: string | null;
  body: string | null;
  tags: string | null;
  media_url: string | null;
  publish_at: string | null;
  approval_state: string;
  approved_content_hash: string;
  publish_state: string;
  publish_error: string;
  provider_post_id: string;
  updated_at: string | null;
};

type BindingRow = {
  id: string;
  status: string;
  claim_state: string;
  autonomy_level: number;
};

type AccountRow = {
  id: string;
  provider: string;
};

type DestinationRow = {
  id: string;
  destination: string;
  mode: "manual" | "approval" | "auto";
  enabled: boolean;
  allowed_content_types: string[];
  daily_publish_limit: number;
  quiet_hours_start: string | null;
  quiet_hours_end: string | null;
};

type DestinationResult =
  | { ok: false; error: string }
  | {
    ok: true;
    destination: string;
    account: AccountRow | null;
    target: DestinationRow;
  };

function cors(origin: string) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Cache-Control": "no-store",
    "Vary": "Origin",
  };
}

function responseJson(body: unknown, status = 200, origin = "") {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...(origin && ALLOWED_ORIGINS.has(origin) ? cors(origin) : {}),
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

function normalizedDestination(value: unknown) {
  const raw = typeof value === "string" && value.trim()
    ? value.trim()
    : "aliaspaces";
  return raw.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "")
    .replace(/\/$/, "");
}

function isNativeDestination(value: unknown) {
  return ["aliaspaces", "aliaspaces.com", "mypersonas", "mypersonas.online"]
    .includes(normalizedDestination(value));
}

function zonedParts(date: Date, timeZone: string): ZonedParts {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(date).filter((part) => part.type !== "literal").map(
      (part) => [part.type, part.value],
    ),
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

function validTimeZone(value: unknown) {
  const timeZone = typeof value === "string" && value.trim()
    ? value.trim()
    : "UTC";
  try {
    zonedParts(new Date(), timeZone);
    return timeZone;
  } catch {
    return "UTC";
  }
}

function parseClock(value: unknown) {
  const match = (typeof value === "string" ? value : "").match(
    /^(\d{1,2}):(\d{2})(?::(\d{2}))?/,
  );
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = Number(match[3] || 0);
  if (hour > 23 || minute > 59 || second > 59) return null;
  return { hour, minute, second, total: hour * 3600 + minute * 60 + second };
}

function inQuietHours(
  startInput: unknown,
  endInput: unknown,
  timeZoneInput: unknown,
  now: Date,
) {
  const start = parseClock(startInput);
  const end = parseClock(endInput);
  if (!start || !end || start.total === end.total) return false;
  const local = zonedParts(now, validTimeZone(timeZoneInput));
  const current = local.hour * 3600 + local.minute * 60 + local.second;
  return start.total > end.total
    ? current >= start.total || current < end.total
    : current >= start.total && current < end.total;
}

async function audit(
  owner: string,
  personaId: string,
  bindingId: string,
  actionType: string,
  draftId: string,
  outcome: string,
  detail: Record<string, unknown> = {},
) {
  const { error } = await admin.rpc("insert_agent_action_service", {
    p_owner: owner,
    p_persona_id: personaId,
    p_binding_id: bindingId,
    p_action_type: actionType,
    p_entity_type: "draft",
    p_entity_id: draftId,
    p_outcome: outcome,
    p_detail: detail,
  });
  if (error) console.error("agent audit insert failed", error.message);
}

async function expectedDraftHash(draft: DraftRow) {
  const { data, error } = await admin.rpc("agent_draft_hash", {
    p_title: draft.title || "",
    p_body: draft.body || "",
    p_tags: draft.tags || "",
    p_media_url: draft.media_url || "",
    p_content_kind: draft.content_kind || "post",
    p_persona_id: draft.persona_id,
    p_account_id: draft.account_id || null,
    p_platform: draft.platform || "aliaspaces",
    p_publish_at: draft.publish_at || null,
  });
  return { hash: typeof data === "string" ? data : "", error };
}

async function markBlocked(
  draft: DraftRow,
  binding: BindingRow,
  message: string,
  code: string,
  origin: string,
  status = 409,
) {
  await admin.from("drafts").update({
    publish_state: "blocked",
    publish_error: message,
  }).eq("id", draft.id).eq("owner", draft.owner).in(
    "publish_state",
    ["not_queued", "queued", "failed", "blocked"],
  );
  await audit(
    draft.owner,
    draft.persona_id,
    binding.id,
    "publish.blocked",
    draft.id,
    "blocked",
    {
      code,
      destination: normalizedDestination(draft.platform),
    },
  );
  return responseJson({ error: message, code, gated: true }, status, origin);
}

async function destinationFor(
  draft: DraftRow,
  binding: BindingRow,
): Promise<DestinationResult> {
  let destination = normalizedDestination(draft.platform);
  let account: AccountRow | null = null;
  if (draft.account_id) {
    const { data, error } = await admin.from("account_ledger")
      .select("id,provider")
      .eq("id", draft.account_id)
      .eq("owner", draft.owner)
      .eq("persona_id", draft.persona_id)
      .maybeSingle();
    if (error || !data) {
      return {
        ok: false,
        error: "The destination account is not assigned to this persona.",
      };
    }
    account = data as AccountRow;
    destination = normalizedDestination(data.provider);
  } else if (!isNativeDestination(destination)) {
    return {
      ok: false,
      error: "External publishing requires an account assigned to the persona.",
    };
  }

  let query = admin.from("agent_destinations")
    .select(
      "id,destination,mode,enabled,allowed_content_types,daily_publish_limit,quiet_hours_start,quiet_hours_end",
    )
    .eq("owner", draft.owner)
    .eq("binding_id", binding.id)
    .eq("persona_id", draft.persona_id);
  query = account
    ? query.eq("account_id", account.id)
    : query.is("account_id", null);
  const { data: target, error } = await query.maybeSingle();
  if (error || !target) {
    return {
      ok: false,
      error: "No automation destination is configured for this target.",
    };
  }
  if (normalizedDestination(target.destination) !== destination) {
    return {
      ok: false,
      error:
        "The configured destination does not match the assigned account provider.",
    };
  }
  return { ok: true, destination, account, target: target as DestinationRow };
}

async function publishDraft(draft: DraftRow, origin: string) {
  const { data, error } = await admin.rpc("publish_native_agent_draft", {
    p_draft_id: draft.id,
    p_owner: draft.owner,
    p_require_due: false,
  });
  if (error) {
    return responseJson(
      {
        error: error.message || "The atomic native publish was rejected.",
        code: "atomic_publish_rejected",
      },
      409,
      origin,
    );
  }
  const result = data as {
    published?: boolean;
    draftId?: string;
    postId?: string;
    postedAt?: string;
    idempotent?: boolean;
  } | null;
  if (!result?.published || !result.postId) {
    return responseJson(
      { error: "The atomic native publish returned an invalid result." },
      500,
      origin,
    );
  }
  return responseJson(result, 200, origin);
}

serve(async (req) => {
  const origin = req.headers.get("Origin") || "";
  if (req.method === "OPTIONS") {
    return ALLOWED_ORIGINS.has(origin)
      ? new Response("ok", { headers: cors(origin) })
      : new Response("Forbidden", { status: 403 });
  }
  if (req.method !== "POST") {
    return responseJson({ error: "POST only" }, 405, origin);
  }
  if (origin && !ALLOWED_ORIGINS.has(origin)) {
    return responseJson({ error: "Origin not allowed" }, 403);
  }

  const guard = await requireAal2(req, admin);
  if (!guard.ok) {
    return responseJson(
      { error: guard.error, code: guard.code },
      guard.status,
      origin,
    );
  }
  const user = guard.user;
  let payload: { draftId?: string };
  try {
    payload = await req.json();
  } catch {
    return responseJson({ error: "Invalid request" }, 400, origin);
  }
  const draftId = (payload.draftId || "").trim();
  if (!/^[0-9a-f-]{36}$/i.test(draftId)) {
    return responseJson({ error: "A valid draft id is required" }, 400, origin);
  }

  const { data: draftData, error: draftError } = await admin.from("drafts")
    .select(
      "*",
    )
    .eq("id", draftId).eq("owner", user.id).maybeSingle();
  if (draftError) {
    return responseJson({ error: "The draft could not be read" }, 500, origin);
  }
  if (!draftData || !draftData.persona_id) {
    return responseJson(
      { error: "Owned draft with a persona not found" },
      404,
      origin,
    );
  }
  const draft = draftData as DraftRow;
  if (draft.publish_state === "published") {
    return responseJson(
      {
        published: true,
        draftId,
        postId: draft.provider_post_id,
        idempotent: true,
      },
      200,
      origin,
    );
  }
  if (draft.publish_state === "publishing") {
    return responseJson(
      { error: "This draft is already being published" },
      409,
      origin,
    );
  }

  const [personaResult, settingsResult, bindingResult] = await Promise.all([
    admin.from("personas").select("id").eq("id", draft.persona_id).eq(
      "owner",
      user.id,
    ).maybeSingle(),
    admin.from("agent_owner_settings").select(
      "automation_paused,default_timezone,quiet_hours_start,quiet_hours_end",
    )
      .eq("owner", user.id).maybeSingle(),
    admin.from("agent_bindings").select("id,status,claim_state,autonomy_level")
      .eq("owner", user.id).eq("persona_id", draft.persona_id).maybeSingle(),
  ]);
  if (personaResult.error || !personaResult.data) {
    return responseJson(
      { error: "The persona is not owned by this account" },
      403,
      origin,
    );
  }
  if (settingsResult.error || !settingsResult.data) {
    return responseJson(
      { error: "Owner automation settings are unavailable" },
      500,
      origin,
    );
  }
  if (bindingResult.error || !bindingResult.data) {
    return responseJson(
      { error: "No agent binding exists for this persona" },
      409,
      origin,
    );
  }
  const settings = settingsResult.data;
  const binding = bindingResult.data as BindingRow;
  if (settings.automation_paused) {
    return await markBlocked(
      draft,
      binding,
      "Owner automation is paused.",
      "owner_paused",
      origin,
    );
  }
  if (binding.status !== "active") {
    return await markBlocked(
      draft,
      binding,
      `Agent binding is ${binding.status}.`,
      "binding_inactive",
      origin,
    );
  }
  if (!["self_attested", "verified"].includes(binding.claim_state)) {
    return await markBlocked(
      draft,
      binding,
      `Persona claim is ${binding.claim_state}.`,
      "claim_inactive",
      origin,
    );
  }

  const destinationResult = await destinationFor(draft, binding);
  if (!destinationResult.ok) {
    return await markBlocked(
      draft,
      binding,
      destinationResult.error,
      "destination_invalid",
      origin,
    );
  }
  const { destination, account, target } = destinationResult;
  if (!target.enabled) {
    return await markBlocked(
      draft,
      binding,
      "This automation destination is disabled.",
      "destination_disabled",
      origin,
    );
  }
  if (
    !Array.isArray(target.allowed_content_types) ||
    !target.allowed_content_types.includes(draft.content_kind)
  ) {
    return await markBlocked(
      draft,
      binding,
      "This content type is not allowed for the destination.",
      "content_type_not_allowed",
      origin,
    );
  }
  if (target.mode === "manual") {
    return await markBlocked(
      draft,
      binding,
      "This destination is set to manual publishing.",
      "destination_manual",
      origin,
    );
  }
  const requiredAutonomy = target.mode === "auto" ? 3 : 2;
  if (Number(binding.autonomy_level) < requiredAutonomy) {
    return await markBlocked(
      draft,
      binding,
      `Autonomy level ${requiredAutonomy} is required for ${target.mode} publishing.`,
      "autonomy_too_low",
      origin,
    );
  }

  if (draft.approval_state !== "approved" || !draft.approved_content_hash) {
    return responseJson(
      {
        error: "The owner must approve this exact draft before publishing.",
        code: "approval_required",
      },
      409,
      origin,
    );
  }
  const hashResult = await expectedDraftHash(draft);
  if (hashResult.error) {
    return responseJson(
      { error: "Draft approval could not be verified" },
      500,
      origin,
    );
  }
  if (!hashResult.hash || hashResult.hash !== draft.approved_content_hash) {
    const message =
      "Approval no longer matches the draft content, target, or schedule. Please approve it again.";
    await admin.from("drafts").update({
      approval_state: "draft",
      approved_at: null,
      approved_content_hash: "",
      publish_state: "not_queued",
      publish_error: message,
      status: "idea",
    }).eq("id", draft.id).eq("owner", user.id).in(
      "publish_state",
      ["not_queued", "queued", "failed", "blocked"],
    );
    await audit(
      user.id,
      draft.persona_id,
      binding.id,
      "publish.approval_invalid",
      draft.id,
      "blocked",
      {
        destination,
      },
    );
    return responseJson(
      { error: message, code: "approval_hash_mismatch" },
      409,
      origin,
    );
  }

  if (!isNativeDestination(destination)) {
    let connectionState = "recorded_only";
    if (account) {
      const { data: connection } = await admin.from("account_connections")
        .select("connection_state")
        .eq("ledger_id", account.id).eq("owner", user.id).maybeSingle();
      if (connection?.connection_state) {
        connectionState = connection.connection_state;
      }
    }
    const message =
      "External publishing is gated: no official write connector is implemented for this destination.";
    await admin.from("drafts").update({
      publish_state: "blocked",
      publish_error: message,
    })
      .eq("id", draft.id).eq("owner", user.id).in(
        "publish_state",
        ["not_queued", "queued", "failed", "blocked"],
      );
    await audit(
      user.id,
      draft.persona_id,
      binding.id,
      "publish.external_gated",
      draft.id,
      "blocked",
      {
        destination,
        connectionState,
        connectorImplemented: false,
        writeAccess: false,
      },
    );
    return responseJson(
      {
        error: message,
        code: "external_connector_not_implemented",
        gated: true,
        destination,
        connectionState,
        connectorImplemented: false,
        writeAccess: false,
      },
      409,
      origin,
    );
  }

  const now = new Date();
  if (
    inQuietHours(
      settings.quiet_hours_start,
      settings.quiet_hours_end,
      settings.default_timezone,
      now,
    ) ||
    inQuietHours(
      target.quiet_hours_start,
      target.quiet_hours_end,
      settings.default_timezone,
      now,
    )
  ) {
    await audit(
      user.id,
      draft.persona_id,
      binding.id,
      "publish.deferred",
      draft.id,
      "deferred",
      {
        destination,
        reason: "quiet_hours",
      },
    );
    return responseJson(
      {
        error: "Publishing is paused during the configured quiet hours.",
        code: "quiet_hours",
      },
      409,
      origin,
    );
  }

  // The atomic RPC is the single authority for the native daily cap. It
  // normalizes every native alias and serializes concurrent publications under
  // the destination lock; duplicating the count here can disagree with it.
  return await publishDraft(draft, origin);
});
