/* Energiefluss & Kennzahlen — pure, DOM-free, node-testable (spec 008 FR-802).

   The device serves only raw Wh (/api/energy) and live power (/api/power); all
   KPI / flow / balance math lives here so it is identical on Übersicht and
   Verlauf (FR-803 — one formula source, never two implementations). Display
   formatting stays in the components; integer-Wh in, ratios/CHF/kg out.

   Glossary formulas (specs/README.md), with the battery terms of issue #20
   (chg/dis = bat_chg_wh/bat_dis_wh, 0 on a site without a battery):
     Verbrauch          = PV − Netzeinspeisung + Netzbezug + Entladung − Ladung
                                                             (pv − exp + imp + dis − chg)
     Eigenverbrauch     = PV − Netzeinspeisung               (pv − exp, ≥ 0; what is
                                                              charged counts as used)
     Autarkiegrad       = (Verbrauch − Netzbezug) / Verbrauch
     Eigenverbrauchsgrad= (PV − Netzeinspeisung) / PV        = selfuse / pv        */
import { deriveCosts } from './aggregate.js';

/* numeric or null (treats undefined/NaN as null) */
function n(v) { return (v === null || v === undefined || isNaN(v)) ? null : Number(v); }
function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }

/* battery charge / discharge Wh of a record (issue #20); 0 when absent */
function chgOf(r) { return n(r.bat_chg_wh) || 0; }
function disOf(r) { return n(r.bat_dis_wh) || 0; }
function hasBattery(records) {
  return records.some(function (r) { return r.bat_chg_wh != null || r.bat_dis_wh != null; });
}

/* A record is a "hole" for KPI purposes when any of the three core Wh fields
   (pv/exp/imp) is missing — such a slot can't be trusted in a ratio. */
function isHole(r) {
  return r.pv_wh === null || r.pv_wh === undefined ||
         r.exp_wh === null || r.exp_wh === undefined ||
         r.imp_wh === null || r.imp_wh === undefined;
}

/* kpis(records, opts) → KpiSet
     records : summed-or-raw /api/energy records (integer Wh; already
               cost-derived or not — costs are re-derived here from Wh).
     opts.tariffs : the /api/meta tariffs object (for Ersparnis re-derivation)
     opts.co2     : CO₂ factor in g CO₂eq/kWh (0/unset hides the stat)

   Returns { autarky, selfuse, savingChf, savingParts, co2Kg,
   incomplete }. Ratios are 0..1 (or null); savingChf/co2Kg are CHF/kg numbers.
   Any KPI that is undefined for the data is `null` — never NaN, never a fake 0
   (UC-802). If > 20 % of the period is missing, ALL KPIs are null and
   `incomplete` is true (Edge case: no confident numbers from holes). */
function kpis(records, opts) {
  opts = opts || {};
  var co2g = n(opts.co2);
  records = records || [];
  var total = records.length;

  /* sum only complete slots; count holes to apply the > 20 % rule */
  var pv = 0, exp = 0, imp = 0, chg = 0, dis = 0;
  var holes = 0, used = 0;
  records.forEach(function (r) {
    if (isHole(r)) { holes++; return; }
    pv += r.pv_wh; exp += r.exp_wh; imp += r.imp_wh;
    chg += chgOf(r); dis += disOf(r);
    used++;
  });

  var incomplete = total > 0 && (holes / total) > 0.2;

  var out = { autarky: null, selfuse: null, savingChf: null,
              savingParts: null, co2Kg: null, incomplete: incomplete };
  if (total === 0 || incomplete || used === 0) return out;

  var selfuseWh = Math.max(0, pv - exp);
  /* total site consumption; the battery shifts PV in time (issue #20) */
  var verbrauch = pv - exp + imp + dis - chg;

  out.autarky = verbrauch > 0 ? clamp01(Math.max(0, verbrauch - imp) / verbrauch) : null;
  out.selfuse = pv > 0 ? clamp01(selfuseWh / pv) : null;

  /* Ersparnis (UC-804): re-derive CHF from the summed Wh (never sum rounded
     CHF), then compose the headline from its components. */
  var c = deriveCosts({ imp_wh: imp, exp_wh: exp, pv_wh: pv }, opts.tariffs || {});
  var selfuseChf = c.saving_selfuse_chf || 0;
  var feedinChf = c.revenue_feedin_chf || 0;
  out.savingParts = { selfuse: selfuseChf, feedin: feedinChf };
  out.savingChf = Math.round((selfuseChf + feedinChf) * 100) / 100;

  /* CO₂ vermieden = self-consumed local energy × factor (UC-804). */
  out.co2Kg = (co2g && co2g > 0) ? (selfuseWh / 1000) * co2g / 1000 : null;

  return out;
}

