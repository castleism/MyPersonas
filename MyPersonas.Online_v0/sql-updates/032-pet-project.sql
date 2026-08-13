-- 032-pet-project.sql
-- Per-persona "pet project" (owner request, 2026-08-13): a short label for the
-- specific product/project this persona is currently working on, shown next to
-- the persona's name and handle. Additive, owner-writable under existing RLS.

alter table public.personas
  add column if not exists pet_project text not null default '';

alter table public.personas
  drop constraint if exists personas_pet_project_len;
alter table public.personas
  add constraint personas_pet_project_len check (char_length(pet_project) <= 120);
