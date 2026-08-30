# WordPress draft-only proof

`wordpress-draft` creates, reconciles, verifies, and moves to Trash a WordPress
post with `status: "draft"`. It has no Private, Publish, or Schedule action.

## Required gate and readback

Migration 069 must prove a current owner-approved `platform-preview-v1` for the
exact connected site/author target. The draft's owner, persona, account,
platform, content, planned time, and text-only media state are checked again
after the durable attempt claim and before the provider call.

The provider request fixes the exact author, closes comments and pings, and
HTML-escapes the approved plain text. Readback uses `context=edit` and must match
the raw title, raw content, author, and `draft` status before the provider ID,
preview URL, and edit URL are returned to the owner.

## Owner API

```json
{ "action": "create-draft", "draftId": "<approved MyPersonas draft UUID>" }
{ "action": "reconcile", "draftId": "<same draft UUID>" }
{ "action": "verify-draft", "draftId": "<same draft UUID>" }
{ "action": "delete-draft", "draftId": "<same draft UUID>", "confirmDelete": true, "expectedProviderDraftId": "<visible provider ID>", "expectedTargetId": "<exact WordPress site/author target>" }
{ "action": "finalize-trash-checkpoint", "draftId": "<same draft UUID>", "confirmProviderTrash": true, "expectedProviderDraftId": "<visually verified provider ID>", "expectedTargetId": "<exact WordPress site/author target>" }
```

An uncertain result is durably locked. Do not retry creation; `reconcile`
searches only the exact author, draft state, time window, title, and raw content
and accepts exactly one match. Delete is reversible (`force=false`) and updates
the checkpoint to Trash. The local source draft and active credential cannot be
deleted while a provider draft remains active.

Reconciliation requires WordPress's numeric `X-WP-Total` evidence and one
complete page. Trash is durably claimed before provider DELETE, preventing any
duplicate after an uncertain result. A final local checkpoint can be recovered
only after the owner visually verifies the exact item in WordPress Trash;
`finalize-trash-checkpoint` performs no provider request.

Self-hosted calls retain the public-HTTPS/no-redirect address guard for every
request. WordPress.com access tokens and self-hosted Application Passwords are
loaded only from the ledger-specific Supabase Vault credential.

Official references:

- <https://developer.wordpress.com/docs/api/getting-started/>
- <https://developer.wordpress.org/rest-api/reference/posts/#create-a-post>
- <https://developer.wordpress.org/rest-api/reference/posts/#retrieve-a-post>
- <https://developer.wordpress.org/rest-api/reference/posts/#delete-a-post>
