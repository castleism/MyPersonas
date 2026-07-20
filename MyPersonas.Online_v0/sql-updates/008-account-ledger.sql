-- AliaSpaces private account ledger.
-- Stores account inventory metadata only. There is deliberately no password,
-- secret, token, recovery-code, or credential column.

create table if not exists public.account_ledger (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null references public.profiles(id) on delete cascade,
  persona_id uuid references public.personas(id) on delete set null,
  provider text not null,
  username text default '',
  login_email text default '',
  url text default '',
  notes text default '',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table public.account_ledger enable row level security;

drop policy if exists "account ledger owner only" on public.account_ledger;
create policy "account ledger owner only" on public.account_ledger for all
  using (auth.uid() = owner)
  with check (auth.uid() = owner and (persona_id is null or owns_persona(persona_id)));

create index if not exists account_ledger_owner_idx
  on public.account_ledger (owner, created_at desc);
create index if not exists account_ledger_persona_idx
  on public.account_ledger (persona_id);

comment on table public.account_ledger is
  'Owner-only metadata inventory of external accounts; never stores credentials or secrets.';
