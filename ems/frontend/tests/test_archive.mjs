/* lib/archive.js — the browser-side IndexedDB archive (spec 011 FR-1101…1111).
   Runs under node against fake-indexeddb; the module itself never touches the
   DOM, so no browser is needed. */
import test from 'node:test';
import assert from 'node:assert';
import 'fake-indexeddb/auto';

const archive = await import('../src/lib/archive.js');

const SLOT = 900;
const T0 = 1767225600;               /* 2026-01-01 00:00 UTC */
const SITE = 'site-a';

/* A fake device: `slots` is the buffer it still serves, ordered oldest-first.
   It mirrors webservice.energyrequest() AFTER the FR-1103 paging change:
   with `from`, the OLDEST `count` records at or after `from`; without it, the
   newest `count`. */
function device(slots, raw) {
  const calls = [];
  return {
    calls,
    getEnergy(res, count, from) {
      calls.push({ res, count, from });
      assert.strictEqual(res, '15m');
      let sel = slots;
      if (from !== undefined && from !== null) {
        sel = slots.filter((r) => r.ts >= from).slice(0, count);
      } else {
        sel = slots.slice(-count);
      }
      return Promise.resolve(sel.map((r) => Object.assign({}, r)));
    },
    getVzevRaw() { return Promise.resolve(raw || null); }
  };
}

function series(n, startTs = T0, step = SLOT) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({ ts: startTs + i * step, imp_wh: 100 + i, exp_wh: i % 7, pv_wh: 10 * i });
  }
  return out;
}

async function freshSite(name) {
  await archive.clearSite(name).catch(() => {});
  return name;
}

test('IndexedDB is reachable in this environment', async () => {
  assert.strictEqual(await archive.available(), true);
});

test('first sync fills an empty archive from the device buffer', async () => {
  const site = await freshSite('first-sync');
  const dev = device(series(96));
  const cov = await archive.sync(dev, site);
  assert.strictEqual(cov.count, 96);
  assert.strictEqual(cov.firstE15Ts, T0);
  assert.strictEqual(cov.lastE15Ts, T0 + 95 * SLOT);
  assert.deepStrictEqual(cov.gaps, []);
  assert.strictEqual(dev.calls[0].from, 0, 'empty archive starts at 0');
});

test('incremental sync asks for from = last + 900 and upserts idempotently', async () => {
  const site = await freshSite('incremental');
  const slots = series(96);
  const dev = device(slots);
  await archive.sync(dev, site);

  /* same session, device grew by 4 slots */
  slots.push(...series(4, T0 + 96 * SLOT));
  const dev2 = device(slots);
  const cov = await archive.sync(dev2, site);
  assert.strictEqual(cov.count, 100);
  /* first sync of a SESSION rewinds 2 days; this one is the second, so it
     resumes exactly after the newest archived slot */
  assert.strictEqual(dev2.calls[0].from, T0 + 95 * SLOT + SLOT);

  /* re-syncing the same data changes nothing (idempotent upsert) */
  const again = await archive.sync(device(slots), site);
  assert.strictEqual(again.count, 100);
  const rows = await archive.range(site, 0, 9999999999);
  assert.strictEqual(rows.length, 100);
  assert.deepStrictEqual(rows[0], { ts: T0, imp_wh: 100, exp_wh: 0, pv_wh: 0 });
});

test('sync pages through a buffer larger than one request', async () => {
  const site = await freshSite('paging');
  const dev = device(series(archive.PAGE * 2 + 5));
  const cov = await archive.sync(dev, site);
  assert.strictEqual(cov.count, archive.PAGE * 2 + 5);
  assert.ok(dev.calls.length >= 3, 'expected at least three pages, got ' + dev.calls.length);
  dev.calls.forEach((c) => assert.strictEqual(c.count, archive.PAGE));
});

