-- 040-persona-ai-model-routes.sql
-- Per-persona AI model routing: maps persona + task type + role → ai_backend.
--
-- The existing ai_backends table stores one provider endpoint + model + Vault-backed
-- credential. This migration adds a routing layer on top so different task types
-- (persona chat, voice drafting, bulk captions, research, code review, image
-- generation, embeddings, TTS) can route to different models per persona.
--
-- Resolution order (enforced by resolve_persona_ai_backend RPC):
--   1. Persona-specific route for route_key + role
--   2. Owner-global route where persona_id is null
--   3. Legacy personas.ai_backend (primary only, persona_chat only)
--   4. Null / explicit error
--
-- Additive and safe. Owner-scoped RLS. No data migration.
-- Owner-run in the Supabase SQL editor.
--
-- Apply BEFORE deploying the matching ai-proxy update that accepts route_key/route_role.

begin;

-- ============ PREREQUISITES ============

-- Ensure the composite unique index on ai_backends exists for FK enforcement.
-- (Created by 011-agent-automation.sql, but re-check idempotently.)
create unique index if not exists ai_backends_id_owner_idx
  on public.ai_backends (id, owner);

-- ============ ROUTING TABLE ============

create table if not exists public.persona_ai_model_routes (
  id uuid primary key default gen_random_uuid(),

  -- Owner who owns this route. Always matches the backend's owner.
  owner uuid not null references public.profiles(id) on delete cascade,

  -- Persona this route applies to.
  -- NULL = owner-wide default (applies to all personas that don't have a
  -- persona-specific override for the same route_key + role).
  persona_id uuid,

  -- The task type this route handles. See route key catalog below.
  -- Adding new route keys does NOT require a migration — they are just text.
  -- The application validates against a known set; the DB does not constrain
  -- the value so you can add new task types without a schema change.
  route_key text not null,

  -- 'primary' = the main model for this route.
  -- 'reviewer' = the cross-model reviewer for this route.
  -- 'fallback' = a lower-priority backup.
  route_role text not null default 'primary'
    check (route_role in ('primary', 'reviewer', 'fallback')),

  -- When multiple routes match the same persona + route_key + role,
  -- lower priority wins (1 = highest). Used for fallback chains.
  priority smallint not null default 1
    check (priority between 1 and 10),

  -- The AI backend this route points to. Must be owned by the same owner.
  backend_id uuid not null,

  -- Whether this route is active. Disabled routes are skipped during resolution.
  enabled boolean not null default true,

  -- Optional per-route configuration (e.g. temperature, max_tokens overrides,
  -- system prompt additions specific to this route).
  route_config jsonb not null default '{}'::jsonb,

  -- Human-readable notes for the owner (e.g. "Claude Sonnet for Avi voice").
  notes text not null default '',

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Enforce owner consistency: backend must be owned by the same owner.
  foreign key (backend_id, owner)
    references public.ai_backends (id, owner)
    on delete cascade,

  -- Enforce owner consistency: persona must be owned by the same owner.
  -- Only when persona_id is not null.
  foreign key (persona_id, owner)
    references public.personas (id, owner)
    on delete cascade
);

-- ============ INDEXES ============

-- Primary lookup: resolve by persona + route_key + role, enabled first.
create index if not exists persona_ai_model_routes_resolve_idx
  on public.persona_ai_model_routes (owner, persona_id, route_key, route_role, enabled, priority);

-- Owner-wide defaults (persona_id is null).
create index if not exists persona_ai_model_routes_defaults_idx
  on public.persona_ai_model_routes (owner, route_key, route_role, enabled, priority)
  where persona_id is null;

-- Per-persona overrides.
create index if not exists persona_ai_model_routes_persona_idx
  on public.persona_ai_model_routes (persona_id, route_key, route_role, enabled, priority)
  where persona_id is not null;

-- ============ RLS ============

alter table public.persona_ai_model_routes enable row level security;

drop policy if exists "persona_ai_model_routes owner all" on public.persona_ai_model_routes;
create policy "persona_ai_model_routes owner all" on public.persona_ai_model_routes
  for all to authenticated
  using (auth.uid() = owner)
  with check (auth.uid() = owner);

-- ============ UPDATED_AT TRIGGER ============

create or replace function public.touch_persona_ai_model_routes_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists touch_persona_ai_model_routes_updated_at
  on public.persona_ai_model_routes;
create trigger touch_persona_ai_model_routes_updated_at
  before update on public.persona_ai_model_routes
  for each row execute function public.touch_persona_ai_model_routes_updated_at();

-- ============ RESOLVER RPC ============
-- Service-role only. Returns a backend_id (uuid) or null.
-- Does NOT expose secrets. The caller (edge function) uses ai_backend_get_key()
-- to retrieve the decrypted key after resolution.

