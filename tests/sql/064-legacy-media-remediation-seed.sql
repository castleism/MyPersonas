\set ON_ERROR_STOP on

-- Focused production-shape additions omitted by the frozen 059 fixture.
alter table storage.objects
  add column if not exists updated_at timestamptz not null default now();
alter table public.personas
  add column if not exists name text not null default '';
alter table public.drafts
  add column if not exists owner uuid references public.profiles(id) on delete cascade;
alter table public.drafts alter column persona_id drop not null;
alter table public.post_drafts alter column persona_id drop not null;

update public.personas set name='Owner A primary'
where id='05900000-0000-4000-8000-000000000199';

insert into public.profiles(id) values
  ('06400000-0000-4000-8000-000000000099')
on conflict(id) do nothing;
insert into public.personas(id,owner,handle,name) values
  ('06400000-0000-4000-8000-000000000199',
   '05900000-0000-4000-8000-000000000099','owner-a-secondary','Owner A secondary'),
  ('06400000-0000-4000-8000-000000000299',
   '06400000-0000-4000-8000-000000000099','owner-b-sentinel','Owner B sentinel')
on conflict(id) do nothing;

-- Exact legacy objects. Metadata is only a fetch bound; the Edge service
-- magic-detects and hashes the actual bytes before recording a preview.
insert into storage.objects(id,bucket_id,name,metadata,updated_at) values
  ('06400000-0000-4000-8000-000000001001','media',
   '05900000-0000-4000-8000-000000000099/1720000000000-shared.png',
   '{"size":24}'::jsonb,'2026-08-23T10:00:00Z'),
  ('06400000-0000-4000-8000-000000001002','media',
   '05900000-0000-4000-8000-000000000099/1720000000001-album.png',
   '{"size":24}'::jsonb,'2026-08-23T10:01:00Z'),
  ('06400000-0000-4000-8000-000000001003','media',
   '05900000-0000-4000-8000-000000000099/1720000000002-post.png',
   '{"size":24}'::jsonb,'2026-08-23T10:02:00Z'),
  ('06400000-0000-4000-8000-000000001004','media',
   '05900000-0000-4000-8000-000000000099/1720000000003-draft.png',
   '{"size":24}'::jsonb,'2026-08-23T10:03:00Z'),
  ('06400000-0000-4000-8000-000000001005','media',
   '05900000-0000-4000-8000-000000000099/1720000000004-source.png',
   '{"size":24}'::jsonb,'2026-08-23T10:04:00Z'),
  ('06400000-0000-4000-8000-000000001006','media',
   '05900000-0000-4000-8000-000000000099/1720000000006-x.png',
   '{"size":24}'::jsonb,'2026-08-23T10:06:00Z'),
  ('06400000-0000-4000-8000-000000001007','media',
   '05900000-0000-4000-8000-000000000099/1720000000007-product.png',
   '{"size":24}'::jsonb,'2026-08-23T10:07:00Z'),
  ('06400000-0000-4000-8000-000000001008','media',
   '06400000-0000-4000-8000-000000000099/1720000000008-secret.png',
   '{"size":24}'::jsonb,'2026-08-23T10:08:00Z')
on conflict(id) do nothing;

update public.personas set
  avatar_url='https://nwsqyuucwzihruszocge.supabase.co/storage/v1/object/public/media/05900000-0000-4000-8000-000000000099/1720000000000-shared.png',
  banner_url='https://nwsqyuucwzihruszocge.supabase.co/storage/v1/object/public/media/05900000-0000-4000-8000-000000000099/1720000000000-shared.png',
  bg_url='https://nwsqyuucwzihruszocge.supabase.co/storage/v1/object/public/media/05900000-0000-4000-8000-000000000099/1720000000005-missing.png',
  feed_img_url='https://nwsqyuucwzihruszocge.supabase.co/storage/v1/object/public/media/06400000-0000-4000-8000-000000000099/1720000000008-secret.png'
where id='05900000-0000-4000-8000-000000000199';
update public.personas set
  avatar_url='https://nwsqyuucwzihruszocge.supabase.co/storage/v1/object/public/media/06400000-0000-4000-8000-000000000099/1720000000008-secret.png'
where id='06400000-0000-4000-8000-000000000299';

