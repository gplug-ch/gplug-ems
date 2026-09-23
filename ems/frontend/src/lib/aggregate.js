/* Pure aggregation helpers for the Verlauf history page (spec 004 FR-401,
   FR-408, FR-409). No DOM — unit-testable under `node`.

   Native API rings (spec 001): 15m, 1d, 1mo. Coarser resolutions (Stunden,
   Wochen, Quartale) are derived client-side from the finest covering ring:
     Stunden  = 4 × 15m   (bucket by wall-clock hour)
     Wochen   = 7 × 1d    (ISO week, Monday–Sunday)
     Quartale = 3 × 1mo   (calendar quarter)
   Aggregation SUMS the Wh fields and RE-DERIVES CHF from the summed Wh via
   the tariff formulas (spec 001 FR-108) — never by summing rounded CHF. */
var WH_FIELDS = ['imp_wh', 'exp_wh', 'pv_wh'];
/* spec 009 FR-909: the grid-import Wh split by tariff window, carried
   alongside WH_FIELDS so coarse buckets sum the split instead of re-deriving
   it from re-averaged coarse Wh. Only populated when HT/NT is configured. */
var HTNT_FIELDS = ['grid_ht_wh', 'grid_nt_wh'];
/* issue #20: battery charge/discharge Wh — summed like HTNT_FIELDS (only when
   a source record has them, and a null never makes the bucket partial), so a
   site without a battery aggregates exactly as before */
