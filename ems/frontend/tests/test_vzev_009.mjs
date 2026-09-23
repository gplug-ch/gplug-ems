
/* Tests for the spec 009 pure extensions to lib/vzev.js and lib/aggregate.js:
   slotTariff, capReference, quality, explainSlot, HT/NT buildBilling split +
   entry_ts filtering, the FR-909 HT/NT cost split in aggregate, and the
   NFR-903 regression proving flat-config results are bit-identical to pre-009.

   TZ is pinned to Europe/Zurich so the local-time slotTariff window matching is
   deterministic regardless of the host machine. */
process.env.TZ = 'Europe/Zurich';

import test from 'node:test';
import assert from 'node:assert';
import {
  slotTariff, capReference, htWeekFraction, dayMatches, hasHtNt,
  quality, lastSlotTs, explainSlot, buildBilling, allocate,
} from '../src/lib/vzev.js';
import { aggregate, deriveCosts, splitHtNt } from '../src/lib/aggregate.js';

/* Europe/Zurich standard time is UTC+1 (winter). Pick a January (CET) day so
   local wall-clock hours are predictable: 2026-01-05 is a Monday.
   2026-01-05 00:00 CET = 2026-01-04 23:00 UTC = 1767567600. */
const MON_0000_CET = Math.floor(Date.UTC(2026, 0, 4, 23, 0, 0) / 1000);
function cet(dayOffset, hour, min) {
  return MON_0000_CET + dayOffset * 86400 + hour * 3600 + (min || 0) * 60;
}

const HTNT = {
  grid_import_ht_chf_kwh: 0.30,
  grid_import_nt_chf_kwh: 0.20,
  grid_import_chf_kwh: 0.26,
  ht_windows: [
    { days: 'mo-fr', from: 6, to: 21 },
    { days: 'sa', from: 6, to: 13 },
  ],
};
const FLAT = { grid_import_chf_kwh: 0.26, vzev_import_chf_kwh: 0.22, vzev_export_chf_kwh: 0.22 };

/* --- dayMatches --- */
test('dayMatches parses ranges, singles and wrap', () => {
  assert.strictEqual(dayMatches('mo-fr', 0), true);   // Monday
  assert.strictEqual(dayMatches('mo-fr', 4), true);   // Friday
  assert.strictEqual(dayMatches('mo-fr', 5), false);  // Saturday
  assert.strictEqual(dayMatches('sa', 5), true);
  assert.strictEqual(dayMatches('sa-mo', 6), true);   // wrap: Sun in sa-mo
  assert.strictEqual(dayMatches('', 3), true);        // empty = every day
  assert.strictEqual(dayMatches(undefined, 3), true);
});

/* --- slotTariff --- */
test('slotTariff: flat when HT/NT not configured', () => {
  assert.strictEqual(slotTariff(cet(0, 10, 0), FLAT), 'flat');
  assert.strictEqual(slotTariff(cet(0, 10, 0), {}), 'flat');
});

test('slotTariff: weekday HT window boundaries (local time)', () => {
  assert.strictEqual(slotTariff(cet(0, 5, 45), HTNT), 'nt');  // before 06:00
  assert.strictEqual(slotTariff(cet(0, 6, 0), HTNT), 'ht');   // inclusive start
  assert.strictEqual(slotTariff(cet(0, 20, 45), HTNT), 'ht'); // inside
  assert.strictEqual(slotTariff(cet(0, 21, 0), HTNT), 'nt');  // exclusive end
});

test('slotTariff: Saturday shorter window, Sunday all NT', () => {
  assert.strictEqual(slotTariff(cet(5, 10, 0), HTNT), 'ht');  // Sat 10:00
  assert.strictEqual(slotTariff(cet(5, 14, 0), HTNT), 'nt');  // Sat 14:00 (>13)
  assert.strictEqual(slotTariff(cet(6, 10, 0), HTNT), 'nt');  // Sunday -> NT
});

