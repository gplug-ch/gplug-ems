/* Übersicht — live energy monitor (spec 003, FR-301..FR-310).
   Three group-accented panels (Netzanschluss, Erzeuger, Lasten), all
   charts sharing one 15-min time window with labeled axes. Live power in
   W/kW (never kWh). Polls /api/power + /loads + /productions every 10 s,
   /site once; pauses when the tab is hidden (via api.poll). */
import { html, useState, useEffect, useRef, Fragment } from '../core.js';
import { t } from '../i18n.js';
import { fmt } from '../format.js';
import { api } from '../api.js';
import { toast } from '../components.js';
import * as ui from '../ui.js';
import * as archive from '../lib/archive.js';
import * as insights from '../lib/insights.js';

  var WINDOW_S = 900;          /* 15 min */
  var MAX_SAMPLES = 90;        /* 15 min at 10 s */

  /* ---- normalise a state string coming from the device (UPPERCASE) ---- */
  function normState(s) {
    s = String(s || '').toLowerCase();
    if (s === 'active' || s === 'waiting' || s === 'inactive') return s;
    return 'inactive';
  }

  function loadName(l) { return l.friendlyName || l.name || l.id || '–'; }
  function prodName(p) { return p.friendlyName || p.name || p.id || '–'; }
  /* current power in W, or null when unknown (spec 010 D-3: «unbekannt» is not
     «0» — a null becomes a chart gap / «—», never a fabricated 0-line). */
  function ratedW(o) {
    var v = o.currentPower !== undefined ? o.currentPower : o.current_power;
    return typeof v === 'number' && !isNaN(v) ? v : null;
  }
  /* issue #15: a gplug item past its stale_after reports stale:true with
     currentPower 0 and lastUpdate = utc of its last fresh value. Returns the
     «last update» note or null; older than a day shows the date too. */
  function staleNote(p, nowSec) {
    if (!p || p.stale !== true) return null;
    var ts = typeof p.lastUpdate === 'number' ? p.lastUpdate : null;
    if (ts === null) return t('prod.stale_unknown');
    var res = (nowSec - ts) > 86400 ? '15m' : 'hm';
    return t('prod.stale', { time: fmt.time(ts, res) });
  }
  function isBatteryProd(p) { return String(p.productionType || '').toUpperCase() === 'BATTERY'; }
  /* number or null (missing/NaN → null) — the single guard against fake zeros */
  function num(v) { return (v === null || v === undefined || isNaN(v)) ? null : Number(v); }
  /* issue #20: a battery item's live state for the Übersicht — direction from
     the signed power (+ discharging), SoC % (0..100 or null), the stored
     energy in Wh when the item has a capacity. Idle below 1 W. */
  function batteryInfo(p) {
    var w = ratedW(p), soc = num(p.soc), cap = num(p.capacity);
    if (soc !== null && (soc < 0 || soc > 100)) soc = null;
    return {
      dir: w === null ? null : (w >= 1 ? 'discharge' : (w <= -1 ? 'charge' : 'idle')),
      soc: soc,
      capacity: cap !== null && cap > 0 ? cap : null,
      storedWh: soc !== null && cap !== null && cap > 0 ? cap * soc / 100 : null
    };
  }
  /* SoC over all battery items: capacity-weighted when every one has a
     capacity, else the plain mean; null when none reports a SoC */
  function batterySoc(prods) {
    var n = 0, plain = 0, wsum = 0, wcap = 0, weighted = true;
    (prods || []).forEach(function (p) {
      if (!isBatteryProd(p)) return;
      var b = batteryInfo(p);
      if (b.soc === null) return;
      if (b.capacity !== null) { wsum += b.soc * b.capacity; wcap += b.capacity; }
      else weighted = false;
      plain += b.soc; n++;
    });
    if (!n) return null;
    return weighted ? wsum / wcap : plain / n;
  }
  var BAT_DIR_LABEL = { charge: 'flow.bat_charge', discharge: 'flow.bat_discharge', idle: 'stat.bat_idle' };

  /* ---- helper: pull the [grid_w,pv_w,bat_w,load_w] arrays out of /api/power
     into per-metric point series {t,y}, clipped to the shared window ---- */
  function powerSeries(power, t0, t1) {
    var out = { grid: [], pv: [], bat: [], load: [] };
    if (!power || !power.samples) return out;
    power.samples.forEach(function (s) {
      var ts = s[0];
      if (ts < t0 || ts > t1) return;
      out.grid.push({ t: ts, y: s[1] });
      out.pv.push({ t: ts, y: s[2] });
      out.bat.push({ t: ts, y: s[3] });
      out.load.push({ t: ts, y: s[4] });
    });
    return out;
  }

  /* newest sample from /api/power as a named object (or null) */
  function newest(power) {
    if (!power || !power.samples || !power.samples.length) return null;
    var s = power.samples[power.samples.length - 1];
    return { ts: s[0], grid_w: s[1], pv_w: s[2], bat_w: s[3], load_w: s[4] };
  }

  /* ---- a mutable client-side history ring keyed by id (UC-302/303) ----
     records {t, y} per key each poll. Loads store their rated power while
     ACTIVE and 0 otherwise (UC-303); a poll that omits an id simply records
     no point, so a device pause becomes a chart gap, not an interpolation. */
  function pushHistory(map, key, ts, y, t0) {
    var arr = map[key] || (map[key] = []);
    arr.push({ t: ts, y: y });
    while (arr.length && arr[0].t < t0) arr.shift();
    while (arr.length > MAX_SAMPLES) arr.shift();
  }

  /* ---- merge archived points into a ring, oldest first, without duplicates.
     Restored points are always older than anything the live poll has recorded
     in this page load, so a plain prepend + de-dup by timestamp is enough. */
  function mergeHistory(map, stored) {
    Object.keys(stored || {}).forEach(function (id) {
      var arr = map[id] || (map[id] = []);
      var seen = {};
      arr.forEach(function (p) { seen[p.t] = true; });
      var add = stored[id].filter(function (p) { return !seen[p.t]; });
      if (!add.length) return;
      map[id] = add.concat(arr).sort(function (a, b) { return a.t - b.t; });
      while (map[id].length > MAX_SAMPLES) map[id].shift();
    });
  }

  /* ---- derive the true "Verbrauch" and "Erzeugung" lines from /api/power ----
     Total site consumption is NOT the sum of the EMS-controllable loads (that
     is only what the device can switch, and is 0 whenever nothing is active).
     It is the whole-site draw, recovered from the meter's energy balance:

       consumption = pv_w + bat_w + grid_w   (grid_w>0 import, bat_w>0 discharge)
       production  = pv_w + bat_w             (local supply to the bus)

     so consumption − production = grid_w: the gap between the two lines is
     exactly the grid flow (import where consumption>production, export where
     production>consumption). A null pv/bat counts as 0 for the sum (absent
     hardware); a null grid_w means the meter is unknown — the sample is
     skipped so it becomes a chart gap, not a fake zero (spec 010 D-3). */
  function gridSeries(power, t0, t1) {
    var ser = powerSeries(power, t0, t1);
    var cons = [], prod = [];
    for (var i = 0; i < ser.grid.length; i++) {
      var ts = ser.grid[i].t;
      var g = num(ser.grid[i].y);
      var pv = num(ser.pv[i].y) || 0;
      var b = num(ser.bat[i].y) || 0;
      if (g === null) continue;
      prod.push({ t: ts, y: pv + b });
      cons.push({ t: ts, y: pv + b + g });
    }
    return { cons: cons, prod: prod };
  }

  /* ================= Stat row ================= */
  /* dir 'out' = leaves the site (→ Export), 'in' = enters it (← Bezug): the
     arrow carries the direction, the colour only reinforces it */
  function Stat(props) {
    return html`
      <div class="ov-stat">
        <span class="ov-stat-dot" style=${'background:' + props.color}></span>
        ${props.dir ? html`<span class="ov-stat-dir" aria-hidden="true"
          style=${'color:' + props.color}>${props.dir === 'out' ? '→' : '←'}</span>` : null}
        <span class="ov-stat-label">${props.label}</span>
        ${props.tooltip ? html`<${ui.Tooltip} text=${props.tooltip} />` : null}
        <span class="ov-stat-value" style=${'color:' + props.color}>${props.value}</span>
      </div>`;
  }

  /* ================= Netzanschluss panel (FR-305/306) ================= */
  function GridPanel(props) {
    var s = props.newest;                 /* newest /api/power sample or null */
    var win = props.win;
    var power = props.power;                /* raw /api/power {now, samples} or null */

    /* All four figures come from the meter's energy balance (see gridSeries),
       never from the EMS-controllable load list — otherwise Verbrauch reads 0
       whenever no switchable load is active while the site still draws power. */
    /* «unbekannt» is not «0» (spec 010 D-3): a missing grid_w means the grid
       meter did not deliver — every figure that depends on it shows "–", not
       a fake zero. pv/bat stay null→0: they are legitimately absent on sites
       without PV or battery, where the balance is still well-defined. */
    var grid = s ? num(s.grid_w) : null;         /* signed: >0 import, <0 export */
    var pv   = s ? (num(s.pv_w) || 0)   : null;
    var bat  = s ? (num(s.bat_w) || 0)  : null;   /* signed: >0 discharge */
    /* consumption = whole-site draw = pv + battery(discharge±) + grid(import±) */
    var consumption = s && grid !== null ? (pv + bat + grid) : null;
    /* production = local supply to the bus = pv + battery discharge/charge */
    var production = s ? (pv + bat) : null;
    /* export / import straight off the grid meter sign; never negative */
    var exportW      = s && grid !== null ? Math.max(0, -grid) : null;
    var gridOpImport = s && grid !== null ? Math.max(0, grid) : null;

    /* combined chart: consumption (blue, whole-site) + production (yellow,
       pv+battery); the area between them is the grid flow — filled green where
       production exceeds consumption (export) and red where consumption
       exceeds production (grid import). */
    var gs = gridSeries(power, win[0], win[1]);
    var consPts = gs.cons;
    var prodPts = gs.prod;

    return html`
      <${ui.Card} group="grid" title=${t('panel.grid')}
        collapsible collapseKey="uebersicht.grid"
        defaultOpen=${false}>
        <div class="ov-stats">
          <${Stat} color="var(--c-consumption)" label=${t('stat.consumption')}
            tooltip=${t('tooltip.consumption')} value=${fmt.w(consumption)} />
          <${Stat} color="var(--c-production)" label=${t('stat.production')}
            value=${fmt.w(production)} />
          <${Stat} color="var(--c-export)" dir="out" label=${t('stat.export')}
            value=${fmt.w(exportW)} />
          <${Stat} color="var(--c-import)" dir="in" label=${t('stat.gridop')}
            tooltip=${t('tooltip.gridop')} value=${fmt.w(gridOpImport)} />
        </div>
        <${ui.LineChart} height=${210} yUnit="W" xUnit="h" timeWindow=${win}
          yFormat=${fmt.w}
          bands=${[
            { top: prodPts, bottom: consPts, color: 'var(--c-export-fill)' },
            { top: consPts, bottom: prodPts, color: 'var(--c-import-fill)' }
          ]}
          series=${[
            { points: consPts, color: 'var(--c-consumption)', label: t('stat.consumption') },
            { points: prodPts, color: 'var(--c-production)', label: t('stat.production') }
          ]} />
      <//>`;
  }

  /* battery state line + SoC bar under a battery item (issue #20) */
  function BatteryMeta(props) {
    var b = props.info;
    return html`
      <div class="ov-sub-meta">
        <span>${b.dir ? t(BAT_DIR_LABEL[b.dir]) : '–'}</span>
        ${b.soc !== null ? html`<span>${t('stat.soc', { pct: Math.round(b.soc) })}${b.storedWh !== null
          ? ' · ' + t('stat.soc_energy', { energy: fmt.wh(b.storedWh), capacity: fmt.wh(b.capacity) }) : ''}</span>` : null}
      </div>
      ${b.soc !== null ? html`
        <div class="bat-soc" role="meter" aria-valuemin="0" aria-valuemax="100"
          aria-valuenow=${Math.round(b.soc)} aria-label=${t('stat.soc', { pct: Math.round(b.soc) })}>
          <div class="bat-soc-fill" style=${'width:' + b.soc.toFixed(1) + '%'}></div>
        </div>` : null}`;
  }

  /* ================= Erzeuger panel (FR-310: hidden if empty) ================= */
  function ProductionPanel(props) {
    var prods = props.productions;
    var hist = props.history;
    var win = props.win;
    if (!prods || !prods.length) return null;
    return html`
      <${ui.Card} group="production" title=${t('panel.production')}
        collapsible collapseKey="uebersicht.production"
        defaultOpen=${false}>
        ${props.notice ? html`
          <div class="ov-notice" role="status">
            <span class="ov-notice-text">${t('flow.prod_nodata')}</span>
            <button class="ov-notice-close" aria-label=${t('common.close')}
              onClick=${props.onDismissNotice}>×</button>
          </div>` : null}
        <div class="ov-subgrid">
          ${prods.map(function (p) {
            var battery = isBatteryProd(p);
            /* Batterie türkis, PV gelb (spec 010 FR-1001 / UC-1002) */
            var col = battery ? 'var(--c-battery)' : 'var(--c-production)';
            var cur = ratedW(p);
            var stale = staleNote(p, Date.now() / 1000);
            var bat = battery && !stale ? batteryInfo(p) : null;
            return html`
              <div key=${p.id} class="ov-sub">
                <div class="ov-sub-head">
                  <span class="ov-sub-name">${prodName(p)}</span>
                  <span class=${'ov-sub-value' + (stale ? ' is-stale' : '')}
                    style=${stale ? '' : 'color:' + col}>${fmt.w(cur)}</span>
                </div>
                ${stale ? html`<div class="ov-sub-meta" role="status"><span>${stale}</span></div>` : null}
                ${bat ? html`<${BatteryMeta} info=${bat} />` : null}
                <${ui.LineChart} height=${150} yUnit="W" xUnit="h" timeWindow=${win}
                  yFormat=${fmt.w}
                  series=${[{ points: hist[p.id] || [], color: col,
                    label: battery ? t('stat.battery') : prodName(p) }]} />
              </div>`;
          })}
        </div>
      <//>`;
  }

  /* ================= Lasten panel (FR-310: hidden if empty) ================= */
  function LoadsPanel(props) {
    var loads = props.loads;
    var hist = props.history;
    var win = props.win;
    var onToggle = props.onToggle;
    if (!loads || !loads.length) return null;
    return html`
      <${ui.Card} group="loads" title=${t('panel.loads')} tooltip=${t('tooltip.loads')}
        collapsible collapseKey="uebersicht.loads"
        defaultOpen=${false}>
        <div class="ov-subgrid">
          ${loads.map(function (l) {
            var st = normState(l.state);
            var cur = ratedW(l);
            /* offered transition: inactive→waiting (request), else →inactive */
            var to = st === 'inactive' ? 'waiting' : 'inactive';
            var actKey = st === 'inactive' ? 'action.request' : 'action.deactivate';
            return html`
              <div key=${l.id} class="ov-sub">
                <div class="ov-sub-head">
                  <span class="ov-sub-name">${loadName(l)}</span>
                  <${ui.Badge} state=${st} />
                </div>
                <div class="ov-sub-meta">
                  <span>${fmt.w(cur)} · ${t('stat.rated')}</span>
                  <span>${t('stat.priority', { n: l.priority !== undefined ? l.priority : '–' })}</span>
                </div>
                <${ui.LineChart} height=${140} yUnit="W" xUnit="h" timeWindow=${win}
                  yFormat=${fmt.w}
                  series=${[{ points: hist[l.id] || [], color: 'var(--c-consumption)',
                    label: loadName(l) }]} />
                <div class="ov-sub-act">
                  <${ui.Button} small secondary=${to === 'inactive'}
                    onClick=${function () { onToggle(l.id, to); }}>${t(actKey)}<//>
                </div>
              </div>`;
          })}
        </div>
      <//>`;
  }

  /* ================= Stromfluss · jetzt (spec 010 FR-1002 / UC-1001) =================
     The live card that leads the page. Haus is the hub: every flow runs
     through it, so the chain reads ☀ PV → 🏠 Haus → ⚡ Netz and the numbers add
     up at Haus (pure insights.hubFlows()). HTML + CSS grid, not SVG — text keeps
     its real size on every screen, and the layout alone switches between a
     vertical chain (narrow card) and a horizontal one (container ≥ 520px).
     Sources (PV, Batterie) sit before Haus, the grid side (Netz) after
     it; an edge's arrow flips with its direction (battery charging, grid
     import). Colour follows the energy role (FR-1001) and only reinforces —
     direction is always carried by the arrow and the words. Edge `state`
     drives the look: ok → moving dots; zero → dimmed (real 0 W); unknown →
     grey dashed «–» (no data ≠ night, UC-1003). */
  var HUB_META = {
    pv:   { color: 'var(--c-production)',  label: 'flow.pv' },
    bat:  { color: 'var(--c-battery)',     label: 'flow.battery' },
    haus: { color: 'var(--c-consumption)', label: 'flow.haus' },
    netz: { color: 'var(--c-grid)',        label: 'flow.netz' }
  };
  var LIVE_S = 30;             /* newest sample older than this → not «live» */

  /* edge colour by energy role: PV production, battery; the grid edge
     is green when exporting and red when importing */
  function edgeColor(e) {
    if (e.node === 'pv') return 'var(--c-production)';
    if (e.node === 'bat') return 'var(--c-battery)';
    return e.dir === 'in' ? 'var(--c-import)' : 'var(--c-export)';
  }

  /* the words under a node value — what the number means right now */
  function nodeCaption(id, e) {
    if (id === 'haus') return { text: t('flow.consumption') };
    if (!e || e.state !== 'ok') return null;
    if (id === 'pv') return { text: t('flow.production'), color: 'var(--c-production)' };
    if (id === 'bat') return { text: e.dir === 'in' ? t('flow.bat_discharge') : t('flow.bat_charge') };
    return e.dir === 'in'
      ? { text: t('flow.import'), color: 'var(--c-import)' }
      : { text: t('flow.export'), color: 'var(--c-export)' };
  }

  /* ---- node glyphs: inline geometric icons on a ~20-unit grid, drawn in the
     node's own colour and sized to sit inside the ring. Strokes use
     non-scaling-stroke so the 1.7 px weight stays uniform across the g scale,
     matching the app's 1.6–1.8 px currentColor icon family. Sonne=PV,
     Haus=Verbrauch, Mast=Netz, Akku=Batterie. */
  function nodeIcon(id, cx, cy, color) {
    var tf = 'translate(' + cx + ' ' + cy + ') scale(1.35)';
    var sk = { fill: 'none', stroke: color, 'stroke-width': '1.7',
      'stroke-linecap': 'round', 'stroke-linejoin': 'round',
      'vector-effect': 'non-scaling-stroke' };
    if (id === 'pv') return html`
      <g transform=${tf}>
        <circle cx="0" cy="0" r="4" ...${sk} />
        <path ...${sk} d="M6.2 0 L8.6 0 M4.38 4.38 L6.08 6.08 M0 6.2 L0 8.6 M-4.38 4.38 L-6.08 6.08 M-6.2 0 L-8.6 0 M-4.38 -4.38 L-6.08 -6.08 M0 -6.2 L0 -8.6 M4.38 -4.38 L6.08 -6.08" />
      </g>`;
    if (id === 'haus') return html`
      <g transform=${tf}>
        <path ...${sk} d="M-7 0 L0 -7.5 L7 0 M-5 0 L-5 7.5 L5 7.5 L5 0 M-1.7 7.5 L-1.7 2.8 L1.7 2.8 L1.7 7.5" />
      </g>`;
    if (id === 'netz') return html`
      <g transform=${tf}>
        <path ...${sk} d="M-5.5 8 L-1.8 -6 M5.5 8 L1.8 -6 M-1.8 -6 L1.8 -6 M-7.5 -4.6 L7.5 -4.6 M-4 0 L4 0 M-4 0 L3.4 5.6 M4 0 L-3.4 5.6 M-4.8 5.6 L4.8 5.6" />
      </g>`;
    if (id === 'bat') return html`
      <g transform=${tf}>
        <rect x="-8" y="-5" width="13.5" height="10" rx="1.8" ...${sk} />
        <rect x="5.7" y="-2.4" width="2.3" height="4.8" rx="0.8" fill=${color} />
        <rect x="-5.9" y="-2.6" width="2.1" height="5.2" rx="0.5" fill=${color} />
        <rect x="-2.6" y="-2.6" width="2.1" height="5.2" rx="0.5" fill=${color} />
        <rect x="0.7" y="-2.6" width="2.1" height="5.2" rx="0.5" fill=${color} />
      </g>`;
    return null;
  }

  function HubNode(props) {
    var m = HUB_META[props.id], nd = props.node;
    var cap = nodeCaption(props.id, props.edge);
    return html`
      <div class=${'hub-node hub-node-' + props.id + ' is-' + nd.state}
        style=${'--node-c:' + m.color}>
        <span class="hub-icon">
          <svg viewBox="-13 -13 26 26" aria-hidden="true">${nodeIcon(props.id, 0, 0, m.color)}</svg>
        </span>
        <span class="hub-node-text">
          <span class="hub-node-label">${t(m.label)}</span>
          <span class="hub-node-value">${nd.state === 'unknown' ? '–' : fmt.w(nd.watts)}</span>
          ${cap ? html`<span class="hub-node-cap"
            style=${cap.color ? 'color:' + cap.color : null}>${cap.text}</span>` : null}
          ${props.soc !== null && props.soc !== undefined ? html`<span class="hub-node-cap">${
            t('stat.soc', { pct: Math.round(props.soc) })}</span>` : null}
        </span>
      </div>`;
  }

  /* an edge between a node and Haus. `side` is where the node sits: 'src'
     before Haus, 'grid' after it. The flow runs «forward» (down / right) when
     a source feeds Haus or Haus feeds the grid side, else «back» (up / left). */
  function HubEdge(props) {
    var e = props.edge;
    var fwd = props.side === 'src' ? e.dir === 'in' : e.dir === 'out';
    var col = e.state === 'unknown' ? 'var(--c-line)' : edgeColor(e);
    return html`
      <div class=${'hub-edge ' + (fwd ? 'is-fwd' : 'is-back') + ' is-' + e.state}
        style=${'--edge-c:' + col}>
        <span class="hub-edge-line" aria-hidden="true"></span>
        ${e.state === 'zero' ? null : html`
          <span class="hub-edge-pill">
            <svg class="hub-edge-arrow" viewBox="0 0 10 10" aria-hidden="true">
              <path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" stroke-width="1.8"
                stroke-linecap="round" stroke-linejoin="round" />
            </svg>
            ${e.state === 'unknown' ? '–' : fmt.w(e.watts)}
          </span>`}
      </div>`;
  }

  function FlowCard(props) {
    var hub = insights.hubFlows(props.newest,
      { pv: props.hasPv, bat: props.hasBattery });
    var head = insights.flowHeadline(hub);

    var badge = html`
      <span class=${'live-badge' + (props.live ? ' is-live' : '')}>
        <span class="live-dot" aria-hidden="true"></span>
        ${props.live ? t('flow.live')
          : (props.asOf ? t('flow.as_of', { time: fmt.time(props.asOf, 'hm') }) : t('flow.offline'))}
      </span>`;

    function edgeOf(id) {
      return hub ? hub.edges.find(function (e) { return e.node === id; }) : null;
    }
    function tier(ids, side) {
      var shown = ids.filter(function (id) { return hub.nodes[id]; });
      if (!shown.length) return null;
      var nodes = html`
        <div class=${'hub-tier hub-tier-' + side}>
          ${shown.map(function (id) {
            return html`<${HubNode} key=${id} id=${id} node=${hub.nodes[id]} edge=${edgeOf(id)}
              soc=${id === 'bat' ? props.soc : null} />`;
          })}
        </div>`;
      var links = html`
        <div class=${'hub-links hub-links-' + side}>
          ${shown.map(function (id) {
            return html`<${HubEdge} key=${id} edge=${edgeOf(id)} side=${side} />`;
          })}
        </div>`;
      /* reading order along the chain: sources → links → Haus → links → grid */
      return side === 'src' ? html`${nodes}${links}` : html`${links}${nodes}`;
    }

    return html`
      <${ui.Card} group="grid" title=${t('flow.title')} tooltip=${t('tooltip.flow')} badge=${badge}>
        ${head ? html`<p class="flow-status">${t(head.key, {
          w: fmt.w(head.vars.w), pct: head.vars.pct })}</p>` : null}
        ${hub ? html`
          <div class="hub-wrap">
            <div class="hub" role="img" aria-label=${t('flow.aria')}>
              ${tier(['pv', 'bat'], 'src')}
              <div class="hub-haus">
                <${HubNode} id="haus" node=${hub.nodes.haus} />
              </div>
              ${tier(['netz'], 'grid')}
            </div>
          </div>` : html`<div class="hub-empty">${t('flow.status_unknown')}</div>`}
      <//>`;
  }

  /* ================= Composition bars (spec 010 FR-1006 / UC-1004) =================
     Two 100 %-stacked horizontal bars under the diagram: «Stromherkunft»
     (Verbrauch gedeckt aus) and «Stromverwendung» (Produktion verwendet für).
     «Jetzt» reads the newest /api/power sample (W); «Heute» reads today's
     /api/energy slots (Wh; battery segments once the slots carry battery Wh —
     issue #20 — with a note while a battery site has none for today yet).
     Zero segments collapse; unknown inputs show the grey «keine Daten» state
     instead of a fabricated 100 % Netz share. */
  function CompBar(props) {
    var segs = (props.segments || []).filter(function (s) { return s.value > 0; });
    var total = segs.reduce(function (a, s) { return a + s.value; }, 0);
    var empty = props.unknown || total <= 0;
    return html`
      <div class="comp-row">
        <div class="comp-row-head">
          <span class="comp-row-title">${props.title}</span>
          ${props.note ? html`<${ui.Tooltip} text=${props.note} />` : null}
        </div>
        ${empty ? html`
          <div class="comp-bar comp-bar-nodata">${props.unknown ? t('flow.comp_nodata') : t('flow.comp_zero')}</div>`
        : html`
          <div class="comp-bar">
            ${segs.map(function (s, i) {
              var pct = s.value / total * 100;
              return html`<div key=${i} class="comp-seg"
                title=${t(s.key) + ': ' + props.fmt(s.value)}
                style=${'width:' + pct.toFixed(2) + '%;background:' + s.color}></div>`;
            })}
          </div>
          <div class="comp-legend">
            ${segs.map(function (s, i) {
              return html`
                <span key=${i} class="comp-leg">
                  <span class="comp-leg-dot" style=${'background:' + s.color}></span>
                  ${props.arrows && props.arrows[s.key] ? html`<span class="comp-leg-dir"
                    aria-hidden="true">${props.arrows[s.key]}</span>` : null}
                  ${t(s.key)} · ${props.fmt(s.value)}
                </span>`;
            })}
          </div>`}
      </div>`;
  }

  /* grid-crossing segments carry their direction: ← bezogen, → abgegeben */
  var COVER_ARROWS = { 'comp.grid': '←' };
  var USAGE_ARROWS = { 'comp.feedin': '→' };

  function CompositionBars(props) {
    var modeSt = useState('now'); var mode = modeSt[0], setMode = modeSt[1];
    var data = mode === 'now'
      ? insights.sourcesNow(props.sample)
      : insights.sourcesToday(props.records);
    var fmtV = mode === 'now' ? fmt.w : fmt.wh;
    var battNote = mode === 'today' && props.hasBattery && !data.battery && !data.unknown
      ? t('flow.comp_batt_note') : null;
    return html`
      <div class="comp-wrap">
        <div class="seg-toggle comp-toggle">
          <button class=${'seg-btn' + (mode === 'now' ? ' seg-btn-active' : '')}
            onClick=${function () { setMode('now'); }}>${t('flow.comp_now')}</button>
          <button class=${'seg-btn' + (mode === 'today' ? ' seg-btn-active' : '')}
            onClick=${function () { setMode('today'); }}>${t('flow.comp_today')}</button>
        </div>
        <${CompBar} title=${t('flow.comp_cover')} segments=${data.cover}
          unknown=${data.unknown} fmt=${fmtV} arrows=${COVER_ARROWS} />
        <${CompBar} title=${t('flow.comp_usage')} segments=${data.usage}
          unknown=${data.unknown} fmt=${fmtV} note=${battNote} arrows=${USAGE_ARROWS} />
      </div>`;
  }

  /* full-width card under Stromfluss + KPIs, like the VERLAUF panels: detail,
     so closed by default; open/closed is a per-browser convenience */
  function CompositionCard(props) {
    return html`
      <${ui.Card} group="grid" title=${t('flow.comp_title')} collapsible collapseKey="ov.comp"
        defaultOpen=${false}>
        <${CompositionBars} sample=${props.sample} records=${props.records}
          hasBattery=${props.hasBattery} />
      <//>`;
  }

  /* ================= KPI strip (FR-803 / UC-802 / UC-804) ================= */

  /* donut gauge: ratio 0..1 (or null → «—»), coloured ring + centred percent */
  function Gauge(props) {
    var r = props.ratio;
    var known = r !== null && r !== undefined && !isNaN(r);
    var pct = known ? Math.round(r * 100) : null;
    var C = 2 * Math.PI * 26;                     /* circumference, radius 26 */
    var dash = known ? Math.max(0, Math.min(1, r)) * C : 0;
    return html`
      <svg class=${'kpi-gauge' + (props.big ? ' kpi-gauge-lg' : '')} viewBox="0 0 64 64" aria-hidden="true">
        <circle cx="32" cy="32" r="26" fill="none" stroke="var(--c-line)" stroke-width="7" />
        ${known ? html`
          <circle cx="32" cy="32" r="26" fill="none" stroke=${props.color} stroke-width="7"
            stroke-linecap="round" stroke-dasharray=${dash.toFixed(1) + ' ' + C.toFixed(1)}
            transform="rotate(-90 32 32)" />` : null}
        <text x="32" y="32" text-anchor="middle" dominant-baseline="central"
          class="kpi-gauge-txt">${known ? pct + ' %' : '–'}</text>
      </svg>`;
  }

  function KpiStrip(props) {
    var k = props.kpis;
    if (!k) return null;
    var incompleteTip = k.incomplete ? t('kpi.incomplete') : null;

    function pctText(v) { return (v === null || v === undefined) ? '–' : Math.round(v * 100) + ' %'; }

    /* Ersparnis breakdown tooltip (UC-804): result headline, arithmetic one
       click away. */
    var sp = k.savingParts;
    var savingTip = sp ? [
      t('kpi.saving_selfuse') + ': ' + fmt.chf(sp.selfuse, true),
      t('kpi.saving_feedin') + ': ' + fmt.chf(sp.feedin, true)
    ].join('\n') : t('tooltip.kpi_saving');

    /* the hero is money when we can show it, self-sufficiency otherwise */
    var heroIsSaving = !!props.showSaving;

    var hero = heroIsSaving
      ? html`
        <div class="kpi-hero">
          <div class="kpi-hero-num">${k.savingChf === null ? '–' : fmt.chf(k.savingChf, false)}</div>
          <div class="kpi-hero-meta">
            <span class="kpi-hero-label">${t('kpi.saving')}<${ui.Tooltip} text=${incompleteTip || savingTip} /></span>
            <span class="kpi-hero-period">${props.period}</span>
          </div>
        </div>`
      : html`
        <div class="kpi-hero">
          <${Gauge} big ratio=${k.autarky} color="var(--c-export)" />
          <div class="kpi-hero-meta">
            <span class="kpi-hero-label">${t('kpi.autarky')}<${ui.Tooltip} text=${incompleteTip || t('tooltip.kpi_autarky')} /></span>
            <span class="kpi-hero-period">${props.period}</span>
          </div>
        </div>`;

    /* supporting tiles — everything the hero didn't take, in priority order */
    var support = [];
    if (heroIsSaving) {
      support.push(html`<${KpiTile} key="au" gauge ratio=${k.autarky} color="var(--c-export)"
        label=${t('kpi.autarky')} tip=${incompleteTip || t('tooltip.kpi_autarky')} />`);
    }
    support.push(html`<${KpiTile} key="su" gauge ratio=${k.selfuse} color="var(--c-production)"
      label=${t('kpi.selfuse_short')} tip=${incompleteTip || t('tooltip.kpi_selfuse')} />`);
    if (props.showCo2) {
      support.push(html`<${KpiTile} key="co" value=${fmtCo2(k.co2Kg)} color="var(--c-production)"
        label=${t('kpi.co2')} tip=${incompleteTip || t('tooltip.kpi_co2', { g: props.co2Factor })} />`);
    }

    return html`
      <div class="kpi-band">
        ${hero}
        <div class="kpi-support">${support}</div>
      </div>`;
  }

  /* supporting KPI tile — a gauge or a bare number, subordinate to the hero */
  function KpiTile(props) {
    return html`
      <div class="kpi-tile">
        ${props.gauge
          ? html`<${Gauge} ratio=${props.ratio} color=${props.color} />`
          : html`<div class="kpi-num" style=${props.color ? 'color:' + props.color : null}>${props.value}</div>`}
        <div class="kpi-body">
          <span class="kpi-label">${props.label}<${ui.Tooltip} text=${props.tip} /></span>
          ${props.sub ? html`<span class="kpi-sub">${props.sub}</span>` : null}
        </div>
      </div>`;
  }

  /* ================= First-paint skeleton ================= */
  /* Mirrors the real layout (flow card · KPI band · one panel) so the first
     poll's arrival doesn't jolt the page, and announces loading to assistive
     tech. Shown until the first power/loads/productions cycle settles. */
  function OverviewSkeleton() {
    return html`
      <div class="ov-skel">
        <span class="sr-only" role="status">${t('common.loading')}</span>
        <div class="ov-top" aria-hidden="true">
          <div class="ov-top-flow">
            <div class="ov-section"> </div>
            <div class="skel skel-flow"></div>
          </div>
          <div class="ov-top-side">
            <div class="ov-section"> </div>
            <div class="kpi-band">
              <div class="skel skel-hero"></div>
              <div class="kpi-support">
                <div class="skel skel-tile"></div>
                <div class="skel skel-tile"></div>
                <div class="skel skel-tile"></div>
              </div>
            </div>
          </div>
        </div>
        <div class="skel skel-panel" aria-hidden="true"></div>
      </div>`;
  }

  /* CO₂ mass: kg below 1 t, else t (Edge: null → «—») */
  function fmtCo2(kg) {
    if (kg === null || kg === undefined || isNaN(kg)) return '–';
    if (kg >= 1000) return fmt.num(kg / 1000, 2) + ' t';
    return fmt.num(kg, kg < 10 ? 2 : 1) + ' kg';
  }

  /* ================= Page ================= */
  function Uebersicht() {
    var siteSt = useState(null); var site = siteSt[0], setSite = siteSt[1];
    var powerSt = useState(null); var power = powerSt[0], setPower = powerSt[1];
    var loadsSt = useState([]); var loads = loadsSt[0], setLoads = loadsSt[1];
    var prodsSt = useState([]); var prods = prodsSt[0], setProds = prodsSt[1];
    var energySt = useState(null); var energy = energySt[0], setEnergy = energySt[1];
    var metaSt = useState(null); var meta = metaSt[0], setMeta = metaSt[1];
    var clockSt = useState(function () { return Math.floor(Date.now() / 1000); });
    var nowClock = clockSt[0], setNowClock = clockSt[1];
    var updSt = useState(null); var lastUpdate = updSt[0], setLastUpdate = updSt[1];
    var dismissSt = useState({}); var dismissed = dismissSt[0], setDismissed = dismissSt[1];
    /* false until the first power/loads/productions poll cycle resolves — drives
       the first-paint skeleton so an initial screen of «–» never reads as broken.
       Flips true even when offline (the cycle still settles), handing off to the
       real empty/offline state rather than a permanent skeleton. */
    var settledSt = useState(false); var settled = settledSt[0], setSettled = settledSt[1];
    /* bumped once the archive rehydrate lands — the rings live in refs, so a
       render has to be forced for the restored sparklines to appear. */
    var hydSt = useState(0); var setHydrateTick = hydSt[1];

    /* per-id client-side history rings (UC-302/303), kept across renders and
       — since the device serves only a snapshot per load/production — mirrored
       into the archive so a browser reload does not restart them empty while
       the Netzanschluss chart (device ring, /api/power) is already complete. */
    var prodHist = useRef({});
    var loadHist = useRef({});
    /* true once the rehydrate below has run (or failed): the poll must not
       persist an empty ring over the stored one before then. */
    var hydrated = useRef(false);

    /* single clock drives the shared window for every chart (FR-304) */
    var t1 = nowClock;
    var t0 = t1 - WINDOW_S;
    var win = [t0, t1];

    /* /site + /api/meta (tariffs incl. co2_g_kwh) once */
    useEffect(function () {
      api.getSite()
        .then(function (s) { setSite(s); })
        .catch(function () { /* toast handled by onStatus */ });
      api.getMeta()
        .then(function (m) { setMeta(m); })
        .catch(function () { /* KPIs fall back to default tariffs */ });
    }, []);

    /* rehydrate the per-id rings from the archive (one shot, before the first
       poll persists anything). Points older than the current window are
       dropped by getLive, so a long-closed tab starts clean. */
    useEffect(function () {
      var alive = true;
      function done() { if (alive) { hydrated.current = true; setHydrateTick(function (n) { return n + 1; }); } }
      archive.ready().then(function (st) {
        if (!alive) return;
        if (!st || !st.available || !st.siteId) { done(); return; }
        var from = Math.floor(Date.now() / 1000) - WINDOW_S;
        return Promise.all([
          archive.getLive(st.siteId, 'prod', from).catch(function () { return {}; }),
          archive.getLive(st.siteId, 'load', from).catch(function () { return {}; })
        ]).then(function (r) {
          if (!alive) return;
          mergeHistory(prodHist.current, r[0]);
          mergeHistory(loadHist.current, r[1]);
          done();
        });
      }, done).catch(done);
      return function () { alive = false; };
    }, []);

    /* today's 15-min energy for the KPI strip (FR-803). Slots close every
       15 min, so a 60 s poll is ample; the strip refreshes with the page. */
    useEffect(function () {
      return api.poll(function () {
        api.getEnergy('15m', 96)
          .then(function (d) {
            if (Array.isArray(d)) setEnergy(d);
          })
          .catch(function () { /* KPIs show «—» without data */ });
      }, 60000);
    }, []);

    /* poll power + loads + productions every 10 s (FR-309) */
    useEffect(function () {
      return api.poll(function () {
        var now = Math.floor(Date.now() / 1000);
        setNowClock(now);
        var lo = now - WINDOW_S;

        Promise.all([
          api.getPower().catch(function () { return null; }),
          api.getLoads().catch(function () { return null; }),
          api.getProductions().catch(function () { return null; })
        ]).then(function (res) {
          var pw = res[0], ld = res[1], pr = res[2];
          if (pw) { setPower(pw); }
          if (ld) { setLoads(ld); }
          if (pr) { setProds(pr); }
          if (pw || ld || pr) { setLastUpdate(now); }
          setSettled(true);

          /* record per-id client-side history from the fresh snapshots */
          if (pr) {
            pr.forEach(function (p) { pushHistory(prodHist.current, p.id, now, ratedW(p), lo); });
          }
          if (ld) {
            ld.forEach(function (l) {
              var y = normState(l.state) === 'active' ? ratedW(l) : 0;
              pushHistory(loadHist.current, l.id, now, y, lo);
            });
          }

          /* mirror the rings into the archive (best effort, ignored when
             IndexedDB is blocked — the charts keep working from RAM) */
          if (hydrated.current && (pr || ld)) {
            var ast = archive.state();
            if (ast && ast.available && ast.siteId) {
              if (pr) archive.putLive(ast.siteId, 'prod', prodHist.current).catch(function () {});
              if (ld) archive.putLive(ast.siteId, 'load', loadHist.current).catch(function () {});
            }
          }
        });
      }, 10000);
    }, []);

    var s = newest(power);
    /* per-metric /api/power series over the shared window — used for the
       Erzeuger data-quality notice below (FR-1005); the Netzanschluss chart
       derives its own consumption/production lines from the same /api/power
       ring inside GridPanel (energy balance, see gridSeries). */
    var ser = powerSeries(power, t0, t1);

    /* Erzeuger data-quality notice (FR-1005): productions configured but every
       live-PV sample in the window is null → integration/reachability hint,
       dismissible per session. */
    var prodNotice = (prods && prods.length &&
      insights.pvSeriesAllNull(ser.pv.map(function (p) { return p.y; })) &&
      !dismissed['flow.prod_nodata']) ? true : false;
    function dismissProdNotice() {
      var next = Object.assign({}, dismissed);
      next['flow.prod_nodata'] = true;
      setDismissed(next);
    }

    /* ---- KPI strip (FR-803): today's slots, one insights.kpis() source ---- */
    var d0 = new Date(); d0.setHours(0, 0, 0, 0);
    var startOfToday = Math.floor(d0.getTime() / 1000);
    var todayRecs = (energy || []).filter(function (r) { return r.ts >= startOfToday; });
    var tariffs = (meta && meta.tariffs) || {};
    /* co2_g_kwh: unset → Schweizer Verbrauchermix default 128; 0 hides the stat */
    var co2Factor = (tariffs.co2_g_kwh === undefined || tariffs.co2_g_kwh === null || tariffs.co2_g_kwh === '')
      ? 128 : Number(tariffs.co2_g_kwh);
    var kpi = insights.kpis(todayRecs, { tariffs: tariffs, co2: co2Factor });
    /* Ersparnis hidden when no import/feed-in tariff is configured (Edge case) */
    var showSaving = (Number(tariffs.grid_import_chf_kwh) > 0) || (Number(tariffs.grid_feedin_chf_kwh) > 0);
    var showCo2 = co2Factor > 0;
    var kpiPartial = todayRecs.some(function (r) { return r.partial; });
    var kpiPeriod = kpiPartial
      ? t('kpi.today_until', { time: fmt.time(nowClock, 'hm') }) : t('kpi.today');

    var hasBattery = (prods || []).some(function (p) {
      return String(p.productionType || '').toUpperCase() === 'BATTERY';
    });
    /* a site without any non-battery production has no PV node (its pv_w is
       null by design, which must not read as «unknown») */
    var hasPv = (prods || []).some(function (p) {
      return String(p.productionType || '').toUpperCase() !== 'BATTERY';
    });
    /* «live»: the last poll succeeded AND the device's newest sample is fresh
       (device clock vs its own sample ts — no browser/device clock skew) */
    var live = !!(s && lastUpdate && nowClock - lastUpdate < 25 &&
      power && typeof power.now === 'number' && power.now - s.ts < LIVE_S);

    var subtitle = site && site.location ? site.location : null;
    var actions = lastUpdate ? html`
      <span class="ov-updated">${t('common.stale', { time: fmt.time(lastUpdate, 'hm') })}</span>` : null;

    function onToggle(id, to) {
      api.setLoadState(id, to)
        .then(function () { return api.getLoads(); })
        .then(function (ld) { if (ld) setLoads(ld); })
        .catch(function () { toast(t('error.toggle'), { type: 'error' }); });
    }

    return html`
      <div>
        <${ui.PageHeader} title=${site && site.name ? site.name : t('page.overview')}
          subtitle=${subtitle} actions=${actions} />
        ${!settled ? html`<${OverviewSkeleton} />` : html`
          <${Fragment}>
            <div class="ov-top">
              <section class="ov-top-flow" aria-labelledby="ov-sec-now">
                <h2 class="ov-section" id="ov-sec-now">${t('section.now')}</h2>
                <${FlowCard} newest=${s} hasBattery=${hasBattery} hasPv=${hasPv}
                  soc=${hasBattery ? batterySoc(prods) : null}
                  live=${live} asOf=${s ? s.ts : null} />
              </section>
              <section class="ov-top-side" aria-labelledby="ov-sec-today">
                <h2 class="ov-section" id="ov-sec-today">${t('section.today')}</h2>
                <${KpiStrip} kpis=${kpi} period=${kpiPeriod} showSaving=${showSaving}
                  showCo2=${showCo2} co2Factor=${co2Factor} />
              </section>
            </div>
            <${CompositionCard} sample=${s} records=${todayRecs}
              hasBattery=${hasBattery} />
            <section class="ov-history" aria-labelledby="ov-sec-history">
              <h2 class="ov-section" id="ov-sec-history">${t('section.history')}</h2>
              <${GridPanel} newest=${s} win=${win} power=${power} />
              <${ProductionPanel} productions=${prods} history=${prodHist.current} win=${win}
                notice=${prodNotice} onDismissNotice=${dismissProdNotice} />
              <${LoadsPanel} loads=${loads} history=${loadHist.current} win=${win} onToggle=${onToggle} />
            </section>
          <//>`}
      </div>`;
  }

export { Uebersicht, mergeHistory, staleNote, batteryInfo, batterySoc };
