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