test('slotTariff: HT/NT rates set but empty windows -> flat', () => {
  const noWin = { grid_import_ht_chf_kwh: 0.3, grid_import_nt_chf_kwh: 0.2, ht_windows: [] };
  assert.strictEqual(hasHtNt(noWin), false);
  assert.strictEqual(slotTariff(cet(0, 10, 0), noWin), 'flat');
});

/* --- capReference --- */
test('capReference: flat external -> 80% of flat', () => {
  assert.strictEqual(capReference({ grid_import_chf_kwh: 0.30 }), 0.24);
  assert.strictEqual(capReference({}), null); // nothing configured
});

test('capReference: HT/NT weighted by window fraction', () => {
  const f = htWeekFraction(HTNT);
  const expected = Math.round((0.30 * f + 0.20 * (1 - f)) * 0.8 * 100) / 100;
  assert.strictEqual(capReference(HTNT), expected);
  assert.ok(f > 0 && f < 1, 'HT fraction strictly between 0 and 1');
});

/* --- quality --- */
function ring(pairs) {
  // pairs: [[ts, imp, exp], ...]
  return pairs.reduce((a, p) => a.concat(p), []);
}

test('quality: complete when every member has every slot', () => {
  const raw = {
    producer_id: 'p', self_id: 'me',
    data: {
      p: ring([[cet(0, 12), 0, 3000], [cet(0, 12) + 900, 0, 3000]]),
      me: ring([[cet(0, 12), 1000, 0], [cet(0, 12) + 900, 1000, 0]]),
      b: ring([[cet(0, 12), 500, 0], [cet(0, 12) + 900, 500, 0]]),
    },
  };
  const members = [{ id: 'me' }, { id: 'b' }];
  const q = quality(raw, members);
  assert.strictEqual(q.expected, 2);
  assert.strictEqual(q.complete, 2);
  assert.strictEqual(q.provisional, 0);
  assert.strictEqual(q.missing, 0);
});

test('quality: a silent member makes slots provisional', () => {
  const t0 = cet(0, 12);
  const raw = {
    producer_id: 'p', self_id: 'me',
    data: {
      p: ring([[t0, 0, 3000], [t0 + 900, 0, 3000]]),
      me: ring([[t0, 1000, 0], [t0 + 900, 1000, 0]]),
      b: ring([[t0, 500, 0]]),  // missing the second slot
    },
  };
  const members = [{ id: 'me' }, { id: 'b' }];
  const q = quality(raw, members);
  assert.strictEqual(q.expected, 2);
  assert.strictEqual(q.provisional, 1); // second slot provisional
  assert.strictEqual(q.complete, 1);
  assert.strictEqual(q.perMember.b.have, 1);
  assert.strictEqual(q.perMember.b.expected, 2);
});

test('quality: own data absent counts as missing', () => {
  const t0 = cet(0, 12);
  const raw = {
    producer_id: 'p', self_id: 'me',
    data: {
      p: ring([[t0, 0, 3000]]),
      b: ring([[t0, 500, 0]]),
      // 'me' has no ring at all
    },
  };
  const q = quality(raw, [{ id: 'me' }, { id: 'b' }]);
  assert.strictEqual(q.missing, 1);
});

test('quality: entry_ts excludes pre-entry slots from the denominator', () => {
  const t0 = cet(0, 12);
  const raw = {
    producer_id: 'p', self_id: 'me',
    data: {
      p: ring([[t0, 0, 3000], [t0 + 900, 0, 3000]]),
      me: ring([[t0, 1000, 0], [t0 + 900, 1000, 0]]),
      b: ring([[t0 + 900, 500, 0]]), // b only delivers the 2nd slot
    },
  };
  // b entered right before the second slot -> first slot must NOT count against b
  const members = [{ id: 'me' }, { id: 'b', entry_ts: t0 + 900 }];
  const q = quality(raw, members);
  assert.strictEqual(q.perMember.b.expected, 1); // only the 2nd slot expected
  assert.strictEqual(q.perMember.b.have, 1);
  assert.strictEqual(q.provisional, 0);          // no provisional slots now
  assert.strictEqual(q.complete, 2);
});

