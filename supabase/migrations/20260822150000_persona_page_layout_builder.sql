-- 050-persona-page-layout-builder.sql
-- Safe, declarative persona-page layouts and owner-private learning snippets.
--
-- Public profiles never execute owner-supplied HTML, CSS, JavaScript, SVG, or
-- extension code. The public layout is a bounded JSON recipe whose module ids,
-- card styles, and simple text/link widgets are validated here and escaped by
-- the renderer. Learning snippets are private reference material only.

begin;

create table if not exists public.persona_page_layouts (
  persona_id uuid primary key references public.personas(id) on delete cascade,
  owner uuid not null references public.profiles(id) on delete cascade,
  schema_version smallint not null default 1 check (schema_version = 1),
  layout jsonb not null default '{"version":1,"order":["live","music","about","fan_chat","links","top8","linked","family","revenue","albums","feed"],"cards":{},"widgets":[]}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.persona_page_code_snippets (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null references public.profiles(id) on delete cascade,
  persona_id uuid,
  name text not null,
  language text not null check (language in ('html','css','json')),
  code text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint persona_page_code_snippets_persona_owner_fkey
    foreign key (persona_id, owner)
    references public.personas(id, owner) on delete cascade
);

create index if not exists persona_page_code_snippets_owner_idx
  on public.persona_page_code_snippets(owner, updated_at desc, id desc);
create index if not exists persona_page_code_snippets_persona_idx
  on public.persona_page_code_snippets(persona_id, updated_at desc, id desc);

alter table public.persona_page_layouts enable row level security;
alter table public.persona_page_code_snippets enable row level security;

drop policy if exists "page layouts owner read" on public.persona_page_layouts;
create policy "page layouts owner read" on public.persona_page_layouts
  for select to authenticated using (owner = auth.uid());

drop policy if exists "page snippets owner read" on public.persona_page_code_snippets;
create policy "page snippets owner read" on public.persona_page_code_snippets
  for select to authenticated using (owner = auth.uid());

-- Table mutation stays behind bounded RPCs. Public layout reads use the narrow
-- persona_page_layout RPC so the owner id and private snippet source never leak.
revoke all on table public.persona_page_layouts from public, anon, authenticated;
revoke all on table public.persona_page_code_snippets from public, anon, authenticated;
grant select on table public.persona_page_layouts to authenticated;
grant select on table public.persona_page_code_snippets to authenticated;

create or replace function public.validate_persona_page_layout_row()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_persona_owner uuid;
  v_item jsonb;
  v_key text;
  v_known_modules constant text[] := array[
    'live','music','about','fan_chat','links','top8','linked','family','revenue','albums','feed'
  ];
  v_known_top_keys constant text[] := array['version','order','cards','widgets'];
  v_known_card_keys constant text[] := array['span','shape','tone'];
  v_known_widget_keys constant text[] := array[
    'id','kind','title','body','label','url','span','shape','tone'
  ];
