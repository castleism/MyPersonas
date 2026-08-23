-- 048-persona-backup-relationships.sql
-- Private, owner-only main -> backup persona organization for the owner roster.
--
-- This relationship is deliberately separate from personas.linked. It never
-- changes public visibility, account bindings, automation, or public profile
-- links. The browser may read owned rows, but all writes use the authenticated
-- security-definer RPC below.

begin;

create table if not exists public.persona_backup_relationships (
  owner uuid not null references public.profiles(id) on delete cascade,
  main_persona_id uuid primary key,
  backup_persona_id uuid not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint persona_backup_not_self
    check (main_persona_id <> backup_persona_id),
  constraint persona_backup_main_owner_fk
    foreign key (main_persona_id, owner)
    references public.personas(id, owner) on delete cascade,
  constraint persona_backup_child_owner_fk
    foreign key (backup_persona_id, owner)
    references public.personas(id, owner) on delete cascade
);

create index if not exists persona_backup_relationships_owner_idx
  on public.persona_backup_relationships(owner, created_at, main_persona_id);

alter table public.persona_backup_relationships enable row level security;

drop policy if exists "persona backup owner read"
  on public.persona_backup_relationships;
create policy "persona backup owner read"
  on public.persona_backup_relationships
  for select to authenticated
  using (owner = auth.uid());

revoke all on public.persona_backup_relationships
  from public, anon, authenticated;
grant select on public.persona_backup_relationships to authenticated;
grant all on public.persona_backup_relationships to service_role;

-- Backup pairs are intentionally disjoint and one level deep. A persona can be
-- a main or a backup, never both, so the rail cannot form chains or cycles.
-- The owner profile lock serializes relationship validation for that account.
create or replace function public.enforce_persona_backup_relationship()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform 1
  from public.profiles profile
  where profile.id = new.owner
  for update;
  if not found then
    raise exception 'Backup relationship owner not found';
  end if;

  if tg_op = 'UPDATE' and (
    new.owner is distinct from old.owner or
    new.main_persona_id is distinct from old.main_persona_id
  ) then
    raise exception 'Backup relationship owner and main persona are immutable';
  end if;

  if new.main_persona_id = new.backup_persona_id then
    raise exception 'A persona cannot be its own backup';
  end if;

  if not exists (
    select 1 from public.personas persona
    where persona.id = new.main_persona_id and persona.owner = new.owner
  ) or not exists (
    select 1 from public.personas persona
    where persona.id = new.backup_persona_id and persona.owner = new.owner
  ) then
    raise exception 'Both backup relationship personas must belong to this account';
  end if;

  if exists (
    select 1
    from public.persona_backup_relationships relationship
    where relationship.owner = new.owner
      and relationship.main_persona_id <> new.main_persona_id
      and (
        relationship.main_persona_id in (new.main_persona_id, new.backup_persona_id) or
        relationship.backup_persona_id in (new.main_persona_id, new.backup_persona_id)
      )
  ) then
    raise exception 'A persona can belong to only one one-level backup pair';
  end if;

  if tg_op = 'UPDATE' then
    new.created_at := old.created_at;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

revoke all on function public.enforce_persona_backup_relationship()
  from public, anon, authenticated;

drop trigger if exists enforce_persona_backup_relationship
  on public.persona_backup_relationships;
create trigger enforce_persona_backup_relationship
  before insert or update on public.persona_backup_relationships
  for each row execute function public.enforce_persona_backup_relationship();

create or replace function public.set_persona_backup(
  p_main_persona_id uuid,
  p_backup_persona_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid := auth.uid();
begin
  if v_owner is null then
    raise exception 'Authentication required';
  end if;
  if p_main_persona_id is null then
    raise exception 'Main persona is required';
  end if;

  -- Lock before the later mutation statement so concurrent writes for this
  -- owner validate against a current, serialized relationship set.
  perform 1
  from public.profiles profile
  where profile.id = v_owner
  for update;
  if not found then
    raise exception 'Owner profile not found';
  end if;

  perform 1
  from public.personas persona
  where persona.id = p_main_persona_id and persona.owner = v_owner
  for update;
  if not found then
    raise exception 'Owned main persona not found';
  end if;

  if p_backup_persona_id is null then
    delete from public.persona_backup_relationships relationship
    where relationship.owner = v_owner
      and relationship.main_persona_id = p_main_persona_id;
    return null;
  end if;

  if p_backup_persona_id = p_main_persona_id then
    raise exception 'A persona cannot be its own backup';
  end if;

  perform 1
  from public.personas persona
  where persona.id = p_backup_persona_id and persona.owner = v_owner
  for update;
  if not found then
    raise exception 'Owned backup persona not found';
  end if;

  insert into public.persona_backup_relationships (
    owner, main_persona_id, backup_persona_id
  ) values (
    v_owner, p_main_persona_id, p_backup_persona_id
  )
  on conflict (main_persona_id) do update
  set backup_persona_id = excluded.backup_persona_id,
      updated_at = now();

  return p_backup_persona_id;
end;
$$;

revoke all on function public.set_persona_backup(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.set_persona_backup(uuid, uuid)
  to authenticated;

comment on table public.persona_backup_relationships is
  'Private owner-roster organization. It does not publish, reveal, or link either persona profile.';
comment on function public.set_persona_backup(uuid, uuid) is
  'Assigns or removes one private, owner-only, one-level backup persona relationship.';

commit;
