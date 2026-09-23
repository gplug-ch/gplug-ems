/* Smart-meter field catalog + pure derivations for the «Zähler» page (spec 007).
   Device-serves-raw (001/C-3): the gPlug streams the descriptor verbatim; ALL
   interpretation lives here. Pure data + functions only — no Preact, so this is
   unit-testable under node:test (see tests/test_metercat.mjs).

   A FieldDescriptor is { group, i18nKey, unit, kind, precision?, phase?, role?, dir? }:
     group ∈ { power, phases, energy, reactive, tariff, meta }
     kind  ∈ { register (authoritative billing value), live (instantaneous), meta }
     phase ∈ { 1,2,3 } and role ∈ { voltage,current,power,reactive,pf } for the phase table
     dir   ∈ { in, out } — one half of an import/export pair (Pi/Po, P1i/P1o …)
             that the page folds into a single signed value (import positive)
   Unknown field → lookup() returns null and the caller renders it raw. */

/* Normalise a descriptor field name so lookups tolerate the real-world naming
   spread: `U_L1`, `volt_l1`, `32_7_0`, `32.7.0`, `Voltage L1` all collapse to a
   comparable token. Case-insensitive, punctuation-insensitive. */
export function normalizeName(name) {
  return String(name == null ? '' : name).toLowerCase().replace(/[^a-z0-9]/g, '');
}

/* Catalog rows. `keys` are pre-normalised aliases (must already be lowercase
   alphanumeric). Order here drives render order within a group. */
