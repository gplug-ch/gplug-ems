/* vZEV community compute (spec 005) — moved from the device to the browser.
   The gPlug now serves only the RAW per-member peer-slot rings via
   /api/vzev/raw; all allocation, flow bucketing and quarterly billing run
   here so the tiny ESP32-C3 Berry heap does none of it. Pure, DOM-free,
   node-testable. The algorithms are exact ports of the former Berry
   ems/backend/vzev.be (allocate / _flows / _bucket_flows / build_billing /
   quarter_range) — integer Wh, deterministic, identical on every device. */
import { round2, monthStart } from './aggregate.js';

/* UTC day start (epoch seconds). ts is non-negative here. */
function dayStart(ts) { return ts - (ts % 86400); }

/* Decode a member's flat ring [ts,imp,exp, ...] into [imp, exp] at `ts`,
   or null when the member has no slot for that ts. The device (issue #4)
   stores peer slots in append-only bucket files: a correction for an
   already-written ts is appended rather than rewritten in place, so a
   ring may contain more than one triple for the same ts. The LAST (most
   recently written) one wins — this is not assumed to be sorted by ts. */
function peerSlot(ring, ts) {
  if (!Array.isArray(ring)) return null;
  var n = Math.floor(ring.length / 3);
  var found = null;
  for (var i = 0; i < n; i++) {
    if (ring[i * 3] === ts) found = [ring[i * 3 + 1], ring[i * 3 + 2]];
  }
  return found;
}

/* Deterministic integer largest-remainder allocation (FR-505, NFR-503).
     producerExp : producer's exported Wh in the slot (>=0)
     importsMap  : { site_id -> imported Wh (>=0) }
   -> { site_id -> allocated Wh }, integer, with
      alloc_i <= imp_i  and  sum(alloc) == min(producerExp, sum(imp)).
   Ordering by ascending site_id makes the remainder tie-break identical on
   every device. */
function allocate(producerExp, importsMap) {
  var out = {};
  var ids = [];
  var totalImp = 0;
  importsMap = importsMap || {};
  for (var id in importsMap) {
    if (!Object.prototype.hasOwnProperty.call(importsMap, id)) continue;
    var v = importsMap[id];
    if (v === null || v === undefined || v < 0) v = 0;
    importsMap[id] = v;
    ids.push(id);
    totalImp += v;
    out[id] = 0;
  }
  if (ids.length === 0) return out;
  ids.sort();                                   /* ascending string compare */

  if (producerExp < 0) producerExp = 0;
  var budget = producerExp < totalImp ? producerExp : totalImp;
  if (budget <= 0 || totalImp <= 0) return out;

  /* floor shares + remainders (budget <= totalImp so floor_i <= imp_i) */
  var rema = {};
  var assigned = 0;
  ids.forEach(function (id) {
    var num = budget * importsMap[id];
    var q = Math.floor(num / totalImp);
    rema[id] = num - q * totalImp;
    out[id] = q;
    assigned += q;
  });

  /* +1 Wh to the `leftover` members with the largest remainder; ties break by
     ascending id (ids is pre-sorted and we keep the FIRST max found). */
  var leftover = budget - assigned;
  while (leftover > 0) {
    var bestId = null, bestR = -1;
    ids.forEach(function (id) {
      if (rema[id] > bestR) { bestR = rema[id]; bestId = id; }
    });
    if (bestId === null) break;
    out[bestId] += 1;
    rema[bestId] = -1;
    leftover -= 1;
  }
  return out;
}

/* The raw 15-min allocated series (oldest first), one record per slot ts.
   raw = { producer_id, self_id, data:{ id:[ts,imp,exp,...] } }. */
