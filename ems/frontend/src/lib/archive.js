/* Browser-side archive of the device's RAW series (spec 011 FR-1101…FR-1111).

   The gPlug keeps only a short append-only buffer (KEEP_DAYS 15-min slots,
   VZ_KEEP_DAYS peer slots). The browser has persistent storage and is the only
   place that needs the long history, so it mirrors every record it has ever
   seen into IndexedDB and derives day/month roll-ups, the vZEV share, costs and
   quarterly billing from its own copy (lib/aggregate.js, lib/vzev.js).

   Stored are RAW integer Wh only — never a cost, a roll-up or an allocation
   (spec 001 «costs are never stored», extended to every derived series).
   `localStorage` is deliberately not used: string-only, ~5 MB, synchronous.

   This is the ONLY module that touches IndexedDB; the pure libs never import it
   (pages inject it) so the node tests keep running without a browser. */

import { build as csvBuild, parse as csvParse } from './csv.js';

var DB_NAME = 'gplug-archive';
var DB_VERSION = 2;
var SLOT = 900;                 /* 15 min, the device's slot length */
var PAGE = 384;                 /* records per /api/energy request (NFR-1104) */
var MAX_PAGES = 60;             /* safety stop: 60 * 384 = 23 040 slots */
var REFETCH_S = 2 * 86400;      /* first sync of a session re-reads 2 days */
var MAX_GAPS = 50;              /* gap runs kept in meta (display only) */
var EXPORT_FORMAT = '2';        /* 2: `e` rows carry bat_chg/bat_dis (issue #20) */
var IMPORT_FORMATS = ['1', '2'];

/* per-session state: which sites this page load has already re-fetched, and
   whether the persistence request has been made (FR-1108) */
var sessionSynced = {};
var persistAsked = false;
var dbPromise = null;
var unavailable = false;

function idb() {
  return typeof indexedDB !== 'undefined' ? indexedDB
    : (typeof globalThis !== 'undefined' ? globalThis.indexedDB : undefined);
}

function req(r) {
  return new Promise(function (resolve, reject) {
    r.onsuccess = function () { resolve(r.result); };
    r.onerror = function () { reject(r.error || new Error('idb request failed')); };
  });
}

function txDone(tx) {
  return new Promise(function (resolve, reject) {
    tx.oncomplete = function () { resolve(); };
    tx.onabort = tx.onerror = function () { reject(tx.error || new Error('idb tx failed')); };
  });
}

/* open() — resolves the database handle, or rejects when storage is blocked
   (private window, quota, SecurityError). Callers treat a rejection as
   «archive not available» and fall back to the live device buffer (FR-1111). */
function open() {
  if (dbPromise) return dbPromise;
  var factory = idb();
  if (!factory) {
    unavailable = true;
    return Promise.reject(new Error('IndexedDB unavailable'));
  }
  dbPromise = new Promise(function (resolve, reject) {
    var r;
    try { r = factory.open(DB_NAME, DB_VERSION); }
    catch (e) { reject(e); return; }
    r.onupgradeneeded = function () {
      var db = r.result;
      if (!db.objectStoreNames.contains('e15')) {
        db.createObjectStore('e15', { keyPath: ['siteId', 'ts'] });
      }
      if (!db.objectStoreNames.contains('vz15')) {
        db.createObjectStore('vz15', { keyPath: ['siteId', 'memberId', 'ts'] });
      }
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'siteId' });
      }
      /* v2: the Übersicht's per-id live power rings (10 s samples, 15 min).
         Not a roll-up — raw W straight from /loads + /productions, kept only
         so a browser reload does not start every sparkline from zero. */
      if (!db.objectStoreNames.contains('live')) {
        db.createObjectStore('live', { keyPath: ['siteId', 'kind', 'id'] });
      }
    };
    r.onsuccess = function () { resolve(r.result); };
    r.onerror = function () { reject(r.error || new Error('idb open failed')); };
    r.onblocked = function () { reject(new Error('idb blocked')); };
  }).catch(function (e) {
    unavailable = true;
    dbPromise = null;
    throw e;
  });
  return dbPromise;
}

/* available() — never rejects; false means every page must render from the
   live device buffer and show the FR-1111 banner. */
function available() {
  if (unavailable) return Promise.resolve(false);
  return open().then(function () { return true; }, function () { return false; });
}

