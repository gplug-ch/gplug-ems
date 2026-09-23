/* Tests for lib/insights.js — pure KPI / flow / balance derivations (spec 008
   FR-802). No DOM. Covers the UC-802 null rules, clamps, the > 20 % gap rule,
   hubFlows edge derivation, the flow headline and balance sums. */
import test from 'node:test';
import assert from 'node:assert';
import {
  kpis, hubFlows, flowHeadline, balance,
  sourcesNow, sourcesToday, pvSeriesAllNull
} from '../src/lib/insights.js';

/* helper: build a complete energy record */
function rec(o) {
  return Object.assign({ ts: 0, pv_wh: 0, exp_wh: 0, imp_wh: 0 }, o);
}
function near(a, b, eps) { return Math.abs(a - b) <= (eps || 1e-6); }
/* find the edge of `node` (to/from Haus) in a hubFlows() result */
function edge(hub, node) {
  return hub.edges.find(function (e) { return e.node === node; });
}

/* ===================== kpis ===================== */

test('kpis: basic autarky / selfuse / saving / co2', () => {
  var k = kpis([rec({ pv_wh: 1000, exp_wh: 400, imp_wh: 200 })], { tariffs: {}, co2: 128 });
  assert.ok(near(k.autarky, 0.75), 'autarky 600/800');
  assert.ok(near(k.selfuse, 0.6), 'selfuse 600/1000');
  assert.ok(near(k.savingChf, 0.12), 'saving 0.05 + 0.07');
  assert.ok(near(k.co2Kg, 0.0768), 'co2 = 0.6 kWh * 128 g / 1e6');
  assert.strictEqual(k.incomplete, false);
});

test('kpis: night (pv=0) → selfuse null, not 0/NaN', () => {
  var k = kpis([rec({ pv_wh: 0, exp_wh: 0, imp_wh: 500 })], { tariffs: {} });
  assert.strictEqual(k.selfuse, null);
  assert.ok(near(k.autarky, 0), 'autarky 0/500');
});

test('kpis: no consumption (verbrauch=0) → autarky null', () => {
  var k = kpis([rec({ pv_wh: 0, exp_wh: 0, imp_wh: 0 })], { tariffs: {} });
  assert.strictEqual(k.autarky, null);
  assert.strictEqual(k.selfuse, null);
});

test('kpis: export > pv (skew) clamps selfuse to 0', () => {
  var k = kpis([rec({ pv_wh: 100, exp_wh: 300, imp_wh: 500 })], { tariffs: {} });
  assert.strictEqual(k.selfuse, 0);
  assert.strictEqual(k.autarky, 0);
});

test('kpis: > 20 % missing → all null + incomplete', () => {
  var recs = [
    rec({ pv_wh: 100, exp_wh: 10, imp_wh: 20 }),
    rec({ pv_wh: 100, exp_wh: 10, imp_wh: 20 }),
    rec({ pv_wh: 100, exp_wh: 10, imp_wh: 20 }),
    rec({ pv_wh: null }),
    rec({ pv_wh: null })
  ];
  var k = kpis(recs, { tariffs: {}, co2: 128 });
  assert.strictEqual(k.incomplete, true);
  assert.strictEqual(k.autarky, null);
  assert.strictEqual(k.selfuse, null);
  assert.strictEqual(k.savingChf, null);
  assert.strictEqual(k.co2Kg, null);
});

test('kpis: exactly 20 % missing is still computed', () => {
  var recs = [
    rec({ pv_wh: 1000, exp_wh: 400, imp_wh: 200 }),
    rec({ pv_wh: 1000, exp_wh: 400, imp_wh: 200 }),
    rec({ pv_wh: 1000, exp_wh: 400, imp_wh: 200 }),
    rec({ pv_wh: 1000, exp_wh: 400, imp_wh: 200 }),
    rec({ imp_wh: null })
  ];
  var k = kpis(recs, { tariffs: {} });
  assert.strictEqual(k.incomplete, false);
  assert.ok(near(k.autarky, 0.75));
});

test('kpis: empty records → all null, incomplete false', () => {
  var k = kpis([], { tariffs: {} });
  assert.strictEqual(k.autarky, null);
  assert.strictEqual(k.incomplete, false);
});

test('kpis: co2 factor 0 hides the CO₂ stat', () => {
  var k = kpis([rec({ pv_wh: 1000, exp_wh: 200, imp_wh: 100 })], { tariffs: {}, co2: 0 });
  assert.strictEqual(k.co2Kg, null);
});

/* ===================== hubFlows ===================== */

test('hubFlows: null sample → null', () => {
  assert.strictEqual(hubFlows(null), null);
});