function flows15m(raw) {
  raw = raw || {};
  var data = raw.data || {};
  var producerId = raw.producer_id;
  var seen = {}, tslist = [];
  for (var id in data) {
    if (!Object.prototype.hasOwnProperty.call(data, id)) continue;
    var ring = data[id];
    var n = Math.floor((ring ? ring.length : 0) / 3);
    for (var i = 0; i < n; i++) {
      var ts = ring[i * 3];
      if (!seen[ts]) { seen[ts] = true; tslist.push(ts); }
    }
  }
  tslist.sort(function (a, b) { return a - b; });

  return tslist.map(function (ts) {
    var imports = {};
    var producerExp = 0;
    for (var id in data) {
      if (!Object.prototype.hasOwnProperty.call(data, id)) continue;
      var s = peerSlot(data[id], ts);
      if (s === null) continue;
      if (id === producerId) producerExp = s[1];
      else imports[id] = s[0];
    }
    return { ts: ts, members: allocate(producerExp, imports) };
  });
}

/* Own vZEV share per 15-min slot (spec 011 FR-1105). Until spec 011 the
   device wrote `vzev_in_wh`/`vzev_out_wh` back into its own sealed 15-min
   records (store.set_vzev); the browser now derives them from the archived
   peer slots instead:
     consumer -> in  = what the allocation assigned to this site
     producer -> out = the sum it handed to all members
   Returns { ts: {vzev_in_wh, vzev_out_wh} }. */
function ownShare(raw) {
  var selfId = raw && raw.self_id;
  var producerId = raw && raw.producer_id;
  var out = {};
  if (!selfId) return out;
  flows15m(raw).forEach(function (rec) {
    var members = rec.members || {};
    var vin = 0, vout = 0;
    if (selfId === producerId) {
      for (var id in members) {
        if (Object.prototype.hasOwnProperty.call(members, id)) vout += members[id];
      }
    } else {
      vin = members[selfId] || 0;
    }
    out[rec.ts] = { vzev_in_wh: vin, vzev_out_wh: vout };
  });
  return out;
}

/* Join the own share onto raw 15-min energy records, so aggregate.js,
   insights.js and the Verlauf columns keep seeing the two fields they always
   had. Records without a matching slot get 0/0 (no allocation happened),
   never null — an absent allocation is a known zero, not missing data. */
function withOwnShare(records, raw) {
  var share = ownShare(raw);
  return (records || []).map(function (r) {
    var s = share[r.ts];
    var out = {};
    for (var k in r) out[k] = r[k];
    out.vzev_in_wh = s ? s.vzev_in_wh : 0;
    out.vzev_out_wh = s ? s.vzev_out_wh : 0;
    return out;
  });
}

/* Bucket a 15-min flow series by keyFn(ts), summing member Wh; oldest-first. */
function bucketFlows(perSlot, keyFn) {
  var acc = {}, order = [];
  perSlot.forEach(function (rec) {
    var bts = keyFn(rec.ts);
    var members = acc[bts];
    if (!members) { members = {}; acc[bts] = members; order.push(bts); }
    var ms = rec.members || {};
    for (var id in ms) {
      if (!Object.prototype.hasOwnProperty.call(ms, id)) continue;
      members[id] = (members[id] || 0) + ms[id];
    }
  });
  order.sort(function (a, b) { return a - b; });
  return order.map(function (bts) { return { ts: bts, members: acc[bts] }; });
}

/* Per-member allocated-Wh series, bucketed to `res` (15m|1d|1mo), oldest-first,
   capped to the newest `count` records. */
function flows(raw, res, count) {
  if (count === undefined || count === null || count < 1) count = 96;
  var perSlot = flows15m(raw);
  var buckets;
  if (res === '1d') buckets = bucketFlows(perSlot, dayStart);
  else if (res === '1mo') buckets = bucketFlows(perSlot, monthStart);
  else buckets = perSlot;
  var start = buckets.length > count ? buckets.length - count : 0;
  return buckets.slice(start);
}

