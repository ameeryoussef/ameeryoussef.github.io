// The Reach — offline.
//
// Three caches, kept apart because they are three different promises, and versioned
// by what they hold (stamped at build time by scripts/stamp-sw.mjs) so a routine
// deploy replaces the app without re-downloading the map:
//   shell  the app itself: pages, script, styles, fonts, icons. New every deploy.
//   data   the year of NOAA predictions, ~4 MB. Saved automatically.
//   map    the 30 MB base map. Saved automatically too, but never over a connection
//          the browser tells us is metered or in data-saver mode.
//
// Wind and warnings are live by nature: they are never cached here. Offline, the app
// shows the last forecast it fetched with its age, and says it cannot check warnings.

const SHELL = "hc-shell-051be39709", DATA = "hc-data-92138636b5", MAP = "hc-map-eed97fcbd2";
const MAP_FILE = "/map/hudson.pmtiles";
const DONE = "/__predictions-complete";   // marker: the whole year is saved, not just what was browsed

// Two files sit under /data/ but belong to the app, not to NOAA: they change when the
// app changes and they are small. Keeping them in the shell means editing them costs a
// phone a few tens of kilobytes on the next open, instead of re-saving the whole 6 MB
// year of predictions because the data cache was given a new name.
const APP_DATA = ["/data/fetch.json", "/data/stations.json"];

const CORE = [
  "/", "/chart.html", "/settings.html", "/manifest.webmanifest",
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
    for (const k of await caches.keys()) {
      if (![SHELL, DATA, MAP].includes(k)) await caches.delete(k);
    }
    await self.clients.claim();
  })());
});

// ── serving ──────────────────────────────────────────────────────────────────
self.addEventListener("fetch", event => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== location.origin) return;   // live data goes to the network

  if (url.pathname === MAP_FILE) return event.respondWith(serveMap(request));
  if (APP_DATA.includes(url.pathname)) return event.respondWith(cacheFirst(request, SHELL));
  if (url.pathname.startsWith("/data/")) return event.respondWith(cacheFirst(request, DATA));
  if (request.mode === "navigate") return event.respondWith(page(request));
  event.respondWith(cacheFirst(request, SHELL));
});

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request, { ignoreSearch: true });
  if (hit) return hit;
  try {
    const res = await fetch(request);
    if (res.ok) cache.put(request, res.clone());
    return res;
  } catch (e) {
    return new Response(`Offline and not saved: ${new URL(request.url).pathname}`, { status: 504 });
  }
}

// Pages come straight from the network, and from the copy saved at install when there is
// no network. Nothing is cloned into the cache on the way past: teeing a page's response
// while the browser is still reading it delays the first paint, and the browser then gives
// up on carrying the chart across between screens (Motion 3c). Every page is already in
// CORE, refreshed whenever a new version installs.
async function page(request) {
  try {
    return await fetch(request);
  } catch (e) {
    const cache = await caches.open(SHELL);
    return (await cache.match(request, { ignoreSearch: true })) ?? (await cache.match("/")) ??
      new Response("Offline, and this page hasn't been saved yet.", { status: 504, headers: { "Content-Type": "text/plain" } });
  }
}

// The saved map, read out of the cache once and kept for as long as this worker lives.
// Reading it per request instead — a fresh 50 MB blob for every tile — ran the browser
// out of memory the moment a wide zoom asked for twenty tiles at once, and the chart
// went blank with "Failed to fetch". Slicing one blob costs nothing.
let mapBlob = null;
function savedMapBlob() {
  if (!mapBlob) mapBlob = caches.open(MAP).then(c => c.match(MAP_FILE)).then(r => r?.blob() ?? null)
    .catch(e => { mapBlob = null; throw e; });
  return mapBlob;
}

