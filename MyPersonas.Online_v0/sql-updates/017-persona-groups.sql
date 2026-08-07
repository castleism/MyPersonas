-- 017-persona-groups.sql
-- Groups / "family": group personas that belong together. Owner-run, additive.
-- Client-writable (owner RLS + explicit grants), so the studio UI manages them directly.
-- The cross-persona context (grouped personas referencing each other's chats/research)
-- is a later agent-layer change — this migration only creates the grouping data.

create table if not exists public.persona_groups(
  id uuid primary key default gen_random_uuid(),
  owner uuid not null references public.profiles(id) on delete cascade,
  name text not null default 'Group' check (char_length(name) between 1 and 80),
  created_at timestamptz not null default now()
);
alter table public.persona_groups enable row level security;
drop policy if exists "persona_groups owner" on public.persona_groups;
create policy "persona_groups owner" on public.persona_groups for all
  using (auth.uid() = owner) with check (auth.uid() = owner);
grant select, insert, update, delete on public.persona_groups to authenticated;

create table if not exists public.persona_group_members(
  group_id uuid not null references public.persona_groups(id) on delete cascade,
  persona_id uuid not null,
  owner uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (group_id, persona_id),
  foreign key (persona_id, owner) references public.personas(id, owner) on delete cascade
);
alter table public.persona_group_members enable row level security;
drop policy if exists "persona_group_members owner" on public.persona_group_members;
create policy "persona_group_members owner" on public.persona_group_members for all
  using (auth.uid() = owner)
  with check (auth.uid() = owner and exists (
    select 1 from public.personas p where p.id = persona_id and p.owner = auth.uid()
  ));
grant select, insert, delete on public.persona_group_members to authenticated;
