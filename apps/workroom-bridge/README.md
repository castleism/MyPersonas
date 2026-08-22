# AliaSpaces Workroom Bridge

This is the local desktop boundary for durable per-account browser sessions. It is
source scaffolding, not a packaged or signed release.

Each account ledger id maps to a different Electron persistent partition derived
from a random local installation id. Provider passwords are entered only into the
visible provider page and remain in that partition's browser storage. MyPersonas
does not receive or pre-fill them.

The custom protocol accepts only:

```text
aliaspaces-workroom://open?provider=instagram&account_id=<uuid>&persona_id=<uuid>&url=<allowed-https-url>
```

The parser rejects unknown providers, non-UUID identities, credentials in URLs,
custom ports, fragments, non-HTTPS URLs, and initial hosts outside the provider's
finite policy. No prompt text, cookie, password, API key, or local file path belongs
in the protocol URL.

## Local development

1. Run `npm install` in this folder only after reviewing the Electron version and
   lockfile policy.
2. Run `npm run check`.
3. Run `npm start` for a local development window.

Before release, add a lockfile, code signing, installer packaging, update signing,
crash/privacy policy, profile deletion UI, logout/revocation tests, custom-protocol
installation tests, and Windows/macOS security review. The owner PWA keeps its
Siloed window button disabled until that separately approved release exists.
