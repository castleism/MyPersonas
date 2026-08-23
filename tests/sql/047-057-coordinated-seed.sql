\set ON_ERROR_STOP on

-- Seed only for a disposable PostgreSQL 16 replay database whose predecessor
-- schema matches the pre-047 MyPersonas schema. Run this before migration 047.
-- It deliberately uses old/short allowed names so 047's guarded renames are
-- exercised. No Abel row, project, family edge, business, or resource is
-- created here; migrations must create only the confirmed records.

insert into auth.users(id,email,email_confirmed_at) values(
  '04700000-0000-4000-8000-000000000001',
  'coordinated-047-057@example.test',
  now()
);

insert into public.profiles(id,email,display_name) values(
  '04700000-0000-4000-8000-000000000001',
  'coordinated-047-057@example.test',
  'Coordinated replay owner'
) on conflict(id) do update set
  email=excluded.email,display_name=excluded.display_name;

insert into public.personas(id,owner,handle,name,visibility) values
  ('04700000-0000-4000-8000-000000000101','04700000-0000-4000-8000-000000000001','wais','WAIS','private'),
  ('04700000-0000-4000-8000-000000000102','04700000-0000-4000-8000-000000000001','justiceright','Justice Right','private'),
  ('04700000-0000-4000-8000-000000000103','04700000-0000-4000-8000-000000000001','castleborn.rohan','Rohan','private'),
  ('04700000-0000-4000-8000-000000000104','04700000-0000-4000-8000-000000000001','castleborn.maria','Maria','private'),
  ('04700000-0000-4000-8000-000000000105','04700000-0000-4000-8000-000000000001','castleborn.alexei','Alexei','private'),
  ('04700000-0000-4000-8000-000000000106','04700000-0000-4000-8000-000000000001','castleborn.cillian','Cillian','private'),
  ('04700000-0000-4000-8000-000000000107','04700000-0000-4000-8000-000000000001','castleborn.akiko','Akiko','private'),
  ('04700000-0000-4000-8000-000000000108','04700000-0000-4000-8000-000000000001','castleborn.yarra','Yarra','private'),
  ('04700000-0000-4000-8000-000000000109','04700000-0000-4000-8000-000000000001','castleborn.sophia','Sophia','private'),
  ('04700000-0000-4000-8000-000000000110','04700000-0000-4000-8000-000000000001','castleborn.kunuk','Kunuk','private'),
  ('04700000-0000-4000-8000-000000000111','04700000-0000-4000-8000-000000000001','castleborn.avi','Avi','private'),
  ('04700000-0000-4000-8000-000000000112','04700000-0000-4000-8000-000000000001','castleborn.lilly','Lilly','private'),
  ('04700000-0000-4000-8000-000000000113','04700000-0000-4000-8000-000000000001','castleborn.brom','Brom','private'),
  ('04700000-0000-4000-8000-000000000114','04700000-0000-4000-8000-000000000001','castleborn.zara','Zara','private'),
  ('04700000-0000-4000-8000-000000000115','04700000-0000-4000-8000-000000000001','castleborn.song','Song','private'),
  ('04700000-0000-4000-8000-000000000116','04700000-0000-4000-8000-000000000001','castleborn.rhythm','Rhythm','private'),
  ('04700000-0000-4000-8000-000000000117','04700000-0000-4000-8000-000000000001','castleborn.lyric','Lyric','private'),
  ('04700000-0000-4000-8000-000000000118','04700000-0000-4000-8000-000000000001','castleborn.adam','Adam','private'),
  ('04700000-0000-4000-8000-000000000119','04700000-0000-4000-8000-000000000001','castleborn.fenrir','Fenrir','private'),
  ('04700000-0000-4000-8000-000000000120','04700000-0000-4000-8000-000000000001','castleborn.hecatia','Hecatia','private'),
  ('04700000-0000-4000-8000-000000000121','04700000-0000-4000-8000-000000000001','castleborn.adeola','Adeola','private');
