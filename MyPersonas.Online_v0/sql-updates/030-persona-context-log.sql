-- 030-persona-context-log.sql
-- Per-persona "context box" (owner request, 2026-08-10): a running, owner-editable
-- log that documents the persona's path along the brand roadmap and — unlike the
-- private notes field — is meant to FEED the AI so it can build coherent follow-up
-- content. Auto-appended on meaningful changes and hand-editable in the Edit form.
--
-- Additive and safe: a single nullable-with-default text column. No data migration.
-- personas is already owner-writable under existing RLS, so the column is editable
-- by the owner with no new policy. Owner-run in the Supabase SQL editor.
--
-- Apply this BEFORE shipping the matching app UI (which reads/writes context_log)
-- and BEFORE deploying the ai-proxy change that folds a bounded slice into the
-- persona system prompt. See CONTEXT-BOX-SPEC.md.

alter table public.personas
  add column if not exists context_log text not null default '';

-- Soft size guard so the log can't grow unbounded and blow the model prompt.
-- 20k chars ≈ plenty of dated entries; the app keeps a bounded recent slice in
-- the prompt regardless.
alter table public.personas
  drop constraint if exists personas_context_log_len;
alter table public.personas
  add constraint personas_context_log_len check (char_length(context_log) <= 20000);