function store(db, name, mode) {
  return db.transaction(name, mode).objectStore(name);
}

/* --- meta ---------------------------------------------------------------- */

function blankMeta(siteId) {
  return {
    siteId: siteId, firstE15Ts: null, lastE15Ts: null, lastVzTs: null,
    gaps: [], count: 0, syncedAt: null,
    producerId: null, selfId: null, tariffs: null
  };
}

function getMeta(siteId) {
  return open().then(function (db) {
    return req(store(db, 'meta', 'readonly').get(siteId));
  }).then(function (m) { return m || blankMeta(siteId); });
}

function putMeta(meta) {
  return open().then(function (db) {
    var tx = db.transaction('meta', 'readwrite');
    tx.objectStore('meta').put(meta);
    return txDone(tx).then(function () { return meta; });
  });
}

/* listSites() — every siteId this origin has archived. More than one means the
   device was re-identified (edge case «archive site id ≠ device site id»). */
function listSites() {
  return open().then(function (db) {
    return req(store(db, 'meta', 'readonly').getAllKeys());
  }).then(function (keys) { return (keys || []).map(String); });
}

/* --- energy records ------------------------------------------------------ */

function boundRange(siteId, from, to) {
  var lo = (from === undefined || from === null) ? 0 : from;
  var hi = (to === undefined || to === null) ? 9999999999 : to;
  return IDBKeyRange.bound([siteId, lo], [siteId, hi]);
}

/* range(siteId, from, to) — archived 15-min records, oldest first, in the
   shape lib/aggregate.js consumes ({ts, imp_wh, exp_wh, pv_wh, partial?},
   plus bat_chg_wh/bat_dis_wh on a battery site — issue #20).
   `from`/`to` are inclusive epoch seconds. */
function range(siteId, from, to) {
  return open().then(function (db) {
    return req(store(db, 'e15', 'readonly').getAll(boundRange(siteId, from, to)));
  }).then(function (rows) {
    return (rows || []).map(function (r) {
      var out = { ts: r.ts, imp_wh: r.imp_wh, exp_wh: r.exp_wh, pv_wh: r.pv_wh };
      putBattery(out, r);
      if (r.partial) out.partial = true;
      return out;
    });
  });
}

function putEnergy(siteId, records) {
  if (!records || !records.length) return Promise.resolve(0);
  return open().then(function (db) {
    var tx = db.transaction('e15', 'readwrite');
    var os = tx.objectStore('e15');
    var n = 0;
    records.forEach(function (r) {
      if (!r || typeof r.ts !== 'number') return;
      var row = {
        siteId: siteId, ts: r.ts,
        imp_wh: norm(r.imp_wh), exp_wh: norm(r.exp_wh), pv_wh: norm(r.pv_wh)
      };
      putBattery(row, r);
      if (r.partial) row.partial = true;
      os.put(row);                            /* upsert: sync is idempotent */
      n++;
    });
    return txDone(tx).then(function () { return n; });
  });
}

function norm(v) {
  return (v === undefined || v === null || isNaN(v)) ? null : Number(v);
}

/* battery charge/discharge Wh (issue #20): only a battery site's records
   carry them, so they are copied when present and never invented — a site
   without a battery keeps its record shape */
var BAT_FIELDS = ['bat_chg_wh', 'bat_dis_wh'];
function putBattery(dst, src) {
  BAT_FIELDS.forEach(function (k) {
    var v = norm(src[k]);
    if (v !== null) dst[k] = v;
  });
}

/* --- peer slots ---------------------------------------------------------- */

/* putRaw(siteId, raw) — mirror a /api/vzev/raw response into `vz15`. Each
   member ring is a flat [ts,imp,exp, …] stream that MAY contain more than one
   triple for the same ts (the device appends corrections); iterating in array
   order makes the LAST one win, exactly as lib/vzev.js peerSlot() does. */
function putRaw(siteId, raw) {
  var data = (raw && raw.data) || {};
  var ids = Object.keys(data);
  if (!ids.length) return Promise.resolve(0);
  return open().then(function (db) {
    var tx = db.transaction('vz15', 'readwrite');
    var os = tx.objectStore('vz15');
    var n = 0;
    ids.forEach(function (id) {
      var ring = data[id];
      if (!Array.isArray(ring)) return;
      for (var i = 0; i + 2 < ring.length; i += 3) {
        os.put({ siteId: siteId, memberId: id, ts: ring[i],
                 imp: ring[i + 1], exp: ring[i + 2] });
        n++;
      }
    });
    return txDone(tx).then(function () { return n; });
  });
}

