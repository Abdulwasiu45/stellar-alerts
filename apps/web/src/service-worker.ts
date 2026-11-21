/// <reference lib="webworker" />

/**
 * Service Worker for Offline-First PWA Synchronization
 * Caches payment history, alerts, and handles background sync events.
 */

const sw = self as unknown as ServiceWorkerGlobalScope;

const CACHE_NAME = 'stellar-alerts-pwa-v1';
const API_CACHE_NAME = 'stellar-alerts-api-v1';

const STATIC_PRECACHE = [
  '/',
  '/manifest.json',
  '/offline.html',
  '/favicon.ico',
];

sw.addEventListener('install', (event: ExtendableEvent) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      try {
        await cache.addAll(STATIC_PRECACHE);
      } catch (err) {
        console.warn('[ServiceWorker] Some precache assets failed:', err);
      }
      await sw.skipWaiting();
    })()
  );
});

sw.addEventListener('activate', (event: ExtendableEvent) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => k !== CACHE_NAME && k !== API_CACHE_NAME)
          .map((k) => caches.delete(k))
      );
      await sw.clients.claim();
    })()
  );
});

// Fetch event with offline fallback
sw.addEventListener('fetch', (event: FetchEvent) => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip cross-origin and non-GET requests
  if (request.method !== 'GET' || url.protocol === 'chrome-extension:') {
    return;
  }

  // API Requests: Network-first with API cache fallback
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      (async () => {
        try {
          const networkResponse = await fetch(request.clone());
          if (networkResponse && networkResponse.status === 200) {
            const cache = await caches.open(API_CACHE_NAME);
            await cache.put(request, networkResponse.clone());
          }
          return networkResponse;
        } catch (err) {
          const cachedResponse = await caches.match(request);
          if (cachedResponse) return cachedResponse;
          return new Response(JSON.stringify({ error: 'Offline', cached: true }), {
            headers: { 'Content-Type': 'application/json' },
            status: 200,
          });
        }
      })()
    );
    return;
  }

  // Navigation requests: Network-first, fallback to offline.html
  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          return await fetch(request);
        } catch {
          const cached = await caches.match(request);
          if (cached) return cached;
          const offlinePage = await caches.match('/offline.html');
          return offlinePage || new Response('Offline', { status: 503 });
        }
      })()
    );
    return;
  }

  // Static assets: Cache-first
  event.respondWith(
    caches.match(request).then((response) => response || fetch(request))
  );
});

// Background Sync event handler
sw.addEventListener('sync', (event: any) => {
  if (event.tag === 'sync-rules' || event.tag === 'sync-alerts') {
    event.waitUntil(
      (async () => {
        console.log(`[ServiceWorker] Processing background sync: ${event.tag}`);
        // Notify all clients to trigger queue synchronization
        const allClients = await sw.clients.matchAll({ includeUncontrolled: true });
        for (const client of allClients) {
          client.postMessage({
            type: 'BACKGROUND_SYNC_TRIGGERED',
            tag: event.tag,
            timestamp: Date.now(),
          });
        }
      })()
    );
  }
});
