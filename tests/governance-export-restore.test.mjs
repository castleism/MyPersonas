import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (value) => readFile(path.join(root, value), "utf8");

test("portable and privacy exports fail closed across organization and governance data", async () => {
  const html = await read("MyPersonas.Online_v0/index.html");
  for (const table of [
    "persona_family_relationships", "persona_groups", "persona_group_members",
    "persona_projects", "persona_project_memberships", "project_resources",
    "businesses", "business_mission_items", "business_persona_memberships",
    "business_publication_reviews", "persona_publication_reviews", "platform_feature_requests",
    "platform_feature_request_events", "persona_follows", "persona_friend_settings",
    "persona_friend_invites", "persona_account_sync_settings",
    "persona_extension_submissions", "platform_role_assignments",
    "account_security_states", "friend_request_security_events",
    "platform_security_events", "account_network_blocks",
    "product_review_requests", "product_review_events",
    "product_review_notification_evidence",
    "persona_publication_dependency_sets", "persona_publication_dependencies",
    "persona_ai_model_routes", "persona_reposts", "persona_media_assets", "post_drafts",
    "agent_board_settings", "agent_board_requests", "agent_board_runs", "agent_board_decisions",
    "persona_revenue_settings", "affiliate_partners", "affiliate_products",
    "persona_affiliate_offers", "affiliate_click_events", "persona_review_requests",
    "product_review_settings", "mailbox_settings", "mailbox_scan_runs", "mailbox_findings",
    "mailbox_action_plans", "mailbox_audit_events", "persona_research_settings",
    "persona_research_briefs", "persona_research_topics", "persona_topic_post_plans",
    "research_brief_annotations", "persona_content_packages", "persona_content_variants",
    "owner_notifications", "persona_activity_events", "discovery_questions", "persona_knowledge",
  ]) assert.match(html, new RegExp(`\\b${table}\\b`), table);
  assert.match(html, /async function loadGovernanceExportSections/);
  assert.match(html, /async function fetchAllKeysetRpcPages/);
  assert.match(html, /p_limit:pageSize/);
  assert.match(html, /repeated a pagination cursor/);
  assert.match(html, /dependentError[\s\S]*return\{data:null,error:dependentError\}/);
  assert.match(html, /data\.version=5/);
  assert.match(html, /persona_custom_field_boxes:customFields\.data\|\|\[\]/);
  assert.match(html, /\.\.\.governanceSections\.data/);
  assert.match(html, /my_friend_request_security_events/);
  assert.match(html, /my_platform_security_events/);
  assert.match(html, /my_account_network_blocks/);
  assert.match(html, /my_product_review_notification_evidence/);
});

