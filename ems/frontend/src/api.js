/* Data layer (FR-214) — thin fetch wrappers over the device HTTP API plus a
   visibility-aware poll() helper. Base URL derives from window.location with
   a ?host= override for development against a remote device. */
import * as vzev from './lib/vzev.js';

function base() {
    var params = new URLSearchParams(window.location.search);
    var host = params.get('host');
    if (host) return 'http://' + host;
    return '';
  }

  var statusListeners = [];
  var online = true;
  var lastOk = null;

  /* vZEV 'enabled' pub/sub: the Shell's nav gate needs to react the instant
     Einstellungen saves the toggle, not on the next 60s poll or a reload —
     both getVzevInfo (read) and setVzevInfo (save) push here so any listener
     (just the Shell today) picks up the change immediately, same-tab. */
  var vzevListeners = [];
  function notifyVzev(info) {
    vzevInfo = info || {};
    vzevKnown = true;
    vzevListeners.forEach(function (cb) { cb(info); });
  }

  /* vZEV request gate. The community endpoints are polled from several places
     (Ubersicht panel every 10s, archive sync, Abrechnung), but a site without
     an energy community has vZEV switched off in Einstellungen -- every one of
     those reads is then pure noise on a single-threaded ESP32 web server.
     Block them centrally in get() rather than at each call site, so a disabled
     community produces NO /api/vzev/* traffic at all. /api/vzev/info is
     exempt: it carries the toggle itself. */
  var vzevInfo = null;     /* last /api/vzev/info payload */
  var vzevKnown = false;   /* info answered at least once */
  var vzevProbe = null;    /* in-flight/settled first read */

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
        or 500 PROVES the device answered, so it marks us online; optional
        endpoints (/api/vzev/* on a site without a community) used to 404 on
        every 10s poll and toast «offline» each time.
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
     time; a page that fires five in a Promise.all (Übersicht: power + loads +
     productions + vzev members + raw) makes the last ones wait behind the
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

  function isVzevInfoPath(p) { return p.indexOf('/api/vzev/info') === 0; }
  function isVzevPath(p) {
    return p.indexOf('/api/vzev/') === 0 && !isVzevInfoPath(p);
  }

  /* Unknown state (info never answered -- e.g. a firmware without the route)
     leaves the gate OPEN so such devices behave exactly as before. */
  function vzevAllowed() {
    return !vzevKnown || !!(vzevInfo && vzevInfo.enabled);
  }

  /* neutral payloads so a blocked read resolves in the shape callers expect */
  function vzevBlocked(path) {
    if (path.indexOf('/api/vzev/members') === 0) return { members: [] };
    if (path.indexOf('/api/vzev/discovered') === 0) return { discovered: [] };
    return null;
  }

  /* read the toggle once before the first gated request; failures leave the
     gate open (see vzevAllowed) and are never retried in a loop */
  function vzevReady() {
    if (vzevKnown) return Promise.resolve();
    if (!vzevProbe) {
      vzevProbe = request('/api/vzev/info', OPT).then(function (info) {
        notifyVzev(info || {});
      }, function () { /* route absent/offline: gate stays open */ });
    }
    return vzevProbe;
  }

  /* opts.vzevBypass: read a vZEV endpoint even while the community is off.
     Only the Einstellungen vZEV tab uses it — that page IS the toggle, and its
     producer/member counts must show the real registry so a user can see what
     switching vZEV back on would bring. One read on an explicit page visit,
     not a poll. */
  function get(path, opts) {
    if (isVzevPath(path) && !(opts && opts.vzevBypass)) {
      return vzevReady().then(function () {
        return vzevAllowed() ? request(path, opts) : vzevBlocked(path);
      });
    }
    return request(path, opts);
  }

  /* shorthand for best-effort reads (optional/absent endpoints) */
  var OPT = { optional: true };

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
    /* spec 005 vZEV: the device serves ONLY the raw per-member peer-slot rings;
       allocation, flow bucketing and billing are computed in the browser
       (lib/vzev.js) so the ESP32-C3 heap does none of it.
       All /api/vzev/* reads are marked OPT (best-effort): the routes only exist
       once main.be has loaded vzev.be, and the Übersicht polls them every 10s —
       their failures must never surface as «Verbindung verloren». */
    getVzevRaw: function () { return get('/api/vzev/raw', OPT); },
    /* /api/vzev/members and /api/vzev/discovered serve bare JSON arrays
       (see members_request/discovered_request in vzev.be) — normalize here so
       callers always get a plain array regardless of that wire shape. */
    getVzevMembersList: function () {
      return get('/api/vzev/members', OPT).then(function (d) {
        return Array.isArray(d) ? d : ((d && d.members) || []);
      });
    },
    getVzevDiscovered: function () {
      return get('/api/vzev/discovered', OPT).then(function (d) {
        return Array.isArray(d) ? d : ((d && d.discovered) || []);
      });
    },
    /* spec 009 FR-903 — vZEV master data (representative + connection point),
       plus the 'enabled' toggle that gates the vZEV nav entry. Read returns
       {representative_name, representative_contact, connection_point_id,
       enabled}; save uses the same query-arg mutate pattern as the members
       endpoint. Both tolerate a device without spec 009 (404 -> {}). */
    getVzevInfo: function () {
      /* on failure do NOT notify: an absent route must not be recorded as
         `enabled: false`, which would gate every other vZEV read away */
      return get('/api/vzev/info', OPT).then(function (info) {
        notifyVzev(info || {});
        return info || {};
      }, function () { return {}; });
    },
    setVzevInfo: function (info) {
      info = info || {};
      var q = '/api/vzev/info?action=set';
      ['representative_name', 'representative_contact', 'connection_point_id'].forEach(function (k) {
        if (info[k] !== undefined && info[k] !== null) {
          q += '&' + k + '=' + encodeURIComponent(info[k]);
        }
      });
      if (info.enabled !== undefined && info.enabled !== null) {
        q += '&enabled=' + (info.enabled ? 'true' : 'false');
      }
      return get(q).then(function (info) { notifyVzev(info); return info; });
    },
    /* Allocated per-member Wh series (FR-507), computed from the raw rings.
       Returns { flows: [{ts, members:{id->wh}}] } (callers read `.flows`). */
    getVzevFlows: function (res, count) {
      return get('/api/vzev/raw', OPT).then(function (raw) {
        return { flows: vzev.flows(raw, res || '15m', count || 90) };
      });
    },
    /* Quarterly settlement (former /api/vzev/billing) computed in the browser
       from the raw rings + the member registry (names) + tariffs (/api/meta).
       Rejects on an invalid quarter so the page shows its error state. */
    getVzevBilling: function (quarter, archivedRaw) {
      var rng = vzev.quarterRange(quarter);
      if (!rng) return Promise.reject(new Error('invalid quarter'));
      return Promise.all([
        /* spec 011 UC-1102: the browser archive holds every peer slot it ever
           fetched, so a settlement runs over the WHOLE quarter instead of the
           few days the device still buffers. The caller passes the archived
           slots; without an archive the live device rings are used as before. */
        archivedRaw ? Promise.resolve(archivedRaw) : get('/api/vzev/raw', OPT),
        get('/api/vzev/members', OPT).catch(function () { return { members: [] }; }),
        get('/api/meta').catch(function () { return {}; }),
        get('/api/vzev/info', OPT).catch(function () { return {}; }),
        get('/site').catch(function () { return {}; })
      ]).then(function (res) {
        var raw = res[0];
        var reg = (res[1] && res[1].members) ? res[1].members
          : (Array.isArray(res[1]) ? res[1] : []);
        var tariffs = (res[2] && res[2].tariffs) || {};
        /* cross-site cost consistency: /api/vzev/raw carries the community
           tariffs (producer-authoritative, distributed via its announcements).
           They override this device's local rates so every site prices the
           same Wh identically; local values remain the fallback until the
           producer has been heard. */
        if (raw && raw.tariffs) tariffs = Object.assign({}, tariffs, raw.tariffs);
        var info = res[3] || {};
        var site = res[4] || {};
        var inrange = vzev.flows15m(raw).filter(function (f) {
          return f.ts >= rng[0] && f.ts < rng[1];
        });
        /* spec 009: quality summary over the quarter (FR-906) is computed from
           the same raw rings and threaded into the billing so the Abrechnung
           page shows completeness/provisional markers from one source. */
        var qual = vzev.quality(raw, reg, rng);
        var bill = vzev.buildBilling(quarter, inrange, reg, tariffs, qual);
        bill.info = info;          /* Vertreter/Netzanschlusspunkt for statements */
        bill.raw = raw;            /* enable per-slot drill-down (FR-908) */
        bill.range = rng;
        bill.tariffs = tariffs;    /* internal tariff + HT/NT for the statement */

        /* role: this device is the producer iff its own site id equals the
           community's producer id (both now reliably resolved via vzev.be's
           _producer_id() productions fallback). The member registry (`reg`)
           never has a self-entry — there is no "add myself" path — so a
           consumer's own row in bill.members would otherwise fall back to
           its raw site id as `name`; look up the real one from /site and
           expose it as `bill.self` so Abrechnung renders the single-card
           ConsumerView (title/labels priced as Kosten) instead of the
           producer's Total + per-member layout (labelled Gewinn). */
        var selfId = raw && raw.self_id;
        var producerId = raw && raw.producer_id;
        if (selfId !== undefined && selfId !== null) {
          if (selfId === producerId) {
            bill.role = 'PRODUCER';
          } else {
            bill.role = 'CONSUMER';
            var own = bill.members.filter(function (m) { return m.id === selfId; })[0];
            bill.self = own
              ? Object.assign({}, own, { name: site.name || own.name })
              : { id: selfId, name: site.name || selfId, wh: 0, chf: 0, months: [] };
          }
        }
        return bill;
      });
    },
    /* Übersicht vZEV panel (spec 003 UC-304 / FR-513): registry members
       enriched with a per-member live power series + window total, computed in
       the browser from /api/vzev/raw. Rejects when spec 005 is absent
       (endpoints 404) so the panel stays hidden (FR-310). */
    getVzevMembers: function () {
      return Promise.all([
        get('/api/vzev/members', OPT),
        get('/api/vzev/raw', OPT)
      ]).then(function (res) {
        var reg = res[0] && res[0].members ? res[0].members : (Array.isArray(res[0]) ? res[0] : []);
        var flows = vzev.flows(res[1], '15m', 90);
        return reg.map(function (m) {
          /* Direction is set by the member's role: a PRODUCER member feeds this
             (consumer) site → Import (net_wh > 0); a CONSUMER member is fed by
             this (producer) site → Export (net_wh < 0). VzevPanel reads the sign
             to pick the Export/Import label (FR-513); magnitude is |net_wh|. */
          var isProducer = m.type === 'PRODUCER' || m.typ === 'P';
          var sign = isProducer ? 1 : -1;
          var points = flows.map(function (f) {
            var v = f.members && f.members[m.id];
            return { t: f.ts, y: typeof v === 'number' ? v : 0 };
          });
          var mag = points.reduce(function (a, p) { return a + (p.y || 0); }, 0);
          return { id: m.id, name: m.name || m.id, address: m.location || m.loc,
                   net_wh: sign * mag, points: points };
        });
      });
    },
    poll: poll,
    onStatus: function (cb) {
      statusListeners.push(cb);
      return function () {
        var i = statusListeners.indexOf(cb);
        if (i >= 0) statusListeners.splice(i, 1);
      };
    },
    onVzevInfo: function (cb) {
      vzevListeners.push(cb);
      return function () {
        var i = vzevListeners.indexOf(cb);
        if (i >= 0) vzevListeners.splice(i, 1);
      };
    },
    isOnline: function () { return online; },
    lastOk: function () { return lastOk; }
};