/* hubFlows(sample, opts) → {nodes, edges} | null  (live flow card, UC-1001)
     sample : newest /api/power sample {grid_w, pv_w, bat_w, load_w} or null
     opts   : {pv, bat} — whether the site HAS a PV / battery node (default
              both true). An absent node is omitted and counts as 0; a present
              node whose value is null is 'unknown' (spec 010 D-3: unknown ≠ 0).

   Haus is the hub: every edge connects one node to Haus, so the numbers add up
   at Haus (in = consumption + out). PV → Haus carries the WHOLE PV power, Haus
   carries the site consumption (pv + bat + grid, the GridPanel balance), and
   Haus ↔ Netz carries the grid exchange.

   nodes: {pv?, bat?, haus, netz} each {watts ≥ 0 | null, state}
   edges: [{node, dir: 'in' | 'out' (into / out of Haus), watts ≥ 0, state}]
   state: 'ok' flowing · 'zero' real < 1 W (dimmed) · 'unknown' no data (grey
   «–», never a fabricated 0 — night and no-data must look different, UC-1003).
   Grid semantics follow 003 FR-305 (grid_w > 0 = import, < 0 = export). */
function hubFlows(sample, opts) {
  if (!sample) return null;
  opts = opts || {};
  var hasPv = opts.pv !== false, hasBat = opts.bat !== false;
  var pvN = n(sample.pv_w), batN = n(sample.bat_w), gridN = n(sample.grid_w);
  var pvU = hasPv && pvN === null, batU = hasBat && batN === null, gridU = gridN === null;
  var pv = hasPv && !pvU ? Math.max(0, pvN) : 0;
  var bat = hasBat && !batU ? batN : 0;
  var grid = gridU ? 0 : gridN;

  function st(w, unknown) { return unknown ? 'unknown' : (w < 1 ? 'zero' : 'ok'); }
  function node(w, unknown) { return { watts: unknown ? null : w, state: st(w, unknown) }; }

  var nodes = {}, edges = [];
  if (hasPv) {
    nodes.pv = node(pv, pvU);
    edges.push({ node: 'pv', dir: 'in', watts: pv, state: st(pv, pvU) });
  }
  if (hasBat) {
    nodes.bat = node(Math.abs(bat), batU);
    edges.push({ node: 'bat', dir: bat < 0 ? 'out' : 'in', watts: Math.abs(bat), state: st(Math.abs(bat), batU) });
  }

  var cons = Math.max(0, pv + bat + grid);
  nodes.haus = node(cons, gridU || pvU || batU);

  /* grid exchange */
  var gridDir = grid > 0 ? 'in' : 'out';
  var netzW = Math.abs(grid);
  nodes.netz = node(netzW, gridU);
  edges.push({ node: 'netz', dir: gridDir, watts: netzW, state: st(netzW, gridU) });
  return { nodes: nodes, edges: edges };
}

