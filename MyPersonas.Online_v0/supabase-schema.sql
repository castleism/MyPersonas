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

-- ============ EXTERNAL ACCOUNT CONNECTION STATE (server-attested; no tokens) ============
create unique index account_ledger_id_owner_idx on public.account_ledger (id, owner);
create table public.account_connections (
  ledger_id uuid primary key,
  owner uuid not null references public.profiles(id) on delete cascade,
  provider text not null,
  provider_subject text default '',
  provider_email text default '',
  granted_scopes text[] not null default '{}',
  connection_state text not null default 'verified'
    check (connection_state in ('verified','connected','error','disconnected')),
  verification_method text default '',
  verified_at timestamptz,
  connected_at timestamptz,
  last_checked_at timestamptz,
  expires_at timestamptz,
  error_code text default '',
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  foreign key (ledger_id, owner)
    references public.account_ledger(id, owner) on delete cascade
);
alter table public.account_connections enable row level security;
create policy "account connections owner read" on public.account_connections
  for select using (auth.uid() = owner);
revoke all on public.account_connections from anon, authenticated;
grant select on public.account_connections to authenticated;
create index account_connections_owner_idx on public.account_connections (owner);
create unique index account_connections_provider_subject_idx
  on public.account_connections (provider, provider_subject)
  where provider_subject <> '';

comment on table public.account_connections is
  'Server-attested external account verification and OAuth connection state; contains no credentials or tokens.';

create or replace function public.verify_account_ledger_email(p_ledger_id uuid)
returns public.account_connections
language plpgsql security definer set search_path = '' as $$
declare
  v_ledger public.account_ledger%rowtype;
  v_email text;
  v_connection public.account_connections%rowtype;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select lower(trim(email)) into v_email from auth.users
    where id = auth.uid() and email_confirmed_at is not null;
  if v_email is null or v_email = '' then
    raise exception 'A confirmed AliaSpaces email is required';
  end if;
  select * into v_ledger from public.account_ledger
    where id = p_ledger_id and owner = auth.uid();
  if not found then raise exception 'Account ledger entry not found'; end if;
  if trim(coalesce(v_ledger.login_email, '')) = '' then
    raise exception 'A login email is required for ownership verification';
  end if;
  if v_email <> lower(trim(v_ledger.login_email)) then
    raise exception 'Recorded login email does not match the signed-in AliaSpaces email';
  end if;
  insert into public.account_connections as ac (
    ledger_id, owner, provider, provider_email, connection_state,
    verification_method, verified_at, last_checked_at, updated_at
  ) values (
    v_ledger.id, v_ledger.owner, v_ledger.provider, v_email, 'verified',
    'aliaspaces_confirmed_email', now(), now(), now()
  )
  on conflict (ledger_id) do update set
    owner = excluded.owner, provider = excluded.provider,
    provider_email = excluded.provider_email,
    connection_state = case
      when ac.connection_state = 'connected' then 'connected'
      else 'verified'
    end,
    verification_method = excluded.verification_method,
    verified_at = excluded.verified_at, last_checked_at = excluded.last_checked_at,
    error_code = '', updated_at = excluded.updated_at
  returning * into v_connection;
  return v_connection;
end;
$$;
revoke all on function public.verify_account_ledger_email(uuid) from public;
grant execute on function public.verify_account_ledger_email(uuid) to authenticated;

comment on function public.verify_account_ledger_email(uuid) is
  'Verifies ledger email ownership from the confirmed authentication email; does not grant external API access.';

-- ============ GMAIL OAUTH (service-only state + Vault-backed refresh tokens) ============
create extension if not exists supabase_vault with schema vault;

create table public.gmail_oauth_transactions (
  state_hash text primary key check (state_hash ~ '^[0-9a-f]{64}$'),
  owner uuid not null references public.profiles(id) on delete cascade,
  ledger_id uuid not null,
  code_verifier text not null check (char_length(code_verifier) between 43 and 128),
  browser_nonce_hash text not null check (browser_nonce_hash ~ '^[0-9a-f]{64}$'),
  return_origin text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  foreign key (ledger_id, owner)
    references public.account_ledger(id, owner) on delete cascade
);
create unique index gmail_oauth_transactions_owner_ledger_idx
  on public.gmail_oauth_transactions (owner, ledger_id);
create index gmail_oauth_transactions_expiry_idx
  on public.gmail_oauth_transactions (expires_at);

create table public.gmail_credentials (
  ledger_id uuid primary key,
  owner uuid not null references public.profiles(id) on delete cascade,
  vault_secret_id uuid not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (ledger_id, owner)
    references public.account_ledger(id, owner) on delete cascade
);

alter table public.gmail_oauth_transactions enable row level security;
alter table public.gmail_credentials enable row level security;
-- No browser policies exist. Only service_role and SECURITY DEFINER helpers may
-- touch OAuth transactions or refresh credentials.
revoke all on public.gmail_oauth_transactions from anon, authenticated;
revoke all on public.gmail_credentials from anon, authenticated;
grant all on public.gmail_oauth_transactions to service_role;
grant all on public.gmail_credentials to service_role;

comment on table public.gmail_oauth_transactions is
  'Service-only, single-use Gmail OAuth state and PKCE verifier records.';
comment on table public.gmail_credentials is
  'Service-only map from a Gmail ledger entry to an encrypted Supabase Vault secret.';

create or replace function public.consume_gmail_oauth_state(
  p_state_hash text,
  p_owner uuid,
  p_browser_nonce_hash text
)
returns table(owner uuid, ledger_id uuid, code_verifier text)
language plpgsql security definer set search_path = '' as $$
begin
  return query
  delete from public.gmail_oauth_transactions as tx
  where tx.state_hash = p_state_hash
    and tx.owner = p_owner
    and tx.browser_nonce_hash = p_browser_nonce_hash
    and tx.expires_at > now()
  returning tx.owner, tx.ledger_id, tx.code_verifier;
end;
$$;

create or replace function public.gmail_store_refresh_token(
  p_ledger_id uuid,
  p_owner uuid,
  p_provider_email text,
  p_refresh_token text
)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_secret_id uuid;
  v_secret_name text := 'gmail_refresh_' || p_ledger_id::text;
  v_provider text;
  v_login_email text;
begin
  if trim(coalesce(p_refresh_token, '')) = '' then
    raise exception 'Refresh token is required';
  end if;
  select provider, lower(trim(coalesce(login_email, '')))
    into v_provider, v_login_email
  from public.account_ledger
  where id = p_ledger_id and owner = p_owner
  for update;
  if not found or v_provider <> 'gmail'
    or v_login_email <> lower(trim(coalesce(p_provider_email, ''))) then
    raise exception 'Owned Gmail ledger entry changed during authorization';
  end if;

  select vault_secret_id into v_secret_id
  from public.gmail_credentials
  where ledger_id = p_ledger_id and owner = p_owner
  for update;

  if v_secret_id is null then
    select id into v_secret_id from vault.secrets where name = v_secret_name;
  end if;

  if v_secret_id is null then
    select vault.create_secret(
      p_refresh_token,
      v_secret_name,
      'Gmail OAuth refresh token for ledger ' || p_ledger_id::text
    ) into v_secret_id;
  else
    perform vault.update_secret(
      v_secret_id,
      p_refresh_token,
      v_secret_name,
      'Gmail OAuth refresh token for ledger ' || p_ledger_id::text
    );
  end if;

  insert into public.gmail_credentials (ledger_id, owner, vault_secret_id, updated_at)
  values (p_ledger_id, p_owner, v_secret_id, now())
  on conflict (ledger_id) do update set
    owner = excluded.owner,
    vault_secret_id = excluded.vault_secret_id,
    updated_at = excluded.updated_at;

  return v_secret_id;
end;
$$;

create or replace function public.gmail_get_refresh_token(p_ledger_id uuid, p_owner uuid)
returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_refresh_token text;
begin
  select secret.decrypted_secret into v_refresh_token
  from public.gmail_credentials as credential
  join vault.decrypted_secrets as secret on secret.id = credential.vault_secret_id
  where credential.ledger_id = p_ledger_id and credential.owner = p_owner;
  return v_refresh_token;
end;
$$;

create or replace function public.delete_gmail_vault_secret()
returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  delete from vault.secrets where id = old.vault_secret_id;
  return old;
end;
$$;

create trigger gmail_credentials_delete_vault_secret
  after delete on public.gmail_credentials
  for each row execute function public.delete_gmail_vault_secret();

create or replace function public.guard_connected_gmail_ledger_change()
returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if exists (
    select 1 from public.gmail_credentials where ledger_id = old.id
  ) then
    if tg_op = 'DELETE' then
      raise exception 'Disconnect Gmail before deleting this account';
    end if;
    if new.provider is distinct from old.provider
      or lower(trim(coalesce(new.login_email, ''))) is distinct from lower(trim(coalesce(old.login_email, ''))) then
      raise exception 'Disconnect Gmail before changing its provider or login email';
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

create trigger guard_connected_gmail_ledger_change
  before delete or update of provider, login_email on public.account_ledger
  for each row execute function public.guard_connected_gmail_ledger_change();

create or replace function public.gmail_delete_refresh_token(p_ledger_id uuid, p_owner uuid)
returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  v_deleted_count integer := 0;
begin
  delete from public.gmail_credentials
  where ledger_id = p_ledger_id and owner = p_owner;
  get diagnostics v_deleted_count = row_count;
  return v_deleted_count > 0;
end;
$$;

revoke all on function public.consume_gmail_oauth_state(text, uuid, text) from public, anon, authenticated;
revoke all on function public.gmail_store_refresh_token(uuid, uuid, text, text) from public, anon, authenticated;
revoke all on function public.gmail_get_refresh_token(uuid, uuid) from public, anon, authenticated;
revoke all on function public.gmail_delete_refresh_token(uuid, uuid) from public, anon, authenticated;
revoke all on function public.delete_gmail_vault_secret() from public, anon, authenticated;
revoke all on function public.guard_connected_gmail_ledger_change() from public, anon, authenticated;

grant execute on function public.consume_gmail_oauth_state(text, uuid, text) to service_role;
grant execute on function public.gmail_store_refresh_token(uuid, uuid, text, text) to service_role;
grant execute on function public.gmail_get_refresh_token(uuid, uuid) to service_role;
grant execute on function public.gmail_delete_refresh_token(uuid, uuid) to service_role;

comment on function public.consume_gmail_oauth_state(text, uuid, text) is
  'Service-only atomic consume for Gmail OAuth state bound to its owner and initiating browser tab.';
comment on function public.gmail_store_refresh_token(uuid, uuid, text, text) is
  'Service-only storage of a Gmail refresh token in encrypted Supabase Vault.';
comment on function public.gmail_get_refresh_token(uuid, uuid) is
  'Service-only retrieval of a Gmail refresh token from Supabase Vault.';
comment on function public.gmail_delete_refresh_token(uuid, uuid) is
  'Service-only deletion of a Gmail refresh token and Vault secret.';

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

-- ============ FRESH-INSTALL COMPLETION (base includes 008-010; append 001-007 + 011) ============
-- Kept inline so a new project created from this snapshot matches the live migration chain.

-- BEGIN 001-error-logs.sql
-- Error reporting table — run in Supabase SQL Editor
create table public.error_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid,
  message text default '',
  context jsonb default '{}',
  created_at timestamptz default now()
);
alter table public.error_logs enable row level security;
-- anyone (even signed-out) can file a report; only you read them via the dashboard
create policy "error logs insert" on public.error_logs for insert with check (true);
-- END 001-error-logs.sql

-- BEGIN 002-drafts.sql
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
-- END 002-drafts.sql

-- BEGIN 003-linked-personas.sql
-- Linked personas: each persona controls which of the owner's OTHER personas
-- are revealed on its page (empty by default — anonymity preserved).
-- Run in Supabase SQL Editor.
alter table public.personas add column linked jsonb default '[]';
-- END 003-linked-personas.sql

-- BEGIN 004-fix-persona-create-rls.sql
-- Fix: creating a persona always failed with
--   "new row violates row-level security policy for table personas" (42501)
-- Cause: the app inserts with .select() (RETURNING). Returned rows must pass
-- the SELECT policy, which called persona_visible() — a security-definer
-- STABLE function that re-queries personas. Within the same INSERT statement
-- the new row is not yet visible in that function's snapshot, so the policy
-- evaluated false and the whole insert was rejected.
-- (Updates never hit this because the update path returns no representation —
-- that is why the bug looked intermittent: edits worked, creates failed.)
--
-- Fix: check ownership and public/unlisted visibility INLINE on the row
-- (evaluated directly on the returned tuple — no table re-query), and keep
-- persona_visible() only for the friends-of-private case.
-- Run in Supabase SQL Editor.

drop policy "personas visible read" on public.personas;
create policy "personas visible read" on public.personas for select
  using (
    visibility in ('public','unlisted')
    or owner = auth.uid()
    or persona_visible(id)
  );
-- END 004-fix-persona-create-rls.sql

-- BEGIN 005-comments-reactions.sql
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
-- END 005-comments-reactions.sql

-- BEGIN 006-privacy-owner-uuid.sql
-- 006 close the owner-uuid privacy leak (VERIFICATION.md finding 10).
--
-- Problem: the personas SELECT policy returns whole rows, including
-- personas.owner, to anyone (even signed-out). Anyone can then group all public
-- personas of one account by owner uuid, breaking the "personas are never linked
-- to each other" promise at the API level.
--
-- Fix is TWO-PHASE so it never breaks the live site:
--   Phase A (this file, safe to run now): add security-definer RPCs the client
--     will use, so the client no longer needs to SELECT the owner column.
--   Phase B (the revoke at the bottom, run ONLY after the matching client
--     changes are deployed, see DEPLOY.md): revoke column SELECT on
--     personas.owner so no client can read it.
--
-- Running Phase A alone changes nothing user-visible; it just adds functions.

-- ===== Phase A: RPCs =====

-- Owner's own roster (full rows incl owner). Replaces select('*').eq('owner',uid).
create or replace function public.my_personas()
returns setof public.personas language sql security definer stable
set search_path = public as $$
  select * from public.personas where owner = auth.uid() order by created_at asc;
$$;

-- Public discovery WITHOUT owner. Optional text search over name/handle/topics/tagline.
create or replace function public.discover_personas(q text default null, lim int default 80)
returns table (
  id uuid, handle text, name text, tagline text, bio text, nsfw boolean,
  visibility text, avatar_url text, banner_url text, bg_url text, feed_img_url text,
  music_url text, live_url text, theme text, topics text, hashtags text,
  top8 jsonb, modules jsonb, linked jsonb, created_at timestamptz
) language sql security definer stable set search_path = public as $$
  select id, handle, name, tagline, bio, nsfw, visibility, avatar_url, banner_url,
         bg_url, feed_img_url, music_url, live_url, theme, topics, hashtags,
         top8, modules, linked, created_at
  from public.personas
  where visibility = 'public'
    and (q is null or name ilike '%'||q||'%' or handle ilike '%'||q||'%'
         or topics ilike '%'||q||'%' or tagline ilike '%'||q||'%')
  order by created_at desc
  limit greatest(1, least(coalesce(lim,80), 200));
$$;

-- One visible persona page by handle, WITHOUT owner. persona_visible() keeps
-- private pages available to their owner/accepted friends without exposing the
-- owner's UUID.
create or replace function public.persona_by_handle(h text)
returns table (
  id uuid, handle text, name text, tagline text, bio text, nsfw boolean,
  visibility text, avatar_url text, banner_url text, bg_url text, feed_img_url text,
  music_url text, live_url text, theme text, topics text, purpose text, voice text,
  audience text, hashtags text, dont text, top8 jsonb, modules jsonb, linked jsonb,
  ai_backend uuid, created_at timestamptz
) language sql security definer stable set search_path = public as $$
  select id, handle, name, tagline, bio, nsfw, visibility, avatar_url, banner_url,
         bg_url, feed_img_url, music_url, live_url, theme, topics, purpose, voice,
         audience, hashtags, dont, top8, modules, linked, ai_backend, created_at
  from public.personas
  where handle = h and persona_visible(id)
  limit 1;
$$;

grant execute on function public.my_personas() to authenticated;
grant execute on function public.discover_personas(text,int) to anon, authenticated;
grant execute on function public.persona_by_handle(text) to anon, authenticated;

-- ===== Phase B: DO NOT RUN until the client is updated (see DEPLOY.md) =====
-- Once the client reads via the RPCs above and never selects personas.owner
-- directly, replace the broad table SELECT grant with an explicit safe-column
-- grant. A column-level revoke by itself does not override table-level SELECT:
--   revoke select on public.personas from anon, authenticated;
--   revoke select (owner) on public.personas from anon, authenticated;
--   grant select (
--     id, handle, name, tagline, bio, nsfw, visibility, avatar_url, banner_url,
--     bg_url, feed_img_url, music_url, live_url, theme, topics, purpose, voice,
--     audience, hashtags, dont, top8, modules, linked, ai_backend, created_at
--   ) on public.personas to anon, authenticated;
-- Owners still reach their own rows via my_personas(); RLS policy expressions may
-- reference owner regardless of this column grant.
-- END 006-privacy-owner-uuid.sql

-- BEGIN 007-ai-backend-provider.sql
-- 007 provider + extra fields for linked AI models.
-- Additive and safe. Adds a provider label and a jsonb for provider-specific
-- fields (e.g. ElevenLabs voice_id, Azure api_version). The client also degrades
-- gracefully if this has not been run yet. Run in Supabase SQL Editor.

alter table public.ai_backends add column if not exists provider text default '';
alter table public.ai_backends add column if not exists extra jsonb default '{}';
-- END 007-ai-backend-provider.sql

-- BEGIN 011-agent-automation.sql
-- MyPersonas agent control plane: bindings, direction, precise schedules,
-- approval/publish state, synced owner chat, audit history, and fan-chat inbox.
-- Additive migration. External publishing remains gated by verified claims,
-- connected accounts, write scopes, and an implemented official connector.

create extension if not exists pgcrypto with schema extensions;
create extension if not exists supabase_vault with schema vault;

create unique index if not exists personas_id_owner_idx
  on public.personas (id, owner);

-- AI provider credentials are accepted once through an owner-authenticated RPC,
-- encrypted in Supabase Vault, and resolved only by service-role Edge Functions.
-- The legacy api_key column is retained empty for compatibility during rollout.
revoke select on public.ai_backends from authenticated;
grant select (id, owner, name, base_url, model, provider, extra, created_at)
  on public.ai_backends to authenticated;
revoke insert, update, delete on public.ai_backends from authenticated;