// The map is read in byte ranges. Once saved, ranges are served from the stored copy.
async function serveMap(request) {
  const blob = await savedMapBlob();
  if (!blob) {
    try { return await fetch(request); }
    catch { return new Response("The chart map isn't saved for offline use.", { status: 504 }); }
  }
  const range = request.headers.get("range");
  if (!range) return new Response(blob, { status: 200, headers: { "Accept-Ranges": "bytes", "Content-Type": "application/octet-stream" } });
  const [, from, to] = /bytes=(\d*)-(\d*)/.exec(range) ?? [];
  const start = Number(from || 0), end = to ? Number(to) : blob.size - 1;
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

// ── saving, on request from Settings ─────────────────────────────────────────
self.addEventListener("message", event => {
  const { type } = event.data ?? {};
  // The app asks for this on every load; both saves are skipped when already done.
  if (type === "ensure") event.waitUntil(ensureSaved(event.data, event.source));
  if (type === "save-predictions") event.waitUntil(savePredictions(event.source));
  if (type === "save-map") event.waitUntil(saveMap(event.source));
  if (type === "forget") event.waitUntil(forget(event.data.what, event.source));
  if (type === "status") event.waitUntil(report(event.source));
});

const say = (client, msg) => client?.postMessage(msg);

// Save what's missing, without being asked twice. `metered` comes from the page, which
// is the only place that can see the connection; browsers that can't tell (Safari)
// report nothing and we go ahead — 34 MB once, not on a schedule.
let saving = false;
async function ensureSaved({ metered = false, mapOptOut = false } = {}, client) {
  if (saving) return;
  saving = true;
  try {
    const data = await caches.open(DATA);
    if (!(await data.match(DONE))) await savePredictions(client);
    const map = await caches.open(MAP);
    if (!(await map.match(MAP_FILE))) {
      if (metered) say(client, { type: "deferred", what: "map", reason: "metered connection" });
      else if (!mapOptOut) await saveMap(client);
    }
  } finally {
    saving = false;
    await report(client);
  }
}

async function savePredictions(client) {
  try {
    const cache = await caches.open(DATA);
    const list = await (await fetch(fresh("/data/stations.json"))).json();
    const urls = [
      ...list.stations.filter(s => s.type !== "W").map(s => `/data/currents/${s.id}.json`),
      ...list.tideStations.map(t => `/data/tides/${t.id}.json`),
    ];
    let done = 0;
    for (const url of urls) {
      if (!(await cache.match(url))) {
        const res = await fetch(fresh(url));
        if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
        await cache.put(url, res);
      }
      say(client, { type: "progress", what: "predictions", done: ++done, total: urls.length });
    }
    await cache.put(DONE, new Response(JSON.stringify({ at: Date.now(), files: urls.length }), { headers: { "Content-Type": "application/json" } }));
    say(client, { type: "saved", what: "predictions" });
  } catch (e) {
    say(client, { type: "failed", what: "predictions", error: String(e.message || e) });
  }
  await report(client);
}

async function saveMap(client) {
  try {
    const cache = await caches.open(MAP);
    const res = await fetch(fresh(MAP_FILE));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const total = Number(res.headers.get("content-length")) || 0;
    const reader = res.body.getReader();
    const chunks = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      got += value.byteLength;
      say(client, { type: "progress", what: "map", done: got, total });
    }
    const blob = new Blob(chunks, { type: "application/octet-stream" });
    await cache.put(MAP_FILE, new Response(blob, { headers: { "Content-Type": "application/octet-stream", "Content-Length": String(blob.size) } }));
    mapBlob = null;                                   // the saved copy changed; read it again
    say(client, { type: "saved", what: "map" });
  } catch (e) {
    // Quota is the usual reason on a phone; pass the real message through.
    say(client, { type: "failed", what: "map", error: String(e.message || e) });
  }
  await report(client);
}

async function forget(what, client) {
  if (what === "map") mapBlob = null;
  await caches.delete(what === "map" ? MAP : DATA);
  await report(client);
}

async function report(client) {
  const data = await caches.open(DATA), map = await caches.open(MAP);
  const dataKeys = await data.keys();
  const predictionsComplete = !!(await data.match(DONE));
  const mapSaved = !!(await map.match(MAP_FILE));
  let quota = null;
  try { quota = await navigator.storage.estimate(); } catch {}
  say(client, {
    type: "status",
    at: Date.now(),          // the client ignores a status older than the one it has
    predictions: predictionsComplete ? dataKeys.length - 1 : 0,
    predictionsComplete,
    map: mapSaved,
    saving,
    usage: quota?.usage ?? null,
    quota: quota?.quota ?? null,
  });
}