/* Parse "YYYY-QN" -> [startTs, stopTs) UTC epoch seconds, or null. */
function quarterRange(q) {
  if (typeof q !== 'string' || q.length !== 7 || q[4] !== '-' || q[5] !== 'Q') {
    return null;
  }
  var year = parseInt(q.slice(0, 4), 10);
  var qn = parseInt(q[6], 10);
  if (isNaN(year) || isNaN(qn) || qn < 1 || qn > 4) return null;
  var m0 = (qn - 1) * 3;                          /* 0-based first month */
  var start = Math.floor(Date.UTC(year, m0, 1) / 1000);
  var stop = Math.floor(Date.UTC(year, m0 + 3, 1) / 1000);  /* Date.UTC wraps Dec */
  return [start, stop];
}

/* Aggregate an in-range 15-min flow series into the billing structure (FR-507).
     quarter : "YYYY-QN"
     flowsInRange : [{ts, members:{id->wh}}] already filtered to the quarter
     members : registry list [{id,name,...}] for name resolution
     tariffs : { vzev_export_chf_kwh, vzev_import_chf_kwh }
   Shape is identical to the former device /api/vzev/billing response. */
function buildBilling(quarter, flowsInRange, members, tariffs, qual) {
  members = members || [];
  tariffs = tariffs || {};
  var byId = {};
  members.forEach(function (m) {
    if (m && m.id !== undefined) byId[m.id] = m;
  });
  /* spec 009: HT/NT split only when configured. When flat, the ht/nt buckets
     stay 0 and every downstream number is computed exactly as pre-009 so the
     regression fixture is bit-identical (NFR-903). */
  var split = hasHtNt(tariffs);
  var entryById = {};
  members.forEach(function (m) {
    if (m && m.id !== undefined) entryById[m.id] = num(m.entry_ts, 0);
  });

  /* perMemberMonths[id][mts] tracks each member's OWN monthly Wh so their
     card's chart (and the Total card's) has a series to plot — `months` alone
     (the community-wide sum) is not enough, see total.months below. */
  var perMember = {}, perMemberHt = {}, perMemberNt = {}, perMemberMonths = {};
  var months = {}, totalWh = 0;
  (flowsInRange || []).forEach(function (rec) {
    var mts = monthStart(rec.ts);
    var isHt = split && slotTariff(rec.ts, tariffs) === 'ht';
    var ms = rec.members || {};
    for (var id in ms) {
      if (!Object.prototype.hasOwnProperty.call(ms, id)) continue;
      /* spec 009 edge case: exclude slots before a member's entry from its
         billing. Absent entry_ts (0) never excludes anything (legacy). */
      if (entryById[id] && rec.ts < entryById[id]) continue;
      var wh = ms[id] || 0;
      perMember[id] = (perMember[id] || 0) + wh;
      if (isHt) perMemberHt[id] = (perMemberHt[id] || 0) + wh;
      else perMemberNt[id] = (perMemberNt[id] || 0) + wh;
      var mm = perMemberMonths[id];
      if (!mm) { mm = {}; perMemberMonths[id] = mm; }
      mm[mts] = (mm[mts] || 0) + wh;
      months[mts] = (months[mts] || 0) + wh;
      totalWh += wh;
    }
  });

  var tOut = num(tariffs.vzev_export_chf_kwh, 0);
  var tIn = num(tariffs.vzev_import_chf_kwh, 0);

  var memberList = [];
  for (var id in perMember) {
    if (!Object.prototype.hasOwnProperty.call(perMember, id)) continue;
    var wh = perMember[id];
    var reg = byId[id];
    var row = {
      id: id,
      name: reg && reg.name !== undefined ? reg.name : id,
      wh: wh,
      chf: round2(wh / 1000 * tIn)
    };
    if (reg) {
      if (reg.location !== undefined) row.location = reg.location;
      if (reg.metering_point !== undefined) row.metering_point = reg.metering_point;
      if (reg.entry_ts !== undefined) row.entry_ts = reg.entry_ts;
    }
    if (split) {
      row.ht_wh = perMemberHt[id] || 0;
      row.nt_wh = perMemberNt[id] || 0;
    }
    /* what the same energy would have cost from the grid operator, for the
       consumer "statt … beim Netzbetreiber" note. Uses the LOCAL grid tariff
       (deliberately not part of the community tariff set — each member
       compares against its own grid rate). Omitted when no rate is known. */
    var gFlat = num(tariffs.grid_import_chf_kwh, null);
    if (gFlat !== null) {
      row.cost_grid_chf = split
        ? round2((row.ht_wh / 1000) * num(tariffs.grid_import_ht_chf_kwh, gFlat)
               + (row.nt_wh / 1000) * num(tariffs.grid_import_nt_chf_kwh, gFlat))
        : round2(wh / 1000 * gFlat);
    }
    row.months = monthList(perMemberMonths[id]);
    memberList.push(row);
  }

  var mlist = monthList(months);

  var out = {
    quarter: quarter,
    months: mlist,
    /* total.months mirrors the community-wide `months` (every consumer's
       received energy summed) — that IS the producer's total distributed/
       exported vZEV energy, so the Total card's chart plots it directly. */
    total: { exp_wh: totalWh, revenue_chf: round2(totalWh / 1000 * tOut), months: mlist },
    members: memberList,
    note: '15-min Messwerte, Abgleich mit Netzbetreiber pro Quartal'
  };
  /* attach the pre-computed quality summary (FR-903/906) when the caller
     supplies it, so the statement/Abrechnung can show completeness without
     recomputing. Omitted entirely when not provided (flat regression path). */
  if (qual !== undefined && qual !== null) out.quality = qual;
  return out;
}

