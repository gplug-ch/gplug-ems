/* i18n completeness test (spec 010 FR-1008, guards defect D-1).
   Walks every src/**.js file for statically-referenced translation keys —
   both `t('…')` call sites and static key tables (e.g. FLOW_NODES / NODE_META
   labels, TAB_LABEL, comp.* segment keys) — and fails when any referenced key
   is missing from de.json OR en.json. Node labels rendering as raw keys
   («flow.pv») was the shipped D-1 bug; this makes the guard automatic rather
   than review-only. Dynamic keys (`t('prefix.' + x)`) are out of scope — they
   cannot be resolved statically, same limitation as bundle.py's check. */
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const SRC = path.join(ROOT, 'src');

/* the same prefixes bundle.py scans (kept in sync), plus `comp` (spec 010). A
   real key ends alphanumeric/underscore; a trailing dot is a dynamic prefix. */
const PREFIXES = [
  'nav', 'state', 'common', 'error', 'banner', 'table', 'page', 'placeholder',
  'tooltip', 'panel', 'hint', 'billing', 'history', 'settings', 'vzev', 'demo',
  'stat', 'action', 'kpi', 'flow', 'explain', 'tariff', 'comp', 'modbus'
];
const KEY_RE = new RegExp(
  "['\"]((?:" + PREFIXES.join('|') + ")\\.[a-z0-9_.]*[a-z0-9_])['\"]", 'g'
);

function walk(dir) {
  let out = [];
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) out = out.concat(walk(p));
    else if (name.endsWith('.js')) out.push(p);
  }
  return out;
}

function referencedKeys() {
  const used = new Map();                       /* key -> first file it appears in */
  for (const file of walk(SRC)) {
    const text = fs.readFileSync(file, 'utf8');
    let m;
    while ((m = KEY_RE.exec(text)) !== null) {
      if (!used.has(m[1])) used.set(m[1], path.relative(ROOT, file));
    }
  }
  return used;
}

function loadLang(lang) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'i18n', lang + '.json'), 'utf8'));
}

test('i18n: every referenced key exists in de.json and en.json', () => {
  const used = referencedKeys();
  const de = loadLang('de');
  const en = loadLang('en');
  assert.ok(used.size > 0, 'expected to find referenced keys');

  const missing = [];
  for (const [key, file] of used) {
    if (!(key in de)) missing.push(`${key} (${file}) — missing in de.json`);
    if (!(key in en)) missing.push(`${key} (${file}) — missing in en.json`);
  }
  assert.deepStrictEqual(missing, [], 'missing i18n keys:\n' + missing.join('\n'));
});

test('i18n: the spec-010 keys are present in both languages', () => {
  const de = loadLang('de');
  const en = loadLang('en');
  const required = [
    'flow.status_export', 'flow.status_import', 'flow.status_covered',
    'flow.status_idle', 'flow.status_unknown', 'flow.vzev_mean_note',
    'flow.prod_nodata', 'flow.comp_now', 'flow.comp_today', 'flow.comp_cover',
    'flow.comp_usage', 'flow.comp_nodata', 'flow.comp_zero', 'flow.comp_batt_note',
    'comp.pv', 'comp.load', 'comp.battery', 'comp.charge', 'comp.vzev',
    'comp.grid', 'comp.feedin', 'settings.prodtype.unknown_warn'
  ];
  required.forEach(function (k) {
    assert.ok(k in de, k + ' missing in de.json');
    assert.ok(k in en, k + ' missing in en.json');
  });
});
