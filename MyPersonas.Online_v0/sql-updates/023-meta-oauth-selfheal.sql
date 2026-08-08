-- 023-meta-oauth-selfheal.sql
-- Makes the in-app Meta cleanup ("Cancel previous Meta authorization") self-healing.
--
-- Problem: meta_claim_oauth_candidate_for_revocation RAISES when the stuck state is
-- inconsistent (vault bundle unreadable, or the identity reservation no longer points
-- at the candidate). The meta-oauth function surfaces that as the dead-end
-- "Could not lock the Meta authorization for cleanup" — and since regular users can't
-- run SQL, they'd be permanently wedged. This migration keeps all the safety
-- properties for the NORMAL path (valid candidate + bundle → claim for provider
-- revocation) but SELF-HEALS the two inconsistent cases instead of raising:
--   1. Vault bundle unreadable → nothing can be revoked at the provider from here;
--      remove the orphan candidate + unlink the reservation, report "already resolved".
--   2. Reservation missing/diverged → repair the pointer and continue the claim.
--
-- Owner-run in the Supabase SQL editor. Safe / idempotent (create or replace).

create or replace function public.meta_claim_oauth_candidate_for_revocation(
  p_selection_hash text,
  p_owner uuid,
  p_browser_nonce_hash text default null,
  p_allow_manual_required boolean default false
)
returns table(
  selection_hash text,
  meta_user_id text,
  previous_revocation_state text,
  token_bundle jsonb
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_candidate public.meta_oauth_candidates%rowtype;
  v_token_bundle jsonb;
begin
  if p_selection_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid Meta candidate selection';
  end if;
  if p_browser_nonce_hash is not null
    and p_browser_nonce_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid Meta candidate browser binding';
  end if;

  select * into v_candidate
  from public.meta_oauth_candidates as candidate
  where candidate.selection_hash = p_selection_hash
    and candidate.owner = p_owner
    and (
      p_browser_nonce_hash is null
      or candidate.browser_nonce_hash = p_browser_nonce_hash
    )
    and (
      candidate.revocation_state in ('pending', 'provider_revoked')
      or (
        candidate.revocation_state = 'revoking'
        and (
          candidate.revocation_started_at is null
          or candidate.revocation_started_at < now() - interval '3 minutes'
        )
      )
      or (
        p_allow_manual_required
        and candidate.revocation_state = 'manual_required'
      )
    )
  for update;
  if not found then return; end if;

  select secret.decrypted_secret::jsonb into v_token_bundle
  from vault.decrypted_secrets as secret
  where secret.id = v_candidate.vault_secret_id;
  if v_token_bundle is null then
    -- SELF-HEAL 1: encrypted bundle unrecoverable. There is no token to revoke at
    -- the provider from here; remove the orphan instead of wedging every cleanup.
    delete from public.meta_oauth_candidates
      where selection_hash = v_candidate.selection_hash and owner = p_owner;
    update public.meta_identity_reservations
      set candidate_selection_hash = null
      where owner = p_owner
        and candidate_selection_hash = v_candidate.selection_hash
        and grant_id is not null;
    delete from public.meta_identity_reservations
      where owner = p_owner
        and candidate_selection_hash = v_candidate.selection_hash
        and grant_id is null;
    return; -- empty result = "already finalized / resolved" to the caller
  end if;

  -- SELF-HEAL 2: repair a missing or diverged reservation pointer for this owner
  -- rather than raising. A reservation held by ANOTHER owner is left untouched
  -- (identity protection), and the claim still proceeds for our own candidate.
  insert into public.meta_identity_reservations (meta_user_id, owner, candidate_selection_hash)
  values (v_candidate.meta_user_id, p_owner, v_candidate.selection_hash)
  on conflict (meta_user_id) do update
    set candidate_selection_hash = excluded.candidate_selection_hash,
        updated_at = now()
    where public.meta_identity_reservations.owner = excluded.owner;

  update public.meta_oauth_candidates
  set
    revocation_state = 'revoking',
    revocation_error_code = '',
    revocation_started_at = now()
  where selection_hash = v_candidate.selection_hash
    and owner = p_owner;

  return query select
    v_candidate.selection_hash,
    v_candidate.meta_user_id,
    v_candidate.revocation_state,
    v_token_bundle;
end;
$$;

revoke all on function public.meta_claim_oauth_candidate_for_revocation(text,uuid,text,boolean) from public, anon, authenticated;
