# MyPersonas owner Expo debug path

This is a **thin Expo WebView companion** over the real MyPersonas owner command center (`#/owner`).
It is **not** a local social publisher, store build, or replacement for the canonical platform.

`publishing_enabled` stays **false**. The app never ships OAuth scopes, production secrets, or provider send code.

Linux CI and this cloud checkout **cannot produce an IPA or Play AAB**. Use Expo Go or a local EAS debug build on the owner's machine. Do not submit to a store from this scaffold.

## What it can do

- Load `https://mypersonas.online/#/owner` when online, or `#/feed` / `#/push` / `#/sites` when a matching owner deep link opens the shell.
- Show bundled offline limitations when the NetInfo listener reports no network, then restore the owner surface.
- Reload the allowed owner URL when the owner taps Reload while online.
- Reuse the same local-prefs export version as Android/iOS (`mobile-owner-workflow-export-v1`).

## What it cannot do

- Create, approve, or send drafts while offline.
- Post to X, Instagram, Facebook, a website, or any other provider.
- Request push permission or deliver APNs/FCM.
- Replace the web command center with a fake feed publisher.
- Produce a store-signed binary in this Linux environment.

## Reproducible debug start (owner machine)

```bash
cd apps/personas-expo
npx expo start
```

Point Expo Go at the project. Store accounts remain owner actions.
