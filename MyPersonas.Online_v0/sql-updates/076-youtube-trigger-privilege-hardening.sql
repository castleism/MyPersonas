-- 076-youtube-trigger-privilege-hardening.sql
-- Remove inherited browser/service RPC execution from the three YouTube
-- SECURITY DEFINER trigger implementations introduced by migration 067.
-- They remain installed as table triggers; they are not application RPCs.

begin;

revoke all on function public.delete_youtube_credential_vault_secret()
  from public, anon, authenticated, service_role;
revoke all on function public.delete_youtube_upload_session_vault_secret()
  from public, anon, authenticated, service_role;
revoke all on function public.invalidate_youtube_approval_on_draft_change()
  from public, anon, authenticated, service_role;

comment on function public.delete_youtube_credential_vault_secret() is
  'Internal trigger only. Deletes the encrypted token secret after its credential row is deleted; never callable as a browser or service RPC.';
comment on function public.delete_youtube_upload_session_vault_secret() is
  'Internal trigger only. Deletes the encrypted resumable-upload URL after its session row is deleted; never callable as a browser or service RPC.';
comment on function public.invalidate_youtube_approval_on_draft_change() is
  'Internal trigger only. Invalidates stale YouTube approval evidence after a draft changes; never callable as a browser or service RPC.';

commit;