/* rawRange(siteId, from, to) — rebuild a /api/vzev/raw-shaped object from the
   archive so lib/vzev.js (flows15m / quality / buildBilling) runs unchanged
   over an arbitrary period instead of the device's short buffer (FR-1105). */
function rawRange(siteId, from, to) {
  return Promise.all([
    getMeta(siteId),
    open().then(function (db) {
      return req(store(db, 'vz15', 'readonly').getAll(
        IDBKeyRange.bound([siteId, '', from === undefined || from === null ? 0 : from],
                          [siteId, '￿', to === undefined || to === null ? 9999999999 : to])));
    })
  ]).then(function (res) {
    var meta = res[0];
    var rows = res[1] || [];
    var lo = (from === undefined || from === null) ? 0 : from;
    var hi = (to === undefined || to === null) ? 9999999999 : to;
    var data = {};
    rows.sort(function (a, b) {
      return a.memberId === b.memberId ? a.ts - b.ts : (a.memberId < b.memberId ? -1 : 1);
    });
    rows.forEach(function (r) {
      if (r.ts < lo || r.ts > hi) return;     /* memberId-major key range is coarse */
      var ring = data[r.memberId];
      if (!ring) { ring = []; data[r.memberId] = ring; }
      ring.push(r.ts, r.imp, r.exp);
    });
    return {
      producer_id: meta.producerId, self_id: meta.selfId,
      tariffs: meta.tariffs, data: data
    };
  });
}

/* --- coverage & gaps ----------------------------------------------------- */

/* gapsOf(tsList) — runs of missing 15-min slots between the first and the last
   archived ts. Gaps are REPORTED, never filled (spec 001 FR-109 / UC-104). */
function gapsOf(tsList) {
  var gaps = [];
  for (var i = 1; i < tsList.length; i++) {
    var prev = tsList[i - 1], cur = tsList[i];
    if (cur - prev > SLOT) {
      gaps.push([prev + SLOT, cur - SLOT]);
      if (gaps.length >= MAX_GAPS) break;
    }
  }
  return gaps;
}

function scan(siteId) {
  return open().then(function (db) {
    return req(store(db, 'e15', 'readonly').getAllKeys(boundRange(siteId)));
  }).then(function (keys) {
    var ts = (keys || []).map(function (k) { return k[1]; });
    ts.sort(function (a, b) { return a - b; });
    return {
      count: ts.length,
      firstE15Ts: ts.length ? ts[0] : null,
      lastE15Ts: ts.length ? ts[ts.length - 1] : null,
      gaps: gapsOf(ts)
    };
  });
}

/* coverage(siteId) — what the «Daten» tab shows (FR-1107). `estimate` is the
   browser's storage estimate where available, otherwise null. */
function coverage(siteId) {
  return Promise.all([getMeta(siteId), scan(siteId), estimate()])
    .then(function (r) {
      var meta = r[0], sc = r[1];
      return {
        siteId: siteId,
        firstE15Ts: sc.firstE15Ts, lastE15Ts: sc.lastE15Ts,
        count: sc.count, gaps: sc.gaps,
        lastVzTs: meta.lastVzTs, syncedAt: meta.syncedAt,
        days: sc.firstE15Ts === null ? 0
          : Math.max(1, Math.round((sc.lastE15Ts - sc.firstE15Ts) / 86400)),
        estimate: r[2]
      };
    });
}

function estimate() {
  if (typeof navigator === 'undefined' || !navigator.storage || !navigator.storage.estimate) {
    return Promise.resolve(null);
  }
  return navigator.storage.estimate().then(function (e) { return e; },
    function () { return null; });
}

function requestPersist() {
  if (persistAsked) return Promise.resolve(null);
  persistAsked = true;
  if (typeof navigator === 'undefined' || !navigator.storage || !navigator.storage.persist) {
    return Promise.resolve(null);
  }
  return navigator.storage.persist().then(function (ok) { return ok; },
    function () { return null; });
}

/* --- sync ---------------------------------------------------------------- */

