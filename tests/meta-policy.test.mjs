import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("Meta policy blocks the canonical cannabis personas without blocking Kunuk", async () => {
  const [shared, frontend, migration] = await Promise.all([
    readFile(path.join(repoRoot, "supabase/functions/_shared/meta-publish.ts"), "utf8"),
    readFile(path.join(repoRoot, "MyPersonas.Online_v0/index.html"), "utf8"),
    readFile(path.join(repoRoot, "MyPersonas.Online_v0/sql-updates/035-post-draft-approval-hardening.sql"), "utf8"),
  ]);

  for (const personaId of [
    "56ebe05e-78c0-4dad-8e61-bcb7d245ab7b",
    "288a472a-b286-43ae-b941-1731f406c23b",
    "a997734c-9e47-4c05-bf55-0537a1c0ad97",
  ]) {
    assert.match(shared, new RegExp(personaId));
    assert.match(migration, new RegExp(personaId));
  }

  for (const source of [shared, frontend, migration]) {
    assert.doesNotMatch(source, /traditionalfamilyvalues|tradfamilyvalues/i);
    assert.match(source, /cannacandidz/i);
    assert.match(source, /sherlockchomes/i);
  }
});
