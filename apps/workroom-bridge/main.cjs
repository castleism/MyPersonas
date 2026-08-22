"use strict";

const { app, BrowserWindow, session, shell } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { parseWorkroomUrl, partitionName } = require("./provider-policy.cjs");

const PROTOCOL = "aliaspaces-workroom";
const windows = new Map();
let pendingProtocolUrl = process.argv.find((value) => value.startsWith(`${PROTOCOL}://`)) || "";

function installationId() {
  const file = path.join(app.getPath("userData"), "installation-id");
  try {
    const current = fs.readFileSync(file, "utf8").trim();
    if (/^[0-9a-f-]{36}$/i.test(current)) return current;
  } catch (_) {}
  const created = crypto.randomUUID();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, created, { encoding: "utf8", mode: 0o600 });
  return created;
}

function safeNavigation(value) {
  try { return new URL(value).protocol === "https:"; } catch (_) { return false; }
}

function hardenWindow(win) {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (safeNavigation(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (!safeNavigation(url)) event.preventDefault();
  });
  win.webContents.on("will-attach-webview", (event) => event.preventDefault());
}

function configurePartition(partition) {
  const isolated = session.fromPartition(partition);
  isolated.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  isolated.setPermissionCheckHandler(() => false);
  isolated.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = { ...details.requestHeaders };
    delete headers["X-AliaSpaces-Owner"];
    callback({ requestHeaders: headers });
  });
}

function openWorkroom(request) {
  const key = request.accountId;
  const existing = windows.get(key);
  if (existing && !existing.isDestroyed()) {
    existing.show(); existing.focus(); existing.loadURL(request.initialUrl); return existing;
  }
  const partition = partitionName(installationId(), request.accountId);
  configurePartition(partition);
  const win = new BrowserWindow({
    title: `AliaSpaces Workroom · ${request.provider}`,
    width: 1240,
    height: 900,
    minWidth: 760,
    minHeight: 560,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: "#f5f7fb",
    webPreferences: {
      partition,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: true
    }
  });
  hardenWindow(win);
  win.once("ready-to-show", () => win.show());
  win.on("closed", () => windows.delete(key));
  win.loadURL(request.initialUrl);
  windows.set(key, win);
  return win;
}

function handleProtocol(value) {
  const request = parseWorkroomUrl(value);
  if (request.ok) openWorkroom(request);
}

function openOwnerApp() {
  const partition = "persist:aliaspaces-owner-app";
  configurePartition(partition);
  const win = new BrowserWindow({
    title: "AliaSpaces Owner",
    width: 1180,
    height: 860,
    minWidth: 420,
    minHeight: 620,
    autoHideMenuBar: true,
    webPreferences: { partition, contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true }
  });
  hardenWindow(win);
  win.loadURL("https://aliaspaces.com/#/owner");
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", (_event, argv) => {
    const value = argv.find((item) => item.startsWith(`${PROTOCOL}://`));
    if (value) handleProtocol(value);
  });
  app.on("open-url", (event, url) => { event.preventDefault(); if (app.isReady()) handleProtocol(url); else pendingProtocolUrl = url; });
  app.whenReady().then(() => {
    app.setAsDefaultProtocolClient(PROTOCOL);
    if (pendingProtocolUrl) handleProtocol(pendingProtocolUrl); else openOwnerApp();
  });
  app.on("window-all-closed", () => app.quit());
}