test("privacy export excludes secrets and sensitive abuse identifiers", async () => {
  const html = await read("MyPersonas.Online_v0/index.html");
  const loader = html.match(/async function loadGovernanceExportSections[\s\S]*?\r?\n}\r?\nasync function loadFanSessionRows/)?.[0] || "";
  assert.ok(loader, "governance export loader was not found");
  assert.match(loader, /affiliate_click_events","id,owner,persona_id,offer_id,product_id,source,utm_source,utm_medium,utm_campaign,created_at"/);
  assert.match(loader, /product_review_requests","id,owner,persona_id,requester_email,requester_name,product_name,product_url,reason,consent_to_reply,marketing_consent,status,captcha_verified_at,created_at,updated_at,retention_expires_at"/);
  assert.doesNotMatch(loader, /\b(?:ip_hash|user_agent_hash|request_fingerprint|dedupe_key|idempotency_key)\b/);
  assert.doesNotMatch(loader, /"(?:ai_backend_credentials|gmail_credentials|twitter_credentials|meta_grants|mailbox_message_refs|mailbox_scan_state|mailbox_action_items|product_review_rate_limits|affiliate_click_rate_limits)"/);
});

test("self-security and notification evidence RPCs use stable bounded keyset pages", async () => {
  const sql = await read("MyPersonas.Online_v0/sql-updates/051-publication-social-security-governance.sql");
  for (const name of [
    "my_friend_request_security_events", "my_platform_security_events",
    "my_account_network_blocks", "my_product_review_notification_evidence",
  ]) {
    const fn = sql.match(new RegExp(`create or replace function public\\.${name}[\\s\\S]*?\\n\\$\\$;`))?.[0] || "";
    assert.ok(fn, `${name} was not found`);
    assert.match(fn, /p_limit integer default 500/);
    assert.match(fn, /limit least\(greatest\(coalesce\(p_limit,500\),1\),500\)/);
  }
  assert.match(sql, /\(event\.created_at,event\.id\) < \(p_before_created_at,p_before_event_id\)/);
  assert.match(sql, /\(block\.updated_at,block\.identifier_hash\)[\s\S]*< \(p_before_updated_at,p_before_identifier_hash\)/);
  assert.match(sql, /\(notification\.updated_at,notification\.request_id\)[\s\S]*< \(p_before_updated_at,p_before_request_id\)/);
});

test("spreadsheet includes owner-operational organization and governance sheets", async () => {
  const html = await read("MyPersonas.Online_v0/index.html");
  for (const sheet of [
    "Family", "Projects", "Project Members", "Project Resources", "Businesses",
    "Business Mission", "Business Members", "Business Publication Review", "Publication Review", "Feature Requests",
    "Friend Policy", "Follows", "Sync Preferences", "Extension Drafts",
    "Review Requests", "Review Request Events", "Review Notification Evidence",
    "AI Model Routes", "Board Settings", "Board Requests", "Board Runs", "Board Decisions",
    "Reposts", "Media Assets", "Staged Posts", "Research Settings", "Research Briefs",
    "Research Topics", "Research Post Plans", "Research Annotations", "Content Packages",
    "Content Variants", "Owner Notifications", "Persona Activity",
  ]) assert.match(html, new RegExp(`add\\("${sheet}"`), sheet);
});

test("restore remaps IDs and forces draft private disconnected states", async () => {
  const html = await read("MyPersonas.Online_v0/index.html");
  assert.match(html, /restoredIds=new Map\(\),projectIds=new Map\(\),businessIds=new Map\(\),groupIds=new Map\(\)/);
  assert.match(html, /set_persona_family_relationship/);
  assert.match(html, /p_visibility:"owner_only"/);
  assert.match(html, /p_project_status:"paused"/);
  assert.match(html, /p_account_ledger_id:null/);
  assert.match(html, /save_project_resource_v2/);
  assert.match(html, /p_expected_row_version:null/);
  assert.match(html, /p_connection_state:"not_configured"/);
  assert.match(html, /p_enabled:false/);
  assert.match(html, /save_business_draft/);
  assert.match(html, /save_persona_review_draft/);
  assert.match(html, /business publication review evidence is export-only/);
  assert.match(html, /featureDrafts=.*status==="draft"/);
  assert.match(html, /extensionDrafts=.*status==="draft"/);
  assert.match(html, /no sync authority or publication state was restored/);
  assert.match(html, /requireAal2ForSensitiveAction\("restore disconnected project-resource metadata"\)/);
  assert.match(html, /nothing from this restore was written/);
  const restore=html.slice(html.indexOf("async function restoreImport"),html.indexOf("// ---------- first-persona onboarding"));
  const preflight=restore.indexOf('requireAal2ForSensitiveAction("restore disconnected project-resource metadata")');
  const fixedClient=restore.indexOf("fixedSessionClient(token)");
  const firstWrite=restore.indexOf("for(const p of personas)");
  assert.ok(preflight>0&&preflight<fixedClient&&fixedClient<firstWrite,"AAL2 preflight and fresh fixed token precede every restore write");
  assert.doesNotMatch(html, /restoreClient\.rpc\("(?:publish_persona_page|publish_business_page|save_business_review_draft|submit_business_for_review|submit_extension_for_review|submit_feature_request)"/);
});

function restoreGuardCore(html) {
  const start = html.indexOf("const RESTORE_MAX_FILE_BYTES=");
  const end = html.indexOf("async function restoreImport", start);
  assert.ok(start >= 0 && end > start, "restore guard source was not found");
  const source = html.slice(start, end);
  return new Function("initialSession", "initialGeneration", `
    let session=initialSession,authLoadGeneration=initialGeneration;
    const toast=()=>{},confirm=()=>false;
    ${source}
    return {
      RESTORE_MAX_FILE_BYTES,RESTORE_MAX_TOTAL_ROWS,RESTORE_SECTION_LIMITS,
      validateRestoreImport,restoreSessionCurrent,assertRestoreSession,restoreAwait,
      setAuth(nextSession,nextGeneration){session=nextSession;authLoadGeneration=nextGeneration;}
    };
  `)({ user: { id: "owner-a" }, access_token: "token-a" }, 7);
}

test("restore guards reject oversized and over-row backups before mutation", async () => {
  const html = await read("MyPersonas.Online_v0/index.html");
  const core = restoreGuardCore(html);
  const valid = { app: "mypersonas", personas: [{ id: "p1" }] };
  assert.equal(core.validateRestoreImport(valid, core.RESTORE_MAX_FILE_BYTES), true);
  assert.throws(
    () => core.validateRestoreImport(valid, core.RESTORE_MAX_FILE_BYTES + 1),
    /20 MB restore limit/,
  );
  assert.throws(
    () => core.validateRestoreImport({ app: "mypersonas", personas: Array(101) }),
    /personas exceeds its 100-row restore limit/,
  );
  assert.throws(
    () => core.validateRestoreImport({
      app: "mypersonas",
      persona_knowledge: Array(10000),
      business_mission_items: Array(10000),
      persona_group_members: Array(5000),
      personas: [{}],
    }),
    /25000-row aggregate limit/,
  );
  assert.throws(
    () => core.validateRestoreImport({ app: "mypersonas", platform_feature_requests: Array.from({ length: 26 }, () => ({ status: "draft" })) }),
    /25 restorable feature-request drafts/,
  );
  const fromFile = html.slice(html.indexOf("function restoreFromFile"), html.indexOf("async function restoreImport"));
  assert.match(fromFile, /f\.size>RESTORE_MAX_FILE_BYTES[\s\S]*?new FileReader\(\)/);
  assert.match(fromFile, /validateRestoreImport\(data,f\.size\)[\s\S]*?confirm\(/);
});

test("restore await guard stops before or immediately after logout and account switch", async () => {
  const html = await read("MyPersonas.Online_v0/index.html");
  const core = restoreGuardCore(html);
  const context = { uid: "owner-a", generation: 7 };
  let calls = 0;
  await assert.rejects(
    core.restoreAwait(context, async () => {
      calls++;
      core.setAuth(null, 8);
      return { data: true };
    }),
    error => error?.code === "RESTORE_SESSION_CHANGED",
  );
  assert.equal(calls, 1, "logout during an RPC is detected by the post-await guard");

  core.setAuth({ user: { id: "owner-b" }, access_token: "token-b" }, 9);
  await assert.rejects(
    core.restoreAwait(context, async () => {
      calls++;
      return { data: true };
    }),
    error => error?.code === "RESTORE_SESSION_CHANGED",
  );
  assert.equal(calls, 1, "an account switch prevents the next operation from starting");

  const restore = html.slice(html.indexOf("async function restoreImport"), html.indexOf("// ---------- first-persona onboarding"));
  assert.doesNotMatch(restore, /\bawait\s+(?:sb|restoreClient)\./);
  assert.doesNotMatch(restore, /\bsb\.(?:rpc|from)\(/);
  const awaitedHelpers = [...restore.matchAll(/\bawait\s+([A-Za-z_$][\w$]*)/g)].map(match => match[1]);
  assert.ok(awaitedHelpers.length > 10);
  assert.deepEqual([...new Set(awaitedHelpers)].sort(), ["requireAal2ForSensitiveAction", "restoreAwait", "restoreRpc", "restoreWrite"]);
  assert.match(restore, /catch\(error\)\{if\(error\?\.code==="RESTORE_SESSION_CHANGED"\)return;/);
});
