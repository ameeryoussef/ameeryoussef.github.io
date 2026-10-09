// The Reach — offline.
//
// Caches kept apart because they are different promises, and versioned by what they hold
// (stamped at build time by scripts/stamp-sw.mjs) so a routine deploy replaces the app
// without re-downloading maps:
//   shell  the app itself: pages, script, styles, fonts, icons. New every deploy.
//   data   NOAA's year of predictions, saved area by area.
//   map    one cache per area's base map (src/areas.js), each versioned by its own file,
//          so a new map for one area never costs a phone the others.
//
// The home port's area is saved automatically; others when Settings asks. A map is never
// saved automatically over a connection the browser says is metered.
//
// Wind and warnings are live by nature: they are never cached here. Offline, the app
// shows the last forecast it fetched with its age, and says it cannot check warnings.

const SHELL = "hc-shell-7fb461420f", DATA = "hc-data-93fe276e2a";
// Each map lives on Cloudflare (the Worker in workers/maps), under a name that carries a
// hash of its contents; `v` is that hash and `bytes` its size.
const AREAS = [{"id":"harbor","name":"New York Harbor & the Hudson","file":"https://reach-maps.hudsoncurrents.workers.dev/harbor.46212272ac.pmtiles","v":"46212272ac","bytes":27500047},{"id":"sound","name":"Long Island Sound & the East End","file":"https://reach-maps.hudsoncurrents.workers.dev/sound.853f1d0418.pmtiles","v":"853f1d0418","bytes":40579808},{"id":"njshore","name":"The New Jersey Shore","file":"https://reach-maps.hudsoncurrents.workers.dev/njshore.4afdca0578.pmtiles","v":"4afdca0578","bytes":12810129},{"id":"sne","name":"Rhode Island, Buzzards Bay & the Cape","file":"https://reach-maps.hudsoncurrents.workers.dev/sne.33fb761e53.pmtiles","v":"33fb761e53","bytes":25677656},{"id":"massbay","name":"Massachusetts Bay to Portsmouth","file":"https://reach-maps.hudsoncurrents.workers.dev/massbay.c33e02930e.pmtiles","v":"c33e02930e","bytes":13332467},{"id":"maine","name":"Maine","file":"https://reach-maps.hudsoncurrents.workers.dev/maine.bcff11b57c.pmtiles","v":"bcff11b57c","bytes":19116022},{"id":"delmarva","name":"Delaware Bay & the Delmarva Coast","file":"https://reach-maps.hudsoncurrents.workers.dev/delmarva.2b2be9e5ff.pmtiles","v":"2b2be9e5ff","bytes":16179675},{"id":"chesup","name":"The Upper Chesapeake & the Potomac","file":"https://reach-maps.hudsoncurrents.workers.dev/chesup.088a2a9080.pmtiles","v":"088a2a9080","bytes":38741797},{"id":"chesdown","name":"The Lower Chesapeake & Hampton Roads","file":"https://reach-maps.hudsoncurrents.workers.dev/chesdown.782bb3748b.pmtiles","v":"782bb3748b","bytes":25408828},{"id":"obx","name":"The Outer Banks & Pamlico Sound","file":"https://reach-maps.hudsoncurrents.workers.dev/obx.cd663ffb05.pmtiles","v":"cd663ffb05","bytes":8269875},{"id":"capefear","name":"Cape Lookout to the Cape Fear","file":"https://reach-maps.hudsoncurrents.workers.dev/capefear.7427d83a5d.pmtiles","v":"7427d83a5d","bytes":8233598},{"id":"sc","name":"South Carolina","file":"https://reach-maps.hudsoncurrents.workers.dev/sc.a4dbe8db20.pmtiles","v":"a4dbe8db20","bytes":16426771},{"id":"georgia","name":"Georgia","file":"https://reach-maps.hudsoncurrents.workers.dev/georgia.1f577197d9.pmtiles","v":"1f577197d9","bytes":6145573},{"id":"nefl","name":"Northeast Florida","file":"https://reach-maps.hudsoncurrents.workers.dev/nefl.938399f3d3.pmtiles","v":"938399f3d3","bytes":33928101},{"id":"spacecoast","name":"The Space & Treasure Coasts","file":"https://reach-maps.hudsoncurrents.workers.dev/spacecoast.af6b41e61a.pmtiles","v":"af6b41e61a","bytes":35193204},{"id":"sefl","name":"Palm Beach to Biscayne Bay","file":"https://reach-maps.hudsoncurrents.workers.dev/sefl.e046cbceb6.pmtiles","v":"e046cbceb6","bytes":13838118}];                  // [{ id, name, file, v, bytes }]
const mapCache = a => `hc-map-${a.id}-${a.v}`;
const areaByFile = new Map(AREAS.map(a => [a.file, a]));
const areaById = new Map(AREAS.map(a => [a.id, a]));
// Marker: this area's whole year is saved, not just what was browsed.
const DONE = id => `/__predictions-complete-${id}`;

