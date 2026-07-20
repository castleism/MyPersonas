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