/* sync(api, siteId) — pull everything the device has that the archive lacks
   (FR-1103) and return the fresh coverage.

   Energy is paged with `from = lastE15Ts + SLOT`; the first sync of a session
   rewinds two days so late or corrected buckets (device clock step) are picked
   up again — upserts make that harmless. Requests go through api.js's queue
   (MAX_INFLIGHT = 2), so a long sync never starves the live polls. */
function sync(api, siteId) {
  var meta;
  return getMeta(siteId).then(function (m) {
    meta = m;
    var from = 0;
    if (m.lastE15Ts !== null && m.lastE15Ts !== undefined) {
      from = m.lastE15Ts + SLOT;
      if (!sessionSynced[siteId]) from = Math.max(0, m.lastE15Ts - REFETCH_S);
    }
    sessionSynced[siteId] = true;
    return pullEnergy(api, siteId, from);
  }).then(function () {
    return api.getVzevRaw ? api.getVzevRaw().catch(function () { return null; })
      : Promise.resolve(null);
  }).then(function (raw) {
    if (!raw || !raw.data) return null;
    if (raw.producer_id !== undefined) meta.producerId = raw.producer_id;
    if (raw.self_id !== undefined) meta.selfId = raw.self_id;
    if (raw.tariffs) meta.tariffs = raw.tariffs;
    return putRaw(siteId, raw).then(function () {
      meta.lastVzTs = newestRawTs(raw);
    });
  }).then(function () {
    return scan(siteId);
  }).then(function (sc) {
    /* concurrent tabs: keep the larger lastE15Ts (spec edge case) */
    meta.firstE15Ts = sc.firstE15Ts;
    meta.lastE15Ts = sc.lastE15Ts;
    meta.count = sc.count;
    meta.gaps = sc.gaps;
    meta.syncedAt = Math.floor(Date.now() / 1000);
    return putMeta(meta);
  }).then(function () {
    return requestPersist();
  }).then(function () {
    return coverage(siteId);
  });
}

function pullEnergy(api, siteId, from) {
  var pages = 0;
  function step(cursor) {
    if (pages >= MAX_PAGES) return Promise.resolve();
    pages++;
    return api.getEnergy('15m', PAGE, cursor).then(function (recs) {
      if (!Array.isArray(recs) || !recs.length) return null;
      return putEnergy(siteId, recs).then(function () {
        var newest = recs[recs.length - 1].ts;
        recs.forEach(function (r) { if (r.ts > newest) newest = r.ts; });
        if (recs.length < PAGE) return null;
        return step(newest + SLOT);
      });
    });
  }
  return step(from);
}

function newestRawTs(raw) {
  var data = (raw && raw.data) || {};
  var newest = null;
  Object.keys(data).forEach(function (id) {
    var ring = data[id];
    if (!Array.isArray(ring)) return;
    for (var i = 0; i + 2 < ring.length; i += 3) {
      if (newest === null || ring[i] > newest) newest = ring[i];
    }
  });
  return newest;
}


/* --- live power rings (Uebersicht sparklines) -----------------------------
   The device keeps a 15-min ring for the METER only (/api/power); per load and
   per production it serves a snapshot, so the Uebersicht builds those series in
   the browser (uebersicht.js pushHistory). Without persistence a reload throws
   that away and every sparkline stays empty for 15 min while the Netzanschluss
   chart is complete immediately - these two functions close that gap.

   One row per (siteId, kind, id) holding a flat [t,y,t,y,...] ring: rewritten
   in full on every poll, so the store never grows past the ids in use. A null y
   («unbekannt») survives the round trip as null, never as 0. */

function liveRange(siteId) {
  return IDBKeyRange.bound([siteId, '', ''], [siteId, '￿', '￿']);
}

/* putLive(siteId, kind, map) - persist {id: [{t,y}, ...]} for one kind
   ('prod' | 'load'). Best effort: callers ignore a rejection. */
function putLive(siteId, kind, map) {
  var ids = Object.keys(map || {});
  if (!siteId || !ids.length) return Promise.resolve(0);
  return open().then(function (db) {
    var tx = db.transaction('live', 'readwrite');
    var os = tx.objectStore('live');
    ids.forEach(function (id) {
      var pts = map[id] || [];
      var flat = [];
      for (var i = 0; i < pts.length; i++) {
        flat.push(pts[i].t, norm(pts[i].y));
      }
      os.put({ siteId: siteId, kind: kind, id: String(id), pts: flat });
    });
    return txDone(tx).then(function () { return ids.length; });
  });
}

