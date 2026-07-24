// mailbox-manager — authenticated, owner-scoped Inbox Concierge control plane.
//
// The browser can request scans and preview cleanup plans, but it never receives
// Gmail tokens or provider message IDs. Gmail is mutated only by the cron worker
// after the owner approves an exact, expiring preview hash.
// Deploy: supabase functions deploy mailbox-manager
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import {
  admin,
  ALLOWED_ORIGINS,
  asRecord,
  caller,
  canModifyMailbox,
  canReadMailbox,
  cors,
  FindingCategory,
  gmailAccessToken,
  GmailMessage,
  gmailMetadataAttachmentState,
  gmailRequest,
  integerInRange,
  isUuid,
  json,
  labelNameForCategory,
  mailboxAiEndpoint,
  MailboxContext,
  MailboxOperation,
  ownedMailboxContext,
  protectedForOperation,
  safeText,
  safeUnsubscribeTarget,
  sha256Hex,
  unsubscribeTargetNetworkSafe,
} from "../_shared/mailbox.ts";

const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_FINDING_IDS = 50;
const PREVIEW_TTL_MS = 24 * 60 * 60 * 1_000;
const ACTIVE_SCAN_STATES = ["queued", "running"];
const CADENCES = new Set(["manual", "daily", "weekly"]);
const CLASSIFIER_MODES = new Set(["rules", "ai"]);
const OPERATIONS = new Set<MailboxOperation>([
  "label",
  "label_archive",
  "trash",
]);

type RequestBody = {
  action?: unknown;
  ledgerId?: unknown;
  paused?: unknown;
  scheduleCadence?: unknown;
  includeSpamTrash?: unknown;
  lookbackDays?: unknown;
  maxMessages?: unknown;
  classifierMode?: unknown;
  aiBackendId?: unknown;
  aiConsent?: unknown;
  findingIds?: unknown;
  operation?: unknown;
  planId?: unknown;
  planHash?: unknown;
  findingId?: unknown;
};

type FindingRow = {
  id: string;
  owner: string;
  ledger_id: string;
  message_ref_id: string;
  category: FindingCategory;
  protected_reasons: string[];
  status: string;
};

type RefRow = {
  id: string;
  owner: string;
  ledger_id: string;
  provider_message_id: string;
  provider_thread_id: string;
  current_labels: string[];
  unsubscribe_kind: string;
  unsubscribe_target: string;
  unsubscribe_host: string;
};

function isoAfter(milliseconds: number) {
  return new Date(Date.now() + milliseconds).toISOString();
}

function nextScheduledAt(cadence: string, paused: boolean) {
  if (paused || cadence === "manual") return null;
  const hours = cadence === "daily" ? 24 : 24 * 7;
  return isoAfter(hours * 60 * 60 * 1_000);
}

function findingIds(value: unknown) {
  if (!Array.isArray(value) || !value.length) return null;
  const ids = [...new Set(value.filter(isUuid))];
  if (
    !ids.length || ids.length > MAX_FINDING_IDS || ids.length !== value.length
  ) {
    return null;
  }
  return ids;
}

function mailboxQueueError(error: unknown) {
  const record = asRecord(error);
  const message = [
    safeText(record.message, 500),
    safeText(record.details, 500),
  ].join(" ");
  if (message.includes("mailbox_active_plan_overlap")) {
    return {
      status: 409,
      body: {
        code: "active_plan_overlap",
        error:
          "One or more messages are already in another active cleanup preview. Review that preview or wait for it to expire.",
      },
    };
  }
  if (message.includes("mailbox_active_plan_limit")) {
    return {
      status: 409,
      body: {
        code: "active_plan_limit",
        error:
          "You already have 10 active cleanup previews or runs. Finish them or let unapproved previews expire before creating another.",
      },
    };
  }
  if (message.includes("mailbox_active_undo_limit")) {
    return {
      status: 409,
      body: {
        code: "active_undo_limit",
        error:
          "You already have 10 Undo requests queued or running. Wait for one to finish before requesting another.",
      },
    };
  }
  return null;
}

async function audit(
  owner: string,
  ledgerId: string,
  eventType: string,
  status: string,
  details: Record<string, unknown> = {},
) {
  const allowedStatus = new Set([
    "info",
    "succeeded",
    "partial",
    "failed",
    "cancelled",
  ]);
  const normalizedStatus = allowedStatus.has(status)
    ? status
    : ["failed", "denied", "blocked"].includes(status)
    ? "failed"
    : "info";
  const counts = Object.fromEntries(
    Object.entries(details).filter(([, value]) =>
      typeof value === "number" && Number.isFinite(value)
    ),
  );
  const { error } = await admin.from("mailbox_audit_events").insert({
    owner,
    ledger_id: ledgerId,
    scan_run_id: isUuid(details.runId) ? details.runId : null,
    action_plan_id: isUuid(details.planId) ? details.planId : null,
    event_type: safeText(
      eventType.toLowerCase().replace(/[^a-z0-9_]+/g, "_"),
      80,
    ),
    status: normalizedStatus,
    summary: safeText(eventType.replaceAll(".", " "), 240),
    counts,
    created_at: new Date().toISOString(),
  });
  if (error) console.error("mailbox audit insert failed", error.code);
  return !error;
}

async function automationPaused(owner: string) {
  const { data, error } = await admin.from("agent_owner_settings").select(
    "automation_paused",
  ).eq("owner", owner).maybeSingle();
  return Boolean(error) || data?.automation_paused === true;
}

