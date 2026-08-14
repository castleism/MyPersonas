# AliaSpaces PWA integration

The installable shell is complete and wired into `index.html`. The Pages artifact now
includes the manifest, worker, install helper, offline page, and brand icons. This is
**local source state only** until the owner reviews and pushes the release.

## Integrated `index.html` contract

The current head contains this block; keep it intact during future head edits:

```diff
-<link rel="icon" type="image/svg+xml" href="assets/favicon.svg">
+<link rel="icon" href="./brand/app-icon/favicon.ico" sizes="any">
+<link rel="icon" type="image/svg+xml" href="./brand/app-icon/icon.svg">
+<link rel="manifest" href="./manifest.webmanifest">
+<meta name="theme-color" content="#1877f2">
+<meta name="apple-mobile-web-app-capable" content="yes">
+<meta name="apple-mobile-web-app-title" content="AliaSpaces">
+<link rel="apple-touch-icon" sizes="180x180" href="./brand/app-icon/icon-180.png">
+<script src="./pwa.js" defer></script>
```

No body patch is needed. `pwa.js` registers `./service-worker.js` and progressively
adds an accessible **Install app** button to the existing header navigation only when
the browser supplies a real install prompt. On iPhone and iPad it instead exposes an
**Install help** button with the standard Share → Add to Home Screen instruction.

All URLs are document-relative. Do not replace them with root-relative `/...` paths:
the relative form works both at `https://mypersonas.online/` and a GitHub Pages project
path such as `https://owner.github.io/MyPersonas/`.

## Cache and update contract

- The service worker caches only `offline.html`, the manifest/install helper, and the
  public A-home icon files listed in `PUBLIC_SHELL_PATHS`.
- It never stores pages, signed-in HTML, Supabase/API responses, uploaded media, or
  third-party requests. Every document stays network-first; a network failure shows the
  public offline page.
- There is no background sync, post queue, push subscription, or implied notification
  permission. Push remains a separate, unimplemented roadmap item.
- A new worker does not call `skipWaiting()`. It waits for existing AliaSpaces tabs to
  close, avoiding a mid-form code swap. The UI announces when an update is waiting.
- Whenever a cached file changes, bump `CACHE_NAME` in `service-worker.js`. Activation
  deletes only older caches beginning with `aliaspaces-public-shell-`.

## Local and release verification

1. Run `node --test tests/pwa-package.test.mjs` from the repository root.
2. Serve `MyPersonas.Online_v0` through localhost; service workers do not run from a
   `file:` URL.
3. Confirm the browser application panel reports the manifest, 192/512/maskable icons,
   start URL, and service-worker scope under the actual hosted path.
4. Install the app, then take the network offline and navigate. The public offline page
   should appear, with no Supabase or authenticated responses in Cache Storage.
5. Restore the network and use **Try again**. Confirm sign-in and all private data are
   fetched fresh.
6. Change `CACHE_NAME` for an update test. Keep one installed tab open and confirm the
   waiting-update message appears; close all tabs, reopen, and confirm the new worker
   activates.

No production deployment, notification permission, or push subscription is part of this
package.
