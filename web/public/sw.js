/** Windy Chat — Service Worker (PWA offline support) */

const CACHE_NAME = 'windy-chat-v1';
const SHELL_URLS = [
  '/',
  '/index.html',
  '/manifest.json',
];

// Install — cache app shell
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_URLS))
  );
  self.skipWaiting();
});

// Activate — clean old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch — network first, fallback to cache (for app shell)
self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Skip API calls and Matrix requests — always go to network
  if (request.url.includes('/api/') || request.url.includes('/_matrix/')) {
    return;
  }

  event.respondWith(
    fetch(request)
      .then((response) => {
        // Cache successful responses for navigation requests
        if (response.ok && request.mode === 'navigate') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
        }
        return response;
      })
      .catch(() => caches.match(request).then((cached) => cached || caches.match('/')))
  );
});

// Push notifications
self.addEventListener('push', (event) => {
  if (!event.data) return;
  const data = event.data.json();
  // The push-gateway nests room/url under data.data — accept both the
  // flat and nested shapes so pushes deep-link to the room.
  const inner = data.data || {};
  event.waitUntil(
    self.registration.showNotification(data.title || 'Windy Chat', {
      body: data.body || 'New message',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: data.tag || inner.room_id || data.room_id || 'default',
      data: { url: inner.url || data.url || '/' },
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.openWindow(event.notification.data?.url || '/')
  );
});
