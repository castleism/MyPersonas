-- Restore the internal AAL2 guard required by protected owner RPCs.
-- This is deliberately helper-only. Do not replay legacy migration 041: it
-- also contains superseded AI-backend function signatures.

begin;

create function public.require_aal2()
returns void
language plpgsql
stable
security invoker
set search_path = ''
as $function$
begin
  if auth.uid() is null then
    raise sqlstate '28000' using message = 'Authentication required';
  end if;
  if coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then
    raise sqlstate '42501' using message = 'Two-factor verification required';
  end if;
end;
$function$;

revoke all on function public.require_aal2() from public, anon, authenticated, service_role;
grant execute on function public.require_aal2() to postgres;

comment on function public.require_aal2() is
  'Internal AAL2 assertion used only by protected SECURITY DEFINER RPCs; no Data API role may call it directly.';

notify pgrst, 'reload schema';

commit;
