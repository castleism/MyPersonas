# Phone sideload — debug APK and browser apps

This checkout **cannot reach a physical Android phone**. There is no USB/adb
device here. Sideload and Chrome install stay owner-device actions.

`publishing_enabled` stays **false**. These installs do not post and do not
request notification permission.

## 1. Debug owner APK

When the Android SDK is present:

```bash
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Android/Sdk}"
./scripts/package-phone-installables.sh
```

Install the resulting
`apps/personas-android/app/build/outputs/apk/debug/app-debug.apk` with:

```bash
adb install -r apps/personas-android/app/build/outputs/apk/debug/app-debug.apk
```

Or copy the APK to the phone and open it. Allow install from that source.
This APK is **debuggable** and must not be submitted to Play.

## 2. Save the websites as Android browser apps

In Chrome on the phone:

1. Open `https://mypersonas.online/` → menu → **Install app** or **Add to Home screen**.
2. Open `https://nooyouniverse.com/` → menu → **Install app** or **Add to Home screen**.
3. After the MyPersonas install, sign in and open **More → Websites to check**.

The Noo YouNiverse PWA is public-only. It is source-complete in this checkout
and still needs the owner Cloudflare deploy before the live domain serves it.
