-- pg_dump --schema-only intentionally excludes rows and Supabase-managed
-- schemas. Recreate only deterministic empty-environment configuration needed
-- by the through-061 application schema. No production users, objects, Vault
-- rows, provider credentials, publications, schedules, or content are copied.

insert into storage.buckets(id,name,public)
values('media','media',true);

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values(
  'persona-media','persona-media',true,52428800,
  array['image/png','image/jpeg','image/webp','image/gif','video/mp4','video/webm','audio/mpeg','audio/ogg','audio/wav']::text[]
);

insert into storage.buckets(id,name,public,file_size_limit)
values('persona-docs','persona-docs',false,26214400);

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values(
  'post-approved-media','post-approved-media',true,10485760,
  array['image/jpeg','image/png','image/webp']::text[]
);

-- Legacy media remains an empty staging-only compatibility bucket. Migration
-- 064 inventories it but never imports production objects.
create policy "media public read" on storage.objects for select to public
  using(bucket_id='media');
create policy "media auth upload" on storage.objects for insert to authenticated
  with check(bucket_id='media' and (storage.foldername(name))[1]=auth.uid()::text);
create policy "media owner delete" on storage.objects for delete to authenticated
  using(bucket_id='media' and (storage.foldername(name))[1]=auth.uid()::text);

create policy "persona media public read" on storage.objects for select to public
  using(bucket_id='persona-media');
create policy "persona docs owner select" on storage.objects for select to authenticated
  using(bucket_id='persona-docs' and split_part(name,'/',1)=auth.uid()::text);
create policy "persona docs owner insert" on storage.objects for insert to authenticated
  with check(bucket_id='persona-docs' and split_part(name,'/',1)=auth.uid()::text);
create policy "persona docs owner update" on storage.objects for update to authenticated
  using(bucket_id='persona-docs' and split_part(name,'/',1)=auth.uid()::text)
  with check(bucket_id='persona-docs' and split_part(name,'/',1)=auth.uid()::text);
create policy "persona docs owner delete" on storage.objects for delete to authenticated
  using(bucket_id='persona-docs' and split_part(name,'/',1)=auth.uid()::text);

create policy "post approved media service writes only" on storage.objects
  as restrictive for all to public
  using(bucket_id<>'post-approved-media' or auth.role()='service_role')
  with check(bucket_id<>'post-approved-media' or auth.role()='service_role');

create policy "persona media service insert" on storage.objects
  as restrictive for insert to public
  with check(bucket_id<>'persona-media' or auth.role()='service_role');
create policy "persona media service update" on storage.objects
  as restrictive for update to public
  using(bucket_id<>'persona-media' or auth.role()='service_role')
  with check(bucket_id<>'persona-media' or auth.role()='service_role');
create policy "persona media service delete" on storage.objects
  as restrictive for delete to public
  using(bucket_id<>'persona-media' or auth.role()='service_role');

-- Triggers whose target tables live in auth are excluded from a public-only
-- dump even though their implementations live in public.
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
create trigger invalidate_stale_aliaspaces_email_attestations
  after update of email,email_confirmed_at on auth.users
  for each row execute function public.invalidate_stale_aliaspaces_email_attestations();