test('hubFlows: consumer importing', () => {
  var h = hubFlows({ pv_w: 0, bat_w: 0, grid_w: 500 });
  assert.deepStrictEqual(edge(h, 'netz'), { node: 'netz', dir: 'in', watts: 500, state: 'ok' });
  assert.strictEqual(edge(h, 'pv').state, 'zero');
  assert.strictEqual(h.nodes.haus.watts, 500);
});

test('hubFlows: producer exporting — PV edge carries the whole PV, Haus balances', () => {
  var h = hubFlows({ pv_w: 1230, bat_w: 0, grid_w: -27 });
  assert.strictEqual(edge(h, 'pv').watts, 1230);
  assert.strictEqual(edge(h, 'pv').dir, 'in');
  assert.deepStrictEqual(edge(h, 'netz'), { node: 'netz', dir: 'out', watts: 27, state: 'ok' });
  assert.strictEqual(h.nodes.haus.watts, 1203);
  assert.strictEqual(h.nodes.netz.watts, 27);
});

test('hubFlows: battery discharge and charge flip the edge direction', () => {
  var d = hubFlows({ pv_w: 0, bat_w: 300, grid_w: 0 });
  assert.deepStrictEqual(edge(d, 'bat'), { node: 'bat', dir: 'in', watts: 300, state: 'ok' });
  var c = hubFlows({ pv_w: 1000, bat_w: -200, grid_w: -300 });
  assert.deepStrictEqual(edge(c, 'bat'), { node: 'bat', dir: 'out', watts: 200, state: 'ok' });
  assert.strictEqual(c.nodes.haus.watts, 500);
});

test('hubFlows: absent PV / battery nodes are omitted and count as 0', () => {
  var h = hubFlows({ pv_w: null, bat_w: null, grid_w: 700 }, { pv: false, bat: false });
  assert.strictEqual(h.nodes.pv, undefined);
  assert.strictEqual(h.nodes.bat, undefined);
  assert.deepStrictEqual(h.nodes.haus, { watts: 700, state: 'ok' });
  assert.deepStrictEqual(h.edges.map(function (e) { return e.node; }), ['netz']);
});

/* ===================== balance ===================== */

test('balance: splits production and consumption', () => {
  var b = balance([rec({ pv_wh: 1000, exp_wh: 300, imp_wh: 200 })]);
  assert.deepStrictEqual(b, { prodSelf: 700, prodFeedin: 300, consSelf: 700, consImport: 200 });
});

test('balance: sums multiple slots, excludes holes', () => {
  var b = balance([
    rec({ pv_wh: 500, exp_wh: 100, imp_wh: 50 }),
    rec({ pv_wh: 500, exp_wh: 100, imp_wh: 50 }),
    rec({ pv_wh: null })
  ]);
  assert.deepStrictEqual(b, { prodSelf: 800, prodFeedin: 200, consSelf: 800, consImport: 100 });
});

test('balance: export skew never goes negative', () => {
  var b = balance([rec({ pv_wh: 100, exp_wh: 300, imp_wh: 400 })]);
  assert.strictEqual(b.prodSelf, 0);
  assert.strictEqual(b.consSelf, 0);
  assert.strictEqual(b.prodFeedin, 300);
});

test('balance: all holes → nulls', () => {
  var b = balance([rec({ pv_wh: null }), rec({ imp_wh: null })]);
  assert.deepStrictEqual(b, { prodSelf: null, prodFeedin: null, consSelf: null, consImport: null });
});

/* =============== hubFlows state (spec 010 FR-1004) =============== */

test('hubFlows: state ok/zero on known values', () => {
  var h = hubFlows({ pv_w: 1000, bat_w: 0, grid_w: -400 });
  assert.strictEqual(edge(h, 'pv').state, 'ok');
  assert.strictEqual(edge(h, 'netz').state, 'ok');
  assert.strictEqual(edge(h, 'bat').state, 'zero');   /* real zero, not unknown */
});

test('hubFlows: null pv → pv and Haus unknown, grid still known', () => {
  var h = hubFlows({ pv_w: null, bat_w: 0, grid_w: 500 });
  assert.deepStrictEqual(h.nodes.pv, { watts: null, state: 'unknown' });
  assert.strictEqual(edge(h, 'pv').state, 'unknown');
  assert.strictEqual(h.nodes.haus.state, 'unknown');   /* consumption needs pv */
  assert.deepStrictEqual(edge(h, 'netz'), { node: 'netz', dir: 'in', watts: 500, state: 'ok' });
});

test('hubFlows: null grid → grid and Haus unknown, not fake zero', () => {
  var h = hubFlows({ pv_w: 800, bat_w: 0, grid_w: null });
  assert.deepStrictEqual(h.nodes.netz, { watts: null, state: 'unknown' });
  assert.strictEqual(edge(h, 'netz').state, 'unknown');
  assert.strictEqual(h.nodes.haus.state, 'unknown');
  assert.strictEqual(edge(h, 'pv').state, 'ok');
});

