// run-publish-queue — publishes due, owner-approved native AliaSpaces drafts.
//
// External destinations are deliberately blocked until a destination-specific
// official write connector exists. Invoke only with X-Cron-Secret.
// Deploy: supabase functions deploy run-publish-queue --no-verify-jwt
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CRON_SECRET = Deno.env.get("CRON_SECRET") || "";
const MAX_DRAFTS_PER_RUN = 50;
const RETRY_DELAY_MS = 15 * 60 * 1000;

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
  publish_at: string;
  publish_next_attempt_at: string | null;
  approval_state: string;
  approved_content_hash: string;
  publish_state: string;
  publish_error: string;
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
  return { total: hour * 3600 + minute * 60 + second };
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
  draft: DraftRow,
  bindingId: string,
  actionType: string,
  outcome: string,
  detail: Record<string, unknown> = {},
) {
  const { error } = await admin.rpc("insert_agent_action_service", {
    p_owner: draft.owner,
    p_persona_id: draft.persona_id,
    p_binding_id: bindingId,
    p_action_type: actionType,
    p_entity_type: "draft",
    p_entity_id: draft.id,
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

async function transitionQueuedDraft(
  draft: { id: string; owner: string },
  values: Record<string, unknown>,
) {
  const { data, error } = await admin.from("drafts").update(values)
    .eq("id", draft.id).eq("owner", draft.owner).eq("publish_state", "queued")
    .select("id").maybeSingle();
  return { changed: !error && !!data, concurrent: !error && !data, error };
}

function transitionFailure(
  draft: { id: string },
  code: string,
  message: string,
  transition: Awaited<ReturnType<typeof transitionQueuedDraft>>,
) {
  return {
    draftId: draft.id,
    status: transition.error ? "transition_error" : "concurrent_noop",
    code: transition.error ? `${code}_update_failed` : `${code}_superseded`,
    message: transition.error
      ? "The queue state could not be updated and will be retried."
      : "Another worker or owner action already changed this draft.",
    detail: transition.error?.message || message,
  };
}

async function blockDraft(
  draft: DraftRow,
  bindingId: string,
  code: string,
  message: string,
  detail: Record<string, unknown> = {},
) {
  const transition = await transitionQueuedDraft(draft, {
    publish_state: "blocked",
    publish_next_attempt_at: null,
    publish_error: message,
  });
  if (!transition.changed) {
    return transitionFailure(draft, code, message, transition);
  }
  await audit(draft, bindingId, "publish.blocked", "blocked", {
    code,
    ...detail,
  });
  return { draftId: draft.id, status: "blocked", code, message };
}

async function deferDraft(
  draft: DraftRow,
  bindingId: string,
  code: string,
  message: string,
  detail: Record<string, unknown> = {},
) {
  const transition = await transitionQueuedDraft(draft, {
    publish_error: message,
    publish_next_attempt_at: new Date(Date.now() + RETRY_DELAY_MS)
      .toISOString(),
  });
  if (!transition.changed) {
    return transitionFailure(draft, code, message, transition);
  }
  if (draft.publish_error !== message) {
    await audit(draft, bindingId, "publish.deferred", "deferred", {
      code,
      ...detail,
    });
  }
  return { draftId: draft.id, status: "deferred", code, message };
}

async function destinationFor(
  draft: DraftRow,
  bindingId: string,
): Promise<DestinationResult> {
  let destination = normalizedDestination(draft.platform);
  let account: AccountRow | null = null;
  if (draft.account_id) {
    const { data, error } = await admin.from("account_ledger").select(
      "id,provider",
    )
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
    .eq("binding_id", bindingId)
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

async function publishNative(draft: DraftRow, bindingId: string) {
  const { data, error } = await admin.rpc("publish_native_agent_draft", {
    p_draft_id: draft.id,
    p_owner: draft.owner,
    p_require_due: true,
  });
  if (error) {
    return await deferDraft(
      draft,
      bindingId,
      "atomic_publish_rejected",
      (error.message || "The atomic native publish was rejected.").slice(
        0,
        500,
      ),
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
    return await deferDraft(
      draft,
      bindingId,
      "atomic_publish_invalid_result",
      "The atomic native publish returned an invalid result.",
    );
  }
  return {
    draftId: result.draftId || draft.id,
    status: "published",
    postId: result.postId,
    postedAt: result.postedAt,
    idempotent: !!result.idempotent,
  };
}

async function processDraft(draft: DraftRow, now: Date) {
  const [personaResult, settingsResult, bindingResult] = await Promise.all([
    admin.from("personas").select("id").eq("id", draft.persona_id).eq(
      "owner",
      draft.owner,
    ).maybeSingle(),
    admin.from("agent_owner_settings").select(
      "automation_paused,default_timezone,quiet_hours_start,quiet_hours_end",
    )
      .eq("owner", draft.owner).maybeSingle(),
    admin.from("agent_bindings").select("id,status,claim_state,autonomy_level")
      .eq("owner", draft.owner).eq("persona_id", draft.persona_id)
      .maybeSingle(),
  ]);
  if (personaResult.error || !personaResult.data) {
    const message = "The persona is missing or not owned.";
    const transition = await transitionQueuedDraft(draft, {
      publish_state: "blocked",
      publish_next_attempt_at: null,
      publish_error: message,
    });
    if (!transition.changed) {
      return transitionFailure(draft, "persona_invalid", message, transition);
    }
    return { draftId: draft.id, status: "blocked", code: "persona_invalid" };
  }
  if (bindingResult.error || !bindingResult.data) {
    const message = "No agent binding exists for the persona.";
    const transition = await transitionQueuedDraft(draft, {
      publish_state: "blocked",
      publish_next_attempt_at: null,
      publish_error: message,
    });
    if (!transition.changed) {
      return transitionFailure(draft, "binding_missing", message, transition);
    }
    return { draftId: draft.id, status: "blocked", code: "binding_missing" };
  }
  const binding = bindingResult.data as BindingRow;
  if (settingsResult.error || !settingsResult.data) {
    return await blockDraft(
      draft,
      binding.id,
      "settings_missing",
      "Owner automation settings are unavailable.",
    );
  }
  const settings = settingsResult.data;
  if (settings.automation_paused) {
    return await deferDraft(
      draft,
      binding.id,
      "owner_paused",
      "Owner automation is paused.",
    );
  }
  if (binding.status === "paused") {
    return await deferDraft(
      draft,
      binding.id,
      "binding_paused",
      "This persona's agent is paused.",
    );
  }
  if (binding.status !== "active") {
    return await blockDraft(
      draft,
      binding.id,
      "binding_inactive",
      `Agent binding is ${binding.status}.`,
    );
  }
  if (!["self_attested", "verified"].includes(binding.claim_state)) {
    return await blockDraft(
      draft,
      binding.id,
      "claim_inactive",
      `Persona claim is ${binding.claim_state}.`,
    );
  }

  const destinationResult = await destinationFor(draft, binding.id);
  if (!destinationResult.ok) {
    return await blockDraft(
      draft,
      binding.id,
      "destination_invalid",
      destinationResult.error,
    );
  }
  const { destination, account, target } = destinationResult;
  if (!target.enabled) {
    return await blockDraft(
      draft,
      binding.id,
      "destination_disabled",
      "This automation destination is disabled.",
    );
  }
  if (
    !Array.isArray(target.allowed_content_types) ||
    !target.allowed_content_types.includes(draft.content_kind)
  ) {
    return await blockDraft(
      draft,
      binding.id,
      "content_type_not_allowed",
      "This content type is not allowed for the destination.",
    );
  }
  if (target.mode === "manual") {
    return await blockDraft(
      draft,
      binding.id,
      "destination_manual",
      "This destination is set to manual publishing.",
    );
  }
  if (target.mode === "approval") {
    return {
      draftId: draft.id,
      status: "awaiting_owner",
      code: "owner_publish_required",
      message:
        "The approved draft is waiting for the owner to press Publish now.",
    };
  }
  const requiredAutonomy = target.mode === "auto" ? 3 : 2;
  if (Number(binding.autonomy_level) < requiredAutonomy) {
    return await blockDraft(
      draft,
      binding.id,
      "autonomy_too_low",
      `Autonomy level ${requiredAutonomy} is required for ${target.mode} publishing.`,
    );
  }

  if (draft.approval_state !== "approved" || !draft.approved_content_hash) {
    return await blockDraft(
      draft,
      binding.id,
      "approval_required",
      "The owner must approve this exact draft before publishing.",
    );
  }
  const hashResult = await expectedDraftHash(draft);
  if (hashResult.error) {
    return await deferDraft(
      draft,
      binding.id,
      "approval_check_failed",
      "Draft approval could not be verified.",
    );
  }
  if (!hashResult.hash || hashResult.hash !== draft.approved_content_hash) {
    const message =
      "Approval no longer matches the draft content, target, or schedule. Please approve it again.";
    const transition = await transitionQueuedDraft(draft, {
      approval_state: "draft",
      approved_at: null,
      approved_content_hash: "",
      publish_state: "not_queued",
      publish_next_attempt_at: null,
      publish_error: message,
      status: "idea",
    });
    if (!transition.changed) {
      return transitionFailure(
        draft,
        "approval_hash_mismatch",
        message,
        transition,
      );
    }
    await audit(draft, binding.id, "publish.approval_invalid", "blocked", {
      destination,
    });
    return {
      draftId: draft.id,
      status: "blocked",
      code: "approval_hash_mismatch",
      message,
    };
  }

  if (!isNativeDestination(destination)) {
    let connectionState = "recorded_only";
    if (account) {
      const { data: connection } = await admin.from("account_connections")
        .select("connection_state")
        .eq("ledger_id", account.id).eq("owner", draft.owner).maybeSingle();
      if (connection?.connection_state) {
        connectionState = connection.connection_state;
      }
    }
    const message =
      "External publishing is gated: no official write connector is implemented for this destination.";
    const transition = await transitionQueuedDraft(draft, {
      publish_state: "blocked",
      publish_next_attempt_at: null,
      publish_error: message,
    });
    if (!transition.changed) {
      return transitionFailure(
        draft,
        "external_connector_not_implemented",
        message,
        transition,
      );
    }
    await audit(draft, binding.id, "publish.external_gated", "blocked", {
      destination,
      connectionState,
      connectorImplemented: false,
      writeAccess: false,
    });
    return {
      draftId: draft.id,
      status: "blocked",
      code: "external_connector_not_implemented",
      destination,
      connectionState,
      connectorImplemented: false,
      writeAccess: false,
    };
  }

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
    return await deferDraft(
      draft,
      binding.id,
      "quiet_hours",
      "Publishing is paused during the configured quiet hours.",
      {
        destination,
      },
    );
  }

  // The atomic RPC is the single authority for the native daily cap. It
  // normalizes every native alias and serializes concurrent publications under
  // the destination lock; duplicating the count here can disagree with it.
  return await publishNative(draft, binding.id);
}

serve(async (req) => {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
    });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  if (!CRON_SECRET || req.headers.get("X-Cron-Secret") !== CRON_SECRET) {
    return json({ error: "forbidden" }, 403);
  }

  const now = new Date();
  const { data: drafts, error } = await admin.rpc("due_auto_publish_drafts", {
    p_limit: MAX_DRAFTS_PER_RUN,
  });
  if (error) {
    return json({ error: "The due publish queue could not be loaded." }, 500);
  }

  const results: Record<string, unknown>[] = [];
  for (const draft of drafts || []) {
    if (!draft.persona_id) {
      const message = "Choose a persona before publishing.";
      const transition = await transitionQueuedDraft(draft, {
        publish_state: "blocked",
        publish_next_attempt_at: null,
        publish_error: message,
      });
      results.push(
        transition.changed
          ? { draftId: draft.id, status: "blocked", code: "persona_missing" }
          : transitionFailure(draft, "persona_missing", message, transition),
      );
      continue;
    }
    results.push(await processDraft(draft as DraftRow, new Date()));
  }
  return json({
    processed: results.length,
    published: results.filter((result) => result.status === "published").length,
    results,
    startedAt: now.toISOString(),
    finishedAt: new Date().toISOString(),
  });
});
