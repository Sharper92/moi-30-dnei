'use strict';

const CACHE = 'my30days-v5-ios-nav-1';
const CACHE_PREFIX = 'my30days-';
const BASE_URL = new URL('./', self.location.href);
const INDEX_URL = new URL('index.html', BASE_URL).href;
const FILES = ['./', './index.html', './manifest.json', './icon-192.png', './icon-512.png', './default-habits.js', './habit-model.js', './habit-stats.js', './habit-picker.js', './api.js', './admin.js?attempt=1'];
const APP_URLS = new Set(FILES.map(path => new URL(path, BASE_URL).href));
const PAGE_URLS = new Set([BASE_URL.href, INDEX_URL]);

function canCache(response) {
  return response.ok && !response.redirected && response.type !== 'opaque' && response.type !== 'opaqueredirect';
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    // Fetch the complete new version before replacing any cached files.
    const resources = await Promise.all([...APP_URLS].map(async url => {
      const response = await fetch(new Request(url, { cache: 'reload', credentials: 'same-origin' }));
      if (!canCache(response)) throw new Error('Unable to cache an application resource');
      return [url, response];
    }));
    const cache = await caches.open(CACHE);
    await Promise.all(resources.map(([url, response]) => cache.put(url, response)));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => key.startsWith(CACHE_PREFIX) && key !== CACHE).map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});

async function pageResponse(request, key) {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch(request);
    if (canCache(response)) {
      // Both entry URLs are the same application, including during offline navigation.
      await Promise.all([...PAGE_URLS].map(url => cache.put(url, response.clone()).catch(() => {})));
    }
    // Let authentication redirects and server errors reach the browser without caching them.
    return response;
  } catch {
    return await cache.match(key) || await cache.match(INDEX_URL) || await cache.match(BASE_URL.href) || Response.error();
  }
}

async function assetResponse(request, key) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(key);
  if (cached) return cached;
  const response = await fetch(request);
  if (canCache(response)) await cache.put(key, response.clone()).catch(() => {});
  return response;
}

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== BASE_URL.origin) return;
  const key = url.href;
  // Only the application files belong in this cache; leave authentication and other routes alone.
  if (!APP_URLS.has(key)) return;
  event.respondWith(PAGE_URLS.has(key) ? pageResponse(event.request, key) : assetResponse(event.request, key));
});

self.addEventListener('push', event => {
  let message = {};
  try {
    message = event.data ? event.data.json() : {};
  } catch (error) {
    message = {};
  }
  const title = message.title || 'Мои 30 дней 🌿';
  event.waitUntil(self.registration.showNotification(title, {
    body: message.body || 'Один маленький шаг тоже считается.',
    icon: './icon-192.png',
    badge: './icon-192.png',
    tag: message.tag || 'moi30-gentle-reminder',
    renotify: false,
    data: { url: message.url || './index.html' }
  }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || './index.html', self.location.origin).href;
  event.waitUntil((async () => {
    const windows = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const windowClient of windows) {
      if (new URL(windowClient.url).origin === self.location.origin) {
        await windowClient.focus();
        if ('navigate' in windowClient) await windowClient.navigate(target);
        return;
      }
    }
    await clients.openWindow(target);
  })());
});
