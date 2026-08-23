\set ON_ERROR_STOP on

create role anon nologin;
create role authenticated nologin;
create role service_role nologin;

create table public.noo_waitlist (
  id bigint generated always as identity primary key,
  email text not null,
  source text not null default 'nooyouniverse.com',
  created_at timestamptz not null default now()
);
alter table public.noo_waitlist enable row level security;
create policy noo_waitlist_anon_insert on public.noo_waitlist
  for insert to anon with check (true);

-- Reproduce the live provider defaults plus the historical column grant.
grant all privileges on table public.noo_waitlist to anon, authenticated, service_role;
grant insert (email,source) on public.noo_waitlist to anon;

create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin return new; end
$$;

create or replace function public.tg_touch_updated_at()
returns trigger language plpgsql as $$
begin return new; end
$$;

create or replace function public.auto_create_research_settings()
returns trigger language plpgsql security definer set search_path='' as $$
begin return new; end
$$;
create or replace function public.cleanup_deleted_fan_chat_notification()
returns trigger language plpgsql security definer set search_path='' as $$
begin return old; end
$$;
create or replace function public.invalidate_content_package_approval()
returns trigger language plpgsql security definer set search_path='' as $$
begin return new; end
$$;
create or replace function public.notify_content_package_review()
returns trigger language plpgsql security definer set search_path='' as $$
begin return new; end
$$;
create or replace function public.notify_new_research_brief()
returns trigger language plpgsql security definer set search_path='' as $$
begin return new; end
$$;
create or replace function public.notify_owner_fan_message()
returns trigger language plpgsql security definer set search_path='' as $$
begin return new; end
$$;

create or replace function public.owner_research_brief_queue(date,text)
returns boolean language sql security definer set search_path='' as $$select true$$;
create or replace function public.get_research_digest(uuid,integer)
returns boolean language sql security definer set search_path='' as $$select true$$;
create or replace function public.owns_persona(uuid)
returns boolean language sql security definer stable set search_path=public as $$select false$$;
create or replace function public.persona_visible(uuid)
returns boolean language sql security definer stable set search_path='' as $$select false$$;

-- Reproduce the old/default browser execution that migration 061 removes.
grant execute on all functions in schema public to anon, authenticated, service_role;