// Two files sit under /data/ but belong to the app, not to NOAA: they change when the
// app changes and they are small. Keeping them in the shell means editing them costs a
// phone a few tens of kilobytes on the next open, instead of re-saving the whole 6 MB
// year of predictions because the data cache was given a new name.
const APP_DATA = ["/data/fetch.json", "/data/stations.json", "/data/areas.json"];

// The app's own scripts and styles, by their built names (filled in by scripts/stamp-sw.mjs).
// They are saved with the pages at install, so a new version is complete before it takes
// over. They used to be saved only once a page had loaded them through the worker — so the
// first open after every deploy needed the network for the app's own code.
const ASSETS = ["/assets/chart-DpcHSodJ.js","/assets/home-DNXEs3VP.js","/assets/offline-BAe9T2Fm.js","/assets/offline-BqfoA3gu.css"];
const CORE = [
  "/", "/chart.html", "/settings.html", "/manifest.webmanifest", ...ASSETS,
  "/favicon-32.png", "/favicon-64.png", "/icon-192.png", "/icon-512.png", "/apple-touch-icon.png", "/licenses.txt",
  "/fonts/fonts.css",
  "/fonts/Archivo-300.woff2", "/fonts/Archivo-400.woff2", "/fonts/Archivo-500.woff2", "/fonts/Archivo-600.woff2",
  "/fonts/IBMPlexMono-400.woff2", "/fonts/IBMPlexMono-500.woff2", "/fonts/IBMPlexMono-600.woff2",
  ...APP_DATA,
];

// Every copy the worker saves is fetched fresh from the server, bypassing the browser's
// own download cache. Saving through that cache once stored a day-old fetch.json — Netlify
// told browsers to keep /data/ files for 24 hours — and the worker then served the stale
// copy indefinitely: stations with no measured open water, and no wave estimates.
const fresh = url => new Request(url, { cache: "reload" });

self.addEventListener("install", e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(CORE.map(fresh))).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil((async () => {
    await carryMapsOver();
    for (const k of await caches.keys()) {
      if (![SHELL, DATA, ...AREAS.map(mapCache)].includes(k)) await caches.delete(k);
    }
    await self.clients.claim();
  })());
});

// A map a phone already saved, from when the maps sat beside the app (/map/harbor.pmtiles),
// is the same file the new name points to if it is the same size to the byte: move it to
// the new name rather than download it again. Anything else is left for the clean-up below.
async function carryMapsOver() {
  for (const area of AREAS) {
    try {
      const fresh = await caches.open(mapCache(area));
      if (await fresh.match(area.file, { ignoreVary: true })) continue;
      for (const k of await caches.keys()) {
        if (!k.startsWith(`hc-map-${area.id}-`) || k === mapCache(area)) continue;
        const old = await (await caches.open(k)).match(`/map/${area.id}.pmtiles`);
        const blob = await old?.blob();
        if (blob && blob.size === area.bytes) {
          await fresh.put(area.file, new Response(blob, { headers: { "Content-Type": "application/octet-stream", "Content-Length": String(blob.size) } }));
          break;
        }
      }
    } catch { /* a failed carry-over only means the map downloads again */ }
  }
}

// ── serving ──────────────────────────────────────────────────────────────────
self.addEventListener("fetch", event => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== "GET") return;
  // The maps come from Cloudflare, so they are checked before the same-origin rule below.
  const map = areaByFile.get(url.origin + url.pathname);
  if (map) return event.respondWith(serveMap(request, map));
  if (url.origin !== location.origin) return;   // live data goes to the network

  if (APP_DATA.includes(url.pathname)) return event.respondWith(cacheFirst(request, SHELL));
  if (url.pathname.startsWith("/data/")) return event.respondWith(cacheFirst(request, DATA));
  if (request.mode === "navigate") return event.respondWith(page(request));
  event.respondWith(cacheFirst(request, SHELL));
});

