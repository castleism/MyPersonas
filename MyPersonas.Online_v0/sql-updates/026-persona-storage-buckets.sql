-- 026-persona-storage-buckets.sql
-- Owner-controlled persona storage (2026-08-08 privacy review decision):
--   persona-media : PUBLIC bucket for persona page art (avatars/banners). The
--                   art is already public on the site; the point is owner
--                   control (upload/replace/delete at will) — writes are
--                   RLS-scoped to the owner's own <uid>/ prefix.
--   persona-docs  : PRIVATE bucket for persona working documents (master
--                   prompts, dossiers, roadmaps). Only the owner can read or
--                   write under their own <uid>/ prefix; no public access.
-- Replaces keeping any of this in the website git repo. Owner-run in the
-- Supabase SQL editor. Safe / idempotent.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'persona-media', 'persona-media', true, 10485760,
  array['image/png','image/jpeg','image/webp','image/gif','image/svg+xml']
)
on conflict (id) do nothing;

insert into storage.buckets (id, name, public, file_size_limit)
values ('persona-docs', 'persona-docs', false, 26214400)
on conflict (id) do nothing;

-- persona-media: anyone may read (public page art), only the owner may write
-- inside their own <uid>/ folder.
drop policy if exists "persona media public read" on storage.objects;
create policy "persona media public read" on storage.objects
  for select
  using (bucket_id = 'persona-media');

drop policy if exists "persona media owner insert" on storage.objects;
create policy "persona media owner insert" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'persona-media'
    and split_part(name, '/', 1) = auth.uid()::text
  );

drop policy if exists "persona media owner update" on storage.objects;
create policy "persona media owner update" on storage.objects
  for update to authenticated
  using (
    bucket_id = 'persona-media'
    and split_part(name, '/', 1) = auth.uid()::text
  )
  with check (
    bucket_id = 'persona-media'
    and split_part(name, '/', 1) = auth.uid()::text
  );

drop policy if exists "persona media owner delete" on storage.objects;
create policy "persona media owner delete" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'persona-media'
    and split_part(name, '/', 1) = auth.uid()::text
  );

-- persona-docs: private — the owner alone, inside their own <uid>/ folder.
drop policy if exists "persona docs owner select" on storage.objects;
create policy "persona docs owner select" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'persona-docs'
    and split_part(name, '/', 1) = auth.uid()::text
  );

drop policy if exists "persona docs owner insert" on storage.objects;
create policy "persona docs owner insert" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'persona-docs'
    and split_part(name, '/', 1) = auth.uid()::text
  );

drop policy if exists "persona docs owner update" on storage.objects;
create policy "persona docs owner update" on storage.objects
  for update to authenticated
  using (
    bucket_id = 'persona-docs'
    and split_part(name, '/', 1) = auth.uid()::text
  )
  with check (
    bucket_id = 'persona-docs'
    and split_part(name, '/', 1) = auth.uid()::text
  );

drop policy if exists "persona docs owner delete" on storage.objects;
create policy "persona docs owner delete" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'persona-docs'
    and split_part(name, '/', 1) = auth.uid()::text
  );
