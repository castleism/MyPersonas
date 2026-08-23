import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (value) => readFile(path.join(root, value), "utf8");
const migrationPath = "MyPersonas.Online_v0/sql-updates/049-persona-relationships-projects-businesses.sql";
const mirrorPath = "supabase/migrations/20260822140000_persona_relationships_projects_businesses.sql";
const migration = await read(migrationPath);

const parentEdges = [
  ["castleborn.rohan", "castleborn.avi"],
  ["castleborn.maria", "castleborn.avi"],
  ["castleborn.rohan", "castleborn.lilly"],
  ["castleborn.sophia", "castleborn.lilly"],
  ["castleborn.adeola", "castleborn.brom"],
  ["castleborn.alexei", "castleborn.brom"],
  ["castleborn.adeola", "castleborn.zara"],
  ["castleborn.alexei", "castleborn.zara"],
  ["castleborn.cillian", "castleborn.song"],
  ["castleborn.akiko", "castleborn.song"],
  ["castleborn.cillian", "castleborn.rhythm"],
  ["castleborn.akiko", "castleborn.rhythm"],
  ["castleborn.cillian", "castleborn.lyric"],
  ["castleborn.akiko", "castleborn.lyric"],
  ["castleborn.kunuk", "castleborn.adam"],
  ["castleborn.yarra", "castleborn.adam"],
  ["justiceright", "castleborn.fenrir"],
  ["castleborn.sophia", "castleborn.fenrir"],
  ["justiceright", "castleborn.hecatia"],
  ["castleborn.sophia", "castleborn.hecatia"],
];

const partnerEdges = [
  ["castleborn.adeola", "castleborn.alexei"],
  ["castleborn.cillian", "castleborn.akiko"],
  ["castleborn.kunuk", "castleborn.yarra"],
  ["justiceright", "castleborn.sophia"],
];

const projectHandles = [
  "wais", "justiceright", "castleborn.rohan", "castleborn.maria",
  "castleborn.alexei", "castleborn.cillian", "castleborn.akiko",
  "castleborn.yarra", "castleborn.sophia", "castleborn.kunuk",
  "castleborn.avi", "castleborn.lilly", "castleborn.brom", "castleborn.zara",
  "castleborn.song", "castleborn.rhythm", "castleborn.lyric", "castleborn.adam",
  "castleborn.fenrir", "castleborn.hecatia", "castleborn.adeola",
];

test("migration mirror is identical and all seven tables are owner-bound", async () => {
  assert.equal(await read(mirrorPath), migration);
  assert.match(migration, /begin;[\s\S]*commit;/i);
  for (const table of [
    "persona_family_relationships", "persona_projects", "persona_project_memberships",
    "project_resources", "businesses", "business_mission_items",
    "business_persona_memberships",
  ]) {
    assert.match(migration, new RegExp(`create table if not exists public\\.${table}`));
    assert.match(migration, new RegExp(`alter table public\\.${table} enable row level security`));
  }
  assert.match(migration, /foreign key \(group_id, owner\)[\s\S]*?references public\.persona_groups\(id, owner\)/);
  assert.equal((migration.match(/foreign key \((?:from|to)_persona_id, owner\)[\s\S]*?references public\.personas\(id, owner\) on delete cascade/g) || []).length, 2);
});

test("family graph is normalized, cycle-safe, private by default, and RPC-only for writes", () => {
  assert.match(migration, /relationship_type in \('parent_of','partner'\)/);
  assert.match(migration, /relationship_type <> 'partner' or from_persona_id < to_persona_id/);
  assert.match(migration, /with recursive descendants/);
  assert.match(migration, /raise exception 'A parent relationship cannot create an ancestry cycle'/);
  assert.match(migration, /perform 1 from public\.profiles where id = new\.owner for update/);
  assert.match(migration, /create or replace function public\.my_persona_family/);
  assert.match(migration, /'sibling'::text relationship_label[\s\S]*?count\(distinct my_parent\.from_persona_id\)/);
  assert.match(migration, /revoke all on public\.persona_family_relationships,[\s\S]*?from public, anon, authenticated/);
  assert.match(migration, /grant select on public\.persona_family_relationships,[\s\S]*?to authenticated/);
  assert.doesNotMatch(migration, /grant (?:insert|update|delete|all)[^;]*persona_family_relationships[^;]*to authenticated/i);
  assert.match(migration, /create or replace function public\.set_persona_family_relationship/);
});

test("Castleborn family seed exactly matches current existing-persona canon", () => {
  const seed = migration.slice(migration.indexOf("-- Exact Castleborn seed."));
  const parentBlock = seed.match(
    /with edge\(parent_handle,child_handle\) as \(values([\s\S]*?)\)\s*insert into public\.persona_family_relationships/
  );
  const partnerBlock = seed.match(
    /with edge\(left_handle,right_handle\) as \(values([\s\S]*?)\)\s*insert into public\.persona_family_relationships/
  );
  assert.ok(parentBlock, "parent seed block");
  assert.ok(partnerBlock, "partner seed block");
  const pairs = (block) => [...block.matchAll(/\('([^']+)','([^']+)'\)/g)]
    .map((match) => [match[1], match[2]]);

  assert.equal(parentEdges.length, 20);
  assert.equal(partnerEdges.length, 4);
  assert.deepEqual(pairs(parentBlock[1]), parentEdges);
  assert.deepEqual(pairs(partnerBlock[1]), partnerEdges);
  for (const [from, to] of [...parentEdges, ...partnerEdges]) {
    assert.ok(migration.includes(`('${from}','${to}')`), `${from} -> ${to}`);
  }
  assert.doesNotMatch(migration, /castleborn\.abel/i);
  assert.doesNotMatch(migration, /\bEnki\b/i);
  assert.match(migration, /'owner_only','working','castleborn-parent-lineage-2026-08-22'/);
  assert.match(migration, /required same-owner personas are missing/);
});

