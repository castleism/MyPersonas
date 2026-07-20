# AliaSpaces / MyPersonas — Setup Guide

Files in this repo:
- **index.html** — the entire app (hosted as a static site)
- **supabase-schema.sql** — the database (run once in Supabase)
- **sql-updates/** — ordered migrations for an existing database
- **../supabase/functions/** — server-side connectors and automation

## Step 1 — Stage the Vault-compatible release

For an existing project, pause the scheduled workers and deploy the new Edge Functions
before migration 011. Their model-key resolver can use the legacy owner-only key column
before migration and the service-only Vault accessor afterward. Deploy the matching
`index.html` before or with the migration; after migration 011, the owner roster and model
operations intentionally require their owner-scoped RPCs instead of broad table reads.

Then run each unapplied file in `sql-updates/` in numeric order. Migration
`011-agent-automation.sql` enables Supabase Vault, moves existing model keys into Vault,
clears the legacy key column, revokes direct browser model writes, and creates the new
agent-control, lease, quota, approval, publishing, and fan-chat data plane. Do not apply it
while an older Edge/client release is the only code available.

The current production project already has migrations 011 and 012. Keep those historical
files unchanged and pause both cron workers before the next release. Apply
`013-fair-generation-queue.sql` before deploying its matching `run-tasks` worker. Migration
013 adds least-recently-served owner rotation, prompt-input bounds, deterministic oversized
input blocking, and the grandfather-safe active-schedule cap. Apply
`014-atomic-persona-save.sql` before publishing the new page; it makes persona, link, and
private-note edits one transaction. Deploy `erase-content` before the new page; the page
checks its versioned content-only capability before enabling erasure.

For a new Supabase project, open **SQL Editor**, paste the entire contents of
`supabase-schema.sql`, and run it. The snapshot includes the base 008–010 account/
connection/Gmail structures plus the immutable 001–012 history and migrations 013–014. There is no
legacy-key transition on a fresh project.

## Step 2 — Wire the app to your project
Dashboard → **Settings → API**:
- **Project URL** (looks like `https://abcdxyz.supabase.co`)
- **anon / public key** (long string starting `eyJ…`)

Paste both into the `CONFIG` block near the top of the `<script>` in `index.html`. These
two values identify the public Supabase client; authorization still comes from row-level
policies and the authenticated Edge Functions. Never put the service-role key there.

## Step 3 — Host it
The current site deploys from this repository through GitHub Pages. A push to the
configured branch starts the Pages workflow; allow for CDN/cache delay before testing
the live copy at `https://mypersonas.online`.

## Step 4 — Tell Supabase your site URL
Supabase → **Authentication → URL Configuration**:
- **Site URL**: `https://mypersonas.online`
- **Redirect URLs**: add `https://mypersonas.online/**`

This configures the allowed return path for magic-link and provider sign-in.

## Step 5 (optional) — Google sign-in to AliaSpaces
1. https://console.cloud.google.com → new project → **APIs & Services → OAuth consent screen** → External.
2. **Credentials → Create OAuth Client ID** → Web application → Authorized redirect URI: `https://YOURPROJECT.supabase.co/auth/v1/callback`.
3. Paste Client ID + Secret into Supabase → Authentication → **Providers → Google** → enable.

This signs a person into AliaSpaces. It does **not** authorize MyPersonas to read a
Gmail inbox.

## Step 6 — Gmail account authorization

For the current deployment, run `sql-updates/009-external-account-connections.sql`
and `sql-updates/010-gmail-oauth.sql`, then configure the isolated Google Cloud
project **MyPersonas Gmail Connector** (`genial-union-503010-q5`):

1. Enable the **Gmail API**.
2. In **Google Auth Platform → Audience**, use External/Testing during development
   and add each mailbox owner you will use during testing as a test user.
3. In **Data Access**, add `openid`, `email`, and
   `https://www.googleapis.com/auth/gmail.readonly`.
4. Use its Web OAuth client
   `373519662305-05bnlabe18i89efnhec9inpt36al7lc6.apps.googleusercontent.com` and add
   this authorized redirect URI:
   `https://nwsqyuucwzihruszocge.supabase.co/functions/v1/gmail-oauth`.
   Keep this client in the isolated Gmail project. Google token revocation can affect
   grants project-wide, so creating another client in the normal site-sign-in project
   is not sufficient; Gmail disconnect/revocation must not disturb AliaSpaces login.
5. Save the OAuth client ID and client secret as Supabase Edge Function secrets named
   `GOOGLE_GMAIL_CLIENT_ID` and `GOOGLE_GMAIL_CLIENT_SECRET`. Never place the secret
   in `index.html` or Git.
6. Deploy the connector:

   ```
   supabase functions deploy gmail-oauth --no-verify-jwt
   ```

After an account is recorded, **Ownership verified** only means its login email matches
the confirmed AliaSpaces sign-in email. Select **Authenticate Gmail** to run Google's
consent flow. The user must choose the exact recorded mailbox and approve read-only
access before the status becomes **API connected**. Passwords are never collected;
the refresh token is encrypted in Supabase Vault and is unavailable to browser code.
Completion is also bound to the same signed-in user and browser tab that started it,
so forwarding a consent link cannot attach someone else's mailbox.

The `gmail.readonly` permission is a restricted Google scope. A Testing app works only
for configured test users. A public production launch requires Google's OAuth app
verification and may require a restricted-scope security assessment.

## Step 7 — Agent control center and schedules

Follow the staged order in `../supabase/DEPLOY.md`: pause both workers; deploy `ai-proxy`,
`post-bridge`, `run-publish-queue`, `fan-chat`, and `gmail-oauth`; apply every pending
migration through 014; deploy `run-tasks`, `delete-account`, and the JWT-verified
`erase-content`; publish the page; probe both workers; then schedule them every five
minutes. Set `CRON_SECRET` and `FAN_CHAT_SALT` before probing.
`SCHEDULE_AI_HOSTS` and `FAN_CHAT_AI_HOSTS` are separate optional hostname allowlists for
custom scheduled-generation and public fan-chat model endpoints. A custom hostname also
needs the separate matching confirmation in Matrix; confirming schedules never confirms
fan chat.

Store the same `CRON_SECRET` value twice: once as the Edge Function secret and once in
Supabase Vault named `mypersonas_cron_secret`. The cron jobs read the Vault copy at runtime,
so the stored job definition contains no credential.

After deployment, the owner configures each persona in Matrix:

1. **Direction** — goal, success measure, audience, content pillars, campaign, calls to
   action, offers/approved links, affiliate disclosure, source notes, and platform rules.
2. **Safety** — global pause, persona status, autonomy level L0–L3, daily model-call and
   publishing limits, quiet hours, and optional disclosed fan chat.
3. **Targets** — native AliaSpaces plus persona-assigned account-ledger rows. A recorded,
   ownership-verified, or read-only-connected external account is still not write-enabled.
4. **Schedule** — daily/weekly day, local time, time zone, preparation lead time, content
   type, model, instructions, and approval requirement.
5. **Queue** — edit, approve the exact draft, reject, publish native content now, or record
   an externally posted draft as manual.

Scheduled generation claims each task with a UUID lease and atomically reserves one daily
model-call unit before contacting the provider. This prevents overlapping cron runs from
duplicating paid calls or exceeding the configured cap. It creates drafts only and never
approves its own output.

Editing an approved draft clears its exact approval and removes it from the publish queue.
At L2, approval waits for the owner to press **Publish now**. At L3, only an exact-approved
native draft on an enabled `auto` target may publish when due. The native bridge rechecks
binding, pause, autonomy, target mode, hash, quiet hours, and daily caps in one database
transaction.

Fan chat atomically reserves the visitor/persona quota, session, saved message, audit row,
and response lease before a model call. It is unavailable for NSFW personas until
AliaSpaces has server-verifiable age assurance; the current client-side 18+ prompt is not
enough for a public AI endpoint. Escalated transcripts are flagged for owner review only—
they do not promise an owner reply or live takeover.

## Implemented in this repository vs. still gated

**Implemented in the repository:** sign-in, anonymous multi-persona pages, private
account ledger, distinct ownership/API states, read-only Gmail OAuth, persona direction,
server-side AI proxy, Vault-backed model keys, precise scheduled draft generation with
atomic call reservations, approval queue, native AliaSpaces publishing, global/persona
pauses, caps and quiet hours, audit history, synchronized owner chat, and optional
disclosed SFW fan chat with an owner-review inbox. These items still require the migration,
function, cron, and Pages deployment described above; this guide does not claim that live
rollout or browser QA has completed.

**Content erasure:** the Matrix security area uses the versioned `erase-content` endpoint,
which can retain the Supabase sign-in while removing owned personas, pages, posts, media,
account records, drafts/tasks, model connections, automation/chat history, display name,
and preferences. It refuses to run unless the server reports the immutable content-only
contract. Gmail is revoked first. Any OpenRouter connection—legacy, pasted, or OAuth—also
requires the owner to revoke its provider-side key before acknowledging local erasure.

**Still gated:** direct posting to Instagram, Facebook, TikTok, X, YouTube, LinkedIn, or
any other external service. No external write connector is implemented. Each provider
needs its own official API integration, write scopes, app review where required, verified
account assignment, reconciliation, and provider-specific testing. Gmail read-only access
does not authorize social posting. Native live streaming is also still an embed; a future
release can add Cloudflare Stream or Mux.

## Honest notes
- **Watermarks**: uploaded images get the page URL burned into pixels (tiled + corner tag); right-click/drag is blocked. Screenshots can't be prevented — treat watermarks as attribution + deterrence.
- **Adult content**: keep the 18+ page gate on NSFW personas and check the host's
  acceptable-use terms. Fan chat remains server-disabled for NSFW personas until a
  server-verifiable age-assurance system exists.
- **AI keys** are accepted through `create_ai_backend`, encrypted in Supabase Vault, and
  retrievable only through a service-role RPC. Browser create/update/delete operations use
  owner-authenticated RPCs and cannot read a saved key back. Never store passwords in
  private notes.
- **Gmail credentials** are not stored in the account ledger. OAuth refresh tokens are
  encrypted in Supabase Vault and only the server-side connector can retrieve them.