const ROWS = [
  /* ── instantaneous power (OBIS 1.7.0 / 2.7.0 / 16.7.0) ──
     Delivered either as one signed total (`P`) or as an import/export pair
     (`Pi`/`Po`) — `dir` marks the halves of such a pair so the page can fold
     them into a signed value. The unit is nominally W but some meters send the
     totals in kW while the per-phase values stay in W; powerScale() below
     detects that from the two, so never trust this unit for the totals. */
  { keys: ['pi', 'pin', 'powerin', '170'], group: 'power', dir: 'in', i18nKey: 'meter.f.power_import', unit: 'W', kind: 'live', precision: 0 },
  { keys: ['po', 'pout', 'powerout', '270'], group: 'power', dir: 'out', i18nKey: 'meter.f.power_export', unit: 'W', kind: 'live', precision: 0 },
  { keys: ['p', 'power', 'psum', '1670'], group: 'power', i18nKey: 'meter.f.power_net', unit: 'W', kind: 'live', precision: 0 },

  /* ── instantaneous reactive power totals (3.7.0 / 4.7.0) ── */
  { keys: ['rpi', 'qi', 'reactivepowerin', '370'], group: 'power', dir: 'in', i18nKey: 'meter.f.reactive_import', unit: 'var', kind: 'live', precision: 0 },
  { keys: ['rpo', 'qo', 'reactivepowerout', '470'], group: 'power', dir: 'out', i18nKey: 'meter.f.reactive_export', unit: 'var', kind: 'live', precision: 0 },

  /* ── per-phase voltage (32/52/72.7.0) ── */
  { keys: ['u1', 'ul1', 'v1', 'vl1', 'voltl1', 'voltagel1', 'spannungl1', '3270'], group: 'phases', role: 'voltage', phase: 1, i18nKey: 'meter.f.voltage', unit: 'V', kind: 'live', precision: 1 },
  { keys: ['u2', 'ul2', 'v2', 'vl2', 'voltl2', 'voltagel2', 'spannungl2', '5270'], group: 'phases', role: 'voltage', phase: 2, i18nKey: 'meter.f.voltage', unit: 'V', kind: 'live', precision: 1 },
  { keys: ['u3', 'ul3', 'v3', 'vl3', 'voltl3', 'voltagel3', 'spannungl3', '7270'], group: 'phases', role: 'voltage', phase: 3, i18nKey: 'meter.f.voltage', unit: 'V', kind: 'live', precision: 1 },

  /* ── per-phase current (31/51/71.7.0) ── */
  { keys: ['i1', 'il1', 'currl1', 'currentl1', 'stroml1', '3170'], group: 'phases', role: 'current', phase: 1, i18nKey: 'meter.f.current', unit: 'A', kind: 'live', precision: 2 },
  { keys: ['i2', 'il2', 'currl2', 'currentl2', 'stroml2', '5170'], group: 'phases', role: 'current', phase: 2, i18nKey: 'meter.f.current', unit: 'A', kind: 'live', precision: 2 },
  { keys: ['i3', 'il3', 'currl3', 'currentl3', 'stroml3', '7170'], group: 'phases', role: 'current', phase: 3, i18nKey: 'meter.f.current', unit: 'A', kind: 'live', precision: 2 },

  /* ── per-phase active power (21/41/61.7.0) ── */
  { keys: ['p1', 'pl1', 'powerl1', '2170'], group: 'phases', role: 'power', phase: 1, i18nKey: 'meter.f.power_phase', unit: 'W', kind: 'live', precision: 0 },
  { keys: ['p2', 'pl2', 'powerl2', '4170'], group: 'phases', role: 'power', phase: 2, i18nKey: 'meter.f.power_phase', unit: 'W', kind: 'live', precision: 0 },
  { keys: ['p3', 'pl3', 'powerl3', '6170'], group: 'phases', role: 'power', phase: 3, i18nKey: 'meter.f.power_phase', unit: 'W', kind: 'live', precision: 0 },

  /* ── per-phase active power as an import/export pair (P1i/P1o …) ──
     Same reading as P1..P3 above, split by direction; folded back into one
     signed value by the page. Always W on the meters seen so far. */
  { keys: ['p1i', 'p1in', 'pl1i'], group: 'phases', role: 'power', phase: 1, dir: 'in', i18nKey: 'meter.f.power_phase_in', unit: 'W', kind: 'live', precision: 0 },
  { keys: ['p1o', 'p1out', 'pl1o'], group: 'phases', role: 'power', phase: 1, dir: 'out', i18nKey: 'meter.f.power_phase_out', unit: 'W', kind: 'live', precision: 0 },
  { keys: ['p2i', 'p2in', 'pl2i'], group: 'phases', role: 'power', phase: 2, dir: 'in', i18nKey: 'meter.f.power_phase_in', unit: 'W', kind: 'live', precision: 0 },
  { keys: ['p2o', 'p2out', 'pl2o'], group: 'phases', role: 'power', phase: 2, dir: 'out', i18nKey: 'meter.f.power_phase_out', unit: 'W', kind: 'live', precision: 0 },
  { keys: ['p3i', 'p3in', 'pl3i'], group: 'phases', role: 'power', phase: 3, dir: 'in', i18nKey: 'meter.f.power_phase_in', unit: 'W', kind: 'live', precision: 0 },
  { keys: ['p3o', 'p3out', 'pl3o'], group: 'phases', role: 'power', phase: 3, dir: 'out', i18nKey: 'meter.f.power_phase_out', unit: 'W', kind: 'live', precision: 0 },

  /* ── per-phase power factor reported by the meter (no cosφ derivation needed) ── */
  { keys: ['pf1', 'cosphi1', 'powerfactorl1'], group: 'phases', role: 'pf', phase: 1, i18nKey: 'meter.f.power_factor', unit: '', kind: 'live', precision: 2 },
  { keys: ['pf2', 'cosphi2', 'powerfactorl2'], group: 'phases', role: 'pf', phase: 2, i18nKey: 'meter.f.power_factor', unit: '', kind: 'live', precision: 2 },
  { keys: ['pf3', 'cosphi3', 'powerfactorl3'], group: 'phases', role: 'pf', phase: 3, i18nKey: 'meter.f.power_factor', unit: '', kind: 'live', precision: 2 },

  /* ── per-phase reactive power (23/43/63.7.0) ── */
  { keys: ['q1', 'ql1', 'blindleistungl1', '2370'], group: 'phases', role: 'reactive', phase: 1, i18nKey: 'meter.f.reactive_phase', unit: 'var', kind: 'live', precision: 0 },
  { keys: ['q2', 'ql2', 'blindleistungl2', '4370'], group: 'phases', role: 'reactive', phase: 2, i18nKey: 'meter.f.reactive_phase', unit: 'var', kind: 'live', precision: 0 },
  { keys: ['q3', 'ql3', 'blindleistungl3', '6370'], group: 'phases', role: 'reactive', phase: 3, i18nKey: 'meter.f.reactive_phase', unit: 'var', kind: 'live', precision: 0 },

  /* ── energy registers (1.8.0 / 2.8.0) — authoritative billing values ── */
  { keys: ['ein', 'ei', 'eimport', 'energyimport', 'bezug', '180'], group: 'energy', i18nKey: 'meter.f.energy_import', unit: 'kWh', kind: 'register', precision: 3 },
  { keys: ['eout', 'eo', 'eexport', 'energyexport', 'einspeisung', '280'], group: 'energy', i18nKey: 'meter.f.energy_export', unit: 'kWh', kind: 'register', precision: 3 },

  /* ── reactive-energy registers (3.8.0 / 4.8.0) ── */
  { keys: ['erin', 'rei', 'reactiveimport', '380'], group: 'reactive', i18nKey: 'meter.f.reactive_energy_import', unit: 'kvarh', kind: 'register', precision: 3 },
  { keys: ['erout', 'reo', 'reactiveexport', '480'], group: 'reactive', i18nKey: 'meter.f.reactive_energy_export', unit: 'kvarh', kind: 'register', precision: 3 },

  /* ── active tariff (96.14.0) ── */
  { keys: ['tariff', 'tarif', 'activetariff', '96140'], group: 'tariff', i18nKey: 'meter.f.tariff', unit: '', kind: 'meta' },

  /* ── meta ── */
  { keys: ['meterid', 'smid', 'deviceid', 'serial', 'seriennummer', 'id'], group: 'meta', i18nKey: 'meter.f.meter_id', unit: '', kind: 'meta' },
];

