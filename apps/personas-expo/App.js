import { useEffect, useState } from "react";
import { Button, Linking, SafeAreaView, Text, View } from "react-native";
import NetInfo from "@react-native-community/netinfo";
import { WebView } from "react-native-webview";

const DEFAULT_ORIGIN = "https://mypersonas.online/#/owner";
const EXPORT_VERSION = "mobile-owner-workflow-export-v1";
const OWNER_SURFACES = ["owner", "feed", "push", "briefs", "schedule", "activity", "notifications"];

function allowedOwnerUrl(url) {
  if (typeof url !== "string") return false;
  try {
    const parsed = new URL(url);
    const host = parsed.hostname;
    const local = host === "localhost" || host === "127.0.0.1";
    const live = host === "mypersonas.online";
    if (!local && !live) return false;
    if (parsed.protocol === "https:") {
      // live or local TLS
    } else if (parsed.protocol === "http:" && local) {
      // laptop Pages only
    } else {
      return false;
    }
    const path = parsed.pathname || "/";
    if (path !== "/" && path !== "") return false;
    const route = decodeURIComponent(parsed.hash || "").replace(/^#\/?/, "").split(/[/?#]/)[0];
    return !route || OWNER_SURFACES.includes(route);
  } catch {
    return false;
  }
}

const OFFLINE_HTML = `<!doctype html><html><body style="font-family:sans-serif;padding:24px;color:#10213b">
<div style="background:#fff7e6;border:1px solid #f2dfb4;padding:14px;border-radius:12px">
<h1>Disconnected from MyPersonas</h1>
<p><strong>publishing_enabled=false.</strong> This Expo debug shell is a thin WebView over the real owner command center. It is not a local social publisher.</p>
<p>While offline this shell cannot create, approve, or send drafts. Private feed (#/feed) and the push ledger (#/push) also need a live session. Share intake is planning-only and never posts. Reconnect, then reload.</p>
</div></body></html>`;

export default function App() {
  const [online, setOnline] = useState(true);
  const [origin, setOrigin] = useState(DEFAULT_ORIGIN);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const applyUrl = (url) => {
      if (allowedOwnerUrl(url)) setOrigin(url);
    };
    const net = NetInfo.addEventListener((state) => {
      setOnline(state.isConnected !== false && state.isInternetReachable !== false);
    });
    const linking = Linking.addEventListener("url", (event) => applyUrl(event.url));
    Linking.getInitialURL().then(applyUrl);
    return () => {
      net();
      linking.remove();
    };
  }, []);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: "#fff" }}>
      <View style={{ padding: 8, gap: 8 }}>
        <Text>MyPersonas Owner (debug) · publishing_enabled=false · export {EXPORT_VERSION}</Text>
        <Button title="Reload when online" onPress={() => {
          if (online && allowedOwnerUrl(origin)) setReloadKey((value) => value + 1);
        }} />
      </View>
      <WebView
        key={reloadKey}
        source={online && allowedOwnerUrl(origin)
          ? { uri: origin }
          : { html: OFFLINE_HTML }}
        javaScriptEnabled
        domStorageEnabled
        originWhitelist={["https://mypersonas.online", "http://127.0.0.1", "http://localhost"]}
        onShouldStartLoadWithRequest={(request) => allowedOwnerUrl(request.url) || request.url.startsWith("data:")}
      />
    </SafeAreaView>
  );
}