function num(v, dflt) {
  return (v === null || v === undefined || isNaN(v)) ? dflt : Number(v);
}

/* {mts -> wh} -> [{ts, wh}] sorted ascending by month, for BarChart series. */
function monthList(months) {
  months = months || {};
  var keys = Object.keys(months).map(Number).sort(function (a, b) { return a - b; });
  return keys.map(function (k) { return { ts: k, wh: months[k] }; });
}

/* =========================================================================
   spec 009 — HT/NT tariffs, cap indicator, data quality, slot explanation.
   All pure, DOM-free and integer-Wh (see NFR-903: flat-config results must
   stay bit-identical to pre-009, which is why the flat path below is the
   untouched original code).
   ========================================================================= */

/* Local weekday of an epoch-second ts, 0=Mon … 6=Sun (JS getDay is 0=Sun).
   Local time is used deliberately (spec: Europe/Zurich via browser TZ) so a
   15-min slot maps to the tariff window active at its wall-clock start. */
function localDow(ts) {
  var d = new Date(ts * 1000);
  return (d.getDay() + 6) % 7;
}

/* Fractional local hour of a ts (e.g. 6.25 for 06:15). */
function localHour(ts) {
  var d = new Date(ts * 1000);
  return d.getHours() + d.getMinutes() / 60;
}

/* Does a window's `days` spec include weekday `dow` (0=Mon..6=Sun)?
   Accepts: a number, an array of numbers, or a compact string of tokens
   ('mo','tue','sat',…) and ranges ('mo-fr'), comma/space separated. An
   absent/empty `days` means "every day". */
var DAY_TOKENS = { mo: 0, mon: 0, di: 1, tu: 1, tue: 1, mi: 2, we: 2, wed: 2,
                   do: 3, th: 3, thu: 3, fr: 4, fri: 4, sa: 5, sat: 5,
                   so: 6, su: 6, sun: 6 };

function dayMatches(days, dow) {
  if (days === null || days === undefined || days === '') return true;
  if (typeof days === 'number') return ((days % 7) + 7) % 7 === dow;
  if (Array.isArray(days)) {
    return days.some(function (d) { return dayMatches(d, dow); });
  }
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
        else { if (dow >= a || dow <= b) return true; }  /* wrap (e.g. sa-mo) */
      }
    } else if (DAY_TOKENS[p] !== undefined && DAY_TOKENS[p] === dow) {
      return true;
    }
  }
  return false;
}

