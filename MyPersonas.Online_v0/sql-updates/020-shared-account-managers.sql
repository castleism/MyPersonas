-- 020-shared-account-managers.sql
-- Multiple personas may manage the same Account Ledger record.
--
-- account_ledger.persona_id remains the PRIMARY manager (back-compatible with
-- every existing flow). This table adds additional co-manager personas.
-- Owner-only data; nothing here is ever publicly readable.

create table if not exists public.account_persona_links (
  ledger_id uuid not null,
  persona_id uuid not null references public.personas(id) on delete cascade,
  owner uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz default now(),
  primary key (ledger_id, persona_id),
  foreign key (ledger_id, owner)
    references public.account_ledger(id, owner) on delete cascade
);

alter table public.account_persona_links enable row level security;

drop policy if exists "account persona links owner read" on public.account_persona_links;
create policy "account persona links owner read" on public.account_persona_links
  for select using (auth.uid() = owner);

drop policy if exists "account persona links owner insert" on public.account_persona_links;
create policy "account persona links owner insert" on public.account_persona_links
  for insert with check (
    auth.uid() = owner
    and exists (select 1 from public.personas p
                where p.id = persona_id and p.owner = auth.uid())
    and exists (select 1 from public.account_ledger l
                where l.id = ledger_id and l.owner = auth.uid())
  );

drop policy if exists "account persona links owner delete" on public.account_persona_links;
create policy "account persona links owner delete" on public.account_persona_links
  for delete using (auth.uid() = owner);

revoke all on public.account_persona_links from anon, authenticated;
grant select, insert, delete on public.account_persona_links to authenticated;

create index if not exists account_persona_links_owner_idx
  on public.account_persona_links (owner);
create index if not exists account_persona_links_persona_idx
  on public.account_persona_links (persona_id);

comment on table public.account_persona_links is
  'Additional co-manager personas for a ledger account; account_ledger.persona_id stays the primary manager.';
