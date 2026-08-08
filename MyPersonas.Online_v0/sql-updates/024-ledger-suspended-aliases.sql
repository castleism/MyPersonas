-- 024-ledger-suspended-aliases.sql
-- Adds a "suspended" checkbox and an unlimited comma-separated aliases field to
-- saved accounts (account_ledger). Owner-run in the Supabase SQL editor. Additive.

alter table public.account_ledger add column if not exists suspended boolean not null default false;
alter table public.account_ledger add column if not exists aliases text not null default '';

-- account_ledger is already client-writable; include the new columns explicitly.
grant update (suspended, aliases) on public.account_ledger to authenticated;
