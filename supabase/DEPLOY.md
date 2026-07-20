# MyPersonas — server tier deploy guide

This bundle stands up the v0.5 "live network" server tier. Nothing here is served by
GitHub Pages; the Edge Functions run on Supabase. You deploy them; I can't from here.

## 0. One-time setup
```
# Install the Supabase CLI (a global `npm i -g supabase` is NOT supported).
# Windows (scoop):  scoop install supabase
#   no scoop yet?   irm get.scoop.sh | iex   then run the line above
# macOS / Linux:    brew install supabase/tap/supabase
# Or install nothing and prefix each command below with `npx`, e.g. `npx supabase login`.
supabase login
supabase link --project-ref nwsqyuucwzihruszocge
```

## 1. SQL migrations (Supabase Dashboard -> SQL Editor)
Run in order. These migrations are additive and safe:
- `sql-updates/005-comments-reactions.sql` — comments + reactions tables + RLS.
- `sql-updates/006-privacy-owner-uuid.sql` — Phase A only (adds RPCs). Do NOT run the
  Phase B `revoke` yet; it needs the client change in step 4.
- `sql-updates/008-account-ledger.sql` — owner-only external-account inventory used by
  Account → Accounts batch mode. Stores metadata only; no credential columns.
- `sql-updates/009-external-account-connections.sql` — server-attested ownership and
  provider-connection state. A row marked `verified` proves the ledger email matches
  the signed-in AliaSpaces email; it does not grant Gmail or inbox access.
- `sql-updates/010-gmail-oauth.sql` — single-use OAuth state, PKCE verification, and
  service-only Gmail refresh-token storage in Supabase Vault.

## 2. Function secrets
```
supabase secrets set CRON_SECRET=$(openssl rand -hex 24)
supabase secrets set GOOGLE_GMAIL_CLIENT_ID="373519662305-05bnlabe18i89efnhec9inpt36al7lc6.apps.googleusercontent.com"
supabase secrets set GOOGLE_GMAIL_CLIENT_SECRET="<new Google OAuth client secret>"
```
`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected automatically.
Never put the Google client secret in `index.html`, a migration, a commit, or a
browser-readable table. It belongs only in Supabase Edge Function secrets.

### Gmail connector — Google Cloud setup

Use the isolated Google Cloud project **MyPersonas Gmail Connector**
(`genial-union-503010-q5`) and its Web application OAuth client
`373519662305-05bnlabe18i89efnhec9inpt36al7lc6.apps.googleusercontent.com`.
Do not place this connector in the Google Cloud project used for normal AliaSpaces
sign-in. Google token revocation can affect grants project-wide, so a separate OAuth
client inside the same project is not sufficient isolation; the Gmail connector must
remain in its own Cloud project.

1. Enable the **Gmail API**.
2. In **Google Auth Platform → Audience**, keep the app External/Testing while
   developing and add each mailbox owner as a test user (currently
   `christiancodyak@gmail.com`). Only listed test users can authorize a Testing app.
3. In **Data Access**, add `openid`, `email`, and
   `https://www.googleapis.com/auth/gmail.readonly`. The Gmail scope permits reading
   mailbox data but not sending, changing, or deleting mail.
4. On the Web OAuth client in **MyPersonas Gmail Connector**, use only this authorized
   redirect URI:
   `https://nwsqyuucwzihruszocge.supabase.co/functions/v1/gmail-oauth`.
   A JavaScript origin is not required because token exchange happens server-side.
5. Create a new client secret if the existing value is no longer available, copy it
   directly into the Supabase `GOOGLE_GMAIL_CLIENT_SECRET` secret, then disable the
   old secret after the new flow succeeds.

These are two separate authorizations. Google sign-in authenticates a person to
AliaSpaces through Supabase. The Gmail connector separately asks Google for read-only
mailbox API access. Saving an account or seeing **Ownership verified** does not create
that API connection; the user must select **Authenticate Gmail**, choose the exact
recorded mailbox, and approve the consent screen. Only then should the account show
**API connected**.

`gmail.readonly` is a restricted Google scope. Testing is limited to configured test
users. Before broad public release, complete Google's OAuth verification process and
any restricted-scope security assessment Google requires for the production design.

## 3. Deploy the functions
```
supabase functions deploy ai-proxy
supabase functions deploy delete-account
supabase functions deploy gmail-oauth --no-verify-jwt
supabase functions deploy run-tasks --no-verify-jwt
supabase functions deploy sitemap   --no-verify-jwt
```

`gmail-oauth` must be deployed with `--no-verify-jwt` because Google returns to its
public GET callback without an AliaSpaces bearer token. The callback only relays the
short-lived Google code to the originating site. Finalization requires the same
signed-in Supabase user plus a one-time browser-tab secret, state, and PKCE; the
start/complete/disconnect POST actions validate the user's access token in code.

