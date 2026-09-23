/* App entry: route table (FR-213), placeholder pages for specs 003-006, the
   hidden #/demo component gallery, and the boot sequence (i18n before first
   render, FR-206). */
import { html, render } from './core.js';
import { t, i18n } from './i18n.js';
import { fmt } from './format.js';
import { toast } from './components.js';
import * as ui from './ui.js';
import { Shell } from './shell.js';
import { Uebersicht } from './pages/uebersicht.js';
import { Verlauf } from './pages/verlauf.js';
import { Zaehler } from './pages/zaehler.js';
import { Modbus } from './pages/modbus.js';
import { Einstellungen } from './pages/einstellungen.js';
import { api } from './api.js';
import * as archive from './lib/archive.js';

/* ---- Placeholder page for routes implemented by later specs ---- */
function placeholder(titleKey, specNo) {
  return function Placeholder() {
    return html`
      <div>
        <${ui.PageHeader} title=${t(titleKey)} />
        <${ui.Card}>
          <p class="placeholder-text">${t('placeholder.note', { spec: specNo })}</p>
        <//>
      </div>`;
  };
}

/* ---- Demo route: every shared component with sample data ---- */
function Demo() {
  var now = Math.floor(Date.now() / 1000);
  var win = [now - 900, now];

  function linePts(base, amp, gapFrom, gapTo) {
    var pts = [];
    for (var i = 0; i <= 90; i++) {
      var ts = now - 900 + i * 10;
      var y = (i >= gapFrom && i <= gapTo)
        ? null
        : Math.max(0, base + amp * Math.sin(i / 9) + amp * 0.4 * Math.sin(i / 2.3));
      pts.push({ t: ts, y: y });
    }
    return pts;
  }

  var barPts = [];
  for (var i = 0; i < 12; i++) {
    barPts.push({
      t: now - 12 * 900 + i * 900,
      y: Math.round((Math.sin(i / 2) * 0.6 - 0.15) * 100) / 100
    });
  }

  var rows = [];
  for (var r = 0; r < 23; r++) {
    rows.push({
      id: r,
      ts: fmt.time(now - r * 900, '15m'),
      imp: fmt.num(Math.round(Math.random() * 0 + r * 7) / 100, 2),
      chf: fmt.chf((r % 3 === 0 ? -1 : 1) * r * 0.19, true)
    });
  }

  return html`
    <div>
      <${ui.PageHeader} title=${t('page.demo')} subtitle="Komponenten-Galerie (dev)"
        actions=${html`<${ui.Button} onClick=${function () { toast('Toast!', { type: 'info' }); }}>Toast<//>`} />

      <${ui.Card} group="grid" title="LineChart" tooltip=${t('tooltip.consumption')}
        value=${fmt.w(1396)} valueColor="var(--c-consumption)">
        <${ui.LineChart} height=${200} yUnit="W" xUnit="h" timeWindow=${win}
          yFormat=${fmt.w}
          series=${[
            { points: linePts(900, 420, 30, 36), color: 'var(--c-consumption)', label: 'Verbrauch' },
            { points: linePts(600, 500, -1, -1), color: 'var(--c-production)', label: 'Erzeugung' }
          ]} />
      <//>

      <${ui.Card} group="grid" title="BarChart" subtitle="0-Achse, signierte Werte"
        value=${fmt.chf(12.4, true)} valueColor="var(--c-export)">
        <${ui.BarChart} height=${200} yUnit="CHF" xUnit="t" yFormat=${function (v) { return fmt.chf(v, true); }}
          points=${barPts.map(function (p) {
            return { t: p.t, y: p.y, color: p.y < 0 ? 'var(--c-import)' : 'var(--c-export)' };
          })} />
      <//>

      <${ui.Card} group="loads" title="Badges & Buttons">
        <div class="demo-row">
          <${ui.Badge} state="active" />
          <${ui.Badge} state="waiting" />
          <${ui.Badge} state="inactive" />
        </div>
        <div class="demo-row">
          <${ui.Button}>Speichern<//>
          <${ui.Button} secondary>Abbrechen<//>
          <${ui.Button} danger>Löschen<//>
          <${ui.Button} disabled>Deaktiviert<//>
        </div>
        <div class="demo-row demo-fields">
          <${ui.TextField} label="Anzeige-Name" value="Familie Huber" />
          <${ui.Select} label="Typ" value="P" options=${[
            { value: 'P', label: 'Produzent' }, { value: 'C', label: 'Konsument' }
          ]} />
        </div>
      <//>

      <${ui.Card} group="production" title="DataTable">
        <${ui.DataTable} pageSize=${10}
          columns=${[
            { key: 'ts', label: 'Zeitpunkt' },
            { key: 'imp', label: 'Netzbezug', unit: '[kWh]', align: 'right' },
            { key: 'chf', label: 'Saldo', unit: '[CHF]', align: 'right',
              render: function (row) {
                var neg = row.chf.indexOf('−') === 0;
                return html`<span class=${neg ? 'val-neg' : 'val-pos'}>${row.chf}</span>`;
              } }
          ]}
          rows=${rows} />
      <//>
    </div>`;
}

/* ---- Route table (FR-213) — first entry is the unknown-route fallback ---- */
function routes() {
  return [
    { path: '/', component: Uebersicht },
    { path: '/verlauf', component: Verlauf },
    { path: '/zaehler', component: Zaehler },
    { path: '/modbus', component: Modbus },
    { path: '/einstellungen/:tab?', component: Einstellungen },
    { path: '/demo', component: Demo }
  ];
}

/* ---- Boot: language first, then render (no flash of raw keys) ---- */
function boot() {
  var mount = document.getElementById('app');
  /* Dictionary URLs, tried in order. In dev every module (incl. this one) is
     served by `npm run dev`, even when the shell is flashed to a device
     (ASSET_BASE=dev): derive the dev-server URL from import.meta.url so
     lang.json comes from the dev server and live ./lang.json edits show up —
     never the device. In a production build __LANG_URLS__ is statically
     replaced (vite.config.js) by a single CDN URL (lang.json, or
     lang-<lang>.json for a non-German build), with NO device fallback —
     lang.json is never packed into the .tapp (it cost a quarter of the
     package), and an unreachable CDN means the JS bundle never loaded either. */
  var langUrls = import.meta.env.DEV
    ? [new URL('../lang.json', import.meta.url).href, 'i18n/de.json']
    : __LANG_URLS__;
  i18n.load(langUrls)
    .catch(function () { /* proceed with raw keys rather than a dead page */ })
    .then(function () {
      render(html`<${Shell} routes=${routes()} />`, mount);
      /* spec 011 FR-1103: mirror the device's raw 15-min records and peer
         slots into IndexedDB, then keep syncing every 15 min. Pages await
         archive.ready() and fall back to the live device buffer when storage
         is unavailable (FR-1111). Never blocks the first render. */
      archive.start(api);
    });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}

/* `placeholder` is retained for the routes that later specs will wire up. */
export { placeholder };
