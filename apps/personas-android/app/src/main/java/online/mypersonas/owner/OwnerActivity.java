package online.mypersonas.owner;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;

/**
 * Debug WebView over the real MyPersonas owner command center.
 * This is not a social publisher. publishing_enabled stays false.
 */
public class OwnerActivity extends Activity {
    static final String PREFS = "owner_mobile_prefs";
    static final String KEY_ORIGIN = "owner_origin";
    static final String EXPORT_VERSION = "mobile-owner-workflow-export-v1";
    static final String OFFLINE_URL = "file:///android_asset/offline-limitations.html";
    static final String[] OWNER_SURFACES = {
        "owner", "feed", "push", "sites", "briefs", "schedule", "activity", "notifications"
    };

    WebView web;
    ConnectivityManager.NetworkCallback networkCallback;
    boolean showingOffline;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
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
                if (request == null || request.getUrl() == null) return true;
                String url = request.getUrl().toString();
                if (allowedOwnerUrl(url)) return false;
                openExternalHttps(url);
                return true;
            }
        });
        findViewById(R.id.exportPrefs).setOnClickListener(v -> exportPrefs());
        findViewById(R.id.importPrefs).setOnClickListener(v -> importPrefs());
        findViewById(R.id.reloadOwner).setOnClickListener(v -> loadOwnerSurface(null));
        findViewById(R.id.openSites).setOnClickListener(v -> loadOwnerSurface(sitesOrigin()));
        applyIntent(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        applyIntent(intent);
    }

    @Override
    protected void onStart() {
        super.onStart();
        registerNetwork();
    }

    @Override
    protected void onStop() {
        unregisterNetwork();
        super.onStop();
    }

    String origin() {
        return getSharedPreferences(PREFS, MODE_PRIVATE)
            .getString(KEY_ORIGIN, BuildConfig.DEFAULT_OWNER_ORIGIN);
    }

    boolean allowedOwnerUrl(String url) {
        if (url == null || url.isEmpty()) return false;
        Uri uri = Uri.parse(url);
        if (uri == null) return false;
        String host = uri.getHost();
        String scheme = uri.getScheme();
        boolean local = "localhost".equals(host) || "127.0.0.1".equals(host) || "10.0.2.2".equals(host);
        boolean live = "mypersonas.online".equals(host);
        if (!local && !live) return false;
        if ("https".equals(scheme)) {
            // live or local TLS
        } else if ("http".equals(scheme) && local) {
            // emulator / laptop Pages only
        } else {
            return false;
        }
        String path = uri.getPath();
        if (path != null && !path.isEmpty() && !"/".equals(path)) return false;
        String fragment = uri.getFragment();
        if (fragment == null || fragment.isEmpty()) return true;
        String route = fragment.startsWith("/") ? fragment.substring(1) : fragment;
        int slash = route.indexOf('/');
        if (slash > 0) route = route.substring(0, slash);
        int query = route.indexOf('?');
        if (query > 0) route = route.substring(0, query);
        for (String surface : OWNER_SURFACES) {
            if (surface.equals(route)) return true;
        }
        return false;
    }

    String sitesOrigin() {
        String current = origin();
        if (current.contains("#")) current = current.substring(0, current.indexOf('#'));
        if (current.endsWith("/")) current = current.substring(0, current.length() - 1);
        String target = current + "/#/sites";
        return allowedOwnerUrl(target) ? target : "https://mypersonas.online/#/sites";
    }

    boolean openExternalHttps(String url) {
        if (url == null || !url.startsWith("https://")) return false;
        Uri uri = Uri.parse(url);
        if (uri == null || uri.getHost() == null) return false;
        try {
            Intent intent = new Intent(Intent.ACTION_VIEW, uri);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(intent);
            Toast.makeText(this, "Opened in the system browser. publishing_enabled=false.", Toast.LENGTH_SHORT).show();
            return true;
        } catch (RuntimeException error) {
            Toast.makeText(this, "Could not open that HTTPS site.", Toast.LENGTH_LONG).show();
            return false;
        }
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

    void applyIntent(Intent intent) {
        String deepLink = null;
        if (intent != null && Intent.ACTION_VIEW.equals(intent.getAction()) && intent.getData() != null) {
            String url = intent.getData().toString();
            if (allowedOwnerUrl(url)) deepLink = url;
        } else if (intent != null && Intent.ACTION_SEND.equals(intent.getAction())) {
            String shared = intent.getStringExtra(Intent.EXTRA_TEXT);
            if (allowedOwnerUrl(shared)) deepLink = shared;
            Toast.makeText(this, "Share intake is planning-only. publishing_enabled=false.", Toast.LENGTH_LONG).show();
        }
        loadOwnerSurface(deepLink);
    }

    void loadOwnerSurface(String overrideUrl) {
        if (!online()) {
            showingOffline = true;
            web.loadUrl(OFFLINE_URL);
            return;
        }
        String target = overrideUrl != null && allowedOwnerUrl(overrideUrl) ? overrideUrl : origin();
        if (!allowedOwnerUrl(target)) target = BuildConfig.DEFAULT_OWNER_ORIGIN;
        showingOffline = false;
        web.loadUrl(target);
    }

    void registerNetwork() {
        ConnectivityManager manager = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
        if (manager == null || networkCallback != null) return;
        networkCallback = new ConnectivityManager.NetworkCallback() {
            @Override
            public void onAvailable(Network network) {
                runOnUiThread(() -> {
                    if (showingOffline) loadOwnerSurface(null);
                });
            }

            @Override
            public void onLost(Network network) {
                runOnUiThread(() -> {
                    if (!online()) {
                        showingOffline = true;
                        web.loadUrl(OFFLINE_URL);
                    }
                });
            }
        };
        manager.registerDefaultNetworkCallback(networkCallback);
    }

    void unregisterNetwork() {
        ConnectivityManager manager = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
        if (manager != null && networkCallback != null) {
            try { manager.unregisterNetworkCallback(networkCallback); } catch (RuntimeException ignored) {}
        }
        networkCallback = null;
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
            String importedOrigin = bundle.optString("owner_origin", BuildConfig.DEFAULT_OWNER_ORIGIN);
            if (!allowedOwnerUrl(importedOrigin)) {
                throw new IllegalStateException("Import origin is not an allowed owner URL");
            }
            SharedPreferences.Editor editor = getSharedPreferences(PREFS, MODE_PRIVATE).edit();
            editor.putString(KEY_ORIGIN, importedOrigin);
            editor.apply();
            Toast.makeText(this, "Imported local prefs. Reloading.", Toast.LENGTH_LONG).show();
            loadOwnerSurface(null);
        } catch (Exception error) {
            Toast.makeText(this, "Import failed: " + error.getMessage(), Toast.LENGTH_LONG).show();
        }
    }
}