### Schedule run-tasks (daily 8am, results land in drafts)
In the SQL Editor, enable cron + net once, then schedule:
```sql
create extension if not exists pg_cron;
create extension if not exists pg_net;
select cron.schedule('mypersonas-run-tasks','0 8 * * *', $$
  select net.http_post(
    url    := 'https://nwsqyuucwzihruszocge.supabase.co/functions/v1/run-tasks',
    headers:= jsonb_build_object('X-Cron-Secret', '<the CRON_SECRET you set>'),
    body   := '{}'::jsonb
  );
$$);
```

## 4. Client wiring (small edits to MyPersonas.Online_v0/index.html)
These are the only app changes; apply them and redeploy Pages. Each is a drop-in
replacement of an existing function.

### 4a. Route AI through the proxy (keys leave the browser)
Replace `callAI(backendId, messages)` with:
```js
async function callAI(backendId, messages){
  const {data:{session}} = await sb.auth.getSession();
  if(!session) throw new Error("Sign in first.");
  const r = await fetch("https://nwsqyuucwzihruszocge.supabase.co/functions/v1/ai-proxy",{
    method:"POST",
    headers:{ "Content-Type":"application/json", "Authorization":"Bearer "+session.access_token },
    body: JSON.stringify({ backendId, messages, max_tokens:2500 })
  });
  const j = await r.json();
  if(!r.ok) throw new Error(j.error || ("HTTP "+r.status));
  return j.content;
}
```
After this ships, you can stop storing api_key in the browser-readable path — the key
is only ever read server-side by ai-proxy.

### 4b. Real account deletion (wire the existing "Delete all my content" or add a button)
```js
async function deleteAccountFully(){
  if(!confirm("Permanently delete your entire account, all personas, and sign-in? This cannot be undone."))return;
  const {data:{session}} = await sb.auth.getSession();
  const r = await fetch("https://nwsqyuucwzihruszocge.supabase.co/functions/v1/delete-account",{
    method:"POST",
    headers:{ "Content-Type":"application/json", "Authorization":"Bearer "+session.access_token },
    body: JSON.stringify({ confirm:true })
  });
  const j = await r.json();
  if(!r.ok){ toast(j.error||"Deletion failed"); return; }
  await sb.auth.signOut(); toast("Account deleted"); go("");
}
```

### 4c. Privacy fix — use the RPCs, then run Phase B
Change these three reads, then (and only then) run the `revoke` at the bottom of 006:
```js
// loadMine(): replace  sb.from("personas").select("*").eq("owner",session.user.id)...
const { data: ps } = await sb.rpc("my_personas");

// renderDiscover(): replace the personas select with
const { data: psRaw } = await sb.rpc("discover_personas", { q: q || null, lim: 80 });

// renderPersonaPage(): replace the by-handle select with
const { data: rows } = await sb.rpc("persona_by_handle", { h: handle });
const p = rows && rows[0];
```
Deploy Pages with these, verify the site still loads and your own studio shows your
personas, THEN in SQL Editor run:
```sql
revoke select (owner) on public.personas from anon, authenticated;
```
Now the owner uuid is unreadable by any client and the anonymity promise holds at the API.

### 4d. Realtime notifications (optional, no server needed — pure client)
Add after loadMine() so friend requests appear without reload:
```js
function subscribeNotifs(){
  if(!session || !myPersonas.length) return;
  sb.channel("notifs")
    .on("postgres_changes",
       { event:"INSERT", schema:"public", table:"follows",
         filter:"target=in.("+myPersonas.map(p=>p.id).join(",")+")" },
       () => { loadMine().then(updateBadge); })
    .subscribe();
}
```
(Enable Realtime on the `follows` table in the Supabase dashboard: Database ->
Replication -> add `follows`.)

## What this unblocks on the roadmap
- v0.5 server-side AI proxy (keys off the browser) — ai-proxy
- v0.5 auto-running scheduled tasks -> drafts each morning — run-tasks + cron
- v0.5 comments and reactions — 005
- v0.5 per-persona sitemap — sitemap function
- v0.5 realtime notifications — 4d
- Privacy finding 10 (owner-uuid leak) — 006
- GDPR/CCPA erasure gap — delete-account

## Not runtime-tested here
These functions are authored against the Supabase Edge (Deno) runtime, which isn't
available in my sandbox, so treat the first deploy as the smoke test: deploy, hit each
once (ai-proxy from the app, sitemap in a browser, run-tasks with the cron secret), and
check the function logs. The logic is straightforward and reviewed; I just can't run
Deno here to prove it.