async function mailboxPaused(owner: string, ledgerId: string) {
  const { data, error } = await admin.from("mailbox_settings").select("paused")
    .eq("owner", owner).eq("ledger_id", ledgerId).maybeSingle();
  return Boolean(error) || data?.paused !== false;
}

function capability(context: MailboxContext, globalPaused = false) {
  return {
    provider: "gmail",
    connected: context.connectionState === "connected",
    canScan: canReadMailbox(context),
    canOrganize: canModifyMailbox(context),
    needsUpgrade: canReadMailbox(context) && !canModifyMailbox(context),
    metadataOnly: false,
    previewSnippets: true,
    fullBodiesRead: false,
    attachmentsRead: false,
    permanentDeleteSupported: false,
    unsubscribeMode: "manual_confirmed",
    globalPaused,
  };
}

async function mailboxSummary(owner: string, ledgerId: string) {
  const countOpen = (category = "", unprotected = false) => {
    let query = admin.from("mailbox_findings").select("id", {
      count: "exact",
      head: true,
    }).eq("owner", owner).eq("ledger_id", ledgerId).eq("status", "open");
    if (category) query = query.eq("category", category);
    if (unprotected) query = query.eq("protected_reasons", "{}");
    return query;
  };
  const [total, subscriptions, accounts, receipts, protectedResult] =
    await Promise.all([
      countOpen(),
      countOpen("subscription", true),
      countOpen("account_creation", true),
      countOpen("receipt", true),
      admin.from("mailbox_findings").select("id", {
        count: "exact",
        head: true,
      }).eq("owner", owner).eq("ledger_id", ledgerId).eq("status", "open")
        .or(
          "category.in.(security,order_travel,financial_legal_medical,personal),protected_reasons.neq.{}",
        ),
    ]);
  const error = [
    total.error,
    subscriptions.error,
    accounts.error,
    receipts.error,
    protectedResult.error,
  ].find(Boolean);
  const totalCount = total.count || 0;
  const subscriptionCount = subscriptions.count || 0;
  const accountCount = accounts.count || 0;
  const receiptCount = receipts.count || 0;
  return {
    error,
    data: error ? null : {
      total: totalCount,
      subscriptions: subscriptionCount,
      subscription: subscriptionCount,
      accountCreations: accountCount,
      account_creation: accountCount,
      receipts: receiptCount,
      receipt: receiptCount,
      protected: protectedResult.count || 0,
      other: Math.max(
        0,
        totalCount - subscriptionCount - accountCount - receiptCount -
          (protectedResult.count || 0),
      ),
    },
  };
}

async function mailboxFindingViews(owner: string, ledgerId: string) {
  const fields =
    "id,ledger_id,scan_run_id,category,sender_name,sender_address,sender_domain,subject,snippet,received_at,confidence,evidence,protected_reasons,suggested_action,unsubscribe_available,status,created_at,updated_at";
  const unprotectedCategory = (category: string) =>
    admin.from("mailbox_findings").select(fields).eq("owner", owner).eq(
      "ledger_id",
      ledgerId,
    ).eq("status", "open").eq("category", category).eq(
      "protected_reasons",
      "{}",
    ).order("received_at", { ascending: false }).limit(250);
  const [subscriptions, accounts, receipts, other, protectedResult] =
    await Promise.all([
      unprotectedCategory("subscription"),
      unprotectedCategory("account_creation"),
      unprotectedCategory("receipt"),
      unprotectedCategory("other"),
      admin.from("mailbox_findings").select(fields).eq("owner", owner).eq(
        "ledger_id",
        ledgerId,
      ).eq("status", "open").or(
        "category.in.(security,order_travel,financial_legal_medical,personal),protected_reasons.neq.{}",
      ).order("received_at", { ascending: false }).limit(250),
    ]);
  const error = [
    subscriptions.error,
    accounts.error,
    receipts.error,
    other.error,
    protectedResult.error,
  ].find(Boolean);
  const views = {
    subscriptions: subscriptions.data || [],
    accountCreations: accounts.data || [],
    receipts: receipts.data || [],
    other: other.data || [],
    protected: protectedResult.data || [],
  };
  const merged = new Map<string, Record<string, unknown>>();
  for (const finding of Object.values(views).flat()) {
    merged.set(finding.id, {
      ...finding,
      sender_email: finding.sender_address,
    });
  }
  return { error, data: [...merged.values()], views };
}