insert into public.posts(id,persona_id,media_url) values(
  '06400000-0000-4000-8000-000000002001',
  '05900000-0000-4000-8000-000000000199',
  'https://nwsqyuucwzihruszocge.supabase.co/storage/v1/object/public/media/05900000-0000-4000-8000-000000000099/1720000000002-post.png'
);
insert into public.albums(id,persona_id) values(
  '06400000-0000-4000-8000-000000002002',
  '05900000-0000-4000-8000-000000000199'
);
insert into public.album_items(id,album_id,thumb_url) values(
  '06400000-0000-4000-8000-000000002003',
  '06400000-0000-4000-8000-000000002002',
  'https://nwsqyuucwzihruszocge.supabase.co/storage/v1/object/public/media/05900000-0000-4000-8000-000000000099/1720000000001-album.png'
);
insert into public.drafts(id,owner,persona_id,media_url) values
  ('06400000-0000-4000-8000-000000002004',
   '05900000-0000-4000-8000-000000000099',null,
   'https://nwsqyuucwzihruszocge.supabase.co/storage/v1/object/public/media/05900000-0000-4000-8000-000000000099/1720000000003-draft.png'),
  ('06400000-0000-4000-8000-000000002005',
   '06400000-0000-4000-8000-000000000099',
   '05900000-0000-4000-8000-000000000199',
   'https://nwsqyuucwzihruszocge.supabase.co/storage/v1/object/public/media/06400000-0000-4000-8000-000000000099/1720000000008-secret.png');

-- Simulate a pre-hardening scheduled legacy snapshot. Current guards correctly
-- reject creating this state; 064 must still inventory historical rows without
-- treating the preview-only slice as rewrite authority.
set session_replication_role=replica;
insert into public.post_drafts(
  id,owner,persona_id,status,source_image_url,fb_image_url,ig_image_url,x_image_url
) values(
  '06400000-0000-4000-8000-000000002006',
  '05900000-0000-4000-8000-000000000099',
  '05900000-0000-4000-8000-000000000199','scheduled',
  'https://nwsqyuucwzihruszocge.supabase.co/storage/v1/object/public/media/05900000-0000-4000-8000-000000000099/1720000000004-source.png',
  'https://nwsqyuucwzihruszocge.supabase.co/storage/v1/object/public/media/05900000-0000-4000-8000-000000000099/1720000000004-source.png',
  'https://nwsqyuucwzihruszocge.supabase.co/storage/v1/object/public/media/05900000-0000-4000-8000-000000000099/1720000000005-missing.png',
  'https://nwsqyuucwzihruszocge.supabase.co/storage/v1/object/public/media/05900000-0000-4000-8000-000000000099/1720000000006-x.png'
);
set session_replication_role=origin;

insert into public.affiliate_products(
  id,owner,title,merchant,image_url,affiliate_url,product_url,status
) values(
  '06400000-0000-4000-8000-000000002007',
  '05900000-0000-4000-8000-000000000099','Shared product','Fixture merchant',
  'https://nwsqyuucwzihruszocge.supabase.co/storage/v1/object/public/media/05900000-0000-4000-8000-000000000099/1720000000007-product.png',
  'https://affiliate.example.test/buy','https://merchant.example.test/product','active'
);
insert into public.persona_affiliate_offers(
  id,owner,persona_id,product_id,status
) values
  ('06400000-0000-4000-8000-000000002008',
   '05900000-0000-4000-8000-000000000099',
   '05900000-0000-4000-8000-000000000199',
   '06400000-0000-4000-8000-000000002007','active'),
  ('06400000-0000-4000-8000-000000002009',
   '05900000-0000-4000-8000-000000000099',
   '06400000-0000-4000-8000-000000000199',
   '06400000-0000-4000-8000-000000002007','active');

-- Broad 062 blocker, intentionally excluded from 064 automatic preview.
insert into public.album_items(id,album_id,thumb_url) values(
  '06400000-0000-4000-8000-000000002010',
  '06400000-0000-4000-8000-000000002002',
  'https://nwsqyuucwzihruszocge.supabase.co/storage/v1/render/image/public/media/05900000-0000-4000-8000-000000000099/encoded.png?width=100'
);
