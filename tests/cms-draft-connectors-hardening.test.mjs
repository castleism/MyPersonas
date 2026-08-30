import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
function normalizeFormattedCode(source) {
  return source
    .replace(/\s+/g, " ")
    .replace(/\(\s+/g, "(")
    .replace(/\s+\)/g, ")")
    .replace(/,\s*\)/g, ")")
    .replace(/\s+\./g, ".")
    .trim();
}

const file = async (name, encoding = "utf8") => {
  const value = await readFile(path.join(root, name), encoding);
  return encoding === "utf8" && /\.(?:ts|js)$/.test(name)
    ? normalizeFormattedCode(value)
    : value;
};

const [
  canonical,
  mirror,
  sql,
  shared,
  safeWordPressUrl,
  wixOauth,
  wixDraft,
  wordpressOauth,
  wordpressDraft,
  ownerUi,
  ownerHtml,
  config,
] = await Promise.all([
  file("MyPersonas.Online_v0/sql-updates/070-cms-draft-connectors.sql", null),
  file("supabase/migrations/20260830130000_cms_draft_connectors.sql", null),
  file("MyPersonas.Online_v0/sql-updates/070-cms-draft-connectors.sql"),
  file("supabase/functions/_shared/cms-drafts.ts"),
  file("supabase/functions/_shared/wordpress-safe-url.ts"),
  file("supabase/functions/wix-oauth/index.ts"),
  file("supabase/functions/wix-draft/index.ts"),
  file("supabase/functions/wordpress-oauth/index.ts"),
  file("supabase/functions/wordpress-draft/index.ts"),
  file("MyPersonas.Online_v0/cms-connector-ui.js"),
  file("MyPersonas.Online_v0/index.html"),
  file("supabase/config.toml"),
]);

function sliceBetween(source, start, end) {
  const from = source.indexOf(start);
  assert.notEqual(from, -1, `missing start marker: ${start}`);
  const to = source.indexOf(end, from + start.length);
  assert.notEqual(to, -1, `missing end marker: ${end}`);
  return source.slice(from, to);
}

function count(source, pattern) {
  return [...source.matchAll(pattern)].length;
}

