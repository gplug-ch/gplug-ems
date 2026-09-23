/* Tests for the vZEV request gate in src/api.js.

   A site without an energy community switches vZEV off in Einstellungen. The
   Übersicht panel, the archive sync and Abrechnung must then stop hitting
   /api/vzev/* entirely — on a single-threaded ESP32 web server those polls are
   pure noise. /api/vzev/info stays reachable: it carries the toggle. */
import test from 'node:test';
import assert from 'node:assert';

globalThis.window = { location: { search: '' } };

let calls = [];
let responder = async () => new Response('{}', { status: 200 });
globalThis.fetch = (url, opts) => { calls.push(String(url)); return responder(url, opts); };

const { api } = await import('../src/api.js');

function ok(body) { return new Response(JSON.stringify(body ?? {}), { status: 200 }); }

/* route the stub per path so /api/vzev/info can answer with a given toggle */
function serve(info) {
  responder = async (url) => {
    if (String(url).indexOf('/api/vzev/info') >= 0) return ok(info);
    return ok({});
  };
}

async function setEnabled(enabled) {
  serve({ enabled: enabled });
  await api.setVzevInfo({ enabled: enabled });   /* seeds the cached toggle */
  calls = [];
}

function vzevCalls() {
  return calls.filter((u) => u.indexOf('/api/vzev/') >= 0 && u.indexOf('/api/vzev/info') < 0);
}

test('disabled: no /api/vzev/* request leaves the browser', async () => {
  await setEnabled(false);

  const raw = await api.getVzevRaw();
  const members = await api.getVzevMembersList();
  const discovered = await api.getVzevDiscovered();
  const flows = await api.getVzevFlows('15m', 90);
  const panel = await api.getVzevMembers();
  const direct = await api.get('/api/vzev/members?action=remove&id=x');

  assert.deepStrictEqual(vzevCalls(), [], 'gate must block every vZEV path');
  /* neutral shapes so callers render empty instead of throwing */
  assert.strictEqual(raw, null);
  assert.deepStrictEqual(members, []);
  assert.deepStrictEqual(discovered, []);
  assert.deepStrictEqual(flows, { flows: [] });
  assert.deepStrictEqual(panel, []);
  assert.deepStrictEqual(direct, { members: [] });
});

test('disabled: the toggle itself stays readable and writable', async () => {
  await setEnabled(false);
  const info = await api.getVzevInfo();
  assert.strictEqual(info.enabled, false);
  assert.ok(calls.some((u) => u.indexOf('/api/vzev/info') >= 0));
});

test('enabled: the reads go through again', async () => {
  await setEnabled(true);
  await api.getVzevRaw();
  await api.getVzevMembersList();
  assert.deepStrictEqual(
    vzevCalls().map((u) => u.replace(/^.*\/api/, '/api')),
    ['/api/vzev/raw', '/api/vzev/members']
  );
});

test('flipping the toggle off closes the gate without a reload', async () => {
  await setEnabled(true);
  await api.getVzevRaw();
  assert.strictEqual(vzevCalls().length, 1);

  serve({ enabled: false });
  await api.setVzevInfo({ enabled: false });
  calls = [];
  await api.getVzevRaw();
  assert.deepStrictEqual(vzevCalls(), []);
});

test('disabled: the Einstellungen tab may still read the registry (vzevBypass)', async () => {
  await setEnabled(false);
  const d = await api.get('/api/vzev/members', { optional: true, vzevBypass: true });
  assert.deepStrictEqual(d, {});
  assert.deepStrictEqual(
    vzevCalls().map((u) => u.replace(/^.*\/api/, '/api')),
    ['/api/vzev/members']
  );
});
