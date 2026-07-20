-- ★ PersonaSpace — privacy-first persona network schema ★
-- Run this whole file in Supabase: Dashboard → SQL Editor → New query → paste → Run

-- ============ PROFILES (one per signed-in user — PRIVATE, never shown publicly) ============
create table public.profiles (
  id uuid primary key references auth.users on delete cascade,
  email text,
  display_name text,
  prefs jsonb default '{}',
  created_at timestamptz default now()
);
alter table public.profiles enable row level security;
-- privacy: only YOU can read your own profile. Personas are never publicly linked to it.
create policy "profiles self read" on public.profiles for select using (auth.uid() = id);
create policy "profiles self update" on public.profiles for update using (auth.uid() = id);

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, display_name)
  values (new.id, new.email, split_part(new.email,'@',1));
  return new;
end; $$;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- ============ AI BACKENDS (models linked to the main account — owner-only) ============
create table public.ai_backends (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null references public.profiles(id) on delete cascade,
  name text not null,
  base_url text not null,
  api_key text default '',
  model text default '',
  created_at timestamptz default now()
);
alter table public.ai_backends enable row level security;
create policy "backends owner only" on public.ai_backends for all
  using (auth.uid() = owner) with check (auth.uid() = owner);

-- ============ PERSONAS ============
create table public.personas (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null references public.profiles(id) on delete cascade,
  handle text unique not null check (handle ~ '^[a-z0-9._]{3,30}$'),
  name text not null,
  tagline text default '',
  bio text default '',
  nsfw boolean default false,
  visibility text default 'public' check (visibility in ('public','unlisted','private')),
  avatar_url text default '',
  banner_url text default '',
  bg_url text default '',
  feed_img_url text default '',
  music_url text default '',
  live_url text default '',
  theme text default '#ff4fa3',
  topics text default '',
  purpose text default '',
  voice text default '',
  audience text default '',
  hashtags text default '',
  dont text default '',
  top8 jsonb default '[]',
  modules jsonb default '{}',
  ai_backend uuid references public.ai_backends(id) on delete set null,
  created_at timestamptz default now()
);
alter table public.personas enable row level security;

-- ============ CONNECTIONS (friend requests: pending → accepted) ============
create table public.follows (
  id uuid primary key default gen_random_uuid(),
  follower uuid not null references public.personas(id) on delete cascade,
  target uuid not null references public.personas(id) on delete cascade,
  status text default 'pending' check (status in ('pending','accepted')),
  created_at timestamptz default now(),
  unique (follower, target)
);
alter table public.follows enable row level security;

-- ============ BLOCKS & MUTES (block = they can't friend you; mute = you don't see them) ============
create table public.blocks (
  id uuid primary key default gen_random_uuid(),
  blocker uuid not null references public.profiles(id) on delete cascade,
  blocked_persona uuid not null references public.personas(id) on delete cascade,
  kind text default 'block' check (kind in ('block','mute')),
  created_at timestamptz default now(),
  unique (blocker, blocked_persona, kind)
);
alter table public.blocks enable row level security;
create policy "blocks owner only" on public.blocks for all
  using (auth.uid() = blocker) with check (auth.uid() = blocker);

-- ============ SECURITY HELPER FUNCTIONS (definer = safe from RLS recursion) ============
create or replace function public.persona_visible(pid uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from personas p where p.id = pid and (
      p.visibility in ('public','unlisted')
      or p.owner = auth.uid()
      or (p.visibility = 'private' and exists (
        select 1 from follows f
        join personas mine on mine.id = f.follower
        where f.target = p.id and f.status = 'accepted' and mine.owner = auth.uid()))
    ));
$$;

