package online.mypersonas.owner;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.ConnectivityManager;
import android.net.NetworkCapabilities;
import android.os.Bundle;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import androidx.annotation.Nullable;
import androidx.appcompat.app.AppCompatActivity;

import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;

/**
 * Debug WebView over the real MyPersonas owner command center.
 * This is not a social publisher. publishing_enabled stays false.
 */
public class OwnerActivity extends AppCompatActivity {
    static final String PREFS = "owner_mobile_prefs";
    static final String KEY_ORIGIN = "owner_origin";
    static final String EXPORT_VERSION = "mobile-owner-workflow-export-v1";

    WebView web;

    @Override
    protected void onCreate(@Nullable Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_owner);
        web = findViewById(R.id.ownerWeb);
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return false;
            }
        });
        findViewById(R.id.exportPrefs).setOnClickListener(v -> exportPrefs());
        findViewById(R.id.importPrefs).setOnClickListener(v -> importPrefs());
        loadOwnerSurface();
    }

    String origin() {
        return getSharedPreferences(PREFS, MODE_PRIVATE)
            .getString(KEY_ORIGIN, BuildConfig.DEFAULT_OWNER_ORIGIN);
    }

    boolean online() {
        ConnectivityManager manager = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
        if (manager == null) return false;
        NetworkCapabilities caps = manager.getNetworkCapabilities(manager.getActiveNetwork());
        return caps != null && (
            caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)
                || caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR)
                || caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)
        );
    }

    void loadOwnerSurface() {
        if (!online()) {
            web.loadUrl("file:///android_asset/offline-limitations.html");
            return;
        }
        web.loadUrl(origin());
    }

    void exportPrefs() {
        try {
            JSONObject bundle = new JSONObject();
            bundle.put("version", EXPORT_VERSION);
            bundle.put("owner_origin", origin());
            bundle.put("publishing_enabled", false);
            bundle.put("note", "Local debug prefs only. Does not include private draft bodies or secrets.");
            File out = new File(getExternalFilesDir(null), "owner-mobile-prefs.json");
            try (FileOutputStream stream = new FileOutputStream(out)) {
                stream.write(bundle.toString(2).getBytes(StandardCharsets.UTF_8));
            }
            Toast.makeText(this, "Exported " + out.getAbsolutePath(), Toast.LENGTH_LONG).show();
        } catch (Exception error) {
            Toast.makeText(this, "Export failed: " + error.getMessage(), Toast.LENGTH_LONG).show();
        }
    }

    void importPrefs() {
        File in = new File(getExternalFilesDir(null), "owner-mobile-prefs.json");
        try (FileInputStream stream = new FileInputStream(in)) {
            byte[] raw = new byte[(int) in.length()];
            int read = stream.read(raw);
            JSONObject bundle = new JSONObject(new String(raw, 0, Math.max(read, 0), StandardCharsets.UTF_8));
            if (!EXPORT_VERSION.equals(bundle.optString("version"))) {
                throw new IllegalStateException("Unrecognized export version");
            }
            if (bundle.optBoolean("publishing_enabled", false)) {
                throw new IllegalStateException("publishing_enabled must remain false");
            }
            SharedPreferences.Editor editor = getSharedPreferences(PREFS, MODE_PRIVATE).edit();
            editor.putString(KEY_ORIGIN, bundle.optString("owner_origin", BuildConfig.DEFAULT_OWNER_ORIGIN));
            editor.apply();
            Toast.makeText(this, "Imported local prefs. Reload to apply.", Toast.LENGTH_LONG).show();
            loadOwnerSurface();
        } catch (Exception error) {
            Toast.makeText(this, "Import failed: " + error.getMessage(), Toast.LENGTH_LONG).show();
        }
    }
}