// ignoreVary: a server that marks its files "Vary: Origin" (Vite's preview server does)
// would otherwise never match the saved copy — the page's module scripts carry an Origin
// header and the worker's saving requests don't — and offline, every script came back 504
// and the app opened as bare text. These files never differ by origin.
async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request, { ignoreSearch: true, ignoreVary: true });
  if (hit) return hit;
  try {
    const res = await fetch(request);
    if (res.ok) cache.put(request, res.clone());
    return res;
  } catch (e) {
    return new Response(`Offline and not saved: ${new URL(request.url).pathname}`, { status: 504 });
  }
}

// Pages come from the copy saved with this version, at once, whatever the signal is doing.
// They used to come from the network first, falling back to the saved copy only when the
// network failed — and a weak signal doesn't fail, it hangs, so the app sat blank for as
// long as the phone kept trying (reproduced: still nothing after 25 seconds). The saved page
// is also the right one: it matches the saved scripts beside it. A new version arrives with
// the next worker, which saves its pages and scripts together before it takes over.
async function page(request) {
  const cache = await caches.open(SHELL);
  const saved = await cache.match(request, { ignoreSearch: true, ignoreVary: true });
  if (saved) return saved;
  try {
    return await fetch(request);
  } catch (e) {
    return (await cache.match("/")) ??
      new Response("Offline, and this page hasn't been saved yet.", { status: 504, headers: { "Content-Type": "text/plain" } });
  }
}

// Each saved map, read out of its cache once and kept for as long as this worker lives.
// Reading it per request instead — a fresh 50 MB blob for every tile — ran the browser
// out of memory the moment a wide zoom asked for twenty tiles at once, and the chart
// went blank with "Failed to fetch". Slicing one blob costs nothing.
const blobs = new Map();                  // area id -> Promise<Blob | null>
function savedMapBlob(area) {
  if (!blobs.has(area.id)) blobs.set(area.id, caches.open(mapCache(area)).then(c => c.match(area.file, { ignoreVary: true })).then(r => r?.blob() ?? null)
    .catch(e => { blobs.delete(area.id); throw e; }));
  return blobs.get(area.id);
}

// Maps are read in byte ranges. Once saved, ranges are served from the stored copy.
async function serveMap(request, area) {
  const blob = await savedMapBlob(area);
  if (!blob) {
    try { return await fetch(request); }
    catch { return new Response(`${area.name} isn't saved for offline use.`, { status: 504 }); }
  }
  const range = request.headers.get("range");
  if (!range) return new Response(blob, { status: 200, headers: { "Accept-Ranges": "bytes", "Content-Type": "application/octet-stream" } });
  const [, from, to] = /bytes=(\d*)-(\d*)/.exec(range) ?? [];
  const start = Number(from || 0), end = to ? Math.min(Number(to), blob.size - 1) : blob.size - 1;
  const part = blob.slice(start, end + 1);
  return new Response(part, {
    status: 206,
    headers: {
      "Content-Range": `bytes ${start}-${end}/${blob.size}`,
      "Accept-Ranges": "bytes",
      "Content-Length": String(part.size),
      "Content-Type": "application/octet-stream",
    },
  });
}

// ── saving ───────────────────────────────────────────────────────────────────
// One job at a time, in the order asked: an automatic save and a tap on Save never race
// each other for the same files.
let queue = Promise.resolve(), busy = null;
const enqueue = job => (queue = queue.then(job, job));

self.addEventListener("message", event => {
  const { type } = event.data ?? {};
  const client = event.source;
  // The app sends this on every load with the areas it wants kept: the home port's, and
  // any saved from Settings. Anything already saved is skipped.
  if (type === "ensure") event.waitUntil(enqueue(() => ensureSaved(event.data, client)));
  // A tap on Save is asked for: it goes ahead on any connection.
  if (type === "save-area") event.waitUntil(enqueue(() => saveArea(event.data.area, client, { metered: false })));
  if (type === "forget-area") event.waitUntil(enqueue(() => forgetArea(event.data.area, client)));
  if (type === "status") event.waitUntil(report(client));
});

const say = (client, msg) => client?.postMessage(msg);

// `metered` comes from the page, which is the only place that can see the connection;
// browsers that can't tell (Safari) report nothing and we go ahead — one area's map once,
// not on a schedule.
async function ensureSaved({ metered = false, areas = [] } = {}, client) {
  for (const id of areas) if (areaById.has(id)) await saveArea(id, client, { metered });
  await report(client);
}

