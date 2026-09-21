const CACHE_NAME = 'shanshan-shell-v4';
const APP_SHELL = [
  './',
  './index.html',
  './tokens.css?v=8',
  './styles.css?v=8',
  './redesign.css?v=26',
  './app.js?v=13',
  './manifest.webmanifest?v=1',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
  './assets/icons/apple-touch-icon.png',
  './assets/illustrations/shanshan-mascot.png?v=5',
  './assets/illustrations/icon-listen.png?v=1',
  './assets/illustrations/icon-story.png?v=1',
  './assets/illustrations/icon-watch.png?v=1',
  './assets/illustrations/listen-room.png',
  './assets/illustrations/watch-fort.png',
  './assets/covers/bluey.jpg',
  './assets/covers/daniel-tiger.jpg',
  './assets/covers/hey-duggee.jpg',
  './assets/covers/music-band.jpg',
  './assets/covers/music-guitar.jpg',
  './assets/covers/music-headphones.jpg',
  './assets/covers/music-piano.jpg',
  './assets/covers/numberblocks.jpg',
  './assets/covers/peppa.jpg',
  './assets/covers/puffin-rock.jpg',
  './assets/covers/story-bed.jpg',
  './assets/covers/story-family.jpg',
  './assets/covers/story-reading.jpg',
  './assets/covers/story-siblings.jpg'
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put('./index.html', copy));
          return response;
        })
        .catch(() => caches.match('./index.html'))
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request).then((response) => {
      if (response.ok && new URL(event.request.url).origin === self.location.origin) {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
      }
      return response;
    }))
  );
});