async function dashboard(owner: string, ledgerId: string) {
  const context = await ownedMailboxContext(ledgerId, owner);
  if (!context) {
    return { status: 404, body: { error: "Owned Gmail account not found" } };
  }
  const now = new Date().toISOString();
  const expiredPreviewResult = await admin.from("mailbox_action_plans").update({
    status: "expired",
    updated_at: now,
  }).eq("owner", owner).eq("ledger_id", ledgerId).eq(
    "status",
    "pending_approval",
  ).lte("expires_at", now);
  if (expiredPreviewResult.error) {
    console.error(
      "mailbox expired preview cleanup failed",
      expiredPreviewResult.error.code,
    );
  }
  const [
    settingsResult,
    activeScanResult,
    recentRunsResult,
    findingsResult,
    plansResult,
    activePlansResult,
    auditResult,
    pausedResult,
    summaryResult,
  ] = await Promise.all([
    admin.from("mailbox_settings").select("*").eq("owner", owner).eq(
      "ledger_id",
      ledgerId,
    ).maybeSingle(),
    admin.from("mailbox_scan_runs").select("*").eq("owner", owner).eq(
      "ledger_id",
      ledgerId,
    ).in("status", ACTIVE_SCAN_STATES).order("created_at", {
      ascending: false,
    }).limit(1).maybeSingle(),
    admin.from("mailbox_scan_runs").select("*").eq("owner", owner).eq(
      "ledger_id",
      ledgerId,
    ).order("created_at", { ascending: false }).limit(8),
    mailboxFindingViews(owner, ledgerId),
    admin.from("mailbox_action_plans").select(
      "id,ledger_id,operation,target_label,status,plan_hash,finding_ids,total_count,category_counts,protected_excluded,expires_at,approved_at,completed_at,undo_status,undo_expires_at,undo_requested_at,undone_at,created_at,updated_at,error_code,error_message",
    ).eq("owner", owner).eq("ledger_id", ledgerId).order("created_at", {
      ascending: false,
    }).limit(20),
    admin.from("mailbox_action_plans").select(
      "id,ledger_id,operation,target_label,status,plan_hash,finding_ids,total_count,category_counts,protected_excluded,expires_at,approved_at,completed_at,undo_status,undo_expires_at,undo_requested_at,undone_at,created_at,updated_at,error_code,error_message",
    ).eq("owner", owner).eq("ledger_id", ledgerId).in("status", [
      "pending_approval",
      "approved",
      "applying",
    ]).order("created_at", { ascending: false }).limit(50),
    admin.from("mailbox_audit_events").select(
      "id,scan_run_id,action_plan_id,event_type,status,summary,counts,created_at",
    ).eq("owner", owner).eq("ledger_id", ledgerId).order("created_at", {
      ascending: false,
    }).limit(40),
    admin.from("agent_owner_settings").select("automation_paused").eq(
      "owner",
      owner,
    ).maybeSingle(),
    mailboxSummary(owner, ledgerId),
  ]);
  const firstError = [
    settingsResult.error,
    activeScanResult.error,
    recentRunsResult.error,
    findingsResult.error,
    plansResult.error,
    activePlansResult.error,
    auditResult.error,
    pausedResult.error,
    summaryResult.error,
  ].find(Boolean);
  if (firstError) {
    console.error("mailbox dashboard query failed", firstError.code);
    return { status: 500, body: { error: "Inbox dashboard is unavailable" } };
  }
  return {
    status: 200,
    body: {
      settings: settingsResult.data,
      activeScan: activeScanResult.data,
      recentRuns: recentRunsResult.data || [],
      summary: summaryResult.data,
      capability: capability(
        context,
        pausedResult.data?.automation_paused === true,
      ),
      findings: findingsResult.data || [],
      findingViews: findingsResult.views,
      actionPlans: [
        ...new Map(
          [
            ...(activePlansResult.data || []),
            ...(plansResult.data || []),
          ].map((plan) => [plan.id, plan]),
        ).values(),
      ].sort((left, right) =>
        String(right.created_at || "").localeCompare(
          String(left.created_at || ""),
        )
      ),
      audit: auditResult.data || [],
    },
  };
}