async function saveArea(id, client, { metered }) {
  const area = areaById.get(id);
  if (!area) return;
  busy = id;
  try {
    // An area's station list can grow (a new region next door, a new station); the marker
    // records which list was saved, and a changed list is topped up — only the new files fetch.
    const data = await caches.open(DATA);
    const done = await data.match(DONE(id)).then(r => r?.json()).catch(() => null);
    const entry = await areaList().then(l => l.find(a => a.id === id)).catch(() => null);
    if (!done || (entry && done.files !== entry.currents.length + entry.tides.length)) await savePredictions(area, client);
    const map = await caches.open(mapCache(area));
    if (!(await map.match(area.file, { ignoreVary: true }))) {
      if (metered) say(client, { type: "deferred", what: "map", area: id, reason: "metered connection" });
      else await saveMap(area, client);
    }
  } finally {
    busy = null;
    await report(client);
  }
}

async function areaList() {
  const res = await fetch(fresh("/data/areas.json"));
  if (!res.ok) throw new Error(`area list: HTTP ${res.status}`);
  return (await res.json()).areas;
}

async function savePredictions(area, client) {
  try {
    const cache = await caches.open(DATA);
    const entry = (await areaList()).find(a => a.id === area.id);
    if (!entry) throw new Error(`no station list for ${area.name}`);
    const urls = [...entry.currents.map(id => `/data/currents/${id}.json`), ...entry.tides.map(id => `/data/tides/${id}.json`)];
    let done = 0;
    for (const url of urls) {
      if (!(await cache.match(url))) {
        const res = await fetch(fresh(url));
        if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
        await cache.put(url, res);
      }
      say(client, { type: "progress", what: "predictions", area: area.id, done: ++done, total: urls.length });
    }
    await cache.put(DONE(area.id), new Response(JSON.stringify({ at: Date.now(), files: urls.length }), { headers: { "Content-Type": "application/json" } }));
    say(client, { type: "saved", what: "predictions", area: area.id });
  } catch (e) {
    say(client, { type: "failed", what: "predictions", area: area.id, error: String(e.message || e) });
  }
}

async function saveMap(area, client) {
  try {
    const cache = await caches.open(mapCache(area));
    const res = await fetch(fresh(area.file));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const total = Number(res.headers.get("content-length")) || 0;
    const reader = res.body.getReader();
    const chunks = [];
    let got = 0, told = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      got += value.byteLength;
      if (got - told > 256 * 1024 || got === total) { told = got; say(client, { type: "progress", what: "map", area: area.id, done: got, total }); }
    }
    const blob = new Blob(chunks, { type: "application/octet-stream" });
    await cache.put(area.file, new Response(blob, { headers: { "Content-Type": "application/octet-stream", "Content-Length": String(blob.size) } }));
    blobs.delete(area.id);                          // the saved copy changed; read it again
    say(client, { type: "saved", what: "map", area: area.id });
  } catch (e) {
    // Quota is the usual reason on a phone; pass the real message through.
    say(client, { type: "failed", what: "map", area: area.id, error: String(e.message || e) });
  }
}

// Removing an area takes its map and its predictions. The page never asks this of the
// home port's area.
async function forgetArea(id, client) {
  const area = areaById.get(id);
  if (!area) return;
  blobs.delete(id);
  await caches.delete(mapCache(area));
  try {
    const entry = (await areaList()).find(a => a.id === id);
    const cache = await caches.open(DATA);
    await cache.delete(DONE(id));
    for (const sid of entry?.currents ?? []) await cache.delete(`/data/currents/${sid}.json`);
    for (const sid of entry?.tides ?? []) await cache.delete(`/data/tides/${sid}.json`);
  } catch (e) {
    say(client, { type: "failed", what: "forget", area: id, error: String(e.message || e) });
  }
  await report(client);
}

async function report(client) {
  const data = await caches.open(DATA);
  const areas = {};
  for (const a of AREAS) {
    const map = await caches.open(mapCache(a));
    areas[a.id] = { map: !!(await map.match(a.file, { ignoreVary: true })), predictions: !!(await data.match(DONE(a.id))) };
  }
  let quota = null;
  try { quota = await navigator.storage.estimate(); } catch {}
  say(client, {
    type: "status",
    at: Date.now(),          // the client ignores a status older than the one it has
    areas, busy,
    usage: quota?.usage ?? null,
    quota: quota?.quota ?? null,
  });
}
