-- Linked personas: each persona controls which of the owner's OTHER personas
-- are revealed on its page (empty by default — anonymity preserved).
-- Run in Supabase SQL Editor.
alter table public.personas add column linked jsonb default '[]';