test('gap detection across a range the device no longer covers', async () => {
  const site = await freshSite('gaps');
  await archive.putEnergy(site, series(4));                       /* four slots */
  await archive.putEnergy(site, series(4, T0 + 400 * SLOT));      /* after a hole */
  const cov = await archive.coverage(site);
  assert.strictEqual(cov.count, 8);
  assert.deepStrictEqual(cov.gaps, [[T0 + 4 * SLOT, T0 + 399 * SLOT]]);
});

test('peer slots: last triple for a ts wins, like vzev.peerSlot()', async () => {
  const site = await freshSite('peers');
  const raw = {
    producer_id: 'prod', self_id: 'me',
    tariffs: { vzev_import_chf_kwh: 0.2 },
    data: {
      prod: [T0, 0, 500, T0 + SLOT, 0, 600],
      me: [T0, 300, 0, T0, 350, 0]            /* correction appended for T0 */
    }
  };
  await archive.sync(device(series(2), raw), site);
  const back = await archive.rawRange(site, T0, T0 + SLOT);
  assert.strictEqual(back.producer_id, 'prod');
  assert.strictEqual(back.self_id, 'me');
  assert.deepStrictEqual(back.tariffs, { vzev_import_chf_kwh: 0.2 });
  assert.deepStrictEqual(back.data.me, [T0, 350, 0]);
  assert.deepStrictEqual(back.data.prod, [T0, 0, 500, T0 + SLOT, 0, 600]);
});

test('rawRange restricts to the requested window', async () => {
  const site = await freshSite('rawrange');
  const raw = { producer_id: 'p', self_id: 'me', data: {
    p: [T0, 0, 100, T0 + SLOT, 0, 200, T0 + 2 * SLOT, 0, 300]
  } };
  await archive.sync(device(series(3), raw), site);
  const back = await archive.rawRange(site, T0 + SLOT, T0 + SLOT);
  assert.deepStrictEqual(back.data.p, [T0 + SLOT, 0, 200]);
});

test('export/import round-trip is stable and refuses a foreign site', async () => {
  const site = await freshSite('export');
  const raw = { producer_id: 'p', self_id: site, data: { p: [T0, 0, 500] } };
  await archive.sync(device(series(8), raw), site);
  const text = await archive.exportText(site);

  await archive.clearSite(site);
  assert.strictEqual((await archive.coverage(site)).count, 0);

  const cov = await archive.importText(text, site);
  assert.strictEqual(cov.count, 8);
  const again = await archive.exportText(site);
  assert.strictEqual(again, text, 'round-trip must be byte-stable');

  await assert.rejects(() => archive.importText(text, 'other-site'), /site mismatch/);
  await assert.rejects(() => archive.importText('nonsense\r\n', site), /not a gplug archive/);
});

test('null Wh survive the archive and the export (never zero-filled)', async () => {
  const site = await freshSite('holes');
  await archive.putEnergy(site, [
    { ts: T0, imp_wh: null, exp_wh: 5, pv_wh: 0, partial: true },
    { ts: T0 + SLOT, imp_wh: 7, exp_wh: null, pv_wh: 1 }
  ]);
  const rows = await archive.range(site, 0, 9999999999);
  assert.strictEqual(rows[0].imp_wh, null);
  assert.strictEqual(rows[0].partial, true);
  assert.strictEqual(rows[1].exp_wh, null);
  const cov = await archive.importText(await archive.exportText(site), site);
  assert.strictEqual(cov.count, 2);
  const back = await archive.range(site, 0, 9999999999);
  assert.deepStrictEqual(back, rows);
});

