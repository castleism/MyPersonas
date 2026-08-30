import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const frontendPath = path.join(repoRoot, "MyPersonas.Online_v0/index.html");
const deployableMigrationPath = path.join(
  repoRoot,
  "supabase/migrations/20260830051925_restore_require_aal2_helper.sql",
);
const operatorMigrationPath = path.join(
  repoRoot,
  "MyPersonas.Online_v0/sql-updates/063-restore-require-aal2-helper.sql",
);
const mailboxGuardMigrationPath = path.join(
  repoRoot,
  "supabase/migrations/20260830053941_prevent_mailbox_social_targets.sql",
);
const mailboxGuardOperatorPath = path.join(
  repoRoot,
  "MyPersonas.Online_v0/sql-updates/064-prevent-mailbox-social-targets.sql",
);

function functionSource(html, name, nextName) {
  const start = html.indexOf(`function ${name}`);
  assert.notEqual(start, -1, `${name} must exist`);
  const end = nextName ? html.indexOf(`function ${nextName}`, start + 1) : html.length;
  assert.notEqual(end, -1, `${nextName} must follow ${name}`);
  return html.slice(start, end);
}

test("the deployable migration restores only the private AAL2 helper", async () => {
  const [deployable, operator] = await Promise.all([
    readFile(deployableMigrationPath, "utf8"),
    readFile(operatorMigrationPath, "utf8"),
  ]);
  assert.equal(operator, deployable, "operator and deployable copies must stay identical");
  assert.match(deployable, /create function public\.require_aal2\(\)/);
  assert.doesNotMatch(deployable, /create or replace function public\.require_aal2/);
  assert.match(deployable, /language plpgsql\s+stable\s+security invoker\s+set search_path = ''/s);
  assert.match(deployable, /auth\.uid\(\) is null/);
  assert.match(deployable, /auth\.jwt\(\) ->> 'aal'/);
  assert.match(deployable, /<> 'aal2'/);
  assert.match(
    deployable,
    /revoke all on function public\.require_aal2\(\) from public, anon, authenticated, service_role/,
  );
  assert.match(deployable, /grant execute on function public\.require_aal2\(\) to postgres/);
  assert.doesNotMatch(deployable, /function public\.(?:create|update|delete)_ai_backend/);
});