/* Are HT/NT rates actually configured with usable windows? */
function hasHtNt(tariffs) {
  tariffs = tariffs || {};
  var ht = tariffs.grid_import_ht_chf_kwh;
  var nt = tariffs.grid_import_nt_chf_kwh;
  var win = tariffs.ht_windows;
  return ht !== null && ht !== undefined && nt !== null && nt !== undefined &&
         Array.isArray(win) && win.length > 0;
}

/* slotTariff(ts, tariffs) -> 'ht' | 'nt' | 'flat' (FR-904).
   'flat' when HT/NT is not fully configured or windows are empty (edge case:
   HT/NT rates set but empty windows => treated as flat by the caller). */
function slotTariff(ts, tariffs) {
  if (!hasHtNt(tariffs)) return 'flat';
  var dow = localDow(ts);
  var h = localHour(ts);
  var win = tariffs.ht_windows;
  for (var i = 0; i < win.length; i++) {
    var w = win[i] || {};
    var from = num(w.from, 0), to = num(w.to, 0);
    if (dayMatches(w.days, dow) && h >= from && h < to) return 'ht';
  }
  return 'nt';
}

/* Fraction of a full week's hours that fall inside the HT windows, used to
   weight the external Standardprodukt for the cap reference. Sampled at 15-min
   resolution over a Mon..Sun week (672 slots) so partial-hour windows and
   per-day-group specs are honoured exactly the way slotTariff sees them. */
function htWeekFraction(tariffs) {
  var win = tariffs.ht_windows;
  if (!Array.isArray(win) || win.length === 0) return 0;
  var htCount = 0, total = 0;
  for (var dow = 0; dow < 7; dow++) {
    for (var q = 0; q < 96; q++) {
      var h = q / 4;
      total++;
      for (var i = 0; i < win.length; i++) {
        var w = win[i] || {};
        if (dayMatches(w.days, dow) && h >= num(w.from, 0) && h < num(w.to, 0)) {
          htCount++;
          break;
        }
      }
    }
  }
  return total === 0 ? 0 : htCount / total;
}

/* capReference(tariffs) -> chf/kWh (FR-905): the legal Pauschalmethode cap for
   the internal solar price = 80 % of the (HT/NT-weighted) external
   Standardprodukt. Flat external -> 80 % of the flat import price. Returns
   null when no external import price is configured at all. */
function capReference(tariffs) {
  tariffs = tariffs || {};
  var ref;
  if (hasHtNt(tariffs)) {
    var f = htWeekFraction(tariffs);
    var ht = num(tariffs.grid_import_ht_chf_kwh, 0);
    var nt = num(tariffs.grid_import_nt_chf_kwh, 0);
    ref = ht * f + nt * (1 - f);
  } else {
    var flat = tariffs.grid_import_chf_kwh;
    if (flat === null || flat === undefined || isNaN(flat)) return null;
    ref = Number(flat);
  }
  return round2(ref * 0.8);
}

/* quality(raw, members, range) -> {expected, complete, provisional, missing,
   perMember} (FR-904/906).
     raw    : /api/vzev/raw shape { producer_id, self_id, data:{id:[ts,imp,exp]} }
     members: registry list [{id, entry_ts?}] — the members that MUST deliver
     range  : optional [startTs, stopTs) filter on slot ts
   A slot is `provisional` when >= 1 registered member that entered before the
   slot has no data for it; `missing` when own (self_id) data is absent.
   `perMember[id] = {have, expected, lastTs}` supports the no-data badge and the
   «Mitglied X fehlt in N Slots» sentence. entry_ts excludes pre-entry slots
   from both the numerator and the denominator (spec edge case). */
