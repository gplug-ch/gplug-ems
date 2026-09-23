/* Data layer (FR-214) — thin fetch wrappers over the device HTTP API plus a
   visibility-aware poll() helper. Base URL derives from window.location with
   a ?host= override for development against a remote device. */

function base() {
    var params = new URLSearchParams(window.location.search);
    var host = params.get('host');
    if (host) return 'http://' + host;
    return '';
  }

  var statusListeners = [];
  var online = true;
  var lastOk = null;

  function setOnline(v) {
    if (v) lastOk = Date.now();
    if (v === online) return;
    online = v;
    statusListeners.forEach(function (cb) { cb(online, lastOk); });
  }

  /* Connectivity accounting. Two rules keep the «Verbindung verloren» toast
     honest:
     1. Only a *transport* failure counts — a TypeError (fetch could not reach
        the device) or an AbortError (our own timeout). An HTTP status like 404
        or 500 PROVES the device answered, so it marks us online; an optional
        endpoint that 404s must not toast «offline» on every poll.
     2. A single blip never toasts: the device is a single-threaded ESP32 web
        server, so one slow/aborted request under load is normal. Offline is
        declared only after FAIL_THRESHOLD consecutive transport failures. */
  var FAIL_THRESHOLD = 3;
  var failStreak = 0;

  function isTransportError(e) {
    return (e instanceof TypeError) || (e && e.name === 'AbortError');
  }
  function markReached() { failStreak = 0; setOnline(true); }
  function markFailed(opts) {
    /* best-effort probes never drive the global status */
    if (opts && opts.optional) return;
    failStreak++;
    if (failStreak >= FAIL_THRESHOLD) setOnline(false);
  }

  /* Per-request timeout (ms). The device streams JSON in chunks over flaky
     Wi‑Fi; without an abort a stalled/half-sent response would hang until the
     browser's multi-minute default (surfacing as ERR_CONNECTION_TIMED_OUT /
     ERR_INCOMPLETE_CHUNKED_ENCODING). Aborting fast lets the next poll retry.
     The timer starts when the request is actually dispatched (see schedule()),
     not while it waits in our client-side queue. */
  var REQUEST_TIMEOUT_MS = 8000;

  /* Client-side concurrency cap. Tasmota's web server handles ONE request at a
     time; a page that fires several in a Promise.all (Übersicht: power + loads +
     productions + ...) makes the last ones wait behind the
     others on the device and blow the abort timeout. Queue them here instead
     so at most MAX_INFLIGHT are outstanding and each one's timeout measures
     real device time. */
  var MAX_INFLIGHT = 2;
  var inflight = 0;
  var pending = [];

  function pump() {
    while (inflight < MAX_INFLIGHT && pending.length > 0) {
      var job = pending.shift();
      inflight++;
      job.run().then(job.resolve, job.reject).finally(function () {
        inflight--;
        pump();
      });
    }
  }

  function schedule(run) {
    return new Promise(function (resolve, reject) {
      pending.push({ run: run, resolve: resolve, reject: reject });
      pump();
    });
  }

  /* request(path, opts) — queued GET with timeout + status accounting.
     opts.text: resolve with the raw body instead of parsed JSON.
     opts.optional: best-effort probe, never flips the connection status. */
  function request(path, opts) {
    opts = opts || {};
    return schedule(function () {
      var ctrl = new AbortController();
      var timer = setTimeout(function () { ctrl.abort(); }, REQUEST_TIMEOUT_MS);
      return fetch(base() + path, { signal: ctrl.signal })
        .then(function (r) {
          /* any HTTP answer means the device is reachable */
          markReached();
          if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + path);
          return opts.text ? r.text() : r.json();
        })
        .catch(function (e) {
          if (isTransportError(e)) markFailed(opts);
          throw e;
        })
        .finally(function () { clearTimeout(timer); });
    });
  }

  /* get(path, opts) — plain queued GET (see request) */
  function get(path, opts) { return request(path, opts); }

  /* poll(fn, ms) — run fn immediately and every ms; pauses while the tab is
     hidden (battery/network hygiene) and resumes on visibility. Returns stop(). */
  function poll(fn, ms) {
    var timer = null;
    var stopped = false;

    function tick() { if (!document.hidden) fn(); }
    function start() {
      if (timer !== null || stopped) return;
      tick();
      timer = setInterval(tick, ms);
    }
    function pause() {
      if (timer !== null) { clearInterval(timer); timer = null; }
    }
    function onVis() { document.hidden ? pause() : start(); }

    document.addEventListener('visibilitychange', onVis);
    start();
    return function stop() {
      stopped = true;
      pause();
      document.removeEventListener('visibilitychange', onVis);
    };
  }

  /* POST JSON body; returns parsed JSON. Throws Error(message) with the
     server-supplied error text on non-2xx (spec 006 FR-601 graceful degrade). */
  function post(path, body) {
    return schedule(function () {
      return fetch(base() + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      })
        .then(function (r) {
          return r.text().then(function (txt) {
            var data = null;
            try { data = txt ? JSON.parse(txt) : null; } catch (e) { /* non-JSON body */ }
            markReached();
            if (!r.ok) {
              var msg = (data && data.error) || ('HTTP ' + r.status);
              throw new Error(msg);
            }
            return data;
          });
        })
        .catch(function (e) {
          /* network failure vs. server 400: only transport errors count */
          if (isTransportError(e)) markFailed();
          throw e;
        });
    });
  }

  function isBlank(v) { return v === undefined || v === null || String(v).trim() === ''; }

  /* Tasmota's own HTTP command endpoint (firmware-level, not webservice.be) —
     used for device operations (restart, Wi-Fi config, Wi-Fi scan) that live
     outside the EMS Berry backend. Same base()/CORS behaviour as get(). */
  function cmnd(command) {
    return request('/cm?cmnd=' + encodeURIComponent(command));
  }

