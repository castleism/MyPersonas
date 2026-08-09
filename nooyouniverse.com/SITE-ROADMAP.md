# nooyouniverse.com — Site Roadmap

Updated: 2026-08-08 · Owner: Christian · Persona: Cillian O'Sullivan / Noo YouNiverse

Stack (best practice = free here): static single-file site on GitHub Pages + Supabase free tier for the waitlist. $0/month; owner controls everything.

## Status

| Item | State |
|---|---|
| Landing page (`index.html`) | ✅ Built — awaiting owner copy approval |
| Hero/og assets (from approved launch pack) | ✅ Copied to `assets/` |
| CNAME / robots / sitemap | ✅ Built |
| Waitlist backend (`sql-updates/027-noo-waitlist.sql`) | ⬜ Owner must run in Supabase SQL editor |
| GitHub Pages deploy | ⬜ Blocked: one Pages site per repo (this repo already serves mypersonas.online) |
| DNS for nooyouniverse.com | ⬜ No A/AAAA/CNAME records exist (verified 2026-08-08) |
| Form end-to-end test | ⬜ After migration + deploy |

## Deploy steps (owner)

1. **Run the migration:** Supabase dashboard → SQL editor → paste `MyPersonas.Online_v0/sql-updates/027-noo-waitlist.sql` → run. Table is insert-only for the public key; read signups in Table Editor.
2. **Create deploy repo:** GitHub → new public repo `nooyouniverse` → push the contents of this folder (`nooyouniverse.com/`) to its root.
3. **Enable Pages:** repo Settings → Pages → deploy from `main` root. The `CNAME` file sets the custom domain automatically.
4. **DNS at your registrar:**
   - `A` records for apex `nooyouniverse.com` → `185.199.108.153`, `185.199.109.153`, `185.199.110.153`, `185.199.111.153`
   - `CNAME` record `www` → `<your-github-username>.github.io`
   - In Pages settings, enable **Enforce HTTPS** once the certificate issues.
5. **Test:** submit a real email on the live page → expect "You're aboard"; submit again → "already aboard"; confirm the row in Supabase.

## Owner approvals pending

- [ ] Landing page copy (disclosure chip, tagline usage, charter lines, waitlist framing)
- [ ] Use of launch-pack images 01 + 10 on the website (currently approved as launch *reference* assets)
- [ ] Linking privacy/data-deletion to mypersonas.online pages vs. writing site-local ones
- [ ] Social handles listed as text-only "coming online" (links withheld until accounts verified — per master roadmap evidence rules)

## Later phases (aligned to master roadmap)

- **Phase 2 (after launch validation, ~Sep):** Mission Log archive — publish the 10 launch concepts as on-site posts with sources + evidence tiers.
- **Phase 3 (Oct+):** newsletter integration (double opt-in), press/collab kit page, per-post source ledger pages.
- **Phase 4 (product):** Observation Log app waitlist → build diary; requires product, privacy, legal and health review before any capability claims.

## Guardrails baked into the site

- Fictional/AI disclosure in hero chip, footer disclosure block, and meta description.
- No dosing, stacks, product claims, or first-person supplement stories anywhere.
- Evidence-tier legend matches the master roadmap taxonomy exactly.
- Social handles are unlinked text until ownership/health is verified.
- Waitlist collects email only; deletion path linked; 21+ statement included.
