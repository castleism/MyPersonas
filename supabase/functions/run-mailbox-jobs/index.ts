// run-mailbox-jobs — bounded Gmail scan, approved cleanup, and undo worker.
//
// Deploy without gateway JWT verification. Calls require X-Cron-Secret.
// Scans read headers, subjects, and bounded preview snippets but never full
// bodies or attachments, and scans never mutate Gmail. Cleanup runs only after an
// owner-approved, 24-hour preview; undo restores only labels MyPersonas changed.
// Deploy: supabase functions deploy run-mailbox-jobs --no-verify-jwt
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import {
  accountBillingAccess,
  type AccountEntitlementResult,
} from "../_shared/account-entitlement.ts";
import { runMailboxProviderBoundary } from "../_shared/mailbox-provider-boundary.ts";
import {
  admin,
  asRecord,
  canModifyMailbox,
  canReadMailbox,
  Classification,
  classifyMessage,
  FindingCategory,
  gmailAccessToken,
  GmailMessage,
  gmailMetadataAttachmentState,
  gmailRequest,
  integerInRange,
  isUuid,
  labelNameForCategory,
  MailboxAiBudgetFatalError,
  mailboxAiClassify,
  MailboxOperation,
  normalizeGmailMessage,
  ownedMailboxContext,
  protectedForOperation,
  safeText,
  sha256Hex,
} from "../_shared/mailbox.ts";

const CRON_SECRET = Deno.env.get("CRON_SECRET") || "";
const RUN_BUDGET_MS = 80_000;
const MAX_DUE_SETTINGS = 50;
const MAX_LOOKBACK_DAYS = 36_500;
const MAX_SCAN_MESSAGES = 15_000;
// At one bounded page per minute, 40 messages can cover 15,000 messages in
// about 6.25 hours before retries while leaving ample room inside the 80s Edge
// budget for Gmail metadata requests and owner-bound database writes.
const MAX_SCAN_MESSAGES_PER_INVOCATION = 40;
const MAX_ACTION_ITEMS_PER_INVOCATION = 16;
const LEASE_SECONDS = 120;
const SCAN_STATE_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const METADATA_HEADERS = [
  "From",
  "Subject",
  "Date",
  "Message-ID",
  "List-Unsubscribe",
  "List-Unsubscribe-Post",
  "List-ID",
  "Precedence",
  "Auto-Submitted",
  "Content-Type",
  "Content-Disposition",
];

type SettingsSnapshot = {
  includeSpamTrash: boolean;
  lookbackDays: number;
  maxMessages: number;
  classifierMode: string;
  aiBackendId: string | null;
  aiConsent: boolean;
};

type ScanRun = {
  id: string;
  owner: string;
  ledger_id: string;
  status: string;
  classifier_mode: string;
  settings_snapshot: Record<string, unknown>;
  processed_count: number;
  found_count: number;
  category_counts: Record<string, number> | null;
};

type ActionPlan = {
  id: string;
  owner: string;
  ledger_id: string;
  operation: MailboxOperation;
  status: string;
  undo_status: string;
  plan_hash: string;
  expires_at: string;
  undo_expires_at: string | null;
  total_count: number;
  error_code?: string;
};

type ActionItem = {
  id: string;
  owner: string;
  ledger_id: string;
  plan_id: string;
  finding_id: string;
  message_ref_id: string;
  provider_message_id: string;
  provider_thread_id: string;
  category: FindingCategory;
  prior_labels: string[];
  target_label: string;
  applied_labels: string[];
  status: string;
  ordinal: number;
};

function nowIso() {
  return new Date().toISOString();
}

function isoAfter(milliseconds: number) {
  return new Date(Date.now() + milliseconds).toISOString();
}

function sortedLabels(value: unknown) {
  return Array.isArray(value)
    ? [...new Set(value.map((label) => safeText(label, 128)).filter(Boolean))]
      .sort()
    : [];
}

function sameLabels(left: unknown, right: unknown) {
  return JSON.stringify(sortedLabels(left)) ===
    JSON.stringify(sortedLabels(right));
}

type RunnableCandidateRpc =
  | "next_runnable_mailbox_scan_id"
  | "next_runnable_mailbox_plan_id"
  | "next_runnable_mailbox_undo_id";

async function nextRunnableId(rpcName: RunnableCandidateRpc) {
  const { data, error } = await admin.rpc(rpcName);
  if (error) {
    console.error(
      "mailbox runnable candidate query failed",
      rpcName,
      error.code,
    );
    return null;
  }
  return isUuid(data) ? data : null;
}

