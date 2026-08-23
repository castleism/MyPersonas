-- Read-only preflight/postflight for the 2026-08-22 full-name canon migration.
-- Expected before migration: 18 NEEDS_UPDATE, Alexei OK, and Abel OPTIONAL_MISSING.
-- Expected after migration: every existing row OK; only Abel may be OPTIONAL_MISSING.
-- This output deliberately omits owner UUIDs.

with desired(handle, canonical_name, optional) as (
  values
    ('castleborn.rohan', 'Rohan Dev', false),
    ('castleborn.maria', 'Maria Luna Garcia', false),
    ('castleborn.alexei', 'Alexei Grigoriev', false),
    ('castleborn.cillian', 'Cillian O''Sullivan', false),
    ('castleborn.akiko', 'Akiko Sasaki', false),
    ('castleborn.yarra', 'Yarra Warruwi', false),
    ('castleborn.sophia', 'Sophia Ona', false),
    ('castleborn.kunuk', 'Kunuk Atiq', false),
    ('castleborn.avi', 'Avi Dev', false),
    ('castleborn.lilly', 'Lilly Dev', false),
    ('castleborn.brom', 'Brom Grigoriev', false),
    ('castleborn.zara', 'Zara Grigoriev', false),
    ('castleborn.song', 'Song O''Sasaki', false),
    ('castleborn.rhythm', 'Rhythm O''Sasaki', false),
    ('castleborn.lyric', 'Lyric O''Sasaki', false),
    ('castleborn.adam', 'Adam Atiq', false),
    ('castleborn.abel', 'Abel Atiq', true),
    ('castleborn.fenrir', 'Fenrir Ona-Right', false),
    ('castleborn.hecatia', 'Hecatia Ona-Right', false),
    ('castleborn.adeola', 'Adeola Dossou', false)
)
select
  desired.handle,
  desired.canonical_name,
  persona.id is not null as row_exists,
  persona.name as current_name,
  persona.visibility,
  case
    when persona.id is null and desired.optional then 'OPTIONAL_MISSING'
    when persona.id is null then 'REQUIRED_MISSING'
    when persona.name = desired.canonical_name then 'OK'
    else 'NEEDS_UPDATE'
  end as status
from desired
left join public.personas as persona using (handle)
order by desired.handle;

with target_handles(handle) as (
  values
    ('castleborn.rohan'), ('castleborn.maria'), ('castleborn.alexei'),
    ('castleborn.cillian'), ('castleborn.akiko'), ('castleborn.yarra'),
    ('castleborn.sophia'), ('castleborn.kunuk'), ('castleborn.avi'),
    ('castleborn.lilly'), ('castleborn.brom'), ('castleborn.zara'),
    ('castleborn.song'), ('castleborn.rhythm'), ('castleborn.lyric'),
    ('castleborn.adam'), ('castleborn.abel'), ('castleborn.fenrir'),
    ('castleborn.hecatia'), ('castleborn.adeola')
)
select
  count(*) as rows_found,
  count(distinct persona.owner) as distinct_owners
from target_handles
join public.personas as persona using (handle);
