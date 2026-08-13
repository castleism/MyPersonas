-- 031-chat-workspaces.sql
-- Chat workspaces (owner request, 2026-08-10): saved, named persona conversations
-- you can resume and reference later — the "save chats to build the persona's
-- context over time" idea. A workspace groups owner↔persona chat threads; a thread's
-- takeaways get distilled into personas.context_log (migration 030) so the persona
-- carries them forward without replaying the whole transcript. See MOBILE-BLUEPRINT.md §3.
--
-- Additive + owner-scoped RLS. Owner-run in the Supabase SQL editor. Safe/idempotent.

create table if not exists public.chat_workspaces (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null references public.profiles(id) on delete cascade,
  persona_id uuid references public.personas(id) on delete set null,
  title text not null default '' check (char_length(title) <= 200),
  pinned boolean not null default false,
  -- optional link to an existing agent_messages thread key, so a workspace can adopt
  -- a conversation that already exists
  conversation_key text not null default '' check (char_length(conversation_key) <= 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists chat_workspaces_owner_idx
  on public.chat_workspaces (owner, pinned desc, updated_at desc);

alter table public.chat_workspaces enable row level security;

drop policy if exists "chat_workspaces owner all" on public.chat_workspaces;
create policy "chat_workspaces owner all" on public.chat_workspaces
  for all to authenticated
  using (owner = auth.uid())
  with check (owner = auth.uid());

-- Tie owner chat messages to a workspace (nullable — existing threads keep working
-- untouched). Guarded so the migration is safe even if the table name differs.
do $$
begin
  if to_regclass('public.agent_messages') is not null then
    alter table public.agent_messages
      add column if not exists workspace_id uuid
        references public.chat_workspaces(id) on delete set null;
    create index if not exists agent_messages_workspace_idx
      on public.agent_messages (workspace_id) where workspace_id is not null;
  end if;
end;
$$;