test('lastSlotTs returns the newest delivered ts', () => {
  const t0 = cet(0, 12);
  const raw = { data: { b: ring([[t0, 1, 0], [t0 + 900, 2, 0]]) } };
  assert.strictEqual(lastSlotTs(raw, 'b'), t0 + 900);
  assert.strictEqual(lastSlotTs(raw, 'nope'), null);
});

/* --- explainSlot: consistency with allocate() --- */
test('explainSlot inputs match the allocate() result exactly', () => {
  const t0 = cet(0, 12);
  const raw = {
    producer_id: 'p', self_id: 'me',
    data: {
      p: ring([[t0, 0, 3200]]),
      me: ring([[t0, 1400, 0]]),
      b: ring([[t0, 2000, 0]]),
    },
  };
  const e = explainSlot(t0, raw, 'me');
  const alloc = allocate(3200, { me: 1400, b: 2000 });
  assert.strictEqual(e.prodWh, 3200);
  assert.strictEqual(e.totalImpWh, 3400);
  assert.strictEqual(e.memberImpWh, 1400);
  assert.strictEqual(e.allocatedWh, alloc.me); // one source of truth
  assert.ok(Math.abs(e.sharePct - (1400 / 3400 * 100)) < 0.01);
});

test('explainSlot: no producer data -> everything zero', () => {
  const t0 = cet(0, 12);
  const raw = { producer_id: 'p', self_id: 'me', data: { me: ring([[t0, 1400, 0]]) } };
  const e = explainSlot(t0, raw, 'me');
  assert.strictEqual(e.prodWh, 0);
  assert.strictEqual(e.allocatedWh, 0);
});

/* --- buildBilling HT/NT split + entry_ts + regression --- */
test('buildBilling HT/NT split sums to the flat total', () => {
  const htTs = cet(0, 10);          // Monday 10:00 -> HT
  const ntTs = cet(0, 23);          // Monday 23:00 -> NT
  const flowsInRange = [
    { ts: htTs, members: { b: 1000 } },
    { ts: ntTs, members: { b: 500 } },
  ];
  const members = [{ id: 'b', name: 'B' }];
  const bill = buildBilling('2026-Q1', flowsInRange, members, HTNT);
  const row = bill.members[0];
  assert.strictEqual(row.wh, 1500);
  assert.strictEqual(row.ht_wh, 1000);
  assert.strictEqual(row.nt_wh, 500);
  assert.strictEqual(row.ht_wh + row.nt_wh, row.wh);
});

test('buildBilling entry_ts excludes pre-entry slots from a member', () => {
  const t0 = cet(0, 10);
  const flowsInRange = [
    { ts: t0, members: { b: 1000 } },
    { ts: t0 + 900, members: { b: 500 } },
  ];
  const members = [{ id: 'b', name: 'B', entry_ts: t0 + 900 }];
  const bill = buildBilling('2026-Q1', flowsInRange, members, FLAT);
  assert.strictEqual(bill.members[0].wh, 500); // first slot excluded
});

test('buildBilling flat regression: bit-identical to pre-009 shape', () => {
  const APR1 = 1775001600;
  const flowsInRange = [
    { ts: APR1, members: { 'site-b': 1000, 'site-c': 500 } },
    { ts: APR1 + 86400, members: { 'site-b': 2000, 'site-c': 500 } },
    { ts: 1778000000, members: { 'site-b': 1000, 'site-c': 1000 } },
  ];
  const members = [{ id: 'site-b', name: 'Müller' }, { id: 'site-c', name: 'Huber' }];
  const bill = buildBilling('2026-Q2', flowsInRange, members, FLAT);
  // no HT/NT keys must leak into a flat billing
  bill.members.forEach((m) => {
    assert.ok(!('ht_wh' in m), 'flat row has no ht_wh');
    assert.ok(!('nt_wh' in m), 'flat row has no nt_wh');
  });
  assert.ok(!('quality' in bill), 'no quality key unless supplied');
  const byId = {};
  bill.members.forEach((m) => { byId[m.id] = m; });
  assert.strictEqual(byId['site-b'].wh, 4000);
  assert.strictEqual(byId['site-c'].wh, 2000);
  assert.strictEqual(bill.total.exp_wh, 6000);
});

