# MyPersonas owner Android debug path

This is a **thin debug WebView** over the real MyPersonas owner command center (`#/owner`).
It is **not** a local social publisher, Play Store build, or replacement for the canonical platform.

`publishing_enabled` stays **false**. The app never ships OAuth scopes, production secrets, or provider send code.

## What it can do

- Open the live owner surfaces (persona selection, private draft, review/approval, `#/feed`, `#/push`, `#/sites`) when the device is online and the owner can sign in.
- Open **Websites to check** (`#/sites`) and launch non-owner HTTPS portals in the system browser. This is not a publisher.
- Show a disconnected page that explains why private workflow is unavailable offline, then restore `#/owner` when the network returns.
- Accept `https://mypersonas.online/#/owner`, `#/feed`, `#/push`, and the other owner hashes into the same WebView. Other hosts and public hashes are ignored.
- Accept `ACTION_SEND` text as planning-only share intake. It never posts.
- Export/import **local prefs only** (the owner origin URL) so a debug-signed install can sit beside a differently signed install without pretending to migrate user drafts.

## What it cannot do

- Create, approve, or send drafts while offline.
- Post to X, Instagram, Facebook, a website, or any other provider.
- Share Android app data automatically when the signing key changes. Use Export/Import, or keep the installs side by side.
- Use existing owner-desktop phone-test prototypes. Those are local and are **not** in this cloud checkout.

## Reproducible debug build

Requirements: JDK 17+, Android SDK platform 34, and Android build-tools 34.0.0. The committed Gradle wrapper (`./gradlew`, Gradle 8.7) is preferred. A system Gradle 8.7+ binary is only a fallback. The debug shell uses the platform WebView and Activity classes only (no AndroidX / Kotlin stdlib). This is not an Expo/React Native rewrite.

```bash
# from the repository root
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Android/Sdk}"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
./scripts/build-personas-android-debug.sh
```

The script writes a debug APK at `apps/personas-android/app/build/outputs/apk/debug/app-debug.apk` when the SDK is present.
This APK is **debuggable**, unsigned for Play, and must not be submitted to a store. Do not submit to Play.

If the Android SDK is not installed:

1. Install Android command-line tools and accept licenses.
2. Install `platforms;android-34` and `build-tools;34.0.0`.
3. Re-run the script.

Store accounts (Google personal / later submissions) are owner actions. This milestone does not submit, promote, or change Play permissions.

## Save the website as an Android browser app

This checkout cannot install anything on a physical phone. On the owner Android
device, in Chrome:

1. Open `https://mypersonas.online/`.
2. Open the Chrome menu.
3. Choose **Install app** or **Add to Home screen**.
4. After install, open **More → Websites to check** (or `#/sites`) to see owner
   surfaces and HTTPS portals. Other hosts open in Chrome, not inside a fake publisher.

The debug APK is a second, unsigned companion over the same live site. Do not submit it to Play.

## Side-by-side testing when signing differs

Debug and Play signing keys do not share app storage. Keep both installs, or use the in-app **Export local prefs** / **Import local prefs** buttons. That file is not a user-data backup of private draft bodies.

## Local site testing

To point the WebView at a laptop Pages checkout instead of production, write this JSON to the app external-files directory as `owner-mobile-prefs.json` and import it:

```json
{
  "version": "mobile-owner-workflow-export-v1",
  "owner_origin": "http://10.0.2.2:4173/#/owner",
  "publishing_enabled": false
}
```

Cleartext is allowed only for `localhost`, `127.0.0.1`, and the emulator host `10.0.2.2`.
