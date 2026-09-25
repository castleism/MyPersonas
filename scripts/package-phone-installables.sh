#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
export ANDROID_HOME="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Android/Sdk}}"
export ANDROID_SDK_ROOT="$ANDROID_HOME"

if [[ ! -d "$ANDROID_HOME/platforms/android-34" ]]; then
  echo "Android SDK platform 34 is not installed at $ANDROID_HOME."
  echo "This script will not invent a fake publisher APK."
  exit 2
fi

"$root/scripts/build-personas-android-debug.sh"
apk="$root/apps/personas-android/app/build/outputs/apk/debug/app-debug.apk"
if [[ -n "${PHONE_ARTIFACT_DIR:-}" && -f "$apk" ]]; then
  mkdir -p "$PHONE_ARTIFACT_DIR"
  cp "$apk" "$PHONE_ARTIFACT_DIR/mypersonas_owner_debug.apk"
  echo "Copied debug APK to $PHONE_ARTIFACT_DIR/mypersonas_owner_debug.apk"
fi

echo "This environment cannot adb-install onto a physical phone unless a device is connected."
adb devices 2>/dev/null || true
