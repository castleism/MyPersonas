import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const android = path.join(root, "apps/personas-android");
const read = (relative) => readFile(path.join(root, relative), "utf8");

test("Android companion wraps the real owner command center and documents offline limits", async () => {
  const [manifest, activity, offline, readme, build] = await Promise.all([
    read("apps/personas-android/app/src/main/AndroidManifest.xml"),
    read("apps/personas-android/app/src/main/java/online/mypersonas/owner/OwnerActivity.java"),
    read("apps/personas-android/app/src/main/assets/offline-limitations.html"),
    read("apps/personas-android/README.md"),
    read("apps/personas-android/app/build.gradle"),
  ]);
  await access(path.join(android, "settings.gradle"));
  await access(path.join(android, "gradlew"));
  await access(path.join(android, "gradle/wrapper/gradle-wrapper.properties"));
  assert.match(manifest, /android:name="online\.mypersonas\.owner\.OwnerActivity"/);
  assert.match(build, /mypersonas\.online\/#\/owner/);
  assert.match(activity, /offline-limitations\.html/);
  assert.match(activity, /BuildConfig\.DEFAULT_OWNER_ORIGIN/);
  assert.match(activity, /NetworkCallback/);
  assert.match(activity, /allowedOwnerUrl/);
  assert.match(activity, /onNewIntent/);
  assert.match(activity, /OWNER_SURFACES/);
  assert.match(activity, /ACTION_SEND/);
  assert.match(manifest, /android:host="mypersonas\.online"/);
  assert.match(manifest, /android.intent.action.SEND/);
  assert.match(offline, /Private feed/);
  assert.match(offline, /planning-only/);
  assert.match(activity, /reloadOwner/);
  assert.doesNotMatch(activity, /twitter\.com\/i\/api|graph\.facebook\.com|oauth|client_secret|SUPABASE_SERVICE/i);
  assert.match(offline, /publishing_enabled=false/);
  assert.match(offline, /cannot create, approve, or send/i);
  assert.match(readme, /debug APK/);
  assert.match(readme, /signing differs/);
  assert.match(readme, /Do not submit to Play/);
  assert.doesNotMatch(build, /storePassword|signingConfig\.storeFile|PLAY_STORE/);
  assert.match(build, /debuggable true/);
});
