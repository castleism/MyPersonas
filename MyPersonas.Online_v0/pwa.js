(() => {
  "use strict";

  const canUseServiceWorker = "serviceWorker" in navigator;
  const isSecureContextForWorker = location.protocol === "https:" ||
    ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);
  const isStandalone = () => window.matchMedia("(display-mode: standalone)").matches ||
    window.navigator.standalone === true;
  const isAppleMobile = /iPad|iPhone|iPod/i.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

  let deferredInstallPrompt = null;
  let installButton = null;
  let statusMessage = null;
  let statusTimer = null;

  function ensureInstallUi() {
    if (installButton && statusMessage) return;

    const nav = document.querySelector("header nav");
    const mount = nav || document.body;
    const authButton = document.getElementById("authBtn");

    statusMessage = document.getElementById("pwaInstallStatus") || document.createElement("span");
    statusMessage.id = "pwaInstallStatus";
    statusMessage.setAttribute("role", "status");
    statusMessage.setAttribute("aria-live", "polite");
    statusMessage.hidden = true;
    statusMessage.style.cssText = "max-width:260px;padding:6px 10px;border-radius:8px;background:#e7f3ff;color:#315273;font-size:12px;font-weight:600;line-height:1.35";

    installButton = document.getElementById("pwaInstallButton") || document.createElement("button");
    installButton.id = "pwaInstallButton";
    installButton.type = "button";
    installButton.className = "btn sec sm";
    installButton.textContent = "Install app";
    installButton.setAttribute("aria-describedby", statusMessage.id);
    installButton.hidden = true;
    installButton.style.whiteSpace = "nowrap";
    installButton.addEventListener("click", handleInstallClick);

    if (!statusMessage.isConnected) mount.insertBefore(statusMessage, authButton || null);
    if (!installButton.isConnected) {
      const buttonAnchor = statusMessage.parentNode === mount ? statusMessage : authButton;
      mount.insertBefore(installButton, buttonAnchor || null);
    }
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
      showStatus(
        choice?.outcome === "accepted" ? "AliaSpaces installation started." : "Installation canceled."
      );
    } catch {
      showStatus("The browser could not open its install prompt. Use the browser menu to install AliaSpaces.", true);
    } finally {
      installButton.disabled = false;
    }
  }

  function reportWaitingUpdate(registration) {
    if (registration.waiting && navigator.serviceWorker.controller) {
      showStatus("An AliaSpaces update is ready. Close every AliaSpaces tab and reopen the app to apply it.", true);
    }
  }

  function watchForUpdates(registration) {
    reportWaitingUpdate(registration);
    registration.addEventListener("updatefound", () => {
      const worker = registration.installing;
      if (!worker) return;
      worker.addEventListener("statechange", () => {
        if (worker.state === "installed") reportWaitingUpdate(registration);
      });
    });
  }

  window.addEventListener("beforeinstallprompt", (event) => {
    if (isStandalone()) return;
    event.preventDefault();
    deferredInstallPrompt = event;
    ensureInstallUi();
    installButton.textContent = "Install app";
    installButton.setAttribute("aria-label", "Install AliaSpaces on this device");
    installButton.hidden = false;
  });

  window.addEventListener("appinstalled", () => {
    deferredInstallPrompt = null;
    ensureInstallUi();
    installButton.hidden = true;
    showStatus("AliaSpaces was installed.");
  });

  if (isAppleMobile && !isStandalone()) {
    ensureInstallUi();
    installButton.textContent = "Install help";
    installButton.setAttribute("aria-label", "Show AliaSpaces installation instructions");
    installButton.hidden = false;
  }

  if (!canUseServiceWorker || !isSecureContextForWorker) return;

  window.addEventListener("load", async () => {
    try {
      const workerUrl = new URL("./service-worker.js", document.baseURI);
      if (workerUrl.origin !== location.origin) return;
      const registration = await navigator.serviceWorker.register(workerUrl.href, {
        scope: new URL("./", workerUrl).href,
        updateViaCache: "none"
      });
      watchForUpdates(registration);
    } catch (error) {
      console.warn("AliaSpaces offline shell registration failed.", error);
    }
  });
})();