test('battery Wh survive archive, range and a v2 export (issue #20)', async () => {
  const site = await freshSite('battery');
  await archive.putEnergy(site, [
    { ts: T0, imp_wh: 10, exp_wh: 0, pv_wh: 100, bat_chg_wh: 60, bat_dis_wh: 0 },
    { ts: T0 + SLOT, imp_wh: 20, exp_wh: 0, pv_wh: 0 }
  ]);
  const rows = await archive.range(site, 0, 9999999999);
  assert.strictEqual(rows[0].bat_chg_wh, 60);
  assert.strictEqual(rows[0].bat_dis_wh, 0);
  assert.ok(!('bat_chg_wh' in rows[1]), 'no battery keys on a record without them');
  const text = await archive.exportText(site);
  assert.match(text.split('\r\n')[0], /;2;/);
  await archive.importText(text, site);
  assert.deepStrictEqual(await archive.range(site, 0, 9999999999), rows);
});

test('a v1 export (no battery columns) still imports', async () => {
  const site = await freshSite('v1file');
  const v1 = '\ufeffgplug-archive;1;' + site + '\r\ne;' + T0 + ';1;2;3;0\r\n';
  const cov = await archive.importText(v1, site);
  assert.strictEqual(cov.count, 1);
  const rows = await archive.range(site, 0, 9999999999);
  assert.deepStrictEqual(rows, [{ ts: T0, imp_wh: 1, exp_wh: 2, pv_wh: 3 }]);
});

test('archives of two site ids coexist under one origin', async () => {
  await freshSite('site-x');
  await freshSite('site-y');
  await archive.sync(device(series(3)), 'site-x');
  await archive.sync(device(series(5)), 'site-y');
  assert.strictEqual((await archive.coverage('site-x')).count, 3);
  assert.strictEqual((await archive.coverage('site-y')).count, 5);
  const sites = await archive.listSites();
  assert.ok(sites.includes('site-x') && sites.includes('site-y'));
  await archive.clearSite('site-x');
  assert.strictEqual((await archive.coverage('site-x')).count, 0);
  assert.strictEqual((await archive.coverage('site-y')).count, 5);
});

/* --- live power rings (Übersicht sparklines survive a reload) ------------- */

test('live rings round-trip per kind and id, nulls kept', async () => {
  const site = await freshSite('live-a');
  await archive.putLive(site, 'prod', {
    pv1: [{ t: T0, y: 1200 }, { t: T0 + 10, y: null }],
    bat: [{ t: T0, y: -400 }]
  });
  await archive.putLive(site, 'load', { dryer: [{ t: T0, y: 0 }] });

  const prod = await archive.getLive(site, 'prod', 0);
  assert.deepStrictEqual(prod.pv1, [{ t: T0, y: 1200 }, { t: T0 + 10, y: null }]);
  assert.deepStrictEqual(prod.bat, [{ t: T0, y: -400 }]);
  assert.strictEqual(prod.dryer, undefined, 'kinds do not leak into each other');
  assert.deepStrictEqual(await archive.getLive(site, 'load', 0),
    { dryer: [{ t: T0, y: 0 }] });
});

test('live rings drop points older than the requested window', async () => {
  const site = await freshSite('live-b');
  await archive.putLive(site, 'prod', {
    pv1: [{ t: T0, y: 10 }, { t: T0 + 900, y: 20 }],
    old: [{ t: T0, y: 30 }]
  });
  const win = await archive.getLive(site, 'prod', T0 + 500);
  assert.deepStrictEqual(win, { pv1: [{ t: T0 + 900, y: 20 }] },
    'an id with nothing left in the window is omitted entirely');
});

test('putLive rewrites a ring in full and clearSite drops it', async () => {
  const site = await freshSite('live-c');
  await archive.putLive(site, 'prod', { pv1: [{ t: T0, y: 1 }, { t: T0 + 10, y: 2 }] });
  await archive.putLive(site, 'prod', { pv1: [{ t: T0 + 20, y: 3 }] });
  assert.deepStrictEqual(await archive.getLive(site, 'prod', 0),
    { pv1: [{ t: T0 + 20, y: 3 }] });
  await archive.clearSite(site);
  assert.deepStrictEqual(await archive.getLive(site, 'prod', 0), {});
});