test('hubFlows: null battery → grey battery edge', () => {
  var h = hubFlows({ pv_w: 0, bat_w: null, grid_w: 0 });
  assert.strictEqual(edge(h, 'bat').state, 'unknown');
  assert.strictEqual(h.nodes.haus.state, 'unknown');
});

test('hubFlows: known idle battery keeps a dimmed edge', () => {
  var h = hubFlows({ pv_w: 0, bat_w: 0, grid_w: 0 });
  assert.deepStrictEqual(edge(h, 'bat'), { node: 'bat', dir: 'in', watts: 0, state: 'zero' });
});

/* =============== flowHeadline (FR-1002) =============== */

test('flowHeadline: export with PV share', () => {
  var hl = flowHeadline(hubFlows({ pv_w: 1230, bat_w: 0, grid_w: -27 }));
  assert.deepStrictEqual(hl, { key: 'flow.status_export', vars: { pct: 100, w: 27 } });
});

test('flowHeadline: import while PV runs → partial share', () => {
  var hl = flowHeadline(hubFlows({ pv_w: 300, bat_w: 0, grid_w: 700 }));
  assert.deepStrictEqual(hl, { key: 'flow.status_import_pv', vars: { pct: 30, w: 700 } });
});

test('flowHeadline: import without PV', () => {
  var hl = flowHeadline(hubFlows({ pv_w: 0, bat_w: 0, grid_w: 800 }));
  assert.deepStrictEqual(hl, { key: 'flow.status_import', vars: { w: 800 } });
});

test('flowHeadline: battery charging is not PV coverage', () => {
  /* 1000 W PV: 200 into the battery, 300 exported → 500 W to Haus = 100 % */
  var hl = flowHeadline(hubFlows({ pv_w: 1000, bat_w: -200, grid_w: -300 }));
  assert.deepStrictEqual(hl, { key: 'flow.status_export', vars: { pct: 100, w: 300 } });
  /* battery discharge covers part of the house → PV share < 100 % */
  var hl2 = flowHeadline(hubFlows({ pv_w: 400, bat_w: 400, grid_w: 0 }));
  assert.deepStrictEqual(hl2, { key: 'flow.status_covered', vars: { pct: 50 } });
});

test('flowHeadline: covered (pv on-site, no grid exchange)', () => {
  var hl = flowHeadline(hubFlows({ pv_w: 500, bat_w: 0, grid_w: 0 }));
  assert.deepStrictEqual(hl, { key: 'flow.status_covered', vars: { pct: 100 } });
});

test('flowHeadline: idle (all zero) → idle, not covered', () => {
  assert.strictEqual(flowHeadline(hubFlows({ pv_w: 0, bat_w: 0, grid_w: 0 })).key, 'flow.status_idle');
});

test('flowHeadline: unknown grid → unknown headline', () => {
  assert.strictEqual(flowHeadline(hubFlows({ pv_w: 500, bat_w: 0, grid_w: null })).key, 'flow.status_unknown');
});

test('flowHeadline: no sample → null', () => {
  assert.strictEqual(flowHeadline(null), null);
});

/* =============== sourcesNow / sourcesToday (FR-1006) =============== */

function segMap(arr) {
  var o = {};
  arr.forEach(function (s) { o[s.key] = s.value; });
  return o;
}

test('sourcesNow: exporting with battery charging', () => {
  /* pv 2000, exporting 500, battery charging 300 */
  var r = sourcesNow({ pv_w: 2000, bat_w: -300, grid_w: -500 });
  var u = segMap(r.usage);
  assert.strictEqual(u['comp.load'], 1200);      /* house = selfuse + batDis(0) + imp(0), issue #21 */
  assert.strictEqual(u['comp.charge'], 300);
  assert.strictEqual(u['comp.feedin'], 500);
  /* the usage bar adds up to PV here (no battery discharge / grid import) */
  assert.strictEqual(1200 + 300 + 500, 2000);
  assert.strictEqual(segMap(r.cover)['comp.pv'], 1200);   /* cons = 2000 − 300 − 500 */
  assert.strictEqual(r.unknown, false);
});

test('sourcesNow: importing with battery discharge → cover segments', () => {
  var r = sourcesNow({ pv_w: 200, bat_w: 400, grid_w: 600 });
  var c = segMap(r.cover);
  assert.strictEqual(c['comp.pv'], 200);         /* selfuse (no export) */
  assert.strictEqual(c['comp.battery'], 400);
  assert.strictEqual(c['comp.grid'], 600);
});