create table if not exists public.ai_backend_credentials (
  backend_id uuid primary key references public.ai_backends(id) on delete cascade,
  owner uuid not null references public.profiles(id) on delete cascade,
  vault_secret_id uuid not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.ai_backend_credentials enable row level security;
revoke all on public.ai_backend_credentials from anon, authenticated;
grant all on public.ai_backend_credentials to service_role;

create or replace function public.delete_ai_backend_vault_secret()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  delete from vault.secrets where id = old.vault_secret_id;
  return old;
end;
$$;
drop trigger if exists ai_backend_credentials_delete_vault_secret
  on public.ai_backend_credentials;
create trigger ai_backend_credentials_delete_vault_secret
  after delete on public.ai_backend_credentials
  for each row execute function public.delete_ai_backend_vault_secret();

create or replace function public.create_ai_backend(
  p_provider text,
  p_name text,
  p_base_url text,
  p_api_key text,
  p_model text,
  p_extra jsonb default '{}'::jsonb
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid := auth.uid();
  v_backend_id uuid;
  v_secret_id uuid;
  v_secret_name text;
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  if trim(coalesce(p_name,'')) = '' or char_length(p_name) > 160 then
    raise exception 'Model connection name is required';
  end if;
  if char_length(coalesce(p_provider,'')) > 80 then
    raise exception 'Provider name is too long';
  end if;
  if trim(coalesce(p_base_url,'')) !~* '^https://[^[:space:]]+$'
    or char_length(p_base_url) > 2048 then
    raise exception 'Hosted model connections require a valid HTTPS base URL';
  end if;
  if char_length(coalesce(p_model,'')) > 300 then
    raise exception 'Model id is too long';
  end if;
  if octet_length(coalesce(p_api_key,'')) > 32768 then
    raise exception 'Provider credential is too large';
  end if;
  if octet_length(coalesce(p_extra,'{}'::jsonb)::text) > 10000 then
    raise exception 'Provider options are too large';
  end if;

  insert into public.ai_backends (
    owner, provider, name, base_url, api_key, model, extra
  ) values (
    v_owner, lower(trim(coalesce(p_provider,''))), trim(p_name), trim(p_base_url),
    '', trim(coalesce(p_model,'')), coalesce(p_extra,'{}'::jsonb)
  ) returning id into v_backend_id;

  if trim(coalesce(p_api_key,'')) <> '' then
    v_secret_name := 'ai_backend_key_' || v_backend_id::text;
    select vault.create_secret(
      p_api_key,
      v_secret_name,
      'AI provider credential for backend ' || v_backend_id::text
    ) into v_secret_id;
    insert into public.ai_backend_credentials (
      backend_id, owner, vault_secret_id
    ) values (v_backend_id, v_owner, v_secret_id);
  end if;
  return v_backend_id;
end;
$$;

create or replace function public.update_ai_backend(
  p_backend_id uuid,
  p_name text,
  p_model text,
  p_extra jsonb default '{}'::jsonb
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_owner uuid := auth.uid();
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  if trim(coalesce(p_name,'')) = '' or char_length(p_name) > 160 then
    raise exception 'Model connection name is required';
  end if;
  if char_length(coalesce(p_model,'')) > 300 then
    raise exception 'Model id is too long';
  end if;
  if octet_length(coalesce(p_extra,'{}'::jsonb)::text) > 10000 then
    raise exception 'Provider options are too large';
  end if;
  update public.ai_backends set
    name = trim(p_name), model = trim(coalesce(p_model,'')),
    extra = coalesce(p_extra,'{}'::jsonb)
  where id = p_backend_id and owner = v_owner;
  if not found then raise exception 'Owned model connection not found'; end if;
  return true;
end;
$$;

create or replace function public.delete_ai_backend(p_backend_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_owner uuid := auth.uid();
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  delete from public.ai_backends where id = p_backend_id and owner = v_owner;
  if not found then raise exception 'Owned model connection not found'; end if;
  return true;
end;
$$;

create or replace function public.delete_my_ai_backends()
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_owner uuid := auth.uid();
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  delete from public.ai_backends where owner = v_owner;
  return true;
end;
$$;

create or replace function public.ai_backend_get_key(
  p_backend_id uuid,
  p_owner uuid
)
returns text language sql security definer stable set search_path = '' as $$
  select secret.decrypted_secret
  from public.ai_backend_credentials credential
  join vault.decrypted_secrets secret on secret.id = credential.vault_secret_id
  where credential.backend_id = p_backend_id and credential.owner = p_owner;
$$;

-- Move any legacy plaintext keys into Vault before clearing the old column.
do $$
declare
  v_row record;
  v_secret_id uuid;
  v_secret_name text;
begin
  for v_row in
    select id, owner, api_key from public.ai_backends
    where trim(coalesce(api_key,'')) <> ''
  loop
    select vault_secret_id into v_secret_id
    from public.ai_backend_credentials
    where backend_id = v_row.id for update;
    v_secret_name := 'ai_backend_key_' || v_row.id::text;
    if v_secret_id is null then
      select id into v_secret_id from vault.secrets where name = v_secret_name;
    end if;
    if v_secret_id is null then
      select vault.create_secret(
        v_row.api_key,
        v_secret_name,
        'AI provider credential for backend ' || v_row.id::text
      ) into v_secret_id;
    else
      perform vault.update_secret(
        v_secret_id,
        v_row.api_key,
        v_secret_name,
        'AI provider credential for backend ' || v_row.id::text
      );
    end if;
    insert into public.ai_backend_credentials (
      backend_id, owner, vault_secret_id, updated_at
    ) values (v_row.id, v_row.owner, v_secret_id, now())
    on conflict (backend_id) do update set
      owner = excluded.owner,
      vault_secret_id = excluded.vault_secret_id,
      updated_at = excluded.updated_at;
    update public.ai_backends set api_key = '' where id = v_row.id;
  end loop;
end;
$$;

revoke all on function public.create_ai_backend(text,text,text,text,text,jsonb)
  from public, anon;
revoke all on function public.update_ai_backend(uuid,text,text,jsonb)
  from public, anon;
revoke all on function public.delete_ai_backend(uuid) from public, anon;
revoke all on function public.delete_my_ai_backends() from public, anon;
grant execute on function public.create_ai_backend(text,text,text,text,text,jsonb)
  to authenticated;
grant execute on function public.update_ai_backend(uuid,text,text,jsonb)
  to authenticated;
grant execute on function public.delete_ai_backend(uuid) to authenticated;
grant execute on function public.delete_my_ai_backends() to authenticated;
revoke all on function public.ai_backend_get_key(uuid,uuid)
  from public, anon, authenticated;
revoke all on function public.delete_ai_backend_vault_secret()
  from public, anon, authenticated;
grant execute on function public.ai_backend_get_key(uuid,uuid) to service_role;

-- Privacy-safe persona reads. Public callers never receive the private owner
-- UUID; an owner reaches their full roster only through my_personas().
create or replace function public.my_personas()
returns setof public.personas language sql security definer stable
set search_path = '' as $$
  select * from public.personas where owner = auth.uid() order by created_at asc;
$$;

create or replace function public.discover_personas(q text default null, lim int default 80)
returns table (
  id uuid, handle text, name text, tagline text, bio text, nsfw boolean,
  visibility text, avatar_url text, banner_url text, bg_url text, feed_img_url text,
  music_url text, live_url text, theme text, topics text, hashtags text,
  top8 jsonb, modules jsonb, linked jsonb, created_at timestamptz
) language sql security definer stable set search_path = '' as $$
  select p.id, p.handle, p.name, p.tagline, p.bio, p.nsfw, p.visibility,
    p.avatar_url, p.banner_url, p.bg_url, p.feed_img_url, p.music_url,
    p.live_url, p.theme, p.topics, p.hashtags, p.top8, p.modules,
    p.linked, p.created_at
  from public.personas p
  where p.visibility = 'public'
    and (q is null or p.name ilike '%'||q||'%' or p.handle ilike '%'||q||'%'
      or p.topics ilike '%'||q||'%' or p.tagline ilike '%'||q||'%')
  order by p.created_at desc
  limit greatest(1, least(coalesce(lim,80),200));
$$;

create or replace function public.persona_by_handle(h text)
returns table (
  id uuid, handle text, name text, tagline text, bio text, nsfw boolean,
  visibility text, avatar_url text, banner_url text, bg_url text, feed_img_url text,
  music_url text, live_url text, theme text, topics text, purpose text, voice text,
  audience text, hashtags text, dont text, top8 jsonb, modules jsonb, linked jsonb,
  ai_backend uuid, created_at timestamptz
) language sql security definer stable set search_path = '' as $$
  select p.id, p.handle, p.name, p.tagline, p.bio, p.nsfw, p.visibility,
    p.avatar_url, p.banner_url, p.bg_url, p.feed_img_url, p.music_url,
    p.live_url, p.theme, p.topics, p.purpose, p.voice, p.audience,
    p.hashtags, p.dont, p.top8, p.modules, p.linked, p.ai_backend, p.created_at
  from public.personas p
  where p.handle = h and public.persona_visible(p.id)
  limit 1;
$$;
revoke all on function public.my_personas() from public, anon, authenticated;
grant execute on function public.my_personas() to authenticated;
grant execute on function public.discover_personas(text,int) to anon, authenticated;
grant execute on function public.persona_by_handle(text) to anon, authenticated;
-- A column-level revoke does not override an existing table-level SELECT grant.
-- Replace the broad grant with an explicit list that omits the private owner UUID.
revoke select on public.personas from anon, authenticated;
revoke select (owner) on public.personas from anon, authenticated;
grant select (
  id, handle, name, tagline, bio, nsfw, visibility, avatar_url, banner_url,
  bg_url, feed_img_url, music_url, live_url, theme, topics, purpose, voice,
  audience, hashtags, dont, top8, modules, linked, ai_backend, created_at
) on public.personas to anon, authenticated;

create table if not exists public.agent_owner_settings (
  owner uuid primary key references public.profiles(id) on delete cascade,
  automation_paused boolean not null default false,
  pause_reason text not null default '',
  paused_at timestamptz,
  default_timezone text not null default 'UTC',
  daily_draft_limit integer not null default 12
    check (daily_draft_limit between 1 and 100),
  quiet_hours_start time,
  quiet_hours_end time,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.agent_owner_settings enable row level security;
drop policy if exists "agent owner settings owner only" on public.agent_owner_settings;
create policy "agent owner settings owner only" on public.agent_owner_settings for all
  using (auth.uid() = owner) with check (auth.uid() = owner);

-- Time-zone math is used by quotas, quiet hours, publishing, and the scheduler.
-- Reject unusable API values at the database boundary, not only in the UI.
update public.agent_owner_settings set
  default_timezone = 'UTC',
  automation_paused = true,
  pause_reason = 'Review the account time zone before resuming automation.',
  paused_at = coalesce(paused_at, now())
where not exists (
  select 1 from pg_catalog.pg_timezone_names z
  where z.name = agent_owner_settings.default_timezone
);
update public.agent_owner_settings set
  quiet_hours_start = null,
  quiet_hours_end = null
where (quiet_hours_start is null) <> (quiet_hours_end is null);

create or replace function public.guard_agent_owner_settings_timezone()
returns trigger language plpgsql set search_path = '' as $$
begin
  if not exists (
    select 1 from pg_catalog.pg_timezone_names z
    where z.name = new.default_timezone
  ) then
    raise exception 'Choose a valid IANA time zone';
  end if;
  if (new.quiet_hours_start is null) <> (new.quiet_hours_end is null) then
    raise exception 'Set both quiet-hour times, or leave both blank';
  end if;
  return new;
end;
$$;
drop trigger if exists guard_agent_owner_settings_timezone
  on public.agent_owner_settings;
create trigger guard_agent_owner_settings_timezone
  before insert or update of default_timezone, quiet_hours_start, quiet_hours_end
  on public.agent_owner_settings for each row
  execute function public.guard_agent_owner_settings_timezone();

create table if not exists public.agent_bindings (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null references public.profiles(id) on delete cascade,
  persona_id uuid not null unique,
  claim_ref text,
  claim_state text not null default 'self_attested'
    check (claim_state in ('self_attested','verified','revoked','suspended')),
  status text not null default 'active'
    check (status in ('active','paused','suspended','withdrawn')),
  autonomy_level smallint not null default 0
    check (autonomy_level between 0 and 3),
  fan_chat_enabled boolean not null default false,
  fan_daily_message_limit integer not null default 30
    check (fan_daily_message_limit between 1 and 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (persona_id, owner)
    references public.personas(id, owner) on delete cascade
);
alter table public.agent_bindings enable row level security;
drop policy if exists "agent bindings owner only" on public.agent_bindings;
create policy "agent bindings owner only" on public.agent_bindings for all
  using (auth.uid() = owner) with check (auth.uid() = owner);
revoke insert, update, delete on public.agent_bindings from anon, authenticated;
grant update (status, autonomy_level, fan_chat_enabled, fan_daily_message_limit)
  on public.agent_bindings to authenticated;

-- Owners can pause or withdraw their own agents, but a platform suspension
-- cannot be cleared (or forged) through the authenticated browser role.
create or replace function public.guard_agent_binding_suspension()
returns trigger language plpgsql set search_path = '' as $$
begin
  if auth.role() = 'authenticated' and new.status is distinct from old.status
    and (old.status = 'suspended' or new.status = 'suspended') then
    raise exception 'Platform suspension state cannot be changed here';
  end if;
  return new;
end;
$$;
drop trigger if exists guard_agent_binding_suspension on public.agent_bindings;
create trigger guard_agent_binding_suspension
  before update of status on public.agent_bindings for each row
  execute function public.guard_agent_binding_suspension();
create index if not exists agent_bindings_owner_idx
  on public.agent_bindings (owner, status);
create unique index if not exists agent_bindings_id_owner_idx
  on public.agent_bindings (id, owner);

create table if not exists public.agent_destinations (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null references public.profiles(id) on delete cascade,
  binding_id uuid not null,
  persona_id uuid not null,
  account_id uuid references public.account_ledger(id) on delete cascade,
  destination text not null default 'aliaspaces',
  mode text not null default 'manual'
    check (mode in ('manual','approval','auto')),
  enabled boolean not null default true,
  allowed_content_types text[] not null default array['post','reel','article','image','newsletter','promo']::text[],
  daily_publish_limit integer not null default 3
    check (daily_publish_limit between 1 and 100),
  quiet_hours_start time,
  quiet_hours_end time,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (binding_id, owner)
    references public.agent_bindings(id, owner) on delete cascade,
  foreign key (persona_id, owner)
    references public.personas(id, owner) on delete cascade
);
alter table public.agent_destinations enable row level security;
drop policy if exists "agent destinations owner only" on public.agent_destinations;
create policy "agent destinations owner only" on public.agent_destinations for all
  using (auth.uid() = owner) with check (auth.uid() = owner);
create unique index if not exists agent_destinations_target_idx
  on public.agent_destinations (
    binding_id,
    coalesce(account_id, '00000000-0000-0000-0000-000000000000'::uuid),
    destination
  );
create index if not exists agent_destinations_owner_idx
  on public.agent_destinations (owner, persona_id, enabled);

create table if not exists public.persona_content_plans (
  persona_id uuid primary key,
  owner uuid not null references public.profiles(id) on delete cascade,
  primary_goal text not null default '',
  success_metric text not null default '',
  audience_focus text not null default '',
  content_pillars text not null default '',
  current_campaign text not null default '',
  calls_to_action text not null default '',
  offers_and_links text not null default '',
  affiliate_disclosure text not null default '',
  source_notes text not null default '',
  platform_guidance text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (persona_id, owner)
    references public.personas(id, owner) on delete cascade
);
alter table public.persona_content_plans enable row level security;
drop policy if exists "content plans owner only" on public.persona_content_plans;
create policy "content plans owner only" on public.persona_content_plans for all
  using (auth.uid() = owner) with check (auth.uid() = owner);

alter table public.ai_tasks add column if not exists active boolean not null default true;
alter table public.ai_tasks add column if not exists destination text not null default 'aliaspaces';
alter table public.ai_tasks add column if not exists account_id uuid;
alter table public.ai_tasks add column if not exists content_kind text not null default 'post';
alter table public.ai_tasks add column if not exists schedule_day smallint;
alter table public.ai_tasks add column if not exists schedule_time time not null default '09:00';
alter table public.ai_tasks add column if not exists timezone text not null default 'UTC';
alter table public.ai_tasks add column if not exists lead_minutes integer not null default 1440;
alter table public.ai_tasks add column if not exists next_run_at timestamptz;
alter table public.ai_tasks add column if not exists next_publish_at timestamptz;
alter table public.ai_tasks add column if not exists approval_required boolean not null default true;
alter table public.ai_tasks add column if not exists last_status text not null default '';
alter table public.ai_tasks add column if not exists last_error text not null default '';
alter table public.ai_tasks add column if not exists lease_token uuid;
alter table public.ai_tasks add column if not exists lease_expires_at timestamptz;
alter table public.ai_tasks add column if not exists updated_at timestamptz not null default now();

create table if not exists public.agent_daily_usage (
  owner uuid not null references public.profiles(id) on delete cascade,
  usage_date date not null,
  generation_requests integer not null default 0
    check (generation_requests between 0 and 10000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (owner, usage_date)
);
alter table public.agent_daily_usage enable row level security;
revoke all on public.agent_daily_usage from anon, authenticated;
grant all on public.agent_daily_usage to service_role;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'ai_tasks_content_kind_check'
    and conrelid = 'public.ai_tasks'::regclass) then
    alter table public.ai_tasks add constraint ai_tasks_content_kind_check
      check (content_kind in ('post','reel','article','image','newsletter','promo'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'ai_tasks_schedule_day_check'
    and conrelid = 'public.ai_tasks'::regclass) then
    alter table public.ai_tasks add constraint ai_tasks_schedule_day_check
      check (schedule_day is null or schedule_day between 0 and 6);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'ai_tasks_lead_minutes_check'
    and conrelid = 'public.ai_tasks'::regclass) then
    alter table public.ai_tasks add constraint ai_tasks_lead_minutes_check
      check (lead_minutes between 0 and 10080);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'ai_tasks_account_owner_fkey'
    and conrelid = 'public.ai_tasks'::regclass) then
    alter table public.ai_tasks add constraint ai_tasks_account_owner_fkey
      foreign key (account_id)
      references public.account_ledger(id) on delete set null not valid;
  end if;
end $$;

-- Scheduling state, run leases, and results are server-owned. Owners may edit
-- only the human-authored task definition and may still delete their tasks.
revoke insert, update on public.ai_tasks from authenticated;
grant insert (
  owner, persona_id, backend_id, name, task_type, instructions, cadence,
  active, destination, account_id, content_kind, schedule_day, schedule_time,
  timezone, lead_minutes, approval_required
) on public.ai_tasks to authenticated;
grant update (
  persona_id, backend_id, name, task_type, instructions, cadence,
  active, destination, account_id, content_kind, schedule_day, schedule_time,
  timezone, lead_minutes, approval_required
) on public.ai_tasks to authenticated;

alter table public.drafts add column if not exists source_task_id uuid references public.ai_tasks(id) on delete set null;
alter table public.drafts add column if not exists account_id uuid;
alter table public.drafts add column if not exists content_kind text not null default 'post';
alter table public.drafts add column if not exists approval_state text not null default 'draft';
alter table public.drafts add column if not exists publish_state text not null default 'not_queued';
alter table public.drafts add column if not exists publish_at timestamptz;
alter table public.drafts add column if not exists approved_at timestamptz;
alter table public.drafts add column if not exists approved_content_hash text not null default '';
alter table public.drafts add column if not exists posted_at timestamptz;
alter table public.drafts add column if not exists provider_post_id text not null default '';
alter table public.drafts add column if not exists publish_error text not null default '';
alter table public.drafts add column if not exists generated_by_agent boolean not null default false;
alter table public.drafts add column if not exists updated_at timestamptz not null default now();

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'drafts_content_kind_check'
    and conrelid = 'public.drafts'::regclass) then
    alter table public.drafts add constraint drafts_content_kind_check
      check (content_kind in ('post','reel','article','image','newsletter','promo'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'drafts_approval_state_check'
    and conrelid = 'public.drafts'::regclass) then
    alter table public.drafts add constraint drafts_approval_state_check
      check (approval_state in ('draft','pending','approved','rejected'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'drafts_publish_state_check'
    and conrelid = 'public.drafts'::regclass) then
    alter table public.drafts add constraint drafts_publish_state_check
      check (publish_state in ('not_queued','queued','publishing','published','failed','blocked'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'drafts_account_owner_fkey'
    and conrelid = 'public.drafts'::regclass) then
    alter table public.drafts add constraint drafts_account_owner_fkey
      foreign key (account_id)
      references public.account_ledger(id) on delete set null not valid;
  end if;
end $$;

create table if not exists public.agent_actions (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null references public.profiles(id) on delete cascade,
  persona_id uuid,
  binding_id uuid references public.agent_bindings(id) on delete set null,
  action_type text not null,
  entity_type text not null default '',
  entity_id uuid,
  outcome text not null default 'ok',
  detail jsonb not null default '{}',
  created_at timestamptz not null default now(),
  foreign key (persona_id, owner)
    references public.personas(id, owner) on delete cascade
);
alter table public.agent_actions enable row level security;
drop policy if exists "agent actions owner read" on public.agent_actions;
drop policy if exists "agent actions owner insert" on public.agent_actions;
create policy "agent actions owner read" on public.agent_actions for select
  using (auth.uid() = owner);
revoke insert, update, delete on public.agent_actions from anon, authenticated;
create index if not exists agent_actions_owner_created_idx
  on public.agent_actions (owner, created_at desc);
create index if not exists agent_actions_persona_created_idx
  on public.agent_actions (persona_id, created_at desc);

create table if not exists public.agent_messages (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null references public.profiles(id) on delete cascade,
  persona_id uuid,
  conversation_key text not null,
  role text not null check (role in ('user','assistant','system')),
  content text not null check (char_length(content) between 1 and 20000),
  created_at timestamptz not null default now(),
  foreign key (persona_id, owner)
    references public.personas(id, owner) on delete cascade
);
alter table public.agent_messages enable row level security;
drop policy if exists "agent messages owner only" on public.agent_messages;
create policy "agent messages owner only" on public.agent_messages for all
  using (auth.uid() = owner) with check (
    auth.uid() = owner and (persona_id is null or public.owns_persona(persona_id))
  );
create index if not exists agent_messages_conversation_idx
  on public.agent_messages (owner, conversation_key, created_at);

create table if not exists public.fan_chat_sessions (
  id uuid primary key,
  owner uuid not null references public.profiles(id) on delete cascade,
  persona_id uuid not null,
  visitor_key_hash text not null,
  escalated boolean not null default false,
  escalation_reason text not null default '',
  inbox_state text not null default 'unread'
    check (inbox_state in ('unread','read','resolved')),
  response_pending boolean not null default false,
  response_lease_token uuid,
  response_lease_expires_at timestamptz,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  foreign key (persona_id, owner)
    references public.personas(id, owner) on delete cascade
);
alter table public.fan_chat_sessions
  add column if not exists response_pending boolean not null default false;
alter table public.fan_chat_sessions
  add column if not exists response_lease_token uuid;
alter table public.fan_chat_sessions
  add column if not exists response_lease_expires_at timestamptz;
alter table public.fan_chat_sessions enable row level security;
drop policy if exists "fan sessions owner read" on public.fan_chat_sessions;
drop policy if exists "fan sessions owner update" on public.fan_chat_sessions;
create policy "fan sessions owner read" on public.fan_chat_sessions for select
  using (auth.uid() = owner);
create policy "fan sessions owner update" on public.fan_chat_sessions for update
  using (auth.uid() = owner) with check (auth.uid() = owner);
revoke insert, delete on public.fan_chat_sessions from anon, authenticated;
revoke update on public.fan_chat_sessions from anon, authenticated;
grant update (inbox_state) on public.fan_chat_sessions to authenticated;
create index if not exists fan_chat_sessions_owner_idx
  on public.fan_chat_sessions (owner, inbox_state, last_seen_at desc);
create index if not exists fan_chat_sessions_visitor_idx
  on public.fan_chat_sessions (persona_id, visitor_key_hash, created_at desc);

create table if not exists public.fan_chat_messages (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.fan_chat_sessions(id) on delete cascade,
  owner uuid not null references public.profiles(id) on delete cascade,
  persona_id uuid not null,
  role text not null check (role in ('fan','assistant','system')),
  content text not null check (char_length(content) between 1 and 12000),
  flagged boolean not null default false,
  created_at timestamptz not null default now(),
  foreign key (persona_id, owner)
    references public.personas(id, owner) on delete cascade
);
alter table public.fan_chat_messages enable row level security;
drop policy if exists "fan messages owner read" on public.fan_chat_messages;
create policy "fan messages owner read" on public.fan_chat_messages for select
  using (auth.uid() = owner);
revoke insert, update, delete on public.fan_chat_messages from anon, authenticated;
create index if not exists fan_chat_messages_session_idx
  on public.fan_chat_messages (session_id, created_at);

-- Reserve each public message, quota unit, response lease, session state, and
-- audit record in one transaction. The persona-wide daily lock is the hard
-- cost boundary even when a visitor rotates their browser token.
create or replace function public.reserve_fan_chat_message(
  p_session_id uuid,
  p_persona_id uuid,
  p_owner uuid,
  p_visitor_key_hash text,
  p_message text,
  p_flag_reasons text[],
  p_hourly_limit integer,
  p_response_token uuid
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_persona public.personas%rowtype;
  v_binding public.agent_bindings%rowtype;
  v_settings public.agent_owner_settings%rowtype;
  v_session public.fan_chat_sessions%rowtype;
  v_session_found boolean := false;
  v_reasons text[] := array[]::text[];
  v_awaiting_human boolean := false;
  v_escalated boolean := false;
  v_usage_date date;
  v_day_start timestamptz;
  v_day_end timestamptz;
  v_daily_count integer := 0;
  v_hourly_count integer := 0;
begin
  if p_session_id is null or p_response_token is null or
     p_visitor_key_hash !~ '^[0-9a-f]{64}$' or
     char_length(trim(coalesce(p_message,''))) not between 1 and 2000 or
     p_hourly_limit not between 1 and 100 then
    return jsonb_build_object('accepted',false,'code','invalid_request');
  end if;

  select * into v_persona from public.personas
    where id = p_persona_id and owner = p_owner
      and visibility in ('public','unlisted') and not coalesce(nsfw,false)
    for share;
  if not found then
    return jsonb_build_object('accepted',false,'code','persona_unavailable');
  end if;
  select * into v_binding from public.agent_bindings
    where owner = p_owner and persona_id = p_persona_id for share;
  if not found or v_binding.status <> 'active' or
     v_binding.claim_state not in ('self_attested','verified') or
     not v_binding.fan_chat_enabled then
    return jsonb_build_object('accepted',false,'code','fan_chat_disabled');
  end if;
  select * into v_settings from public.agent_owner_settings
    where owner = p_owner for share;
  if not found or v_settings.automation_paused then
    return jsonb_build_object('accepted',false,'code','owner_paused');
  end if;

  v_usage_date := (now() at time zone v_settings.default_timezone)::date;
  perform pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'fan-chat-day:' || p_persona_id::text || ':' || v_usage_date::text, 0
  ));
  v_day_start := v_usage_date::timestamp at time zone v_settings.default_timezone;
  v_day_end := (v_usage_date + 1)::timestamp at time zone v_settings.default_timezone;

  select * into v_session from public.fan_chat_sessions
    where id = p_session_id for update;
  v_session_found := found;
  if v_session_found and (
    v_session.owner <> p_owner or v_session.persona_id <> p_persona_id or
    v_session.visitor_key_hash <> p_visitor_key_hash
  ) then
    return jsonb_build_object('accepted',false,'code','invalid_session');
  end if;
  if v_session_found and v_session.response_pending and
     v_session.response_lease_expires_at > now() then
    return jsonb_build_object('accepted',false,'code','session_busy');
  end if;

  select count(*) into v_daily_count from public.fan_chat_messages
    where owner = p_owner and persona_id = p_persona_id and role = 'fan'
      and created_at >= v_day_start and created_at < v_day_end;
  if v_daily_count >= v_binding.fan_daily_message_limit then
    return jsonb_build_object(
      'accepted',false,'code','persona_daily_limit',
      'used',v_daily_count,'limit',v_binding.fan_daily_message_limit
    );
  end if;

  select count(*) into v_hourly_count
  from public.fan_chat_messages message
  join public.fan_chat_sessions session on session.id = message.session_id
  where session.persona_id = p_persona_id
    and session.visitor_key_hash = p_visitor_key_hash
    and message.role = 'fan'
    and message.created_at >= now() - interval '1 hour';
  if v_hourly_count >= p_hourly_limit then
    return jsonb_build_object(
      'accepted',false,'code','visitor_hourly_limit',
      'used',v_hourly_count,'limit',p_hourly_limit
    );
  end if;

  select coalesce(array_agg(reason),array[]::text[]) into v_reasons
  from (
    select left(trim(reason),50) as reason
    from unnest(coalesce(p_flag_reasons,array[]::text[])) reason
    where trim(reason) <> ''
    limit 8
  ) cleaned;
  v_awaiting_human := v_session_found and v_session.escalated
    and v_session.inbox_state <> 'resolved';
  v_escalated := cardinality(v_reasons) > 0 or v_awaiting_human;

  if not v_session_found then
    insert into public.fan_chat_sessions (
      id, owner, persona_id, visitor_key_hash, escalated,
      escalation_reason, inbox_state, response_pending,
      response_lease_token, response_lease_expires_at, last_seen_at
    ) values (
      p_session_id, p_owner, p_persona_id, p_visitor_key_hash, v_escalated,
      case when cardinality(v_reasons) > 0
        then left(array_to_string(v_reasons,','),200) else '' end,
      'unread', true, p_response_token, now() + interval '90 seconds', now()
    ) returning * into v_session;
  else
    update public.fan_chat_sessions set
      escalated = case
        when cardinality(v_reasons) > 0 then true
        when inbox_state = 'resolved' then false
        else escalated end,
      escalation_reason = case
        when cardinality(v_reasons) > 0 then left(array_to_string(v_reasons,','),200)
        when inbox_state = 'resolved' then ''
        else escalation_reason end,
      inbox_state = 'unread',
      last_seen_at = now(),
      response_pending = true,
      response_lease_token = p_response_token,
      response_lease_expires_at = now() + interval '90 seconds'
    where id = p_session_id returning * into v_session;
  end if;

  insert into public.fan_chat_messages (
    session_id, owner, persona_id, role, content, flagged
  ) values (
    p_session_id, p_owner, p_persona_id, 'fan', trim(p_message), v_escalated
  );
  insert into public.agent_actions (
    owner, persona_id, binding_id, action_type, entity_type, entity_id,
    outcome, detail
  ) values (
    p_owner, p_persona_id, v_binding.id, 'fan_chat.received',
    'fan_chat_session', p_session_id,
    case when v_escalated then 'escalated' else 'ok' end,
    jsonb_build_object('messageCharacters',char_length(trim(p_message)),
      'dailyMessageNumber',v_daily_count + 1,
      'categories',to_jsonb(v_reasons))
  );
  return jsonb_build_object(
    'accepted',true,'escalated',v_escalated,
    'awaitingHuman',v_awaiting_human,'categories',to_jsonb(v_reasons),
    'dailyMessageNumber',v_daily_count + 1
  );
end;
$$;

create or replace function public.complete_fan_chat_reply(
  p_session_id uuid,
  p_owner uuid,
  p_response_token uuid,
  p_reply text,
  p_outcome text,
  p_categories text[] default array[]::text[]
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_session public.fan_chat_sessions%rowtype;
  v_binding_id uuid;
  v_flagged boolean;
begin
  if char_length(trim(coalesce(p_reply,''))) not between 1 and 4000 or
     p_outcome not in ('ok','escalated','model_error') then
    raise exception 'Invalid fan reply completion';
  end if;
  select * into v_session from public.fan_chat_sessions
    where id = p_session_id and owner = p_owner for update;
  if not found or not v_session.response_pending or
     v_session.response_lease_token is distinct from p_response_token then
    return false;
  end if;
  select id into v_binding_id from public.agent_bindings
    where owner = p_owner and persona_id = v_session.persona_id;
  if not found then raise exception 'Persona binding is unavailable'; end if;
  v_flagged := p_outcome <> 'ok';
  insert into public.fan_chat_messages (
    session_id, owner, persona_id, role, content, flagged
  ) values (
    p_session_id, p_owner, v_session.persona_id, 'assistant', trim(p_reply),
    v_flagged
  );
  update public.fan_chat_sessions set
    response_pending = false,
    response_lease_token = null,
    response_lease_expires_at = null,
    last_seen_at = now(),
    inbox_state = 'unread',
    escalated = case when v_flagged then true else escalated end,
    escalation_reason = case
      when p_outcome = 'model_error' and escalation_reason = ''
        then 'model_unavailable'
      when p_outcome = 'escalated' and escalation_reason = '' then
        left(coalesce(nullif(array_to_string(p_categories, ','),''),
          'owner_review'), 500)
      else escalation_reason end
  where id = p_session_id;
  insert into public.agent_actions (
    owner, persona_id, binding_id, action_type, entity_type, entity_id,
    outcome, detail
  ) values (
    p_owner, v_session.persona_id, v_binding_id, 'fan_chat.response',
    'fan_chat_session', p_session_id, p_outcome,
    jsonb_build_object('replyCharacters',char_length(trim(p_reply)),
      'categories',to_jsonb(coalesce(p_categories,array[]::text[])))
  );
  return true;
end;
$$;

revoke all on function public.reserve_fan_chat_message(
  uuid,uuid,uuid,text,text,text[],integer,uuid
) from public, anon, authenticated;
grant execute on function public.reserve_fan_chat_message(
  uuid,uuid,uuid,text,text,text[],integer,uuid
) to service_role;
revoke all on function public.complete_fan_chat_reply(
  uuid,uuid,uuid,text,text,text[]
) from public, anon, authenticated;
grant execute on function public.complete_fan_chat_reply(
  uuid,uuid,uuid,text,text,text[]
) to service_role;

create or replace function public.touch_agent_updated_at()
returns trigger language plpgsql set search_path = public as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists touch_agent_owner_settings on public.agent_owner_settings;
create trigger touch_agent_owner_settings before update on public.agent_owner_settings
  for each row execute function public.touch_agent_updated_at();
drop trigger if exists touch_agent_bindings on public.agent_bindings;
create trigger touch_agent_bindings before update on public.agent_bindings
  for each row execute function public.touch_agent_updated_at();
drop trigger if exists touch_agent_destinations on public.agent_destinations;
create trigger touch_agent_destinations before update on public.agent_destinations
  for each row execute function public.touch_agent_updated_at();
drop trigger if exists touch_persona_content_plans on public.persona_content_plans;
create trigger touch_persona_content_plans before update on public.persona_content_plans
  for each row execute function public.touch_agent_updated_at();
drop trigger if exists touch_ai_tasks on public.ai_tasks;
create trigger touch_ai_tasks before update on public.ai_tasks
  for each row execute function public.touch_agent_updated_at();
drop trigger if exists touch_drafts on public.drafts;
create trigger touch_drafts before update on public.drafts
  for each row execute function public.touch_agent_updated_at();

-- Approval, publication, provenance, and audit state are server-owned. Owners may
-- edit draft content/target/time, but any such edit invalidates prior approval.
revoke insert on public.drafts from authenticated;
grant insert (
  owner, persona_id, platform, title, body, tags, media_url, status,
  scheduled_for, account_id, content_kind, publish_at
) on public.drafts to authenticated;
revoke update on public.drafts from authenticated;
grant update (
  persona_id, platform, title, body, tags, media_url, status,
  scheduled_for, account_id, content_kind, publish_at
) on public.drafts to authenticated;
revoke delete on public.drafts from authenticated;

create or replace function public.ensure_agent_owner_settings()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.agent_owner_settings (owner)
  values (new.id) on conflict (owner) do nothing;
  return new;
end;
$$;
drop trigger if exists ensure_agent_owner_settings on public.profiles;
create trigger ensure_agent_owner_settings after insert on public.profiles
  for each row execute function public.ensure_agent_owner_settings();

create or replace function public.ensure_persona_agent_binding()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.agent_owner_settings (owner)
  values (new.owner) on conflict (owner) do nothing;
  insert into public.agent_bindings (owner, persona_id)
  values (new.owner, new.id) on conflict (persona_id) do nothing;
  return new;
end;
$$;
drop trigger if exists ensure_persona_agent_binding on public.personas;
create trigger ensure_persona_agent_binding after insert on public.personas
  for each row execute function public.ensure_persona_agent_binding();

create or replace function public.guard_agent_destination()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_binding_persona uuid;
  v_provider text;
  v_autonomy smallint;
begin
  select persona_id, autonomy_level into v_binding_persona, v_autonomy
    from public.agent_bindings
    where id = new.binding_id and owner = new.owner;
  if not found or v_binding_persona <> new.persona_id then
    raise exception 'Destination binding does not match this persona';
  end if;
  if new.account_id is null then
    new.destination := 'aliaspaces';
    if new.mode = 'auto' and v_autonomy < 3 then
      raise exception 'Bounded native auto mode requires L3 autonomy';
    end if;
  else
    select provider into v_provider from public.account_ledger
      where id = new.account_id and owner = new.owner
        and persona_id = new.persona_id;
    if not found then
      raise exception 'Destination account must be assigned to this persona';
    end if;
    new.destination := v_provider;
    if new.mode = 'auto' then
      raise exception 'External auto mode requires a verified official connector and is not enabled';
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists guard_agent_destination on public.agent_destinations;
create trigger guard_agent_destination before insert or update on public.agent_destinations
  for each row execute function public.guard_agent_destination();

create or replace function public.ensure_native_agent_destination()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.agent_destinations (
    owner, binding_id, persona_id, destination, mode
  ) values (
    new.owner, new.id, new.persona_id, 'aliaspaces', 'approval'
  ) on conflict do nothing;
  return new;
end;
$$;
drop trigger if exists ensure_native_agent_destination on public.agent_bindings;
create trigger ensure_native_agent_destination after insert on public.agent_bindings
  for each row execute function public.ensure_native_agent_destination();

insert into public.agent_owner_settings (owner)
select id from public.profiles on conflict (owner) do nothing;
insert into public.agent_bindings (owner, persona_id)
select owner, id from public.personas on conflict (persona_id) do nothing;
insert into public.agent_destinations (owner, binding_id, persona_id, destination, mode)
select owner, id, persona_id, 'aliaspaces', 'approval'
from public.agent_bindings on conflict do nothing;

create or replace function public.next_content_occurrence(
  p_cadence text,
  p_day smallint,
  p_time time,
  p_timezone text,
  p_after timestamptz
)
returns timestamptz
language plpgsql stable set search_path = '' as $$
declare
  v_local_after timestamp;
  v_date date;
  v_days integer := 0;
  v_candidate timestamp;
begin
  if p_cadence = 'manual' then return null; end if;
  if p_cadence not in ('daily','weekly') then
    raise exception 'Unsupported cadence';
  end if;
  if trim(coalesce(p_timezone,'')) = '' then
    raise exception 'Time zone is required';
  end if;
  v_local_after := p_after at time zone p_timezone;
  v_date := v_local_after::date;
  if p_cadence = 'weekly' then
    if p_day is null or p_day < 0 or p_day > 6 then
      raise exception 'Weekly schedules require a day from 0 through 6';
    end if;
    v_days := (p_day - extract(dow from v_date)::integer + 7) % 7;
  end if;
  v_candidate := (v_date + v_days)::timestamp + p_time;
  if v_candidate <= v_local_after then
    v_candidate := v_candidate + case when p_cadence = 'daily'
      then interval '1 day' else interval '7 days' end;
  end if;
  return v_candidate at time zone p_timezone;
end;
$$;

create or replace function public.set_ai_task_schedule()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.lease_token := null;
  new.lease_expires_at := null;
  if not new.active or new.cadence = 'manual' then
    new.next_run_at := null;
    new.next_publish_at := null;
    return new;
  end if;
  new.next_publish_at := public.next_content_occurrence(
    new.cadence, new.schedule_day, new.schedule_time, new.timezone, now()
  );
  new.next_run_at := greatest(
    new.next_publish_at - make_interval(mins => new.lead_minutes),
    now() + interval '1 minute'
  );
  return new;
end;
$$;

-- Legacy tasks predate precise day/time controls. Keep ambiguous rows paused for
-- owner review instead of guessing a posting day or aborting this migration.
update public.ai_tasks set
  cadence = 'manual', active = false,
  last_status = 'needs_schedule_review',
  last_error = 'This legacy cadence needs to be reselected before automation can run.'
where cadence is null or cadence not in ('manual','daily','weekly');
alter table public.ai_tasks alter column cadence set default 'manual';
alter table public.ai_tasks alter column cadence set not null;
do $$ begin
  if not exists (select 1 from pg_constraint
    where conname = 'ai_tasks_cadence_check'
      and conrelid = 'public.ai_tasks'::regclass) then
    alter table public.ai_tasks add constraint ai_tasks_cadence_check
      check (cadence in ('manual','daily','weekly'));
  end if;
end $$;
update public.ai_tasks set
  active = false,
  last_status = 'needs_schedule_day',
  last_error = 'Choose a weekday before resuming this legacy weekly schedule.'
where cadence = 'weekly' and schedule_day is null;
update public.ai_tasks set
  timezone = 'UTC', active = false,
  last_status = 'needs_timezone_review',
  last_error = 'Choose a valid time zone before resuming this legacy schedule.'
where not exists (
  select 1 from pg_catalog.pg_timezone_names z where z.name = ai_tasks.timezone
);

drop trigger if exists set_ai_task_schedule on public.ai_tasks;
create trigger set_ai_task_schedule
  before insert or update of active, cadence, schedule_day, schedule_time, timezone, lead_minutes
  on public.ai_tasks for each row execute function public.set_ai_task_schedule();

drop function if exists public.advance_ai_task_schedule(
  uuid, timestamptz, text, text
);
create or replace function public.advance_ai_task_schedule(
  p_task_id uuid,
  p_finished_at timestamptz default now(),
  p_status text default 'drafted',
  p_error text default '',
  p_lease_token uuid default null
)
returns public.ai_tasks
language plpgsql security definer set search_path = '' as $$
declare
  v_task public.ai_tasks%rowtype;
  v_after timestamptz;
begin
  select * into v_task from public.ai_tasks where id = p_task_id for update;
  if not found then raise exception 'Task not found'; end if;
  if p_lease_token is null then
    raise exception 'Task lease token is required';
  end if;
  if v_task.lease_token is distinct from p_lease_token then
    raise exception 'Task lease no longer belongs to this worker';
  end if;
  v_after := greatest(p_finished_at, coalesce(v_task.next_publish_at, p_finished_at)) + interval '1 second';
  update public.ai_tasks set
    last_run = p_finished_at,
    last_status = left(coalesce(p_status,''),80),
    last_error = left(coalesce(p_error,''),1000),
    next_publish_at = case when v_task.active and v_task.cadence <> 'manual'
      then public.next_content_occurrence(v_task.cadence, v_task.schedule_day,
        v_task.schedule_time, v_task.timezone, v_after) else null end,
    lease_token = null,
    lease_expires_at = null
  where id = p_task_id
  returning * into v_task;
  update public.ai_tasks set next_run_at = case
    when v_task.next_publish_at is null then null
    else greatest(v_task.next_publish_at - make_interval(mins => v_task.lead_minutes),
      p_finished_at + interval '1 minute') end
  where id = p_task_id returning * into v_task;
  return v_task;
end;
$$;
revoke all on function public.advance_ai_task_schedule(uuid,timestamptz,text,text,uuid)
  from public, anon, authenticated;
grant execute on function public.advance_ai_task_schedule(uuid,timestamptz,text,text,uuid)
  to service_role;

create or replace function public.claim_ai_task_generation(
  p_task_id uuid,
  p_due_at timestamptz,
  p_lease_token uuid
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_task public.ai_tasks%rowtype;
begin
  if p_lease_token is null then raise exception 'Lease token is required'; end if;
  select * into v_task from public.ai_tasks where id = p_task_id for update;
  if not found or not v_task.active or v_task.next_run_at is null
    or v_task.next_run_at > p_due_at
    or (v_task.lease_expires_at is not null and v_task.lease_expires_at > now()) then
    return false;
  end if;
  update public.ai_tasks set
    lease_token = p_lease_token,
    lease_expires_at = now() + interval '5 minutes',
    last_status = 'processing',
    last_error = ''
  where id = p_task_id;
  return true;
end;
$$;
revoke all on function public.claim_ai_task_generation(uuid,timestamptz,uuid)
  from public, anon, authenticated;
grant execute on function public.claim_ai_task_generation(uuid,timestamptz,uuid)
  to service_role;

create or replace function public.reserve_agent_generation(
  p_task_id uuid,
  p_owner uuid,
  p_lease_token uuid
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_task public.ai_tasks%rowtype;
  v_settings public.agent_owner_settings%rowtype;
  v_binding public.agent_bindings%rowtype;
  v_usage_date date;
  v_day_start timestamptz;
  v_day_end timestamptz;
  v_existing_drafts integer := 0;
  v_used integer := 0;
  v_next integer := 0;
begin
  select * into v_task from public.ai_tasks
    where id = p_task_id and owner = p_owner for update;
  if not found or v_task.lease_token is distinct from p_lease_token
    or v_task.lease_expires_at is null or v_task.lease_expires_at <= now() then
    return jsonb_build_object('reserved',false,'code','lease_lost');
  end if;

  select * into v_settings from public.agent_owner_settings
    where owner = p_owner for share;
  if not found then
    return jsonb_build_object('reserved',false,'code','settings_unavailable');
  end if;
  if v_settings.automation_paused then
    return jsonb_build_object('reserved',false,'code','owner_paused');
  end if;

  select * into v_binding from public.agent_bindings
    where owner = p_owner and persona_id = v_task.persona_id for share;
  if not found or v_binding.status <> 'active' or
     v_binding.claim_state not in ('self_attested','verified') or
     v_binding.autonomy_level < 1 then
    return jsonb_build_object('reserved',false,'code','binding_inactive');
  end if;

  v_usage_date := (now() at time zone v_settings.default_timezone)::date;
  perform pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'agent-generation-day:' || p_owner::text || ':' || v_usage_date::text, 0
  ));
  v_day_start := v_usage_date::timestamp at time zone v_settings.default_timezone;
  v_day_end := (v_usage_date + 1)::timestamp at time zone v_settings.default_timezone;
  select count(*) into v_existing_drafts from public.drafts
    where owner = p_owner and generated_by_agent
      and created_at >= v_day_start and created_at < v_day_end;
  select generation_requests into v_used from public.agent_daily_usage
    where owner = p_owner and usage_date = v_usage_date for update;
  if not found then v_used := 0; end if;
  v_used := greatest(v_used, v_existing_drafts);
  if v_used >= v_settings.daily_draft_limit then
    return jsonb_build_object(
      'reserved',false,'code','daily_cap','used',v_used,
      'limit',v_settings.daily_draft_limit
    );
  end if;
  v_next := v_used + 1;
  insert into public.agent_daily_usage (
    owner, usage_date, generation_requests, updated_at
  ) values (p_owner, v_usage_date, v_next, now())
  on conflict (owner, usage_date) do update set
    generation_requests = excluded.generation_requests,
    updated_at = excluded.updated_at;

  insert into public.agent_actions (
    owner, persona_id, binding_id, action_type, entity_type, entity_id,
    outcome, detail
  ) values (
    p_owner, v_task.persona_id, v_binding.id, 'ai.call.started',
    'ai_task', v_task.id, 'started',
    jsonb_build_object('generationRequest',v_next,
      'dailyLimit',v_settings.daily_draft_limit)
  );
  return jsonb_build_object(
    'reserved',true,'used',v_next,'limit',v_settings.daily_draft_limit
  );
end;
$$;
revoke all on function public.reserve_agent_generation(uuid,uuid,uuid)
  from public, anon, authenticated;
grant execute on function public.reserve_agent_generation(uuid,uuid,uuid)
  to service_role;

create or replace function public.guard_ai_task_assignment()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_provider text;
begin
  if new.persona_id is not null and not exists (
    select 1 from public.personas where id = new.persona_id and owner = new.owner
  ) then raise exception 'Task persona is not owned by this account'; end if;
  if new.backend_id is not null and not exists (
    select 1 from public.ai_backends where id = new.backend_id and owner = new.owner
  ) then raise exception 'Task model is not owned by this account'; end if;
  if new.account_id is not null then
    select provider into v_provider from public.account_ledger
      where id = new.account_id and owner = new.owner
        and persona_id = new.persona_id;
    if not found then
      raise exception 'Destination account must be assigned to the task persona';
    end if;
    new.destination := v_provider;
  elsif trim(coalesce(new.destination,'')) = '' then
    new.destination := 'aliaspaces';
  end if;
  -- Generation never approves its own output. L3 means an exact owner-approved
  -- native draft may publish automatically when due, not self-approval.
  new.approval_required := true;
  return new;
end;
$$;
drop trigger if exists guard_ai_task_assignment on public.ai_tasks;
create trigger guard_ai_task_assignment before insert or update on public.ai_tasks
  for each row execute function public.guard_ai_task_assignment();

create or replace function public.guard_draft_assignment()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.persona_id is not null and not exists (
    select 1 from public.personas where id = new.persona_id and owner = new.owner
  ) then raise exception 'Draft persona is not owned by this account'; end if;
  if new.account_id is not null and not exists (
    select 1 from public.account_ledger where id = new.account_id
      and owner = new.owner and persona_id = new.persona_id
  ) then raise exception 'Draft destination must be assigned to its persona'; end if;
  return new;
end;
$$;
drop trigger if exists guard_draft_assignment on public.drafts;
create trigger guard_draft_assignment before insert or update on public.drafts
  for each row execute function public.guard_draft_assignment();

create or replace function public.agent_draft_hash(
  p_title text,
  p_body text,
  p_tags text,
  p_media_url text,
  p_content_kind text,
  p_persona_id uuid,
  p_account_id uuid,
  p_platform text,
  p_publish_at timestamptz
)
returns text
language sql immutable set search_path = '' as $$
  select encode(extensions.digest(
    concat_ws(chr(31), coalesce(p_title,''), coalesce(p_body,''),
      coalesce(p_tags,''), coalesce(p_media_url,''), coalesce(p_content_kind,''),
      coalesce(p_persona_id::text,''), coalesce(p_account_id::text,'native'),
      coalesce(nullif(lower(trim(p_platform)),''),'aliaspaces'),
      coalesce(((extract(epoch from p_publish_at) * 1000000)::bigint)::text,'')),
    'sha256'
  ), 'hex');
$$;

create or replace function public.invalidate_changed_draft_approval()
returns trigger language plpgsql set search_path = '' as $$
declare v_hash text;
begin
  v_hash := public.agent_draft_hash(new.title, new.body, new.tags,
    new.media_url, new.content_kind, new.persona_id, new.account_id,
    new.platform, new.publish_at);
  -- The approval RPC deliberately changes publish_at and writes the matching
  -- content hash in one statement. Preserve that server-authored transition;
  -- browser edits cannot write either approval_state or the hash.
  if new.approval_state = 'approved'
    and new.approved_at is not null
    and new.approved_content_hash = v_hash then
    return new;
  end if;
  if old.approval_state = 'approved' then
    if v_hash is distinct from old.approved_content_hash then
      new.approval_state := 'draft';
      new.approved_at := null;
      new.approved_content_hash := '';
      new.publish_state := 'not_queued';
      new.publish_error := 'Approval was cleared because the content, target, or schedule changed.';
    end if;
  elsif old.approval_state = 'rejected' then
    new.approval_state := 'draft';
    new.approved_at := null;
    new.approved_content_hash := '';
    new.publish_state := 'not_queued';
    new.publish_error := '';
  end if;
  return new;
end;
$$;
drop trigger if exists invalidate_changed_draft_approval on public.drafts;
create trigger invalidate_changed_draft_approval
  before update of title, body, tags, media_url, content_kind, persona_id,
    account_id, platform, publish_at
  on public.drafts for each row execute function public.invalidate_changed_draft_approval();

create or replace function public.guard_publishing_draft_edit()
returns trigger language plpgsql set search_path = '' as $$
begin
  if old.publish_state in ('publishing','published') then
    raise exception 'Publishing or published history is locked; copy it into a new draft instead';
  end if;
  return new;
end;
$$;
drop trigger if exists guard_publishing_draft_edit on public.drafts;
create trigger guard_publishing_draft_edit
  before update of title, body, tags, media_url, content_kind, account_id,
    publish_at, persona_id, platform
  on public.drafts for each row execute function public.guard_publishing_draft_edit();

create or replace function public.audit_agent_binding_change()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.agent_actions (
    owner, persona_id, binding_id, action_type, entity_type, entity_id, detail
  ) values (
    new.owner, new.persona_id, new.id, 'binding.updated', 'binding', new.id,
    jsonb_build_object('status_from',old.status,'status_to',new.status,
      'autonomy_from',old.autonomy_level,'autonomy_to',new.autonomy_level,
      'fan_chat_from',old.fan_chat_enabled,'fan_chat_to',new.fan_chat_enabled,
      'claim_state_from',old.claim_state,'claim_state_to',new.claim_state,
      'claim_ref_changed',old.claim_ref is distinct from new.claim_ref)
  );
  return new;
end;
$$;
drop trigger if exists audit_agent_binding_change on public.agent_bindings;
create trigger audit_agent_binding_change after update on public.agent_bindings
  for each row when (
    old.status is distinct from new.status or
    old.autonomy_level is distinct from new.autonomy_level or
    old.fan_chat_enabled is distinct from new.fan_chat_enabled or
    old.fan_daily_message_limit is distinct from new.fan_daily_message_limit or
    old.claim_state is distinct from new.claim_state or
    old.claim_ref is distinct from new.claim_ref
  ) execute function public.audit_agent_binding_change();

create or replace function public.downgrade_native_auto_destination()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if old.autonomy_level >= 3 and new.autonomy_level < 3 then
    update public.agent_destinations set mode = 'approval'
    where binding_id = new.id and owner = new.owner and account_id is null
      and mode = 'auto';
  end if;
  return new;
end;
$$;
drop trigger if exists downgrade_native_auto_destination on public.agent_bindings;
create trigger downgrade_native_auto_destination
  after update of autonomy_level on public.agent_bindings
  for each row execute function public.downgrade_native_auto_destination();

create or replace function public.audit_agent_owner_settings_change()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.agent_actions (
    owner, action_type, entity_type, entity_id, detail
  ) values (
    new.owner, 'owner_controls.updated', 'owner_controls', new.owner,
    jsonb_build_object('paused_from',old.automation_paused,
      'paused_to',new.automation_paused,'pause_reason',new.pause_reason,
      'timezone',new.default_timezone,'daily_draft_limit',new.daily_draft_limit)
  );
  return new;
end;
$$;
drop trigger if exists audit_agent_owner_settings_change on public.agent_owner_settings;
create trigger audit_agent_owner_settings_change after update on public.agent_owner_settings
  for each row execute function public.audit_agent_owner_settings_change();

create or replace function public.audit_agent_destination_change()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    insert into public.agent_actions (
      owner, persona_id, binding_id, action_type, entity_type, entity_id, detail
    ) values (
      old.owner, old.persona_id, old.binding_id, 'destination.deleted',
      'destination', old.id,
      jsonb_build_object('destination',old.destination,'mode',old.mode,
        'enabled',old.enabled,'daily_publish_limit',old.daily_publish_limit)
    );
    return old;
  end if;
  if tg_op = 'INSERT' then
    insert into public.agent_actions (
      owner, persona_id, binding_id, action_type, entity_type, entity_id, detail
    ) values (
      new.owner, new.persona_id, new.binding_id, 'destination.created',
      'destination', new.id,
      jsonb_build_object('destination',new.destination,'mode',new.mode,
        'enabled',new.enabled,'daily_publish_limit',new.daily_publish_limit)
    );
    return new;
  end if;
  insert into public.agent_actions (
    owner, persona_id, binding_id, action_type, entity_type, entity_id, detail
  ) values (
    new.owner, new.persona_id, new.binding_id, 'destination.updated',
    'destination', new.id,
    jsonb_build_object('destination',new.destination,'mode_from',old.mode,
      'mode_to',new.mode,'enabled',new.enabled,
      'daily_publish_limit',new.daily_publish_limit)
  );
  return new;
end;
$$;
drop trigger if exists audit_agent_destination_change on public.agent_destinations;
create trigger audit_agent_destination_change
  after insert or update or delete on public.agent_destinations
  for each row execute function public.audit_agent_destination_change();

create or replace function public.audit_content_plan_change()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_binding_id uuid;
begin
  select id into v_binding_id from public.agent_bindings
    where persona_id = new.persona_id and owner = new.owner;
  insert into public.agent_actions (
    owner, persona_id, binding_id, action_type, entity_type, entity_id
  ) values (
    new.owner, new.persona_id, v_binding_id, 'direction.updated',
    'content_plan', new.persona_id
  );
  return new;
end;
$$;
drop trigger if exists audit_content_plan_change on public.persona_content_plans;
create trigger audit_content_plan_change after insert or update on public.persona_content_plans
  for each row execute function public.audit_content_plan_change();

create or replace function public.approve_agent_draft(
  p_draft_id uuid,
  p_publish_at timestamptz default null
)
returns public.drafts
language plpgsql security definer set search_path = '' as $$
declare
  v_draft public.drafts%rowtype;
  v_binding public.agent_bindings%rowtype;
  v_hash text;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select * into v_draft from public.drafts
    where id = p_draft_id and owner = auth.uid() for update;
  if not found then raise exception 'Draft not found'; end if;
  if v_draft.publish_state in ('publishing','published') then
    raise exception 'Publishing or published history cannot be approved again';
  end if;
  if v_draft.persona_id is null then raise exception 'Choose a persona before approval'; end if;
  select * into v_binding from public.agent_bindings
    where persona_id = v_draft.persona_id and owner = auth.uid();
  if not found or v_binding.status <> 'active' or v_binding.autonomy_level < 2 then
    raise exception 'This persona must have an active L2 or L3 agent before approval';
  end if;
  v_draft.publish_at := coalesce(p_publish_at, v_draft.publish_at, now());
  v_hash := public.agent_draft_hash(v_draft.title, v_draft.body, v_draft.tags,
    v_draft.media_url, v_draft.content_kind, v_draft.persona_id,
    v_draft.account_id, v_draft.platform, v_draft.publish_at);
  update public.drafts set
    approval_state = 'approved',
    approved_at = now(),
    approved_content_hash = v_hash,
    publish_at = v_draft.publish_at,
    publish_state = 'queued',
    publish_error = '',
    status = 'ready'
  where id = p_draft_id returning * into v_draft;
  insert into public.agent_actions (
    owner, persona_id, binding_id, action_type, entity_type, entity_id, detail
  ) values (
    auth.uid(), v_draft.persona_id, v_binding.id, 'draft.approved',
    'draft', v_draft.id, jsonb_build_object('publish_at',v_draft.publish_at,
      'content_hash',v_hash,'destination',v_draft.platform)
  );
  return v_draft;
end;
$$;
revoke all on function public.approve_agent_draft(uuid,timestamptz)
  from public, anon, authenticated;
grant execute on function public.approve_agent_draft(uuid,timestamptz) to authenticated;

create or replace function public.reject_agent_draft(p_draft_id uuid)
returns public.drafts
language plpgsql security definer set search_path = '' as $$
declare
  v_draft public.drafts%rowtype;
  v_binding_id uuid;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select * into v_draft from public.drafts
    where id = p_draft_id and owner = auth.uid() for update;
  if not found then raise exception 'Draft not found'; end if;
  if v_draft.publish_state in ('publishing','published') then
    raise exception 'Publishing or published history cannot be rejected';
  end if;
  select id into v_binding_id from public.agent_bindings
    where persona_id = v_draft.persona_id and owner = auth.uid();
  update public.drafts set approval_state = 'rejected', approved_at = null,
    approved_content_hash = '', publish_state = 'not_queued', status = 'idea'
  where id = p_draft_id returning * into v_draft;
  insert into public.agent_actions (
    owner, persona_id, binding_id, action_type, entity_type, entity_id
  ) values (
    auth.uid(), v_draft.persona_id, v_binding_id, 'draft.rejected', 'draft', v_draft.id
  );
  return v_draft;
end;
$$;
revoke all on function public.reject_agent_draft(uuid)
  from public, anon, authenticated;
grant execute on function public.reject_agent_draft(uuid) to authenticated;

create or replace function public.delete_my_draft(p_draft_id uuid)
returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  v_draft public.drafts%rowtype;
  v_binding_id uuid;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select * into v_draft from public.drafts
    where id = p_draft_id and owner = auth.uid() for update;
  if not found then raise exception 'Draft not found'; end if;
  if v_draft.publish_state in ('publishing','published') then
    raise exception 'Publishing and published history cannot be deleted from the queue';
  end if;
  select id into v_binding_id from public.agent_bindings
    where persona_id = v_draft.persona_id and owner = auth.uid();
  delete from public.drafts where id = p_draft_id;
  insert into public.agent_actions (
    owner, persona_id, binding_id, action_type, entity_type, entity_id
  ) values (
    auth.uid(), v_draft.persona_id, v_binding_id, 'draft.deleted',
    'draft', v_draft.id
  );
  return true;
end;
$$;
revoke all on function public.delete_my_draft(uuid)
  from public, anon, authenticated;
grant execute on function public.delete_my_draft(uuid) to authenticated;

-- Explicit erasure is separate from ordinary queue deletion so a user can still
-- remove all of their data, including immutable publication history.
create or replace function public.delete_my_drafts_for_erasure()
returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  delete from public.drafts where owner = auth.uid();
  return true;
end;
$$;
revoke all on function public.delete_my_drafts_for_erasure()
  from public, anon, authenticated;
grant execute on function public.delete_my_drafts_for_erasure() to authenticated;

create or replace function public.mark_manual_draft_posted(p_draft_id uuid)
returns public.drafts
language plpgsql security definer set search_path = '' as $$
declare
  v_draft public.drafts%rowtype;
  v_binding_id uuid;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select * into v_draft from public.drafts
    where id = p_draft_id and owner = auth.uid() for update;
  if not found then raise exception 'Draft not found'; end if;
  if v_draft.publish_state in ('publishing','published') then
    raise exception 'This draft is already publishing or published';
  end if;
  if v_draft.account_id is null and
     coalesce(nullif(lower(trim(v_draft.platform)),''),'aliaspaces') in (
       'aliaspaces','aliaspaces.com','mypersonas','mypersonas.online'
     ) then
    raise exception 'Native posts must use the publishing bridge';
  end if;
  select id into v_binding_id from public.agent_bindings
    where persona_id = v_draft.persona_id and owner = auth.uid();
  update public.drafts set status = 'posted', publish_state = 'published',
    posted_at = now(), provider_post_id = 'manual', publish_error = ''
  where id = p_draft_id returning * into v_draft;
  insert into public.agent_actions (
    owner, persona_id, binding_id, action_type, entity_type, entity_id,
    detail
  ) values (
    auth.uid(), v_draft.persona_id, v_binding_id, 'draft.manual_posted',
    'draft', v_draft.id, jsonb_build_object('destination',v_draft.platform)
  );
  return v_draft;
end;
$$;
revoke all on function public.mark_manual_draft_posted(uuid)
  from public, anon, authenticated;
grant execute on function public.mark_manual_draft_posted(uuid) to authenticated;

create or replace function public.agent_in_quiet_hours(
  p_timezone text,
  p_start time,
  p_end time,
  p_at timestamptz default now()
)
returns boolean
language plpgsql stable set search_path = '' as $$
declare v_local_time time;
begin
  if p_start is null or p_end is null then return false; end if;
  v_local_time := (p_at at time zone p_timezone)::time;
  if p_start = p_end then return false; end if;
  if p_start < p_end then
    return v_local_time >= p_start and v_local_time < p_end;
  end if;
  return v_local_time >= p_start or v_local_time < p_end;
end;
$$;

-- Native publication is one database transaction: lock current controls, recheck
-- exact approval and limits, insert the post, finalize the draft, and write audit.
-- This removes the check/claim/insert gaps that can duplicate posts or exceed caps.
create or replace function public.publish_native_agent_draft(
  p_draft_id uuid,
  p_owner uuid,
  p_require_due boolean default false
)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_draft public.drafts%rowtype;
  v_settings public.agent_owner_settings%rowtype;
  v_binding public.agent_bindings%rowtype;
  v_target public.agent_destinations%rowtype;
  v_post public.posts%rowtype;
  v_hash text;
  v_required_autonomy smallint;
  v_local_date date;
  v_day_start timestamptz;
  v_day_end timestamptz;
  v_published_count integer;
  v_now timestamptz := now();
begin
  if p_owner is null then raise exception 'Owner is required'; end if;

  select * into v_draft from public.drafts
    where id = p_draft_id and owner = p_owner for update;
  if not found then raise exception 'Draft not found'; end if;

  if v_draft.publish_state = 'published' then
    select * into v_post from public.posts
      where id::text = v_draft.provider_post_id
        and persona_id = v_draft.persona_id;
    if not found then
      raise exception 'Published draft requires reconciliation';
    end if;
    return jsonb_build_object(
      'published',true,'draftId',v_draft.id,'postId',v_post.id,
      'postedAt',v_draft.posted_at,'idempotent',true
    );
  end if;

  if v_draft.publish_state = 'publishing' then
    raise exception 'Another publisher is already handling this draft';
  end if;
  if v_draft.approval_state <> 'approved' or v_draft.approved_content_hash = '' then
    raise exception 'Exact owner approval is required';
  end if;
  if p_require_due and (v_draft.publish_at is null or v_draft.publish_at > v_now) then
    raise exception 'Draft is not due';
  end if;
  if v_draft.persona_id is null then raise exception 'Draft persona is required'; end if;
  if v_draft.account_id is not null or
     coalesce(nullif(lower(trim(v_draft.platform)),''),'aliaspaces')
       not in ('aliaspaces','mypersonas','mypersonas.online') then
    raise exception 'No official external write connector is enabled';
  end if;
  if coalesce(v_draft.title,'') = '' and coalesce(v_draft.body,'') = '' and
     coalesce(v_draft.media_url,'') = '' then
    raise exception 'Draft content is empty';
  end if;

  select * into v_settings from public.agent_owner_settings
    where owner = p_owner for share;
  if not found then raise exception 'Owner automation settings are unavailable'; end if;
  if v_settings.automation_paused then raise exception 'Owner automation is paused'; end if;

  select * into v_binding from public.agent_bindings
    where owner = p_owner and persona_id = v_draft.persona_id for share;
  if not found then raise exception 'Persona binding is unavailable'; end if;
  if v_binding.status <> 'active' then raise exception 'Persona binding is not active'; end if;
  if v_binding.claim_state not in ('self_attested','verified') then
    raise exception 'Persona claim is not active';
  end if;

  select * into v_target from public.agent_destinations
    where owner = p_owner and binding_id = v_binding.id
      and persona_id = v_draft.persona_id and account_id is null
      and destination in ('aliaspaces','mypersonas','mypersonas.online')
    for update;
  if not found then raise exception 'Native destination is unavailable'; end if;
  if not v_target.enabled then raise exception 'Native destination is disabled'; end if;
  if v_target.mode = 'manual' then raise exception 'Native destination is manual-only'; end if;
  if p_require_due and v_target.mode <> 'auto' then
    raise exception 'This destination needs an owner to press Publish now';
  end if;
  if not (v_draft.content_kind = any(v_target.allowed_content_types)) then
    raise exception 'Content type is not allowed for this destination';
  end if;
  v_required_autonomy := case when v_target.mode = 'auto' then 3 else 2 end;
  if v_binding.autonomy_level < v_required_autonomy then
    raise exception 'Persona autonomy is below the destination requirement';
  end if;

  v_hash := public.agent_draft_hash(
    v_draft.title, v_draft.body, v_draft.tags, v_draft.media_url,
    v_draft.content_kind, v_draft.persona_id, v_draft.account_id,
    v_draft.platform, v_draft.publish_at
  );
  if v_hash is distinct from v_draft.approved_content_hash then
    raise exception 'Approval no longer matches this exact draft';
  end if;

  if public.agent_in_quiet_hours(
    v_settings.default_timezone, v_settings.quiet_hours_start,
    v_settings.quiet_hours_end, v_now
  ) or public.agent_in_quiet_hours(
    v_settings.default_timezone, v_target.quiet_hours_start,
    v_target.quiet_hours_end, v_now
  ) then
    raise exception 'Publishing is paused during quiet hours';
  end if;

  v_local_date := (v_now at time zone v_settings.default_timezone)::date;
  v_day_start := v_local_date::timestamp at time zone v_settings.default_timezone;
  v_day_end := (v_local_date + 1)::timestamp at time zone v_settings.default_timezone;
  select count(*) into v_published_count from public.drafts d
    where d.owner = p_owner and d.persona_id = v_draft.persona_id
      and d.account_id is null and d.publish_state = 'published'
      and coalesce(nullif(lower(trim(d.platform)),''),'aliaspaces')
        in ('aliaspaces','mypersonas','mypersonas.online')
      and d.posted_at >= v_day_start and d.posted_at < v_day_end;
  if v_published_count >= v_target.daily_publish_limit then
    raise exception 'Destination daily publishing limit has been reached';
  end if;

  insert into public.posts (persona_id, kind, title, body, tags, media_url)
  values (
    v_draft.persona_id,
    case when v_draft.content_kind = 'reel' then 'reel' else 'post' end,
    coalesce(v_draft.title,''), coalesce(v_draft.body,''),
    coalesce(v_draft.tags,''), coalesce(v_draft.media_url,'')
  ) returning * into v_post;

  update public.drafts set
    status = 'posted', publish_state = 'published', posted_at = v_now,
    provider_post_id = v_post.id::text, publish_error = ''
  where id = v_draft.id returning * into v_draft;

  insert into public.agent_actions (
    owner, persona_id, binding_id, action_type, entity_type, entity_id,
    outcome, detail
  ) values (
    p_owner, v_draft.persona_id, v_binding.id, 'publish.completed',
    'draft', v_draft.id, 'ok',
    jsonb_build_object('destination','aliaspaces','destinationId',v_target.id,
      'postId',v_post.id,'atomic',true)
  );

  return jsonb_build_object(
    'published',true,'draftId',v_draft.id,'postId',v_post.id,
    'postedAt',v_now,'idempotent',false
  );
end;
$$;
revoke all on function public.publish_native_agent_draft(uuid,uuid,boolean)
  from public, anon, authenticated;
grant execute on function public.publish_native_agent_draft(uuid,uuid,boolean)
  to service_role;
revoke all on function public.agent_in_quiet_hours(text,time,time,timestamptz)
  from public, anon, authenticated;
grant execute on function public.agent_in_quiet_hours(text,time,time,timestamptz)
  to service_role;

create or replace function public.delete_my_agent_data()
returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_owner uuid := auth.uid();
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  delete from public.fan_chat_sessions where owner = v_owner;
  delete from public.agent_messages where owner = v_owner;
  delete from public.agent_daily_usage where owner = v_owner;
  delete from public.persona_content_plans where owner = v_owner;
  delete from public.agent_destinations where owner = v_owner;
  delete from public.agent_bindings where owner = v_owner;
  delete from public.agent_owner_settings where owner = v_owner;
  delete from public.agent_actions where owner = v_owner;
  return true;
end;
$$;
revoke all on function public.delete_my_agent_data()
  from public, anon, authenticated;
grant execute on function public.delete_my_agent_data() to authenticated;

update public.ai_tasks set active = active
where cadence in ('manual','daily','weekly')
  and (cadence <> 'weekly' or schedule_day is not null)
  and exists (
    select 1 from pg_catalog.pg_timezone_names z where z.name = ai_tasks.timezone
  );

create index if not exists ai_tasks_due_idx
  on public.ai_tasks (active, next_run_at) where active and next_run_at is not null;
create index if not exists ai_tasks_persona_idx
  on public.ai_tasks (persona_id, created_at);
create index if not exists drafts_publish_queue_idx
  on public.drafts (publish_state, publish_at)
  where publish_state = 'queued' and approval_state = 'approved';
create index if not exists drafts_source_task_idx
  on public.drafts (source_task_id);
create unique index if not exists drafts_agent_slot_idx
  on public.drafts (
    source_task_id,
    publish_at,
    coalesce(account_id, '00000000-0000-0000-0000-000000000000'::uuid)
  ) where generated_by_agent and source_task_id is not null;

create or replace function public.fan_chat_available(p_persona_id uuid)
returns boolean
language sql security definer stable set search_path = '' as $$
  select exists (
    select 1
    from public.agent_bindings b
    join public.agent_owner_settings s on s.owner = b.owner
    join public.personas p on p.id = b.persona_id and p.owner = b.owner
    where b.persona_id = p_persona_id
      and b.status = 'active'
      and b.claim_state in ('self_attested','verified')
      and b.fan_chat_enabled
      and not s.automation_paused
      and p.visibility in ('public','unlisted')
      and not coalesce(p.nsfw,false)
  );
$$;
revoke all on function public.fan_chat_available(uuid)
  from public, anon, authenticated;
grant execute on function public.fan_chat_available(uuid) to service_role;

-- Supabase projects may have default function grants for anon/authenticated.
-- Explicitly close older owner-only and trigger-only SECURITY DEFINER helpers.
revoke all on function public.verify_account_ledger_email(uuid)
  from public, anon, authenticated;
grant execute on function public.verify_account_ledger_email(uuid) to authenticated;
revoke all on function public.handle_new_user()
  from public, anon, authenticated;

-- Supabase default table privileges can include TRUNCATE, REFERENCES, and
-- TRIGGER. Replace them with the exact browser surface; service_role keeps its
-- server privileges and every owner-facing operation remains RLS-protected.
revoke all on table public.ai_backends from anon, authenticated;
grant select (id, owner, name, base_url, model, provider, extra, created_at)
  on public.ai_backends to authenticated;

revoke all on table public.agent_owner_settings from anon, authenticated;
grant select, insert, update on public.agent_owner_settings to authenticated;

revoke all on table public.agent_bindings from anon, authenticated;
grant select on public.agent_bindings to authenticated;
grant update (status, autonomy_level, fan_chat_enabled, fan_daily_message_limit)
  on public.agent_bindings to authenticated;

revoke all on table public.agent_destinations from anon, authenticated;
grant select, insert, update, delete on public.agent_destinations to authenticated;

revoke all on table public.persona_content_plans from anon, authenticated;
grant select, insert, update, delete on public.persona_content_plans to authenticated;

revoke all on table public.ai_tasks from anon, authenticated;
grant select, delete on public.ai_tasks to authenticated;
grant insert (
  owner, persona_id, backend_id, name, task_type, instructions, cadence,
  active, destination, account_id, content_kind, schedule_day, schedule_time,
  timezone, lead_minutes, approval_required
) on public.ai_tasks to authenticated;
grant update (
  persona_id, backend_id, name, task_type, instructions, cadence,
  active, destination, account_id, content_kind, schedule_day, schedule_time,
  timezone, lead_minutes, approval_required
) on public.ai_tasks to authenticated;

revoke all on table public.drafts from anon, authenticated;
grant select on public.drafts to authenticated;
grant insert (
  owner, persona_id, platform, title, body, tags, media_url, status,
  scheduled_for, account_id, content_kind, publish_at
) on public.drafts to authenticated;
grant update (
  persona_id, platform, title, body, tags, media_url, status,
  scheduled_for, account_id, content_kind, publish_at
) on public.drafts to authenticated;

revoke all on table public.agent_actions from anon, authenticated;
grant select on public.agent_actions to authenticated;

revoke all on table public.agent_messages from anon, authenticated;
grant select, insert, delete on public.agent_messages to authenticated;

revoke all on table public.fan_chat_sessions from anon, authenticated;
grant select on public.fan_chat_sessions to authenticated;
grant update (inbox_state) on public.fan_chat_sessions to authenticated;

revoke all on table public.fan_chat_messages from anon, authenticated;
grant select on public.fan_chat_messages to authenticated;

revoke all on function public.ensure_agent_owner_settings() from public, anon, authenticated;
revoke all on function public.ensure_persona_agent_binding() from public, anon, authenticated;
revoke all on function public.ensure_native_agent_destination() from public, anon, authenticated;
revoke all on function public.set_ai_task_schedule() from public, anon, authenticated;
revoke all on function public.guard_agent_destination() from public, anon, authenticated;
revoke all on function public.guard_agent_owner_settings_timezone()
  from public, anon, authenticated;
revoke all on function public.guard_agent_binding_suspension()
  from public, anon, authenticated;
revoke all on function public.guard_ai_task_assignment() from public, anon, authenticated;
revoke all on function public.guard_draft_assignment() from public, anon, authenticated;
revoke all on function public.invalidate_changed_draft_approval() from public, anon, authenticated;
revoke all on function public.guard_publishing_draft_edit() from public, anon, authenticated;
revoke all on function public.audit_agent_binding_change() from public, anon, authenticated;
revoke all on function public.downgrade_native_auto_destination() from public, anon, authenticated;
revoke all on function public.audit_agent_owner_settings_change() from public, anon, authenticated;
revoke all on function public.audit_agent_destination_change() from public, anon, authenticated;
revoke all on function public.audit_content_plan_change() from public, anon, authenticated;

comment on table public.agent_bindings is
  'Consent and autonomy boundary for one MyPersonas agent bound to one owner-controlled persona.';
comment on table public.persona_content_plans is
  'Owner-authored strategic direction injected into scheduled content generation.';
comment on table public.agent_destinations is
  'Per-persona destination intent and bounds; connector readiness is still attested server-side.';
comment on table public.agent_actions is
  'Append-only owner-visible audit trail for agent generation, approval, publishing, and safety actions.';
comment on table public.agent_messages is
  'Synced owner-to-agent chat history; replaces browser-only localStorage as the durable source of truth.';
comment on table public.fan_chat_sessions is
  'Owner-visible fan-chat inbox. The public reaches it only through the rate-limited fan-chat Edge Function.';
-- END 011-agent-automation.sql

-- BEGIN 012-agent-automation-hardening.sql
-- Post-live safety and durability hardening for the agent control plane.
-- Migration 011 is already live and immutable. Pause both cron workers before
-- applying this delta, then deploy the matching workers and client before resume.

begin;

-- Error reports remain available signed out, but cannot be forged as another
-- user and new payloads are bounded. Existing oversized rows stay readable.
drop policy if exists "error logs insert" on public.error_logs;
create policy "error logs insert" on public.error_logs for insert with check (
  (auth.uid() is null and user_id is null)
  or (auth.uid() is not null and user_id = auth.uid())
);
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'error_logs_message_size_check'
    and conrelid = 'public.error_logs'::regclass) then
    alter table public.error_logs add constraint error_logs_message_size_check
      check (char_length(message) <= 2000) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'error_logs_context_size_check'
    and conrelid = 'public.error_logs'::regclass) then
    alter table public.error_logs add constraint error_logs_context_size_check
      check (octet_length(context::text) <= 20000) not valid;
  end if;
end $$;
create or replace function public.my_error_logs()
returns setof public.error_logs language sql security definer stable
set search_path = '' as $$
  select * from public.error_logs where user_id = auth.uid()
  order by created_at asc, id asc;
$$;
revoke all on function public.my_error_logs() from public, anon, authenticated;
grant execute on function public.my_error_logs() to authenticated;

-- Vault-backed model connections must have a credential, while browser clients
-- receive only a boolean readiness signal.
create or replace function public.create_ai_backend(
  p_provider text,
  p_name text,
  p_base_url text,
  p_api_key text,
  p_model text,
  p_extra jsonb default '{}'::jsonb
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid := auth.uid();
  v_backend_id uuid;
  v_secret_id uuid;
  v_secret_name text;
begin
  if v_owner is null then raise exception 'Authentication required'; end if;
  if trim(coalesce(p_name,'')) = '' or char_length(p_name) > 160 then
    raise exception 'Model connection name is required';
  end if;
  if char_length(coalesce(p_provider,'')) > 80 then
    raise exception 'Provider name is too long';
  end if;
  if trim(coalesce(p_base_url,'')) !~* '^https://[^[:space:]]+$'
    or char_length(p_base_url) > 2048 then
    raise exception 'Hosted model connections require a valid HTTPS base URL';
  end if;
  if char_length(coalesce(p_model,'')) > 300 then
    raise exception 'Model id is too long';
  end if;
  if trim(coalesce(p_api_key,'')) = '' then
    raise exception 'A provider credential is required';
  end if;
  if octet_length(coalesce(p_api_key,'')) > 32768 then
    raise exception 'Provider credential is too large';
  end if;
  if octet_length(coalesce(p_extra,'{}'::jsonb)::text) > 10000 then
    raise exception 'Provider options are too large';
  end if;

  insert into public.ai_backends (
    owner, provider, name, base_url, api_key, model, extra
  ) values (
    v_owner, lower(trim(coalesce(p_provider,''))), trim(p_name), trim(p_base_url),
    '', trim(coalesce(p_model,'')), coalesce(p_extra,'{}'::jsonb)
  ) returning id into v_backend_id;

  if trim(coalesce(p_api_key,'')) <> '' then
    v_secret_name := 'ai_backend_key_' || v_backend_id::text;
    select vault.create_secret(
      p_api_key,
      v_secret_name,
      'AI provider credential for backend ' || v_backend_id::text
    ) into v_secret_id;
    insert into public.ai_backend_credentials (
      backend_id, owner, vault_secret_id
    ) values (v_backend_id, v_owner, v_secret_id);
  end if;
  return v_backend_id;
end;
$$;
revoke all on function public.create_ai_backend(text,text,text,text,text,jsonb)
  from public, anon;
grant execute on function public.create_ai_backend(text,text,text,text,text,jsonb)
  to authenticated;

create or replace function public.my_ai_backend_status()
returns table(backend_id uuid, has_credential boolean)
language sql security definer stable set search_path = '' as $$
  select backend.id,
    trim(coalesce(backend.api_key,'')) <> '' or exists (
      select 1 from public.ai_backend_credentials credential
      join vault.decrypted_secrets secret
        on secret.id = credential.vault_secret_id
      where credential.backend_id = backend.id
        and credential.owner = auth.uid()
        and trim(coalesce(secret.decrypted_secret,'')) <> ''
    )
  from public.ai_backends backend
  where backend.owner = auth.uid();
$$;
revoke all on function public.my_ai_backend_status()
  from public, anon, authenticated;
grant execute on function public.my_ai_backend_status() to authenticated;

-- Narrow public persona reads after the already-live column grants.
drop function if exists public.persona_by_handle(text);
create function public.persona_by_handle(h text)
returns table (
  id uuid, handle text, name text, tagline text, bio text, nsfw boolean,
  visibility text, avatar_url text, banner_url text, bg_url text, feed_img_url text,
  music_url text, live_url text, theme text, topics text, hashtags text,
  top8 jsonb, modules jsonb, linked jsonb, created_at timestamptz
) language sql security definer stable set search_path = '' as $$
  select p.id, p.handle, p.name, p.tagline, p.bio, p.nsfw, p.visibility,
    p.avatar_url, p.banner_url, p.bg_url, p.feed_img_url, p.music_url,
    p.live_url, p.theme, p.topics, p.hashtags, p.top8, p.modules,
    p.linked, p.created_at
  from public.personas p
  where p.handle = h and public.persona_visible(p.id)
  limit 1;
$$;
grant execute on function public.persona_by_handle(text) to anon, authenticated;
revoke select on public.personas from anon, authenticated;
revoke select (owner, purpose, voice, audience, dont, ai_backend)
  on public.personas from anon, authenticated;
grant select (
  id, handle, name, tagline, bio, nsfw, visibility, avatar_url, banner_url,
  bg_url, feed_img_url, music_url, live_url, theme, topics, hashtags,
  top8, modules, linked, created_at
) on public.personas to anon, authenticated;

-- Retry state, fair publish due-times, and durable client message ids.
alter table public.ai_tasks
  add column if not exists retry_count integer not null default 0;
alter table public.drafts
  add column if not exists publish_next_attempt_at timestamptz;
alter table public.agent_messages
  add column if not exists client_message_id uuid;

do $$ begin
  if exists (
    select 1
    from public.agent_messages
    where client_message_id is not null
    group by owner, client_message_id
    having count(*) > 1
  ) then
    raise exception 'Duplicate agent message client ids must be resolved before migration 012';
  end if;
end $$;

create unique index if not exists agent_messages_client_message_idx
  on public.agent_messages (owner, client_message_id);
create index if not exists drafts_auto_publish_due_idx
  on public.drafts (publish_next_attempt_at, publish_at, owner)
  where publish_state = 'queued' and approval_state = 'approved'
    and publish_next_attempt_at is not null;

-- Owners may erase a complete fan conversation without exposing visitor hashes.
create or replace function public.delete_my_fan_chat_session(p_session_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_deleted integer := 0;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  delete from public.fan_chat_sessions
  where id = p_session_id and owner = auth.uid();
  get diagnostics v_deleted = row_count;
  return v_deleted > 0;
end;
$$;
revoke all on function public.delete_my_fan_chat_session(uuid)
  from public, anon, authenticated;
grant execute on function public.delete_my_fan_chat_session(uuid)
  to authenticated;

revoke all on table public.fan_chat_sessions from anon, authenticated;
grant select (
  id, owner, persona_id, escalated, escalation_reason, inbox_state,
  created_at, last_seen_at
) on public.fan_chat_sessions to authenticated;
grant update (inbox_state) on public.fan_chat_sessions to authenticated;

-- Scheduled generation keeps its intended slot through bounded transient retries.
create or replace function public.set_ai_task_schedule()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.lease_token := null;
  new.lease_expires_at := null;
  new.retry_count := 0;
  if not new.active or new.cadence = 'manual' then
    new.next_run_at := null;
    new.next_publish_at := null;
    return new;
  end if;
  new.next_publish_at := public.next_content_occurrence(
    new.cadence, new.schedule_day, new.schedule_time, new.timezone, now()
  );
  new.next_run_at := greatest(
    new.next_publish_at - make_interval(mins => new.lead_minutes),
    now() + interval '1 minute'
  );
  return new;
end;
$$;
revoke all on function public.set_ai_task_schedule()
  from public, anon, authenticated;

update public.ai_tasks set
  active = false,
  last_status = 'needs_persona',
  last_error = 'Choose a persona and review this legacy schedule before resuming it.'
where persona_id is null;

create or replace function public.advance_ai_task_schedule(
  p_task_id uuid,
  p_finished_at timestamptz default now(),
  p_status text default 'drafted',
  p_error text default '',
  p_lease_token uuid default null
)
returns public.ai_tasks
language plpgsql security definer set search_path = '' as $$
declare
  v_task public.ai_tasks%rowtype;
  v_after timestamptz;
begin
  select * into v_task from public.ai_tasks where id = p_task_id for update;
  if not found then raise exception 'Task not found'; end if;
  if p_lease_token is null then
    raise exception 'Task lease token is required';
  end if;
  if v_task.lease_token is distinct from p_lease_token then
    raise exception 'Task lease no longer belongs to this worker';
  end if;
  v_after := greatest(p_finished_at, coalesce(v_task.next_publish_at, p_finished_at)) + interval '1 second';
  update public.ai_tasks set
    last_run = p_finished_at,
    last_status = left(coalesce(p_status,''),80),
    last_error = left(coalesce(p_error,''),1000),
    retry_count = 0,
    next_publish_at = case when v_task.active and v_task.cadence <> 'manual'
      then public.next_content_occurrence(v_task.cadence, v_task.schedule_day,
        v_task.schedule_time, v_task.timezone, v_after) else null end,
    lease_token = null,
    lease_expires_at = null
  where id = p_task_id
  returning * into v_task;
  update public.ai_tasks set next_run_at = case
    when v_task.next_publish_at is null then null
    else greatest(v_task.next_publish_at - make_interval(mins => v_task.lead_minutes),
      p_finished_at + interval '1 minute') end
  where id = p_task_id returning * into v_task;
  return v_task;
end;
$$;
revoke all on function public.advance_ai_task_schedule(uuid,timestamptz,text,text,uuid)
  from public, anon, authenticated;
grant execute on function public.advance_ai_task_schedule(uuid,timestamptz,text,text,uuid)
  to service_role;

create or replace function public.retry_ai_task_generation(
  p_task_id uuid,
  p_lease_token uuid,
  p_status text default 'retry_wait',
  p_error text default '',
  p_retry_seconds integer default 300
)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_task public.ai_tasks%rowtype;
  v_after timestamptz;
  v_attempt integer;
  v_base_seconds integer := least(900, greatest(60, coalesce(p_retry_seconds,300)));
  v_retry_seconds integer;
begin
  select * into v_task from public.ai_tasks where id = p_task_id for update;
  if not found then raise exception 'Task not found'; end if;
  if p_lease_token is null or v_task.lease_token is distinct from p_lease_token
    or v_task.lease_expires_at is null or v_task.lease_expires_at <= now() then
    raise exception 'Task lease no longer belongs to this worker';
  end if;
  v_attempt := coalesce(v_task.retry_count,0) + 1;
  if v_attempt > 3 then
    v_after := greatest(now(), coalesce(v_task.next_publish_at, now())) + interval '1 second';
    update public.ai_tasks set
      last_run = now(), last_status = 'retry_exhausted',
      last_error = left(coalesce(p_error,''),1000), retry_count = 0,
      next_publish_at = case when v_task.active and v_task.cadence <> 'manual'
        then public.next_content_occurrence(v_task.cadence, v_task.schedule_day,
          v_task.schedule_time, v_task.timezone, v_after) else null end,
      lease_token = null, lease_expires_at = null
    where id = p_task_id returning * into v_task;
    update public.ai_tasks set next_run_at = case
      when v_task.next_publish_at is null then null
      else greatest(v_task.next_publish_at - make_interval(mins => v_task.lead_minutes),
        now() + interval '1 minute') end
    where id = p_task_id returning * into v_task;
    return jsonb_build_object('scheduled',false,'exhausted',true,
      'retryCount',3,'nextPublishAt',v_task.next_publish_at);
  end if;
  v_retry_seconds := least(3600, v_base_seconds * case v_attempt
    when 1 then 1 when 2 then 2 else 4 end);
  update public.ai_tasks set
    last_run = now(),
    last_status = left(coalesce(p_status,'retry_wait'),80),
    last_error = left(coalesce(p_error,''),1000),
    next_run_at = now() + make_interval(secs => v_retry_seconds),
    retry_count = v_attempt,
    lease_token = null,
    lease_expires_at = null
  where id = p_task_id returning * into v_task;
  return jsonb_build_object('scheduled',true,'exhausted',false,
    'retryCount',v_attempt,'retrySeconds',v_retry_seconds,
    'nextRunAt',v_task.next_run_at,'nextPublishAt',v_task.next_publish_at);
end;
$$;
revoke all on function public.retry_ai_task_generation(uuid,uuid,text,text,integer)
  from public, anon, authenticated;
grant execute on function public.retry_ai_task_generation(uuid,uuid,text,text,integer)
  to service_role;

-- Exact approvals are invalidated when content, consent, or native targets change.
create or replace function public.normalize_agent_destination(p_destination text)
returns text
language sql immutable set search_path = '' as $$
  select coalesce(nullif(
    regexp_replace(regexp_replace(regexp_replace(
      lower(trim(coalesce(p_destination,''))), '^https?://', ''
    ), '^www\.', ''), '/$', ''),
    ''
  ), 'aliaspaces');
$$;
revoke all on function public.normalize_agent_destination(text)
  from public, anon, authenticated;

create or replace function public.invalidate_changed_draft_approval()
returns trigger language plpgsql set search_path = '' as $$
declare v_hash text;
begin
  v_hash := public.agent_draft_hash(new.title, new.body, new.tags,
    new.media_url, new.content_kind, new.persona_id, new.account_id,
    new.platform, new.publish_at);
  -- The approval RPC deliberately changes publish_at and writes the matching
  -- content hash in one statement. Preserve that server-authored transition;
  -- browser edits cannot write either approval_state or the hash.
  if new.approval_state = 'approved'
    and new.approved_at is not null
    and new.approved_content_hash = v_hash then
    return new;
  end if;
  if old.approval_state = 'approved' then
    if v_hash is distinct from old.approved_content_hash then
      new.approval_state := 'draft';
      new.approved_at := null;
      new.approved_content_hash := '';
      new.publish_state := 'not_queued';
      new.publish_next_attempt_at := null;
      new.publish_error := 'Approval was cleared because the content, target, or schedule changed.';
    end if;
  elsif old.approval_state = 'rejected' then
    new.approval_state := 'draft';
    new.approved_at := null;
    new.approved_content_hash := '';
    new.publish_state := 'not_queued';
    new.publish_next_attempt_at := null;
    new.publish_error := '';
  end if;
  return new;
end;
$$;
revoke all on function public.invalidate_changed_draft_approval()
  from public, anon, authenticated;

create or replace function public.approve_agent_draft(
  p_draft_id uuid,
  p_publish_at timestamptz default null
)
returns public.drafts
language plpgsql security definer set search_path = '' as $$
declare
  v_draft public.drafts%rowtype;
  v_binding public.agent_bindings%rowtype;
  v_hash text;
  v_auto_queue boolean := false;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select * into v_draft from public.drafts
    where id = p_draft_id and owner = auth.uid() for update;
  if not found then raise exception 'Draft not found'; end if;
  if v_draft.publish_state in ('publishing','published') then
    raise exception 'Publishing or published history cannot be approved again';
  end if;
  if v_draft.persona_id is null then raise exception 'Choose a persona before approval'; end if;
  select * into v_binding from public.agent_bindings
    where persona_id = v_draft.persona_id and owner = auth.uid();
  if not found or v_binding.status <> 'active'
    or v_binding.claim_state not in ('self_attested','verified')
    or v_binding.autonomy_level < 2 then
    raise exception 'This persona must have an active, valid L2 or L3 agent before approval';
  end if;
  v_draft.publish_at := coalesce(p_publish_at, v_draft.publish_at, now());
  v_hash := public.agent_draft_hash(v_draft.title, v_draft.body, v_draft.tags,
    v_draft.media_url, v_draft.content_kind, v_draft.persona_id,
    v_draft.account_id, v_draft.platform, v_draft.publish_at);
  v_auto_queue := v_binding.autonomy_level >= 3
    and v_draft.account_id is null
    and public.normalize_agent_destination(v_draft.platform) in (
      'aliaspaces','aliaspaces.com','mypersonas','mypersonas.online'
    )
    and exists (
      select 1 from public.agent_destinations target
      where target.owner = auth.uid() and target.binding_id = v_binding.id
        and target.persona_id = v_draft.persona_id
        and target.account_id is null and target.enabled and target.mode = 'auto'
        and public.normalize_agent_destination(target.destination) in (
          'aliaspaces','aliaspaces.com','mypersonas','mypersonas.online'
        )
        and v_draft.content_kind = any(target.allowed_content_types)
    );
  update public.drafts set
    approval_state = 'approved',
    approved_at = now(),
    approved_content_hash = v_hash,
    publish_at = v_draft.publish_at,
    publish_state = case when v_auto_queue then 'queued' else 'not_queued' end,
    publish_next_attempt_at = case when v_auto_queue then v_draft.publish_at else null end,
    publish_error = '',
    status = 'ready'
  where id = p_draft_id returning * into v_draft;
  insert into public.agent_actions (
    owner, persona_id, binding_id, action_type, entity_type, entity_id, detail
  ) values (
    auth.uid(), v_draft.persona_id, v_binding.id, 'draft.approved',
    'draft', v_draft.id, jsonb_build_object('publish_at',v_draft.publish_at,
      'content_hash',v_hash,'destination',v_draft.platform)
  );
  return v_draft;
end;
$$;
revoke all on function public.approve_agent_draft(uuid,timestamptz)
  from public, anon, authenticated;
grant execute on function public.approve_agent_draft(uuid,timestamptz)
  to authenticated;

create or replace function public.reject_agent_draft(p_draft_id uuid)
returns public.drafts
language plpgsql security definer set search_path = '' as $$
declare
  v_draft public.drafts%rowtype;
  v_binding_id uuid;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select * into v_draft from public.drafts
    where id = p_draft_id and owner = auth.uid() for update;
  if not found then raise exception 'Draft not found'; end if;
  if v_draft.publish_state in ('publishing','published') then
    raise exception 'Publishing or published history cannot be rejected';
  end if;
  select id into v_binding_id from public.agent_bindings
    where persona_id = v_draft.persona_id and owner = auth.uid();
  update public.drafts set approval_state = 'rejected', approved_at = null,
    approved_content_hash = '', publish_state = 'not_queued',
    publish_next_attempt_at = null, status = 'idea'
  where id = p_draft_id returning * into v_draft;
  insert into public.agent_actions (
    owner, persona_id, binding_id, action_type, entity_type, entity_id
  ) values (
    auth.uid(), v_draft.persona_id, v_binding_id, 'draft.rejected', 'draft', v_draft.id
  );
  return v_draft;
end;
$$;
revoke all on function public.reject_agent_draft(uuid)
  from public, anon, authenticated;
grant execute on function public.reject_agent_draft(uuid) to authenticated;

create or replace function public.mark_manual_draft_posted(p_draft_id uuid)
returns public.drafts
language plpgsql security definer set search_path = '' as $$
declare
  v_draft public.drafts%rowtype;
  v_binding_id uuid;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select * into v_draft from public.drafts
    where id = p_draft_id and owner = auth.uid() for update;
  if not found then raise exception 'Draft not found'; end if;
  if v_draft.publish_state in ('publishing','published') then
    raise exception 'This draft is already publishing or published';
  end if;
  if v_draft.account_id is null and
     public.normalize_agent_destination(v_draft.platform) in (
       'aliaspaces','aliaspaces.com','mypersonas','mypersonas.online'
     ) then
    raise exception 'Native posts must use the publishing bridge';
  end if;
  select id into v_binding_id from public.agent_bindings
    where persona_id = v_draft.persona_id and owner = auth.uid();
  update public.drafts set status = 'posted', publish_state = 'published',
    publish_next_attempt_at = null, posted_at = now(),
    provider_post_id = 'manual', publish_error = ''
  where id = p_draft_id returning * into v_draft;
  insert into public.agent_actions (
    owner, persona_id, binding_id, action_type, entity_type, entity_id,
    detail
  ) values (
    auth.uid(), v_draft.persona_id, v_binding_id, 'draft.manual_posted',
    'draft', v_draft.id, jsonb_build_object('destination',v_draft.platform)
  );
  return v_draft;
end;
$$;
revoke all on function public.mark_manual_draft_posted(uuid)
  from public, anon, authenticated;
grant execute on function public.mark_manual_draft_posted(uuid) to authenticated;

-- Only currently valid L3 native-auto approvals enter the fair worker queue.
create or replace function public.due_auto_publish_drafts(p_limit integer default 50)
returns setof public.drafts
language sql security definer stable set search_path = '' as $$
  with ranked as (
    select d.id,
      row_number() over (
        partition by d.owner
        order by d.publish_next_attempt_at, d.publish_at, d.id
      ) as owner_rank
    from public.drafts d
    join public.agent_bindings binding
      on binding.owner = d.owner and binding.persona_id = d.persona_id
    join public.agent_owner_settings settings on settings.owner = d.owner
    where d.approval_state = 'approved' and d.publish_state = 'queued'
      and d.publish_at is not null and d.publish_at <= now()
      and d.publish_next_attempt_at is not null
      and d.publish_next_attempt_at <= now()
      and d.account_id is null
      and public.normalize_agent_destination(d.platform) in (
        'aliaspaces','aliaspaces.com','mypersonas','mypersonas.online'
      )
      and not settings.automation_paused
      and binding.status = 'active'
      and binding.claim_state in ('self_attested','verified')
      and binding.autonomy_level >= 3
      and exists (
        select 1 from public.agent_destinations target
        where target.owner = d.owner and target.binding_id = binding.id
          and target.persona_id = d.persona_id and target.account_id is null
          and target.enabled and target.mode = 'auto'
          and public.normalize_agent_destination(target.destination) in (
            'aliaspaces','aliaspaces.com','mypersonas','mypersonas.online'
          )
          and d.content_kind = any(target.allowed_content_types)
          and not public.agent_in_quiet_hours(
            settings.default_timezone, target.quiet_hours_start,
            target.quiet_hours_end, now()
          )
      )
      and not public.agent_in_quiet_hours(
        settings.default_timezone, settings.quiet_hours_start,
        settings.quiet_hours_end, now()
      )
  )
  select draft.*
  from ranked
  join public.drafts draft on draft.id = ranked.id
  order by ranked.owner_rank, draft.publish_next_attempt_at,
    draft.publish_at, draft.id
  limit greatest(1, least(coalesce(p_limit, 50), 200));
$$;
revoke all on function public.due_auto_publish_drafts(integer)
  from public, anon, authenticated;
grant execute on function public.due_auto_publish_drafts(integer) to service_role;

-- Repair older approvals: only enabled L3 native-auto rows belong in cron.
update public.drafts draft set
  approval_state = 'pending', approved_at = null, approved_content_hash = '',
  publish_state = 'not_queued', publish_next_attempt_at = null,
  publish_error = 'Automatic publishing was cleared because current agent consent is not valid.'
where draft.approval_state = 'approved' and draft.publish_state = 'queued'
  and not (
    draft.account_id is null
    and public.normalize_agent_destination(draft.platform) in (
      'aliaspaces','aliaspaces.com','mypersonas','mypersonas.online'
    )
    and exists (
      select 1 from public.agent_bindings binding
      join public.agent_destinations target
        on target.binding_id = binding.id and target.owner = binding.owner
        and target.persona_id = binding.persona_id
      where binding.owner = draft.owner
        and binding.persona_id = draft.persona_id
        and binding.status = 'active'
        and binding.claim_state in ('self_attested','verified')
        and binding.autonomy_level >= 3
        and target.account_id is null and target.enabled and target.mode = 'auto'
        and public.normalize_agent_destination(target.destination) in (
          'aliaspaces','aliaspaces.com','mypersonas','mypersonas.online'
        )
        and draft.content_kind = any(target.allowed_content_types)
    )
  );
update public.drafts set
  publish_next_attempt_at = coalesce(publish_next_attempt_at, publish_at)
where approval_state = 'approved' and publish_state = 'queued'
  and publish_at is not null;

create or replace function public.dequeue_drafts_after_destination_change()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    update public.drafts set
      approval_state = 'pending', approved_at = null,
      approved_content_hash = '', publish_state = 'not_queued',
      publish_next_attempt_at = null,
      publish_error = 'Automatic publishing was cleared because the target changed.'
    where owner = old.owner and persona_id = old.persona_id
      and account_id is not distinct from old.account_id
      and approval_state = 'approved' and publish_state = 'queued';
    return old;
  end if;
  if (
    old.owner, old.persona_id, old.account_id, old.destination
  ) is distinct from (
    new.owner, new.persona_id, new.account_id, new.destination
  ) then
    update public.drafts set
      approval_state = 'pending', approved_at = null,
      approved_content_hash = '', publish_state = 'not_queued',
      publish_next_attempt_at = null,
      publish_error = 'Automatic publishing was cleared because the target changed.'
    where owner = old.owner and persona_id = old.persona_id
      and account_id is not distinct from old.account_id
      and approval_state = 'approved' and publish_state = 'queued';
  end if;
  update public.drafts draft set
    approval_state = 'pending', approved_at = null,
    approved_content_hash = '', publish_state = 'not_queued',
    publish_next_attempt_at = null,
    publish_error = 'Automatic publishing was cleared because the target policy changed.'
  where draft.owner = new.owner and draft.persona_id = new.persona_id
    and draft.account_id is not distinct from new.account_id
    and draft.approval_state = 'approved' and draft.publish_state = 'queued'
    and (
      not new.enabled or new.mode <> 'auto' or new.account_id is not null
      or public.normalize_agent_destination(new.destination) not in (
        'aliaspaces','aliaspaces.com','mypersonas','mypersonas.online'
      )
      or not (draft.content_kind = any(new.allowed_content_types))
    );
  return new;
end;
$$;
drop trigger if exists dequeue_drafts_after_destination_change
  on public.agent_destinations;
create trigger dequeue_drafts_after_destination_change
  after update or delete on public.agent_destinations
  for each row execute function public.dequeue_drafts_after_destination_change();
revoke all on function public.dequeue_drafts_after_destination_change()
  from public, anon, authenticated;

create or replace function public.dequeue_drafts_after_binding_change()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    update public.drafts set
      approval_state = 'pending', approved_at = null,
      approved_content_hash = '', publish_state = 'not_queued',
      publish_next_attempt_at = null,
      publish_error = 'Automatic publishing was cleared because L3 consent changed.'
    where owner = old.owner and persona_id = old.persona_id
      and approval_state = 'approved' and publish_state = 'queued';
    return old;
  end if;
  if (old.owner, old.persona_id) is distinct from (new.owner, new.persona_id)
    or (old.autonomy_level >= 3 and new.autonomy_level < 3)
    or (new.status <> 'active' and old.status is distinct from new.status)
    or (
      new.claim_state not in ('self_attested','verified')
      and old.claim_state is distinct from new.claim_state
    ) then
    update public.drafts set
      approval_state = 'pending', approved_at = null,
      approved_content_hash = '', publish_state = 'not_queued',
      publish_next_attempt_at = null,
      publish_error = 'Automatic publishing was cleared because L3 consent changed.'
    where owner = old.owner and persona_id = old.persona_id
      and approval_state = 'approved' and publish_state = 'queued';
  end if;
  return new;
end;
$$;
drop trigger if exists dequeue_drafts_after_binding_change on public.agent_bindings;
create trigger dequeue_drafts_after_binding_change
  after update of owner, persona_id, autonomy_level, status, claim_state
    or delete on public.agent_bindings
  for each row execute function public.dequeue_drafts_after_binding_change();
revoke all on function public.dequeue_drafts_after_binding_change()
  from public, anon, authenticated;

-- Native publication rechecks normalized destination, exact consent, quiet hours,
-- and per-day limits in the same transaction as the post.
create or replace function public.publish_native_agent_draft(
  p_draft_id uuid,
  p_owner uuid,
  p_require_due boolean default false
)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_draft public.drafts%rowtype;
  v_settings public.agent_owner_settings%rowtype;
  v_binding public.agent_bindings%rowtype;
  v_target public.agent_destinations%rowtype;
  v_post public.posts%rowtype;
  v_hash text;
  v_required_autonomy smallint;
  v_local_date date;
  v_day_start timestamptz;
  v_day_end timestamptz;
  v_published_count integer;
  v_now timestamptz := now();
begin
  if p_owner is null then raise exception 'Owner is required'; end if;

  select * into v_draft from public.drafts
    where id = p_draft_id and owner = p_owner for update;
  if not found then raise exception 'Draft not found'; end if;

  if v_draft.publish_state = 'published' then
    select * into v_post from public.posts
      where id::text = v_draft.provider_post_id
        and persona_id = v_draft.persona_id;
    if not found then
      raise exception 'Published draft requires reconciliation';
    end if;
    return jsonb_build_object(
      'published',true,'draftId',v_draft.id,'postId',v_post.id,
      'postedAt',v_draft.posted_at,'idempotent',true
    );
  end if;

  if v_draft.publish_state = 'publishing' then
    raise exception 'Another publisher is already handling this draft';
  end if;
  if v_draft.approval_state <> 'approved' or v_draft.approved_content_hash = '' then
    raise exception 'Exact owner approval is required';
  end if;
  if p_require_due and (v_draft.publish_at is null or v_draft.publish_at > v_now) then
    raise exception 'Draft is not due';
  end if;
  if v_draft.persona_id is null then raise exception 'Draft persona is required'; end if;
  if v_draft.account_id is not null or
     public.normalize_agent_destination(v_draft.platform) not in (
       'aliaspaces','aliaspaces.com','mypersonas','mypersonas.online'
     ) then
    raise exception 'No official external write connector is enabled';
  end if;
  if coalesce(v_draft.title,'') = '' and coalesce(v_draft.body,'') = '' and
     coalesce(v_draft.media_url,'') = '' then
    raise exception 'Draft content is empty';
  end if;

  select * into v_settings from public.agent_owner_settings
    where owner = p_owner for share;
  if not found then raise exception 'Owner automation settings are unavailable'; end if;
  if v_settings.automation_paused then raise exception 'Owner automation is paused'; end if;

  select * into v_binding from public.agent_bindings
    where owner = p_owner and persona_id = v_draft.persona_id for share;
  if not found then raise exception 'Persona binding is unavailable'; end if;
  if v_binding.status <> 'active' then raise exception 'Persona binding is not active'; end if;
  if v_binding.claim_state not in ('self_attested','verified') then
    raise exception 'Persona claim is not active';
  end if;

  select * into v_target from public.agent_destinations
    where owner = p_owner and binding_id = v_binding.id
      and persona_id = v_draft.persona_id and account_id is null
      and public.normalize_agent_destination(destination) in (
        'aliaspaces','aliaspaces.com','mypersonas','mypersonas.online'
      )
    for update;
  if not found then raise exception 'Native destination is unavailable'; end if;
  if not v_target.enabled then raise exception 'Native destination is disabled'; end if;
  if v_target.mode = 'manual' then raise exception 'Native destination is manual-only'; end if;
  if p_require_due and v_target.mode <> 'auto' then
    raise exception 'This destination needs an owner to press Publish now';
  end if;
  if not (v_draft.content_kind = any(v_target.allowed_content_types)) then
    raise exception 'Content type is not allowed for this destination';
  end if;
  v_required_autonomy := case when v_target.mode = 'auto' then 3 else 2 end;
  if v_binding.autonomy_level < v_required_autonomy then
    raise exception 'Persona autonomy is below the destination requirement';
  end if;

  v_hash := public.agent_draft_hash(
    v_draft.title, v_draft.body, v_draft.tags, v_draft.media_url,
    v_draft.content_kind, v_draft.persona_id, v_draft.account_id,
    v_draft.platform, v_draft.publish_at
  );
  if v_hash is distinct from v_draft.approved_content_hash then
    raise exception 'Approval no longer matches this exact draft';
  end if;

  if public.agent_in_quiet_hours(
    v_settings.default_timezone, v_settings.quiet_hours_start,
    v_settings.quiet_hours_end, v_now
  ) or public.agent_in_quiet_hours(
    v_settings.default_timezone, v_target.quiet_hours_start,
    v_target.quiet_hours_end, v_now
  ) then
    raise exception 'Publishing is paused during quiet hours';
  end if;

  v_local_date := (v_now at time zone v_settings.default_timezone)::date;
  v_day_start := v_local_date::timestamp at time zone v_settings.default_timezone;
  v_day_end := (v_local_date + 1)::timestamp at time zone v_settings.default_timezone;
  select count(*) into v_published_count from public.drafts d
    where d.owner = p_owner and d.persona_id = v_draft.persona_id
      and d.account_id is null and d.publish_state = 'published'
      and public.normalize_agent_destination(d.platform) in (
        'aliaspaces','aliaspaces.com','mypersonas','mypersonas.online'
      )
      and d.posted_at >= v_day_start and d.posted_at < v_day_end;
  if v_published_count >= v_target.daily_publish_limit then
    raise exception 'Destination daily publishing limit has been reached';
  end if;

  insert into public.posts (persona_id, kind, title, body, tags, media_url)
  values (
    v_draft.persona_id,
    case when v_draft.content_kind = 'reel' then 'reel' else 'post' end,
    coalesce(v_draft.title,''), coalesce(v_draft.body,''),
    coalesce(v_draft.tags,''), coalesce(v_draft.media_url,'')
  ) returning * into v_post;

  update public.drafts set
    status = 'posted', publish_state = 'published', posted_at = v_now,
    publish_next_attempt_at = null, provider_post_id = v_post.id::text,
    publish_error = ''
  where id = v_draft.id returning * into v_draft;

  insert into public.agent_actions (
    owner, persona_id, binding_id, action_type, entity_type, entity_id,
    outcome, detail
  ) values (
    p_owner, v_draft.persona_id, v_binding.id, 'publish.completed',
    'draft', v_draft.id, 'ok',
    jsonb_build_object('destination','aliaspaces','destinationId',v_target.id,
      'postId',v_post.id,'atomic',true)
  );

  return jsonb_build_object(
    'published',true,'draftId',v_draft.id,'postId',v_post.id,
    'postedAt',v_now,'idempotent',false
  );
end;
$$;
revoke all on function public.publish_native_agent_draft(uuid,uuid,boolean)
  from public, anon, authenticated;
grant execute on function public.publish_native_agent_draft(uuid,uuid,boolean)
  to service_role;

commit;
-- END 012-agent-automation-hardening.sql

-- BEGIN 013-fair-generation-queue.sql
-- Fair owner rotation and a bounded active-schedule surface.
-- Migrations 011 and 012 are already live and immutable. Apply this migration
-- before deploying the matching run-tasks worker.

begin;

-- Keep scheduling fairness in a service-only table so owners cannot reset their
-- place by editing or deleting tasks. An absent row means the owner has not yet
-- been served and therefore sorts ahead of previously served owners.
create table if not exists public.agent_generation_queue_state (
  owner uuid primary key references public.profiles(id) on delete cascade,
  last_claimed_at timestamptz not null default now(),
  claim_count bigint not null default 0 check (claim_count >= 0),
  updated_at timestamptz not null default now()
);
alter table public.agent_generation_queue_state enable row level security;
revoke all on table public.agent_generation_queue_state
  from public, anon, authenticated;
grant select, insert, update, delete on public.agent_generation_queue_state
  to service_role;

-- Return due work in rounds: every owner's oldest due task is considered before
-- any owner's second task, and least-recently-served owners lead each round.
-- Only the service worker may inspect this cross-owner queue.
create or replace function public.due_ai_generation_tasks(
  p_due_at timestamptz default now(),
  p_limit integer default 8
)
returns setof public.ai_tasks
language sql security definer stable set search_path = '' as $$
  with due as (
    select
      task.id,
      task.owner,
      task.next_run_at,
      row_number() over (
        partition by task.owner
        order by task.next_run_at asc, task.id asc
      ) as owner_rank
    from public.ai_tasks task
    where task.active
      and task.next_run_at is not null
      and task.next_run_at <= p_due_at
      and (
        task.lease_expires_at is null
        or task.lease_expires_at <= p_due_at
      )
  )
  select task.*
  from due
  join public.ai_tasks task on task.id = due.id
  left join public.agent_generation_queue_state queue
    on queue.owner = due.owner
  order by
    due.owner_rank asc,
    queue.last_claimed_at asc nulls first,
    due.next_run_at asc,
    due.owner asc,
    due.id asc
  limit least(100, greatest(1, coalesce(p_limit, 8)));
$$;
revoke all on function public.due_ai_generation_tasks(timestamptz,integer)
  from public, anon, authenticated;
grant execute on function public.due_ai_generation_tasks(timestamptz,integer)
  to service_role;

-- A successful lease claim is the durable fairness event. Failed or raced
-- claims do not move an owner to the back of the queue.
create or replace function public.claim_ai_task_generation(
  p_task_id uuid,
  p_due_at timestamptz,
  p_lease_token uuid
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_task public.ai_tasks%rowtype;
  v_claimed_at timestamptz;
begin
  if p_lease_token is null then raise exception 'Lease token is required'; end if;
  select * into v_task from public.ai_tasks where id = p_task_id for update;
  if not found or not v_task.active or v_task.next_run_at is null
    or v_task.next_run_at > p_due_at
    or (v_task.lease_expires_at is not null and v_task.lease_expires_at > now()) then
    return false;
  end if;
  update public.ai_tasks set
    lease_token = p_lease_token,
    lease_expires_at = now() + interval '5 minutes',
    last_status = 'processing',
    last_error = ''
  where id = p_task_id;
  v_claimed_at := clock_timestamp();
  insert into public.agent_generation_queue_state (
    owner, last_claimed_at, claim_count, updated_at
  ) values (
    v_task.owner, v_claimed_at, 1, v_claimed_at
  )
  on conflict (owner) do update set
    last_claimed_at = greatest(
      public.agent_generation_queue_state.last_claimed_at,
      excluded.last_claimed_at
    ),
    claim_count = public.agent_generation_queue_state.claim_count + 1,
    updated_at = greatest(
      public.agent_generation_queue_state.updated_at,
      excluded.updated_at
    );
  return true;
end;
$$;
revoke all on function public.claim_ai_task_generation(uuid,timestamptz,uuid)
  from public, anon, authenticated;
grant execute on function public.claim_ai_task_generation(uuid,timestamptz,uuid)
  to service_role;

-- Deterministic input violations cannot improve on retry. Pause the task and
-- release its lease so one bad field cannot consume quota or a worker slot on
-- every recurrence. Re-enabling after an owner edit recomputes its schedule.
create or replace function public.block_ai_task_input(
  p_task_id uuid,
  p_lease_token uuid,
  p_error text default 'Generation input exceeds the configured limit.'
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_task public.ai_tasks%rowtype;
begin
  select * into v_task from public.ai_tasks where id = p_task_id for update;
  if not found or p_lease_token is null
    or v_task.lease_token is distinct from p_lease_token
    or v_task.lease_expires_at is null or v_task.lease_expires_at <= now() then
    return false;
  end if;
  update public.ai_tasks set
    active = false,
    next_run_at = null,
    next_publish_at = null,
    last_run = now(),
    last_status = 'input_too_large',
    last_error = left(coalesce(p_error,''),1000),
    retry_count = 0,
    lease_token = null,
    lease_expires_at = null
  where id = p_task_id;
  return true;
end;
$$;
revoke all on function public.block_ai_task_input(uuid,uuid,text)
  from public, anon, authenticated;
grant execute on function public.block_ai_task_input(uuid,uuid,text)
  to service_role;

-- Bound new or changed provider-input fields at the data boundary. The trigger
-- compares updates field-by-field so an untouched oversized legacy value does
-- not prevent an owner from editing other settings; the worker separately
-- enforces the aggregate request budget before reserving or calling a model.
create or replace function public.enforce_agent_prompt_text_limits()
returns trigger language plpgsql set search_path = '' as $$
declare
  v_limits jsonb;
  v_field text;
  v_limit integer;
  v_value text;
  v_changed boolean;
begin
  case tg_table_name
    when 'personas' then v_limits := '{
      "name": 256,
      "tagline": 512,
      "bio": 2048,
      "purpose": 1024,
      "voice": 2048,
      "topics": 1024,
      "audience": 1024,
      "hashtags": 1024,
      "dont": 3072
    }'::jsonb;
    when 'persona_content_plans' then v_limits := '{
      "primary_goal": 768,
      "success_metric": 512,
      "audience_focus": 768,
      "content_pillars": 1024,
      "current_campaign": 768,
      "calls_to_action": 768,
      "offers_and_links": 1536,
      "affiliate_disclosure": 512,
      "source_notes": 1536,
      "platform_guidance": 1024
    }'::jsonb;
    when 'ai_tasks' then v_limits := '{
      "name": 256,
      "instructions": 4096,
      "destination": 128
    }'::jsonb;
    when 'account_ledger' then v_limits := '{
      "provider": 128
    }'::jsonb;
    else
      raise exception 'Unsupported prompt-input table %', tg_table_name;
  end case;

  for v_field, v_limit in
    select entry.key, entry.value::integer
    from jsonb_each_text(v_limits) entry
    order by entry.key
  loop
    v_value := coalesce(to_jsonb(new) ->> v_field, '');
    if tg_op = 'INSERT' then
      v_changed := true;
    else
      v_changed := (to_jsonb(new) ->> v_field)
        is distinct from (to_jsonb(old) ->> v_field);
    end if;
    if v_changed and octet_length(v_value) > v_limit then
      raise exception using
        errcode = '22001',
        message = format(
          '%s.%s may be at most %s UTF-8 bytes',
          tg_table_name, v_field, v_limit
        );
    end if;
  end loop;
  return new;
end;
$$;
revoke all on function public.enforce_agent_prompt_text_limits()
  from public, anon, authenticated;

drop trigger if exists enforce_agent_prompt_text_limits on public.personas;
create trigger enforce_agent_prompt_text_limits
  before insert or update on public.personas
  for each row execute function public.enforce_agent_prompt_text_limits();
drop trigger if exists enforce_agent_prompt_text_limits
  on public.persona_content_plans;
create trigger enforce_agent_prompt_text_limits
  before insert or update on public.persona_content_plans
  for each row execute function public.enforce_agent_prompt_text_limits();
drop trigger if exists enforce_agent_prompt_text_limits on public.ai_tasks;
create trigger enforce_agent_prompt_text_limits
  before insert or update on public.ai_tasks
  for each row execute function public.enforce_agent_prompt_text_limits();
drop trigger if exists enforce_agent_prompt_text_limits on public.account_ledger;
create trigger enforce_agent_prompt_text_limits
  before insert or update on public.account_ledger
  for each row execute function public.enforce_agent_prompt_text_limits();

-- Cap newly created or newly re-enabled schedules without disabling or blocking
-- edits to rows that were already active before this migration. Lock the owner
-- profile row so concurrent activations cannot both pass the count check.
create or replace function public.enforce_ai_task_active_limit()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_enforce boolean := false;
  v_active_count integer := 0;
begin
  if new.active then
    if tg_op = 'INSERT' then
      v_enforce := true;
    elsif not coalesce(old.active, false) or new.owner is distinct from old.owner then
      v_enforce := true;
    end if;
  end if;
  if not v_enforce then return new; end if;

  perform 1 from public.profiles profile where profile.id = new.owner for update;
  select count(*) into v_active_count
  from public.ai_tasks task
  where task.owner = new.owner
    and task.active
    and (tg_op = 'INSERT' or task.id <> new.id);
  if v_active_count >= 100 then
    raise exception using
      errcode = '23514',
      message = 'An account may have at most 100 active schedules',
      hint = 'Pause an active schedule before enabling another one.';
  end if;
  return new;
end;
$$;
revoke all on function public.enforce_ai_task_active_limit()
  from public, anon, authenticated;

drop trigger if exists enforce_ai_task_active_limit on public.ai_tasks;
create trigger enforce_ai_task_active_limit
  before insert or update of active, owner on public.ai_tasks
  for each row execute function public.enforce_ai_task_active_limit();

comment on table public.agent_generation_queue_state is
  'Service-only least-recently-served state for fair scheduled generation across owners.';

commit;
-- END 013-fair-generation-queue.sql
-- BEGIN 014-atomic-persona-save.sql
-- 014-atomic-persona-save.sql
-- Saves the owner-editable persona row, public links, and private note in one
-- transaction so a partial browser/network failure cannot delete child rows.

create or replace function public.save_persona_bundle(
  p_persona_id uuid,
  p_persona jsonb,
  p_links jsonb,
  p_note text
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_id uuid;
  v_handle text;
  v_name text;
  v_visibility text;
  v_ai_backend uuid;
  v_top8 jsonb := coalesce(p_persona -> 'top8', '[]'::jsonb);
  v_linked jsonb := coalesce(p_persona -> 'linked', '[]'::jsonb);
  v_modules jsonb := coalesce(p_persona -> 'modules', '{}'::jsonb);
begin
  if v_uid is null then
    raise exception 'Authentication required';
  end if;
  if jsonb_typeof(coalesce(p_persona, 'null'::jsonb)) <> 'object' then
    raise exception 'Persona data must be an object';
  end if;
  if octet_length(p_persona::text) > 100000 then
    raise exception 'Persona data is too large';
  end if;
  if jsonb_typeof(coalesce(p_links, 'null'::jsonb)) <> 'array'
      or jsonb_array_length(p_links) > 100 then
    raise exception 'Links must be an array of at most 100 items';
  end if;
  if jsonb_typeof(v_top8) <> 'array' or jsonb_array_length(v_top8) > 8 then
    raise exception 'Top 8 must be an array of at most 8 personas';
  end if;
  if jsonb_typeof(v_linked) <> 'array' then
    raise exception 'Linked personas must be an array';
  end if;
  if jsonb_typeof(v_modules) <> 'object' then
    raise exception 'Page modules must be an object';
  end if;

  v_handle := lower(trim(coalesce(p_persona ->> 'handle', '')));
  v_name := trim(coalesce(p_persona ->> 'name', ''));
  v_visibility := coalesce(nullif(p_persona ->> 'visibility', ''), 'public');
  if v_handle !~ '^[a-z0-9._]{3,30}$' then
    raise exception 'Invalid persona handle';
  end if;
  if v_name = '' or char_length(v_name) > 256 then
    raise exception 'Persona name is required and must be 256 characters or less';
  end if;
  if v_visibility not in ('public', 'unlisted', 'private') then
    raise exception 'Invalid persona visibility';
  end if;
  if char_length(coalesce(p_note, '')) > 20000 then
    raise exception 'Private note must be 20000 characters or less';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_links) as item(value)
    where jsonb_typeof(value) <> 'object'
       or char_length(coalesce(value ->> 'platform', '')) > 50
       or char_length(coalesce(value ->> 'handle', '')) > 500
       or char_length(coalesce(value ->> 'url', '')) > 4000
  ) then
    raise exception 'A persona link is invalid or too long';
  end if;

  begin
    v_ai_backend := nullif(p_persona ->> 'ai_backend', '')::uuid;
  exception when invalid_text_representation then
    raise exception 'Invalid AI backend';
  end;
  if v_ai_backend is not null and not exists (
    select 1 from public.ai_backends b
    where b.id = v_ai_backend and b.owner = v_uid
  ) then
    raise exception 'AI backend is not owned by this account';
  end if;
  if exists (
    select 1 from jsonb_array_elements_text(v_linked) as item(value)
    where value !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ) then
    raise exception 'A linked persona id is invalid';
  end if;
  if exists (
    select 1 from jsonb_array_elements_text(v_top8) as item(value)
    where value !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ) then
    raise exception 'A Top 8 persona id is invalid';
  end if;
  if exists (
    select 1 from jsonb_array_elements_text(v_linked) as linked(linked_id)
    where not exists (
      select 1 from public.personas p
      where p.id = linked_id::uuid and p.owner = v_uid
    )
  ) then
    raise exception 'A linked persona is not owned by this account';
  end if;
  if exists (
    select 1 from jsonb_array_elements_text(v_top8) as top_item(top_id)
    where not exists (
      select 1 from public.personas p
      where p.id = top_id::uuid and public.persona_visible(p.id)
    )
  ) then
    raise exception 'A Top 8 persona does not exist';
  end if;

  if p_persona_id is null then
    insert into public.personas (
      owner, handle, name, nsfw, visibility, tagline, theme, bio,
      avatar_url, banner_url, bg_url, feed_img_url, music_url, live_url,
      purpose, voice, topics, audience, hashtags, dont, ai_backend,
      top8, linked, modules
    ) values (
      v_uid, v_handle, v_name,
      coalesce((p_persona ->> 'nsfw')::boolean, false), v_visibility,
      coalesce(p_persona ->> 'tagline', ''),
      coalesce(p_persona ->> 'theme', '#ff4fa3'),
      coalesce(p_persona ->> 'bio', ''),
      coalesce(p_persona ->> 'avatar_url', ''),
      coalesce(p_persona ->> 'banner_url', ''),
      coalesce(p_persona ->> 'bg_url', ''),
      coalesce(p_persona ->> 'feed_img_url', ''),
      coalesce(p_persona ->> 'music_url', ''),
      coalesce(p_persona ->> 'live_url', ''),
      coalesce(p_persona ->> 'purpose', ''),
      coalesce(p_persona ->> 'voice', ''),
      coalesce(p_persona ->> 'topics', ''),
      coalesce(p_persona ->> 'audience', ''),
      coalesce(p_persona ->> 'hashtags', ''),
      coalesce(p_persona ->> 'dont', ''),
      v_ai_backend, v_top8, v_linked, v_modules
    ) returning id into v_id;
  else
    select p.id into v_id from public.personas p
      where p.id = p_persona_id and p.owner = v_uid for update;
    if v_id is null then
      raise exception 'Owned persona not found';
    end if;
    if exists (
      select 1 from jsonb_array_elements_text(v_linked) as linked(linked_id)
      where linked_id::uuid = v_id
    ) then
      raise exception 'A persona cannot link to itself';
    end if;
    update public.personas set
      handle = v_handle,
      name = v_name,
      nsfw = coalesce((p_persona ->> 'nsfw')::boolean, false),
      visibility = v_visibility,
      tagline = coalesce(p_persona ->> 'tagline', ''),
      theme = coalesce(p_persona ->> 'theme', '#ff4fa3'),
      bio = coalesce(p_persona ->> 'bio', ''),
      avatar_url = coalesce(p_persona ->> 'avatar_url', ''),
      banner_url = coalesce(p_persona ->> 'banner_url', ''),
      bg_url = coalesce(p_persona ->> 'bg_url', ''),
      feed_img_url = coalesce(p_persona ->> 'feed_img_url', ''),
      music_url = coalesce(p_persona ->> 'music_url', ''),
      live_url = coalesce(p_persona ->> 'live_url', ''),
      purpose = coalesce(p_persona ->> 'purpose', ''),
      voice = coalesce(p_persona ->> 'voice', ''),
      topics = coalesce(p_persona ->> 'topics', ''),
      audience = coalesce(p_persona ->> 'audience', ''),
      hashtags = coalesce(p_persona ->> 'hashtags', ''),
      dont = coalesce(p_persona ->> 'dont', ''),
      ai_backend = v_ai_backend,
      top8 = v_top8,
      linked = v_linked,
      modules = v_modules
    where id = v_id;
  end if;

  delete from public.persona_links where persona_id = v_id;
  insert into public.persona_links (persona_id, platform, handle, url, sort)
  select v_id,
    coalesce(nullif(trim(link ->> 'platform'), ''), 'other'),
    coalesce(link ->> 'handle', ''),
    coalesce(link ->> 'url', ''),
    ordinality::integer - 1
  from jsonb_array_elements(p_links) with ordinality as links(link, ordinality);

  delete from public.private_notes where persona_id = v_id;
  if trim(coalesce(p_note, '')) <> '' then
    insert into public.private_notes (persona_id, content)
    values (v_id, trim(p_note));
  end if;

  return v_id;
end;
$$;

revoke all on function public.save_persona_bundle(uuid,jsonb,jsonb,text)
  from public, anon, authenticated;
grant execute on function public.save_persona_bundle(uuid,jsonb,jsonb,text)
  to authenticated;

comment on function public.save_persona_bundle(uuid,jsonb,jsonb,text) is
  'Atomically saves one owned persona and replaces its public links and private note.';
-- END 014-atomic-persona-save.sql

-- BEGIN 015-twitter-oauth.sql
-- X / Twitter OAuth 2.0 Authorization Code + PKCE.
--
-- OAuth state, PKCE verifiers, access tokens, and refresh tokens are
-- service-only. account_connections contains only non-secret, server-attested
-- identity and connection metadata. Posting remains disabled in the connector.

create extension if not exists supabase_vault with schema vault;

create table if not exists public.twitter_oauth_transactions (
  state_hash text primary key check (state_hash ~ '^[0-9a-f]{64}$'),
  owner uuid not null references public.profiles(id) on delete cascade,
  ledger_id uuid not null,
  code_verifier text not null check (char_length(code_verifier) between 43 and 128),
  browser_nonce_hash text not null check (browser_nonce_hash ~ '^[0-9a-f]{64}$'),
  return_origin text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  foreign key (ledger_id, owner)
    references public.account_ledger(id, owner) on delete cascade
);

create unique index if not exists twitter_oauth_transactions_owner_ledger_idx
  on public.twitter_oauth_transactions (owner, ledger_id);
create index if not exists twitter_oauth_transactions_expiry_idx
  on public.twitter_oauth_transactions (expires_at);

-- The token payload itself is stored as one encrypted JSON document in Vault.
-- These non-secret identity columns let the service verify that refreshed
-- credentials still belong to the same X account before replacing the secret.
create table if not exists public.twitter_credentials (
  ledger_id uuid primary key,
  owner uuid not null references public.profiles(id) on delete cascade,
  provider_subject text not null default '',
  provider_username text not null default '',
  vault_secret_id uuid not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (ledger_id, owner)
    references public.account_ledger(id, owner) on delete cascade,
  check (provider_subject = '' or provider_subject ~ '^[0-9]{1,32}$'),
  check (
    provider_username = ''
    or provider_username ~ '^[A-Za-z0-9_]{1,15}$'
  )
);

create unique index if not exists twitter_credentials_provider_subject_idx
  on public.twitter_credentials (provider_subject)
  where provider_subject <> '';

-- Refresh tokens may rotate. Serialize every operation that can rotate, revoke,
-- or delete a token bundle so concurrent tabs/workers cannot overwrite a newer
-- refresh token with a stale one. Leases are bounded and safely reclaimable.
create table if not exists public.twitter_token_operation_leases (
  ledger_id uuid primary key,
  owner uuid not null references public.profiles(id) on delete cascade,
  lease_id uuid not null unique,
  operation_kind text not null
    check (operation_kind in ('connect', 'refresh', 'disconnect', 'reset')),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  foreign key (ledger_id, owner)
    references public.account_ledger(id, owner) on delete cascade
);

create index if not exists twitter_token_operation_leases_expiry_idx
  on public.twitter_token_operation_leases (expires_at);

alter table public.twitter_oauth_transactions enable row level security;
alter table public.twitter_credentials enable row level security;
alter table public.twitter_token_operation_leases enable row level security;

-- Deliberately no browser policies. Only service_role and SECURITY DEFINER
-- helpers can touch authorization transactions or encrypted credentials.
revoke all on public.twitter_oauth_transactions from anon, authenticated;
revoke all on public.twitter_credentials from anon, authenticated;
revoke all on public.twitter_token_operation_leases from anon, authenticated;
grant all on public.twitter_oauth_transactions to service_role;
grant all on public.twitter_credentials to service_role;
grant all on public.twitter_token_operation_leases to service_role;

comment on table public.twitter_oauth_transactions is
  'Service-only, single-use X OAuth state, same-browser nonce, and PKCE verifier records.';
comment on table public.twitter_credentials is
  'Service-only map from an X ledger entry to an encrypted Supabase Vault token bundle.';
comment on table public.twitter_token_operation_leases is
  'Service-only bounded leases that serialize X connect, refresh, disconnect, and reset operations per ledger.';

create or replace function public.consume_twitter_oauth_state(
  p_state_hash text,
  p_owner uuid,
  p_browser_nonce_hash text
)
returns table(owner uuid, ledger_id uuid, code_verifier text)
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
  delete from public.twitter_oauth_transactions as tx
  where tx.state_hash = p_state_hash
    and tx.owner = p_owner
    and tx.browser_nonce_hash = p_browser_nonce_hash
    and tx.expires_at > now()
  returning tx.owner, tx.ledger_id, tx.code_verifier;
end;
$$;

create or replace function public.claim_twitter_token_operation(
  p_ledger_id uuid,
  p_owner uuid,
  p_lease_id uuid,
  p_operation_kind text,
  p_ttl_seconds integer
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_claimed boolean := false;
begin
  if p_operation_kind not in ('connect', 'refresh', 'disconnect', 'reset') then
    raise exception 'Invalid X token operation';
  end if;
  if p_ttl_seconds < 15 or p_ttl_seconds > 180 then
    raise exception 'X token-operation lease must be between 15 and 180 seconds';
  end if;
  if not exists (
    select 1
    from public.account_ledger
    where id = p_ledger_id
      and owner = p_owner
      and provider = 'twitter'
  ) then
    raise exception 'Owned X ledger entry not found';
  end if;

  insert into public.twitter_token_operation_leases as lease (
    ledger_id,
    owner,
    lease_id,
    operation_kind,
    expires_at,
    created_at
  ) values (
    p_ledger_id,
    p_owner,
    p_lease_id,
    p_operation_kind,
    now() + make_interval(secs => p_ttl_seconds),
    now()
  )
  on conflict (ledger_id) do update set
    owner = excluded.owner,
    lease_id = excluded.lease_id,
    operation_kind = excluded.operation_kind,
    expires_at = excluded.expires_at,
    created_at = excluded.created_at
  where lease.expires_at <= now()
  returning true into v_claimed;

  return coalesce(v_claimed, false);
end;
$$;

create or replace function public.release_twitter_token_operation(
  p_ledger_id uuid,
  p_owner uuid,
  p_lease_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted_count integer := 0;
begin
  delete from public.twitter_token_operation_leases
  where ledger_id = p_ledger_id
    and owner = p_owner
    and lease_id = p_lease_id;
  get diagnostics v_deleted_count = row_count;
  return v_deleted_count > 0;
end;
$$;

create or replace function public.twitter_store_token_bundle(
  p_ledger_id uuid,
  p_owner uuid,
  p_expected_ledger_username text,
  p_provider_subject text,
  p_provider_username text,
  p_access_token text,
  p_refresh_token text,
  p_token_type text,
  p_scope text,
  p_expires_at timestamptz
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_secret_id uuid;
  v_secret_name text := 'twitter_oauth_' || p_ledger_id::text;
  v_provider text;
  v_ledger_username text;
  v_expected_username text :=
    lower(regexp_replace(trim(coalesce(p_expected_ledger_username, '')), '^@+', ''));
  v_provider_username text :=
    regexp_replace(trim(coalesce(p_provider_username, '')), '^@+', '');
  v_bundle text;
begin
  if trim(coalesce(p_access_token, '')) = ''
    or trim(coalesce(p_refresh_token, '')) = '' then
    raise exception 'X access and refresh tokens are required';
  end if;
  if char_length(p_access_token) > 16384
    or char_length(p_refresh_token) > 16384 then
    raise exception 'X token exceeds the storage limit';
  end if;
  if lower(trim(coalesce(p_token_type, ''))) <> 'bearer' then
    raise exception 'X token type must be bearer';
  end if;
  if char_length(coalesce(p_scope, '')) > 2048 then
    raise exception 'X scope exceeds the storage limit';
  end if;
  if p_expires_at is null or p_expires_at <= now() then
    raise exception 'X access-token expiry must be in the future';
  end if;
  if trim(coalesce(p_provider_subject, '')) <> ''
    and p_provider_subject !~ '^[0-9]{1,32}$' then
    raise exception 'Invalid X provider subject';
  end if;
  if v_provider_username <> ''
    and v_provider_username !~ '^[A-Za-z0-9_]{1,15}$' then
    raise exception 'Invalid X provider username';
  end if;
  if (trim(coalesce(p_provider_subject, '')) = '')
    is distinct from (v_provider_username = '') then
    raise exception 'X provider subject and username must be stored together';
  end if;

  select
    provider,
    lower(regexp_replace(trim(coalesce(username, '')), '^@+', ''))
    into v_provider, v_ledger_username
  from public.account_ledger
  where id = p_ledger_id and owner = p_owner
  for update;

  if not found
    or v_provider <> 'twitter'
    or v_ledger_username = ''
    or v_ledger_username <> v_expected_username then
    raise exception 'Owned X ledger entry changed during authorization';
  end if;

  v_bundle := jsonb_build_object(
    'access_token', p_access_token,
    'refresh_token', p_refresh_token,
    'token_type', 'bearer',
    'scope', trim(coalesce(p_scope, '')),
    'expires_at', p_expires_at,
    'stored_at', now()
  )::text;

  select vault_secret_id into v_secret_id
  from public.twitter_credentials
  where ledger_id = p_ledger_id and owner = p_owner
  for update;

  if v_secret_id is null then
    select id into v_secret_id
    from vault.secrets
    where name = v_secret_name;
  end if;

  if v_secret_id is null then
    select vault.create_secret(
      v_bundle,
      v_secret_name,
      'X OAuth token bundle for ledger ' || p_ledger_id::text
    ) into v_secret_id;
  else
    perform vault.update_secret(
      v_secret_id,
      v_bundle,
      v_secret_name,
      'X OAuth token bundle for ledger ' || p_ledger_id::text
    );
  end if;

  insert into public.twitter_credentials as credential (
    ledger_id,
    owner,
    provider_subject,
    provider_username,
    vault_secret_id,
    updated_at
  ) values (
    p_ledger_id,
    p_owner,
    trim(coalesce(p_provider_subject, '')),
    v_provider_username,
    v_secret_id,
    now()
  )
  on conflict (ledger_id) do update set
    owner = excluded.owner,
    provider_subject = excluded.provider_subject,
    provider_username = excluded.provider_username,
    vault_secret_id = excluded.vault_secret_id,
    updated_at = excluded.updated_at;

  return v_secret_id;
end;
$$;

create or replace function public.twitter_get_token_bundle(
  p_ledger_id uuid,
  p_owner uuid
)
returns table(
  provider_subject text,
  provider_username text,
  token_bundle jsonb
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
  select
    credential.provider_subject,
    credential.provider_username,
    secret.decrypted_secret::jsonb
  from public.twitter_credentials as credential
  join vault.decrypted_secrets as secret
    on secret.id = credential.vault_secret_id
  where credential.ledger_id = p_ledger_id
    and credential.owner = p_owner;
end;
$$;

create or replace function public.delete_twitter_vault_secret()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from vault.secrets where id = old.vault_secret_id;
  return old;
end;
$$;

drop trigger if exists twitter_credentials_delete_vault_secret
  on public.twitter_credentials;
create trigger twitter_credentials_delete_vault_secret
  after delete on public.twitter_credentials
  for each row execute function public.delete_twitter_vault_secret();

-- A direct or stale browser write must not orphan a confirmed or ambiguous X
-- grant by deleting its ledger or changing the provider identity underneath it.
create or replace function public.guard_connected_twitter_ledger_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- The service erasure path holds the same per-ledger disconnect lease while
  -- it revokes the provider grant, deletes the Vault bundle, and deletes the
  -- ledger row. Once the credential is gone, allow only that exact
  -- service_role operation to finish before the lease is released.
  if tg_op = 'DELETE'
    and auth.role() = 'service_role'
    and not exists (
      select 1
      from public.twitter_credentials
      where ledger_id = old.id
    )
    and exists (
      select 1
      from public.twitter_token_operation_leases
      where ledger_id = old.id
        and owner = old.owner
        and operation_kind = 'disconnect'
        and expires_at > now()
    ) then
    return old;
  end if;

  if exists (
    select 1
    from public.twitter_credentials
    where ledger_id = old.id
  ) or exists (
    select 1
    from public.account_connections
    where ledger_id = old.id
      and owner = old.owner
      and provider = 'twitter'
      and connection_state in ('connected', 'error')
  ) or exists (
    select 1
    from public.twitter_token_operation_leases
    where ledger_id = old.id and expires_at > now()
  ) then
    if tg_op = 'DELETE' then
      raise exception 'Disconnect X before deleting this account';
    end if;
    if new.provider is distinct from old.provider
      or lower(regexp_replace(trim(coalesce(new.username, '')), '^@+', ''))
        is distinct from
        lower(regexp_replace(trim(coalesce(old.username, '')), '^@+', '')) then
      raise exception 'Disconnect X before changing its provider or username';
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists guard_connected_twitter_ledger_change
  on public.account_ledger;
create trigger guard_connected_twitter_ledger_change
  before delete or update of provider, username on public.account_ledger
  for each row execute function public.guard_connected_twitter_ledger_change();

create or replace function public.twitter_delete_token_bundle(
  p_ledger_id uuid,
  p_owner uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted_count integer := 0;
begin
  delete from public.twitter_credentials
  where ledger_id = p_ledger_id and owner = p_owner;
  get diagnostics v_deleted_count = row_count;
  return v_deleted_count > 0;
end;
$$;

revoke all on function public.consume_twitter_oauth_state(text, uuid, text)
  from public, anon, authenticated;
revoke all on function public.claim_twitter_token_operation(
  uuid, uuid, uuid, text, integer
) from public, anon, authenticated;
revoke all on function public.release_twitter_token_operation(
  uuid, uuid, uuid
) from public, anon, authenticated;
revoke all on function public.twitter_store_token_bundle(
  uuid, uuid, text, text, text, text, text, text, text, timestamptz
) from public, anon, authenticated;
revoke all on function public.twitter_get_token_bundle(uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.twitter_delete_token_bundle(uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.delete_twitter_vault_secret()
  from public, anon, authenticated;
revoke all on function public.guard_connected_twitter_ledger_change()
  from public, anon, authenticated;

grant execute on function public.consume_twitter_oauth_state(text, uuid, text)
  to service_role;
grant execute on function public.claim_twitter_token_operation(
  uuid, uuid, uuid, text, integer
) to service_role;
grant execute on function public.release_twitter_token_operation(
  uuid, uuid, uuid
) to service_role;
grant execute on function public.twitter_store_token_bundle(
  uuid, uuid, text, text, text, text, text, text, text, timestamptz
) to service_role;
grant execute on function public.twitter_get_token_bundle(uuid, uuid)
  to service_role;
grant execute on function public.twitter_delete_token_bundle(uuid, uuid)
  to service_role;

comment on function public.consume_twitter_oauth_state(text, uuid, text) is
  'Service-only atomic consume for X OAuth state bound to its owner and initiating browser tab.';
comment on function public.claim_twitter_token_operation(
  uuid, uuid, uuid, text, integer
) is
  'Service-only atomic claim of a bounded per-ledger X token-operation lease.';
comment on function public.release_twitter_token_operation(
  uuid, uuid, uuid
) is
  'Service-only release of an X token-operation lease by its unguessable lease id.';
comment on function public.twitter_store_token_bundle(
  uuid, uuid, text, text, text, text, text, text, text, timestamptz
) is
  'Service-only storage of an X OAuth access/refresh token bundle in encrypted Supabase Vault.';
comment on function public.twitter_get_token_bundle(uuid, uuid) is
  'Service-only retrieval of an X OAuth token bundle from Supabase Vault.';
comment on function public.twitter_delete_token_bundle(uuid, uuid) is
  'Service-only deletion of an X OAuth token bundle and its Vault secret.';
-- END 015-twitter-oauth.sql
