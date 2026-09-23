/* Tests for lib/vzev.js — the browser port of the former device-side vZEV
   allocation / flow bucketing / billing (spec 005). Mirrors the assertions
   removed from ems/backend/tests/vzev/test_vzev.be. */
import test from 'node:test';
import assert from 'node:assert';
import { allocate, flows, flows15m, quarterRange, buildBilling, peerSlot, lastSlotTs,
         ownShare, withOwnShare } from '../src/lib/vzev.js';

function sum(m) { return Object.keys(m).reduce(function (a, k) { return a + m[k]; }, 0); }

/* --- allocate --- */

test('allocate: full allocation when export covers imports', () => {
  const a = allocate(2000, { a: 1500, b: 500 });
  assert.strictEqual(a.a, 1500);
  assert.strictEqual(a.b, 500);
  assert.strictEqual(sum(a), 2000);
});

test('allocate: proportional when export < total imports', () => {
  const a = allocate(1000, { a: 1500, b: 500 });
  assert.strictEqual(a.a, 750);
  assert.strictEqual(a.b, 250);
  assert.strictEqual(sum(a), 1000); /* == min(exp, imp) */
});

test('allocate: capped at total imports, rest stays exported', () => {
  const a = allocate(1000, { a: 200, b: 100 });
  assert.strictEqual(a.a, 200);
  assert.strictEqual(a.b, 100);
  assert.strictEqual(sum(a), 300);
});

test('allocate: zero producer export -> all zero', () => {
  assert.strictEqual(sum(allocate(0, { a: 100, b: 50 })), 0);
});

test('allocate: no imports -> empty', () => {
  assert.deepStrictEqual(allocate(1000, {}), {});
});

test('allocate: largest-remainder tie broken by lowest id (determinism)', () => {
  const a = allocate(10, { a: 10, b: 10, c: 10 });
  assert.strictEqual(a.a, 4);
  assert.strictEqual(a.b, 3);
  assert.strictEqual(a.c, 3);
  assert.strictEqual(sum(a), 10);
});

test('allocate: order-independent + per-member cap never exceeded', () => {
  const a1 = allocate(1000, { x: 700, y: 200, z: 100 });
  const a2 = allocate(1000, { z: 100, y: 200, x: 700 });
  assert.deepStrictEqual(a1, a2);
  [0, 1, 50, 137, 999, 1500, 3000].forEach(function (exp) {
    const imp = { m1: 300, m2: 700, m3: 250 };
    const r = allocate(exp, imp);
    assert.strictEqual(sum(r), Math.min(exp, 1250), 'exact sum for exp=' + exp);
    Object.keys(r).forEach(function (k) {
      assert.ok(r[k] <= imp[k] && r[k] >= 0, 'cap for exp=' + exp + ' member=' + k);
    });
  });
});

/* --- flows bucketing --- */

const day0 = 1728000; /* exact multiple of 86400 -> UTC day start */
const raw = {
  producer_id: 'site-p',
  self_id: null,
  data: {
    'site-p': [day0, 0, 100, day0 + 900, 0, 200],
    'site-b': [day0, 100, 0, day0 + 900, 200, 0]
  }
};

test('flows 15m: one record per slot', () => {
  const f = flows(raw, '15m', 10);
  assert.strictEqual(f.length, 2);
  assert.strictEqual(f[0].members['site-b'], 100);
  assert.strictEqual(f[1].members['site-b'], 200);
});

test('flows 1d: single bucket summing both slots at day start', () => {
  const f = flows(raw, '1d', 10);
  assert.strictEqual(f.length, 1);
  assert.strictEqual(f[0].ts, day0);
  assert.strictEqual(f[0].members['site-b'], 300);
});

/* --- quarterRange --- */

test('quarterRange 2026-Q2 = [Apr 1, Jul 1) UTC', () => {
  assert.deepStrictEqual(quarterRange('2026-Q2'), [1775001600, 1782864000]);
});

