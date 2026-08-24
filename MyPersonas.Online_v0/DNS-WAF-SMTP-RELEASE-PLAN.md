# MyPersonas DNS, WAF, CAPTCHA, and transactional-email release plan

Status: **reviewed local plan only**. No DNS record, nameserver, Cloudflare zone,
WAF rule, SMTP credential, sender identity, or paid AWS resource is created by
this document.

## Verified public DNS snapshot — 2026-08-23

Capture a fresh authoritative export immediately before any cutover. The public
snapshot used for this plan currently resolves as follows:

| Name | Record currently observed |
|---|---|
| `mypersonas.online` | GitHub Pages A records: `185.199.108.153` through `185.199.111.153` |
| `www.mypersonas.online` | CNAME `castleism.github.io` |
| `mypersonas.online` MX | priority 10 `smtp.google.com` |
| `mypersonas.online` TXT | Google site verification and `v=spf1 include:_spf.google.com ~all` |
| `mypersonas.online` NS | `ns10.wixdns.net`, `ns11.wixdns.net` |
| `auth.mypersonas.online` | CNAME `nwsqyuucwzihruszocge.supabase.co` |
| `media.mypersonas.online` | no public answer observed |
| `staging.mypersonas.online` | no public answer observed |
| `_dmarc.mypersonas.online` | no TXT answer observed |
| `google._domainkey.mypersonas.online` | no answer observed; this checks only that selector and is not proof that no other DKIM selector exists |

Do not infer the complete Wix zone from public lookups. Export it from Wix and
compare every A, AAAA, CNAME, MX, TXT, CAA, SRV, DKIM selector, verification,
and subdomain record before changing nameservers.

## Protection boundaries

Cloudflare Turnstile can protect MyPersonas forms without moving DNS. The public
site must send the short-lived token and the server or Supabase Auth must verify
it. A widget alone is not a security boundary.

Cloudflare WAF protects only traffic that actually passes through a proxied
Cloudflare zone. The current authoritative nameservers are Wix. Free/Pro full
zone onboarding therefore requires a reviewed nameserver cutover after every DNS
record is mirrored. A partial CNAME setup that leaves Wix authoritative requires
a Business or Enterprise plan and is not the assumed zero-cost path.

The browser currently calls the hosted Supabase project origin directly. A WAF
in front of `mypersonas.online` does not inspect those Auth, REST, Realtime,
Storage, or Edge Function requests. Auth is protected separately by Supabase
rate limits, Turnstile, RLS, AAL2 controls, and bounded function/database
limits. The reviewed AWS media gateway protects `media.mypersonas.online` only;
it is not an application-wide WAF.

## Zero-cost work that can be activated before a DNS move

1. Create one production Turnstile widget restricted to
   `mypersonas.online` and `www.mypersonas.online`; keep pre-clearance off.
2. Put only the public site key in frontend configuration. Enter the secret
   directly into Supabase Auth and the Edge Function secret manager; never put
   it in Git, chat, screenshots, or test evidence.
3. Deploy the frontend CAPTCHA token flow to staging first. Test sign-up,
   password sign-in, magic link/OTP, password recovery, expired/replayed tokens,
   hostname mismatch, browser back/refresh, iOS Safari, and Android Chrome.
4. Configure conservative Supabase Auth limits in staging, then production.
   Treat database and Edge limits as backstops and verify `429` handling.
5. Keep the opaque-media origin lock closed until the reviewed gateway and
   origin secret agree exactly.

The production Pages source intentionally retains an empty Turnstile key. The
protected `github-pages` environment supplies the public
`PRODUCTION_TURNSTILE_SITE_KEY` variable only while packaging. The release
script rejects a missing/malformed key, Cloudflare's published test keys, an
already-mutated source marker, and a staging artifact. It writes only the
prepared artifact; no public key or secret is committed to source.

After the matching staging or production CAPTCHA and SMTP settings are read
back, deploy `request-review` through the separate `public-intake` function
scope. Its exact staging confirmation is
`STAGING-PUBLIC-INTAKE+TURNSTILE+SMTP-VERIFIED`; production additionally requires
WAF evidence and uses `PUBLIC-INTAKE+TURNSTILE+SMTP+WAF-VERIFIED`. The scope
deploys only `request-review` and does not broaden the billing, media, or
maintenance function sets.

