-- 005 comments and reactions on feed posts (roadmap v0.5).
-- Additive and safe to run any time. You comment / react as one of your own
-- personas; visibility follows the post's persona via the existing helper
-- functions persona_visible() and owns_persona(). Run in Supabase SQL Editor.

-- ===== COMMENTS =====
create table if not exists public.comments (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.posts(id) on delete cascade,
  persona_id uuid not null references public.personas(id) on delete cascade,
  body text not null check (char_length(body) between 1 and 2000),
  created_at timestamptz default now()
);
alter table public.comments enable row level security;
create index if not exists comments_post_idx on public.comments (post_id, created_at);

create policy "comments read" on public.comments for select using (
  exists (select 1 from public.posts p where p.id = post_id and persona_visible(p.persona_id))
);
create policy "comments insert" on public.comments for insert with check (
  owns_persona(persona_id)
  and exists (select 1 from public.posts p where p.id = post_id and persona_visible(p.persona_id))
);
create policy "comments delete" on public.comments for delete using (
  owns_persona(persona_id)
  or exists (select 1 from public.posts p where p.id = post_id and owns_persona(p.persona_id))
);

-- ===== REACTIONS =====
create table if not exists public.reactions (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.posts(id) on delete cascade,
  persona_id uuid not null references public.personas(id) on delete cascade,
  kind text not null default 'like' check (kind in ('like','love','fire','laugh','wow','sad')),
  created_at timestamptz default now(),
  unique (post_id, persona_id, kind)
);
alter table public.reactions enable row level security;
create index if not exists reactions_post_idx on public.reactions (post_id);

create policy "reactions read" on public.reactions for select using (
  exists (select 1 from public.posts p where p.id = post_id and persona_visible(p.persona_id))
);
create policy "reactions write" on public.reactions for insert with check (
  owns_persona(persona_id)
  and exists (select 1 from public.posts p where p.id = post_id and persona_visible(p.persona_id))
);
create policy "reactions remove" on public.reactions for delete using (owns_persona(persona_id));
