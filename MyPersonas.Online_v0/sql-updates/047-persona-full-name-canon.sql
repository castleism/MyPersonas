-- 047-persona-full-name-canon.sql
-- Owner-confirmed Castleborn full display names, 2026-08-22.
--
-- This migration is deliberately narrow:
--   * match immutable persona handles, never a possibly duplicated first name;
--   * update only public.personas.name;
--   * tolerate a fresh database where a listed persona has not been created;
--   * fail closed if an existing row has an unexpected display name;
--   * do not create Abel Atiq's currently absent persona row.

do $$
declare
  v_entry jsonb;
  v_handle text;
  v_canonical_name text;
  v_allowed_names text[];
  v_current_name text;
begin
  for v_entry in
    select value
    from jsonb_array_elements($canon$
      [
        {"handle":"castleborn.rohan","canonical_name":"Rohan Dev","allowed_names":["Rohan","Rohan Dev"]},
        {"handle":"castleborn.maria","canonical_name":"Maria Luna Garcia","allowed_names":["Maria","Maria Luna Garcia"]},
        {"handle":"castleborn.cillian","canonical_name":"Cillian O'Sullivan","allowed_names":["Cillian","Cillian O'Sullivan"]},
        {"handle":"castleborn.akiko","canonical_name":"Akiko Sasaki","allowed_names":["Akiko","Akiko Sasaki"]},
        {"handle":"castleborn.yarra","canonical_name":"Yarra Warruwi","allowed_names":["Yarra","Yara","Yara Warruwi","Yarra Warruwi"]},
        {"handle":"castleborn.sophia","canonical_name":"Sophia Ona","allowed_names":["Sophia","Sophia Onassis","Sophia Ona"]},
        {"handle":"castleborn.kunuk","canonical_name":"Kunuk Atiq","allowed_names":["Kunuk","Kunuk Atiq"]},
        {"handle":"castleborn.avi","canonical_name":"Avi Dev","allowed_names":["Avi","Avi Dev"]},
        {"handle":"castleborn.lilly","canonical_name":"Lilly Dev","allowed_names":["Lilly","Lilly Dev"]},
        {"handle":"castleborn.brom","canonical_name":"Brom Grigoriev","allowed_names":["Brom","Brom Grigoriev"]},
        {"handle":"castleborn.zara","canonical_name":"Zara Grigoriev","allowed_names":["Zara","Zara Grigoriev"]},
        {"handle":"castleborn.song","canonical_name":"Song O'Sasaki","allowed_names":["Song","Song O'Sasaki"]},
        {"handle":"castleborn.rhythm","canonical_name":"Rhythm O'Sasaki","allowed_names":["Rhythm","Rhythm O'Sasaki"]},
        {"handle":"castleborn.lyric","canonical_name":"Lyric O'Sasaki","allowed_names":["Lyric","Lyric O'Sasaki"]},
        {"handle":"castleborn.adam","canonical_name":"Adam Atiq","allowed_names":["Adam","Adam | Contractors Club","Adam Atiq"]},
        {"handle":"castleborn.fenrir","canonical_name":"Fenrir Ona-Right","allowed_names":["Fenrir","Fenrir Ona-Right"]},
        {"handle":"castleborn.hecatia","canonical_name":"Hecatia Ona-Right","allowed_names":["Hecatia","Hecatia Ona-Right"]},
        {"handle":"castleborn.adeola","canonical_name":"Adeola Dossou","allowed_names":["Adeola","Adeola Dossou"]}
      ]
    $canon$::jsonb)
  loop
    v_handle := v_entry ->> 'handle';
    v_canonical_name := v_entry ->> 'canonical_name';

    select array_agg(value order by ordinality)
      into v_allowed_names
    from jsonb_array_elements_text(v_entry -> 'allowed_names')
      with ordinality as allowed(value, ordinality);

    select p.name
      into v_current_name
    from public.personas as p
    where p.handle = v_handle;

    if not found then
      continue;
    end if;

    if not (v_current_name = any(v_allowed_names)) then
      raise exception
        'Refusing persona canon rename for %: unexpected current name %',
        v_handle,
        v_current_name;
    end if;

    update public.personas
    set name = v_canonical_name
    where handle = v_handle
      and name is distinct from v_canonical_name;

    if exists (
      select 1
      from public.personas
      where handle = v_handle
        and name is distinct from v_canonical_name
    ) then
      raise exception 'Persona canon rename did not persist for %', v_handle;
    end if;
  end loop;
end;
$$;
