-- 007 provider + extra fields for linked AI models.
-- Additive and safe. Adds a provider label and a jsonb for provider-specific
-- fields (e.g. ElevenLabs voice_id, Azure api_version). The client also degrades
-- gracefully if this has not been run yet. Run in Supabase SQL Editor.

alter table public.ai_backends add column if not exists provider text default '';
alter table public.ai_backends add column if not exists extra jsonb default '{}';
