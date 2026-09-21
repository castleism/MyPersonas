#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
app="$root/apps/personas-android"
sdk="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"

if [[ -z "$sdk" || ! -d "$sdk" ]]; then
  echo "Android SDK not found. Set ANDROID_HOME and install platforms;android-34 plus build-tools."
  echo "This script will not invent a fake publisher APK."
  exit 2
fi

printf 'sdk.dir=%s\n' "$sdk" > "$app/local.properties"

if [[ -x "$app/gradlew" ]]; then
  (cd "$app" && ./gradlew :app:assembleDebug --no-daemon)
else
  gradle_bin="$(command -v gradle || true)"
  if [[ -z "$gradle_bin" ]]; then
    echo "Gradle is not on PATH and apps/personas-android/gradlew is missing."
    echo "Install Gradle 8.7+ or open apps/personas-android in Android Studio and assemble the debug variant."
    exit 3
  fi
  (cd "$app" && "$gradle_bin" :app:assembleDebug --no-daemon)
fi

apk="$app/app/build/outputs/apk/debug/app-debug.apk"
if [[ -f "$apk" ]]; then
  echo "Debug APK: $apk"
else
  echo "Gradle finished but $apk was not produced."
  exit 4
fi
