// Service Worker offline-first do PraxisBot Tablet.
// Pré-carrega o aplicativo estático para funcionar sem internet em sala de aula e
// nunca intercepta nem guarda em cache requisições da API do Supabase.
const CACHE_NAME = 'praxisbot-tablet-e7b08b752e25';
const ARQUIVOS_SHELL = [
    './',
    './index.html',
    './styles.css',
    './manifest.webmanifest',
    './icons/icon128.png',
    './icons/icon500.png',
    './vendor/catalog-model.js',
    './vendor/queue-model.js',
    './vendor/schedule-calendar-model.js',
    './vendor/previsao-datas-model.js',
    './vendor/academic-report-model.js',
    './src/config.js',
    './src/crypto-web.js',
    './src/db.js',
    './src/supabase.js',
    './src/sync.js',
    './src/qr-scanner.js',
    './src/gemini.js',
    './src/domain.js',
    './src/phase3-ui.js',
    './src/app.js'
];

self.addEventListener('install', evento => {
    evento.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => cache.addAll(ARQUIVOS_SHELL))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', evento => {
    evento.waitUntil(
        caches.keys()
            .then(nomes => Promise.all(nomes.filter(n => n !== CACHE_NAME).map(n => caches.delete(n))))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', evento => {
    const req = evento.request;
    if (req.method !== 'GET') return;
    const url = new URL(req.url);
    if (url.origin !== self.location.origin) return;

    evento.respondWith(
        caches.open(CACHE_NAME).then(async cache => {
            const emCache = await cache.match(req);
            const rede = fetch(req).then(resp => {
                if (resp && resp.ok && resp.type === 'basic') cache.put(req, resp.clone());
                return resp;
            }).catch(() => null);
            if (emCache) {
                evento.waitUntil(rede);
                return emCache;
            }
            const respostaRede = await rede;
            if (respostaRede) return respostaRede;
            return cache.match('./index.html');
        })
    );
});