/* flowHeadline(hub) → {key, vars} | null  (spec 010 FR-1002, UC-1001)
   A one-line words-first summary driven by the SAME hub data the card draws
   (never a second derivation). {pct} = share of the consumption covered by PV
   (PV minus what goes to the grid and into the battery), 0..100.
     flow.status_unknown   — grid or consumption unknown
     flow.status_export    — net feed-in        {pct, w = eingespeist}
     flow.status_import_pv — draw while PV runs {pct, w = bezogen}
     flow.status_import    — draw without PV    {w = bezogen}
     flow.status_covered   — PV covers the house, no grid exchange
     flow.status_idle      — everything ~zero (night, no load) */
function flowHeadline(hub) {
  if (!hub) return null;
  var nd = hub.nodes;
  if (nd.netz.state === 'unknown' || nd.haus.state === 'unknown') return { key: 'flow.status_unknown', vars: {} };
  var imp = 0, exp = 0, charge = 0;
  hub.edges.forEach(function (e) {
    if (e.node === 'netz') { if (e.dir === 'in') imp += e.watts; else exp += e.watts; }
    if (e.node === 'bat' && e.dir === 'out') charge += e.watts;
  });
  var pv = nd.pv ? nd.pv.watts : 0;
  var cons = nd.haus.watts;
  var pvToHaus = Math.max(0, pv - exp - charge);
  var pct = cons >= 1 ? Math.round(clamp01(pvToHaus / cons) * 100) : (pv >= 1 ? 100 : 0);
  if (exp >= 1) return { key: 'flow.status_export', vars: { pct: pct, w: exp } };
  if (imp >= 1) {
    return pvToHaus >= 1
      ? { key: 'flow.status_import_pv', vars: { pct: pct, w: imp } }
      : { key: 'flow.status_import', vars: { w: imp } };
  }
  if (pvToHaus >= 1) return { key: 'flow.status_covered', vars: { pct: pct } };
  return { key: 'flow.status_idle', vars: {} };
}

/* Segment colour tokens, keyed by composition-segment id (spec 010 FR-1006).
   Returned as data so the presentational component needs no key→colour map. */
var SEG_COLOR = {
  'comp.pv': 'var(--c-production)',        /* PV — gelb */
  'comp.load': 'var(--c-consumption)',     /* Haus — blau */
  'comp.battery': 'var(--c-battery)',      /* Batterie entladen — türkis */
  'comp.charge': 'var(--c-battery)',       /* Batterie laden — türkis */
  'comp.grid': 'var(--c-import)',          /* Netzbezug — rot */
  'comp.feedin': 'var(--c-export-fill)'    /* Einspeisung — grün, heller */
};
function seg(key, value) {
  return { key: key, value: Math.max(0, value || 0), color: SEG_COLOR[key] };
}

/* sourcesNow(sample) → {cover, usage, unknown}  (spec 010 FR-1006, UC-1004)
   The live composition of the newest /api/power sample:
     cover (Verbrauch gedeckt aus): PV direkt + Batterie-Entladung + Netzbezug
     usage (Strom verwendet für): Haus + Batterie-Ladung + Einspeisung
   «PV direkt» is PV minus export minus battery charge (issue #20 — counting the
   charge in both the PV segment and its own would overfill the bar). `cover`
   sums to the house load by construction (selfuse + batDis + imp), so `usage`
   reuses that as its «Haus» segment instead of re-deriving PV self-use — a
   battery discharge or grid import covering the house with zero PV production
   used to leave every usage segment at 0 («Kein Fluss» despite real
   consumption, issue #21). Segments clamp ≥ 0 and sum to their bar's total.
   `unknown` is true when pv or grid is null — the bar then shows the grey
   «keine Daten» state instead of a fabricated 100 % Netz share (UC-1004). */
