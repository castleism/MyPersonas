package com.portfolio.guide;

import android.app.Activity;
import android.os.Build;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;

/** Keeps wrapper controls outside system bars, cutouts and the keyboard on API 35+. */
public final class WindowSafety {
    private WindowSafety() {}
    public static void apply(Activity host) {
        if (Build.VERSION.SDK_INT < 35) return;
        ViewGroup content = host.findViewById(android.R.id.content);
        final int left = content.getPaddingLeft(), top = content.getPaddingTop();
        final int right = content.getPaddingRight(), bottom = content.getPaddingBottom();
        content.setOnApplyWindowInsetsListener((view, insets) -> {
            android.graphics.Insets safe = insets.getInsets(WindowInsets.Type.systemBars()
                | WindowInsets.Type.displayCutout() | WindowInsets.Type.ime());
            view.setPadding(left + safe.left, top + safe.top, right + safe.right, bottom + safe.bottom);
            return WindowInsets.CONSUMED;
        });
        content.requestApplyInsets();
    }
}
