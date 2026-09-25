(() => {
  "use strict";

  const canUseServiceWorker = "serviceWorker" in navigator;
  const isSecureContextForWorker = location.protocol === "https:" ||
    ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);
  const isStandalone = () => window.matchMedia("(display-mode: standalone)").matches ||
    window.navigator.standalone === true;
  const isAppleMobile = /iPad|iPhone|iPod/i.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const isAndroid = /Android/i.test(navigator.userAgent);

  let deferredInstallPrompt = null;
  let installButton = null;
  let statusMessage = null;
  let statusTimer = null;

  function ensureInstallUi() {
    if (installButton && statusMessage) return;
    const nav = document.querySelector("nav .nav-inner") || document.querySelector("nav") || document.body;
    statusMessage = document.getElementById("pwaInstallStatus") || document.createElement("span");
    statusMessage.id = "pwaInstallStatus";
    statusMessage.setAttribute("role", "status");
    statusMessage.setAttribute("aria-live", "polite");
    statusMessage.hidden = true;
    statusMessage.style.cssText = "max-width:240px;padding:6px 10px;border-radius:8px;background:#1a2047;color:#e9ebf7;font-size:12px;font-weight:600;line-height:1.35";

    installButton = document.getElementById("pwaInstallButton") || document.createElement("button");
    installButton.id = "pwaInstallButton";
    installButton.type = "button";
    installButton.className = "btn btn-ghost nav-cta";
    installButton.textContent = "Install app";
    installButton.hidden = true;
    installButton.addEventListener("click", handleInstallClick);

    if (!statusMessage.isConnected) nav.appendChild(statusMessage);
    if (!installButton.isConnected) nav.appendChild(installButton);
  }

  function showStatus(message, persistent = false) {
    ensureInstallUi();
    window.clearTimeout(statusTimer);
    statusMessage.textContent = message;
    statusMessage.hidden = false;
    if (!persistent) {
      statusTimer = window.setTimeout(() => {
        statusMessage.hidden = true;
      }, 10000);
    }
  }

  async function handleInstallClick() {
    if (!deferredInstallPrompt) {
      if (isAppleMobile && !isStandalone()) {
        showStatus("On iPhone or iPad, open Share, then choose Add to Home Screen.", true);
      } else if (isAndroid && !isStandalone()) {
        showStatus("On Android Chrome, open the browser menu, then choose Install app or Add to Home screen. That saves Noo YouNiverse as a standalone browser app. It does not post and does not request notification permission.", true);
      }
      return;
    }
    const promptEvent = deferredInstallPrompt;
    deferredInstallPrompt = null;
    installButton.disabled = true;
    try {
      await promptEvent.prompt();
      const choice = await promptEvent.userChoice;
      installButton.hidden = true;
      showStatus(choice?.outcome === "accepted" ? "Noo YouNiverse installation started." : "Installation canceled.");
    } catch {
      showStatus("Use the browser menu to install Noo YouNiverse.", true);
    } finally {
      installButton.disabled = false;
    }
  }

  window.addEventListener("beforeinstallprompt", (event) => {
    if (isStandalone()) return;
    event.preventDefault();
    deferredInstallPrompt = event;
    ensureInstallUi();
    installButton.hidden = false;
  });

  window.addEventListener("appinstalled", () => {
    deferredInstallPrompt = null;
    ensureInstallUi();
    installButton.hidden = true;
    showStatus("Noo YouNiverse was installed.");
  });

  if ((isAppleMobile || isAndroid) && !isStandalone()) {
    ensureInstallUi();
    installButton.textContent = "Install help";
    installButton.hidden = false;
  }

  if (!canUseServiceWorker || !isSecureContextForWorker) return;

  window.addEventListener("load", async () => {
    try {
      const workerUrl = new URL("./service-worker.js", document.baseURI);
      if (workerUrl.origin !== location.origin) return;
      await navigator.serviceWorker.register(workerUrl.href, {
        scope: new URL("./", workerUrl).href,
        updateViaCache: "none"
      });
    } catch (error) {
      console.warn("Noo YouNiverse offline shell registration failed.", error);
    }
  });
})();
