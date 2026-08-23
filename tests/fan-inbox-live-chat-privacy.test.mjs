import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (value) => readFile(path.join(root, value), "utf8");

test("fan-facing chat requires owner-visibility consent and offers honest retention modes", async () => {
  const html = await read("MyPersonas.Online_v0/index.html");
  assert.match(html, /The human owner can see this chat\./);
  assert.match(html, /Save this conversation/);
  assert.match(html, /temporarily stored only while this window is open/i);
  assert.match(html, /deleted when you close it/i);
  assert.match(html, /automatically expire after 30 minutes idle/i);
  assert.match(html, /not added to persona memory/i);
  assert.match(html, /I understand the persona owner can see my messages/);
  assert.match(html, /roleLabel=\{assistant:"AI",owner:"Owner",system:"Notice"\}/);
  assert.match(html, /action:"close"/);
  assert.match(html, /keepalive:true/);
  assert.match(html, /window\.addEventListener\("pagehide"/);
  assert.match(html, /ownerVisibilityAccepted:true/);
});

test("owner mobile inbox exposes history and finite labeled live takeover", async () => {
  const [html, owner] = await Promise.all([
    read("MyPersonas.Online_v0/index.html"),
    read("MyPersonas.Online_v0/owner-app.js"),
  ]);
  assert.match(html, /data-view="fan-inbox"/);
  assert.match(html, /view==="fan-inbox"/);
  assert.match(owner, /function renderOwnerFanInbox/);
  assert.match(owner, /Saved chats remain here until deleted/);
  assert.match(owner, /Private-session chats are visible only while open/);
  assert.match(owner, /\[5, 15, 30, 60\]/);
  assert.match(owner, /start_fan_chat_live/);
  assert.match(owner, /stop_fan_chat_live/);
  assert.match(owner, /send_owner_fan_chat_message/);
  assert.match(owner, /Send as Owner/);
  assert.match(owner, /AI replies pause/);
});

test("migration 046 enforces privacy mode, cleanup, owner isolation, and AI-live exclusion", async () => {
  const sql = await read("MyPersonas.Online_v0/sql-updates/046-fan-inbox-live-chat-privacy.sql");
  assert.match(sql, /retention_mode text not null default 'saved'/);
  assert.match(sql, /retention_mode in \('saved','ephemeral'\)/);
  assert.match(sql, /privacy_notice_version text not null default 'legacy-owner-review-v1'/);
  assert.match(sql, /'owner-visible-v2', now\(\)/);
  assert.match(sql, /role in \('fan','assistant','owner','system'\)/);
  assert.match(sql, /create table if not exists public\.fan_chat_usage_receipts/);
  assert.match(sql, /source_message_id uuid not null unique/);
  assert.match(sql, /from public\.fan_chat_usage_receipts/);
  assert.doesNotMatch(sql.match(/create table if not exists public\.fan_chat_usage_receipts[\s\S]*?\n\);/)?.[0] || "", /\bcontent\b/);
  assert.match(sql, /owner_live_until/);
  assert.match(sql, /p_minutes not in \(5,15,30,60\)/);
  assert.match(sql, /response_pending and v_session\.response_lease_expires_at > now\(\)/);
  assert.match(sql, /response_pending = not v_owner_live/);
  assert.match(sql, /close_ephemeral_fan_chat/);
  assert.match(sql, /purge_expired_ephemeral_fan_chats/);
  assert.match(sql, /discard_empty_fan_chat_session/);
  assert.match(sql, /fan-chat-ephemeral-cleanup/);
  assert.match(sql, /requires pg_cron for the ephemeral-chat deletion promise/);
  assert.match(sql, /cleanup_deleted_fan_chat_notification/);
  assert.match(sql, /auth\.uid\(\)/);
  assert.match(sql, /Start a live-chat window before replying as the owner/);
  assert.match(sql, /Fan chat is disabled or globally paused/);
  assert.match(sql, /This legacy chat did not record the current owner-visibility consent/);
  assert.match(sql, /revoke insert, update, delete on public\.fan_chat_messages from authenticated/);
  assert.doesNotMatch(sql, /grant execute on function public\.(?:ensure_fan_chat_session|close_ephemeral_fan_chat|purge_expired_ephemeral_fan_chats)[\s\S]{0,180}to (?:public|anon|authenticated)/);
});

test("public fan-chat endpoint authenticates the visitor session and skips AI during owner live", async () => {
  const source = await read("supabase/functions/fan-chat/index.ts");
  assert.match(source, /visitorHash\(personaId, visitorToken\)/);
  assert.match(source, /\.eq\("visitor_key_hash", visitorKeyHash\)/);
  assert.match(source, /ensureFanChatSession/);
  assert.match(source, /discardEmptyFanChatSession/);
  assert.match(source, /retentionChoices: \["saved", "ephemeral"\]/);
  assert.match(source, /body\.ownerVisibilityAccepted !== true/);
  assert.match(source, /action === "poll"/);
  assert.match(source, /action === "close"/);
  assert.match(source, /\.eq\("publication_state", "published"\)/);
  assert.match(source, /isPublishedFanChatPersona/);
  assert.match(source, /reason: "persona_unavailable",\s*messages: \[\]/);
  assert.match(source, /if \(ownerLive\)/);
  assert.match(source, /deliveredToOwner: true/);
  assert.match(source, /row\.role !== "owner"/);
  assert.doesNotMatch(source, /Access-Control-Allow-Origin"\s*:\s*"\*"/);
});

test("fan notifications contain no private message body", async () => {
  const sql = await read("MyPersonas.Online_v0/sql-updates/046-fan-inbox-live-chat-privacy.sql");
  const fn = sql.match(/create or replace function public\.notify_owner_fan_message\(\)[\s\S]*?\n\$\$;/)?.[0] || "";
  assert.match(fn, /Open the private fan inbox to review the conversation/);
  assert.doesNotMatch(fn, /new\.content/);
  assert.match(fn, /'fan-inbox\/' \|\| new\.session_id/);
});
