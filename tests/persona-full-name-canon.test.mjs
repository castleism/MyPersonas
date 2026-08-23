import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (value) => readFile(path.join(root, value), "utf8");

const expectedCanon = Object.freeze({
  "castleborn.rohan": "Rohan Dev",
  "castleborn.maria": "Maria Luna Garcia",
  "castleborn.alexei": "Alexei Grigoriev",
  "castleborn.cillian": "Cillian O'Sullivan",
  "castleborn.akiko": "Akiko Sasaki",
  "castleborn.yarra": "Yarra Warruwi",
  "castleborn.sophia": "Sophia Ona",
  "castleborn.kunuk": "Kunuk Atiq",
  "castleborn.avi": "Avi Dev",
  "castleborn.lilly": "Lilly Dev",
  "castleborn.brom": "Brom Grigoriev",
  "castleborn.zara": "Zara Grigoriev",
  "castleborn.song": "Song O'Sasaki",
  "castleborn.rhythm": "Rhythm O'Sasaki",
  "castleborn.lyric": "Lyric O'Sasaki",
  "castleborn.adam": "Adam Atiq",
  "castleborn.fenrir": "Fenrir Ona-Right",
  "castleborn.hecatia": "Hecatia Ona-Right",
  "castleborn.adeola": "Adeola Dossou",
});

const migrationCanon = (sql) => {
  const encoded = sql.match(/\$canon\$([\s\S]*?)\$canon\$::jsonb/);
  assert.ok(encoded, "migration needs a machine-checkable canon block");
  return Object.fromEntries(
    JSON.parse(encoded[1]).map(({ handle, canonical_name: name }) => [handle, name]),
  );
};

test("full-name source records exactly the owner-confirmed canon and open boundary", async () => {
  const source = JSON.parse(await read("MyPersonas.Online_v0/content/persona-full-name-canon-2026-08-22.json"));

  assert.equal(source.version, "2026-08-22");
  assert.equal(source.personas.length, 20);
  assert.deepEqual(
    Object.fromEntries(source.personas.filter(({ handle }) => handle).map(({ handle, full_name: name }) => [handle, name])),
    expectedCanon,
  );
  assert.deepEqual(
    source.personas.filter(({ handle }) => !handle),
    [{ handle: null, given_name: "Abel", full_name: "Abel Atiq", database_state: "canon_only_no_persona_row" }],
  );
  assert.match(source.rules.join("\n"), /No surname was supplied for Enki/);
});

test("both migration paths carry the same narrow handle-keyed rename set", async () => {
  const paths = [
    "MyPersonas.Online_v0/sql-updates/047-persona-full-name-canon.sql",
    "supabase/migrations/20260822113925_persona_full_name_canon.sql",
  ];

  for (const migrationPath of paths) {
    const sql = await read(migrationPath);
    const expectedChanges = { ...expectedCanon };
    delete expectedChanges["castleborn.alexei"];

    assert.deepEqual(migrationCanon(sql), expectedChanges, migrationPath);
    assert.match(sql, /unexpected current name/);
    assert.match(sql, /name is distinct from v_canonical_name/);
    assert.doesNotMatch(sql, /insert\s+into\s+public\.personas/i);
    assert.doesNotMatch(sql, /castleborn\.abel/);
    assert.doesNotMatch(sql, /\bEnki\b/);
  }
});

test("tracked handoff preserves the combined-family rules without reviving retired twin canon", async () => {
  const [canon, handoff, updates] = await Promise.all([
    read("MyPersonas.Online_v0/persona-briefs/2026-08-22-full-name-canon.md"),
    read("MyPersonas.Online_v0/BRAND-MANAGER-HANDOFF.md"),
    read("MyPersonas.Online_v0/persona-briefs/2026-08-10-persona-updates.md"),
  ]);

  assert.match(canon, /combined surname is \*\*O'Sasaki\*\*/);
  assert.match(canon, /combined\s+surname is \*\*Ona-Right\*\*/);
  assert.match(canon, /Do not infer one from the Atiq family entries/);
  assert.match(handoff, /Abel Atiq is confirmed/);
  assert.match(updates, /Song O'Sasaki, Rhythm O'Sasaki, and Lyric O'Sasaki are the children/);
  assert.match(updates, /not established as twins/);
});

test("tracked Akiko draft generator cannot reintroduce the first-name-only identity", async () => {
  const generator = await read("scripts/build-akiko-local-draft-pack.mjs");

  assert.match(generator, /display_name:\s*"Akiko Sasaki \/ Being Tea Co\."/);
  assert.doesNotMatch(generator, /display_name:\s*"Akiko \/ Being Tea Co\."/);
});
