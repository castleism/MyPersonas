-- 027-noo-waitlist.sql
-- Waitlist table for the nooyouniverse.com landing page (Cillian / Noo YouNiverse).
-- Anonymous visitors may INSERT an email; anon may never read, update, or delete.
-- Run in the Supabase SQL editor (project nwsqyuucwzihruszocge) or via migration tooling.

create table if not exists public.noo_waitlist (
  id         uuid primary key default gen_random_uuid(),
  email      text not null,
  source     text not null default 'nooyouniverse.com',
  created_at timestamptz not null default now(),
  constraint noo_waitlist_email_format
    check (email ~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$')
);

-- Case-insensitive dedupe (client also lowercases before submit).
create unique index if not exists noo_waitlist_email_unique
  on public.noo_waitlist (lower(email));

alter table public.noo_waitlist enable row level security;

drop policy if exists noo_waitlist_anon_insert on public.noo_waitlist;
create policy noo_waitlist_anon_insert
  on public.noo_waitlist
  for insert
  to anon
  with check (true);

-- Write-only surface for the public key.
grant insert (email, source) on public.noo_waitlist to anon;
revoke select, update, delete on public.noo_waitlist from anon;

comment on table public.noo_waitlist is
  'Email waitlist collected by nooyouniverse.com. Owner reads via dashboard/service role only. Delete rows on user request (data-deletion policy).';
