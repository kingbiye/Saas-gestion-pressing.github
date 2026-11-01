const CACHE_NAME = "pressing-os-shell-v1";
const APP_SHELL = "/";

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys
        .filter((key) => key.startsWith("pressing-os-") && key !== CACHE_NAME)
        .map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;

  if (request.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          const response = await fetch(request);
          if (response.ok) {
            try {
              await caches.open(CACHE_NAME).then((cache) => cache.put(APP_SHELL, response.clone()));
            } catch (error) {
              console.error("Unable to cache the application shell:", error);
            }
          }
          return response;
        } catch {
          const cached = (await caches.match(request)) || (await caches.match(APP_SHELL));
          if (cached) return cached;
          return new Response("Connecte-toi une première fois à Internet pour rendre l’application disponible hors ligne.", {
            status: 503,
            headers: { "Content-Type": "text/plain; charset=utf-8" },
          });
        }
      })(),
    );
    return;
  }

  if (
    url.pathname.startsWith("/_next/static/")
    || url.pathname.startsWith("/pressing-scenes/")
    || url.pathname === "/manifest.webmanifest"
    || url.pathname === "/icon.svg"
  ) {
    event.respondWith(
      (async () => {
        const cached = await caches.match(request);
        if (cached) return cached;
        const response = await fetch(request);
        if (response.ok) {
          try {
            await caches.open(CACHE_NAME).then((cache) => cache.put(request, response.clone()));
          } catch (error) {
            console.error("Unable to cache an application asset:", error);
          }
        }
        return response;
      })(),
    );
  }
});