test("CMS migration 070 and its timestamped release mirror are byte-identical", () => {
  assert.deepEqual(mirror, canonical);
  assert.match(
    config,
    /\[functions\.wix-oauth\]\s*\r?\nverify_jwt\s*=\s*false/,
  );
  assert.match(
    config,
    /\[functions\.wordpress-oauth\]\s*\r?\nverify_jwt\s*=\s*false/,
  );
  assert.match(config, /\[functions\.wix-draft\]\s*\r?\nverify_jwt\s*=\s*true/);
  assert.match(
    config,
    /\[functions\.wordpress-draft\]\s*\r?\nverify_jwt\s*=\s*true/,
  );
  assert.doesNotMatch(sql, /cron\.schedule\s*\(/i);
});

test("credentials, OAuth transactions, and attempts remain service-only and Vault-backed", () => {
  for (
    const table of [
      "cms_oauth_transactions",
      "cms_credentials",
      "cms_draft_attempts",
    ]
  ) {
    assert.match(
      sql,
      new RegExp(
        `alter table public\\.${table} enable row level security`,
        "i",
      ),
    );
  }
  assert.match(
    sql,
    /revoke all on public\.cms_oauth_transactions,public\.cms_credentials,[\s\S]*public\.cms_draft_attempts from anon,authenticated/i,
  );
  assert.match(
    sql,
    /grant all on public\.cms_oauth_transactions,public\.cms_credentials,[\s\S]*public\.cms_draft_attempts to service_role/i,
  );
  assert.match(
    sql,
    /revoke all on public\.cms_provider_drafts from anon,authenticated/i,
  );
  assert.match(
    sql,
    /grant select on public\.cms_provider_drafts to authenticated/i,
  );
  assert.match(
    sql,
    /create policy "cms provider drafts owner read"[\s\S]*owner=auth\.uid\(\)/i,
  );

  const credentialTable = sliceBetween(
    sql,
    "create table if not exists public.cms_credentials",
    "create unique index if not exists cms_credentials_owner_subject_idx",
  );
  assert.match(credentialTable, /vault_secret_id uuid not null unique/i);
  assert.doesNotMatch(
    credentialTable,
    /\baccess_token\b|\brefresh_token\b|\bapplication_password\b|\binstance_id\b|\bclient_secret\b/i,
  );
  assert.match(sql, /vault\.create_secret/);
  assert.match(sql, /vault\.update_secret/);
  assert.match(sql, /vault\.decrypted_secrets/);
  assert.match(sql, /delete_cms_credential_vault_secret/);
  assert.match(
    sql,
    /p_name not in \('wix_app_secret','wordpress_com_client_secret'\)/,
  );
  assert.match(
    sql,
    /revoke all on function public\.cms_get_app_secret_service\(text\)[\s\S]*from public,anon,authenticated/i,
  );
  assert.match(
    sql,
    /grant execute on function public\.cms_get_app_secret_service\(text\) to service_role/i,
  );

  for (const source of [wixOauth, wixDraft, wordpressOauth, wordpressDraft]) {
    assert.doesNotMatch(
      source,
      /Deno\.env\.get\(["'](?:WIX_APP_SECRET|WORDPRESS_COM_CLIENT_SECRET)["']\)/,
    );
  }
  assert.match(
    wixOauth + wixDraft,
    /loadCmsAppSecret\(service, "wix_app_secret"\)/,
  );
  assert.match(
    wordpressOauth,
    /loadCmsAppSecret\(service, "wordpress_com_client_secret"\)/,
  );
  assert.match(shared, /cms_get_app_secret_service/);
});

test("database gate binds current approval, exact target, owner account, persona, and text-only content", () => {
  const gate = sliceBetween(
    sql,
    "create or replace function public.cms_exact_preview_is_current_service",
    "revoke all on function public.cms_store_credential_service",
  );
  assert.match(gate, /d\.approval_state<>'approved'/);
  assert.match(gate, /d\.publish_state in \('publishing','published'\)/);
  assert.match(gate, /coalesce\(d\.provider_post_id,''\)<>''/);
  assert.match(gate, /trim\(coalesce\(d\.media_url,''\)\)<>''/);
  assert.match(
    gate,
    /agent_draft_hash\(d\.title,d\.body,d\.tags,d\.media_url,d\.content_kind,[\s\S]*d\.persona_id,d\.account_id,d\.platform,d\.publish_at\)/,
  );
  assert.match(
    gate,
    /where id=d\.account_id and owner=p_owner[\s\S]*provider=p_provider[\s\S]*not suspended/,
  );
  assert.match(gate, /persona_id=d\.persona_id/);
  assert.match(gate, /connection_state='connected'/);
  assert.match(gate, /agent_draft_expected_preview_target/);
  assert.match(gate, /d\.approved_content_hash=v_hash/);
  assert.match(gate, /d\.approved_preview_version='platform-preview-v1'/);
  assert.match(gate, /d\.approved_preview_target_id=c\.provider_subject/);
  assert.match(gate, /d\.approved_preview_target_id=v_target/);
  assert.match(gate, /d\.approved_preview_hash=v_preview_hash/);
});

test("the server reloads the exact gate and owner safety state around every draft claim", () => {
  assert.ok(
    count(shared, /cms_exact_preview_is_current_service/g) >= 2,
    "loadExactCmsDraft must check the durable preview gate before and after loading the snapshot",
  );
  assert.match(shared, /agent_owner_settings/);
  assert.match(shared, /automation_paused === true/);
  assert.match(
    shared,
    /credential\.provider_subject !== connection\.provider_subject/,
  );
  assert.match(
    shared,
    /draft\.approved_preview_target_id !== connection\.provider_subject/,
  );
  for (const source of [wixDraft, wordpressDraft]) {
    assert.ok(
      count(source, /loadExactCmsDraft\(/g) >= 2,
      "gate must be reloaded after the durable attempt claim",
    );
    assert.match(
      source,
      /action === "create-draft" \? await claimCmsAttemptWithPreview\(service, context, fingerprint, receiptId\) : await claimCmsAttempt\(service, context, fingerprint\)/,
    );
    assert.match(
      source,
      /fresh\.context\.connection\.provider_subject !== context\.connection\.provider_subject/,
    );
    assert.match(
      source,
      /const freshFingerprint = fresh\.context \? await cmsFingerprint\(fresh\.context\) : ""/,
    );
    assert.match(
      source,
      /freshFingerprint !== fingerprint/,
      "the provider request must keep the complete content-and-target fingerprint that was claimed",
    );
    assert.match(
      source,
      /if \(action === "create-draft"\)[\s\S]*status: "definitive_failure"[\s\S]*Nothing was sent/,
    );
    assert.ok(
      source.indexOf("const fresh = await loadExactCmsDraft") <
        source.indexOf("await createDraft(fresh.context"),
    );
  }
  assert.match(shared, /claim_cms_draft_with_preview_service/);
  assert.match(shared, /No prior provider-draft attempt exists/);
  assert.match(shared, /reconciliation cannot create a new attempt/);
  assert.match(
    sql,
    /consume_provider_action_preview_for_claim_service[\s\S]*insert into public\.cms_draft_attempts/,
    "receipt consumption and the first durable CMS attempt must share one database transaction",
  );
});

test("Wix install flow is same-browser, signed-instance, exact-site and exact-author bound", () => {
  assert.match(wixOauth, /requireAal2\(req, userClient\)/);
  assert.match(wixOauth, /sha256Hex\(ticket\)/);
  assert.match(wixOauth, /mp_wix_install=.*HttpOnly; Secure; SameSite=Lax/);
  assert.match(wixOauth, /callbackTicket !== ticket/);
  assert.match(wixOauth, /crypto\.subtle\.sign\("HMAC"/);
  assert.match(wixOauth, /constantTimeEqual\(signature, expected\)/);
  assert.match(
    wixOauth,
    /Math\.abs\(Date\.now\(\) - signedAt\) > 20 \* 60_000/,
  );
  assert.match(wixOauth, /url\.searchParams\.get\("appId"\) !== APP_ID/);
  assert.match(
    wixOauth,
    /url\.searchParams\.get\("instanceId"\) !== verified\.instanceId/,
  );
  assert.match(
    wixOauth,
    /url\.searchParams\.get\("tenantId"\) !== instance\.siteId/,
  );
  assert.match(
    wixOauth,
    /from\("cms_oauth_transactions"\)\.delete\(\)\s*\.eq\("state_hash", stateHash\)\.eq\("provider", "wix"\)\s*\.select\("owner,ledger_id,expires_at,launched_at"\)\.maybeSingle\(\)/,
    "the Wix callback must atomically consume and return its single-use install ticket",
  );
  assert.ok(
    wixOauth.indexOf(
      'const consumed = await service.from("cms_oauth_transactions").delete()',
    ) <
      wixOauth.indexOf('service.rpc("cms_store_credential_service"'),
    "Wix state must be consumed before the local credential binding is mutated",
  );
  assert.match(wixOauth, /https:\/\/www\.wix\.com\/app-installer/);
  assert.match(wixOauth, /postInstallationUrl/);
  assert.match(wixOauth, /shareUrlId/);
  assert.match(
    wixOauth,
    /\.eq\("id", ledgerId\)\.eq\("owner", owner\)\.eq\("provider", "wix"\)/,
  );
  assert.match(
    wixOauth,
    /result\?\.members\.find\(\(member\) => member\.id === memberId\)/,
  );
  assert.match(wixOauth, /async function proveManageBlogRead/);
  assert.ok(
    wixOauth.indexOf(
      "await proveManageBlogRead(result.accessToken, result.siteId)",
    ) <
      wixOauth.indexOf('service.rpc("cms_set_wix_author_service"'),
    "Manage Blog must be proven by a read before the connection is promoted",
  );
  assert.match(sql, /v_target:='wix:'\|\|c\.site_id\|\|':'\|\|p_member_id/);
  assert.doesNotMatch(
    sql,
    /granted_scopes=array\['MANAGE_BLOG'\]/,
    "do not claim Manage Blog was granted unless the installed permission was actually verified",
  );
});

test("WordPress.com OAuth is server-only, single-use, and bound to the exact recorded site and author", () => {
  assert.match(wordpressOauth, /requireAal2\(req, userClient\)/);
  assert.match(wordpressOauth, /scope", "posts"/);
  assert.match(wordpressOauth, /sha256Hex\(state\)/);
  assert.match(
    wordpressOauth,
    /mp_wordpress_oauth=.*HttpOnly; Secure; SameSite=Lax/,
  );
  assert.match(wordpressOauth, /state !== browserState/);
  assert.match(
    wordpressOauth,
    /from\("cms_oauth_transactions"\)\.delete\(\)\s*\.eq\("state_hash", stateHash\)\.eq\("provider", "wordpress"\)\s*\.select\("owner,ledger_id,requested_site,expires_at,launched_at"\)\.maybeSingle\(\)/,
    "the WordPress callback must atomically consume and return its single-use state",
  );
  const wordpressConsumeAt = wordpressOauth.indexOf(
    'const transaction = await service.from("cms_oauth_transactions").delete()',
  );
  assert.notEqual(wordpressConsumeAt, -1);
  assert.ok(
    wordpressConsumeAt <
      wordpressOauth.indexOf("const token = await exchangeCode"),
    "state must be consumed before the authorization code exchange",
  );
  assert.match(
    wordpressOauth,
    /String\(token\.client_id \|\| ""\) !== CLIENT_ID/,
  );
  assert.match(wordpressOauth, /authorId !== tokenUserId/);
  assert.match(wordpressOauth, /capabilities\.edit_posts !== true/);
  assert.match(
    wordpressOauth,
    /`wpcom:\$\{identity\.siteId\}:\$\{identity\.authorId\}`/,
  );
  assert.match(
    wordpressOauth,
    /const requestedBlog = normalizeWordPressSiteUrl\(String\(ledger\.url \|\| ""\)\) \|\| ""/,
  );
  assert.match(wordpressOauth, /requested_site: requestedBlog/);
  assert.match(
    wordpressOauth,
    /const requestedSite = normalizeWordPressSiteUrl\(String\(transaction\.data\.requested_site \|\| ""\)\)/,
  );
  assert.match(wordpressOauth, /identity\.siteUrl !== requestedSite/);
  assert.doesNotMatch(
    wordpressOauth,
    /new URL\(identity\.siteUrl\)\.hostname\.toLowerCase\(\) !== requestedSite\.toLowerCase\(\)/,
    "hostname-only matching can bind the wrong subdirectory or multisite WordPress site",
  );
  assert.doesNotMatch(wordpressOauth, /action === ["']complete["']/);
  assert.match(wordpressOauth, /pkce: false/);
  assert.match(wordpressOauth, /does not advertise PKCE/);
});

test("self-hosted WordPress rejects internal, redirected, or mutable destination URLs", () => {
  assert.match(safeWordPressUrl, /url\.protocol !== "https:"/);
  assert.match(
    safeWordPressUrl,
    /url\.username \|\| url\.password \|\| url\.search \|\| url\.hash/,
  );
  assert.match(safeWordPressUrl, /url\.port !== "443"/);
  assert.match(safeWordPressUrl, /hostname === "localhost"/);
  assert.match(safeWordPressUrl, /\.endsWith\("\.local"\)/);
  assert.match(safeWordPressUrl, /\.endsWith\("\.internal"\)/);
  assert.match(safeWordPressUrl, /\.endsWith\("\.home\.arpa"\)/);
  assert.match(safeWordPressUrl, /a === 10|a === 127/);
  assert.match(safeWordPressUrl, /a === 169 && b === 254/);
  assert.match(safeWordPressUrl, /a === 172 && b >= 16 && b <= 31/);
  assert.match(safeWordPressUrl, /a === 192 && b === 168/);
  assert.match(safeWordPressUrl, /Deno\.resolveDns\(hostname, "A"\)/);
  assert.match(safeWordPressUrl, /Deno\.resolveDns\(hostname, "AAAA"\)/);
  assert.match(safeWordPressUrl, /addresses\.length > 0 && addresses\.every/);
  assert.match(safeWordPressUrl, /redirect: "error"/);
  assert.match(
    wordpressOauth,
    /safeWordPressFetch\(siteUrl, "\/wp-json\/wp\/v2\/users\/me\?context=edit"/,
  );
  assert.match(wordpressOauth, /capabilities\.edit_posts !== true/);
  assert.match(wordpressOauth, /application_password: applicationPassword/);
  assert.match(ownerUi, /if \(passwordInput\) passwordInput\.value = ""/);
  assert.doesNotMatch(
    ownerUi,
    /(?:localStorage|sessionStorage)[\s\S]{0,160}applicationPassword/i,
  );
});

test("both provider writers expose draft/readback/reconcile/trash only", () => {
  assert.match(wixDraft, /publish: false/);
  assert.doesNotMatch(wixDraft, /publish:\s*true/);
  assert.match(wordpressDraft, /status: "draft"/);
  assert.doesNotMatch(
    wordpressDraft,
    /status:\s*["'](?:publish|future|private)["']/i,
  );
  for (const source of [wixDraft, wordpressDraft]) {
    assert.doesNotMatch(
      source,
      /action\s*===\s*["'](?:publish|schedule|publish-draft|schedule-draft)["']/i,
    );
    assert.doesNotMatch(
      source,
      /\[(?:[^\]]*["'](?:publish|schedule|publish-draft|schedule-draft)["'][^\]]*)\]\.includes\(action\)/i,
    );
    assert.match(source, /\["create-draft", "reconcile"\]\.includes\(action\)/);
    assert.match(source, /action === "verify-draft"/);
    assert.match(source, /action === "delete-draft"/);
    assert.match(source, /requireAal2\(req, userClient\)/);
  }
  assert.match(wixDraft, /permanent=false/);
  assert.match(wordpressDraft, /force=false/);
  assert.match(wixDraft + wordpressDraft, /confirmDelete !== true/);
});

test("creation and later verification read back exact title, author, content, and unpublished status", () => {
  assert.match(
    wixDraft,
    /function wixDraftMatches[\s\S]*draft\.title[\s\S]*draft\.memberId[\s\S]*UNPUBLISHED[\s\S]*extractRicosText\(draft\.richContent\) === exactPlainText/,
  );
  assert.match(
    wordpressDraft,
    /function wordpressPostMatches[\s\S]*post\.status[\s\S]*post\.author[\s\S]*nestedRaw\(post\.title\)[\s\S]*nestedRaw\(post\.content\)/,
  );
  assert.ok(
    wixDraft.indexOf("return await verifyAndRecord") >
      wixDraft.indexOf("provider_accepted_at"),
  );
  assert.ok(
    wordpressDraft.indexOf("return await verifyAndRecord") >
      wordpressDraft.indexOf("provider_accepted_at"),
  );

  const wixVerify = sliceBetween(
    wixDraft,
    'if (action === "verify-draft")',
    'if (action === "delete-draft")',
  );
  const wordpressVerify = sliceBetween(
    wordpressDraft,
    'if (action === "verify-draft")',
    'if (action === "delete-draft")',
  );
  assert.match(
    wixVerify,
    /wixDraftMatches|extractRicosText\(response\.draft\.richContent\)/,
    "Verify exact draft must detect provider-side body edits, not only title/author/status",
  );
  assert.match(
    wordpressVerify,
    /wordpressPostMatches|nestedRaw\(readback\.post\.content\)/,
    "Verify exact draft must detect provider-side body edits, not only title/author/status",
  );
});

test("unknown create outcomes never blind-retry and reconciliation fails closed on truncated result sets", () => {
  assert.match(
    shared,
    /\["claimed", "outcome_unknown", "provider_created"\]\.includes\(prior\.status\)/,
  );
  assert.match(
    sql,
    /if attempt\.status<>'definitive_failure' then[\s\S]*The existing CMS attempt must be reconciled before another provider request/,
    "the atomic create wrapper must reject an unfinished or uncertain prior provider result",
  );
  assert.match(
    sql,
    /claimed','outcome_unknown','provider_created','verified',[\s\S]*delete_claimed','delete_outcome_unknown/,
  );
  for (const source of [wixDraft, wordpressDraft]) {
    assert.match(
      source,
      /status:\s*uncertain \? "outcome_unknown" : "definitive_failure"/,
    );
    assert.match(
      source,
      /response\.status === 408 \|\| response\.status >= 500/,
    );
    assert.match(source, /reconciliationRequired: true/);
    assert.match(
      source,
      /Do not retry creation|Do not retry the create request/i,
    );
  }
  assert.match(
    wixDraft,
    /typeof total !== "number"[\s\S]*!Number\.isSafeInteger\(total\)[\s\S]*total !== rows\.length/,
    "Wix reconciliation must require trustworthy total-count metadata for the complete result set",
  );
  assert.doesNotMatch(
    wixDraft,
    /pagingMetadata[\s\S]{0,240}\?\? rows\.length/,
    "Wix must not silently substitute the returned page length when total-count evidence is absent",
  );
  assert.match(
    wordpressDraft,
    /const totalHeader = response\.headers\.get\("X-WP-Total"\) \|\| ""/,
  );
  assert.match(
    wordpressDraft,
    /\^\\d\+\$\/[\s\S]*Number\.isSafeInteger\(total\)[\s\S]*total !== rows\.length/,
    "WordPress reconciliation must require a numeric X-WP-Total equal to the complete result set",
  );
  assert.doesNotMatch(
    wordpressDraft,
    /X-WP-Total"\) \|\| rows\.length/,
    "WordPress must not silently substitute the returned page length when X-WP-Total is absent",
  );
});

test("provider Trash is exact, single-flight, reversible, and durably recoverable", () => {
  const markTrash = sliceBetween(
    sql,
    "create or replace function public.cms_mark_provider_draft_trashed_service",
    "-- Durable pre-mutation claim for a reversible provider Trash request",
  );
  const claimTrash = sliceBetween(
    sql,
    "create or replace function public.cms_claim_provider_draft_trash_service",
    "-- Browser-safe recovery state for queue hydration",
  );
  const recovery = sliceBetween(
    sql,
    "create or replace function public.my_cms_draft_recovery_status",
    "revoke all on function public.cms_store_credential_service",
  );

  assert.match(
    claimTrash,
    /provider_draft_id=p_provider_draft_id[\s\S]*exact_target_id=p_exact_target_id[\s\S]*provider_status='draft'/,
  );
  assert.match(claimTrash, /set status='delete_claimed'/);
  assert.match(claimTrash, /and status='verified'/);
  assert.match(
    markTrash,
    /set provider_status='trash',deleted_at=now\(\),updated_at=now\(\)/,
  );
  assert.match(
    markTrash,
    /and status in \('delete_claimed','delete_outcome_unknown'\)/,
  );
  assert.doesNotMatch(
    markTrash,
    /status in \([^)]*'verified'/,
    "manual finalization must not skip the durable provider-delete claim",
  );

  for (
    const [provider, source] of [["wix", wixDraft], [
      "wordpress",
      wordpressDraft,
    ]]
  ) {
    const deleteBlock = sliceBetween(
      source,
      'if (action === "delete-draft")',
      'return json(origin, 400, { error: "Unknown action" })',
    );
    const finalizeBlock = sliceBetween(
      source,
      'if (action === "finalize-trash-checkpoint")',
      provider === "wix"
        ? "const appSecret = await loadCmsAppSecret"
        : 'if (action === "verify-draft")',
    );
    assert.match(deleteBlock, /body\.confirmDelete !== true/);
    assert.match(
      deleteBlock,
      /body\.expectedProviderDraftId[\s\S]*stored\.provider_draft_id/,
    );
    assert.match(
      deleteBlock,
      /body\.expectedTargetId[\s\S]*stored\.exact_target_id/,
    );
    assert.ok(
      deleteBlock.indexOf("cms_claim_provider_draft_trash_service") <
        deleteBlock.indexOf('method: "DELETE"'),
      `${provider} must durably claim Trash before sending the provider DELETE`,
    );
    assert.match(deleteBlock, /cms_mark_provider_draft_trashed_service/);
    assert.match(deleteBlock, /localCheckpointPending: true/);
    assert.match(deleteBlock, /status: "delete_outcome_unknown"/);

    assert.match(finalizeBlock, /body\.confirmProviderTrash !== true/);
    assert.match(
      finalizeBlock,
      /body\.expectedProviderDraftId[\s\S]*stored\.provider_draft_id/,
    );
    assert.match(
      finalizeBlock,
      /body\.expectedTargetId[\s\S]*stored\.exact_target_id/,
    );
    assert.match(finalizeBlock, /cms_mark_provider_draft_trashed_service/);
    assert.match(finalizeBlock, /No provider request was sent/);
    assert.doesNotMatch(
      finalizeBlock,
      /fetch\(|wordpressFetch\(|wixAccessToken\(|getWixDraft\(/,
      `${provider} local-checkpoint recovery must not send another provider request`,
    );
  }

  const wixStoredAt = wixDraft.indexOf(
    'const storedResult = await service.from("cms_provider_drafts")',
  );
  assert.notEqual(wixStoredAt, -1);
  assert.ok(
    wixDraft.indexOf(
      'if (action === "finalize-trash-checkpoint")',
      wixStoredAt,
    ) <
      wixDraft.indexOf("const appSecret = await loadCmsAppSecret", wixStoredAt),
    "Wix local-checkpoint recovery must not require a fresh app token",
  );
  assert.match(
    wordpressDraft,
    /String\(payload\?\.status \|\| ""\) !== "trash"[\s\S]*status: "delete_outcome_unknown"/,
    "a WordPress 2xx response without status=trash is still an unknown outcome",
  );

  assert.match(
    recovery,
    /join public\.drafts d on d\.id=a\.draft_id and d\.owner=a\.owner/,
  );
  assert.match(recovery, /a\.owner=auth\.uid\(\)/);
  assert.match(recovery, /'delete_claimed','delete_outcome_unknown'/);
  assert.match(
    sql,
    /revoke all on function public\.my_cms_draft_recovery_status\(uuid\[\]\)[\s\S]*from public,anon;/,
  );
  assert.match(
    sql,
    /grant execute on function public\.my_cms_draft_recovery_status\(uuid\[\]\) to authenticated;/,
  );
  assert.match(
    ownerUi,
    /sb\.rpc\("my_cms_draft_recovery_status", \{ p_draft_ids: ids \}\)/,
  );
  assert.match(
    ownerUi,
    /\["delete_claimed", "delete_outcome_unknown"\]\.includes\(row\.recovery_state\)/,
  );
  assert.match(ownerUi, /trashCheckpointNeeded\.add\(row\.draft_id\)/);
  assert.match(ownerUi, /action: "finalize-trash-checkpoint"/);
  assert.match(ownerUi, /No provider request was sent/);
  assert.ok(count(ownerUi, /expectedProviderDraftId: providerDraftId/g) >= 2);
  assert.ok(count(ownerUi, /expectedTargetId: exactTargetId/g) >= 2);
});

test("owner UI always shows a platform preview immediately before a CMS provider mutation", () => {
  assert.match(ownerHtml, /data-draft-id="\$\{esc\(d\.id\)\}"/);
  assert.match(ownerHtml, /<script src="\.\/cms-connector-ui\.js\?v=/);
  const review = sliceBetween(
    ownerUi,
    "window.reviewCmsDraftHandoff",
    "window.executeCmsDraftHandoff",
  );
  const execute = sliceBetween(
    ownerUi,
    "window.executeCmsDraftHandoff",
    "window.reconcileCmsDraft",
  );
  assert.match(review, /openPlatformPreviewDialog/);
  assert.match(review, /action: "prepare-preview"/);
  assert.match(review, /prepared\.data\?\.preview/);
  assert.match(review, /\.\.\.preview/);
  assert.match(review, /acknowledge_provider_action_preview/);
  assert.match(
    review,
    /onConfirm: \(\) => acknowledgeAndExecuteCmsDraftHandoff/,
  );
  assert.match(review, /receipt\.receiptHash/);
  assert.match(execute, /requireAal2ForSensitiveAction/);
  assert.match(execute, /action: "create-draft"/);
  assert.match(execute, /receiptId/);
  assert.match(execute, /result\.status === 202/);
  assert.match(execute, /reconcileNeeded\.add\(draftId\)/);
  assert.match(
    ownerUi,
    /button\[onclick\^="markManualDraftPosted\("\][\s\S]*button\.remove\(\)/,
  );
  assert.match(
    ownerUi,
    /const textOnly = String\(draft\.media_url \|\| ""\)\.trim\(\) === ""/,
    "a malformed but nonempty media URL must not make a text-only draft appear eligible",
  );
});

test("connected CMS ledgers and provider draft evidence cannot be silently retargeted or erased", () => {
  assert.match(
    sql,
    /create trigger guard_connected_cms_ledger_change before update or delete on public\.account_ledger/,
  );
  assert.match(
    sql,
    /Disconnect the CMS authorization before deleting this ledger entry/,
  );
  assert.match(
    sql,
    /Disconnect the CMS authorization before retargeting this ledger entry/,
  );
  assert.match(
    sql,
    /draft_id uuid not null references public\.drafts\(id\) on delete restrict/,
  );
  assert.match(
    sql,
    /attempt_id uuid not null unique references public\.cms_draft_attempts\(id\) on delete restrict/,
  );
  assert.match(
    sql,
    /provider_status='draft'[\s\S]*Move every provider draft for this connection to Trash before disconnecting/,
  );
  const disconnect = sliceBetween(
    sql,
    "create or replace function public.cms_delete_credential_service",
    "create or replace function public.delete_cms_credential_vault_secret",
  );
  assert.match(disconnect, /cms_draft_attempts/);
  for (
    const status of [
      "claimed",
      "outcome_unknown",
      "provider_created",
      "delete_claimed",
      "delete_outcome_unknown",
    ]
  ) {
    assert.match(disconnect, new RegExp(`'${status}'`));
  }
  assert.match(disconnect, /reconcil|unfinished/i);

  const storeCredential = sliceBetween(
    sql,
    "create or replace function public.cms_store_credential_service",
    "create or replace function public.cms_get_credential_service",
  );
  assert.match(
    storeCredential,
    /v_has_existing and exists\([\s\S]*cms_draft_attempts/,
  );
  for (
    const status of [
      "claimed",
      "outcome_unknown",
      "provider_created",
      "delete_claimed",
      "delete_outcome_unknown",
    ]
  ) {
    assert.match(storeCredential, new RegExp(`'${status}'`));
  }
  assert.match(
    storeCredential,
    /v_has_existing and exists\([\s\S]*cms_provider_drafts[\s\S]*provider_status='draft'/,
  );
  assert.match(
    storeCredential,
    /v_existing\.provider_subject is distinct from coalesce\(p_provider_subject,''\)/,
  );
  assert.match(
    storeCredential,
    /Disconnect the existing CMS authorization before rebinding its site or author/,
  );
  assert.match(
    wixOauth,
    /if \(existing\.data\)[\s\S]*Disconnect the existing Wix authorization before installing or rebinding/,
  );
  assert.match(
    wordpressOauth,
    /\["start", "connect-self-hosted"\]\.includes\(action\)[\s\S]*if \(existing\.data\)[\s\S]*Disconnect the existing WordPress authorization before reconnecting or rebinding/,
  );
  assert.match(wixOauth, /provider_status", "draft"/);
  assert.match(wordpressOauth, /provider_status", "draft"/);

  const sourceGuard = sliceBetween(
    sql,
    "create or replace function public.guard_active_cms_source_draft_change",
    "drop trigger if exists guard_active_cms_source_draft_change",
  );
  assert.match(sourceGuard, /cms_draft_attempts/);
  assert.match(sourceGuard, /cms_provider_drafts/);
  for (
    const status of [
      "claimed",
      "outcome_unknown",
      "provider_created",
      "delete_claimed",
      "delete_outcome_unknown",
    ]
  ) {
    assert.match(sourceGuard, new RegExp(`'${status}'`));
  }
  for (
    const field of [
      "owner",
      "persona_id",
      "account_id",
      "platform",
      "title",
      "body",
      "tags",
      "media_url",
      "content_kind",
      "publish_at",
      "approved_content_hash",
    ]
  ) {
    assert.match(
      sourceGuard,
      new RegExp(`new\\.${field} is distinct from old\\.${field}`),
    );
  }
  assert.match(
    sql,
    /create trigger guard_active_cms_source_draft_change before update or delete on public\.drafts/,
  );
});