var BAT_FIELDS = ['bat_chg_wh', 'bat_dis_wh'];

  function round2(v) {
    if (v === null || v === undefined || isNaN(v)) return null;
    /* round half away from zero, matching the device's Rappen rounding */
    return Math.round((v + (v >= 0 ? 1 : -1) * 1e-9) * 100) / 100;
  }

  /* Cost re-derivation from Wh quantities + tariffs (spec 001 FR-108).
     `null` quantities propagate to `null` cost fields. Returns a shallow copy
     of `rec` with the CHF fields recomputed. */
  function deriveCosts(rec, tariffs) {
    tariffs = tariffs || {};
    var gi = num(tariffs.grid_import_chf_kwh, 0.26);
    var gf = num(tariffs.grid_feedin_chf_kwh, 0.18);

    var imp = rec.imp_wh, exp = rec.exp_wh, pv = rec.pv_wh;
    var out = {};
    for (var k in rec) out[k] = rec[k];

    out.cost_import_chf = imp === null || imp === undefined
      ? null : round2(imp / 1000 * gi);
    out.revenue_feedin_chf = exp === null || exp === undefined
      ? null : round2(exp / 1000 * gf);
    out.saving_selfuse_chf = (pv === null || pv === undefined || exp === null || exp === undefined)
      ? null : round2(Math.max(0, (pv - exp) / 1000 * (gi - gf)));

    /* spec 009 FR-909: HT/NT grid-import cost split, derived from the split Wh
       carried up from the 15-min level. Only emitted when HT/NT is configured
       AND the split Wh are present, so the flat path stays bit-identical
       (NFR-903) and existing history tests are unaffected. cost_import_chf is
       overridden with the HT+NT sum so the total always equals the split. */
    if (hasHtNt(tariffs) && rec.grid_ht_wh !== undefined && rec.grid_nt_wh !== undefined) {
      var ght = num(tariffs.grid_import_ht_chf_kwh, gi);
      var gnt = num(tariffs.grid_import_nt_chf_kwh, gi);
      out.cost_import_ht_chf = round2(rec.grid_ht_wh / 1000 * ght);
      out.cost_import_nt_chf = round2(rec.grid_nt_wh / 1000 * gnt);
      out.cost_import_chf = round2(out.cost_import_ht_chf + out.cost_import_nt_chf);
    }
    return out;
  }

  function num(v, dflt) {
    return (v === null || v === undefined || isNaN(v)) ? dflt : Number(v);
  }

  /* spec 009 FR-909 — tariff-window classification (local time). */
  var DAY_TOKENS = { mo: 0, mon: 0, di: 1, tu: 1, tue: 1, mi: 2, we: 2, wed: 2,
                     do: 3, th: 3, thu: 3, fr: 4, fri: 4, sa: 5, sat: 5,
                     so: 6, su: 6, sun: 6 };

  function dayMatches(days, dow) {
    if (days === null || days === undefined || days === '') return true;
    if (typeof days === 'number') return ((days % 7) + 7) % 7 === dow;
    if (Array.isArray(days)) return days.some(function (d) { return dayMatches(d, dow); });
    if (typeof days !== 'string') return true;
    var parts = days.toLowerCase().split(/[\s,]+/).filter(Boolean);
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      var dash = p.indexOf('-');
      if (dash > 0) {
        var a = DAY_TOKENS[p.slice(0, dash)];
        var b = DAY_TOKENS[p.slice(dash + 1)];
        if (a !== undefined && b !== undefined) {
          if (a <= b) { if (dow >= a && dow <= b) return true; }
          else { if (dow >= a || dow <= b) return true; }
        }
      } else if (DAY_TOKENS[p] !== undefined && DAY_TOKENS[p] === dow) {
        return true;
      }
    }
    return false;
  }

  function hasHtNt(tariffs) {
    tariffs = tariffs || {};
    var ht = tariffs.grid_import_ht_chf_kwh;
    var nt = tariffs.grid_import_nt_chf_kwh;
    var win = tariffs.ht_windows;
    return ht !== null && ht !== undefined && nt !== null && nt !== undefined &&
           Array.isArray(win) && win.length > 0;
  }

  /* 'ht' | 'nt' for a slot ts when HT/NT is configured (only called then). */
  function slotIsHt(ts, tariffs) {
    var d = new Date(ts * 1000);
    var dow = (d.getDay() + 6) % 7;
    var h = d.getHours() + d.getMinutes() / 60;
    var win = tariffs.ht_windows;
    for (var i = 0; i < win.length; i++) {
      var w = win[i] || {};
      if (dayMatches(w.days, dow) && h >= num(w.from, 0) && h < num(w.to, 0)) return true;
    }
    return false;
  }

  /* Pre-split a 15-min base record's grid-import Wh into
     grid_ht_wh / grid_nt_wh by the tariff window of its own ts. No-op (returns
     the record unchanged) when HT/NT is not configured, so the flat path and
     all existing tests are untouched (NFR-903). */
  function splitHtNt(rec, tariffs) {
    if (!hasHtNt(tariffs)) return rec;
    var imp = rec.imp_wh;
    if (imp === null || imp === undefined) return rec;
    var grid = Math.max(0, imp);
    var out = {};
    for (var k in rec) out[k] = rec[k];
    if (slotIsHt(rec.ts, tariffs)) { out.grid_ht_wh = grid; out.grid_nt_wh = 0; }
    else { out.grid_ht_wh = 0; out.grid_nt_wh = grid; }
    return out;
  }

  /* Sum Wh fields of `records` into one record with timestamp `ts`. `null`
     inputs are treated as unknown: if ANY summed value in a field is present
     the field is the sum of the present values; if a field is entirely null
     across all records it stays null. Sets `partial` if any source is partial
     or any field had a null hole. */
  function sumRecords(ts, records) {
    var out = { ts: ts };
    var anyPartial = false;
    WH_FIELDS.forEach(function (f) {
      var sum = 0, seen = false, hole = false;
      records.forEach(function (r) {
        var v = r[f];
        if (v === null || v === undefined) { hole = true; }
        else { sum += v; seen = true; }
      });
      out[f] = seen ? sum : null;
      if (seen && hole) anyPartial = true;
    });
    /* spec 009 FR-909: carry the HT/NT grid-import split forward by summation
       (only when the base records were pre-split), so coarse buckets keep the
       tariff split computed at the 15-min level. Fields are added only when at
       least one source record has them -> flat path output is unchanged. */
    HTNT_FIELDS.concat(BAT_FIELDS).forEach(function (f) {
      var sum = 0, seen = false;
      records.forEach(function (r) {
        var v = r[f];
        if (v !== null && v !== undefined) { sum += v; seen = true; }
      });
      if (seen) out[f] = sum;
    });
    records.forEach(function (r) { if (r.partial) anyPartial = true; });
    if (anyPartial) out.partial = true;
    out.count = records.length;
    return out;
  }

  /* Bucket start helpers — all operate on UTC epoch seconds and return the
     UTC bucket-start second (DST-safe: no local-time math). */
  function hourStart(ts) { return ts - (ts % 3600); }

  /* ISO week start (Monday 00:00 UTC) of the day containing ts.
     1970-01-01 (day 0) was a Thursday; days-since-epoch mod 7 gives
     Thu=0…Wed=6, so Monday=4. Shifting by +3 (≡ −4 mod 7) maps Monday→0. */
  function isoWeekStart(ts) {
    var daySec = ts - mod(ts, 86400);
    var dow = mod(Math.floor(daySec / 86400) + 3, 7);
    return daySec - dow * 86400;
  }

  function mod(a, n) { return ((a % n) + n) % n; }

  /* Month start (UTC) — uses Date for calendar correctness. */
  function monthStart(ts) {
    var d = new Date(ts * 1000);
    return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000);
  }

  /* Quarter start (UTC): first day of the calendar quarter. */
  function quarterStart(ts) {
    var d = new Date(ts * 1000);
    var q = Math.floor(d.getUTCMonth() / 3) * 3;
    return Math.floor(Date.UTC(d.getUTCFullYear(), q, 1) / 1000);
  }

  /* Generic bucketing: group `records` (any order) by `keyFn(ts)`, sum each
     group, re-derive costs, and return newest-first sorted by bucket ts. */
  function bucketBy(records, keyFn, tariffs) {
    var groups = {};
    var order = [];
    (records || []).forEach(function (r) {
      var k = keyFn(r.ts);
      if (!groups[k]) { groups[k] = []; order.push(k); }
      groups[k].push(r);
    });
    var out = order.map(function (k) {
      return deriveCosts(sumRecords(Number(k), groups[k]), tariffs);
    });
    out.sort(function (a, b) { return a.ts - b.ts; });
    return out;
  }

  /* Aggregate a base ring into the requested resolution.
     base: array of records (any order); baseRes: '15m' | '1d' | '1mo';
     target: '15m' | '1h' | '1d' | '1w' | '1mo' | '1q'. When baseRes===target
     the records are returned re-derived (costs recomputed with the given
     tariffs) but not merged. Returns newest-first. */
  function aggregate(base, baseRes, target, tariffs) {
    base = base || [];
    /* spec 009 FR-909: when HT/NT is configured, split each base record's
       grid import by its own 15-min tariff window BEFORE bucketing, so the
       tariff split is always derived at the finest level and merely summed by
       coarser resolutions (never re-derived from re-averaged coarse Wh).
       No-op for flat tariffs, keeping the existing behavior and tests. */
    if (hasHtNt(tariffs) && baseRes === '15m') {
      base = base.map(function (r) { return splitHtNt(r, tariffs); });
    }
    if (baseRes === target) {
      var same = base.map(function (r) { return deriveCosts(r, tariffs); });
      same.sort(function (a, b) { return a.ts - b.ts; });
      return same;
    }
    switch (target) {
      case '1h': return bucketBy(base, hourStart, tariffs);
      case '1w': return bucketBy(base, isoWeekStart, tariffs);
      case '1q': return bucketBy(base, quarterStart, tariffs);
      case '1mo': return bucketBy(base, monthStart, tariffs);
      case '1d':
      default: return bucketBy(base, function (ts) { return ts - mod(ts, 86400); }, tariffs);
    }
  }

  /* --- Summary-strip pure functions (FR-408) --- */

  /* avg(series) — arithmetic mean of numeric values, ignoring null/undefined.
     Returns null when the series has no numeric value. */
  function avg(series) {
    var sum = 0, n = 0;
    (series || []).forEach(function (v) {
      if (v === null || v === undefined || isNaN(v)) return;
      sum += Number(v); n++;
    });
    return n === 0 ? null : sum / n;
  }

  /* trend(series) — compares the mean of the newer half against the older
     half (series is oldest→newest). Returns { dir: 'up'|'down'|'flat',
     pct: number|null }. pct is the relative change of the newer vs older
     mean; null when the older mean is 0 or a half is empty. */
  function trend(series) {
    series = (series || []).filter(function (v) {
      return v !== null && v !== undefined && !isNaN(v);
    });
    if (series.length < 2) return { dir: 'flat', pct: null };
    var mid = Math.floor(series.length / 2);
    var older = avg(series.slice(0, mid));
    var newer = avg(series.slice(mid));
    if (older === null || newer === null) return { dir: 'flat', pct: null };
    var diff = newer - older;
    var dir = diff > 1e-9 ? 'up' : diff < -1e-9 ? 'down' : 'flat';
    var pct = older === 0 ? null : (diff / Math.abs(older)) * 100;
    return { dir: dir, pct: pct };
  }

  /* yoy(monthly) — year-over-year change of the latest month vs the same
     month a year earlier. `monthly` is oldest→newest monthly values. Needs
     ≥ 13 entries. Returns pct|null. */
  function yoy(monthly) {
    monthly = monthly || [];
    if (monthly.length < 13) return null;
    var latest = monthly[monthly.length - 1];
    var prior = monthly[monthly.length - 13];
    if (latest === null || latest === undefined || isNaN(latest) ||
        prior === null || prior === undefined || isNaN(prior) || prior === 0) {
      return null;
    }
    return ((latest - prior) / Math.abs(prior)) * 100;
  }

  /* peaks(rows, topN=3) — indices (into `rows`) of the topN highest imp_wh,
     descending by imp_wh. Ignores rows without a numeric imp_wh. Used to mark
     the ⚡ peak rows on the loaded 15-min range (FR-409). */
  function peaks(rows, topN) {
    topN = topN || 3;
    var idx = [];
    (rows || []).forEach(function (r, i) {
      if (r && r.imp_wh !== null && r.imp_wh !== undefined && !isNaN(r.imp_wh) && r.imp_wh > 0) {
        idx.push(i);
      }
    });
    idx.sort(function (a, b) { return rows[b].imp_wh - rows[a].imp_wh; });
    return idx.slice(0, topN);
  }

export {
  WH_FIELDS, HTNT_FIELDS, round2, deriveCosts, sumRecords, aggregate,
  hourStart, isoWeekStart, monthStart, quarterStart,
  avg, trend, yoy, peaks,
  hasHtNt, splitHtNt, slotIsHt, dayMatches,
};
