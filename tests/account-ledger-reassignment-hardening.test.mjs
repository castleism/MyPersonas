import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const sql = readFileSync(
  new URL("../MyPersonas.Online_v0/sql-updates/051-publication-social-security-governance.sql", import.meta.url),
  "utf8",
);

function functionBody(signature, nextSignature) {
  const start = sql.indexOf(signature);
  assert.notEqual(start, -1, `missing ${signature}`);
  const end = sql.indexOf(nextSignature, start + signature.length);
  assert.notEqual(end, -1, `missing boundary ${nextSignature}`);
  return sql.slice(start, end);
}

function assertAgentBeforeLedgerLocks(body) {
  const ownerAgent = body.indexOf("51051101");
  const personaAgent = body.indexOf("51051102");
  const ownerLedger = body.indexOf("51051059");
  assert.ok(ownerAgent >= 0, "owner-agent lock is required");
  assert.ok(personaAgent > ownerAgent, "persona locks must follow the owner-agent lock");
  assert.ok(ownerLedger > personaAgent, "ledger lock must follow agent-storage locks");
}

test("ledger save and assignment reject account/persona drift in agent children", () => {
  const save = functionBody(
    "create or replace function public.save_account_ledger_entry(",
    "create or replace function public.assign_account_ledger_persona(",
  );
  const assign = functionBody(
    "create or replace function public.assign_account_ledger_persona(",
    "create or replace function public.set_primary_account_ledger_entry(",
  );

  for (const body of [save, assign]) {
    assertAgentBeforeLedgerLocks(body);
    assert.match(body, /from public\.agent_destinations[\s\S]*account_id=p_ledger_id/);
    assert.match(body, /from public\.ai_tasks[\s\S]*account_id=p_ledger_id/);
    assert.match(body, /from public\.drafts[\s\S]*account_id=p_ledger_id/);
    assert.match(
      body,
      /Reassign or delete agent destinations, tasks, and drafts before moving this account/,
    );
  }
});

test("ledger deletion follows the same deadlock-safe agent lock hierarchy", () => {
  const ownerDelete = functionBody(
    "create or replace function public.delete_account_ledger_entry(",
    "create or replace function public.delete_account_ledger_for_account_service(",
  );
  const serviceDelete = functionBody(
    "create or replace function public.delete_account_ledger_for_account_service(",
    "revoke insert,update,delete on public.account_ledger",
  );

  assertAgentBeforeLedgerLocks(ownerDelete);
  assertAgentBeforeLedgerLocks(serviceDelete);
});
