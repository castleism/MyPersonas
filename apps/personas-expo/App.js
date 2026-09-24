import { useEffect, useMemo, useState } from "react";
import { Button, SafeAreaView, Text, View } from "react-native";
import NetInfo from "@react-native-community/netinfo";
import { WebView } from "react-native-webview";

const DEFAULT_ORIGIN = "https://mypersonas.online/#/owner";
const EXPORT_VERSION = "mobile-owner-workflow-export-v1";

function allowedOwnerUrl(url) {
  return typeof url === "string" && (
    url.startsWith("https://mypersonas.online/")
    || url.startsWith("http://127.0.0.1:")
    || url.startsWith("http://localhost:")
  );
}

const OFFLINE_HTML = `<!doctype html><html><body style="font-family:sans-serif;padding:24px;color:#10213b">
<div style="background:#fff7e6;border:1px solid #f2dfb4;padding:14px;border-radius:12px">
<h1>Disconnected from MyPersonas</h1>
<p><strong>publishing_enabled=false.</strong> This Expo debug shell is a thin WebView over the real owner command center. It is not a local social publisher.</p>
<p>While offline this shell cannot create, approve, or send drafts. Reconnect, then reload.</p>
</div></body></html>`;

export default function App() {
  const [online, setOnline] = useState(true);
  const origin = useMemo(() => DEFAULT_ORIGIN, []);

  useEffect(() => {
    const sub = NetInfo.addEventListener((state) => {
      setOnline(state.isConnected !== false && state.isInternetReachable !== false);
    });
    return () => sub();
  }, []);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: "#fff" }}>
      <View style={{ padding: 8, gap: 8 }}>
        <Text>MyPersonas Owner (debug) · publishing_enabled=false · export {EXPORT_VERSION}</Text>
        <Button title="Reload when online" onPress={() => setOnline((value) => value)} />
      </View>
      <WebView
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
