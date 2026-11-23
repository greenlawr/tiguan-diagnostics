// Offline support: network first (so updates arrive), cached copy when there is no signal.
const CACHE = 'evergreen-v14';
const FILES = [
  './', 'index.html', 'styles.css', 'icon.svg', 'manifest.webmanifest',
  'js/app.js', 'js/appconnect.js', 'js/ble.js', 'js/biometric.js', 'js/deliveries.js', 'js/dtc.js', 'js/elm.js', 'js/explain.js', 'js/garage.js',
  'js/life.js', 'js/isotp.js', 'js/obd.js', 'js/pids.js', 'js/report.js', 'js/simulator.js', 'js/trip.js', 'js/vault.js', 'js/vehicle.js', 'js/vw.js',
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
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE).then((c) => c.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request, { ignoreSearch: true }))
  );
});
