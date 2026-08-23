import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = await readFile(
  path.join(repoRoot, "supabase/functions/delete-account/index.ts"),
  "utf8",
);
const contentOnlySource = await readFile(
  path.join(repoRoot, "supabase/functions/erase-content/index.ts"),
  "utf8",
);
const governanceSql = await readFile(
  path.join(
    repoRoot,
    "MyPersonas.Online_v0/sql-updates/051-publication-social-security-governance.sql",
  ),
  "utf8",
);

function functionBlock(text, name) {
  const start = text.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} was not found`);
  const bodyStart = text.indexOf("{", start);
  assert.notEqual(bodyStart, -1, `${name} has no body`);
  let depth = 0;
  for (let index = bodyStart; index < text.length; index++) {
    if (text[index] === "{") depth++;
    if (text[index] === "}" && --depth === 0) {
      return text.slice(start, index + 1);
    }
  }
  assert.fail(`${name} has an unterminated body`);
}

function assertOrdered(text, needles) {
  let cursor = -1;
  for (const needle of needles) {
    const index = text.indexOf(needle, cursor + 1);
    assert.ok(index > cursor, `${JSON.stringify(needle)} must appear in order`);
    cursor = index;
  }
}

test("content erasure explicitly removes owner organization and governance rows", () => {
  const block = functionBlock(source, "eraseOwnedRows");
  for (const table of [
    "businesses",
    "persona_groups",
    "persona_publication_reviews",
    "platform_feature_requests",
    "persona_friend_settings",
    "persona_friend_invites",
    "persona_account_sync_settings",
    "persona_extension_submissions",
    "post_drafts",
    "post_approved_media_handles",
  ]) {
    assert.match(
      block,
      new RegExp(`admin\\.from\\("${table}"\\)\\.delete\\(\\)\\.eq\\("owner", uid\\)`),
      `${table} must be erased by owner`,
    );
  }

  assertOrdered(block, [
    'admin.from("post_drafts").delete().eq("owner", uid)',
    'admin.from("post_approved_media_handles").delete().eq("owner", uid)',
    'admin.from("personas").delete().eq("owner", uid)',
  ]);

  assert.match(
    block,
    /admin\.rpc\("delete_persona_org_data_for_account_service",\s*\{\s*p_owner:\s*uid,?\s*\}\)/s,
    "family, project, membership, and resource erasure must use the owner-lock-ordered service path",
  );
  assert.doesNotMatch(
    block,
    /admin\.from\("(?:project_resources|persona_projects|persona_family_relationships)"\)\.delete/,
    "organization tables must not bypass the lock-ordered service cleanup",
  );

  assert.match(
    block,
    /admin\.rpc\("delete_persona_page_builder_data_for_account_service",\s*\{\s*p_owner:\s*uid,?\s*\}\)/s,
    "page layout and private snippet erasure must use the lock-ordered service path",
  );
  assert.match(
    block,
    /admin\.rpc\("delete_revenue_review_data_for_account_service",\s*\{\s*p_owner:\s*uid,?\s*\}\)/s,
    "affiliate, revenue, and product-review data must use the lock-ordered service erasure path",
  );
  assert.match(
    block,
    /admin\.rpc\("delete_owner_research_content_data_for_account_service",\s*\{\s*p_owner:\s*uid,?\s*\}\)/s,
    "research, content-kit, notification, and activity data must use the lock-ordered service erasure path",
  );
  assert.doesNotMatch(
    block,
    /admin\.from\("(?:persona_research_settings|persona_research_briefs|persona_research_topics|persona_topic_post_plans|research_brief_annotations|persona_content_packages|persona_content_variants|owner_notifications|persona_activity_events)"\)\.delete/,
  );
  assert.match(
    block,
    /admin\.rpc\("delete_account_ledger_for_account_service",\s*\{\s*p_owner:\s*uid,?\s*\}\)/s,
    "account-ledger erasure must share the owner ledger lock",
  );
  assert.doesNotMatch(block, /admin\.from\("account_ledger"\)\.delete/);

  assertOrdered(block, [
    'admin.rpc("delete_persona_org_data_for_account_service"',
    'admin.rpc("delete_revenue_review_data_for_account_service"',
    'admin.rpc("delete_owner_research_content_data_for_account_service"',
    'admin.rpc("delete_account_ledger_for_account_service"',
    'admin.from("personas")',
  ]);
});

test("044 and 045 erasure is service-only, owner-locked, complete, and dependency ordered", () => {
  const cleanup = governanceSql.match(
    /create or replace function public\.delete_owner_research_content_data_for_account_service[\s\S]*?\n\$\$;/,
  )?.[0] || "";
  assert.ok(cleanup, "044/045 cleanup RPC was not found");
  assert.match(cleanup, /coalesce\(auth\.role\(\),''\)<>'service_role'/);
  assert.match(cleanup, /hashtextextended\(p_owner::text,51051056\)/);
  assertOrdered(cleanup, [
    "hashtextextended(p_owner::text,51051056)",
    "order by persona.id",
    "lock_persona_publication_mutation(v_persona_id)",
    "delete from public.owner_notifications",
  ]);
  for (const table of [
    "owner_notifications", "persona_activity_events", "persona_content_variants",
    "persona_content_packages", "research_brief_annotations",
    "persona_topic_post_plans", "persona_research_topics",
    "persona_research_briefs", "persona_research_settings",
  ]) {
    assert.match(cleanup, new RegExp(`delete from public\\.${table}[\\s\\S]*?owner=p_owner`), table);
    assert.match(cleanup, new RegExp(`'${table}'`), `${table} count must be returned`);
  }
  assertOrdered(cleanup, [
    "delete from public.persona_content_variants",
    "delete from public.persona_content_packages",
    "delete from public.research_brief_annotations",
    "delete from public.persona_topic_post_plans",
    "delete from public.persona_research_topics",
    "delete from public.persona_research_briefs",
    "delete from public.persona_research_settings",
  ]);
  assert.match(
    governanceSql,
    /revoke insert,update,delete on public\.persona_research_settings,[\s\S]*?public\.persona_activity_events\s+from service_role/,
  );
  assert.match(
    governanceSql,
    /grant execute on function public\.delete_owner_research_content_data_for_account_service\(uuid\)\s+to service_role/,
  );
  assert.doesNotMatch(
    governanceSql,
    /grant execute on function public\.delete_owner_research_content_data_for_account_service\(uuid\)[^;]*authenticated/i,
  );
});

test("friend security history and both follow systems are erased for owned personas", () => {
  const block = functionBlock(source, "eraseOwnedRows");
  assert.match(
    block,
    /admin\.from\("friend_request_security_events"\)\.delete\(\)\.eq\(\s*"requester_owner",\s*uid,/s,
  );
  assert.match(
    block,
    /admin\.from\("friend_request_security_events"\)\.delete\(\)\.in\(\s*"follower_persona_id",\s*batch,/s,
  );
  assert.match(
    block,
    /admin\.from\("friend_request_security_events"\)\.delete\(\)\.in\(\s*"target_persona_id",\s*batch,/s,
  );
  assert.match(
    block,
    /admin\.from\("persona_follows"\)\.delete\(\)\.in\("follower_persona_id", batch\)/,
  );
  assert.match(
    block,
    /admin\.from\("persona_follows"\)\.delete\(\)\.in\("target_persona_id", batch\)/,
  );
  assert.match(block, /for \(let start = 0; start < personaIds\.length; start \+= 100\)/);
});

test("platform security cleanup runs only on the full-account path", () => {
  const ownedRows = functionBlock(source, "eraseOwnedRows");
  assert.doesNotMatch(
    ownedRows,
    /platform_security_events|security_network_blocks/,
  );

  assertOrdered(source, [
    "if (body.keepAccount === true)",
    "return json({ deleted: true, accountDeleted: false });",
    '"platform security events by actor"',
    '"platform security events by account subject id"',
    '"legacy platform security events by account subject"',
    '"security network blocks by account subject id"',
    'admin.from("profiles").delete().eq("id", uid)',
  ]);
  assert.match(
    source,
    /admin\.from\("platform_security_events"\)\.delete\(\)\.eq\("actor_id", uid\)/,
  );
  assert.match(
    source,
    /admin\.from\("platform_security_events"\)\.delete\(\)\.eq\(\s*"subject_account_id",\s*uid,\s*\)/s,
  );
  assert.match(
    source,
    /admin\.from\("platform_security_events"\)\.delete\(\)\.eq\(\s*"subject_type",\s*"account",\s*\)\.eq\("subject_id", uid\)/s,
  );
  assert.match(
    source,
    /admin\.from\("security_network_blocks"\)\.delete\(\)\.eq\(\s*"subject_account_id",\s*uid,\s*\)/s,
  );
});

test("erase-content remains pinned to the immutable content-only handler", () => {
  assert.match(
    contentOnlySource,
    /serve\(createErasureHandler\(\{ contentOnly: true \}\)\);/,
  );
  assert.doesNotMatch(contentOnlySource, /platform_security_events|keepAccount/);
});