test('sourcesNow: battery discharge + grid import, no PV → usage not empty (issue #21)', () => {
  /* house fully covered by battery + grid, PV=0 → usage bar used to be all-zero */
  var r = sourcesNow({ pv_w: 0, bat_w: 813, grid_w: 48 });
  var u = segMap(r.usage);
  assert.strictEqual(u['comp.load'], 861);       /* house = 0 + 813 + 48 */
  assert.strictEqual(u['comp.charge'], 0);
  assert.strictEqual(u['comp.feedin'], 0);
});

test('sourcesNow: null pv → unknown, no fabricated Netz share', () => {
  var r = sourcesNow({ pv_w: null, bat_w: 0, grid_w: 500 });
  assert.strictEqual(r.unknown, true);
});

test('sourcesNow: segments never negative (export skew)', () => {
  var r = sourcesNow({ pv_w: 100, bat_w: 0, grid_w: -300 });
  var u = segMap(r.usage);
  assert.strictEqual(u['comp.load'], 0);         /* clamp ≥ 0 */
  assert.strictEqual(u['comp.feedin'], 300);
});

test('sourcesToday: no battery Wh → no battery segments, sums complete slots', () => {
  var r = sourcesToday([
    rec({ pv_wh: 1000, exp_wh: 400, imp_wh: 200 }),
    rec({ pv_wh: 1000, exp_wh: 400, imp_wh: 200 })
  ]);
  var c = segMap(r.cover), u = segMap(r.usage);
  assert.strictEqual(c['comp.battery'], undefined, 'no battery in Heute');
  assert.strictEqual(u['comp.charge'], undefined, 'no battery in Heute');
  assert.strictEqual(c['comp.pv'], 1200);        /* selfuse = pv − exp */
  assert.strictEqual(c['comp.grid'], 400);       /* imp summed */
  assert.strictEqual(u['comp.feedin'], 800);     /* exp summed */
});

test('sourcesToday: battery segments once the records carry battery Wh (issue #20)', () => {
  var r = sourcesToday([
    rec({ pv_wh: 3000, exp_wh: 500, imp_wh: 0, bat_chg_wh: 1000, bat_dis_wh: 0 }),
    rec({ pv_wh: 0, exp_wh: 0, imp_wh: 200, bat_chg_wh: 0, bat_dis_wh: 800 })
  ]);
  var c = segMap(r.cover), u = segMap(r.usage);
  assert.strictEqual(r.battery, true);
  assert.strictEqual(u['comp.load'], 2500);      /* house = selfuse(1500) + dis(800) + imp(200) */
  assert.strictEqual(u['comp.charge'], 1000);
  assert.strictEqual(u['comp.feedin'], 500);     /* usage sums to pv+dis+imp 4000 */
  assert.strictEqual(c['comp.pv'], 1500);
  assert.strictEqual(c['comp.battery'], 800);
  assert.strictEqual(c['comp.grid'], 200);       /* cover sums to Verbrauch 2500 */
});

test('sourcesToday: without battery Wh the bars keep their shape', () => {
  var r = sourcesToday([rec({ pv_wh: 1000, exp_wh: 400, imp_wh: 200 })]);
  assert.strictEqual(r.battery, false);
  assert.deepStrictEqual(r.cover.map(function (s) { return s.key; }),
                         ['comp.pv', 'comp.grid']);
});

test('kpis / balance count the battery into the consumption (issue #20)', () => {
  var recs = [rec({ pv_wh: 3000, exp_wh: 500, imp_wh: 200, bat_chg_wh: 1000, bat_dis_wh: 800 })];
  var k = kpis(recs, {});
  /* Verbrauch = 3000 − 500 + 200 + 800 − 1000 = 2500; self-covered 2300 */
  assert.ok(near(k.autarky, 2300 / 2500), 'autarky ' + k.autarky);
  assert.ok(near(k.selfuse, 2500 / 3000), 'selfuse ' + k.selfuse);
  var b = balance(recs);
  assert.strictEqual(b.prodSelf, 2500);
  assert.strictEqual(b.prodFeedin, 500);
  assert.strictEqual(b.consSelf, 2300);
  assert.strictEqual(b.consImport, 200);
});

test('sourcesToday: all holes → unknown', () => {
  var r = sourcesToday([rec({ pv_wh: null })]);
  assert.strictEqual(r.unknown, true);
  assert.deepStrictEqual(r.cover, []);
});

/* =============== pvSeriesAllNull (FR-1005) =============== */

test('pvSeriesAllNull: all null → true', () => {
  assert.strictEqual(pvSeriesAllNull([null, null, undefined]), true);
});
test('pvSeriesAllNull: one number → false', () => {
  assert.strictEqual(pvSeriesAllNull([null, 0, null]), false);
});
test('pvSeriesAllNull: empty → false (no false alarm)', () => {
  assert.strictEqual(pvSeriesAllNull([]), false);
});
