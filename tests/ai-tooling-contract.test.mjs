import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const ROOT = new URL("../MyPersonas.Online_v0/", import.meta.url);

async function doc(name) {
  return readFile(new URL(name, ROOT), "utf8");
}

test("tooling plan uses the current bounded model stack", async () => {
  const text = await doc("AI-TOOLING-AND-SPRINT-PLAN.md");
  for (const required of [
    "gpt-5.6-terra",
    "claude-sonnet-5",
    "gemini-3.6-flash",
    "gpt-oss:20b",
    "embeddinggemma",
    "sonar-pro",
    "eleven_flash_v2_5",
    "gemini-3.1-flash-image",
  ]) {
    assert.match(text, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }

  for (const retired of [
    "Llama-3.1-8B",
    "Qwen-2.5-7B",
    "claude-3-5-sonnet-latest",
    "gemini-1.5-pro",
  ]) {
    assert.equal(text.includes(retired), false, `retired recommendation remains: ${retired}`);
  }
});

test("provider projects and recursive work remain bounded", async () => {
  const text = await doc("AI-TOOLING-AND-SPRINT-PLAN.md");
  assert.match(text, /Do not create projects per persona/i);
  assert.match(text, /maximum number of iterations/i);
  assert.match(text, /global stop/i);
  assert.match(text, /no auto-recharge/i);
  assert.match(text, /creating or revealing an API\/OAuth key/i);
});

test("security runbook does not overclaim SSO or MFA", async () => {
  const text = await doc("SECURITY-AND-ACCESS-RUNBOOK.md");
  assert.match(text, /Google social\/federated sign-in/i);
  assert.match(text, /not enterprise SSO/i);
  assert.match(text, /enrollment alone is not MFA enforcement/i);
  assert.match(text, /AAL1-denied and AAL2-allowed/i);
  assert.match(text, /Paid budget defaults to \$0/i);
  assert.match(text, /OpenRouter OAuth must be exchanged and stored server-side/i);
});

test("handoff separates release states and records current migration uncertainty", async () => {
  const text = await doc("SETUP-CONDUCTOR-HANDOFF.md");
  for (const state of ["local", "pushed", "deployed", "verified live", "revenue-ready", "blocked"]) {
    assert.match(text, new RegExp(`\\b${state.replace("-", "[- ]")}\\b`, "i"));
  }
  assert.match(text, /Migration 039.*Not visible/is);
  assert.match(text, /Migration 037.*Unknown/is);
  assert.match(text, /Migration 036.*dormant/is);
  assert.equal(/033\/034\/035\/037\/038\/039 applied/i.test(text), false);
});

test("50-hour board prioritizes containment and requires owner gates", async () => {
  const text = await doc("50-HOUR-COMMAND-BOARD.md");
  assert.match(text, /H0–H5.*Close Aware Of My Food and Lifegiving Compassion/is);
  assert.match(text, /PrintMason \$19 Foundations Pack/i);
  assert.match(text, /Default paid spend is \$0/i);
  assert.match(text, /Owner gate/i);
  assert.match(text, /Stop conditions/i);
});

test("roadmap records the credential and release gates as unfinished", async () => {
  const text = await doc("ROADMAP.md");
  assert.match(text, /Enforce MFA, not only enrollment/i);
  assert.match(text, /global emergency spend stop remain roadmap work/i);
  assert.match(text, /frozen\s+local validation is green[\s\S]*live\s+evidence remain open/i);
  assert.match(text, /pushes validate but deploy nothing/i);
  assert.match(text, /gemini-image.*still needs exact Google host\/path enforcement/is);
  assert.doesNotMatch(text, /\[x\] gemini-image Edge Function deployed/i);
});

test("agent role packets keep writers serialized and external actions gated", async () => {
  const text = await doc("AGENT-ROLE-PACKETS.md");
  assert.match(text, /single primary writer/i);
  assert.match(text, /read-only independent reviewer/i);
  assert.match(text, /Do not connect repositories, cloud accounts, email, social, payments, or secrets/i);
  assert.match(text, /Never retry an ambiguous provider post, email, or payment/i);
  assert.match(text, /local, tested locally, pushed, deployed, verified live, revenue-ready, blocked, not started/i);
});
