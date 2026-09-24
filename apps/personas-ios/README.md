# MyPersonas owner iOS debug path

This is a **thin WKWebView companion** over the real MyPersonas owner command center (`#/owner`).
It is **not** a local social publisher, App Store build, Expo rewrite, or replacement for the canonical platform.

`publishing_enabled` stays **false**. The app never ships OAuth scopes, production secrets, or provider send code.

Linux CI and this cloud checkout **cannot produce an IPA**. Open `Sources/` in Xcode on macOS to assemble a debug build. Do not submit to the App Store from this scaffold.

## What it can do

- Load `https://mypersonas.online/#/owner` when the device is online.
- Show bundled offline limitations when `NWPathMonitor` reports no network, then restore the owner surface when connectivity returns.
- Accept `https://mypersonas.online/#/owner`, `#/feed`, `#/push`, and the other owner hashes. Other hosts and public hashes are ignored.
- Export/import **local prefs only** (the owner origin URL) beside a differently signed install. That file is not a user-data backup of private draft bodies.

## What it cannot do

- Create, approve, or send drafts while offline.
- Post to X, Instagram, Facebook, a website, or any other provider.
- Share app data automatically when the signing team or bundle id changes.
- Use existing owner-desktop phone-test prototypes. Those are local and are **not** in this cloud checkout.
- Produce a store-signed IPA in this Linux environment.

## Reproducible debug build (macOS + Xcode only)

```text
1. Open a new iOS App project in Xcode (iOS 17+, Swift).
2. Add Sources/AppDelegate.swift and Sources/OwnerViewController.swift.
3. Copy Resources/offline-limitations.html into the app bundle.
4. Use Info.plist ATS exceptions only for localhost / 127.0.0.1.
5. Run the debug destination on a simulator or personal device.
```

Store accounts (Apple personal / later submissions) are owner actions. This milestone does not submit, promote, or change App Store permissions.
