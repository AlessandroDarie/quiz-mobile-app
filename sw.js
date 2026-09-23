const CACHE_NAME = 'quiz-cache-v7';
const urlsToCache = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './pdf_parser.js',
  './lib/pdf.min.js',
  './lib/pdf.worker.min.js',
  './lib/tesseract/tesseract.min.js',
  './lib/tesseract/worker.min.js'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(urlsToCache))
  );
});

// I file "core"/dati lingua di Tesseract (OCR) vengono scaricati da CDN al primo utilizzo:
// non fanno parte del precache sopra, ma una volta scaricati con successo restano salvati
// qui per gli utilizzi offline successivi.
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        if (response && response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
        }
        return response;
      }).catch(() => cached);
    })
  );
});