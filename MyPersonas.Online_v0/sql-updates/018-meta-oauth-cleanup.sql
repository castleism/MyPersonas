-- 018-meta-oauth-cleanup.sql
-- Clears any retained/orphan Meta OAuth handshake state for your account so a fresh
-- Meta connect can proceed cleanly. These are TRANSIENT handshake rows (candidates +
-- the reservation's pointer to a candidate) — this does NOT delete a live grant or any
-- connected Page. Run only if the app still shows "Meta authorization cleanup required"
-- after you've deployed the patched index.html.
--
-- Root cause of the stuck state: the client bug in finishPendingMeta() discarded a
-- successful `complete` on a same-user SPA reload, orphaning the server candidate.
-- The patched index.html fixes that going forward; this clears the pre-existing orphan.

delete from public.meta_oauth_candidates
  where owner = '512dfc83-3ee3-4d67-ab2a-48d108e8f75a';

update public.meta_identity_reservations
  set candidate_selection_hash = null
  where owner = '512dfc83-3ee3-4d67-ab2a-48d108e8f75a';
