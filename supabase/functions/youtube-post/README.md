# YouTube exact-approved video publisher

`youtube-post` uploads an owned generic draft only after two approvals match:

1. the generic draft's canonical content/target/schedule approval with a current
   `platform-preview-v1` receipt bound to the connected channel ID; and
2. `youtube-preview-v1`, which binds the rendered platform preview to the exact
   channel ID, verified video bytes, title, description, fixed People & Blogs
   category (`22`), audience choice, altered/synthetic-media disclosure,
   privacy, and schedule.

Any edit clears or invalidates the YouTube receipt. The release does not support
YouTube Community posts because the official Data API has no Community-post
creation endpoint.

The first private proof uses category `22` (People & Blogs). That value is
server-selected, displayed in the platform preview, stored in the approval
receipt, included in its hash, sent as `snippet.categoryId`, and checked again
when YouTube returns the uploaded video resource. The browser cannot substitute
a different category after approval.

## Private-first verification

Use `privacyStatus: "private"` for connector verification. Google notes that
uploads from unverified API projects created after July 28, 2020 are restricted
to private viewing until the project passes its audit. The publisher does not
request a delete scope merely to clean up tests; every successful response
returns the exact YouTube Studio edit URL for manual review or deletion.

The current safe media contract accepts a provenance-ledgered, owner-scoped MP4
or WebM asset already stored in `persona-media`, up to the repository's verified
media ceiling of 15 MiB. It re-downloads and verifies MIME, byte size, and SHA-256
immediately before the provider call. Raising that ceiling requires a separately
reviewed chunk-verifying video ingest path, not a constant change.

## Owner API

```json
{
  "action": "preview-draft",
  "draftId": "<owned YouTube draft UUID>",
  "videoAssetId": "<verified media asset UUID>",
  "madeForKids": false,
  "containsSyntheticMedia": true,
  "privacyStatus": "private"
}
{
  "action": "approve-preview",
  "draftId": "<same draft UUID>",
  "videoAssetId": "<same asset UUID>",
  "madeForKids": false,
  "containsSyntheticMedia": true,
  "privacyStatus": "private"
}
{ "action": "publish-draft", "draftId": "<same draft UUID>" }
{ "action": "verify-processing", "draftId": "<same draft UUID>" }
```

## Failure and reconciliation contract

- The resumable session URI is stored in Vault before any video bytes are sent.
- A timeout or 5xx after bytes are sent triggers Google's upload-status query.
- A confirmed `308 Resume Incomplete` records the exact accepted byte offset and
  can resume the same session; it never creates a second upload session.
- An unconfirmed outcome remains `publishing` and reconciliation-locked.
- The 11-character video ID is checkpointed before the generic draft reaches
  `published`.
- `verify-processing` checks that the video belongs to the approved channel and
  records `processing`, `succeeded`, `failed`, or `terminated`.

Official references:

- <https://developers.google.com/youtube/v3/docs/videos/insert>
- <https://developers.google.com/youtube/v3/guides/using_resumable_upload_protocol>
- <https://developers.google.com/youtube/v3/docs/videos/list>
- <https://developers.google.com/youtube/v3/docs/videos>