/* getLive(siteId, kind, from) - the stored rings as {id: [{t,y}, ...]}, oldest
   first, dropping every point older than `from` (the current chart window), so
   a tab that was closed for hours rehydrates to nothing rather than to a stale
   line. */
function getLive(siteId, kind, from) {
  var lo = (from === undefined || from === null) ? 0 : from;
  return open().then(function (db) {
    return req(store(db, 'live', 'readonly').getAll(liveRange(siteId)));
  }).then(function (rows) {
    var out = {};
    (rows || []).forEach(function (r) {
      if (!r || r.kind !== kind || !Array.isArray(r.pts)) return;
      var pts = [];
      for (var i = 0; i + 1 < r.pts.length; i += 2) {
        if (r.pts[i] < lo) continue;
        pts.push({ t: r.pts[i], y: r.pts[i + 1] });
      }
      if (pts.length) out[r.id] = pts;
    });
    return out;
  });
}

/* --- export / import (FR-1110) ------------------------------------------- */

/* exportText(siteId) — the whole archive as one CSV. Row 1 identifies the
   archive (format version + site id) so an import can refuse a foreign file;
   `e` rows are 15-min records, `v` rows peer slots. */
function exportText(siteId) {
  return Promise.all([
    open().then(function (db) { return req(store(db, 'e15', 'readonly').getAll(boundRange(siteId))); }),
    open().then(function (db) {
      return req(store(db, 'vz15', 'readonly').getAll(
        IDBKeyRange.bound([siteId, '', 0], [siteId, '￿', 9999999999])));
    })
  ]).then(function (res) {
    var rows = [];
    (res[0] || []).sort(function (a, b) { return a.ts - b.ts; }).forEach(function (r) {
      rows.push(['e', r.ts, blank(r.imp_wh), blank(r.exp_wh), blank(r.pv_wh),
                 r.partial ? '1' : '0', blank(r.bat_chg_wh), blank(r.bat_dis_wh)]);
    });
    (res[1] || []).sort(function (a, b) {
      return a.memberId === b.memberId ? a.ts - b.ts : (a.memberId < b.memberId ? -1 : 1);
    }).forEach(function (r) {
      rows.push(['v', r.ts, r.memberId, blank(r.imp), blank(r.exp), '']);
    });
    return csvBuild([DB_NAME, EXPORT_FORMAT, siteId], rows);
  });
}

function blank(v) { return (v === null || v === undefined) ? '' : String(v); }

/* importText(text, siteId) — merge a previously exported file (upsert, never
   deletes). Rejects a file whose site id differs from the current device's. */
function importText(text, siteId) {
  var rows = csvParse(text);
  if (!rows.length || rows[0][0] !== DB_NAME) {
    return Promise.reject(new Error('not a gplug archive export'));
  }
  if (IMPORT_FORMATS.indexOf(rows[0][1]) < 0) {
    return Promise.reject(new Error('unsupported export format ' + rows[0][1]));
  }
  var fileSite = rows[0][2];
  if (siteId && fileSite !== siteId) {
    return Promise.reject(new Error('site mismatch: file ' + fileSite + ', device ' + siteId));
  }
  var target = siteId || fileSite;
  var energy = [], peers = {};
  for (var i = 1; i < rows.length; i++) {
    var r = rows[i];
    if (!r || !r.length) continue;
    if (r[0] === 'e') {
      var rec = { ts: Number(r[1]), imp_wh: numOrNull(r[2]), exp_wh: numOrNull(r[3]),
                  pv_wh: numOrNull(r[4]) };
      if (r[5] === '1') rec.partial = true;
      putBattery(rec, { bat_chg_wh: numOrNull(r[6]), bat_dis_wh: numOrNull(r[7]) });
      energy.push(rec);
    } else if (r[0] === 'v') {
      var id = r[2];
      if (!peers[id]) peers[id] = [];
      peers[id].push(Number(r[1]), numOrZero(r[3]), numOrZero(r[4]));
    }
  }
  return putEnergy(target, energy)
    .then(function () { return putRaw(target, { data: peers }); })
    .then(function () { return scan(target); })
    .then(function (sc) {
      return getMeta(target).then(function (meta) {
        meta.firstE15Ts = sc.firstE15Ts;
        meta.lastE15Ts = sc.lastE15Ts;
        meta.count = sc.count;
        meta.gaps = sc.gaps;
        return putMeta(meta);
      });
    })
    .then(function () { return coverage(target); });
}