test("autonomy controls explain MFA and never show a raw missing-helper error", async () => {
  const html = await readFile(frontendPath, "utf8");
  assert.match(html, /Two-factor confirmation protects these controls/);
  assert.match(html, /Set up or verify authenticator/);
  const setup = functionSource(html, "openAutomationSecuritySetup", "automationStudioHtml");
  assert.match(setup, /assuranceSnapshot\(\)/);
  assert.match(setup, /mfaLoginGate=\{active:true/);
  assert.match(setup, /renderMfaLoginGate\(\)/);
  assert.match(html, /AUTO_LEVELS\.map\(x=>`<button type="button" class="levelcard/);
  assert.match(html, /aria-pressed="\$\{level===x\.n\}"/);
  assert.match(html, /require_aal2\.\*does not exist/i);
  assert.match(html, /requires a site update, not a different authenticator code/);
  const safeError = functionSource(html, "sensitiveActionErrorMessage", "contentPlanRpcParams");
  assert.match(safeError, /Two-factor verification required/);
  assert.doesNotMatch(safeError, /code==="42501"/);
  assert.match(html, /Google Authenticator help/);
  assert.match(html, /Copy setup key/);
  assert.match(html, /AUTO_LEVELS\.map\(level=>`<option/);
  assert.doesNotMatch(html, /L2 — Approve &amp; publish \(you approve, it posts\)/);
  assert.doesNotMatch(html, /L3 — Bounded autopost/);
});

test("Targets visibly explains the workflow and daily policy field", async () => {
  const html = await readFile(frontendPath, "utf8");
  const targets = functionSource(html, "automationTargetsHtml", "automationWeekHtml");
  assert.match(targets, /Saving a target policy does not connect an account, grant provider permission, create a schedule, or publish anything/);
  assert.match(targets, /<label for="destMode_\$\{key\}">Posting workflow<\/label>/);
  assert.match(targets, /<label for="destCap_\$\{key\}">Daily policy limit<\/label>/);
  assert.match(targets, /daily_publish_limit\?\?3/);
  assert.match(targets, /Maximum posts per day for this persona on this destination once eligible automated publishing is enabled/);
  assert.match(targets, /Manual workflows are not automatically capped/);
  assert.match(targets, /Enter 1–100; 3 is a cautious starting point/);
  assert.match(targets, /Saving this does not create or run a schedule/);
  assert.match(targets, /Save target policy/);
  assert.match(targets, /Not saved — schedules cannot use this target yet/);
  assert.match(targets, /Target policy saved\. This did not connect, schedule, or publish anything/);
  assert.match(targets, /provider-setup\.html#/);
  assert.match(targets, /Connection options/);
  const schedule = functionSource(html, "automationScheduleHtml", "automationQueueHtml");
  assert.match(schedule, /Approved native drafts must still be staged into page review/);
  assert.match(schedule, /automatic publication remains paused/);
  assert.doesNotMatch(schedule, /L3 can publish an exact approved native draft/);
});

test("mailboxes are kept out of social targets, schedules, and draft destination choices", async () => {
  const html = await readFile(frontendPath, "utf8");
  assert.match(html, /function autoAssignedSocialAccounts\(pid\)\{return autoAssignedAccounts\(pid\)\.filter\(a=>!LEDGER_EMAIL_PROVIDERS\.has\(a\.provider\)\)\}/);
  assert.match(html, /function autoAssignedMailboxAccounts/);
  assert.match(html, /This is an inbox account, not a posting target/);
  assert.match(html, /Open Inbox cleanup/);
  assert.match(html, /assigned=autoAssignedSocialAccounts\(p\.id\)/);
  assert.match(html, /autoAssignedSocialAccounts\(p\.id\)\.map\(a=>`<option/);
  const editor = functionSource(html, "openDraftEditor", "saveDraftEditor");
  assert.match(editor, /assigned=autoAssignedSocialAccounts\(p\.id\)/);
  const saveEditor = functionSource(html, "saveDraftEditor", "approveAutomationDraft");
  assert.match(saveEditor, /LEDGER_EMAIL_PROVIDERS\.has\(a\.provider\)/);
  assert.match(html, /Inbox accounts use Inbox cleanup and cannot be social schedule destinations/);
  assert.match(html, /Inbox accounts use Inbox cleanup and cannot be resumed as social schedules/);
  assert.match(html, /Inbox accounts use Inbox cleanup and cannot receive social drafts/);
});

test("saving a target validates the policy and invokes only its destination RPC", async () => {
  const html = await readFile(frontendPath, "utf8");
  const save = functionSource(html, "saveAutomationDestination", "editAutomationTask");
  assert.match(save, /Number\(val\("destCap_"\+key\)\)/);
  assert.match(save, /Number\.isInteger\(daily_publish_limit\)/);
  assert.match(save, /daily_publish_limit<1\|\|daily_publish_limit>100/);
  assert.match(save, /sb\.rpc\("save_agent_destination"/);
  assert.doesNotMatch(save, /oauth|save_ai_task_definition|save_owner_draft|publishAutomationDraft|meta-post/i);
  assert.match(save, /Policy saved — nothing was posted/);
});

test("the database also rejects mailbox accounts from social automation tables", async () => {
  const [deployable, operator] = await Promise.all([
    readFile(mailboxGuardMigrationPath, "utf8"),
    readFile(mailboxGuardOperatorPath, "utf8"),
  ]);
  assert.equal(operator, deployable, "mailbox guard copies must stay identical");
  assert.match(deployable, /create function public\.reject_mailbox_social_account\(\)/);
  assert.match(deployable, /security definer\s+set search_path = ''/s);
  assert.match(deployable, /'gmail','outlook','yahoo','icloud','proton'/);
  assert.match(deployable, /errcode = '23514'/);
  for (const trigger of [
    "reject_mailbox_agent_destination",
    "reject_mailbox_ai_task",
    "reject_mailbox_draft",
    "reject_social_account_mailbox_reclassification",
  ]) assert.match(deployable, new RegExp(`create trigger ${trigger}`));
  assert.match(
    deployable,
    /revoke all on function public\.reject_mailbox_social_account\(\)\s+from public, anon, authenticated, service_role/,
  );
  assert.match(deployable, /grant execute on function public\.reject_mailbox_social_account\(\) to postgres/);
});
