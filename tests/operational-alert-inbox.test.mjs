import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const root = path.resolve(import.meta.dirname, "..");
const read = (relative) => readFile(path.join(root, relative), "utf8");

function section(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0, `missing section start: ${start}`);
  assert.ok(to > from, `missing section end: ${end}`);
  return source.slice(from, to);
}

test("migration 069 is mirrored and the staff RPC is AAL2 role-scoped", async () => {
  const [sql, mirror] = await Promise.all([
    read("MyPersonas.Online_v0/sql-updates/069-operational-alert-inbox.sql"),
    read("supabase/migrations/20260823110000_operational_alert_inbox.sql"),
  ]);
  assert.equal(mirror, sql);
  assert.match(sql, /^begin;[\s\S]*commit;\s*$/m);

  const staff = section(
    sql,
    "create or replace function public.staff_operational_alerts",
    "revoke all on function public.staff_operational_alerts",
  );
  assert.match(staff, /security definer[\s\S]*stable[\s\S]*set search_path = ''/);
  assert.match(staff, /perform public\.require_aal2\(\)/);
  assert.match(staff, /has_platform_role\(array\['global_administrator'\]/);
  assert.match(staff, /has_platform_role\(array\['technician'\]/);
  assert.match(staff, /raise sqlstate '42501' using message='Active staff role required'/);
  assert.match(staff, /least\(greatest\(coalesce\(p_limit,100\),1\),200\)/);
  assert.match(staff, /raise sqlstate '22023' using message='Invalid alert cursor'/);
  assert.match(staff, /\(candidate\.last_seen,candidate\.alert_key\)</);
  assert.match(staff, /order by candidate\.last_seen desc,candidate\.alert_key desc/);
  assert.match(staff, /where v_global_admin/);
  assert.doesNotMatch(
    staff,
    /object_id|account_id|identifier_hash|provider_message|requester_|stripe_|\.metadata|\.message|\.detail/i,
  );
  assert.match(
    sql,
    /grant execute on function public\.staff_operational_alerts\([\s\S]*\) to authenticated/,
  );
  assert.doesNotMatch(
    sql,
    /grant execute on function public\.staff_operational_alerts\([\s\S]*\) to anon/,
  );
});

test("billing alerts degrade safely before 068 and never project financial identifiers", async () => {
  const sql = await read("MyPersonas.Online_v0/sql-updates/069-operational-alert-inbox.sql");
  const billing = section(
    sql,
    "create or replace function public.operational_billing_alerts_service",
    "revoke all on function public.operational_billing_alerts_service",
  );
  assert.match(billing, /to_regclass\('private\.billing_reconciliation_alerts'\) is null/);
  assert.match(billing, /return query execute \$billing_alerts\$/);
  assert.match(billing, /where alert\.resolved_at is null/);
  assert.match(billing, /else 'billing_other'/);
  assert.doesNotMatch(
    billing,
    /object_id|account_id|stripe_(?:event|customer|subscription|price)|\.detail|provider_/i,
  );
  assert.match(
    sql,
    /revoke all on function public\.operational_billing_alerts_service\(\)[\s\S]*from public,anon,authenticated,service_role/,
  );
});

test("operational projections are aggregate-only and maintenance staleness is explicit", async () => {
  const sql = await read("MyPersonas.Online_v0/sql-updates/069-operational-alert-inbox.sql");
  for (const source of [
    "platform_security_events",
    "account_security_states",
    "product_review_notifications",
    "error_logs",
  ]) assert.match(sql, new RegExp(`from public\\.${source}`));
  for (const action of [
    "review_security_events",
    "notify_locked_accounts",
    "review_product_notification_queue",
    "review_client_error_volume",
    "run_operations_maintenance",
  ]) assert.match(sql, new RegExp(`'${action}'`));
  assert.match(sql, /event\.created_at>=now\(\)-interval '24 hours'/);
  assert.match(sql, /notification\.available_at<now\(\)-interval '15 minutes'/);
  assert.match(sql, /having count\(\*\)>=5 or bool_or\(log\.severity='critical'\)/);
  assert.match(sql, /heartbeat\.last_success<now\(\)-interval '36 hours'/);
  assert.match(sql, /event_type='operations_maintenance_completed'/);
});

test("maintenance uses bounded service-only batches and one existing cron-secret boundary", async () => {
  const [sql, edge, config] = await Promise.all([
    read("MyPersonas.Online_v0/sql-updates/069-operational-alert-inbox.sql"),
    read("supabase/functions/run-operations-maintenance/index.ts"),
    read("supabase/config.toml"),
  ]);
  for (const fn of [
    "prune_product_review_rate_limits_batch_service",
    "purge_affiliate_click_retention_batch_service",
    "purge_governance_security_retention_batch_service",
  ]) {
    const fnSource = section(sql, `create or replace function public.${fn}`, "$$;");
    assert.match(fnSource, /least\(greatest\(coalesce\(p_limit,500\),1\),1000\)/);
    assert.match(fnSource, /coalesce\(auth\.role\(\),''\)<>'service_role'/);
    assert.match(fnSource, /limit v_limit for update skip locked/);
    assert.match(
      sql,
      new RegExp(`grant execute on function[\\s\\S]{0,350}public\\.${fn}\\(integer\\)`),
    );
  }

  for (const fixedTask of [
    "product_review_rate_limits",
    "affiliate_click_retention",
    "governance_security_retention",
    "ai_backend_budget_retention",
    "billing_retention",
  ]) assert.match(edge, new RegExp(`name: "${fixedTask}"`));
  assert.match(edge, /const CRON_SECRET = Deno\.env\.get\("CRON_SECRET"\) \|\| ""/);
  assert.match(edge, /request\.headers\.get\("X-Cron-Secret"\) !== CRON_SECRET/);
  assert.match(edge, /if \(request\.method !== "POST"\)/);
  assert.match(edge, /operations_maintenance_completed/);
  assert.match(edge, /operations_maintenance_failed/);
  assert.match(edge, /source: "edge_function"/);
  assert.match(edge, /identifier_hash: ""/);
  assert.match(edge, /failed_tasks: failedTasks/);
  assert.doesNotMatch(edge, /console\.error\([^\n]*(?:result|heartbeat)\.error/);
  assert.doesNotMatch(edge, /error\.message|JSON\.stringify\([^\n]*\.error/);
  assert.doesNotMatch(edge, /cron\.schedule|pg_cron|create schedule/i);
  assert.match(config, /\[functions\.run-operations-maintenance\]\s*\nverify_jwt = false/);
});

test("staff UI parses, escapes rows, and discards route or account races", async () => {
  const [source, css, html] = await Promise.all([
    read("MyPersonas.Online_v0/platform-governance.js"),
    read("MyPersonas.Online_v0/platform-governance.css"),
    read("MyPersonas.Online_v0/index.html"),
  ]);
  new vm.Script(source, { filename: "platform-governance.js" });
  assert.match(source, /operationalAlerts:\[\]/);
  assert.match(source, /operationalAlertsError:""/);
  assert.match(source, /operationalAlertsLoaded:false/);
  assert.match(source, /governanceRpc\("staff_operational_alerts"/);
  assert.match(source, /requireAal2ForSensitiveAction\("view aggregate operational alerts"\)/);
  assert.match(source, /epoch!==renderEpoch\|\|session\?\.user\?\.id!==owner/);
  assert.match(source, /split\("\/"\)\[0\]!=="platform-queue"/);
  assert.match(source, /esc\(String\(alert\.category/);
  assert.match(source, /esc\(alert\.source/);
  assert.match(source, /GOVERNANCE_OPERATIONAL_ACTIONS\[alert\.safe_action_code\]/);
  assert.match(source, /Read-only, aggregate in-app visibility/);
  assert.doesNotMatch(source, /localStorage|sessionStorage/);
  assert.doesNotMatch(source, /resolve_operational|dismiss_operational/);
  assert.match(css, /\.gov-alert-list/);
  assert.match(css, /\.gov-alert\.critical/);
  assert.match(html, /platform-governance\.css\?v=20260823-2/);
  assert.match(html, /platform-governance\.js\?v=20260823-2/);
});

test("staff alert renderer escapes hostile rows and a late account response is inert", async () => {
  const source = await read("MyPersonas.Online_v0/platform-governance.js");
  let finishRpc;
  const toasts = [];
  const context = vm.createContext({
    session: { user: { id: "owner-a" } },
    renderEpoch: 7,
    location: { hash: "#/platform-queue" },
    document: { getElementById: () => ({ setAttribute() {}, outerHTML: "" }) },
    sb: { rpc: () => new Promise((resolve) => { finishRpc = resolve; }) },
    requireAal2ForSensitiveAction: async () => true,
    toast: (message) => toasts.push(message),
    esc: (value) => String(value).replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;").replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;").replaceAll("'", "&#39;"),
  });
  vm.runInContext(source, context);
  vm.runInContext(`governanceState={...governanceState,
    operationalAlertsLoaded:true,
    operationalAlerts:[{category:"</b><img src=x onerror=alert(1)>",
      source:"<script>bad</script>",severity:"critical",occurrence_count:2,
      last_seen:"2026-08-23T00:00:00Z",safe_action_code:"hostile-action",
      requires_global_admin:false}]}`, context);
  const html = context.governanceOperationalAlertsCard();
  assert.doesNotMatch(html, /<img|<script>|hostile-action/);
  assert.match(html, /&lt;\/b&gt;&lt;img/);
  assert.match(html, /Review the restricted operations runbook/);

  vm.runInContext("resetGovernanceState()", context);
  const pending = context.governanceRefreshOperationalAlerts();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(typeof finishRpc, "function");
  context.session = { user: { id: "owner-b" } };
  context.renderEpoch = 8;
  finishRpc({ data: [{ category: "stale-account-row" }], error: null });
  await pending;
  const state = vm.runInContext("governanceState", context);
  assert.equal(state.operationalAlerts.length, 0);
  assert.equal(toasts.length, 0);
});

test("runbook preserves deployment, delivery, WAF, and irreversible-retention boundaries", async () => {
  const runbook = await read("MyPersonas.Online_v0/OPERATIONS-ALERT-RUNBOOK.md");
  assert.match(runbook, /local implementation only/i);
  assert.match(runbook, /not incident paging/i);
  assert.match(runbook, /queued row is not delivery evidence/i);
  assert.match(runbook, /Do not use a generic dismiss or resolve/i);
  assert.match(runbook, /AAL2 global administrators\s+and technicians/i);
  assert.match(runbook, /Billing rows are visible only to global administrators/i);
  assert.match(runbook, /Do not create a schedule without owner approval/i);
  assert.match(runbook, /Retention deletion is intentionally irreversible/i);
  assert.match(runbook, /WAF\/CAPTCHA\/rate-limit/i);
});
