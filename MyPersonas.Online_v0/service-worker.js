"use strict";

// Bump this version whenever any file in PUBLIC_SHELL_PATHS changes. An existing
// worker is allowed to finish its session; the new worker activates after all
// AliaSpaces tabs using the old version are closed.
const CACHE_PREFIX = "aliaspaces-public-shell-";
const CACHE_NAME = `${CACHE_PREFIX}2026-08-13-1`;
const PUBLIC_SHELL_PATHS = Object.freeze([
  "./offline.html",
  "./manifest.webmanifest",
  "./pwa.js",
  "./brand/app-icon/favicon.ico",
  "./brand/app-icon/icon.svg",
  "./brand/app-icon/icon-180.png",
  "./brand/app-icon/icon-192.png",
  "./brand/app-icon/icon-512.png",
  "./brand/app-icon/icon-maskable-512.png"
]);

const SCOPE_URL = new URL(self.registration.scope);
const OFFLINE_URL = new URL("./offline.html", SCOPE_URL).href;
const PUBLIC_SHELL_URLS = PUBLIC_SHELL_PATHS.map((path) => new URL(path, SCOPE_URL).href);
const PUBLIC_SHELL_URL_SET = new Set(PUBLIC_SHELL_URLS);

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PUBLIC_SHELL_URLS))
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const cacheNames = await caches.keys();
    await Promise.all(
      cacheNames
        .filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
        .map((name) => caches.delete(name))
    );
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const requestUrl = new URL(request.url);
  if (requestUrl.origin !== SCOPE_URL.origin) return;

  // Documents are always network-first and are never written to Cache Storage.
  // Offline navigation receives the public fallback, never a stored signed-in page.
  if (request.mode === "navigate") {
    event.respondWith((async () => {
      try {
        return await fetch(request);
      } catch {
        const cache = await caches.open(CACHE_NAME);
        return (await cache.match(OFFLINE_URL)) || Response.error();
      }
    })());
    return;
  }

  // Ignore every request outside the explicit public shell allowlist. In
  // particular, API, authentication, Supabase, uploaded-media, and third-party
  // responses pass through without service-worker storage.
  if (!PUBLIC_SHELL_URL_SET.has(requestUrl.href)) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(request);
    return cached || fetch(request);
  })());
});
