\set ON_ERROR_STOP on

-- Narrow disposable-database prerequisites for migration 063. The harness
-- applies the frozen 059/060 provenance migrations first. This fixture
-- supplies only the ledgered-035 post draft fields/function and approved-media
-- bucket shape consumed directly by the forward migration.

create table if not exists storage.buckets (
  id text primary key,
  public boolean not null default false
);
grant select,update on storage.buckets to service_role;

insert into storage.buckets(id,public)
values ('post-approved-media',true)
on conflict(id) do update set public=excluded.public;

alter table public.post_drafts
  add column if not exists approved_fb_media_mime text not null default '',
  add column if not exists approved_fb_media_bytes bigint not null default 0,
  add column if not exists approved_fb_media_path text not null default '',
  add column if not exists approved_ig_media_mime text not null default '',
  add column if not exists approved_ig_media_bytes bigint not null default 0,
  add column if not exists approved_ig_media_path text not null default '',
  add column if not exists fb_post_id text,
  add column if not exists ig_media_id text;

create or replace function public.approve_and_schedule_post_draft(
  p_owner uuid,p_draft_id uuid,p_scheduled_for timestamptz,p_timezone text,
  p_fb_caption text,p_ig_caption text,p_x_caption text,p_targets text[],
  p_fb_source_url text,p_ig_source_url text,
  p_fb_media_sha256 text,p_fb_media_mime text,p_fb_media_bytes bigint,
  p_fb_media_path text,p_fb_media_url text,
  p_ig_media_sha256 text,p_ig_media_mime text,p_ig_media_bytes bigint,
  p_ig_media_path text,p_ig_media_url text
)
returns public.post_drafts language plpgsql security definer set search_path='' as $$
declare v_draft public.post_drafts%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Service role required';
  end if;
  update public.post_drafts draft set
    status='scheduled',targets=p_targets,
    fb_image_url=case when 'facebook'=any(p_targets) then p_fb_media_url else fb_image_url end,
    ig_image_url=case when 'instagram'=any(p_targets) then p_ig_media_url else ig_image_url end,
    approved_fb_media_sha256=case when 'facebook'=any(p_targets) then p_fb_media_sha256 else '' end,
    approved_fb_media_mime=case when 'facebook'=any(p_targets) then p_fb_media_mime else '' end,
    approved_fb_media_bytes=case when 'facebook'=any(p_targets) then p_fb_media_bytes else 0 end,
    approved_fb_media_path=case when 'facebook'=any(p_targets) then p_fb_media_path else '' end,
    approved_fb_media_url=case when 'facebook'=any(p_targets) then p_fb_media_url else '' end,
    approved_ig_media_sha256=case when 'instagram'=any(p_targets) then p_ig_media_sha256 else '' end,
    approved_ig_media_mime=case when 'instagram'=any(p_targets) then p_ig_media_mime else '' end,
    approved_ig_media_bytes=case when 'instagram'=any(p_targets) then p_ig_media_bytes else 0 end,
    approved_ig_media_path=case when 'instagram'=any(p_targets) then p_ig_media_path else '' end,
    approved_ig_media_url=case when 'instagram'=any(p_targets) then p_ig_media_url else '' end
  where draft.id=p_draft_id and draft.owner=p_owner
  returning * into v_draft;
  if not found then raise exception 'Draft not found'; end if;
  return v_draft;
end;
$$;
grant execute on function public.approve_and_schedule_post_draft(
  uuid,uuid,timestamptz,text,text,text,text,text[],text,text,
  text,text,bigint,text,text,text,text,bigint,text,text
) to service_role;

-- Seed one legacy approved snapshot before migration 063 adds the opaque id.
-- Its direct URL/hash remain untouched; runtime assertions backfill only the
-- new delivery id and prove that approval-state expansion is non-destructive.
insert into storage.objects(bucket_id,name,metadata) values (
  'post-approved-media',
  'owners/05900000-0000-4000-8000-000000000099/sha256/bb/'||repeat('b',64)||'.png',
  jsonb_build_object('size',12,'mimetype','image/png')
);
update public.post_drafts set
  targets=array['facebook']::text[],status='failed',
  approved_fb_media_sha256=repeat('b',64),approved_fb_media_mime='image/png',
  approved_fb_media_bytes=12,
  approved_fb_media_path='owners/05900000-0000-4000-8000-000000000099/sha256/bb/'||repeat('b',64)||'.png',
  approved_fb_media_url='https://nwsqyuucwzihruszocge.supabase.co/storage/v1/object/public/post-approved-media/owners/05900000-0000-4000-8000-000000000099/sha256/bb/'||repeat('b',64)||'.png'
where id='05900000-0000-4000-8000-000000000299';