/* alias → descriptor (built once). */
const INDEX = (function () {
  const m = {};
  ROWS.forEach(function (row) {
    const desc = { group: row.group, i18nKey: row.i18nKey, unit: row.unit, kind: row.kind };
    if (row.precision !== undefined) desc.precision = row.precision;
    if (row.phase !== undefined) desc.phase = row.phase;
    if (row.role !== undefined) desc.role = row.role;
    if (row.dir !== undefined) desc.dir = row.dir;
    row.keys.forEach(function (k) { if (m[k] === undefined) m[k] = desc; });
  });
  return m;
})();

/* lookup(name) → FieldDescriptor | null (case- and punctuation-insensitive). */
export function lookup(name) {
  const d = INDEX[normalizeName(name)];
  return d === undefined ? null : d;
}

/* ── derived values (all computed in the browser, marked as such in the UI) ── */

/* Schieflast = phase imbalance = max−min of the per-phase active power.
   Ignores null/undefined phases; needs ≥2 present phases, else null. */
export function schieflast(powers) {
  const vals = (powers || []).filter(function (v) { return typeof v === 'number' && !isNaN(v); });
  if (vals.length < 2) return null;
  return Math.max.apply(null, vals) - Math.min.apply(null, vals);
}

/* Fold an import/export pair into one signed value (import positive, export
   negative), the convention the whole UI uses for power. Either half may be
   missing (counts as 0); both missing → null. */
export function foldPair(inValue, outValue) {
  const i = (typeof inValue === 'number' && !isNaN(inValue)) ? inValue : null;
  const o = (typeof outValue === 'number' && !isNaN(outValue)) ? outValue : null;
  if (i === null && o === null) return null;
  return (i || 0) - (o || 0);
}

/* Unit cross-check for the *total* power fields. Real meters exist (Landis+Gyr
   via the gPlug SMI) that deliver Pi/Po in kW while the per-phase values stay
   in W — the catalog cannot tell the two apart by name, so compare them: when
   the per-phase sum is ~1000× the total, the total is kW.
   Returns the factor to multiply the total by (1 or 1000); 1 whenever there is
   nothing to compare against or either value is too small to judge. */
export function powerScale(total, phaseSum) {
  if (typeof total !== 'number' || isNaN(total) || !isFinite(total)) return 1;
  if (typeof phaseSum !== 'number' || isNaN(phaseSum) || !isFinite(phaseSum)) return 1;
  const a = Math.abs(total);
  const b = Math.abs(phaseSum);
  /* below ~5 W of phase sum the rounding of a kW total (3 decimals) swamps the
     ratio, so refuse to judge rather than guess wrong. */
  if (a < 1e-6 || b < 5) return 1;
  const ratio = b / a;
  return (ratio > 100 && ratio < 10000) ? 1000 : 1;
}

/* cosφ = |P| / √(P²+Q²). Needs both P and Q present; returns null otherwise or
   when apparent power is ~0. Clamped to [0,1]. */
export function cosphi(p, q) {
  if (typeof p !== 'number' || typeof q !== 'number' || isNaN(p) || isNaN(q)) return null;
  const s = Math.sqrt(p * p + q * q);
  if (s < 1e-9) return null;
  return Math.min(1, Math.abs(p) / s);
}

/* Normalise a value to Watts given its catalog unit (kW → W). Register values
   keep their own unit elsewhere; this is only for the derived total. */
export function kwToW(value, unit) {
  if (typeof value !== 'number' || isNaN(value)) return null;
  return unit === 'kW' ? value * 1000 : value;
}

/* Stale-counter heuristic (UC-704): the CII push is ≤ 10 s, so if the import
   energy register has not moved across ≥ `min` consecutive polls while power
   still shows import, the meter link is likely stuck.
   window: array of { reg:Number|null, importing:Boolean } newest-last. */
export function isStale(window, min) {
  const need = min || 6;
  if (!window || window.length < need) return false;
  const last = window.slice(-need);
  for (let i = 0; i < last.length; i++) {
    if (typeof last[i].reg !== 'number' || isNaN(last[i].reg)) return false;
  }
  if (!last[last.length - 1].importing) return false;
  const first = last[0].reg;
  return last.every(function (s) { return s.reg === first; });
}

/* Fold one voltage reading into a running {min,max}. Exact zeros are a common
   decode glitch (UC edge case) and are ignored so they don't poison the min. */
export function voltageStat(prev, v) {
  if (typeof v !== 'number' || isNaN(v) || v === 0) return prev || null;
  if (!prev) return { min: v, max: v };
  return { min: Math.min(prev.min, v), max: Math.max(prev.max, v) };
}

/* Fold a non-negative peak reading (import/export power) into a running max. */
export function peakStat(prev, v) {
  if (typeof v !== 'number' || isNaN(v)) return prev || 0;
  return Math.max(prev || 0, v);
}