Supabase Auth CAPTCHA is a separate provider-side control. In each project,
enable Cloudflare Turnstile under Authentication > Bot and Abuse Protection and
enter the secret directly there. The browser already consumes and resets one
token per signup, password sign-in, and magic-link request. Read the current Auth
rate-limit values before changing them; record a redacted before/after, test the
documented `429` response, and do not enable IP forwarding unless requests are
actually sent through an approved server proxy using a Supabase secret API key.

## Transactional email and SMTP

Supabase's built-in mail service is a development aid, not the production mail
path. Production activation needs a dedicated transactional sender, a verified
sending subdomain, provider credentials entered directly in Supabase, and
delivery evidence.

Recommended separation:

- Auth/security mail: a provider-assigned subdomain such as
  `notify.mypersonas.online`, with a From address such as
  `no-reply@notify.mypersonas.online`.
- Human support: a monitored Google Workspace address on the primary domain.
- Marketing/persona campaigns: a different provider stream and preferably a
  different sending subdomain. Never mix it with Auth reputation.

Provider choice remains an owner decision. AWS SES can use the existing AWS
account but requires identity/DNS verification, sandbox/production review, and
an approved spending ceiling. Resend, Postmark, or another transactional SMTP
provider may be faster to stage. For either path:

1. Provider supplies exact DKIM and verification records; copy them verbatim.
2. Add SPF without creating a second SPF record. Merge mechanisms into the one
   existing record and stay below the DNS-lookup limit.
3. Add DMARC initially in monitoring mode with an owner-controlled aggregate
   report mailbox; inspect results before moving to quarantine/reject.
4. Configure separate staging and production credentials and sender streams.
5. Set low provider and Supabase send rates, bounce/complaint handling, and an
   emergency kill switch.
6. Test confirmation, magic link, recovery, email change, security lock,
   billing receipt, refund, and deletion messages without personal data in
   subjects or logs.

## Cloudflare full-zone cutover checklist

This is a separate production change requiring an exact owner-approved window.

1. Export Wix DNS and record DNSSEC/DS state at the registrar.
2. Add the zone to Cloudflare Free without changing nameservers.
3. Diff the Cloudflare import against the Wix export and the public snapshot.
4. Keep mail, verification, and any provider-control records DNS-only. Review
   GitHub Pages apex/www behavior and Cloudflare SSL mode before proxying web
   records.
5. Lower relevant TTLs at least one prior TTL before the window when supported.
6. Verify Cloudflare Universal SSL is ready, GitHub Pages still owns the custom
   domain, and no redirect loop exists.
7. If DNSSEC is enabled, follow the registrar-safe disable/change/re-enable
   sequence; never leave a stale DS record during a nameserver change.
8. Change nameservers at the registrar only after the diff is clean.
9. Verify apex, `www`, Auth redirects, OAuth callbacks, mail flow, and every
   known subdomain from two independent resolvers and mobile data.
10. Enable the Free Managed Ruleset and one conservative rate-limit rule in
    log/challenge-first mode. Static page requests are not the same as direct
    Supabase API requests.
11. Add hosting response headers only after browser QA: CSP in report-only mode
    before enforcement, `frame-ancestors 'none'`, `X-Content-Type-Options:
    nosniff`, a strict referrer policy, a minimal Permissions Policy, and HSTS
    only after every required HTTPS hostname is verified. The current GitHub
    Pages origin does not provide a repository-level custom-header file, and
    the large inline application needs a separate CSP refactor before
    `unsafe-inline` can be removed honestly.
12. Preserve the Wix export and previous nameservers as rollback evidence. If
    material records or TLS fail, restore the prior nameservers and verify
    recovery before further edits.

## AWS media-gateway cost gate

The checked-in AWS plan has a planning baseline of about USD 11/month plus
usage. Do not create it until the owner supplies both:

- a hard monthly ceiling; and
- an alert threshold and recipient.

Create separate staging and production stacks, certificates, hostnames,
secrets, logs, and budgets. Never reuse the production media-origin secret in
staging.

## Evidence required to call this complete

- Turnstile server verification and replay/hostname failures pass in staging.
- Supabase Auth and application limits return bounded, user-safe errors.
- Two-account desktop, iOS Safari, and Android Chrome privacy tests pass.
- SMTP SPF/DKIM/DMARC alignment and bounce/complaint paths are verified.
- Cloudflare/AWS security events reach a named owner route without secrets or
  raw personal data.
- WAF false-positive rollback is rehearsed.
- DNS and deployment evidence records exact environment, commit, time, and
  result without credential values.
