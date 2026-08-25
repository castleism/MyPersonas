\set ON_ERROR_STOP on

create table if not exists public.meta_owner_erasure_leases (
  owner uuid primary key references public.profiles(id) on delete cascade,
  lease_id uuid not null unique,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
grant select,insert,update,delete on public.meta_owner_erasure_leases to service_role;

create or replace function public.claim_meta_owner_erasure(
  p_owner uuid,p_lease_id uuid,p_ttl_seconds integer
)
returns text language plpgsql security definer set search_path='' as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('meta-owner:'||p_owner::text,0));
  delete from public.meta_owner_erasure_leases lease
  where lease.owner=p_owner and lease.expires_at<=now();
  if exists(select 1 from public.meta_owner_erasure_leases lease
    where lease.owner=p_owner) then return 'busy'; end if;
  insert into public.meta_owner_erasure_leases(
    owner,lease_id,expires_at
  ) values(p_owner,p_lease_id,now()+make_interval(secs=>p_ttl_seconds));
  return 'claimed';
end;
$$;
grant execute on function public.claim_meta_owner_erasure(uuid,uuid,integer)
  to service_role;

create or replace function public.release_meta_owner_erasure(
  p_owner uuid,p_lease_id uuid
)
returns boolean language plpgsql security definer set search_path='' as $$
declare v_count integer;
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('meta-owner:'||p_owner::text,0));
  delete from public.meta_owner_erasure_leases lease
  where lease.owner=p_owner and lease.lease_id=p_lease_id;
  get diagnostics v_count=row_count;
  return v_count=1;
end;
$$;
grant execute on function public.release_meta_owner_erasure(uuid,uuid)
  to service_role;

create or replace function public.lock_persona_publication_mutation(p_persona_id uuid)
returns void language plpgsql security definer set search_path='' as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('persona-publication:'||p_persona_id::text,0));
  perform 1 from public.personas persona where persona.id=p_persona_id for update;
end;
$$;
revoke all on function public.lock_persona_publication_mutation(uuid)
  from public,anon,authenticated;

insert into storage.buckets(id,public) values ('media',true)
on conflict(id) do update set public=excluded.public;

alter table public.post_drafts
  add column if not exists scheduled_for timestamptz,
  add column if not exists posted_at timestamptz,
  add column if not exists fb_published_at timestamptz,
  add column if not exists ig_published_at timestamptz,
  add column if not exists updated_at timestamptz not null default now(),
  add column if not exists approved_at timestamptz,
  add column if not exists approved_by uuid,
  add column if not exists approved_content_hash text not null default '',
  add column if not exists approved_timezone text not null default '',
  add column if not exists approved_facebook_page_id text not null default '',
  add column if not exists approved_instagram_business_id text not null default '',
  add column if not exists publish_facebook_page_id text not null default '',
  add column if not exists publish_instagram_business_id text not null default '',
  add column if not exists publish_claimed_at timestamptz,
  add column if not exists x_tweet_id text,
  add column if not exists last_error text;

-- One editable private draft and post draft exercise terminal clear/import
-- behavior without changing the public persona revision.
insert into storage.objects(id,bucket_id,name,metadata,updated_at) values
  ('06500000-0000-4000-8000-000000001001','media',
   '05900000-0000-4000-8000-000000000099/1730000000000-private.png',
   '{"size":24,"mimetype":"image/png"}'::jsonb,'2026-08-23T11:00:00Z'),
  ('06500000-0000-4000-8000-000000001002','media',
   '05900000-0000-4000-8000-000000000099/1730000000001-social.png',
   '{"size":24,"mimetype":"image/png"}'::jsonb,'2026-08-23T11:01:00Z')
on conflict(id) do nothing;

insert into public.drafts(id,owner,persona_id,media_url) values(
  '06500000-0000-4000-8000-000000002001',
  '05900000-0000-4000-8000-000000000099',
  '05900000-0000-4000-8000-000000000199',
  'https://nwsqyuucwzihruszocge.supabase.co/storage/v1/object/public/media/05900000-0000-4000-8000-000000000099/1730000000000-private.png'
);
insert into public.post_drafts(
  id,owner,persona_id,status,source_image_url,fb_image_url,targets
) values(
  '06500000-0000-4000-8000-000000002002',
  '05900000-0000-4000-8000-000000000099',
  '05900000-0000-4000-8000-000000000199','draft',
  'https://nwsqyuucwzihruszocge.supabase.co/storage/v1/object/public/media/05900000-0000-4000-8000-000000000099/1730000000000-private.png',
  'https://nwsqyuucwzihruszocge.supabase.co/storage/v1/object/public/media/05900000-0000-4000-8000-000000000099/1730000000001-social.png',
  array['facebook']::text[]
);

-- A second owned persona shares the exact legacy source with the primary
-- persona so 065 can prove declaration/current-binding isolation.
update public.personas set
  avatar_url='https://nwsqyuucwzihruszocge.supabase.co/storage/v1/object/public/media/05900000-0000-4000-8000-000000000099/1720000000000-shared.png'
where id='06400000-0000-4000-8000-000000000199';