test("WAIS manages the exact private Castleborn project without becoming an auth principal", () => {
  const seed = migration.slice(migration.indexOf("-- Exact Castleborn seed."));
  const expectedBlock = seed.match(/v_expected text\[\] := array\[([\s\S]*?)\];/);
  assert.ok(expectedBlock, "Castleborn project roster block");
  const seededHandles = [...expectedBlock[1].matchAll(/'([^']+)'/g)]
    .map((match) => match[1]);
  assert.equal(projectHandles.length, 21);
  assert.deepEqual(seededHandles, projectHandles);
  for (const handle of projectHandles) assert.ok(migration.includes(`'${handle}'`), handle);
  assert.match(migration, /case when persona\.handle='wais' then 'manager' else 'member' end/);
  assert.match(migration, /values\(v_owner,'castleborn','Castleborn',[\s\S]*?'active','owner_only'\)/);
  assert.match(migration, /persona roles do not grant authentication authority/i);
  assert.match(seed, /persona\.handle=any\(v_expected\)/);
  assert.match(migration, /project_resources[\s\S]*?account_ledger_id[\s\S]*?access_mode[\s\S]*?connection_state/);
  assert.match(migration, /Never stores passwords, API keys, OAuth tokens, or database credentials/i);
  assert.doesNotMatch(seed, /insert into public\.project_resources/i);
});

test("business page and titles are draft-first presentation data with a narrow public projection", () => {
  const seed = migration.slice(migration.indexOf("-- Exact Castleborn seed."));
  assert.match(migration, /public_title[\s\S]*?char_length\(public_title\) <= 120/);
  assert.match(migration, /membership_visibility[\s\S]*?title_visibility/);
  assert.match(migration, /values\(v_owner,'castleborn','Castleborn','','','draft','owner_only',null\)/);
  assert.doesNotMatch(seed, /Spokesperson/);
  assert.doesNotMatch(seed, /insert into public\.business_persona_memberships/i);
  assert.match(migration, /A published business page must be public/);
  assert.match(migration, /business\.page_status='published'[\s\S]*?business\.visibility='public'/);
  assert.match(migration, /membership\.title_visibility='public'/);
  assert.match(migration, /persona\.visibility='public'/);
  assert.match(migration, /friends\/followers tiers deliberately[\s\S]*?fail closed/i);
});

test("owner mutation RPCs validate same-owner resources and keep public reads secret-free", () => {
  for (const fn of [
    "set_persona_family_relationship", "delete_persona_family_relationship",
    "save_persona_project", "set_persona_project_membership", "save_project_resource",
    "save_business_profile", "set_business_persona_membership", "save_business_mission_item",
  ]) {
    assert.match(migration, new RegExp(`create or replace function public\\.${fn}`));
  }
  assert.match(migration, /Both personas must belong to this account/);
  assert.match(migration, /Owned account ledger entry not found/);
  assert.match(migration, /Owned business not found/);
  assert.match(migration, /Public family projection exposes only explicit public edges/);
  assert.doesNotMatch(migration.match(/create or replace function public\.business_page_by_slug[\s\S]*?\$\$;/)?.[0] || "", /owner_notes|resource_locator|account_ledger_id/);
});

test("persona Settings can create, edit, remove, and scope direct family connections", async () => {
  const governance = await read("MyPersonas.Online_v0/platform-governance.js");
  const card = governance.slice(
    governance.indexOf("function governanceOrganizationCard"),
    governance.indexOf("function governanceSecurityCard"),
  );
  assert.match(governance, /governanceMaybe\("persona_family_relationships"/);
  assert.match(card, /id="govFamilyKind"/);
  assert.match(card, /id="govFamilyRelative"/);
  assert.match(card, /id="govFamilyVisibility"/);
  for (const visibility of ["owner_only", "friends", "followers", "public"]) {
    assert.match(card, new RegExp(`<option value="${visibility}">`));
  }
  assert.match(card, /governanceEditFamilyRelationship/);
  assert.match(card, /governanceDeleteFamilyRelationship/);
  assert.match(card, /sb\.rpc\("set_persona_family_relationship"[\s\S]{0,420}p_visibility:document\.getElementById\("govFamilyVisibility"\)/);
  assert.match(card, /sb\.rpc\("delete_persona_family_relationship"/);
  assert.match(card, /Sibling labels are derived safely from shared parent connections/);
});

test("handoff records unresolved canon and the production approval gates", async () => {
  const doc = await read("MyPersonas.Online_v0/CASTLEBORN-RELATIONSHIPS-PROJECT-BUSINESS.md");
  assert.match(doc, /Implemented and tested locally/i);
  assert.match(doc, /not pushed, applied to the linked database,[\s\S]*deployed,[\s\S]*or verified live/i);
  assert.match(doc, /Abel Atiq is canon-only and has no MyPersonas row/);
  assert.match(doc, /Enki has no persona row or\s+resolved surname/);
  assert.match(doc, /21 memberships total/);
  assert.match(doc, /blank,\s+owner-only, and `draft`/);
  assert.match(doc, /exact Castleborn database\/provider/);
  assert.match(doc, /Account export includes the family, group, project, resource, business, business-review,[\s\S]*and publication-governance rows/i);
  assert.match(doc, /UUID-remapped restore recreates owner data[\s\S]*private\/draft\/paused states/i);
});
