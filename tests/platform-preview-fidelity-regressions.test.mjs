import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const read = (relative) => readFile(path.join(root, relative), "utf8");
const [html, ownerApp, sql065, mirror065, sql069, mirror069, sql071, mirror071,
  sql072, mirror072, patreon] = await Promise.all([
  read("MyPersonas.Online_v0/index.html"),
  read("MyPersonas.Online_v0/owner-app.js"),
  read("MyPersonas.Online_v0/sql-updates/065-post-preview-approval-gate.sql"),
  read("supabase/migrations/20260830080000_post_preview_approval_gate.sql"),
  read("MyPersonas.Online_v0/sql-updates/069-agent-draft-platform-preview-gate.sql"),
  read("supabase/migrations/20260830120000_agent_draft_platform_preview_gate.sql"),
  read("MyPersonas.Online_v0/sql-updates/071-twitch-patreon-capability-foundation.sql"),
  read("supabase/migrations/20260830140000_twitch_patreon_capability_foundation.sql"),
  read("MyPersonas.Online_v0/sql-updates/072-immediate-provider-preview-receipts.sql"),
  read("supabase/migrations/20260830150000_immediate_provider_preview_receipts.sql"),
  read("supabase/functions/patreon-handoff/index.ts"),
]);

function functionBody(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist`);
  const next = source.indexOf("\nfunction ", start + 10);
  return source.slice(start, next < 0 ? source.length : next);
}

function asyncFunctionBody(source, name) {
  const start = source.indexOf(`async function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist`);
  const next = source.indexOf("\nasync function ", start + 16);
  return source.slice(start, next < 0 ? source.length : next);
}

test("X preview weighting is shared, conservative, and fail-closed for ambiguous text", () => {
  const body = functionBody(html, "platformPreviewXWeightedLength");
  const weighted = new Function(`${body}\nreturn platformPreviewXWeightedLength;`)();
  assert.deepEqual(weighted("plain ASCII"), { count: 11, exact: true, reason: "" });
  assert.deepEqual(weighted("漢字"), { count: 4, exact: true, reason: "" });
  assert.deepEqual(weighted("hello https://example.com/path"), {
    count: 29, exact: true, reason: "",
  });
  assert.equal(weighted("hello example.com").exact, false);
  assert.equal(weighted("hello https://example.com/(path)").exact, false);
  assert.equal(weighted("hello https://example.com/[path]").exact, false);
  assert.equal(weighted("👩‍💻").exact, false);
  assert.equal(weighted("a".repeat(280)).count, 280);
  assert.equal(weighted("a".repeat(281)).count, 281);

  assert.match(sql072, /v_x_weight := v_x_weight \+ v_x_url_count \* 23/);
  assert.match(sql072, /codepoint<=4351/);
  assert.match(sql072, /Exact X weighted length cannot be guaranteed/);
  assert.match(sql072, /'weightedLength',v_x_weight/);
  assert.match(sql072, /'weightingRule','x-conservative-v1'/);
  assert.doesNotMatch(sql072, /char_length\(v_text\) > 280/);
});

test("every visible copy field gets a count and ambiguous X copy blocks acknowledgement", () => {
  const bodies = ["platformPreviewProvider", "platformPreviewXWeightedLength",
    "platformPreviewCopyLimits", "platformPreviewCopyMeter"]
    .map((name) => functionBody(html, name)).join("\n");
  const meter = new Function("esc", `${bodies}\nreturn platformPreviewCopyMeter;`)(
    (value) => String(value),
  );
  const generic = meter("wordpress", "SEO", "body", "");
  assert.match(generic, /title 3 characters/);
  assert.match(generic, /copy 4 characters/);
  const uncertain = meter("twitter", "", "visit example.com", "");
  assert.match(uncertain, /data-preview-ready="failed"/);
  assert.match(uncertain, /exact X weighting is unavailable/);
  const exact = meter("twitter", "", "hello https:\/\/example.com\/path", "");
  assert.match(exact, /X weighted copy 29 \/ 280/);
  assert.match(exact, /data-preview-ready="ready"/);
});

test("multi-asset readiness updates only the matching asset status", () => {
  const source = functionBody(html, "platformPreviewSetMediaState");
  assert.match(source, /closest\("\.platformpreviewasset"\)/);
  assert.doesNotMatch(source, /closest\("\.platformpreviewmediawrap"\)/);
  const setState = new Function(
    "updatePlatformPreviewConfirmation",
    `${source}\nreturn platformPreviewSetMediaState;`,
  )(() => {});
  const status = { dataset: {}, textContent: "Loading…" };
  const overlay = {};
  const media = {
    dataset: {},
    closest(selector) {
      if (selector === ".platformpreviewasset") {
        return { querySelector: () => status };
      }
      if (selector === ".platformpreviewoverlay") return overlay;
      throw new Error(`unexpected ancestor lookup ${selector}`);
    },
  };
  setState(media, "ready", "Media ready · asset 2");
  assert.equal(media.dataset.previewReady, "ready");
  assert.equal(status.dataset.state, "ready");
  assert.equal(status.textContent, "Media ready · asset 2");
});

test("server receipts preserve the immutable schedule timezone into each rendered item", () => {
  assert.match(sql065, /'scheduledFor',v_scheduled_for,\s*'timezone',v_timezone/);
  assert.match(sql069, /timezone text not null check \(char_length\(timezone\) between 1 and 80\)/);
  assert.match(sql069, /add column if not exists timezone text/);
  assert.match(sql069, /set timezone='UTC'[\s\S]*alter column timezone set not null/);
  assert.match(sql069, /agent_draft_preview_receipts_timezone_check/);
  assert.match(sql069, /'scheduledFor',v_publish_at,'timezone',v_timezone/);
  assert.match(sql069, /pg_catalog\.pg_timezone_names/);
  assert.match(html, /p_timezone:autoTz\(\)/);

  const exactReceipt = new Function(
    `${functionBody(html, "exactOwnerPreviewReceipt")}\nreturn exactOwnerPreviewReceipt;`,
  )();
  const id = "11111111-1111-4111-8111-111111111111";
  const hash = "a".repeat(64);
  const createdAt = new Date(Date.now() - 1_000).toISOString();
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  const payload = {
    receiptVersion: "agent-draft-preview-v1", receiptId: id, receiptHash: hash,
    draftId: "draft-1", action: "draft.approve", targetId: "target-1",
    contentHash: "b".repeat(64), timezone: "America/Anchorage",
    items: [{ provider: "aliaspaces", scheduledFor: "2026-09-01T17:00:00Z" }],
  };
  const result = exactReceipt({
    receipt_id: id, receipt_hash: hash, created_at: createdAt, expires_at: expiresAt,
    preview_payload: payload,
  }, {
    version: "agent-draft-preview-v1", draftId: "draft-1", actions: ["draft.approve"],
  });
  assert.equal(result.items[0].timezone, "America/Anchorage");
});

test("Patreon binds timezone through request, handoff hash, row, receipt, and owner display", () => {
  assert.match(patreon, /const timezone = String\(body\.timezone \|\| ""\)\.trim\(\)/);
  assert.match(patreon, /p_timezone: timezone/);
  assert.match(patreon, /timezone: String\(item\.timezone \|\| ""\)/);
  assert.match(sql071, /scheduled_for timestamptz,\s*timezone text not null/);
  assert.match(sql071, /p_scheduled_for timestamptz,p_timezone text,p_preview_version text/);
  assert.match(sql071, /h\.scheduled_for,h\.timezone,h\.preview_version/);
  assert.match(sql071, /pg_catalog\.pg_timezone_names/);
  assert.match(html, /scheduledFor,timezone,previewVersion:"patreon-native-preview-v1"/);
  assert.match(html, /autoTaskDate\(handoff\.scheduledFor,handoff\.timezone\|\|autoTz\(\)\)/);
});

test("Reddit mixed body and media fails before and inside the authoritative receipt", () => {
  const preview = asyncFunctionBody(html, "publishRedditDraft");
  assert.match(preview, /String\(draft\.body\|\|""\)\.trim\(\)&&String\(draft\.media_url\|\|""\)\.trim\(\)/);
  assert.match(preview, /Reddit cannot send attached media with a self\/text post/);
  assert.match(sql072, /Reddit cannot send attached media with a self\/text post/);
  assert.match(sql072, /Reddit link media must be one credential-free https:\/\/ URL/);
  const reject = sql072.indexOf("Reddit cannot send attached media with a self/text post");
  const receipt = sql072.indexOf("'mediaUrl',case when v_is_link then v_media else '' end");
  assert.ok(reject > 0 && reject < receipt, "mixed media must fail before receipt rendering");
});

test("content-kit previews use platform-distinct placement labels", () => {
  const source = ownerApp.slice(
    ownerApp.indexOf("function ownerAppPackagePreviewItems("),
    ownerApp.indexOf("function ownerAppPackageStatus("),
  );
  const items = new Function(
    "safeHttpUrl", "autoTz", `${source}\nreturn ownerAppPackagePreviewItems;`,
  )((value) => String(value || ""), () => "UTC");
  const result = items({
    proposed_for: "2026-09-01T17:00:00Z", timezone: "America/Anchorage",
    action: "approve", variants: [
      { channel: "x", preview_provider: "twitter", title: "x", body: "x", media_plan: [] },
      { channel: "website", preview_provider: "website", title: "web", body: "web", media_plan: [] },
    ],
  });
  assert.equal(result[0].placement, "Timeline");
  assert.equal(result[1].placement, "Article");
});

test("every edited receipt migration remains byte-identical to its release mirror", () => {
  assert.equal(mirror065, sql065);
  assert.equal(mirror069, sql069);
  assert.equal(mirror071, sql071);
  assert.equal(mirror072, sql072);
});