function numOrNull(v) { return (v === '' || v === undefined) ? null : Number(v); }
function numOrZero(v) { return (v === '' || v === undefined) ? 0 : Number(v); }

/* clearSite(siteId) — drop one archive (a renamed site, or freeing space). */
function clearSite(siteId) {
  return open().then(function (db) {
    var tx = db.transaction(['e15', 'vz15', 'meta', 'live'], 'readwrite');
    tx.objectStore('e15').delete(boundRange(siteId));
    tx.objectStore('vz15').delete(
      IDBKeyRange.bound([siteId, '', 0], [siteId, '￿', 9999999999]));
    tx.objectStore('meta').delete(siteId);
    tx.objectStore('live').delete(liveRange(siteId));
    return txDone(tx);
  });
}

/* --- page glue ------------------------------------------------------------
   Everything below is the impure half: it owns the site id, the boot sync and
   the 15-min re-sync, and lets pages subscribe to coverage changes. Pure
   consumers (aggregate.js, vzev.js, insights.js) never see it. */

var RESYNC_MS = 15 * 60 * 1000;
var st = { available: null, siteId: null, coverage: null, error: null, syncing: false,
           otherSites: [] };
var listeners = [];
var readyPromise = null;
var timer = null;

function state() { return st; }

function notify() {
  listeners.forEach(function (cb) { try { cb(st); } catch (e) { /* isolated */ } });
}

/* onChange(cb) -> unsubscribe. Fires after every sync and on the first
   availability verdict. */
function onChange(cb) {
  listeners.push(cb);
  return function () {
    var i = listeners.indexOf(cb);
    if (i >= 0) listeners.splice(i, 1);
  };
}

/* start(api) — called once at boot (main.js). Resolves the site id, syncs, and
   keeps syncing every 15 min while the page lives. Never rejects: a blocked or
   missing IndexedDB just leaves `available: false` and every page falls back to
   the live device buffer (FR-1111). */
function start(api) {
  if (readyPromise) return readyPromise;
  readyPromise = available().then(function (ok) {
    st.available = ok;
    if (!ok) { notify(); return st; }
    return api.getSite().then(function (site) {
      st.siteId = (site && site.id) ? String(site.id) : null;
      if (!st.siteId) { st.available = false; notify(); return st; }
      /* FR-1102: the archive belongs to the site id, not the origin. A device
         that reports a different id under the same origin gets its own
         archive; the UI says so once instead of silently mixing them. */
      return listSites().then(function (ids) {
        st.otherSites = ids.filter(function (id) { return id !== st.siteId; });
      }, function () { /* listing is best effort */ }).then(function () {
        return runSync(api);
      }).then(function () {
        if (timer === null && typeof setInterval === 'function') {
          timer = setInterval(function () { runSync(api); }, RESYNC_MS);
        }
        return st;
      });
    }, function () {
      /* device unreachable at boot — keep the archive usable for reads */
      notify();
      return st;
    });
  });
  return readyPromise;
}

function runSync(api) {
  if (!st.available || !st.siteId || st.syncing) return Promise.resolve(st);
  st.syncing = true;
  return sync(api, st.siteId).then(function (cov) {
    st.coverage = cov;
    st.error = null;
  }, function (e) {
    st.error = e && e.message ? e.message : 'sync failed';
  }).then(function () {
    st.syncing = false;
    notify();
    return st;
  });
}

/* ready() — resolves once the boot sync has settled; pages await it before
   deciding whether to read from the archive or from the device. */
function ready() {
  return readyPromise || Promise.resolve(st);
}

/* refresh(api) — force a sync now («Daten» tab button, after an import). */
function refresh(api) { return runSync(api); }

export {
  available, open, sync, range, rawRange, coverage, listSites,
  start, ready, refresh, state, onChange,
  exportText, importText, clearSite, putEnergy, putRaw, getMeta,
  putLive, getLive,
  DB_NAME, DB_VERSION, SLOT, PAGE, EXPORT_FORMAT
};
