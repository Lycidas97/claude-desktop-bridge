import { Capacitor } from "@capacitor/core";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { diagLog, installDiagnostics, runRelayConnectivityProbe } from "./lib/diagnostics.js";
import { installSpecularHighlight } from "./lib/specular.js";
import "@fontsource-variable/dm-sans";
import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import "./styles.css";
import "./media-preview.css";

installDiagnostics();

createRoot(document.getElementById("root")!).render(
  <StrictMode><App /></StrictMode>,
);

installSpecularHighlight();

if ("serviceWorker" in navigator) {
  if (Capacitor.isNativePlatform()) {
    void navigator.serviceWorker.getRegistrations().then((registrations) => {
      diagLog("info", "sw", `检测到 ${registrations.length} 个 ServiceWorker 注册，正在注销`);
      return Promise.all(registrations.map((registration) => registration.unregister()));
    }).catch((err) => diagLog("warn", "sw", "ServiceWorker 注销异常", String(err)));
    if ("caches" in window) {
      void caches.keys().then((keys) => {
        diagLog("info", "sw", `检测到 ${keys.length} 个 CacheStorage 缓存桶，正在清理`, keys);
        return Promise.all(keys.map((key) => caches.delete(key)));
      }).catch((err) => diagLog("warn", "sw", "CacheStorage 清理异常", String(err)));
    }
  } else if (
    !window.bridgeDesktop &&
    (window.location.protocol === "http:" || window.location.protocol === "https:")
  ) {
    window.addEventListener("load", () => void navigator.serviceWorker.register("/sw.js"));
  }
}

setTimeout(() => {
  void runRelayConnectivityProbe().catch(() => undefined);
}, 1_500);