create or replace function public.owns_persona(pid uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (select 1 from personas p where p.id = pid and p.owner = auth.uid());
$$;

create or replace function public.can_request(follower_id uuid, target_id uuid)
returns boolean language sql security definer stable set search_path = public as $$
  -- you must own the requesting persona, and the target's owner must not have blocked it
  select owns_persona(follower_id) and not exists (
    select 1 from blocks b
    join personas t on t.id = target_id
    where b.blocker = t.owner and b.blocked_persona = follower_id and b.kind = 'block');
$$;

-- ============ PERSONA POLICIES ============
create policy "personas visible read" on public.personas for select using (persona_visible(id));
create policy "personas owner insert" on public.personas for insert with check (auth.uid() = owner);
create policy "personas owner update" on public.personas for update using (auth.uid() = owner);
create policy "personas owner delete" on public.personas for delete using (auth.uid() = owner);

-- ============ FOLLOWS POLICIES ============
create policy "follows read" on public.follows for select
  using (status = 'accepted' or owns_persona(follower) or owns_persona(target));
create policy "follows request" on public.follows for insert
  with check (can_request(follower, target));
create policy "follows accept" on public.follows for update
  using (owns_persona(target));
create policy "follows remove" on public.follows for delete
  using (owns_persona(follower) or owns_persona(target));

-- ============ PERSONA LINKS (public social links) ============
create table public.persona_links (
  id uuid primary key default gen_random_uuid(),
  persona_id uuid not null references public.personas(id) on delete cascade,
  platform text not null,
  handle text default '',
  url text default '',
  sort int default 0
);
alter table public.persona_links enable row level security;
create policy "links visible read" on public.persona_links for select using (persona_visible(persona_id));
create policy "links owner write" on public.persona_links for all
  using (owns_persona(persona_id)) with check (owns_persona(persona_id));

-- ============ PRIVATE NOTES (owner-only: account emails, reminders) ============
create table public.private_notes (
  id uuid primary key default gen_random_uuid(),
  persona_id uuid not null references public.personas(id) on delete cascade,
  content text default ''
);
alter table public.private_notes enable row level security;
create policy "notes owner only" on public.private_notes for all
  using (owns_persona(persona_id)) with check (owns_persona(persona_id));

-- ============ PRIVATE ACCOUNT LEDGER (metadata only; never credentials) ============
create table public.account_ledger (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null references public.profiles(id) on delete cascade,
  persona_id uuid references public.personas(id) on delete set null,
  provider text not null,
  username text default '',
  login_email text default '',
  url text default '',
  notes text default '',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
alter table public.account_ledger enable row level security;
create policy "account ledger owner only" on public.account_ledger for all
  using (auth.uid() = owner)
  with check (auth.uid() = owner and (persona_id is null or owns_persona(persona_id)));
create index account_ledger_owner_idx on public.account_ledger (owner, created_at desc);
create index account_ledger_persona_idx on public.account_ledger (persona_id);

-- ============ POSTS (blog feed + reels) ============
create table public.posts (
  id uuid primary key default gen_random_uuid(),
  persona_id uuid not null references public.personas(id) on delete cascade,
  kind text default 'post' check (kind in ('post','reel')),
  title text default '',
  body text default '',
  tags text default '',
  media_url text default '',
  created_at timestamptz default now()
);
alter table public.posts enable row level security;
create policy "posts visible read" on public.posts for select using (persona_visible(persona_id));
create policy "posts owner write" on public.posts for all
  using (owns_persona(persona_id)) with check (owns_persona(persona_id));
create index posts_persona_idx on public.posts (persona_id, created_at desc);

-- ============ ALBUMS (photo/video albums that deep-link to OnlyFans/IG/affiliate links) ============
create table public.albums (
  id uuid primary key default gen_random_uuid(),
  persona_id uuid not null references public.personas(id) on delete cascade,
  title text not null,
  kind text default 'gallery' check (kind in ('gallery','affiliate')),
  sort int default 0,
  created_at timestamptz default now()
);
alter table public.albums enable row level security;
create policy "albums visible read" on public.albums for select using (persona_visible(persona_id));
create policy "albums owner write" on public.albums for all
  using (owns_persona(persona_id)) with check (owns_persona(persona_id));

create table public.album_items (
  id uuid primary key default gen_random_uuid(),
  album_id uuid not null references public.albums(id) on delete cascade,
  thumb_url text default '',
  caption text default '',
  link_url text default '',
  sort int default 0,
  created_at timestamptz default now()
);
alter table public.album_items enable row level security;
create policy "items visible read" on public.album_items for select
  using (exists (select 1 from public.albums a where a.id = album_id and persona_visible(a.persona_id)));
create policy "items owner write" on public.album_items for all
  using (exists (select 1 from public.albums a where a.id = album_id and owns_persona(a.persona_id)))
  with check (exists (select 1 from public.albums a where a.id = album_id and owns_persona(a.persona_id)));

-- ============ SCHEDULED TASKS (each task = persona + model + instructions) ============
create table public.ai_tasks (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null references public.profiles(id) on delete cascade,
  persona_id uuid references public.personas(id) on delete cascade,
  backend_id uuid references public.ai_backends(id) on delete set null,
  name text not null,
  task_type text default 'original',
  instructions text default '',
  cadence text default 'manual',
  last_run timestamptz,
  created_at timestamptz default now()
);
alter table public.ai_tasks enable row level security;
create policy "tasks owner only" on public.ai_tasks for all
  using (auth.uid() = owner) with check (auth.uid() = owner);

-- ============ MEDIA STORAGE ============
insert into storage.buckets (id, name, public) values ('media','media', true);
create policy "media public read" on storage.objects for select using (bucket_id = 'media');
create policy "media auth upload" on storage.objects for insert
  with check (bucket_id = 'media' and auth.role() = 'authenticated' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "media owner delete" on storage.objects for delete
  using (bucket_id = 'media' and (storage.foldername(name))[1] = auth.uid()::text);