create or replace function public.resolve_persona_ai_backend(
  p_owner uuid,
  p_persona_id uuid,
  p_route_key text,
  p_route_role text default 'primary'
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_backend_id uuid;
begin
  if p_owner is null or p_route_key is null then
    raise exception using
      errcode = '22023',
      message = 'Owner and route_key are required';
  end if;

  if p_route_role is null then
    p_route_role := 'primary';
  end if;

  -- 1. Persona-specific route
  select r.backend_id into v_backend_id
  from public.persona_ai_model_routes r
  where r.owner = p_owner
    and r.persona_id = p_persona_id
    and r.route_key = p_route_key
    and r.route_role = p_route_role
    and r.enabled = true
  order by r.priority asc, r.created_at asc
  limit 1;

  if v_backend_id is not null then
    return v_backend_id;
  end if;

  -- 2. Owner-global default route
  select r.backend_id into v_backend_id
  from public.persona_ai_model_routes r
  where r.owner = p_owner
    and r.persona_id is null
    and r.route_key = p_route_key
    and r.route_role = p_route_role
    and r.enabled = true
  order by r.priority asc, r.created_at asc
  limit 1;

  if v_backend_id is not null then
    return v_backend_id;
  end if;

  -- 3. Legacy fallback: personas.ai_backend (only for primary + persona_chat)
  if p_route_role = 'primary' and p_route_key = 'persona_chat' then
    select p.ai_backend into v_backend_id
    from public.personas p
    where p.id = p_persona_id and p.owner = p_owner
      and p.ai_backend is not null;

    return v_backend_id;
  end if;

  -- 4. No route found
  return null;
end;
$$;

comment on function public.resolve_persona_ai_backend(uuid, uuid, text, text)
  is 'Service-role-only resolver. Returns backend_id for a persona + route_key + role. Does not expose secrets. Resolution order: persona-specific → owner-global default → legacy personas.ai_backend (primary/persona_chat only) → null.';

revoke all on function public.resolve_persona_ai_backend(uuid, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.resolve_persona_ai_backend(uuid, uuid, text, text)
  to service_role;

-- ============ OWNER-FACING HELPER RPC ============
-- Returns the effective route map for a persona (all route keys + roles).
-- Owner-authenticated. Does not expose secrets.

create or replace function public.get_persona_route_map(
  p_persona_id uuid
)
returns table (
  route_key text,
  route_role text,
  priority smallint,
  backend_id uuid,
  backend_name text,
  backend_provider text,
  backend_model text,
  enabled boolean,
  notes text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid := auth.uid();
begin
  if v_owner is null then
    raise exception 'Authentication required';
  end if;

  -- Verify ownership
  if not exists (
    select 1 from public.personas p
    where p.id = p_persona_id and p.owner = v_owner
  ) then
    raise exception 'Persona not found or not owned by caller';
  end if;

  return query
  select
    r.route_key,
    r.route_role,
    r.priority,
    r.backend_id,
    b.name as backend_name,
    b.provider as backend_provider,
    b.model as backend_model,
    r.enabled,
    r.notes
  from public.persona_ai_model_routes r
  left join public.ai_backends b on b.id = r.backend_id
  where r.owner = v_owner
    and (r.persona_id = p_persona_id or r.persona_id is null)
  order by r.route_key, r.route_role, r.priority;
end;
$$;

comment on function public.get_persona_route_map(uuid)
  is 'Owner-authenticated. Returns the effective AI model route map for a persona, including owner-wide defaults. Does not expose secrets.';

revoke all on function public.get_persona_route_map(uuid)
  from anon, public;
grant execute on function public.get_persona_route_map(uuid)
  to authenticated;

-- ============ ROUTE KEY CATALOG ============
-- These are the standard route keys the application recognizes.
-- New keys can be added without a migration — this is documentation only.
--
-- Text / Chat routes (consumed by ai-proxy edge function):
--   persona_chat           — Conversational persona chat (the main AI proxy)
--   persona_voice_draft    — Persona-voiced content drafting (posts, captions)
--   bulk_caption_draft     — High-volume short-form drafting (tags, descriptions)
--   long_context_synthesis — Long-document summarization / synthesis
--   research               — Web research / market intel / competitor analysis
--   code_review            — Cross-model code review
--   security_review        — Security audit review
--
-- Non-text routes (consumed by future/specialized edge functions):
--   image_prompt           — Image prompt generation (text model that writes prompts)
--   image_generation      — Image generation (FLUX, DALL-E, etc.)
--   embedding              — Vector embeddings for semantic search
--   rerank                 — Search result reranking
--   tts                    — Text-to-speech voice generation
--
-- Cross-model review pattern:
--   For each route_key with role='primary', set a corresponding route with
--   role='reviewer' pointing to a different provider. The agent board
--   uses this to run cross-model review before anything reaches the owner.

commit;