export const api = {
    base: base,
    get: get,
    post: post,
    /* device restart (Tasmota `Restart 1` — reboots with config saved) */
    restartDevice: function () { return cmnd('Restart 1'); },
    /* current primary/secondary Wi-Fi SSIDs (passwords are never readable —
       Tasmota masks them, so the form always starts with empty password fields) */
    getWifiConfig: function () {
      return Promise.all([cmnd('SSId1'), cmnd('SSId2')]).then(function (r) {
        return {
          ssid1: (r[0] && r[0].SSId1) || '',
          ssid2: (r[1] && r[1].SSId2) || ''
        };
      });
    },
    /* Setting SSId<x>/Password<x> each triggers a restart; batching them in one
       Backlog applies all four before that restart happens. Blank passwords
       are omitted so an unchanged (masked) field does not clear the password. */
    setWifiConfig: function (cfg) {
      cfg = cfg || {};
      var parts = [];
      if (!isBlank(cfg.ssid1)) parts.push('SSId1 ' + cfg.ssid1);
      if (!isBlank(cfg.password1)) parts.push('Password1 ' + cfg.password1);
      if (!isBlank(cfg.ssid2)) parts.push('SSId2 ' + cfg.ssid2);
      if (!isBlank(cfg.password2)) parts.push('Password2 ' + cfg.password2);
      if (parts.length === 0) return Promise.resolve({});
      return cmnd('Backlog ' + parts.join(';'));
    },
    /* Wi-Fi scan: WifiScan 1 starts an async scan; poll wifiScanResult() until
       it returns network entries (result stays "Scanning"/"Busy" as a string
       until done, per Tasmota's WifiScan command). */
    wifiScanStart: function () { return cmnd('WifiScan 1'); },
    wifiScanResult: function () { return cmnd('WifiScan'); },
    /* spec 006 config document */
    getConfig: function () { return get('/api/config'); },
    postConfig: function (doc) { return post('/api/config', doc); },
    /* Pro mode (raw site.json editor): fetch the config as verbatim text so the
       editor shows the exact file (unknown keys included), not a re-serialised
       object. Separate from get() because that parses JSON. */
    getConfigRaw: function () { return request('/api/config', { text: true }); },
    /* spec 001 endpoints */
    getPower: function () { return get('/api/power'); },
    /* spec 011 FR-1122: 15m is the only resolution the device serves — the
       day/month roll-ups are derived in the browser from the archive. */
    getEnergy: function (res, count, from, to) {
      if (res && res !== '15m') throw new Error('getEnergy: res must be 15m');
      var q = '/api/energy?res=15m&count=' + (count || 96);
      if (from !== undefined) q += '&from=' + from;
      if (to !== undefined) q += '&to=' + to;
      return get(q);
    },
    getMeta: function () { return get('/api/meta'); },
    /* spec 007 — raw smart-meter descriptor passthrough: { now, values } where
       values is the Tasmota SMI sensor object (key `z`) or null. The browser
       (pages/zaehler.js + lib/metercat.js) does all interpretation. */
    getMeter: function () { return get('/api/meter'); },
    /* existing endpoints */
    getSite: function () { return get('/site'); },
    getLoads: function () { return get('/loads'); },
    getProductions: function () { return get('/productions'); },
    /* standalone Modbus registers (site.json "modbusRegisters") — named
       registers that don't fit loads/productions/grid, e.g. a submeter
       behind a Modbus TCP gateway. Each entry carries its own config
       (friendlyName/register/unitLabel/...) plus the live "currentPower". */
    getModbus: function () { return get('/api/modbus'); },
    setLoadState: function (id, state) {
      return get('/loads?id=' + encodeURIComponent(id) + '&action=transition&to=' + encodeURIComponent(state));
    },
    poll: poll,
    onStatus: function (cb) {
      statusListeners.push(cb);
      return function () {
        var i = statusListeners.indexOf(cb);
        if (i >= 0) statusListeners.splice(i, 1);
      };
    },
    isOnline: function () { return online; },
    lastOk: function () { return lastOk; }
};