function quality(raw, members, range) {
  raw = raw || {};
  var data = raw.data || {};
  var selfId = raw.self_id;
  members = members || [];

  /* union of all slot ts present in any ring, within range */
  var seen = {}, tslist = [];
  for (var id in data) {
    if (!Object.prototype.hasOwnProperty.call(data, id)) continue;
    var ring = data[id];
    var n = Math.floor((ring ? ring.length : 0) / 3);
    for (var i = 0; i < n; i++) {
      var ts = ring[i * 3];
      if (range && (ts < range[0] || ts >= range[1])) continue;
      if (!seen[ts]) { seen[ts] = true; tslist.push(ts); }
    }
  }
  tslist.sort(function (a, b) { return a - b; });

  var entryById = {};
  var perMember = {};
  members.forEach(function (m) {
    if (!m || m.id === undefined) return;
    entryById[m.id] = num(m.entry_ts, 0);
    perMember[m.id] = { have: 0, expected: 0, lastTs: null };
  });

  var expected = 0, complete = 0, provisional = 0, missing = 0;
  tslist.forEach(function (ts) {
    expected++;
    var slotProvisional = false;
    members.forEach(function (m) {
      if (!m || m.id === undefined) return;
      if (ts < entryById[m.id]) return;          /* not yet a member */
      var pm = perMember[m.id];
      pm.expected++;
      var s = peerSlot(data[m.id], ts);
      if (s === null) { slotProvisional = true; }
      else {
        pm.have++;
        if (pm.lastTs === null || ts > pm.lastTs) pm.lastTs = ts;
      }
    });
    if (selfId !== undefined && selfId !== null && peerSlot(data[selfId], ts) === null) {
      missing++;
    }
    if (slotProvisional) provisional++; else complete++;
  });

  return {
    expected: expected,
    complete: complete,
    provisional: provisional,
    missing: missing,
    perMember: perMember
  };
}

/* Newest slot ts a member delivered (FR-906 no-data badge), or null. The
   device (issue #4) streams a member's bucket files oldest-to-newest but a
   corrected slot is appended out of ts order (see peerSlot above), so the
   ring's last triple is not necessarily the newest — take the max ts. */
function lastSlotTs(raw, memberId) {
  raw = raw || {};
  var ring = (raw.data || {})[memberId];
  if (!Array.isArray(ring) || ring.length < 3) return null;
  var n = Math.floor(ring.length / 3);
  var best = null;
  for (var i = 0; i < n; i++) {
    var ts = ring[i * 3];
    if (best === null || ts > best) best = ts;
  }
  return best;
}

/* explainSlot(ts, raw, memberId) -> {prodWh, totalImpWh, memberImpWh,
   sharePct, allocatedWh} (FR-904). Derived from the SAME allocate() call the
   billing uses (one source of truth) so the drill-down sentence can never
   disagree with the billed amount. Returns nulls-safe zeros when the producer
   has no data in the slot (drill-down then says «keine Produktionsdaten»). */
function explainSlot(ts, raw, memberId) {
  raw = raw || {};
  var data = raw.data || {};
  var producerId = raw.producer_id;
  var imports = {}, totalImp = 0, prodWh = 0, memberImp = 0;
  for (var id in data) {
    if (!Object.prototype.hasOwnProperty.call(data, id)) continue;
    var s = peerSlot(data[id], ts);
    if (s === null) continue;
    if (id === producerId) { prodWh = s[1]; }
    else {
      imports[id] = s[0];
      totalImp += s[0];
      if (id === memberId) memberImp = s[0];
    }
  }
  var alloc = allocate(prodWh, imports);
  return {
    prodWh: prodWh,
    totalImpWh: totalImp,
    memberImpWh: memberImp,
    sharePct: totalImp > 0 ? round2(memberImp / totalImp * 100) : 0,
    allocatedWh: alloc[memberId] || 0
  };
}

export {
  allocate, flows15m, flows, bucketFlows, quarterRange, buildBilling, peerSlot,
  ownShare, withOwnShare,
  dayStart,
  slotTariff, hasHtNt, capReference, htWeekFraction, dayMatches,
  quality, lastSlotTs, explainSlot
};