function sourcesNow(sample) {
  if (!sample) return { cover: [], usage: [], unknown: true };
  var pvN = n(sample.pv_w), batN = n(sample.bat_w), gridN = n(sample.grid_w);
  var unknown = pvN === null || gridN === null;
  var pv = pvN === null ? 0 : pvN, bat = batN === null ? 0 : batN, grid = gridN === null ? 0 : gridN;

  var imp = Math.max(0, grid), exp = Math.max(0, -grid);
  var batDis = Math.max(0, bat), batChg = Math.max(0, -bat);
  var selfuse = Math.max(0, pv - exp - batChg);
  var house = selfuse + batDis + imp;

  return {
    cover: [
      seg('comp.pv', selfuse), seg('comp.battery', batDis), seg('comp.grid', imp)
    ],
    usage: [
      seg('comp.load', house), seg('comp.charge', batChg), seg('comp.feedin', exp)
    ],
    unknown: unknown
  };
}

/* sourcesToday(records) → {cover, usage, unknown, battery}  (spec 010 FR-1006,
   UC-1004). Same two bars from today's summed /api/energy slots (integer Wh).
   The battery segments appear once the records carry battery Wh (issue #20);
   a site without them keeps the three-segment bars (`battery` false). Sums only
   complete slots; `unknown` when no complete slot exists (never a fake 100 %). */
function sourcesToday(records) {
  records = records || [];
  var pv = 0, exp = 0, imp = 0, chg = 0, dis = 0, used = 0;
  records.forEach(function (r) {
    if (isHole(r)) return;
    pv += r.pv_wh; exp += r.exp_wh; imp += r.imp_wh;
    chg += chgOf(r); dis += disOf(r);
    used++;
  });
  if (used === 0) return { cover: [], usage: [], unknown: true, battery: false };
  var bat = hasBattery(records);
  var selfuse = Math.max(0, pv - exp - chg);
  var house = selfuse + dis + imp;
  var cover = [seg('comp.pv', selfuse)];
  var usage = [seg('comp.load', house)];
  if (bat) { cover.push(seg('comp.battery', dis)); usage.push(seg('comp.charge', chg)); }
  cover.push(seg('comp.grid', imp));
  usage.push(seg('comp.feedin', exp));
  return { cover: cover, usage: usage, unknown: false, battery: bat };
}

/* pvSeriesAllNull(pvValues) → bool  (spec 010 FR-1005, UC-1003)
   True when the live-PV window has ≥ 1 sample and EVERY value is null/undefined
   — «Produktion konfiguriert, aber keine Live-Daten» (integration/reachability).
   The caller (with configured productions) turns this into the data-quality
   notice. An empty window is not "all null" (returns false → no false alarm). */
function pvSeriesAllNull(pvValues) {
  if (!pvValues || !pvValues.length) return false;
  return pvValues.every(function (v) { return v === null || v === undefined; });
}

/* balance(records) → BalanceSet  (for the Verlauf Bilanz bars, UC-803)
   Two split sums over a period: Produktion → selbst verbraucht / eingespeist,
   Verbrauch → selbst gedeckt / Netzbezug. selbst-verbraucht = Eigenverbrauch
   (pv − exp, clamped ≥ 0, what went into the battery included); selbst-gedeckt
   = Verbrauch − Netzbezug (pv − exp − chg + dis — equal to Eigenverbrauch
   without a battery, issue #20). All integer Wh; null when the period has no
   complete slot. Segments never go negative (Edge case: export skew). */
function balance(records) {
  records = records || [];
  var pv = 0, exp = 0, imp = 0, chg = 0, dis = 0, used = 0;
  records.forEach(function (r) {
    if (isHole(r)) return;
    pv += r.pv_wh; exp += r.exp_wh; imp += r.imp_wh;
    chg += chgOf(r); dis += disOf(r);
    used++;
  });
  if (used === 0) {
    return { prodSelf: null, prodFeedin: null, consSelf: null, consImport: null };
  }
  var selfuse = Math.max(0, pv - exp);
  return { prodSelf: selfuse, prodFeedin: Math.max(0, exp),
           consSelf: Math.max(0, pv - exp - chg + dis), consImport: Math.max(0, imp) };
}

export {
  kpis, hubFlows, flowHeadline, balance,
  sourcesNow, sourcesToday, pvSeriesAllNull
};
