-- 034-post-draft-target.sql
-- The scheduled publisher needs (a) which Facebook Page a draft posts to, and
-- (b) a 'publishing' claim state so overlapping cron runs can't double-post.
-- Additive; owner-scoped RLS already covers the table.

alter table public.post_drafts
  add column if not exists facebook_ledger_id text not null default ''
    check (char_length(facebook_ledger_id) <= 64);

create index if not exists post_drafts_fbledger_idx
  on public.post_drafts (facebook_ledger_id) where facebook_ledger_id <> '';

-- Allow a transient 'publishing' claim state (set atomically before a draft posts).
alter table public.post_drafts drop constraint if exists post_drafts_status_check;
alter table public.post_drafts add constraint post_drafts_status_check
  check (status in ('draft','approved','scheduled','publishing','posted','failed','skipped'));

-- Due-work index for the publisher.
create index if not exists post_drafts_due_scheduled_idx
  on public.post_drafts (scheduled_for)
  where status = 'scheduled';
