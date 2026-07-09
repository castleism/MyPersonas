-- Content drafts: posts written for EXTERNAL platforms (X, OnlyFans, IG...)
-- managed here, posted manually there. Run in Supabase SQL Editor.
create table public.drafts (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null references public.profiles(id) on delete cascade,
  persona_id uuid references public.personas(id) on delete set null,
  platform text default '',
  title text default '',
  body text default '',
  tags text default '',
  media_url text default '',
  status text default 'idea' check (status in ('idea','ready','posted')),
  scheduled_for date,
  created_at timestamptz default now()
);
alter table public.drafts enable row level security;
create policy "drafts owner only" on public.drafts for all
  using (auth.uid() = owner) with check (auth.uid() = owner);
create index drafts_owner_idx on public.drafts (owner, status, created_at desc);