begin
  select p.owner into v_persona_owner
  from public.personas p
  where p.id = new.persona_id;

  if v_persona_owner is null or v_persona_owner <> new.owner then
    raise exception 'Page layout owner must match persona owner';
  end if;
  if tg_op = 'UPDATE'
     and (new.owner is distinct from old.owner
          or new.persona_id is distinct from old.persona_id) then
    raise exception 'Page layout owner and persona are immutable';
  end if;
  if new.schema_version <> 1 then
    raise exception 'Unsupported page layout version';
  end if;
  if jsonb_typeof(new.layout) <> 'object'
     or octet_length(new.layout::text) > 30000 then
    raise exception 'Page layout must be an object no larger than 30000 bytes';
  end if;
  if exists (
    select 1 from jsonb_object_keys(new.layout) key
    where key <> all(v_known_top_keys)
  ) then
    raise exception 'Page layout contains an unsupported field';
  end if;
  if coalesce((new.layout ->> 'version')::integer, 0) <> 1 then
    raise exception 'Page layout version must be 1';
  end if;

  if jsonb_typeof(new.layout -> 'order') <> 'array'
     or jsonb_array_length(new.layout -> 'order') > array_length(v_known_modules, 1) then
    raise exception 'Page module order must be a bounded array';
  end if;
  if exists (
    select 1 from jsonb_array_elements(new.layout -> 'order') as ordered(value)
    where jsonb_typeof(ordered.value) <> 'string'
       or not ((ordered.value #>> '{}') = any(v_known_modules))
  ) then
    raise exception 'Page module order contains an unsupported module';
  end if;
  if (
    select count(*) from jsonb_array_elements_text(new.layout -> 'order') as ordered(value)
  ) <> (
    select count(distinct ordered.value) from jsonb_array_elements_text(new.layout -> 'order') as ordered(value)
  ) then
    raise exception 'Page module order cannot contain duplicates';
  end if;

  if jsonb_typeof(coalesce(new.layout -> 'cards', '{}'::jsonb)) <> 'object' then
    raise exception 'Page card settings must be an object';
  end if;
  for v_key, v_item in
    select key, value from jsonb_each(coalesce(new.layout -> 'cards', '{}'::jsonb))
  loop
    if not (v_key = any(v_known_modules)) or jsonb_typeof(v_item) <> 'object' then
      raise exception 'Page card settings contain an unsupported module';
    end if;
    if exists (
      select 1 from jsonb_object_keys(v_item) key
      where key <> all(v_known_card_keys)
    ) then
      raise exception 'Page card settings contain an unsupported field';
    end if;
    if coalesce(v_item ->> 'span', 'half') not in ('half','full')
       or coalesce(v_item ->> 'shape', 'soft') not in ('square','soft','round')
       or coalesce(v_item ->> 'tone', 'default') not in ('default','theme','muted','glass') then
      raise exception 'Page card style is invalid';
    end if;
  end loop;

  if jsonb_typeof(coalesce(new.layout -> 'widgets', '[]'::jsonb)) <> 'array'
     or jsonb_array_length(coalesce(new.layout -> 'widgets', '[]'::jsonb)) > 12 then
    raise exception 'Page widgets must be an array of at most 12 items';
  end if;
  if (
    select count(*)
    from jsonb_array_elements(coalesce(new.layout -> 'widgets', '[]'::jsonb)) as widget(value)
  ) <> (
    select count(distinct widget.value ->> 'id')
    from jsonb_array_elements(coalesce(new.layout -> 'widgets', '[]'::jsonb)) as widget(value)
  ) then
    raise exception 'Page widget ids must be unique';
  end if;
  for v_item in
    select value from jsonb_array_elements(coalesce(new.layout -> 'widgets', '[]'::jsonb))
  loop
    if jsonb_typeof(v_item) <> 'object' then
      raise exception 'Each page widget must be an object';
    end if;
    if exists (
      select 1 from jsonb_object_keys(v_item) key
      where key <> all(v_known_widget_keys)
    ) then
      raise exception 'Page widget contains an unsupported field';
    end if;
    if coalesce(v_item ->> 'id', '') !~ '^[a-zA-Z0-9_-]{1,64}$'
       or coalesce(v_item ->> 'kind', '') not in ('text','link')
       or char_length(coalesce(v_item ->> 'title', '')) > 120
       or char_length(coalesce(v_item ->> 'body', '')) > 2000
       or char_length(coalesce(v_item ->> 'label', '')) > 120
       or char_length(coalesce(v_item ->> 'url', '')) > 2048
       or coalesce(v_item ->> 'span', 'half') not in ('half','full')
       or coalesce(v_item ->> 'shape', 'soft') not in ('square','soft','round')
       or coalesce(v_item ->> 'tone', 'default') not in ('default','theme','muted','glass') then
      raise exception 'Page widget is invalid';
    end if;
    if v_item ->> 'kind' = 'link'
       and coalesce(v_item ->> 'url', '') !~ '^https://[^[:space:]]+$' then
      raise exception 'Page link widgets require an HTTPS URL';
    end if;
    if v_item ->> 'kind' = 'text'
       and coalesce(v_item ->> 'url', '') <> '' then
      raise exception 'Text widgets cannot contain a URL';
    end if;
  end loop;

  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists enforce_persona_page_layout on public.persona_page_layouts;
create trigger enforce_persona_page_layout
before insert or update on public.persona_page_layouts
for each row execute function public.validate_persona_page_layout_row();

create or replace function public.touch_persona_page_code_snippet()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists touch_persona_page_code_snippet on public.persona_page_code_snippets;
create trigger touch_persona_page_code_snippet
before update on public.persona_page_code_snippets
for each row execute function public.touch_persona_page_code_snippet();

create or replace function public.set_persona_page_layout(
  p_persona_id uuid,
  p_layout jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid := auth.uid();
  v_saved jsonb;
begin
  if v_owner is null then
    raise exception 'Authentication required';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_persona_id::text,51051051)
  );
  if not exists (
    select 1 from public.personas p
    where p.id = p_persona_id and p.owner = v_owner
  ) then
    raise exception 'Owned persona not found';
  end if;

  insert into public.persona_page_layouts(persona_id, owner, schema_version, layout)
  values (p_persona_id, v_owner, 1, p_layout)
  on conflict (persona_id) do update
    set layout = excluded.layout,
        schema_version = 1
    where public.persona_page_layouts.owner = v_owner
  returning layout into v_saved;

  if v_saved is null then
    raise exception 'Page layout could not be saved';
  end if;
  return v_saved;
end;
$$;

create or replace function public.persona_page_layout(p_persona_id uuid)
returns table(schema_version smallint, layout jsonb)
language sql
security definer
stable
set search_path = ''
as $$
  select page.schema_version, page.layout
  from public.persona_page_layouts page
  where page.persona_id = p_persona_id
    and public.persona_visible(page.persona_id)
  limit 1;
$$;

create or replace function public.my_persona_page_code_snippets(p_persona_id uuid default null)
returns table(
  id uuid,
  persona_id uuid,
  name text,
  language text,
  code text,
  created_at timestamptz,
  updated_at timestamptz
)
language sql
security definer
stable
set search_path = ''
as $$
  select snippet.id, snippet.persona_id, snippet.name, snippet.language,
         snippet.code, snippet.created_at, snippet.updated_at
  from public.persona_page_code_snippets snippet
  where snippet.owner = auth.uid()
    and (p_persona_id is null or snippet.persona_id = p_persona_id)
  order by snippet.updated_at desc, snippet.id desc
  limit 100;
$$;

create or replace function public.save_persona_page_code_snippet(
  p_snippet_id uuid,
  p_persona_id uuid,
  p_name text,
  p_language text,
  p_code text
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid := auth.uid();
  v_id uuid := coalesce(p_snippet_id, gen_random_uuid());
begin
  if v_owner is null then
    raise exception 'Authentication required';
  end if;
  if p_persona_id is not null and not exists (
    select 1 from public.personas p
    where p.id = p_persona_id and p.owner = v_owner
  ) then
    raise exception 'Owned persona not found';
  end if;
  if trim(coalesce(p_name, '')) = '' or char_length(trim(p_name)) > 120 then
    raise exception 'Snippet name is required and must be 120 characters or less';
  end if;
  if p_language not in ('html','css','json') then
    raise exception 'Unsupported snippet language';
  end if;
  if octet_length(coalesce(p_code, '')) > 20000 then
    raise exception 'Snippet code must be 20000 bytes or less';
  end if;

  insert into public.persona_page_code_snippets(
    id, owner, persona_id, name, language, code
  ) values (
    v_id, v_owner, p_persona_id, trim(p_name), p_language, coalesce(p_code, '')
  )
  on conflict (id) do update
    set persona_id = excluded.persona_id,
        name = excluded.name,
        language = excluded.language,
        code = excluded.code
    where public.persona_page_code_snippets.owner = v_owner;

  if not exists (
    select 1 from public.persona_page_code_snippets snippet
    where snippet.id = v_id and snippet.owner = v_owner
  ) then
    raise exception 'Snippet could not be saved';
  end if;
  return v_id;
end;
$$;

create or replace function public.delete_persona_page_code_snippet(p_snippet_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid := auth.uid();
  v_deleted integer;
begin
  if v_owner is null then
    raise exception 'Authentication required';
  end if;
  delete from public.persona_page_code_snippets snippet
  where snippet.id = p_snippet_id and snippet.owner = v_owner;
  get diagnostics v_deleted = row_count;
  return v_deleted = 1;
end;
$$;

revoke all on function public.validate_persona_page_layout_row()
  from public, anon, authenticated;
revoke all on function public.touch_persona_page_code_snippet()
  from public, anon, authenticated;
revoke all on function public.set_persona_page_layout(uuid,jsonb)
  from public, anon, authenticated;
revoke all on function public.persona_page_layout(uuid)
  from public, anon, authenticated;
revoke all on function public.my_persona_page_code_snippets(uuid)
  from public, anon, authenticated;
revoke all on function public.save_persona_page_code_snippet(uuid,uuid,text,text,text)
  from public, anon, authenticated;
revoke all on function public.delete_persona_page_code_snippet(uuid)
  from public, anon, authenticated;

grant execute on function public.set_persona_page_layout(uuid,jsonb) to authenticated;
grant execute on function public.persona_page_layout(uuid) to anon, authenticated;
grant execute on function public.my_persona_page_code_snippets(uuid) to authenticated;
grant execute on function public.save_persona_page_code_snippet(uuid,uuid,text,text,text) to authenticated;
grant execute on function public.delete_persona_page_code_snippet(uuid) to authenticated;

comment on table public.persona_page_layouts is
  'Strict declarative page recipes. Never stores or executes arbitrary HTML, CSS, JavaScript, SVG, or extension code.';
comment on table public.persona_page_code_snippets is
  'Owner-private learning references. Snippet code is never returned by public page RPCs or executed by the public renderer.';
comment on function public.persona_page_layout(uuid) is
  'Returns only a visible persona public layout recipe; owner identity and private learning snippets are excluded.';

commit;
