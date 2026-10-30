/* One coherent offline app release. Never deletes recording databases or
 * localStorage. Boot/recovery code installs a release before loading the app. */
"use strict";
const CACHE_VERSION = "brixtonvibes-v42";
const APP_SHELL = [
  "./",
  "./index.html",
  "./style.css",
  "./style.css?v=42",
  "./app-bootstrap.js?v=42",
  "./app.js?v=42",
  "./features.js",
  "./classifier.js",
  "./training-set.js",
  "./raw-store.js",
  "./fork-engine.js",
  "./track-position.js",
  "./track-reference.js",
  "./track-view.js",
  "./onedrive-sync.js",
  "./native-save.js",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
  "./apple-touch-icon.png",
];
const SHELL_URLS = new Set(
  APP_SHELL.map((path) => new URL(path, self.registration.scope).href),
);

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then(async (cache) => {
      // A new cache name alone is insufficient: the browser HTTP cache could
      // otherwise fill it with the previous release's HTML/JavaScript.
      await cache.addAll(
        APP_SHELL.map(
          (path) =>
            new Request(new URL(path, self.registration.scope), {
              cache: "reload",
            }),
        ),
      );
      await self.skipWaiting();
    }),
  );
});
self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter(
            (name) =>
              name.startsWith("brixtonvibes-") && name !== CACHE_VERSION,
          )
          .map((name) => caches.delete(name)),
      );
      // Taking control does not navigate/reload existing clients. In particular
      // an old recording tab must continue undisturbed until its user finishes.
      await self.clients.claim();
    })(),
  );
});
self.addEventListener("fetch", (event) => {
  const request = event.request,
    url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;
  if (
    url.pathname.includes("/api/") ||
    /\/(update\.html|update\.js)$/.test(url.pathname)
  )
    return;
  if (request.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          const response = await fetch(request, { cache: "no-store" });
          if (response.ok) return response;
        } catch {
          /* Offline: retain the complete cached release. */
        }
        const cache = await caches.open(CACHE_VERSION);
        return (await cache.match("./index.html")) || Response.error();
      })(),
    );
    return;
  }
  if (!SHELL_URLS.has(url.href)) return;
  event.respondWith(
    caches
      .open(CACHE_VERSION)
      .then(async (cache) => (await cache.match(request)) || fetch(request)),
  );
});