async function globallyPaused(owner: string) {
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

async function audit(
  owner: string,
  ledgerId: string,
  eventType: string,
  status: "info" | "succeeded" | "partial" | "failed" | "cancelled",
  summary: string,
  counts: Record<string, number> = {},
  scanRunId: string | null = null,
  actionPlanId: string | null = null,
) {
  const sanitizedCounts = Object.fromEntries(
    Object.entries(counts).filter(([, value]) =>
      Number.isFinite(value) && value >= 0
    ).map(([key, value]) => [safeText(key, 64), Math.trunc(value)]),
  );
  const { error } = await admin.from("mailbox_audit_events").insert({
    owner,
    ledger_id: ledgerId,
    scan_run_id: scanRunId,
    action_plan_id: actionPlanId,
    event_type: safeText(
      eventType.toLowerCase().replace(/[^a-z0-9_]+/g, "_"),
      80,
    ),
    status,
    summary: safeText(summary, 240),
    counts: sanitizedCounts,
    created_at: nowIso(),
  });
  if (error) console.error("mailbox worker audit failed", error.code);
}

async function claim(
  owner: string,
  ledgerId: string,
  kind: "scan" | "apply" | "undo",
) {
  const leaseId = crypto.randomUUID();
  const { data, error } = await admin.rpc("claim_mailbox_operation", {
    p_ledger_id: ledgerId,
    p_owner: owner,
    p_lease_id: leaseId,
    p_operation: kind,
    p_ttl_seconds: LEASE_SECONDS,
  });
  return { claimed: !error && data === true, leaseId };
}

async function release(owner: string, ledgerId: string, leaseId: string) {
  await admin.rpc("release_mailbox_operation", {
    p_ledger_id: ledgerId,
    p_owner: owner,
    p_lease_id: leaseId,
  });
}

function settingsSnapshot(value: unknown): SettingsSnapshot {
  const record = asRecord(value);
  return {
    includeSpamTrash: record.includeSpamTrash === true,
    lookbackDays: integerInRange(
      record.lookbackDays,
      90,
      1,
      MAX_LOOKBACK_DAYS,
    ),
    maxMessages: integerInRange(
      record.maxMessages,
      500,
      25,
      MAX_SCAN_MESSAGES,
    ),
    classifierMode: safeText(record.classifierMode, 16) === "ai"
      ? "ai"
      : "rules",
    aiBackendId: isUuid(record.aiBackendId) ? record.aiBackendId : null,
    aiConsent: record.aiConsent === true,
  };
}

function nextScheduledAt(cadence: string) {
  const hours = cadence === "weekly" ? 24 * 7 : 24;
  return isoAfter(hours * 60 * 60 * 1_000);
}

async function enqueueDueScans() {
  const { data: due, error } = await admin.from("mailbox_settings").select("*")
    .eq("paused", false).in("schedule_cadence", ["daily", "weekly"])
    .lte("next_scan_at", nowIso()).order("next_scan_at", { ascending: true })
    .limit(MAX_DUE_SETTINGS);
  if (error) {
    console.error("mailbox due settings query failed", error.code);
    return 0;
  }
  let queued = 0;
  for (const setting of due || []) {
    const cadence = safeText(setting.schedule_cadence, 16);
    const nextScanAt = nextScheduledAt(cadence);
    if (await globallyPaused(setting.owner)) {
      await admin.from("mailbox_settings").update({
        next_scan_at: isoAfter(60 * 60 * 1_000),
        updated_at: nowIso(),
      }).eq("ledger_id", setting.ledger_id).eq("owner", setting.owner);
      continue;
    }
    if (setting.classifier_mode === "ai") {
      const entitlement = await accountBillingAccess(admin, setting.owner);
      if (!entitlement.allowed) {
        await admin.from("mailbox_settings").update({
          next_scan_at: entitlement.unavailable
            ? isoAfter(60 * 60 * 1_000)
            : nextScanAt,
          updated_at: nowIso(),
        }).eq("ledger_id", setting.ledger_id).eq("owner", setting.owner);
        await audit(
          setting.owner,
          setting.ledger_id,
          "scan.schedule_skipped_billing",
          entitlement.unavailable ? "failed" : "info",
          entitlement.unavailable
            ? "Membership verification was unavailable; no AI inbox scan was queued."
            : "This scheduled AI inbox scan was skipped because membership is inactive.",
        );
        continue;
      }
    }
    const context = await ownedMailboxContext(setting.ledger_id, setting.owner);
    if (!context || !canReadMailbox(context)) {
      await admin.from("mailbox_settings").update({
        paused: true,
        next_scan_at: null,
        updated_at: nowIso(),
      }).eq("ledger_id", setting.ledger_id).eq("owner", setting.owner);
      await audit(
        setting.owner,
        setting.ledger_id,
        "scan.schedule_paused",
        "failed",
        "Scheduled inbox scans paused because Gmail access is unavailable.",
      );
      continue;
    }
    const snapshot: SettingsSnapshot = {
      includeSpamTrash: setting.include_spam_trash === true,
      lookbackDays: integerInRange(
        setting.lookback_days,
        90,
        1,
        MAX_LOOKBACK_DAYS,
      ),
      maxMessages: integerInRange(
        setting.max_messages,
        500,
        25,
        MAX_SCAN_MESSAGES,
      ),
      classifierMode: setting.classifier_mode === "ai" ? "ai" : "rules",
      aiBackendId: isUuid(setting.ai_backend_id) ? setting.ai_backend_id : null,
      aiConsent: setting.ai_consent === true,
    };
    const { data: run, error: insertError } = await admin.from(
      "mailbox_scan_runs",
    ).insert({
      owner: setting.owner,
      ledger_id: setting.ledger_id,
      provider: "gmail",
      trigger_kind: "scheduled",
      status: "queued",
      classifier_mode: snapshot.classifierMode,
      settings_snapshot: snapshot,
      processed_count: 0,
      found_count: 0,
      category_counts: {},
      error_code: "",
      error_message: "",
      created_at: nowIso(),
      updated_at: nowIso(),
    }).select("id").single();
    if (insertError || !run) {
      if (insertError?.code === "23505") {
        // The unique active-run constraint handles concurrent cron deliveries.
        await admin.from("mailbox_settings").update({
          next_scan_at: nextScanAt,
          updated_at: nowIso(),
        }).eq("ledger_id", setting.ledger_id).eq("owner", setting.owner);
      } else {
        await audit(
          setting.owner,
          setting.ledger_id,
          "scan_schedule_failed",
          "failed",
          "Scheduled inbox scan could not be queued and will be retried.",
        );
      }
      continue;
    }
    const stateResult = await admin.from("mailbox_scan_state").insert({
      scan_run_id: run.id,
      owner: setting.owner,
      ledger_id: setting.ledger_id,
      page_token: "",
      processed_count: 0,
      found_count: 0,
      checkpoint: { categoryCounts: {} },
      expires_at: isoAfter(SCAN_STATE_TTL_MS),
      updated_at: nowIso(),
    });
    if (stateResult.error) {
      await admin.from("mailbox_scan_runs").update({
        status: "failed",
        error_code: "scan_state_unavailable",
        error_message: "Scan checkpoint could not be created.",
        finished_at: nowIso(),
        updated_at: nowIso(),
      }).eq("id", run.id).eq("owner", setting.owner);
      continue;
    }
    await admin.from("mailbox_settings").update({
      next_scan_at: nextScanAt,
      updated_at: nowIso(),
    }).eq("ledger_id", setting.ledger_id).eq("owner", setting.owner);
    queued++;
    await audit(
      setting.owner,
      setting.ledger_id,
      "scan.scheduled",
      "info",
      "A scheduled headers-and-preview inbox scan was queued; it will not read full bodies or attachments.",
      {},
      run.id,
    );
  }
  return queued;
}

function suggestedAction(
  classification: Classification,
  hasUnsubscribe: boolean,
) {
  if (
    classification.protectedReasons.length ||
    classification.category === "order_travel"
  ) return "review";
  if (classification.category === "subscription") {
    return hasUnsubscribe ? "review" : "label_archive";
  }
  if (
    ["account_creation", "receipt"].includes(classification.category)
  ) return "label_archive";
  if (classification.category === "other") return "review";
  return "label";
}

async function gmailMetadata(accessToken: string, messageId: string) {
  const params = new URLSearchParams({ format: "metadata" });
  for (const header of METADATA_HEADERS) {
    params.append("metadataHeaders", header);
  }
  return await gmailRequest(
    accessToken,
    `/gmail/v1/users/me/messages/${
      encodeURIComponent(messageId)
    }?${params.toString()}`,
    {},
    15_000,
    512_000,
  ) as GmailMessage;
}

async function persistScannedMessage(
  run: ScanRun,
  message: ReturnType<typeof normalizeGmailMessage>,
  classification: Classification,
) {
  if (!message.providerMessageId) return false;
  const rfcHash = message.rfcMessageId
    ? await sha256Hex(message.rfcMessageId)
    : "";
  const { data: ref, error: refError } = await admin.from(
    "mailbox_message_refs",
  ).upsert({
    owner: run.owner,
    ledger_id: run.ledger_id,
    scan_run_id: run.id,
    provider_message_id: message.providerMessageId,
    provider_thread_id: message.providerThreadId,
    rfc_message_id_hash: rfcHash,
    current_labels: message.labels,
    unsubscribe_kind: message.unsubscribeKind || "none",
    unsubscribe_target: message.unsubscribeTarget,
    unsubscribe_host: message.unsubscribeHost,
    provider_internal_at: message.receivedAt,
    updated_at: nowIso(),
  }, { onConflict: "ledger_id,provider_message_id" }).select("id").single();
  if (refError || !ref) {
    console.error("mailbox message ref save failed", refError?.code);
    return false;
  }
  const { data: existing } = await admin.from("mailbox_findings").select(
    "id,status",
  ).eq("owner", run.owner).eq("ledger_id", run.ledger_id).eq(
    "message_ref_id",
    ref.id,
  ).maybeSingle();
  const findingValues = {
    owner: run.owner,
    ledger_id: run.ledger_id,
    scan_run_id: run.id,
    message_ref_id: ref.id,
    category: classification.category,
    sender_name: message.senderName,
    sender_address: message.senderEmail,
    sender_domain: message.senderDomain,
    subject: message.subject,
    snippet: message.snippet,
    received_at: message.receivedAt,
    confidence: classification.confidence,
    evidence: classification.evidence,
    protected_reasons: classification.protectedReasons,
    suggested_action: suggestedAction(
      classification,
      Boolean(message.unsubscribeKind),
    ),
    unsubscribe_available: Boolean(message.unsubscribeKind),
    status: existing?.status || "open",
    updated_at: nowIso(),
  };
  const findingResult = existing
    ? await admin.from("mailbox_findings").update(findingValues).eq(
      "id",
      existing.id,
    ).eq("owner", run.owner)
    : await admin.from("mailbox_findings").insert(findingValues);
  if (findingResult.error) {
    console.error("mailbox finding save failed", findingResult.error.code);
    return false;
  }
  return true;
}

async function failScan(
  run: ScanRun,
  code: string,
  message: string,
  counts: Record<string, number> = {},
  progress: {
    processed: number;
    found: number;
    categoryCounts: Record<string, unknown>;
  } | null = null,
) {
  const processed = progress
    ? integerInRange(
      progress.processed,
      run.processed_count,
      0,
      MAX_SCAN_MESSAGES,
    )
    : integerInRange(run.processed_count, 0, 0, MAX_SCAN_MESSAGES);
  const found = progress
    ? integerInRange(progress.found, run.found_count, 0, MAX_SCAN_MESSAGES)
    : integerInRange(run.found_count, 0, 0, MAX_SCAN_MESSAGES);
  const terminal = await admin.from("mailbox_scan_runs").update({
    status: "failed",
    processed_count: processed,
    found_count: found,
    ...(progress ? { category_counts: progress.categoryCounts } : {}),
    error_code: safeText(code, 80),
    error_message: safeText(message, 300),
    finished_at: nowIso(),
    updated_at: nowIso(),
  }).eq("id", run.id).eq("owner", run.owner);
  if (terminal.error) return;
  await admin.from("mailbox_scan_state").delete().eq("scan_run_id", run.id).eq(
    "owner",
    run.owner,
  );
  await audit(
    run.owner,
    run.ledger_id,
    "scan.failed",
    "failed",
    `Inbox scan stopped incomplete without changing Gmail: ${
      safeText(message, 160)
    }`,
    { ...counts, processed, savedFindings: found },
    run.id,
  );
}

async function failScanForBilling(
  run: ScanRun,
  entitlement: AccountEntitlementResult,
  phase: "initial" | "credential" | "listing" | "metadata" | "persistence",
) {
  const detail = phase === "initial"
    ? "No Gmail credential, metadata, or AI provider was contacted."
    : phase === "credential"
    ? "No Gmail credential was resolved or refreshed."
    : phase === "listing"
    ? "No Gmail message listing or metadata request followed the membership check."
    : phase === "metadata"
    ? "No additional Gmail metadata batch was requested, and no findings from this Gmail page were saved."
    : "No findings from this Gmail page were saved.";
  await failScan(
    run,
    entitlement.unavailable
      ? "billing_verification_unavailable"
      : "billing_membership_inactive",
    `${
      entitlement.unavailable
        ? "Membership verification became unavailable."
        : "Membership became inactive."
    } ${detail}`,
  );
}

async function processOneScan(startedAt: number) {
  const candidateId = await nextRunnableId("next_runnable_mailbox_scan_id");
  if (!candidateId) return false;
  const { data, error } = await admin.from("mailbox_scan_runs").select("*")
    .eq("id", candidateId).in("status", ["queued", "running"]).maybeSingle();
  if (error || !data) return false;
  const run = data as ScanRun;
  // Pause may change after SQL selected the candidate. Recheck immediately
  // before the lease so an emergency stop always wins the race.
  if (
    await globallyPaused(run.owner) ||
    await mailboxPaused(run.owner, run.ledger_id)
  ) return false;
  const lease = await claim(run.owner, run.ledger_id, "scan");
  if (!lease.claimed) return false;
  try {
    if (Date.now() - startedAt > RUN_BUDGET_MS - 20_000) return false;
    const snapshot = settingsSnapshot(run.settings_snapshot);
    if (snapshot.classifierMode === "ai") {
      const initialEntitlement = await accountBillingAccess(admin, run.owner);
      if (!initialEntitlement.allowed) {
        await failScanForBilling(run, initialEntitlement, "initial");
        return true;
      }
    }
    const context = await ownedMailboxContext(run.ledger_id, run.owner);
    if (!context || !canReadMailbox(context)) {
      await failScan(
        run,
        "gmail_read_access_missing",
        "Gmail read access is unavailable.",
      );
      return true;
    }
    if (run.status === "queued") {
      const { data: started, error: startError } = await admin.from(
        "mailbox_scan_runs",
      ).update({
        status: "running",
        started_at: nowIso(),
        updated_at: nowIso(),
      }).eq("id", run.id).eq("owner", run.owner).eq("status", "queued")
        .select("id").maybeSingle();
      if (startError || !started) return false;
    }
    const { data: state, error: stateError } = await admin.from(
      "mailbox_scan_state",
    ).select("*").eq("scan_run_id", run.id).eq("owner", run.owner)
      .maybeSingle();
    if (stateError || !state) {
      await failScan(run, "scan_state_missing", "Scan checkpoint is missing.");
      return true;
    }
    if (Date.parse(state.expires_at || "") <= Date.now()) {
      await failScan(run, "scan_expired", "Scan checkpoint expired.");
      return true;
    }
    const processedBefore = integerInRange(
      state.processed_count,
      0,
      0,
      MAX_SCAN_MESSAGES,
    );
    const remaining = snapshot.maxMessages - processedBefore;
    if (remaining <= 0) {
      await completeScan(run, state, asRecord(state.checkpoint));
      return true;
    }
    let accessToken: string;
    try {
      const tokenBoundary = await runMailboxProviderBoundary(
        admin,
        run.owner,
        snapshot.classifierMode === "ai",
        () => gmailAccessToken(context),
      );
      if (!tokenBoundary.allowed) {
        await failScanForBilling(run, tokenBoundary, "credential");
        return true;
      }
      accessToken = tokenBoundary.value;
    } catch (tokenError) {
      await failScan(
        run,
        tokenError instanceof Error ? tokenError.message : "gmail_token_failed",
        "Gmail authorization could not be refreshed.",
      );
      return true;
    }
    const params = new URLSearchParams({
      maxResults: String(
        Math.min(MAX_SCAN_MESSAGES_PER_INVOCATION, remaining),
      ),
      includeSpamTrash: snapshot.includeSpamTrash ? "true" : "false",
      q: `newer_than:${snapshot.lookbackDays}d`,
    });
    if (safeText(state.page_token, 2_048)) {
      params.set("pageToken", safeText(state.page_token, 2_048));
    }
    let page: Record<string, unknown>;
    try {
      const listingBoundary = await runMailboxProviderBoundary(
        admin,
        run.owner,
        snapshot.classifierMode === "ai",
        () =>
          gmailRequest(
            accessToken,
            `/gmail/v1/users/me/messages?${params.toString()}`,
          ),
      );
      if (!listingBoundary.allowed) {
        await failScanForBilling(run, listingBoundary, "listing");
        return true;
      }
      page = listingBoundary.value;
    } catch (gmailError) {
      await failScan(
        run,
        gmailError instanceof Error ? gmailError.message : "gmail_list_failed",
        "Gmail could not provide the next metadata page.",
      );
      return true;
    }
    const candidates = Array.isArray(page.messages)
      ? (page.messages as Record<string, unknown>[]).map((entry) =>
        safeText(entry.id, 256)
      ).filter(Boolean)
      : [];
    const fetched: GmailMessage[] = [];
    let inspectedCandidates = 0;
    for (let index = 0; index < candidates.length; index += 5) {
      if (Date.now() - startedAt > RUN_BUDGET_MS - 12_000) {
        // Do not advance the Gmail page token until every result on the page
        // has either been read or confirmed deleted.
        return true;
      }
      const metadataBoundary = await runMailboxProviderBoundary(
        admin,
        run.owner,
        snapshot.classifierMode === "ai",
        () =>
          Promise.allSettled(
            candidates.slice(index, index + 5).map((id) =>
              gmailMetadata(accessToken, id)
            ),
          ),
      );
      if (!metadataBoundary.allowed) {
        await failScanForBilling(run, metadataBoundary, "metadata");
        return true;
      }
      const batch = metadataBoundary.value;
      for (const result of batch) {
        inspectedCandidates++;
        if (result.status === "fulfilled") {
          fetched.push(result.value);
          continue;
        }
        const code = result.reason instanceof Error
          ? result.reason.message
          : "gmail_metadata_failed";
        if (code === "gmail_message_missing") continue;
        await failScan(
          run,
          safeText(code, 80),
          "Gmail metadata could not be read completely.",
        );
        return true;
      }
    }
    if (inspectedCandidates !== candidates.length) return true;
    const normalized = fetched.map(normalizeGmailMessage);
    const classifications = normalized.map(classifyMessage);
    let aiUsed = 0;
    let aiFallback = 0;
    if (
      snapshot.classifierMode === "ai" && snapshot.aiConsent &&
      snapshot.aiBackendId
    ) {
      const ambiguous = classifications.map((classification, index) => ({
        classification,
        index,
      })).filter(({ classification }) => classification.confidence < 0.75)
        .slice(0, 12);
      if (ambiguous.length) {
        const { data: liveConsent } = await admin.from("mailbox_settings")
          .select(
            "classifier_mode,ai_backend_id,ai_consent,ai_consent_at,paused",
          ).eq("owner", run.owner).eq("ledger_id", run.ledger_id)
          .maybeSingle();
        const consentStillValid = liveConsent?.paused === false &&
          liveConsent.classifier_mode === "ai" &&
          liveConsent.ai_consent === true &&
          Boolean(liveConsent.ai_consent_at) &&
          liveConsent.ai_backend_id === snapshot.aiBackendId;
        const { data: backend } = consentStillValid
          ? await admin.from("ai_backends").select("*")
            .eq("id", snapshot.aiBackendId).eq("owner", run.owner).maybeSingle()
          : { data: null };
        if (backend && consentStillValid) {
          const inputs = ambiguous.map(({ index }, keyIndex) => ({
            key: `item_${keyIndex}`,
            subject: normalized[index].subject,
            snippet: normalized[index].snippet,
          }));
          let ai: Map<string, FindingCategory>;
          try {
            ai = await mailboxAiClassify(backend, run.owner, inputs);
          } catch (error) {
            if (!(error instanceof MailboxAiBudgetFatalError)) throw error;
            await failScan(
              run,
              error.code,
              error.code === "budget_reconciliation_required"
                ? "AI classification may have reached the provider, but budget accounting could not be reconciled. No findings from this Gmail page were saved."
                : error.code === "budget_claim_unavailable"
                ? "AI budget enforcement was unavailable, so no provider request was sent and no findings from this Gmail page were saved."
                : "Membership changed before AI classification. No provider request or findings persistence continued.",
            );
            return true;
          }
          aiUsed = ai.size;
          aiFallback = Math.max(0, ambiguous.length - aiUsed);
          ambiguous.forEach(({ index }, keyIndex) => {
            const category = ai.get(`item_${keyIndex}`);
            if (!category) return;
            classifications[index] = {
              category,
              confidence: 0.74,
              evidence: [
                ...classifications[index].evidence,
                "AI-assisted metadata classification",
              ].slice(0, 6),
              protectedReasons: [
                ...classifications[index].protectedReasons.filter((reason) =>
                  !reason.startsWith("protected_category:") &&
                  reason !== "uncertain_category"
                ),
                ...(["security", "financial_legal_medical", "personal"]
                    .includes(
                      category,
                    )
                  ? [`protected_category:${category}`]
                  : []),
              ],
            };
          });
        } else {
          aiFallback = ambiguous.length;
        }
      }
    }
    if (snapshot.classifierMode === "ai") {
      const persistenceEntitlement = await accountBillingAccess(
        admin,
        run.owner,
      );
      if (!persistenceEntitlement.allowed) {
        await failScanForBilling(run, persistenceEntitlement, "persistence");
        return true;
      }
    }
    let saved = 0;
    const checkpoint = asRecord(state.checkpoint);
    const categoryCounts = asRecord(checkpoint.categoryCounts);
    categoryCounts.ai_used = integerInRange(
      categoryCounts.ai_used,
      0,
      0,
      1_000_000,
    ) + aiUsed;
    categoryCounts.ai_fallback = integerInRange(
      categoryCounts.ai_fallback,
      0,
      0,
      1_000_000,
    ) + aiFallback;
    for (let index = 0; index < normalized.length; index++) {
      const persisted = await persistScannedMessage(
        run,
        normalized[index],
        classifications[index],
      );
      if (!persisted) {
        await failScan(
          run,
          "scan_persistence_failed",
          "A report record could not be saved, so this Gmail page was not marked complete. Start a new scan after checking the service.",
          {
            pageCandidates: candidates.length,
            pageSavedBeforeFailure: saved,
            persistenceFailures: 1,
          },
          {
            processed: processedBefore + candidates.length,
            found: integerInRange(
              state.found_count,
              0,
              0,
              MAX_SCAN_MESSAGES,
            ) + saved,
            categoryCounts,
          },
        );
        return true;
      }
      saved++;
      const category = classifications[index].category;
      categoryCounts[category] = integerInRange(
        categoryCounts[category],
        0,
        0,
        1_000_000,
      ) + 1;
    }
    const processed = processedBefore + candidates.length;
    const found = integerInRange(
      state.found_count,
      0,
      0,
      MAX_SCAN_MESSAGES,
    ) + saved;
    const nextPageToken = safeText(page.nextPageToken, 2_048);
    const completed = !nextPageToken || processed >= snapshot.maxMessages;
    categoryCounts.scan_cap_reached =
      nextPageToken && processed >= snapshot.maxMessages ? 1 : 0;
    const stateProgress = await admin.from("mailbox_scan_state").update({
      page_token: completed ? "" : nextPageToken,
      processed_count: processed,
      found_count: found,
      checkpoint: { categoryCounts },
      expires_at: isoAfter(SCAN_STATE_TTL_MS),
      updated_at: nowIso(),
    }).eq("scan_run_id", run.id).eq("owner", run.owner);
    if (stateProgress.error) {
      await failScan(
        run,
        "scan_checkpoint_save_failed",
        "The report page was saved, but its checkpoint was not; the scan stopped incomplete.",
        {
          pageCandidates: candidates.length,
          pageSavedBeforeFailure: saved,
          persistenceFailures: 1,
        },
        { processed, found, categoryCounts },
      );
      return true;
    }
    const runProgress = await admin.from("mailbox_scan_runs").update({
      processed_count: processed,
      found_count: found,
      category_counts: categoryCounts,
      updated_at: nowIso(),
    }).eq("id", run.id).eq("owner", run.owner);
    if (runProgress.error) {
      await failScan(
        run,
        "scan_progress_save_failed",
        "The report page was saved, but its visible progress could not be recorded; the scan stopped incomplete.",
        {
          pageCandidates: candidates.length,
          pageSavedBeforeFailure: saved,
          persistenceFailures: 1,
        },
        { processed, found, categoryCounts },
      );
      return true;
    }
    if (completed) {
      await completeScan(
        { ...run, processed_count: processed, found_count: found },
        { ...state, processed_count: processed, found_count: found },
        { categoryCounts },
      );
    }
    if (aiFallback > 0) {
      await audit(
        run.owner,
        run.ledger_id,
        "scan_ai_fallback",
        "partial",
        "Some ambiguous messages used rule-based classification because the assigned AI was unavailable or consent changed.",
        { aiUsed, aiFallback },
        run.id,
      );
    }
    return true;
  } finally {
    await release(run.owner, run.ledger_id, lease.leaseId);
  }
}

async function completeScan(
  run: ScanRun,
  state: Record<string, unknown>,
  checkpoint: Record<string, unknown>,
) {
  const completedAt = nowIso();
  const processed = integerInRange(
    state.processed_count,
    run.processed_count,
    0,
    MAX_SCAN_MESSAGES,
  );
  const found = integerInRange(
    state.found_count,
    run.found_count,
    0,
    MAX_SCAN_MESSAGES,
  );
  const categoryCounts = asRecord(checkpoint.categoryCounts);
  const aiUsed = integerInRange(categoryCounts.ai_used, 0, 0, 1_000_000);
  const aiFallback = integerInRange(
    categoryCounts.ai_fallback,
    0,
    0,
    1_000_000,
  );
  const capReached = integerInRange(
    categoryCounts.scan_cap_reached,
    0,
    0,
    1,
  ) === 1;
  const terminal = await admin.from("mailbox_scan_runs").update({
    status: "completed",
    processed_count: processed,
    found_count: found,
    category_counts: categoryCounts,
    error_code: "",
    error_message: "",
    finished_at: completedAt,
    updated_at: completedAt,
  }).eq("id", run.id).eq("owner", run.owner);
  if (terminal.error) return;
  await admin.from("mailbox_scan_state").delete().eq("scan_run_id", run.id).eq(
    "owner",
    run.owner,
  );
  const settingsUpdate = await admin.from("mailbox_settings").update({
    last_scan_at: completedAt,
    last_successful_scan_at: completedAt,
    updated_at: completedAt,
  }).eq("ledger_id", run.ledger_id).eq("owner", run.owner);
  if (settingsUpdate.error) {
    await audit(
      run.owner,
      run.ledger_id,
      "scan_summary_update_failed",
      "partial",
      "Inbox scan completed, but its latest-scan timestamp could not be updated.",
      { processed, findings: found },
      run.id,
    );
  }
  await audit(
    run.owner,
    run.ledger_id,
    "scan.completed",
    "succeeded",
    capReached
      ? "Inbox scan reached its saved message limit; older matching mail remains. No email was changed."
      : "Inbox headers, subjects, and preview snippets were scanned; no full bodies or attachments were read and no email was changed.",
    {
      processed,
      findings: found,
      aiUsed,
      aiFallback,
      capReached: capReached ? 1 : 0,
    },
    run.id,
  );
}

function canonicalPlan(plan: ActionPlan, items: ActionItem[]) {
  return JSON.stringify({
    version: 1,
    ledgerId: plan.ledger_id,
    operation: plan.operation,
    items: [...items].sort((a, b) => a.finding_id.localeCompare(b.finding_id))
      .map((item) => ({
        findingId: item.finding_id,
        messageRefId: item.message_ref_id,
        providerMessageId: item.provider_message_id,
        labels: sortedLabels(item.prior_labels),
        targetLabel: item.target_label || "",
      })),
  });
}

async function ensureUserLabels(
  accessToken: string,
  names: string[],
) {
  const wanted = [...new Set(names.filter(Boolean))];
  const payload = await gmailRequest(
    accessToken,
    "/gmail/v1/users/me/labels",
  );
  const labels = Array.isArray(payload.labels)
    ? payload.labels as Record<string, unknown>[]
    : [];
  const result = new Map<string, string>();
  for (const label of labels) {
    const name = safeText(label.name, 225);
    const id = safeText(label.id, 256);
    if (wanted.includes(name) && id) result.set(name, id);
  }
  for (const name of wanted) {
    if (result.has(name)) continue;
    try {
      const created = await gmailRequest(
        accessToken,
        "/gmail/v1/users/me/labels",
        {
          method: "POST",
          body: JSON.stringify({
            name,
            labelListVisibility: "labelShow",
            messageListVisibility: "show",
          }),
        },
      );
      const id = safeText(created.id, 256);
      if (id) result.set(name, id);
    } catch {
      // A concurrent run may have created the same label. Re-list once.
      const refreshed = await gmailRequest(
        accessToken,
        "/gmail/v1/users/me/labels",
      );
      for (
        const label of Array.isArray(refreshed.labels)
          ? refreshed.labels as Record<string, unknown>[]
          : []
      ) {
        if (safeText(label.name, 225) === name && safeText(label.id, 256)) {
          result.set(name, safeText(label.id, 256));
        }
      }
    }
  }
  return result;
}

function expectedAppliedLabels(
  plan: ActionPlan,
  item: ActionItem,
  labelIds: Map<string, string>,
) {
  const prior = sortedLabels(item.prior_labels);
  if (plan.operation === "trash") {
    return [
      ...new Set([
        ...prior.filter((label) => label !== "INBOX"),
        "TRASH",
      ]),
    ].sort();
  }
  const labelName = item.target_label || labelNameForCategory(item.category);
  const labelId = labelIds.get(labelName);
  if (!labelId) return null;
  return [
    ...new Set([
      ...prior.filter((label) =>
        plan.operation !== "label_archive" || label !== "INBOX"
      ),
      labelId,
    ]),
  ].sort();
}

function actionEffectPresent(
  plan: ActionPlan,
  currentLabels: string[],
  expectedLabels: string[],
) {
  if (plan.operation === "trash" && !currentLabels.includes("TRASH")) {
    return false;
  }
  if (
    plan.operation === "label_archive" && currentLabels.includes("INBOX")
  ) return false;
  return expectedLabels.every((label) => currentLabels.includes(label));
}

async function persistAppliedItem(
  plan: ActionPlan,
  item: ActionItem,
  appliedLabels: string[],
  currentLabels = appliedLabels,
) {
  const refResult = await admin.from("mailbox_message_refs").update({
    current_labels: currentLabels,
    updated_at: nowIso(),
  }).eq("id", item.message_ref_id).eq("owner", plan.owner).eq(
    "ledger_id",
    plan.ledger_id,
  ).select("id").maybeSingle();
  if (refResult.error || !refResult.data) return false;
  const findingResult = await admin.from("mailbox_findings").update({
    status: "acted",
    updated_at: nowIso(),
  }).eq("id", item.finding_id).eq("owner", plan.owner).select("id")
    .maybeSingle();
  if (findingResult.error || !findingResult.data) return false;
  const itemResult = await admin.from("mailbox_action_items").update({
    status: "applied",
    applied_labels: appliedLabels,
    error_code: "",
    error_message: "",
    applied_at: nowIso(),
    updated_at: nowIso(),
  }).eq("id", item.id).eq("owner", plan.owner).eq("status", "applying")
    .select("id").maybeSingle();
  return !itemResult.error && Boolean(itemResult.data);
}

async function updatePlanTerminal(plan: ActionPlan) {
  const { data: items, error } = await admin.from("mailbox_action_items")
    .select(
      "status",
    ).eq("plan_id", plan.id).eq("owner", plan.owner);
  if (error || !items) return;
  const manifestRecovery = [
    "plan_items_missing",
    "plan_hash_mismatch",
  ].includes(safeText(plan.error_code, 80));
  if (items.length !== plan.total_count && !manifestRecovery) return;
  const statuses = (items || []).map((item) => item.status);
  if (statuses.some((status) => ["pending", "applying"].includes(status))) {
    return;
  }
  const applied = statuses.filter((status) => status === "applied").length;
  const skipped = statuses.filter((status) => status === "skipped").length;
  const failed = statuses.filter((status) => status === "failed").length;
  const status = applied === statuses.length
    ? "completed"
    : applied > 0
    ? "partial"
    : "failed";
  const update: Record<string, unknown> = {
    status,
    completed_at: nowIso(),
    undo_status: applied > 0 ? "available" : "not_available",
    // Gmail controls Trash retention and may purge near 30 days. Keep a
    // two-day safety margin for the user-visible undo window.
    undo_expires_at: applied > 0 ? isoAfter(28 * 24 * 60 * 60 * 1_000) : null,
    updated_at: nowIso(),
    error_code: failed || skipped ? "some_items_not_applied" : "",
    error_message: failed || skipped
      ? "Some messages changed or were protected before cleanup ran."
      : "",
  };
  const terminal = await admin.from("mailbox_action_plans").update(update).eq(
    "id",
    plan.id,
  ).eq("owner", plan.owner).eq("status", "applying").select("id")
    .maybeSingle();
  if (terminal.error || !terminal.data) return;
  await audit(
    plan.owner,
    plan.ledger_id,
    "action.completed",
    status === "completed"
      ? "succeeded"
      : status === "partial"
      ? "partial"
      : "failed",
    status === "completed"
      ? "Approved inbox cleanup completed."
      : "Approved cleanup finished with protected or changed messages skipped.",
    { applied, skipped, failed },
    null,
    plan.id,
  );
}

async function handleApplyingManifestProblem(
  plan: ActionPlan,
  items: ActionItem[],
  code: string,
) {
  const uncertain = items.filter((item) => item.status === "applying").length;
  const applied = items.filter((item) => item.status === "applied").length;
  if (code === "plan_items_missing" || uncertain > 0 || items.length === 0) {
    const firstDetection = !["plan_items_missing", "plan_hash_mismatch"]
      .includes(
        safeText(plan.error_code, 80),
      );
    const blocked = await admin.from("mailbox_action_plans").update({
      status: "applying",
      error_code: code,
      error_message:
        "Cleanup recovery bindings need administrator attention; automatic Gmail work is stopped for this plan.",
      updated_at: nowIso(),
    }).eq("id", plan.id).eq("owner", plan.owner).eq("status", "applying")
      .select("id").maybeSingle();
    if (!blocked.error && blocked.data && firstDetection) {
      await audit(
        plan.owner,
        plan.ledger_id,
        "action_recovery_blocked",
        "failed",
        "Automatic cleanup stopped because its service-only recovery bindings need administrator repair.",
        { applied, uncertain },
        null,
        plan.id,
      );
    }
    return;
  }
  const completedAt = nowIso();
  const terminal = await admin.from("mailbox_action_plans").update({
    status: applied > 0 ? "partial" : "failed",
    completed_at: completedAt,
    undo_status: applied > 0 ? "available" : "not_available",
    undo_expires_at: applied > 0 ? isoAfter(28 * 24 * 60 * 60 * 1_000) : null,
    error_code: code,
    error_message: applied > 0
      ? "Some cleanup completed before its recovery bindings changed."
      : "Cleanup bindings changed before any confirmed Gmail action.",
    updated_at: completedAt,
  }).eq("id", plan.id).eq("owner", plan.owner).eq("status", "applying")
    .select("id").maybeSingle();
  if (terminal.error || !terminal.data) return;
  await audit(
    plan.owner,
    plan.ledger_id,
    "action_recovery_manifest_failed",
    applied > 0 ? "partial" : "failed",
    applied > 0
      ? "Cleanup stopped after a binding integrity error; confirmed changes remain undoable."
      : "Cleanup stopped before a confirmed Gmail change because its bindings failed integrity checks.",
    { applied, uncertain },
    null,
    plan.id,
  );
}

async function processOnePlan(startedAt: number) {
  const candidateId = await nextRunnableId("next_runnable_mailbox_plan_id");
  if (!candidateId) return false;
  const { data, error } = await admin.from("mailbox_action_plans").select("*")
    .eq("id", candidateId).in("status", ["approved", "applying"])
    .maybeSingle();
  if (error || !data) return false;
  const plan = data as ActionPlan;
  if (
    await globallyPaused(plan.owner) ||
    await mailboxPaused(plan.owner, plan.ledger_id)
  ) return false;
  const lease = await claim(plan.owner, plan.ledger_id, "apply");
  if (!lease.claimed) return false;
  try {
    const previewExpired = Date.parse(plan.expires_at || "") <= Date.now();
    if (previewExpired && plan.status === "approved") {
      await admin.from("mailbox_action_plans").update({
        status: "expired",
        error_code: "preview_expired",
        error_message: "The approved preview expired before it ran.",
        updated_at: nowIso(),
      }).eq("id", plan.id).eq("owner", plan.owner);
      return true;
    }
    const context = await ownedMailboxContext(plan.ledger_id, plan.owner);
    if (!context || !canModifyMailbox(context)) {
      const update: Record<string, unknown> = {
        error_code: "gmail_modify_access_missing",
        error_message: "Gmail cleanup permission is unavailable.",
        updated_at: nowIso(),
      };
      if (plan.status === "approved") {
        update.status = "failed";
        update.completed_at = nowIso();
      }
      await admin.from("mailbox_action_plans").update(update).eq(
        "id",
        plan.id,
      ).eq("owner", plan.owner);
      return true;
    }
    const { data: allItemData, error: allItemsError } = await admin.from(
      "mailbox_action_items",
    ).select("*").eq("plan_id", plan.id).eq("owner", plan.owner).order(
      "ordinal",
      { ascending: true },
    );
    if (allItemsError) {
      // A transient read failure must never overwrite an in-progress plan or
      // hide already-applied Gmail changes. Leave it claimable for retry.
      return false;
    }
    if (!allItemData?.length || allItemData.length !== plan.total_count) {
      if (plan.status === "applying") {
        await handleApplyingManifestProblem(
          plan,
          (allItemData || []) as ActionItem[],
          "plan_items_missing",
        );
      } else {
        await admin.from("mailbox_action_plans").update({
          status: "failed",
          error_code: "plan_items_missing",
          error_message: "Cleanup bindings are unavailable.",
          completed_at: nowIso(),
          updated_at: nowIso(),
        }).eq("id", plan.id).eq("owner", plan.owner);
      }
      return true;
    }
    const allItems = allItemData as ActionItem[];
    if (
      await sha256Hex(canonicalPlan(plan, allItems)) !==
        safeText(plan.plan_hash, 64)
    ) {
      if (plan.status === "applying") {
        await handleApplyingManifestProblem(
          plan,
          allItems,
          "plan_hash_mismatch",
        );
      } else {
        await admin.from("mailbox_action_plans").update({
          status: "failed",
          error_code: "plan_hash_mismatch",
          error_message: "Cleanup preview bindings no longer match.",
          completed_at: nowIso(),
          updated_at: nowIso(),
        }).eq("id", plan.id).eq("owner", plan.owner);
      }
      return true;
    }
    if (previewExpired && plan.status === "applying") {
      const skipped = await admin.from("mailbox_action_items").update({
        status: "skipped",
        error_code: "preview_expired_before_apply",
        error_message: "The approval expired before this item was started.",
        updated_at: nowIso(),
      }).eq("plan_id", plan.id).eq("owner", plan.owner).eq(
        "status",
        "pending",
      );
      if (skipped.error) return false;
      for (const item of allItems) {
        if (item.status === "pending") item.status = "skipped";
      }
    }
    const planClaim = await admin.from("mailbox_action_plans").update({
      status: "applying",
      updated_at: nowIso(),
    }).eq("id", plan.id).eq("owner", plan.owner).in("status", [
      "approved",
      "applying",
    ]).select("id").maybeSingle();
    if (planClaim.error || !planClaim.data) return false;
    const pending = allItems.filter((item) =>
      ["pending", "applying"].includes(item.status)
    ).slice(0, MAX_ACTION_ITEMS_PER_INVOCATION);
    if (!pending.length) {
      await updatePlanTerminal(plan);
      return true;
    }
    let accessToken: string;
    try {
      accessToken = await gmailAccessToken(context);
    } catch {
      await admin.from("mailbox_action_plans").update({
        status: plan.status === "applying" ? "applying" : "approved",
        error_code: "gmail_token_unavailable",
        error_message: "Gmail authorization could not be refreshed.",
        updated_at: nowIso(),
      }).eq("id", plan.id).eq("owner", plan.owner);
      return true;
    }
    const labelNames = plan.operation === "trash"
      ? []
      : pending.map((item) =>
        item.target_label || labelNameForCategory(item.category)
      );
    const labelIds = await ensureUserLabels(accessToken, labelNames);
    for (const item of pending) {
      if (Date.now() - startedAt > RUN_BUDGET_MS - 10_000) break;
      if (
        await globallyPaused(plan.owner) ||
        await mailboxPaused(plan.owner, plan.ledger_id)
      ) break;
      const { data: safetyFinding, error: safetyError } = await admin.from(
        "mailbox_findings",
      ).select("category,protected_reasons").eq("id", item.finding_id).eq(
        "owner",
        plan.owner,
      ).eq("ledger_id", plan.ledger_id).maybeSingle();
      if (safetyError || !safetyFinding) break;
      const findingSafe = safetyFinding.category === item.category &&
        ["subscription", "account_creation", "receipt"].includes(
          safetyFinding.category,
        ) &&
        Array.isArray(safetyFinding.protected_reasons) &&
        safetyFinding.protected_reasons.length === 0;
      const itemClaim = await admin.from("mailbox_action_items").update({
        status: "applying",
        updated_at: nowIso(),
      }).eq("id", item.id).eq("owner", plan.owner).in("status", [
        "pending",
        "applying",
      ]).select("id").maybeSingle();
      if (itemClaim.error || !itemClaim.data) continue;
      let metadata: GmailMessage;
      try {
        metadata = await gmailMetadata(accessToken, item.provider_message_id);
      } catch (itemError) {
        const code = itemError instanceof Error
          ? itemError.message
          : "gmail_message_unavailable";
        await admin.from("mailbox_action_items").update({
          status: code === "gmail_api_retryable" ? "pending" : "failed",
          error_code: safeText(code, 80),
          error_message: "Gmail message could not be checked safely.",
          updated_at: nowIso(),
        }).eq("id", item.id).eq("owner", plan.owner);
        if (code === "gmail_api_retryable") break;
        continue;
      }
      const currentLabels = sortedLabels(metadata.labelIds);
      const expectedLabels = expectedAppliedLabels(plan, item, labelIds);
      if (!sameLabels(currentLabels, item.prior_labels)) {
        if (
          item.status === "applying" && expectedLabels &&
          actionEffectPresent(plan, currentLabels, expectedLabels)
        ) {
          if (
            !await persistAppliedItem(
              plan,
              item,
              expectedLabels,
              currentLabels,
            )
          ) break;
          continue;
        }
        await admin.from("mailbox_action_items").update({
          status: "skipped",
          error_code: "message_changed_after_preview",
          error_message: "Message labels changed after preview.",
          updated_at: nowIso(),
        }).eq("id", item.id).eq("owner", plan.owner);
        continue;
      }
      if (!findingSafe) {
        await admin.from("mailbox_action_items").update({
          status: "skipped",
          error_code: "finding_became_protected",
          error_message: "Message became protected after preview.",
          updated_at: nowIso(),
        }).eq("id", item.id).eq("owner", plan.owner);
        continue;
      }
      const attachmentState = plan.operation === "trash"
        ? gmailMetadataAttachmentState(metadata)
        : null;
      const protectedReasons = protectedForOperation(
        item.category,
        currentLabels,
        plan.operation,
        plan.operation === "trash" ? attachmentState === false : null,
      );
      if (protectedReasons.length) {
        await admin.from("mailbox_action_items").update({
          status: "skipped",
          error_code: "message_protected",
          error_message: "Message matched a cleanup protection rule.",
          updated_at: nowIso(),
        }).eq("id", item.id).eq("owner", plan.owner);
        continue;
      }
      try {
        let result: Record<string, unknown>;
        if (plan.operation === "trash") {
          result = await gmailRequest(
            accessToken,
            `/gmail/v1/users/me/messages/${
              encodeURIComponent(item.provider_message_id)
            }/trash`,
            { method: "POST" },
          );
        } else {
          const labelName = item.target_label ||
            labelNameForCategory(item.category);
          const labelId = labelIds.get(labelName);
          if (!labelId) throw new Error("gmail_label_unavailable");
          result = await gmailRequest(
            accessToken,
            `/gmail/v1/users/me/messages/${
              encodeURIComponent(item.provider_message_id)
            }/modify`,
            {
              method: "POST",
              body: JSON.stringify({
                addLabelIds: [labelId],
                removeLabelIds: plan.operation === "label_archive"
                  ? ["INBOX"]
                  : [],
              }),
            },
          );
        }
        let appliedLabels = sortedLabels(result.labelIds);
        if (!appliedLabels.length) {
          const refreshed = await gmailMetadata(
            accessToken,
            item.provider_message_id,
          );
          appliedLabels = sortedLabels(refreshed.labelIds);
        }
        if (
          !expectedLabels ||
          !actionEffectPresent(plan, appliedLabels, expectedLabels)
        ) {
          throw new Error("gmail_action_state_unexpected");
        }
        if (
          !await persistAppliedItem(
            plan,
            item,
            expectedLabels,
            appliedLabels,
          )
        ) break;
      } catch (itemError) {
        const code = itemError instanceof Error
          ? itemError.message
          : "gmail_action_failed";
        await admin.from("mailbox_action_items").update({
          status: [
              "gmail_api_retryable",
              "gmail_api_unreachable",
              "gmail_action_state_unexpected",
            ].includes(code)
            ? "applying"
            : "failed",
          error_code: safeText(code, 80),
          error_message: "Approved Gmail action could not be completed.",
          updated_at: nowIso(),
        }).eq("id", item.id).eq("owner", plan.owner);
        if (code === "gmail_api_retryable") break;
      }
    }
    await updatePlanTerminal(plan);
    return true;
  } finally {
    await release(plan.owner, plan.ledger_id, lease.leaseId);
  }
}

async function persistUndoneItem(
  plan: ActionPlan,
  item: ActionItem,
  restoredLabels: string[],
) {
  const refResult = await admin.from("mailbox_message_refs").update({
    current_labels: restoredLabels,
    updated_at: nowIso(),
  }).eq("id", item.message_ref_id).eq("owner", plan.owner).eq(
    "ledger_id",
    plan.ledger_id,
  ).select("id").maybeSingle();
  if (refResult.error || !refResult.data) return false;
  const findingResult = await admin.from("mailbox_findings").update({
    status: "open",
    updated_at: nowIso(),
  }).eq("id", item.finding_id).eq("owner", plan.owner).select("id")
    .maybeSingle();
  if (findingResult.error || !findingResult.data) return false;
  const itemResult = await admin.from("mailbox_action_items").update({
    status: "undone",
    error_code: "",
    error_message: "",
    undone_at: nowIso(),
    updated_at: nowIso(),
  }).eq("id", item.id).eq("owner", plan.owner).eq("status", "undoing")
    .select("id").maybeSingle();
  return !itemResult.error && Boolean(itemResult.data);
}

async function updateUndoTerminal(plan: ActionPlan) {
  const { data: items, error } = await admin.from("mailbox_action_items")
    .select(
      "status",
    ).eq("plan_id", plan.id).eq("owner", plan.owner);
  if (error || !items) return;
  const manifestRecovery = [
    "plan_items_missing",
    "plan_hash_mismatch",
  ].includes(safeText(plan.error_code, 80));
  if (items.length !== plan.total_count && !manifestRecovery) return;
  const appliedItems = (items || []).filter((item) =>
    ["applied", "undoing", "undone", "undo_failed"].includes(item.status)
  );
  if (
    appliedItems.some((item) => ["applied", "undoing"].includes(item.status))
  ) {
    return;
  }
  if (!appliedItems.length) {
    await admin.from("mailbox_action_plans").update({
      undo_status: "failed",
      error_code: "undo_items_missing",
      error_message: "No applied cleanup items were available to undo.",
      updated_at: nowIso(),
    }).eq("id", plan.id).eq("owner", plan.owner);
    return;
  }
  const undone = appliedItems.filter((item) => item.status === "undone").length;
  const failed = appliedItems.filter((item) => item.status === "undo_failed")
    .length;
  const undoStatus = failed === 0
    ? "completed"
    : undone > 0
    ? "partial"
    : "failed";
  const terminal = await admin.from("mailbox_action_plans").update({
    undo_status: undoStatus,
    undone_at: undone > 0 ? nowIso() : null,
    updated_at: nowIso(),
    error_code: failed ? "some_items_not_undone" : "",
    error_message: failed
      ? "Some messages changed or could not be restored."
      : "",
  }).eq("id", plan.id).eq("owner", plan.owner).eq("undo_status", "running")
    .select("id").maybeSingle();
  if (terminal.error || !terminal.data) return;
  await audit(
    plan.owner,
    plan.ledger_id,
    "undo.completed",
    undoStatus === "completed"
      ? "succeeded"
      : undoStatus === "partial"
      ? "partial"
      : "failed",
    undoStatus === "completed"
      ? "Inbox cleanup was undone without removing later user changes."
      : "Undo finished with some messages left unchanged for safety.",
    { undone, failed },
    null,
    plan.id,
  );
}

async function processOneUndo(startedAt: number) {
  const candidateId = await nextRunnableId("next_runnable_mailbox_undo_id");
  if (!candidateId) return false;
  const { data, error } = await admin.from("mailbox_action_plans").select("*")
    .eq("id", candidateId).in("undo_status", ["requested", "running"])
    .maybeSingle();
  if (error || !data) return false;
  const plan = data as ActionPlan;
  if (
    await globallyPaused(plan.owner) ||
    await mailboxPaused(plan.owner, plan.ledger_id)
  ) return false;
  const lease = await claim(plan.owner, plan.ledger_id, "undo");
  if (!lease.claimed) return false;
  try {
    const undoExpired = !plan.undo_expires_at ||
      Date.parse(plan.undo_expires_at) <= Date.now();
    if (undoExpired && plan.undo_status === "requested") {
      await admin.from("mailbox_action_plans").update({
        undo_status: "expired",
        updated_at: nowIso(),
      }).eq("id", plan.id).eq("owner", plan.owner);
      await audit(
        plan.owner,
        plan.ledger_id,
        "undo_expired",
        "cancelled",
        "The undo request reached Gmail's retention safety deadline before restoration began.",
        {},
        null,
        plan.id,
      );
      return true;
    }
    const context = await ownedMailboxContext(plan.ledger_id, plan.owner);
    if (!context || !canModifyMailbox(context)) {
      await admin.from("mailbox_action_plans").update({
        undo_status: "requested",
        error_code: "gmail_modify_access_missing",
        error_message: "Gmail cleanup permission is unavailable.",
        updated_at: nowIso(),
      }).eq("id", plan.id).eq("owner", plan.owner);
      return true;
    }
    const undoClaim = await admin.from("mailbox_action_plans").update({
      undo_status: "running",
      updated_at: nowIso(),
    }).eq("id", plan.id).eq("owner", plan.owner).in("undo_status", [
      "requested",
      "running",
    ]).select("id").maybeSingle();
    if (undoClaim.error || !undoClaim.data) return false;
    const { data: itemData } = await admin.from("mailbox_action_items")
      .select("*").eq("plan_id", plan.id).eq("owner", plan.owner).in("status", [
        "applied",
        "undoing",
      ]).order("ordinal", { ascending: true }).limit(
        MAX_ACTION_ITEMS_PER_INVOCATION,
      );
    const items = (itemData || []) as ActionItem[];
    if (!items.length) {
      await updateUndoTerminal(plan);
      return true;
    }
    let accessToken: string;
    try {
      accessToken = await gmailAccessToken(context);
    } catch {
      await admin.from("mailbox_action_plans").update({
        undo_status: "requested",
        error_code: "gmail_token_unavailable",
        error_message: "Gmail authorization could not be refreshed.",
        updated_at: nowIso(),
      }).eq("id", plan.id).eq("owner", plan.owner);
      return true;
    }
    for (const item of items) {
      if (Date.now() - startedAt > RUN_BUDGET_MS - 10_000) break;
      if (
        await globallyPaused(plan.owner) ||
        await mailboxPaused(plan.owner, plan.ledger_id)
      ) break;
      const itemClaim = await admin.from("mailbox_action_items").update({
        status: "undoing",
        updated_at: nowIso(),
      }).eq("id", item.id).eq("owner", plan.owner).in("status", [
        "applied",
        "undoing",
      ]).select("id").maybeSingle();
      if (itemClaim.error || !itemClaim.data) continue;
      try {
        let metadata = await gmailMetadata(
          accessToken,
          item.provider_message_id,
        );
        if (
          plan.operation === "trash" && metadata.labelIds?.includes("TRASH")
        ) {
          metadata = await gmailRequest(
            accessToken,
            `/gmail/v1/users/me/messages/${
              encodeURIComponent(item.provider_message_id)
            }/untrash`,
            { method: "POST" },
          ) as GmailMessage;
        }
        const current = sortedLabels(metadata.labelIds);
        const prior = sortedLabels(item.prior_labels);
        const applied = sortedLabels(item.applied_labels);
        const addBack = prior.filter((label) =>
          !applied.includes(label) &&
          !current.includes(label)
        );
        const removeOurs = applied.filter((label) =>
          !prior.includes(label) &&
          current.includes(label)
        );
        let restored = current;
        if (addBack.length || removeOurs.length) {
          const result = await gmailRequest(
            accessToken,
            `/gmail/v1/users/me/messages/${
              encodeURIComponent(item.provider_message_id)
            }/modify`,
            {
              method: "POST",
              body: JSON.stringify({
                addLabelIds: addBack,
                removeLabelIds: removeOurs,
              }),
            },
          );
          restored = sortedLabels(result.labelIds);
          if (!restored.length) {
            const refreshed = await gmailMetadata(
              accessToken,
              item.provider_message_id,
            );
            restored = sortedLabels(refreshed.labelIds);
          }
        }
        if (
          addBack.some((label) => !restored.includes(label)) ||
          removeOurs.some((label) => restored.includes(label)) ||
          (plan.operation === "trash" && restored.includes("TRASH"))
        ) throw new Error("gmail_undo_state_unexpected");
        if (!await persistUndoneItem(plan, item, restored)) break;
      } catch (itemError) {
        const code = itemError instanceof Error
          ? itemError.message
          : "gmail_undo_failed";
        await admin.from("mailbox_action_items").update({
          status: [
              "gmail_api_retryable",
              "gmail_api_unreachable",
              "gmail_undo_state_unexpected",
            ].includes(code)
            ? "undoing"
            : "undo_failed",
          error_code: safeText(code, 80),
          error_message: "Message could not be restored safely.",
          updated_at: nowIso(),
        }).eq("id", item.id).eq("owner", plan.owner);
        if (code === "gmail_api_retryable") break;
      }
    }
    await updateUndoTerminal(plan);
    return true;
  } finally {
    await release(plan.owner, plan.ledger_id, lease.leaseId);
  }
}

serve(async (req) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
    });
  }
  if (
    !CRON_SECRET ||
    req.headers.get("X-Cron-Secret") !== CRON_SECRET
  ) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
    });
  }
  const startedAt = Date.now();
  const scheduled = await enqueueDueScans();
  const scanProcessed = Date.now() - startedAt < RUN_BUDGET_MS - 25_000
    ? await processOneScan(startedAt)
    : false;
  const planProcessed = Date.now() - startedAt < RUN_BUDGET_MS - 20_000
    ? await processOnePlan(startedAt)
    : false;
  const undoProcessed = Date.now() - startedAt < RUN_BUDGET_MS - 20_000
    ? await processOneUndo(startedAt)
    : false;
  return new Response(
    JSON.stringify({
      ok: true,
      scheduled,
      scanProcessed,
      planProcessed,
      undoProcessed,
    }),
    {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
    },
  );
});
