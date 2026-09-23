/* «Zähler» — full smart-meter detail (spec 007), persona A (Technik-affin).
   Polls GET /api/meter every 10 s (pauses when hidden) and renders whatever the
   meter delivers: signed total power, a per-phase table, the authoritative
   registers, session Min/Max, and a raw-register view. ALL interpretation
   (labels, units, grouping, derived values) is done here from lib/metercat.js —
   the device serves the descriptor verbatim (001/C-3). The page degrades
   gracefully: sections/rows appear only when their fields are present. */
import { html, useState, useEffect, useRef } from '../core.js';
import { t } from '../i18n.js';
import { fmt } from '../format.js';
import { api } from '../api.js';
import * as ui from '../ui.js';
import {
  lookup, schieflast, cosphi, isStale, voltageStat, peakStat, foldPair, powerScale,
} from '../lib/metercat.js';

  var POLL_MS = 10000;
  var WINDOW = 90; /* RAM window cap (FR-707): 90 samples, no device storage */

  /* coerce a raw descriptor value to a number, or null (strings like serials
     stay null and are never number-formatted — edge case). */
  function asNum(v) {
    if (typeof v === 'number' && !isNaN(v)) return v;
    if (typeof v === 'string' && v.trim() !== '' && !isNaN(Number(v))) return Number(v);
    return null;
  }

  /* annotate every delivered field with its catalog descriptor (or null). */
  function resolve(values) {
    return Object.keys(values || {}).map(function (k) {
      return { name: k, raw: values[k], desc: lookup(k) };
    });
  }
  function pick(resolved, pred) {
    for (var i = 0; i < resolved.length; i++) {
      if (resolved[i].desc && pred(resolved[i].desc)) return resolved[i];
    }
    return null;
  }
  function pickNum(resolved, pred) {
    var r = pick(resolved, pred);
    return r ? asNum(r.raw) : null;
  }
  function byKey(k) { return function (d) { return d.i18nKey === k; }; }
  function phaseRole(role, phase) {
    return function (d) {
      return d.group === 'phases' && d.role === role && d.phase === phase && !d.dir;
    };
  }
  function phaseDir(role, phase, dir) {
    return function (d) {
      return d.group === 'phases' && d.role === role && d.phase === phase && d.dir === dir;
    };
  }

  /* One phase reading, whether the meter sends it signed (P1) or as an
     import/export pair (P1i/P1o). Import positive, export negative. */
  function phaseValue(r, role, p) {
    var plain = pickNum(r, phaseRole(role, p));
    if (plain !== null) return plain;
    return foldPair(pickNum(r, phaseDir(role, p, 'in')),
                    pickNum(r, phaseDir(role, p, 'out')));
  }
  function phaseSumOf(r, role) {
    var sum = null;
    [1, 2, 3].forEach(function (p) {
      var v = phaseValue(r, role, p);
      if (v !== null) sum = (sum || 0) + v;
    });
    return sum;
  }

  /* Signed total power in WATTS, plus how it was obtained.
     { net, derived, scale } — scale is 1000 when the meter delivers its power
     totals in kW (detected against the per-phase sum, see powerScale), so the
     raw view can label those fields with the unit actually delivered. */
  function readPower(r) {
    var phaseSum = phaseSumOf(r, 'power');
    var net = pickNum(r, byKey('meter.f.power_net'));
    var derived = false;
    if (net === null) {
      var pi = pickNum(r, byKey('meter.f.power_import'));
      var po = pickNum(r, byKey('meter.f.power_export'));
      net = foldPair(pi, po);
      if (net !== null) derived = true;
    }
    var scale = powerScale(net, phaseSum);
    if (net !== null) return { net: net * scale, derived: derived, scale: scale };
    /* last resort: sum of per-phase active power (already W) */
    if (phaseSum !== null) return { net: phaseSum, derived: true, scale: 1 };
    return { net: null, derived: false, scale: 1 };
  }

  /* ---- derived-value wrapper: dashed underline + formula tooltip (FR-706) ---- */
  function Derived(props) {
    return html`
      <span class="meter-derived-wrap">
        <span class="meter-derived">${props.children}</span>
        <${ui.Tooltip} text=${props.tip} />
      </span>`;
  }
  function derivedBadge() {
    return html`<span class="meter-tag meter-tag-derived">${t('meter.derived')}</span>`;
  }
  function registerBadge() {
    return html`
      <span class="meter-tag meter-tag-register">${t('meter.register')}
        <${ui.Tooltip} text=${t('meter.tip.register')} /></span>`;
  }

  /* signed-power colour: import (+) red, export (−) green (002 palette). */
  function powerColor(v) {
    if (v === null || v === undefined) return '';
    if (v > 0) return 'var(--c-import)';
    if (v < 0) return 'var(--c-export)';
    return '';
  }

  /* ================= ① Leistung — big signed total ================= */
  function PowerSection(props) {
    var r = props.resolved;
    var p = readPower(r);
    var net = p.net, derived = p.derived;
    if (net === null) return null;

    var importing = net > 0;
    var label = importing ? t('meter.importing') : t('meter.exporting');
    return html`
      <${ui.Card} group="grid" title=${t('meter.section.power')}
        tooltip=${t('meter.tip.net')}
        badge=${derived ? derivedBadge() : null}>
        <div class="meter-big">
          <span class="meter-big-value" style=${'color:' + powerColor(net)}>
            ${fmt.w(Math.abs(net))}
          </span>
          <span class="meter-big-label">${label}</span>
        </div>
      <//>`;
  }

  /* ================= ② Phasen table ================= */
  var PHASE_METRICS = [
    { role: 'voltage', unit: 'V', prec: 1, key: 'meter.voltage', tip: null, signed: false },
    { role: 'current', unit: 'A', prec: 2, key: 'meter.current', tip: null, signed: false },
    { role: 'power', unit: 'W', prec: 0, key: 'meter.active_power', tip: null, signed: true },
    { role: 'reactive', unit: 'var', prec: 0, key: 'meter.reactive', tip: 'meter.tip.reactive', signed: true },
    { role: 'pf', unit: '', prec: 2, key: 'meter.power_factor', tip: 'meter.tip.cosphi', signed: false },
  ];

  function PhaseSection(props) {
    var r = props.resolved;
    var phases = [1, 2, 3];

    /* which metric rows have at least one phase present? */
    var rows = PHASE_METRICS.map(function (m) {
      var cells = phases.map(function (p) { return phaseValue(r, m.role, p); });
      var any = cells.some(function (v) { return v !== null; });
      return { m: m, cells: cells, any: any };
    }).filter(function (row) { return row.any; });

    if (rows.length === 0) return null;

    /* Schieflast (derived): max−min of per-phase active power, if power present */
    var powerRow = rows.filter(function (row) { return row.m.role === 'power'; })[0];
    var imbalance = powerRow ? schieflast(powerRow.cells) : null;

    /* cosφ per phase (derived), only where both P and Q are present — skipped
       when the meter reports its own power factor (pf1..pf3). */
    var cosRow = null;
    var pfRow = rows.filter(function (row) { return row.m.role === 'pf'; })[0];
    if (powerRow && !pfRow) {
      var qRow = rows.filter(function (row) { return row.m.role === 'reactive'; })[0];
      if (qRow) {
        var cells = phases.map(function (p, i) { return cosphi(powerRow.cells[i], qRow.cells[i]); });
        if (cells.some(function (v) { return v !== null; })) cosRow = cells;
      }
    }

    return html`
      <${ui.Card} title=${t('meter.section.phases')} tooltip=${t('meter.tip.phases')}
        collapsible collapseKey="zaehler.phases">
        <div class="meter-table-wrap">
          <table class="meter-table">
            <thead>
              <tr>
                <th class="meter-th-metric"></th>
                <th>${t('meter.phase', { n: 1 })}</th>
                <th>${t('meter.phase', { n: 2 })}</th>
                <th>${t('meter.phase', { n: 3 })}</th>
              </tr>
            </thead>
            <tbody>
              ${rows.map(function (row) {
                return html`
                  <tr>
                    <th scope="row" class="meter-th-metric">
                      ${t(row.m.key)}
                      ${row.m.unit ? html`<span class="meter-unit">[${row.m.unit}]</span>` : null}
                      ${row.m.tip ? html`<${ui.Tooltip} text=${t(row.m.tip)} />` : null}
                    </th>
                    ${row.cells.map(function (v) {
                      var color = row.m.signed ? powerColor(v) : '';
                      return html`<td style=${color ? 'color:' + color : ''}>
                        ${v === null ? '–' : fmt.num(v, row.m.prec)}</td>`;
                    })}
                  </tr>`;
              })}
              ${cosRow ? html`
                <tr class="meter-row-derived">
                  <th scope="row" class="meter-th-metric">
                    <${Derived} tip=${t('meter.tip.cosphi')}>cos φ<//>
                  </th>
                  ${cosRow.map(function (v) {
                    return html`<td>${v === null ? '–' : fmt.num(v, 2)}</td>`;
                  })}
                </tr>` : null}
            </tbody>
          </table>
        </div>
        ${imbalance !== null ? html`
          <div class="meter-imbalance">
            <${Derived} tip=${t('meter.tip.imbalance')}>${t('meter.imbalance')}<//>
            <span class="meter-imbalance-val">${fmt.w(imbalance)}</span>
          </div>` : null}
      <//>`;
  }

  /* ================= ③ Zählerstände (registers) ================= */
  function RegisterSection(props) {
    var r = props.resolved;
    /* every register-kind field, in catalog order of appearance */
    var regs = r.filter(function (x) { return x.desc && x.desc.kind === 'register'; });
    var tariff = pick(r, function (d) { return d.group === 'tariff'; });

    if (regs.length === 0 && !tariff) return null;

    var tariffNum = tariff ? asNum(tariff.raw) : null;
    return html`
      <${ui.Card} group="production" title=${t('meter.section.registers')}
        tooltip=${t('meter.tip.registers')} collapsible collapseKey="zaehler.registers"
        badge=${tariff && (tariffNum === 1 || tariffNum === 2) ? html`
          <span class=${'meter-tariff meter-tariff-' + (tariffNum === 2 ? 'nt' : 'ht')}
            title=${t('meter.tip.tariff') + ' (' + tariff.name + '=' + tariff.raw + ')'}>
            ${tariffNum === 2 ? t('tariff.nt') : t('tariff.ht')}
          </span>` : null}>
        ${regs.length ? html`
          <dl class="meter-reg-list">
            ${regs.map(function (x) {
              var v = asNum(x.raw);
              return html`
                <div class="meter-reg">
                  <dt>${t(x.desc.i18nKey)} <span class="meter-unit">[${x.desc.unit}]</span> ${registerBadge()}</dt>
                  <dd>${v === null ? String(x.raw) : fmt.num(v, x.desc.precision === undefined ? 3 : x.desc.precision)}</dd>
                </div>`;
            })}
          </dl>` : null}
      <//>`;
  }

  /* ================= ④ Min/Max (Sitzung) ================= */
  function MinMaxSection(props) {
    var s = props.stats;
    if (!s) return null;
    var hasV = s.u[1] || s.u[2] || s.u[3];
    if (!hasV && !s.peakImp && !s.peakExp) return null;

    function vcell(st) { return st ? (fmt.num(st.min, 1) + ' / ' + fmt.num(st.max, 1)) : '–'; }
    return html`
      <${ui.Card} title=${t('meter.section.minmax')} subtitle=${t('meter.since_open')}
        tooltip=${t('meter.tip.minmax')} collapsible collapseKey="zaehler.minmax">
        <dl class="meter-reg-list">
          ${[1, 2, 3].map(function (p) {
            return s.u[p] ? html`
              <div class="meter-reg">
                <dt>${t('meter.voltage')} ${t('meter.phase', { n: p })} <span class="meter-unit">[V]</span></dt>
                <dd>${vcell(s.u[p])}</dd>
              </div>` : null;
          })}
          ${s.peakImp ? html`
            <div class="meter-reg">
              <dt>${t('meter.peak_import')} <span class="meter-unit">[W]</span></dt>
              <dd style=${'color:var(--c-import)'}>${fmt.w(s.peakImp)}</dd>
            </div>` : null}
          ${s.peakExp ? html`
            <div class="meter-reg">
              <dt>${t('meter.peak_export')} <span class="meter-unit">[W]</span></dt>
              <dd style=${'color:var(--c-export)'}>${fmt.w(s.peakExp)}</dd>
            </div>` : null}
        </dl>
      <//>`;
  }

  /* ================= ⑤ Rohdaten (raw register view) ================= */
  function RawSection(props) {
    var r = props.resolved;
    /* the totals may arrive in kW (see readPower/powerScale) — show the unit
       the meter actually delivered, not the catalog's nominal W. */
    var scale = readPower(r).scale;
    function unitOf(d) {
      if (scale === 1000 && d.group === 'power' && d.unit === 'W') return 'kW';
      return d.unit;
    }

    var known = r.filter(function (x) { return x.desc; });
    var unknown = r.filter(function (x) { return !x.desc; });

    function rawRow(x) {
      var isKnown = !!x.desc;
      /* show the value exactly as delivered (UC-703): numbers/strings verbatim,
         nested objects JSON-stringified so the row never crashes (NFR-703). */
      var display = (x.raw !== null && typeof x.raw === 'object')
        ? JSON.stringify(x.raw) : String(x.raw);
      return html`
        <tr>
          <td class="meter-raw-name">${x.name}</td>
          <td class="meter-raw-val">${display}</td>
          <td class="meter-raw-unit">${isKnown && x.desc.unit ? unitOf(x.desc) : ''}</td>
          <td class="meter-raw-label">${isKnown ? t(x.desc.i18nKey) : t('meter.unknown')}</td>
        </tr>`;
    }

    return html`
      <${ui.Card} title=${t('meter.section.raw')}
        collapsible collapseKey="zaehler.raw" defaultOpen=${false}>
        <div class="meter-table-wrap">
          <table class="meter-table meter-raw-table">
            <thead>
              <tr>
                <th>${t('meter.raw.field')}</th>
                <th>${t('meter.raw.value')}</th>
                <th>${t('meter.raw.unit')}</th>
                <th>${t('meter.raw.meaning')}</th>
              </tr>
            </thead>
            <tbody>
              ${known.map(rawRow)}
              ${unknown.length ? html`
                <tr class="meter-raw-sep"><td colspan="4">${t('meter.raw.other')}</td></tr>
                ${unknown.map(rawRow)}` : null}
            </tbody>
          </table>
        </div>
      <//>`;
  }

  /* ================= page ================= */
  function Zaehler() {
    var snapSt = useState(undefined);          /* undefined=loading, null=empty */
    var snap = snapSt[0], setSnap = snapSt[1];
    var statsSt = useState(null);
    var stats = statsSt[0], setStats = statsSt[1];
    var staleSt = useState(false);
    var stale = staleSt[0], setStale = staleSt[1];
    var updatedSt = useState(null);
    var updated = updatedSt[0], setUpdated = updatedSt[1];

    var windowRef = useRef([]);                /* staleness sample window (RAM) */
    var statsRef = useRef({ u: {}, peakImp: 0, peakExp: 0 });

    useEffect(function () {
      return api.poll(function () {
        api.getMeter().then(function (res) {
          setSnap(res && res.values ? res.values : null);
          setUpdated(res && typeof res.now === 'number' ? res.now : Math.floor(Date.now() / 1000));
          if (!res || !res.values) return;

          var r = resolve(res.values);
          /* fold Min/Max (session RAM only) */
          var st = statsRef.current;
          [1, 2, 3].forEach(function (p) {
            var v = pickNum(r, phaseRole('voltage', p));
            if (v !== null) st.u[p] = voltageStat(st.u[p], v);
          });
          var pw = readPower(r);
          var net = pw.net;                    /* signed, always W */
          var imp = pickNum(r, byKey('meter.f.power_import'));
          var exp = pickNum(r, byKey('meter.f.power_export'));
          if (imp !== null) imp = imp * pw.scale;
          if (exp !== null) exp = exp * pw.scale;
          if (imp === null && net !== null) imp = net > 0 ? net : 0;
          if (exp === null && net !== null) exp = net < 0 ? -net : 0;
          if (imp !== null) st.peakImp = peakStat(st.peakImp, imp);
          if (exp !== null) st.peakExp = peakStat(st.peakExp, exp);
          setStats({ u: Object.assign({}, st.u), peakImp: st.peakImp, peakExp: st.peakExp });

          /* staleness window: import register frozen while importing? */
          var reg = pickNum(r, byKey('meter.f.energy_import'));
          var importing = (net !== null ? net > 0 : (imp !== null && imp > 0));
          var w = windowRef.current;
          w.push({ reg: reg, importing: importing });
          while (w.length > WINDOW) w.shift();
          setStale(isStale(w));
        }).catch(function () { /* offline handled globally by api.onStatus */ });
      }, POLL_MS);
    }, []);

    var resolved = snap ? resolve(snap) : [];
    var age = updated ? Math.max(0, Math.floor(Date.now() / 1000) - updated) : null;

    return html`
      <div>
        <${ui.PageHeader} title=${t('page.meter')} subtitle=${t('meter.subtitle')}
          actions=${updated ? html`
            <span class="meter-updated">
              ${t('meter.updated', { time: fmt.time(updated, 'hm') })}
              ${age !== null ? html`<span class="meter-age"> · ${t('meter.age', { s: age })}</span>` : null}
            </span>` : null} />

        ${stale ? html`<div class="banner banner-warn">${t('meter.stale')}</div>` : null}

        ${snap === undefined ? html`<${ui.Card}><p class="placeholder-text">${t('common.loading')}</p><//>` : null}
        ${snap === null ? html`<${ui.Card}><p class="placeholder-text">${t('meter.empty')}</p><//>` : null}
        ${snap ? html`
          <${PowerSection} resolved=${resolved} />
          <${PhaseSection} resolved=${resolved} />
          <${RegisterSection} resolved=${resolved} />
          <${MinMaxSection} stats=${stats} />
          <${RawSection} resolved=${resolved} />` : null}
      </div>`;
  }

export { Zaehler };