test('quarterRange invalid -> null', () => {
  assert.strictEqual(quarterRange('2026-Q5'), null);
  assert.strictEqual(quarterRange('bad'), null);
  assert.strictEqual(quarterRange(''), null);
});

/* --- buildBilling --- */

test('buildBilling aggregates per-member + per-month with names', () => {
  const APR1 = 1775001600;
  const flowsInRange = [
    { ts: APR1, members: { 'site-b': 1000, 'site-c': 500 } },
    { ts: APR1 + 86400, members: { 'site-b': 2000, 'site-c': 500 } },
    { ts: 1778000000, members: { 'site-b': 1000, 'site-c': 1000 } } /* May */
  ];
  const members = [
    { id: 'site-b', name: 'Müller' },
    { id: 'site-c', name: 'Huber' }
  ];
  const tariffs = { vzev_import_chf_kwh: 0.22, vzev_export_chf_kwh: 0.22 };
  const bill = buildBilling('2026-Q2', flowsInRange, members, tariffs);

  assert.strictEqual(bill.quarter, '2026-Q2');
  assert.strictEqual(bill.total.exp_wh, 6000);

  const byId = {};
  bill.members.forEach(function (m) { byId[m.id] = m; });
  assert.strictEqual(byId['site-b'].wh, 4000);
  assert.strictEqual(byId['site-c'].wh, 2000);
  assert.strictEqual(byId['site-b'].name, 'Müller');

  assert.strictEqual(bill.months.length, 2);
  assert.strictEqual(bill.months[0].wh, 4000); /* April 1500 + 2500 */
  assert.strictEqual(bill.months[1].wh, 2000); /* May */
  assert.ok(bill.note && bill.note.length > 0);

  /* regression: the Abrechnung page's BarChart reads total.months and each
     member's own .months (not the top-level `months`, which is the whole
     community's sum) — both must be populated or the charts render empty. */
  assert.deepStrictEqual(bill.total.months, bill.months);
  assert.strictEqual(byId['site-b'].months.length, 2);
  assert.strictEqual(byId['site-b'].months[0].wh, 3000); /* April 1000 + 2000 */
  assert.strictEqual(byId['site-b'].months[1].wh, 1000); /* May */
  assert.strictEqual(byId['site-c'].months[0].wh, 1000); /* April 500 + 500 */
  assert.strictEqual(byId['site-c'].months[1].wh, 1000); /* May */

  /* no grid rate in the tariffs -> the grid-comparison field stays absent
     (keeps the pre-009 flat fixture bit-identical) */
  assert.ok(!('cost_grid_chf' in byId['site-b']));
});

test('buildBilling computes cost_grid_chf from the local grid tariff', () => {
  const APR1 = 1775001600;
  const flowsInRange = [{ ts: APR1, members: { 'site-b': 4000 } }];
  const members = [{ id: 'site-b', name: 'Müller' }];
  const tariffs = {
    vzev_import_chf_kwh: 0.22,
    vzev_export_chf_kwh: 0.22,
    grid_import_chf_kwh: 0.26
  };
  const bill = buildBilling('2026-Q2', flowsInRange, members, tariffs);
  const m = bill.members[0];
  /* the consumer note compares 4 kWh at 0.22 vZEV vs 0.26 grid */
  assert.strictEqual(m.chf, 0.88);
  assert.strictEqual(m.cost_grid_chf, 1.04);
});

test('flows15m: producer export capped, consumer gets its import', () => {
  const f = flows15m(raw);
  assert.strictEqual(f.length, 2);
  /* producer exp 100 >= import 100 -> site-b gets full 100 */
  assert.strictEqual(f[0].members['site-b'], 100);
});

/* --- peerSlot / lastSlotTs tolerance (issue #4) ---
   The device now stores peer slots in append-only bucket files: a
   correction for an already-written ts is APPENDED rather than rewritten
   in place, so a ring can hold duplicate ts entries, and entries are not
   guaranteed to stay in ascending ts order across the whole ring. */

