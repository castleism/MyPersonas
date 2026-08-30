import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const ownerApp = await readFile(path.join(root, "MyPersonas.Online_v0/owner-app.js"), "utf8");
const canonical = await readFile(path.join(root, "MyPersonas.Online_v0/sql-updates/073-content-package-preview-gate.sql"), "utf8");
const timestamped = await readFile(path.join(root, "supabase/migrations/20260830160000_content_package_preview_gate.sql"), "utf8");

function between(source, start, end) {
  const from = source.indexOf(start);
  assert.notEqual(from, -1, `${start} must exist`);
  const to = source.indexOf(end, from + start.length);
  assert.notEqual(to, -1, `${end} must follow ${start}`);
  return source.slice(from, to);
}

test("migration 073 mirrors remain byte-identical", () => {
  assert.equal(timestamped, canonical);
});

test("both package state changes start with the shared exact-platform preview", () => {
  const approve = between(ownerApp, "async function ownerAppApprovePackage(", "async function ownerAppSchedulePackage(");
  const schedule = between(ownerApp, "async function ownerAppSchedulePackage(", "async function ownerAppPreviewPackageAction(");
  const preview = between(ownerApp, "async function ownerAppPreviewPackageAction(", "async function ownerAppCommitPackagePreview(");
  assert.match(approve, /ownerAppPreviewPackageAction\(id, "approve"\)/);
  assert.match(schedule, /ownerAppPreviewPackageAction\(id, "manual_schedule"\)/);
  assert.match(preview, /typeof openPlatformPreviewDialog !== "function"/);
  assert.match(preview, /Nothing was approved or scheduled/);
  assert.match(preview, /content_package_preview_snapshot/);
  assert.match(preview, /expectedChannels = \["x", "instagram", "facebook", "website"\]/);
  assert.match(preview, /openPlatformPreviewDialog/);
  assert.match(preview, /onConfirm: \(\) => ownerAppCommitPackagePreview\(id, snapshot\)/);
  assert.ok(preview.indexOf('sb.rpc("content_package_preview_snapshot"') < preview.indexOf("openPlatformPreviewDialog({"));
  assert.doesNotMatch(ownerApp, /sb\.rpc\("approve_content_package"/);
  assert.doesNotMatch(ownerApp, /sb\.rpc\("schedule_content_package"/);
});

test("every exact card carries target, copy, media plan, and proposed time", () => {
  const items = between(ownerApp, "function ownerAppPackagePreviewItems(", "function ownerAppPackageStatus(");
  assert.match(items, /account: variant\?\.account_label/);
  assert.match(items, /accountId: variant\?\.target_id/);
  assert.match(items, /title: variant\?\.title/);
  assert.match(items, /text: variant\?\.body/);
  assert.match(items, /scheduledFor: proposedFor/);
  assert.match(items, /Exact media plan: \$\{JSON\.stringify\(mediaPlan\)\}/);
  assert.match(items, /Accessibility text:/);
  assert.match(items, /planning record only; it cannot call a provider or auto-post/i);
  assert.match(ownerApp, /Proposed manual-work time/);
  assert.match(ownerApp, /Preview &amp; place on schedule/);
});

test("the confirmation submits only server-bound preview evidence", () => {
  const commit = between(ownerApp, "async function ownerAppCommitPackagePreview(", "async function ownerAppUnschedulePackage(");
  assert.match(commit, /acknowledge_content_package_preview/);
  assert.match(commit, /commit_content_package_preview/);
  assert.match(commit, /p_receipt_id: snapshot\.receipt_id/);
  assert.match(commit, /p_preview_version: snapshot\.version/);
  assert.match(commit, /p_preview_hash: snapshot\.preview_hash/);
  assert.match(commit, /p_target_hash: snapshot\.target_hash/);
  assert.match(commit, /p_variant_hashes: snapshot\.variant_hashes/);
  assert.ok(commit.indexOf('sb.rpc("acknowledge_content_package_preview"') < commit.indexOf('sb.rpc("commit_content_package_preview"'));
  assert.match(commit, /no provider publishing was activated/);
});

test("the database stores and enforces the complete durable receipt", () => {
  assert.match(canonical, /create table if not exists public\.content_package_preview_receipts/);
  assert.match(canonical, /approved_preview_version text not null default ''/);
  assert.match(canonical, /approved_preview_package_hash text not null default ''/);
  assert.match(canonical, /approved_preview_variant_hashes jsonb not null default '\{\}'::jsonb/);
  assert.match(canonical, /approved_preview_target_hash text not null default ''/);
  assert.match(canonical, /approved_preview_scheduled_for timestamptz/);
  assert.match(canonical, /preview_session_id text not null default ''/);
  assert.match(canonical, /expires_at timestamptz not null/);
  assert.match(canonical, /acknowledged_at timestamptz/);
  assert.match(canonical, /consumed_at timestamptz/);
  assert.match(canonical, /create or replace function public\.acknowledge_content_package_preview/);
  assert.match(canonical, /content_package_variant_hashes/);
  assert.match(canonical, /content_package_preview_targets/);
  assert.match(canonical, /create constraint trigger assert_content_package_preview/);
  assert.match(canonical, /deferrable initially deferred/);
  assert.match(canonical, /Content, media, target, or proposed time changed after preview/);
  assert.match(canonical, /receipt\.proposed_for=new\.approved_preview_scheduled_for/);
  assert.match(canonical, /receipt\.acknowledged_at is not null/);
  assert.match(canonical, /receipt\.consumed_at is not null/);
});

test("copy, media, package, account, and schedule-state changes invalidate evidence", () => {
  assert.match(canonical, /create or replace function public\.invalidate_content_package_approval\(\)/);
  assert.match(canonical, /invalidation_reason='content or media changed'/);
  assert.match(canonical, /create or replace function public\.guard_content_package_material_edit\(\)/);
  assert.match(canonical, /invalidation_reason='package material changed'/);
  assert.match(canonical, /invalidate_content_package_preview_on_ledger_target/);
  assert.match(canonical, /invalidate_content_package_preview_on_connection_target/);
  assert.match(canonical, /invalidation_reason='assigned account target changed'/);
  assert.match(canonical, /clear_content_package_preview_on_state_change/);
  assert.match(canonical, /invalidation_reason='package target time or state changed'/);
});

test("legacy direct RPCs are terminal and manual scheduling never enters a provider queue", () => {
  assert.match(canonical, /Deprecated: use the exact content-package platform preview gate/);
  assert.match(canonical, /revoke all on function public\.approve_content_package\(uuid\),\s*public\.schedule_content_package\(uuid,timestamptz,text\)/);
  assert.match(canonical, /revoke insert,update,delete on public\.persona_content_packages/);
  const commit = between(canonical, "create or replace function public.commit_content_package_preview(", "create or replace function public.invalidate_content_package_approval(");
  assert.match(commit, /status='scheduled',scheduled_for=p_scheduled_for/);
  assert.match(commit, /persona_content_variants set status='scheduled'/);
  assert.doesNotMatch(commit, /post_drafts|provider_post|net\.http|functions\/v1|pg_cron|cron\./i);
  assert.match(canonical, /planning records only/);
});

test("manual schedule requires exact targets and every planned media asset", () => {
  const snapshot = between(canonical, "create or replace function public.content_package_preview_snapshot_for_owner(", "create or replace function public.content_package_preview_snapshot(");
  assert.match(snapshot, /p_action='manual_schedule'[\s\S]*target\.value->>'determinable'/);
  assert.match(snapshot, /Choose one exact account or site for every platform/);
  assert.match(snapshot, /jsonb_array_elements\(variant\.media_plan\)/);
  assert.match(snapshot, /Attach every planned media asset/);
  const items = between(ownerApp, "function ownerAppPackagePreviewItems(", "function ownerAppPackageStatus(");
  assert.match(items, /mediaItems/);
  assert.match(items, /requiresExactTarget: scheduling/);
  assert.match(items, /exactTargetReady: variant\?\.target_determinable === true/);
  assert.match(items, /requiredMediaMissing: scheduling/);
});
