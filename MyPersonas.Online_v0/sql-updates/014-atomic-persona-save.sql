-- 014-atomic-persona-save.sql
-- Saves the owner-editable persona row, public links, and private note in one
-- transaction so a partial browser/network failure cannot delete child rows.

create or replace function public.save_persona_bundle(
  p_persona_id uuid,
  p_persona jsonb,
  p_links jsonb,
  p_note text
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_id uuid;
  v_handle text;
  v_name text;
  v_visibility text;
  v_ai_backend uuid;
  v_top8 jsonb := coalesce(p_persona -> 'top8', '[]'::jsonb);
  v_linked jsonb := coalesce(p_persona -> 'linked', '[]'::jsonb);
  v_modules jsonb := coalesce(p_persona -> 'modules', '{}'::jsonb);
begin
  if v_uid is null then
    raise exception 'Authentication required';
  end if;
  if jsonb_typeof(coalesce(p_persona, 'null'::jsonb)) <> 'object' then
    raise exception 'Persona data must be an object';
  end if;
  if octet_length(p_persona::text) > 100000 then
    raise exception 'Persona data is too large';
  end if;
  if jsonb_typeof(coalesce(p_links, 'null'::jsonb)) <> 'array'
      or jsonb_array_length(p_links) > 100 then
    raise exception 'Links must be an array of at most 100 items';
  end if;
  if jsonb_typeof(v_top8) <> 'array' or jsonb_array_length(v_top8) > 8 then
    raise exception 'Top 8 must be an array of at most 8 personas';
  end if;
  if jsonb_typeof(v_linked) <> 'array' then
    raise exception 'Linked personas must be an array';
  end if;
  if jsonb_typeof(v_modules) <> 'object' then
    raise exception 'Page modules must be an object';
  end if;

  v_handle := lower(trim(coalesce(p_persona ->> 'handle', '')));
  v_name := trim(coalesce(p_persona ->> 'name', ''));
  v_visibility := coalesce(nullif(p_persona ->> 'visibility', ''), 'public');
  if v_handle !~ '^[a-z0-9._]{3,30}$' then
    raise exception 'Invalid persona handle';
  end if;
  if v_name = '' or char_length(v_name) > 256 then
    raise exception 'Persona name is required and must be 256 characters or less';
  end if;
  if v_visibility not in ('public', 'unlisted', 'private') then
    raise exception 'Invalid persona visibility';
  end if;
  if char_length(coalesce(p_note, '')) > 20000 then
    raise exception 'Private note must be 20000 characters or less';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_links) as item(value)
    where jsonb_typeof(value) <> 'object'
       or char_length(coalesce(value ->> 'platform', '')) > 50
       or char_length(coalesce(value ->> 'handle', '')) > 500
       or char_length(coalesce(value ->> 'url', '')) > 4000
  ) then
    raise exception 'A persona link is invalid or too long';
  end if;

  begin
    v_ai_backend := nullif(p_persona ->> 'ai_backend', '')::uuid;
  exception when invalid_text_representation then
    raise exception 'Invalid AI backend';
  end;
  if v_ai_backend is not null and not exists (
    select 1 from public.ai_backends b
    where b.id = v_ai_backend and b.owner = v_uid
  ) then
    raise exception 'AI backend is not owned by this account';
  end if;
  if exists (
    select 1 from jsonb_array_elements_text(v_linked) as item(value)
    where value !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ) then
    raise exception 'A linked persona id is invalid';
  end if;
  if exists (
    select 1 from jsonb_array_elements_text(v_top8) as item(value)
    where value !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ) then
    raise exception 'A Top 8 persona id is invalid';
  end if;
  if exists (
    select 1 from jsonb_array_elements_text(v_linked) as linked(linked_id)
    where not exists (
      select 1 from public.personas p
      where p.id = linked_id::uuid and p.owner = v_uid
    )
  ) then
    raise exception 'A linked persona is not owned by this account';
  end if;
  if exists (
    select 1 from jsonb_array_elements_text(v_top8) as top_item(top_id)
    where not exists (
      select 1 from public.personas p
      where p.id = top_id::uuid and public.persona_visible(p.id)
    )
  ) then
    raise exception 'A Top 8 persona does not exist';
  end if;

  if p_persona_id is null then
    insert into public.personas (
      owner, handle, name, nsfw, visibility, tagline, theme, bio,
      avatar_url, banner_url, bg_url, feed_img_url, music_url, live_url,
      purpose, voice, topics, audience, hashtags, dont, ai_backend,
      top8, linked, modules
    ) values (
      v_uid, v_handle, v_name,
      coalesce((p_persona ->> 'nsfw')::boolean, false), v_visibility,
      coalesce(p_persona ->> 'tagline', ''),
      coalesce(p_persona ->> 'theme', '#ff4fa3'),
      coalesce(p_persona ->> 'bio', ''),
      coalesce(p_persona ->> 'avatar_url', ''),
      coalesce(p_persona ->> 'banner_url', ''),
      coalesce(p_persona ->> 'bg_url', ''),
      coalesce(p_persona ->> 'feed_img_url', ''),
      coalesce(p_persona ->> 'music_url', ''),
      coalesce(p_persona ->> 'live_url', ''),
      coalesce(p_persona ->> 'purpose', ''),
      coalesce(p_persona ->> 'voice', ''),
      coalesce(p_persona ->> 'topics', ''),
      coalesce(p_persona ->> 'audience', ''),
      coalesce(p_persona ->> 'hashtags', ''),
      coalesce(p_persona ->> 'dont', ''),
      v_ai_backend, v_top8, v_linked, v_modules
    ) returning id into v_id;
  else
    select p.id into v_id from public.personas p
      where p.id = p_persona_id and p.owner = v_uid for update;
    if v_id is null then
      raise exception 'Owned persona not found';
    end if;
    if exists (
      select 1 from jsonb_array_elements_text(v_linked) as linked(linked_id)
      where linked_id::uuid = v_id
    ) then
      raise exception 'A persona cannot link to itself';
    end if;
    update public.personas set
      handle = v_handle,
      name = v_name,
      nsfw = coalesce((p_persona ->> 'nsfw')::boolean, false),
      visibility = v_visibility,
      tagline = coalesce(p_persona ->> 'tagline', ''),
      theme = coalesce(p_persona ->> 'theme', '#ff4fa3'),
      bio = coalesce(p_persona ->> 'bio', ''),
      avatar_url = coalesce(p_persona ->> 'avatar_url', ''),
      banner_url = coalesce(p_persona ->> 'banner_url', ''),
      bg_url = coalesce(p_persona ->> 'bg_url', ''),
      feed_img_url = coalesce(p_persona ->> 'feed_img_url', ''),
      music_url = coalesce(p_persona ->> 'music_url', ''),
      live_url = coalesce(p_persona ->> 'live_url', ''),
      purpose = coalesce(p_persona ->> 'purpose', ''),
      voice = coalesce(p_persona ->> 'voice', ''),
      topics = coalesce(p_persona ->> 'topics', ''),
      audience = coalesce(p_persona ->> 'audience', ''),
      hashtags = coalesce(p_persona ->> 'hashtags', ''),
      dont = coalesce(p_persona ->> 'dont', ''),
      ai_backend = v_ai_backend,
      top8 = v_top8,
      linked = v_linked,
      modules = v_modules
    where id = v_id;
  end if;

  delete from public.persona_links where persona_id = v_id;
  insert into public.persona_links (persona_id, platform, handle, url, sort)
  select v_id,
    coalesce(nullif(trim(link ->> 'platform'), ''), 'other'),
    coalesce(link ->> 'handle', ''),
    coalesce(link ->> 'url', ''),
    ordinality::integer - 1
  from jsonb_array_elements(p_links) with ordinality as links(link, ordinality);

  delete from public.private_notes where persona_id = v_id;
  if trim(coalesce(p_note, '')) <> '' then
    insert into public.private_notes (persona_id, content)
    values (v_id, trim(p_note));
  end if;

  return v_id;
end;
$$;

revoke all on function public.save_persona_bundle(uuid,jsonb,jsonb,text)
  from public, anon, authenticated;
grant execute on function public.save_persona_bundle(uuid,jsonb,jsonb,text)
  to authenticated;

comment on function public.save_persona_bundle(uuid,jsonb,jsonb,text) is
  'Atomically saves one owned persona and replaces its public links and private note.';