test('peerSlot: duplicate ts -> the LAST (most recently written) entry wins', () => {
  const ring = [900, 100, 0, 1800, 200, 0, 900, 150, 0];
  assert.deepStrictEqual(peerSlot(ring, 900), [150, 0]);
  assert.deepStrictEqual(peerSlot(ring, 1800), [200, 0]);
});

test('peerSlot: unordered ring still resolves any ts', () => {
  const ring = [1800, 200, 0, 900, 100, 0, 2700, 300, 0];
  assert.deepStrictEqual(peerSlot(ring, 900), [100, 0]);
  assert.deepStrictEqual(peerSlot(ring, 2700), [300, 0]);
});

test('lastSlotTs: an out-of-order correction does not shadow the true max ts', () => {
  /* a late correction for ts=900 is appended AFTER ts=1800, so the ring's
     final triple is not the newest slot -> lastSlotTs must take the max */
  const rawOoo = { data: { peer: [900, 100, 0, 1800, 200, 0, 900, 150, 0] } };
  assert.strictEqual(lastSlotTs(rawOoo, 'peer'), 1800);
});

test('lastSlotTs: no data for the member -> null', () => {
  assert.strictEqual(lastSlotTs({ data: {} }, 'peer'), null);
  assert.strictEqual(lastSlotTs({}, 'peer'), null);
});

/* --- ownShare / withOwnShare (spec 011 FR-1105) ---
   These replace the device's store.set_vzev write-back: the browser derives
   each site's own vZEV share from the archived peer slots. */

test('ownShare: consumer gets what the allocation assigned to it', () => {
  const r = { producer_id: 'site-p', self_id: 'site-b', data: raw.data };
  const s = ownShare(r);
  assert.deepStrictEqual(s[day0], { vzev_in_wh: 100, vzev_out_wh: 0 });
  /* slot 2: producer exported 200, site-b imported 200 -> full 200 */
  assert.deepStrictEqual(s[day0 + 900], { vzev_in_wh: 200, vzev_out_wh: 0 });
});

test('ownShare: producer gets the sum handed to all members', () => {
  const r = {
    producer_id: 'site-p', self_id: 'site-p',
    data: {
      'site-p': [day0, 0, 1000],
      'site-b': [day0, 600, 0],
      'site-c': [day0, 200, 0]
    }
  };
  const s = ownShare(r);
  assert.deepStrictEqual(s[day0], { vzev_in_wh: 0, vzev_out_wh: 800 });
});

test('ownShare: producer export short of demand -> share equals what was split', () => {
  const r = {
    producer_id: 'p', self_id: 'p',
    data: { p: [day0, 0, 300], b: [day0, 600, 0], c: [day0, 600, 0] }
  };
  assert.deepStrictEqual(ownShare(r)[day0], { vzev_in_wh: 0, vzev_out_wh: 300 });
});

test('ownShare: no self id -> nothing derived', () => {
  assert.deepStrictEqual(ownShare(raw), {});
});

test('withOwnShare: joins onto the 15-min records by ts, 0 where no allocation', () => {
  const r = { producer_id: 'site-p', self_id: 'site-b', data: raw.data };
  const recs = [
    { ts: day0, imp_wh: 500, exp_wh: 0, pv_wh: 0 },
    { ts: day0 + 900, imp_wh: 400, exp_wh: 0, pv_wh: 0 },
    { ts: day0 + 1800, imp_wh: 300, exp_wh: 0, pv_wh: 0 }   /* no peer slot */
  ];
  const out = withOwnShare(recs, r);
  assert.strictEqual(out[0].vzev_in_wh, 100);
  assert.strictEqual(out[1].vzev_in_wh, 200);
  assert.strictEqual(out[2].vzev_in_wh, 0);
  assert.strictEqual(out[2].vzev_out_wh, 0);
  /* input records are not mutated */
  assert.strictEqual(recs[0].vzev_in_wh, undefined);
  assert.strictEqual(out[0].imp_wh, 500);
});
