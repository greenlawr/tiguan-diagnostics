// Offline support: network first (so updates arrive), cached copy when there is no signal.
const CACHE = 'evergreen-v45';
const FILES = [
  './', 'index.html', 'styles.css', 'icon.svg', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'apple-touch-icon.png', 'manifest.webmanifest',
  'js/app.js', 'js/appconnect.js', 'js/ble.js', 'js/biometric.js', 'js/deliveries.js', 'js/dtc.js', 'js/elm.js', 'js/explain.js', 'js/garage.js', 'js/household.js', 'js/ical.js', 'js/icons.js',
  'js/life.js', 'js/import.js', 'js/isotp.js', 'js/mrz.js', 'js/obd.js', 'js/photos.js', 'js/pids.js', 'js/report.js', 'js/simulator.js', 'js/sync.js', 'js/trip.js', 'js/vault.js', 'js/vehicle.js', 'js/vw.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET' || new URL(event.request.url).origin !== location.origin) return;
  const req = event.request;
  // 'no-cache' revalidates with the server every time (cheap when unchanged),
  // so a new version is picked up on the next open instead of up to 10 min later.
  const fresh = req.mode === 'navigate' ? fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' }) : fetch(req, { cache: 'no-cache' });
  event.respondWith(
    fresh
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE).then((c) => c.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request, { ignoreSearch: true }))
  );
});
