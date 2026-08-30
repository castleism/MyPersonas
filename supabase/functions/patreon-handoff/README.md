# Patreon native-editor handoff

Patreon's public API exposes campaign and post reads but no ordinary creator
post creation or scheduling endpoint. This function therefore creates an
immutable, previewed copy package for owner completion in Patreon itself. It
does not scrape Patreon or automate a browser.

The owner sees the exact campaign, title, body, tags, media link, audience,
publish mode, and schedule time before preparing the handoff. The package is
bound to the migration-069 exact campaign preview, the current approved content
hash, current assignment/pause state, and a `patreon-native-preview-v1` receipt.

The direct editor convenience link is `https://www.patreon.com/posts/new`. If it
does not open the intended campaign, use Patreon's **Create > Post** menu. The
owner must review Patreon's own final preview and choose Save, Publish, or
Schedule. Completion recorded in MyPersonas is owner-attested, not API-verified.

Official help: [Posting to Patreon](https://support.patreon.com/hc/en-us/articles/115004048046-Posting-to-your-Patreon)
and [Scheduled posts](https://support.patreon.com/hc/en-us/articles/360031956632-Scheduled-posts).
