-- 016-persona-title-focus-primary.sql
-- Adds Title + Focus to personas, and an is_primary marker to account_ledger.
-- Owner-run in Supabase SQL editor. Safe / additive (no data changes).
--
-- Read path: my_personas() returns `setof public.personas`, so the two new
-- persona columns appear automatically once added — no RPC change needed to READ.
-- Write path: save_persona_bundle uses a fixed column list and the client has no
-- direct UPDATE grant on personas, so a tiny security-definer writer is added.

alter table public.personas      add column if not exists title text not null default '';
alter table public.personas      add column if not exists focus text not null default '';
alter table public.account_ledger add column if not exists is_primary boolean not null default false;

-- Let clients read the new persona columns (public pages); owners already read via my_personas().
grant select (title, focus) on public.personas to anon, authenticated;
-- account_ledger is already client-writable; make sure is_primary is included.
grant update (is_primary) on public.account_ledger to authenticated;

-- Owner-only writer for the two new persona fields.
create or replace function public.set_persona_meta(p_persona_id uuid, p_title text, p_focus text)
returns void
language plpgsql
security definer
set search_path = ''
as $func$
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;
  update public.personas set
    title = left(coalesce(p_title, ''), 200),
    focus = left(coalesce(p_focus, ''), 2000)
  where id = p_persona_id and owner = auth.uid();
end;
$func$;
revoke all on function public.set_persona_meta(uuid,text,text) from public, anon, authenticated;
grant execute on function public.set_persona_meta(uuid,text,text) to authenticated;
