-- 033-staged-posts.sql
-- 3-part staged posting system (owner request, 2026-08-13). One post is authored
-- once and staged as three platform-tailored variants (Facebook landscape /
-- Instagram square / X portrait, with FB-detailed -> IG-optimal -> X-short
-- captions), grouped into a weekly schedule that is reviewed/edited and approved
-- on approval day, then published via meta-post (FB+IG) and twitter-post (X).
-- See POSTING-3PART-SPEC.md. Additive + owner-scoped RLS.

create table if not exists public.post_drafts (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null references public.profiles(id) on delete cascade,
  persona_id uuid references public.personas(id) on delete set null,
  -- Monday of the week this draft belongs to (weekly staging bucket).
  week_start date,
  status text not null default 'draft'
    check (status in ('draft','approved','scheduled','posted','failed','skipped')),
  scheduled_for timestamptz,
  brief text not null default '' check (char_length(brief) <= 4000),
  source_image_url text not null default '' check (char_length(source_image_url) <= 2048),
  -- Per-platform captions (lengths mirror each platform's sweet spot / hard cap).
  fb_caption text not null default '' check (char_length(fb_caption) <= 5000),
  ig_caption text not null default '' check (char_length(ig_caption) <= 2200),
  x_caption  text not null default '' check (char_length(x_caption)  <= 280),
  -- Per-platform image crops (public https urls the posting APIs fetch).
  fb_image_url text not null default '' check (char_length(fb_image_url) <= 2048),
  ig_image_url text not null default '' check (char_length(ig_image_url) <= 2048),
  x_image_url  text not null default '' check (char_length(x_image_url)  <= 2048),
  targets text[] not null default array['facebook','instagram','twitter']::text[],
  -- Publish results / errors.
  fb_post_id text,
  ig_media_id text,
  x_tweet_id text,
  last_error text,
  approved_at timestamptz,
  approved_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists post_drafts_owner_idx
  on public.post_drafts (owner, week_start desc, status);
create index if not exists post_drafts_persona_idx
  on public.post_drafts (persona_id) where persona_id is not null;
create index if not exists post_drafts_due_idx
  on public.post_drafts (scheduled_for) where status = 'scheduled';

alter table public.post_drafts enable row level security;

drop policy if exists "post_drafts owner all" on public.post_drafts;
create policy "post_drafts owner all" on public.post_drafts
  for all to authenticated
  using (owner = auth.uid())
  with check (owner = auth.uid());
