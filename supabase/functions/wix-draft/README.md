# Wix Blog draft-only proof

`wix-draft` can create, reconcile, verify, and move to Trash one Wix Blog
provider draft. There is no publish endpoint and no schedule endpoint.

## Required gate

`create-draft` fails closed unless migration 069 proves that the owner approved
the current `platform-preview-v1` rendition for the exact connected
`wix:<siteId>:<memberId>` target. The current draft must still have the same
owner, persona, account, platform, title, body, tags, content kind, media state,
and planned time. This first proof is text-only; any media URL blocks it.

The function audits before the provider call, sends `publish: false`, then reads
the provider object back and verifies the exact site header, author member ID,
title, rich text, and `UNPUBLISHED` state. It records Wix's URL-preview field and
the Wix Blog dashboard link without representing either as publication.

## Owner API

```json
{ "action": "create-draft", "draftId": "<approved MyPersonas draft UUID>" }
{ "action": "reconcile", "draftId": "<same draft UUID>" }
{ "action": "verify-draft", "draftId": "<same draft UUID>" }
{ "action": "delete-draft", "draftId": "<same draft UUID>", "confirmDelete": true, "expectedProviderDraftId": "<visible provider ID>", "expectedTargetId": "<exact wix:site:member target>" }
{ "action": "finalize-trash-checkpoint", "draftId": "<same draft UUID>", "confirmProviderTrash": true, "expectedProviderDraftId": "<visually verified provider ID>", "expectedTargetId": "<exact wix:site:member target>" }
```

An HTTP 202 or `reconciliationRequired` response means **do not retry
`create-draft`**. Use `reconcile`; it reads the exact site and accepts only one
matching draft. Delete uses Wix's reversible trash behavior, never permanent
deletion. Active provider drafts block credential disconnect and local-draft
deletion so the audit link cannot be orphaned.

Reconciliation accepts only a complete Wix result page with valid total-count
metadata. Provider Trash is durably claimed before DELETE, so an uncertain
response cannot be retried. If only the final local checkpoint failed, the UI
requires the owner to inspect Wix Trash and exactly re-confirm the provider ID
and target; `finalize-trash-checkpoint` then changes local state only.

The non-secret `WIX_APP_ID` is an Edge Function setting. The Wix app secret is
read only from Supabase Vault name `wix_app_secret`; the instance ID is read
only from the ledger-specific Vault credential.

Official references:

- <https://dev.wix.com/docs/api-reference/business-solutions/blog/skills/how-to-create-blog-posts>
- <https://dev.wix.com/docs/api-reference/business-solutions/blog/draft-posts/create-draft-post>
- <https://dev.wix.com/docs/api-reference/business-solutions/blog/draft-posts/get-draft-post>
- <https://dev.wix.com/docs/api-reference/business-solutions/blog/draft-posts/delete-draft-post>
