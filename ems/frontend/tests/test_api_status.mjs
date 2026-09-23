/* Tests for the connection-status accounting in src/api.js.

   Regression guard for the spurious «Verbindung zum gPlug verloren» toast:
   the old get() flipped offline on ANY rejected fetch, so a 404 from an
   optional /api/vzev/* route (polled every 10s by the Übersicht) or a single
   aborted request under load raised the toast on a perfectly healthy device. */
import test from 'node:test';
import assert from 'node:assert';

globalThis.window = { location: { search: '' } };

/* fetch stub: each test installs its own responder */
let responder = async () => new Response('{}', { status: 200 });
globalThis.fetch = (url, opts) => responder(url, opts);

const { api } = await import('../src/api.js');

function ok(body) { return new Response(JSON.stringify(body ?? {}), { status: 200 }); }
function status(code) { return new Response('nope', { status: code }); }
function transportFail() { return Promise.reject(new TypeError('Failed to fetch')); }

/* run fn while collecting every onStatus notification */
async function withStatus(fn) {
  const events = [];
  const stop = api.onStatus((online) => events.push(online));
  try { await fn(events); } finally { stop(); }
  return events;
}

/* bring the module back to a known-online state with an empty fail streak */
async function reset() {
  responder = async () => ok({});
  await api.get('/reset');
}

test('an HTTP error is not a lost connection (device answered)', async () => {
  await reset();
  const events = await withStatus(async () => {
    responder = async () => status(404);
    for (let i = 0; i < 5; i++) {
      await assert.rejects(api.get('/api/vzev/members'));
    }
  });
  assert.deepStrictEqual(events, []);
  assert.strictEqual(api.isOnline(), true);
});

test('a single transport failure does not toast; three do', async () => {
  await reset();
  const events = await withStatus(async (seen) => {
    responder = transportFail;
    await assert.rejects(api.get('/loads'));
    await assert.rejects(api.get('/loads'));
    assert.deepStrictEqual(seen, [], 'two failures must stay silent');
    await assert.rejects(api.get('/loads'));
  });
  assert.deepStrictEqual(events, [false]);
  assert.strictEqual(api.isOnline(), false);
});

test('one success clears the streak and restores online', async () => {
  await reset();                       /* previous test left us offline */
  assert.strictEqual(api.isOnline(), true);
  const events = await withStatus(async () => {
    responder = transportFail;
    await assert.rejects(api.get('/loads'));
    await assert.rejects(api.get('/loads'));
    responder = async () => ok({});
    await api.get('/loads');
    responder = transportFail;
    await assert.rejects(api.get('/loads'));
    await assert.rejects(api.get('/loads'));
  });
  assert.deepStrictEqual(events, [], 'streak reset by the success in between');
  assert.strictEqual(api.isOnline(), true);
});

test('optional reads never drive the connection status', async () => {
  await reset();
  const events = await withStatus(async () => {
    responder = transportFail;
    for (let i = 0; i < 10; i++) {
      await assert.rejects(api.getVzevRaw());
      await assert.rejects(api.getVzevMembersList());
    }
    await api.getVzevInfo();           /* swallows its own error -> {} */
  });
  assert.deepStrictEqual(events, []);
  assert.strictEqual(api.isOnline(), true);
});

test('requests are capped at 2 in flight (single-threaded device)', async () => {
  await reset();
  let inflight = 0, peak = 0;
  const release = [];
  responder = () => {
    inflight++;
    peak = Math.max(peak, inflight);
    return new Promise((resolve) => {
      release.push(() => { inflight--; resolve(ok({})); });
    });
  };
  const all = Promise.all([
    api.get('/api/power'), api.get('/loads'), api.get('/productions'),
    api.get('/api/vzev/members', { optional: true }), api.getVzevRaw()
  ].map((p) => p.catch(() => null)));

  /* drain: each release lets the queue dispatch the next one */
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setTimeout(r, 0));
    while (release.length) { release.shift()(); }
  }
  await all;
  assert.strictEqual(peak, 2);
  await reset();
});