async function saveSettings(
  owner: string,
  context: MailboxContext,
  body: RequestBody,
) {
  if (!canReadMailbox(context)) {
    return {
      status: 409,
      body: { error: "Connect Gmail before configuring inbox scans" },
    };
  }
  const paused = typeof body.paused === "boolean" ? body.paused : true;
  const scheduleCadence = safeText(body.scheduleCadence, 32) || "manual";
  const requestedClassifierMode = safeText(body.classifierMode, 32) || "rules";
  const classifierMode = requestedClassifierMode === "ai_assisted"
    ? "ai"
    : requestedClassifierMode;
  const aiBackendId = body.aiBackendId === null || body.aiBackendId === ""
    ? null
    : isUuid(body.aiBackendId)
    ? body.aiBackendId
    : null;
  const aiConsent = body.aiConsent === true;
  if (!CADENCES.has(scheduleCadence)) {
    return { status: 400, body: { error: "Unsupported scan schedule" } };
  }
  if (!CLASSIFIER_MODES.has(classifierMode)) {
    return { status: 400, body: { error: "Unsupported classifier mode" } };
  }
  if (classifierMode === "ai" && (!aiConsent || !aiBackendId)) {
    return {
      status: 400,
      body: {
        error:
          "AI-assisted classification requires explicit consent and a saved AI backend",
      },
    };
  }
  if (aiBackendId) {
    const { data: backend, error } = await admin.from("ai_backends").select(
      "id,owner,provider,base_url,api_key,model,extra",
    )
      .eq("id", aiBackendId).eq("owner", owner).maybeSingle();
    if (error || !backend) {
      return { status: 400, body: { error: "Owned AI backend not found" } };
    }
    if (
      classifierMode === "ai" &&
      (!mailboxAiEndpoint(backend) || !safeText(backend.model, 200))
    ) {
      return {
        status: 400,
        body: {
          error:
            "That AI backend is not approved for inbox classification. Confirm its inbox host and deployment allowlist first.",
        },
      };
    }
  }
  const values = {
    owner,
    ledger_id: context.ledgerId,
    provider: "gmail",
    paused,
    schedule_cadence: scheduleCadence,
    include_spam_trash: body.includeSpamTrash === true,
    lookback_days: integerInRange(body.lookbackDays, 90, 1, 3_650),
    max_messages: integerInRange(body.maxMessages, 500, 25, 5_000),
    classifier_mode: classifierMode,
    ai_backend_id: classifierMode === "ai" ? aiBackendId : null,
    ai_consent: classifierMode === "ai" && aiConsent,
    ai_consent_at: classifierMode === "ai" && aiConsent
      ? new Date().toISOString()
      : null,
    next_scan_at: nextScheduledAt(scheduleCadence, paused),
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await admin.from("mailbox_settings").upsert(values, {
    onConflict: "ledger_id",
  }).select("*").single();
  if (error) {
    console.error("mailbox settings save failed", error.code);
    return {
      status: 500,
      body: { error: "Inbox settings could not be saved" },
    };
  }
  await audit(owner, context.ledgerId, "settings.saved", "ok", {
    paused,
    scheduleCadence,
    classifierMode,
    includeSpamTrash: values.include_spam_trash,
  });
  return { status: 200, body: { settings: data } };
}

async function requestScan(owner: string, context: MailboxContext) {
  if (await automationPaused(owner)) {
    return {
      status: 409,
      body: {
        error:
          "All agent automation is paused. Resume it before starting an inbox scan.",
        globalPaused: true,
      },
    };
  }
  if (await mailboxPaused(owner, context.ledgerId)) {
    return {
      status: 409,
      body: {
        error:
          "Inbox Concierge is paused for this account. Resume it before scanning.",
        mailboxPaused: true,
      },
    };
  }
  if (!canReadMailbox(context)) {
    return {
      status: 409,
      body: { error: "Connect Gmail with inbox read access first" },
    };
  }
  const { data: active, error: activeError } = await admin.from(
    "mailbox_scan_runs",
  ).select("*").eq("owner", owner).eq("ledger_id", context.ledgerId).in(
    "status",
    ACTIVE_SCAN_STATES,
  ).order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (activeError) {
    return { status: 500, body: { error: "Scan status could not be checked" } };
  }
  if (active) {
    return { status: 202, body: { run: active, alreadyQueued: true } };
  }

  let { data: settings, error: settingsError } = await admin.from(
    "mailbox_settings",
  ).select("*").eq("owner", owner).eq("ledger_id", context.ledgerId)
    .maybeSingle();
  if (settingsError) {
    return { status: 500, body: { error: "Inbox settings could not be read" } };
  }
  if (!settings) {
    const defaultSettings = {
      owner,
      ledger_id: context.ledgerId,
      provider: "gmail",
      paused: true,
      schedule_cadence: "manual",
      include_spam_trash: false,
      lookback_days: 90,
      max_messages: 500,
      classifier_mode: "rules",
      ai_backend_id: null,
      ai_consent: false,
      ai_consent_at: null,
      next_scan_at: null,
      updated_at: new Date().toISOString(),
    };
    const created = await admin.from("mailbox_settings").insert(defaultSettings)
      .select("*").single();
    if (created.error) {
      return {
        status: 500,
        body: { error: "Default inbox settings could not be created" },
      };
    }
    settings = created.data;
  }
  const snapshot = {
    includeSpamTrash: settings.include_spam_trash === true,
    lookbackDays: integerInRange(settings.lookback_days, 90, 1, 3_650),
    maxMessages: integerInRange(settings.max_messages, 500, 25, 5_000),
    classifierMode: safeText(settings.classifier_mode, 32) || "rules",
    aiBackendId: isUuid(settings.ai_backend_id) ? settings.ai_backend_id : null,
    aiConsent: settings.ai_consent === true,
  };
  const { data: run, error } = await admin.from("mailbox_scan_runs").insert({
    owner,
    ledger_id: context.ledgerId,
    provider: "gmail",
    status: "queued",
    trigger_kind: "manual",
    classifier_mode: snapshot.classifierMode,
    settings_snapshot: snapshot,
    processed_count: 0,
    found_count: 0,
    error_code: "",
    created_at: new Date().toISOString(),
  }).select("*").single();
  if (error) {
    if (error.code === "23505") {
      return {
        status: 409,
        body: { error: "A mailbox scan is already queued or running" },
      };
    }
    console.error("mailbox scan queue failed", error.code);
    return { status: 500, body: { error: "Inbox scan could not be queued" } };
  }
  const { error: stateError } = await admin.from("mailbox_scan_state").insert({
    scan_run_id: run.id,
    owner,
    ledger_id: context.ledgerId,
    page_token: "",
    processed_count: 0,
    found_count: 0,
    checkpoint: {},
    expires_at: isoAfter(24 * 60 * 60 * 1_000),
    updated_at: new Date().toISOString(),
  });
  if (stateError) {
    await admin.from("mailbox_scan_runs").update({
      status: "failed",
      error_code: "scan_state_unavailable",
      error_message: "Scan checkpoint could not be created.",
      finished_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).eq("id", run.id).eq("owner", owner);
    console.error("mailbox scan state create failed", stateError.code);
    return {
      status: 500,
      body: { error: "Inbox scan checkpoint could not be created" },
    };
  }
  await audit(owner, context.ledgerId, "scan.requested", "queued", {
    runId: run.id,
    trigger: "manual",
  });
  return { status: 202, body: { run } };
}

function canonicalPreview(
  ledgerId: string,
  operation: MailboxOperation,
  items: Array<{
    findingId: string;
    messageRefId: string;
    providerMessageId: string;
    labels: string[];
    targetLabel: string;
  }>,
) {
  return JSON.stringify({
    version: 1,
    ledgerId,
    operation,
    items: [...items].sort((a, b) => a.findingId.localeCompare(b.findingId))
      .map((item) => ({
        findingId: item.findingId,
        messageRefId: item.messageRefId,
        providerMessageId: item.providerMessageId,
        labels: [...new Set(item.labels)].sort(),
        targetLabel: item.targetLabel,
      })),
  });
}

async function currentGmailState(
  accessToken: string,
  providerMessageId: string,
  inspectAttachments: boolean,
) {
  const query = inspectAttachments
    ? "format=metadata&metadataHeaders=Content-Type&metadataHeaders=Content-Disposition"
    : "format=minimal&fields=id%2ClabelIds";
  const payload = await gmailRequest(
    accessToken,
    `/gmail/v1/users/me/messages/${
      encodeURIComponent(providerMessageId)
    }?${query}`,
    {},
    6_000,
    64_000,
  );
  const labels = Array.isArray(payload.labelIds)
    ? [
      ...new Set(
        payload.labelIds.map((label) => safeText(label, 128)).filter(
          Boolean,
        ),
      ),
    ].sort()
    : [];
  return {
    labels,
    attachmentSafe: inspectAttachments
      ? gmailMetadataAttachmentState(payload as GmailMessage) === false
      : null,
  };
}

async function prepareAction(
  owner: string,
  context: MailboxContext,
  body: RequestBody,
) {
  if (!canModifyMailbox(context)) {
    return {
      status: 409,
      body: { error: "Upgrade Gmail permission before organizing mail" },
    };
  }
  if (
    await automationPaused(owner) ||
    await mailboxPaused(owner, context.ledgerId)
  ) {
    return {
      status: 409,
      body: {
        error: "Inbox Concierge is paused. Resume it before preparing cleanup.",
        mailboxPaused: true,
      },
    };
  }
  const ids = findingIds(body.findingIds);
  const operation = safeText(body.operation, 32) as MailboxOperation;
  if (!ids || !OPERATIONS.has(operation)) {
    return { status: 400, body: { error: "Invalid cleanup selection" } };
  }
  const leaseId = crypto.randomUUID();
  const { data: leaseClaimed, error: leaseError } = await admin.rpc(
    "claim_mailbox_operation",
    {
      p_ledger_id: context.ledgerId,
      p_owner: owner,
      p_lease_id: leaseId,
      p_operation: "plan",
      p_ttl_seconds: 90,
    },
  );
  if (leaseError || leaseClaimed !== true) {
    return {
      status: 409,
      body: {
        error:
          "This inbox is busy with another safe operation. Try again shortly.",
      },
    };
  }
  try {
    const { data: findings, error: findingsError } = await admin.from(
      "mailbox_findings",
    ).select(
      "id,owner,ledger_id,message_ref_id,category,protected_reasons,status",
    ).eq(
      "owner",
      owner,
    ).eq("ledger_id", context.ledgerId).in("id", ids).eq("status", "open");
    if (findingsError || !findings || findings.length !== ids.length) {
      return {
        status: 409,
        body: { error: "One or more findings are no longer available" },
      };
    }
    const rows = findings as FindingRow[];
    const refIds = [...new Set(rows.map((finding) => finding.message_ref_id))];
    const { data: refs, error: refsError } = await admin.from(
      "mailbox_message_refs",
    ).select(
      "id,owner,ledger_id,provider_message_id,provider_thread_id,current_labels,unsubscribe_kind,unsubscribe_target,unsubscribe_host",
    ).eq("owner", owner).eq("ledger_id", context.ledgerId).in("id", refIds);
    if (refsError || !refs || refs.length !== refIds.length) {
      return {
        status: 409,
        body: { error: "Mailbox references changed; run a fresh scan" },
      };
    }
    const refsById = new Map(
      (refs as RefRow[]).map((ref) => [ref.id, ref]),
    );
    let accessToken: string;
    try {
      accessToken = await gmailAccessToken(context);
    } catch {
      return {
        status: 409,
        body: {
          error:
            "Gmail could not be checked. Reconnect it before preparing cleanup.",
        },
      };
    }
    const liveStates = new Map<
      string,
      { labels: string[]; attachmentSafe: boolean | null }
    >();
    const refRows = refs as RefRow[];
    for (let index = 0; index < refRows.length; index += 10) {
      const batch = refRows.slice(index, index + 10);
      const results = await Promise.allSettled(
        batch.map((ref) =>
          currentGmailState(
            accessToken,
            ref.provider_message_id,
            operation === "trash",
          )
        ),
      );
      for (let offset = 0; offset < results.length; offset++) {
        const result = results[offset];
        if (result.status === "fulfilled") {
          liveStates.set(batch[offset].id, result.value);
        }
      }
    }
    if (!liveStates.size) {
      return {
        status: 409,
        body: {
          error:
            "None of the selected messages could be rechecked. Run a fresh scan.",
        },
      };
    }
    await Promise.all(
      [...liveStates].map(([refId, state]) =>
        admin.from("mailbox_message_refs").update({
          current_labels: state.labels,
          updated_at: new Date().toISOString(),
        }).eq("id", refId).eq("owner", owner).eq(
          "ledger_id",
          context.ledgerId,
        )
      ),
    );
    const included: Array<{
      finding: FindingRow;
      ref: RefRow;
      targetLabel: string;
    }> = [];
    let protectedExcluded = 0;
    const categoryCounts: Record<string, number> = {};
    for (const finding of rows) {
      const ref = refsById.get(finding.message_ref_id);
      const liveState = ref ? liveStates.get(ref.id) : null;
      if (!ref || !liveState) {
        protectedExcluded++;
        continue;
      }
      if (
        !["subscription", "account_creation", "receipt"].includes(
          finding.category,
        ) ||
        (Array.isArray(finding.protected_reasons) &&
          finding.protected_reasons.length)
      ) {
        protectedExcluded++;
        continue;
      }
      const labels = liveState.labels;
      ref.current_labels = labels;
      const protectedReasons = protectedForOperation(
        finding.category,
        labels,
        operation,
        operation === "trash" ? liveState.attachmentSafe : null,
      );
      if (protectedReasons.length) {
        protectedExcluded++;
        continue;
      }
      const targetLabel = operation === "trash"
        ? ""
        : labelNameForCategory(finding.category);
      included.push({ finding, ref, targetLabel });
      categoryCounts[finding.category] =
        (categoryCounts[finding.category] || 0) +
        1;
    }
    if (!included.length) {
      return {
        status: 409,
        body: {
          error: "Every selected message is protected from that action",
          protectedExcluded,
        },
      };
    }
    const previewItems = included.map(({ finding, ref, targetLabel }) => ({
      findingId: finding.id,
      messageRefId: ref.id,
      providerMessageId: ref.provider_message_id,
      labels: Array.isArray(ref.current_labels) ? ref.current_labels : [],
      targetLabel,
    }));
    const uniqueTargets = [
      ...new Set(previewItems.map((item) => item.targetLabel)),
    ];
    const planTargetLabel = operation === "trash"
      ? ""
      : uniqueTargets.length === 1
      ? uniqueTargets[0]
      : "MyPersonas/Organized";
    if (operation !== "trash" && uniqueTargets.length > 1) {
      for (const item of included) item.targetLabel = planTargetLabel;
      for (const item of previewItems) item.targetLabel = planTargetLabel;
    }
    const planHash = await sha256Hex(
      canonicalPreview(context.ledgerId, operation, previewItems),
    );
    const expiresAt = isoAfter(PREVIEW_TTL_MS);
    const { data: plan, error: planError } = await admin.from(
      "mailbox_action_plans",
    ).insert({
      owner,
      ledger_id: context.ledgerId,
      operation,
      target_label: planTargetLabel,
      status: "pending_approval",
      plan_hash: planHash,
      finding_ids: included.map(({ finding }) => finding.id),
      total_count: included.length,
      category_counts: categoryCounts,
      protected_excluded: protectedExcluded,
      expires_at: expiresAt,
      error_code: "",
      error_message: "",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).select("*").single();
    if (planError || !plan) {
      const queueError = mailboxQueueError(planError);
      if (queueError) return queueError;
      console.error("mailbox plan create failed", planError?.code);
      return {
        status: 500,
        body: { error: "Cleanup preview could not be built" },
      };
    }
    const itemRows = included.map(({ finding, ref, targetLabel }, ordinal) => ({
      plan_id: plan.id,
      owner,
      ledger_id: context.ledgerId,
      finding_id: finding.id,
      message_ref_id: ref.id,
      provider_message_id: ref.provider_message_id,
      provider_thread_id: ref.provider_thread_id,
      category: finding.category,
      ordinal: ordinal + 1,
      target_label: targetLabel,
      prior_labels: Array.isArray(ref.current_labels) ? ref.current_labels : [],
      applied_labels: [],
      status: "pending",
      error_code: "",
      error_message: "",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }));
    const { error: itemError } = await admin.from("mailbox_action_items")
      .insert(
        itemRows,
      );
    if (itemError) {
      await admin.from("mailbox_action_plans").delete().eq("id", plan.id).eq(
        "owner",
        owner,
      );
      console.error("mailbox plan items create failed", itemError.code);
      return {
        status: 500,
        body: { error: "Cleanup preview could not be saved" },
      };
    }
    await audit(owner, context.ledgerId, "action.prepared", "prepared", {
      planId: plan.id,
      operation,
      totalCount: included.length,
      protectedExcluded,
    });
    return {
      status: 200,
      body: {
        plan: {
          id: plan.id,
          operation,
          targetLabel: planTargetLabel,
          target_label: planTargetLabel,
          findingIds: included.map(({ finding }) => finding.id),
          finding_ids: included.map(({ finding }) => finding.id),
          planHash,
          plan_hash: planHash,
          totalCount: included.length,
          total_count: included.length,
          categoryCounts,
          category_counts: categoryCounts,
          protectedExcluded,
          protected_excluded: protectedExcluded,
          expiresAt,
          expires_at: expiresAt,
        },
      },
    };
  } finally {
    await admin.rpc("release_mailbox_operation", {
      p_ledger_id: context.ledgerId,
      p_owner: owner,
      p_lease_id: leaseId,
    });
  }
}

async function approveAction(
  owner: string,
  context: MailboxContext,
  planId: string,
  suppliedHash: string,
) {
  if (await automationPaused(owner)) {
    return {
      status: 409,
      body: {
        error:
          "All agent automation is paused. Resume it before approving cleanup.",
        globalPaused: true,
      },
    };
  }
  if (await mailboxPaused(owner, context.ledgerId)) {
    return {
      status: 409,
      body: {
        error:
          "Inbox Concierge is paused for this account. Resume it before approving cleanup.",
        mailboxPaused: true,
      },
    };
  }
  if (!canModifyMailbox(context)) {
    return {
      status: 409,
      body: { error: "Gmail cleanup permission is no longer available" },
    };
  }
  const { data: plan, error } = await admin.from("mailbox_action_plans")
    .select("*").eq("id", planId).eq("owner", owner).eq(
      "ledger_id",
      context.ledgerId,
    ).maybeSingle();
  if (error || !plan) {
    return { status: 404, body: { error: "Cleanup plan not found" } };
  }
  if (plan.status !== "pending_approval") {
    return {
      status: 409,
      body: { error: "Cleanup plan is not awaiting approval" },
    };
  }
  if (Date.parse(plan.expires_at || "") <= Date.now()) {
    await admin.from("mailbox_action_plans").update({
      status: "expired",
      updated_at: new Date().toISOString(),
    }).eq("id", plan.id).eq("owner", owner);
    return {
      status: 409,
      body: { error: "Cleanup preview expired; prepare it again" },
    };
  }
  if (
    !/^[0-9a-f]{64}$/i.test(suppliedHash) ||
    suppliedHash.toLowerCase() !== safeText(plan.plan_hash, 64).toLowerCase()
  ) {
    await audit(owner, context.ledgerId, "action.approval_rejected", "denied", {
      planId,
      reason: "preview_hash_mismatch",
    });
    return {
      status: 409,
      body: { error: "Cleanup preview no longer matches" },
    };
  }
  const now = new Date().toISOString();
  const { data: updated, error: updateError } = await admin.from(
    "mailbox_action_plans",
  ).update({
    status: "approved",
    approved_at: now,
    updated_at: now,
  }).eq("id", plan.id).eq("owner", owner).eq("status", "pending_approval")
    .select("*")
    .maybeSingle();
  if (updateError || !updated) {
    const queueError = mailboxQueueError(updateError);
    if (queueError) return queueError;
    return {
      status: 409,
      body: { error: "Cleanup plan changed before approval" },
    };
  }
  await audit(owner, context.ledgerId, "action.approved", "queued", {
    planId,
    operation: plan.operation,
    totalCount: plan.total_count,
  });
  return { status: 202, body: { plan: updated } };
}

async function cancelPreview(
  owner: string,
  context: MailboxContext,
  planId: string,
) {
  const { data: plan, error } = await admin.from("mailbox_action_plans")
    .select("id,status").eq("id", planId).eq("owner", owner).eq(
      "ledger_id",
      context.ledgerId,
    ).maybeSingle();
  if (error || !plan) {
    return { status: 404, body: { error: "Cleanup preview not found" } };
  }
  if (plan.status === "cancelled") {
    return { status: 200, body: { cancelled: true, planId } };
  }
  if (plan.status !== "pending_approval") {
    return {
      status: 409,
      body: {
        error:
          "This preview can no longer be cancelled because it was already approved or completed.",
      },
    };
  }
  const now = new Date().toISOString();
  const { data: cancelled, error: cancelError } = await admin.from(
    "mailbox_action_plans",
  ).update({
    status: "cancelled",
    completed_at: now,
    updated_at: now,
  }).eq("id", planId).eq("owner", owner).eq("ledger_id", context.ledgerId).eq(
    "status",
    "pending_approval",
  ).select("id").maybeSingle();
  if (cancelError) {
    return {
      status: 500,
      body: { error: "Cleanup preview could not be cancelled" },
    };
  }
  if (!cancelled) {
    const { data: current } = await admin.from("mailbox_action_plans")
      .select("status").eq("id", planId).eq("owner", owner).eq(
        "ledger_id",
        context.ledgerId,
      ).maybeSingle();
    if (current?.status === "cancelled") {
      return { status: 200, body: { cancelled: true, planId } };
    }
    return {
      status: 409,
      body: {
        error:
          "This preview changed before cancellation. Refresh its current status.",
      },
    };
  }
  await audit(
    owner,
    context.ledgerId,
    "action.preview_cancelled",
    "cancelled",
    { planId },
  );
  return { status: 200, body: { cancelled: true, planId } };
}

async function requestUndo(
  owner: string,
  context: MailboxContext,
  planId: string,
) {
  if (await automationPaused(owner)) {
    return {
      status: 409,
      body: {
        error:
          "All agent automation is paused. Resume it before requesting undo.",
        globalPaused: true,
      },
    };
  }
  if (await mailboxPaused(owner, context.ledgerId)) {
    return {
      status: 409,
      body: {
        error:
          "Inbox Concierge is paused for this account. Resume it before requesting undo.",
        mailboxPaused: true,
      },
    };
  }
  if (!canModifyMailbox(context)) {
    return {
      status: 409,
      body: { error: "Reconnect Gmail before undoing cleanup" },
    };
  }
  const { data: plan, error } = await admin.from("mailbox_action_plans")
    .select("*").eq("id", planId).eq("owner", owner).eq(
      "ledger_id",
      context.ledgerId,
    ).maybeSingle();
  if (error || !plan) {
    return { status: 404, body: { error: "Cleanup plan not found" } };
  }
  if (!["completed", "partial"].includes(plan.status)) {
    return {
      status: 409,
      body: { error: "This cleanup cannot be undone yet" },
    };
  }
  const deadline = Date.parse(plan.undo_expires_at || "");
  if (!Number.isFinite(deadline) || deadline <= Date.now()) {
    return {
      status: 409,
      body: {
        error:
          "The undo window has ended. Gmail controls how long Trash is retained.",
      },
    };
  }
  const { data: updated, error: updateError } = await admin.from(
    "mailbox_action_plans",
  ).update({
    undo_status: "requested",
    undo_requested_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq("id", plan.id).eq("owner", owner).in("status", ["completed", "partial"])
    .eq("undo_status", "available").select("*").maybeSingle();
  if (updateError || !updated) {
    const queueError = mailboxQueueError(updateError);
    if (queueError) return queueError;
    return {
      status: 409,
      body: { error: "Undo status changed; refresh and retry" },
    };
  }
  await audit(owner, context.ledgerId, "undo.requested", "queued", { planId });
  return { status: 202, body: { plan: updated } };
}

async function dismiss(owner: string, ids: string[]) {
  const { data: owned, error } = await admin.from("mailbox_findings").select(
    "id,ledger_id",
  ).eq("owner", owner).in("id", ids).eq("status", "open");
  if (error || !owned || owned.length !== ids.length) {
    return { status: 409, body: { error: "One or more findings changed" } };
  }
  const { data, error: updateError } = await admin.from("mailbox_findings")
    .update({ status: "dismissed", updated_at: new Date().toISOString() }).eq(
      "owner",
      owner,
    ).in("id", ids).eq("status", "open").select("id,ledger_id");
  if (updateError) {
    return { status: 500, body: { error: "Findings could not be dismissed" } };
  }
  const ledgers = [...new Set((owned || []).map((row) => row.ledger_id))];
  await Promise.all(
    ledgers.map((ledgerId) =>
      audit(owner, ledgerId, "finding.dismissed", "ok", {
        count: owned.filter((row) => row.ledger_id === ledgerId).length,
      })
    ),
  );
  return { status: 200, body: { dismissed: data?.length || 0 } };
}

async function unsubscribeTarget(owner: string, findingId: string) {
  const { data: finding, error } = await admin.from("mailbox_findings").select(
    "id,ledger_id,message_ref_id,category",
  ).eq("id", findingId).eq("owner", owner).maybeSingle();
  if (error || !finding) {
    return { status: 404, body: { error: "Finding not found" } };
  }
  if (finding.category !== "subscription") {
    return {
      status: 409,
      body: { error: "No subscription action is available" },
    };
  }
  const { data: ref, error: refError } = await admin.from(
    "mailbox_message_refs",
  ).select("unsubscribe_kind,unsubscribe_target,unsubscribe_host").eq(
    "id",
    finding.message_ref_id,
  ).eq("owner", owner).eq("ledger_id", finding.ledger_id).maybeSingle();
  if (refError || !ref) {
    return { status: 404, body: { error: "Unsubscribe link is unavailable" } };
  }
  const safe = safeUnsubscribeTarget(safeText(ref.unsubscribe_target, 2_048));
  if (!safe.kind || safe.kind !== ref.unsubscribe_kind) {
    return {
      status: 409,
      body: { error: "Unsubscribe link did not pass safety checks" },
    };
  }
  if (!await unsubscribeTargetNetworkSafe(safe.target)) {
    return {
      status: 409,
      body: {
        error:
          "Unsubscribe destination could not be verified as a public address",
      },
    };
  }
  await audit(
    owner,
    finding.ledger_id,
    "unsubscribe.target_requested",
    "offered",
    { findingId, kind: safe.kind, hostname: safe.hostname },
  );
  return {
    status: 200,
    body: { kind: safe.kind, url: safe.target, hostname: safe.hostname },
  };
}

serve(async (req) => {
  const origin = req.headers.get("Origin") || "";
  if (req.method === "OPTIONS") {
    return ALLOWED_ORIGINS.has(origin)
      ? new Response(null, { status: 204, headers: cors(origin) })
      : new Response(null, { status: 403 });
  }
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405, origin);
  }
  const declaredLength = Number(req.headers.get("Content-Length") || 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
    return json({ error: "Request is too large" }, 413, origin);
  }
  const user = await caller(req);
  if (!user) return json({ error: "Invalid or expired session" }, 401, origin);
  let body: RequestBody;
  try {
    const text = await req.text();
    if (new TextEncoder().encode(text).byteLength > MAX_REQUEST_BYTES) {
      return json({ error: "Request is too large" }, 413, origin);
    }
    body = asRecord(JSON.parse(text)) as RequestBody;
  } catch {
    return json({ error: "Invalid JSON request" }, 400, origin);
  }
  const action = safeText(body.action, 64);
  if (action === "dismiss") {
    const ids = findingIds(body.findingIds);
    if (!ids) return json({ error: "Invalid finding selection" }, 400, origin);
    const result = await dismiss(user.id, ids);
    return json(result.body, result.status, origin);
  }
  if (action === "unsubscribe-target") {
    if (!isUuid(body.findingId)) {
      return json({ error: "Invalid finding" }, 400, origin);
    }
    const result = await unsubscribeTarget(user.id, body.findingId);
    return json(result.body, result.status, origin);
  }
  if (!isUuid(body.ledgerId)) {
    return json({ error: "Valid Gmail account is required" }, 400, origin);
  }
  const context = await ownedMailboxContext(body.ledgerId, user.id);
  if (!context) {
    return json({ error: "Owned Gmail account not found" }, 404, origin);
  }
  let result: { status: number; body: Record<string, unknown> };
  if (action === "dashboard") {
    result = await dashboard(user.id, context.ledgerId);
  } else if (action === "save-settings") {
    result = await saveSettings(user.id, context, body);
  } else if (action === "request-scan") {
    result = await requestScan(user.id, context);
  } else if (action === "prepare-action") {
    result = await prepareAction(user.id, context, body);
  } else if (action === "approve-action") {
    if (!isUuid(body.planId)) {
      return json({ error: "Invalid cleanup plan" }, 400, origin);
    }
    result = await approveAction(
      user.id,
      context,
      body.planId,
      safeText(body.planHash, 64),
    );
  } else if (action === "cancel-preview") {
    if (!isUuid(body.planId)) {
      return json({ error: "Invalid cleanup preview" }, 400, origin);
    }
    result = await cancelPreview(user.id, context, body.planId);
  } else if (action === "request-undo") {
    if (!isUuid(body.planId)) {
      return json({ error: "Invalid cleanup plan" }, 400, origin);
    }
    result = await requestUndo(user.id, context, body.planId);
  } else {
    result = { status: 400, body: { error: "Unsupported mailbox action" } };
  }
  return json(result.body, result.status, origin);
});
