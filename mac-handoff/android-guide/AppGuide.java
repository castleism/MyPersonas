package com.portfolio.guide;

import android.app.Activity;
import android.content.Intent;
import android.content.pm.ShortcutInfo;
import android.content.pm.ShortcutManager;
import android.graphics.drawable.Icon;
import android.os.Build;
import java.util.Collections;

/** Offline help only: no accounts, permissions, network or user-data writes. */
public final class AppGuide {
    public static final String PREFS = "portfolio_app_guide_v1";
    static boolean presenting;
    private AppGuide() {}
    public static void install(Activity host) {
        if (Build.VERSION.SDK_INT >= 25) {
            try {
                Intent replay = new Intent(host, GuideActivity.class).setAction(Intent.ACTION_VIEW);
                ShortcutInfo shortcut = new ShortcutInfo.Builder(host, "app-guide")
                    .setShortLabel("App guide").setLongLabel("Replay the app walkthrough")
                    .setIcon(Icon.createWithResource(host, android.R.drawable.ic_menu_help))
                    .setIntent(replay).build();
                host.getSystemService(ShortcutManager.class).addDynamicShortcuts(Collections.singletonList(shortcut));
            } catch (RuntimeException ignored) { /* Launcher shortcut support is optional. */ }
        }
        if (!presenting && !host.getSharedPreferences(PREFS, 0).getBoolean("completed", false)) {
            presenting = true;
            host.startActivity(new Intent(host, GuideActivity.class));
        }
    }
}
