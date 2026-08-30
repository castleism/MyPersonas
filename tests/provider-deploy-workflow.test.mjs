import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const workflow = await readFile(path.join(root, ".github/workflows/supabase-deploy.yml"), "utf8");
const pagesWorkflow = await readFile(path.join(root, ".github/workflows/pages.yml"), "utf8");

test("provider deployment remains owner-triggered and migration-readback gated", () => {
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /\n\s+push:/);
  assert.match(workflow, /provider-publish/);
  assert.match(workflow, /PROVIDER-MIGRATIONS-VERIFIED/);
  assert.match(workflow, /provider migrations 065 through 075/i);
  assert.match(workflow, /Deployment blocked: SUPABASE_ACCESS_TOKEN is not configured/);
});

test("provider deployment uses an exact reviewed function allowlist", () => {
  const start = workflow.indexOf("- name: Deploy reviewed provider functions");
  const end = workflow.indexOf("- name: Deploy all reviewed edge functions", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const step = workflow.slice(start, end);
  for (const functionName of [
    "approve-post-draft",
    "meta-oauth", "meta-post", "run-post-queue",
    "twitter-oauth", "twitter-post",
    "discord-oauth", "discord-post",
    "youtube-oauth", "youtube-post",
    "tiktok-oauth", "tiktok-post",
    "twitch-oauth", "twitch-action",
    "patreon-oauth", "patreon-handoff",
    "wix-oauth", "wix-draft",
    "wordpress-oauth", "wordpress-draft",
    "reddit-oauth", "reddit-post",
    "delete-account",
  ]) assert.match(step, new RegExp(`\\b${functionName.replaceAll("-", "\\-")}\\b`));
  assert.doesNotMatch(step, /supabase functions deploy\s+--project-ref/);
});

test("provider-capable site deployment requires both migration ledgers", () => {
  assert.match(pagesWorkflow, /MIGRATIONS-VERIFIED/);
  assert.match(pagesWorkflow, /PROVIDER-MIGRATIONS-VERIFIED/);
  assert.match(pagesWorkflow, /provider migrations 065 through 075/i);
  assert.match(pagesWorkflow, /--include '\/cms-connector-ui\.js'/);
});