test('buildBilling attaches quality only when supplied (5th arg)', () => {
  const q = { expected: 4, complete: 3, provisional: 1, missing: 0, perMember: {} };
  const bill = buildBilling('2026-Q1', [{ ts: cet(0, 10), members: { b: 100 } }],
    [{ id: 'b' }], FLAT, q);
  assert.deepStrictEqual(bill.quality, q);
});

/* --- aggregate FR-909 cost split + flat regression --- */
test('aggregate: HT/NT cost split at 15m derived from each slot window', () => {
  const base = [
    { ts: cet(0, 10), imp_wh: 1000, exp_wh: 0, pv_wh: 0, vzev_in_wh: 0, vzev_out_wh: 0 }, // HT
    { ts: cet(0, 23), imp_wh: 2000, exp_wh: 0, pv_wh: 0, vzev_in_wh: 0, vzev_out_wh: 0 }, // NT
  ];
  const rows = aggregate(base, '15m', '15m', HTNT);
  const ht = rows.find((r) => r.ts === cet(0, 10));
  const nt = rows.find((r) => r.ts === cet(0, 23));
  assert.strictEqual(ht.cost_import_ht_chf, 0.30);         // 1000Wh * 0.30/kWh
  assert.strictEqual(ht.cost_import_nt_chf, 0);
  assert.strictEqual(nt.cost_import_nt_chf, 0.40);         // 2000Wh * 0.20/kWh
  assert.strictEqual(ht.cost_import_chf, 0.30);            // total == ht+nt
});

test('aggregate: coarse bucket sums the 15m HT/NT split (not re-derived)', () => {
  // Two 15m slots on the same day: one HT (1000Wh), one NT (2000Wh)
  const base = [
    { ts: cet(0, 10), imp_wh: 1000, exp_wh: 0, pv_wh: 0, vzev_in_wh: 0, vzev_out_wh: 0 },
    { ts: cet(0, 23), imp_wh: 2000, exp_wh: 0, pv_wh: 0, vzev_in_wh: 0, vzev_out_wh: 0 },
  ];
  const day = aggregate(base, '15m', '1d', HTNT);
  assert.strictEqual(day.length, 1);
  assert.strictEqual(day[0].grid_ht_wh, 1000);
  assert.strictEqual(day[0].grid_nt_wh, 2000);
  assert.strictEqual(day[0].cost_import_ht_chf, 0.30);
  assert.strictEqual(day[0].cost_import_nt_chf, 0.40);
  assert.strictEqual(day[0].cost_import_chf, 0.70);
});

test('aggregate: flat tariffs are bit-identical to pre-009 (no HT/NT keys)', () => {
  const base = [
    { ts: cet(0, 10), imp_wh: 1000, exp_wh: 100, pv_wh: 200, vzev_in_wh: 50, vzev_out_wh: 10 },
  ];
  const rows = aggregate(base, '15m', '15m', FLAT);
  const r = rows[0];
  assert.ok(!('grid_ht_wh' in r), 'no grid_ht_wh on flat');
  assert.ok(!('cost_import_ht_chf' in r), 'no HT cost on flat');
  // matches the plain deriveCosts output exactly
  const direct = deriveCosts(base[0], FLAT);
  assert.strictEqual(r.cost_import_chf, direct.cost_import_chf);
  assert.strictEqual(r.cost_vzev_chf, direct.cost_vzev_chf);
});

test('splitHtNt is a no-op for flat tariffs', () => {
  const rec = { ts: cet(0, 10), imp_wh: 1000, vzev_in_wh: 0 };
  assert.strictEqual(splitHtNt(rec, FLAT), rec); // same reference, untouched
});
