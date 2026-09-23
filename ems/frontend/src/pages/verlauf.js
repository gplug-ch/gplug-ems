/* «Verlauf» — energy & cost history (spec 004). Newest-first paginated table
   with resolution select, resolution-boundary separators, gap markers, peak
   marks, a 0-anchored bar chart, a summary strip and CSV export. Columns are
   data-driven: a site with productions gets the producer column set. Units
   live in the column HEADERS only; row cells are plain numbers. */
import { html, useState, useEffect, useMemo } from '../core.js';
import { t } from '../i18n.js';
import { fmt } from '../format.js';
import { api } from '../api.js';
import * as ui from '../ui.js';
import * as agg from '../lib/aggregate.js';
import * as insights from '../lib/insights.js';
import * as csv from '../lib/csv.js';
import * as archive from '../lib/archive.js';

var PAGE_SIZES = [10, 25, 50];

  /* Resolution menu: value → { aggregation target, device-buffer record
     count, the fmtTime token for row/tick labels, the seconds per slot }.
     Every resolution aggregates 15-min records (spec 011 FR-1122: that is the
     only resolution the device serves). `count` is what to fetch when there is
     no archive — DEV_CAP is store.capacity('15m') = KEEP_DAYS·96. */
  var DEV_CAP = 2880;
  var RES = {
    '15m': { label: 'history.res.15m', count: 240, target: '15m', tk: '15m', slot: 900 },
    '1h': { label: 'history.res.hour', count: 240, target: '1h', tk: '15m', slot: 3600 },
    '1d': { label: 'history.res.day', count: DEV_CAP, target: '1d', tk: '1d', slot: 86400 },
    '1w': { label: 'history.res.week', count: DEV_CAP, target: '1w', tk: '1d', slot: 604800 },
    '1mo': { label: 'history.res.month', count: DEV_CAP, target: '1mo', tk: '1mo', slot: 2592000 },
    '1q': { label: 'history.res.quarter', count: DEV_CAP, target: '1q', tk: 'q', slot: 7776000 }
  };
  var RES_ORDER = ['15m', '1h', '1d', '1w', '1mo', '1q'];

  /* spec 011 FR-1105: every resolution is derived from ARCHIVED 15-min
     records. One window per resolution, in seconds back from now, matching
     the record counts the device's former 1d/1mo rings used to hold. */
  var ARCHIVE_SPAN = {
    '15m': 240 * 900, '1h': 240 * 900,
    '1d': 125 * 86400, '1w': 125 * 86400,
    '1mo': 19 * 31 * 86400, '1q': 19 * 31 * 86400
  };

  /* Chart overview window: how many most-recent slots the bar chart shows per
     resolution. The chart is a fixed recent window on a CONTINUOUS time grid —
     missing slots render as blanks so gaps stay visible and bars from different
     days never collapse next to each other. The full history lives in the table
     below. */
  var CHART_SLOTS = { '15m': 32, '1h': 24, '1d': 31, '1w': 13, '1mo': 13, '1q': 9 };

  /* session-persisted UI prefs */
  var prefs = { res: '15m', pageSize: 25, chfMode: false, chartMode: 'net' };

  function whToKwh(wh) { return (wh === null || wh === undefined) ? null : wh / 1000; }

  /* Previous aligned slot start for a resolution. Constant-length slots step by
     seconds; months/quarters step by calendar (UTC, matching lib/aggregate.js
     bucket starts) since their length varies. */
  function prevSlot(ts, resKey) {
    var d;
    if (resKey === '1mo') {
      d = new Date(ts * 1000);
      return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1) / 1000);
    }
    if (resKey === '1q') {
      d = new Date(ts * 1000);
      return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 3, 1) / 1000);
    }
    return ts - RES[resKey].slot;
  }

  /* Build the chart's recent continuous window: up to CHART_SLOTS[res] slots
     ending at the newest row, stepping back one aligned slot at a time. Present
     slots carry their record; missing slots get a `__blank` sentinel (rendered
     as empty space). Never steps older than the oldest available row, so there
     are no blanks before data ever existed. Returns newest-first. */
  function chartWindow(rows, resKey) {
    if (!rows.length) return [];
    var count = CHART_SLOTS[resKey] || rows.length;
    var byTs = {};
    rows.forEach(function (r) { byTs[r.ts] = r; });
    var oldest = rows[rows.length - 1].ts;
    var out = [];
    var ts = rows[0].ts; /* rows are newest-first → newest slot */
    for (var i = 0; i < count && ts >= oldest; i++) {
      out.push(byTs[ts] || { ts: ts, __blank: true });
      ts = prevSlot(ts, resKey);
    }
    return out;
  }

  /* number cell: plain de-CH number (units are in the header). */
  function numCell(wh, decimals) {
    var k = whToKwh(wh);
    return k === null ? '–' : fmt.num(k, decimals === undefined ? 2 : decimals);
  }

  /* plain CHF span, always green when positive (savings / import cost). */
  function chfPlain(v, cls) {
    if (v === null || v === undefined) return html`<span>–</span>`;
    return html`<span class=${cls || ''}>${fmt.chf(v, false)}</span>`;
  }

  /* Build the column descriptor list for the current site type + data.
     `htnt` (spec 009 FR-909): when HT/NT is configured the single Netzbezug-cost
     column is replaced by two HT/NT cost columns (costs always derived from the
     15-min split carried up by lib/aggregate.js). `battery` (issue #20): the
     rows carry battery charge/discharge Wh → two Batterie columns. */
  function buildColumns(producer, hasFeedin, htnt, battery) {
    var cols = [
      { key: 'ts', label: t('history.col.time') },
      { key: 'imp', label: t('history.col.gridimport'), unit: '[kWh]', align: 'right' }
    ];
    if (htnt) {
      cols.push({ key: 'impcost_ht', label: t('history.col.gridcost_ht'), unit: '[CHF]', align: 'right' });
      cols.push({ key: 'impcost_nt', label: t('history.col.gridcost_nt'), unit: '[CHF]', align: 'right' });
    } else {
      cols.push({ key: 'impcost', label: t('history.col.gridcost'), unit: '[CHF]', align: 'right' });
    }
    if (producer && hasFeedin) {
      cols.push({ key: 'exp', label: t('history.col.feedin'), unit: '[kWh]', align: 'right' });
    }
    if (battery) {
      cols.push({ key: 'batchg', label: t('history.col.batcharge'), unit: '[kWh]', align: 'right' });
      cols.push({ key: 'batdis', label: t('history.col.batdischarge'), unit: '[kWh]', align: 'right' });
    }
    if (producer) {
      cols.push({ key: 'saving', label: t('history.col.selfuse'), unit: '[CHF]', align: 'right' });
      /* spec 008 derived per-period columns (UC-803) */
      cols.push({ key: 'autarky', label: t('history.col.autarky'), unit: '[%]', align: 'right' });
      cols.push({ key: 'selfuserate', label: t('history.col.selfuserate'), unit: '[%]', align: 'right' });
      cols.push({ key: 'ersparnis', label: t('history.col.ersparnis'), unit: '[CHF]', align: 'right' });
    }
    return cols;
  }

  /* percent cell from an insights ratio (0..1) or null → «–» */
  function pctCell(ratio) {
    return (ratio === null || ratio === undefined) ? '–' : fmt.num(ratio * 100, 0) + ' %';
  }

  /* Grid saldo of a row: feed-in revenue minus import cost (CHF), or null
     when neither is known. */
  function rowGridSaldo(r) {
    var rev = r.revenue_feedin_chf, cost = r.cost_import_chf;
    if ((rev === null || rev === undefined) && (cost === null || cost === undefined)) return null;
    return (rev || 0) - (cost || 0);
  }

  /* Insert boundary + gap sentinel rows into a newest-first record list.
     Returns an array of display items: { kind:'row', rec } | { kind:'gap' } |
     { kind:'boundary' }. FR-403 (boundary when the finest ring ends) and
     FR-410 (gap when ≥1 slot missing between adjacent rows). */
  function withSeparators(records, resKey, coversFullRange) {
    var slot = RES[resKey].slot;
    var items = [];
    for (var i = 0; i < records.length; i++) {
      items.push({ kind: 'row', rec: records[i] });
      var next = records[i + 1]; /* older neighbour (list is newest-first) */
      if (next) {
        var gapSlots = Math.round((records[i].ts - next.ts) / slot) - 1;
        if (gapSlots >= 1) items.push({ kind: 'gap', key: 'g' + records[i].ts });
      }
    }
    /* FR-403: the finest ring only covers a limited range; when older data
       would only exist at a coarser resolution, terminate with a boundary. */
    if (!coversFullRange && records.length) {
      items.push({ kind: 'boundary', key: 'b' + records[records.length - 1].ts });
    }
    return items;
  }

  /* ---- Archive coverage note (spec 011 FR-1107) ----
     How much history the browser holds, and whether the visible period is
     «provisorisch» because the archive has a hole in it. Gaps are shown,
     never filled (spec 001 UC-104). */
  function ArchiveNote(props) {
    var cov = props.coverage;
    if (!cov || cov.firstE15Ts === null) return null;
    var from = Math.floor(Date.now() / 1000) - props.span;
    var gaps = (cov.gaps || []).filter(function (g) { return g[1] >= from; });
    return html`
      <p class="verlauf-archive-note">
        <span class="badge badge-inactive">${t('history.archive_badge', { days: cov.days })}</span>
        ${gaps.length ? html`
          <span class="verlauf-archive-gap">
            ${t('history.archive_gap', {
              from: fmt.time(gaps[0][0], '1d'),
              to: fmt.time(gaps[gaps.length - 1][1], '1d'),
              count: gaps.length
            })}
          </span>` : null}
      </p>`;
  }

  function Verlauf() {
    var resSt = useState(prefs.res);
    var resKey = resSt[0], setResKey = resSt[1];
    var pageSt = useState(0);
    var page = pageSt[0], setPage = pageSt[1];
    var sizeSt = useState(prefs.pageSize);
    var pageSize = sizeSt[0], setPageSize = sizeSt[1];
    var chfSt = useState(prefs.chfMode);
    var chfMode = chfSt[0], setChfMode = chfSt[1];
    var modeSt = useState(prefs.chartMode);
    var chartMode = modeSt[0], setChartMode = modeSt[1];

    var dataSt = useState({ records: null, tariffs: {}, producer: false,
                            err: false, archived: false, coverage: null,
                            blocked: false });
    var data = dataSt[0], setData = dataSt[1];
    var loadSt = useState(true);
    var loading = loadSt[0], setLoading = loadSt[1];

    /* persist prefs in module scope for the session */
    prefs.res = resKey; prefs.pageSize = pageSize; prefs.chfMode = chfMode;
    prefs.chartMode = chartMode;

    /* Load raw 15-min data whenever the resolution changes. Preferred source
       is the browser archive (spec 011): it holds the full 15-min history, so
       every resolution — including «Monat» — is derived from 15-min records
       and the HT/NT split works on past months too. Without a usable archive
       (private window, blocked storage) the device's own buffer is used, which
       reaches back KEEP_DAYS days (FR-1111). */
    useEffect(function () {
      var cancelled = false;
      setLoading(true);
      var cfg = RES[resKey];
      archive.ready().then(function (st) {
        var useArchive = !!(st.available && st.siteId);
        var now = Math.floor(Date.now() / 1000);
        var winFrom = now - ARCHIVE_SPAN[resKey];
        return Promise.all([
          useArchive
            ? archive.range(st.siteId, winFrom, now).catch(function () { return null; })
            : api.getEnergy('15m', cfg.count).catch(function () { return null; }),
          api.getMeta().catch(function () { return null; }),
          api.getProductions().catch(function () { return null; })
        ]).then(function (res) {
          if (cancelled) return;
          var energy = res[0];
          var meta = res[1];
          var prods = res[2];
          if (energy === null) {
            setData({ records: null, tariffs: {}, producer: false,
                      err: true, archived: false, coverage: null,
                      blocked: st.available === false });
            setLoading(false);
            return;
          }
          var tariffs = (meta && meta.tariffs) || {};
          var producer = Array.isArray(prods) && prods.some(function (p) {
            return p && p.productionType === 'PHOTOVOLTAIC';
          });
          setData({ records: energy, tariffs: tariffs, producer: producer,
                    err: false, archived: useArchive,
                    coverage: st.coverage || null,
                    blocked: st.available === false });
          setLoading(false);
        });
      });
      return function () { cancelled = true; };
    }, [resKey]);

    /* spec 009 FR-909: the HT/NT split needs a 15-min base (window boundaries
       align with 15-min slots by construction) — which is now the only base
       there is. Pre-split each record so aggregate() carries grid_ht_wh/
       grid_nt_wh up to coarser buckets; no-op for flat tariffs. */
    var htnt = agg.hasHtNt(data.tariffs);

    /* Aggregate + sort newest-first. */
    var rows = useMemo(function () {
      if (!data.records) return [];
      var base = data.records;
      if (htnt) {
        base = data.records.map(function (r) { return agg.splitHtNt(r, data.tariffs); });
      }
      var out = agg.aggregate(base, '15m', RES[resKey].target, data.tariffs);
      /* newest-first for display */
      return out.slice().sort(function (a, b) { return b.ts - a.ts; });
    }, [data.records, data.tariffs, resKey, htnt]);

    /* peak indices on the raw 15-min range (only meaningful at 15m view). */
    var peakTs = useMemo(function () {
      if (resKey !== '15m' || !data.records) return {};
      var derived = agg.aggregate(data.records, '15m', '15m', data.tariffs);
      var idx = agg.peaks(derived, 3);
      var map = {};
      idx.forEach(function (i) { map[derived[i].ts] = true; });
      return map;
    }, [data.records, data.tariffs, resKey]);

    var hasFeedin = rows.some(function (r) { return (r.exp_wh || 0) > 0; });
    var hasBattery = rows.some(function (r) { return r.bat_chg_wh != null || r.bat_dis_wh != null; });
    var columns = buildColumns(data.producer, hasFeedin, htnt, hasBattery);

    /* spec 008 KPI opts: CO₂ factor from tariffs (default 128, 0 hides). */
    var co2Factor = (data.tariffs.co2_g_kwh === undefined || data.tariffs.co2_g_kwh === null || data.tariffs.co2_g_kwh === '')
      ? 128 : Number(data.tariffs.co2_g_kwh);
    var kpiOpts = { tariffs: data.tariffs, co2: co2Factor };
    var showSaving = (Number(data.tariffs.grid_import_chf_kwh) > 0) || (Number(data.tariffs.grid_feedin_chf_kwh) > 0);

    /* per-row derived KPIs (UC-803 table/CSV columns), keyed by row ts */
    var rowKpis = useMemo(function () {
      var m = {};
      rows.forEach(function (r) { m[r.ts] = insights.kpis([r], kpiOpts); });
      return m;
    }, [rows, data.tariffs, co2Factor]);

    /* one KPI set over the whole visible selection (FR-803) */
    var kpiSummary = useMemo(function () {
      return insights.kpis(rows, kpiOpts);
    }, [rows, data.tariffs, co2Factor]);

    /* Where the visible history ends (FR-403). With the archive that is the
       oldest archived slot; without one it is the far edge of the device
       buffer, reached whenever it came back full. */
    var coversFullRange = data.archived
      ? !(data.coverage && data.coverage.firstE15Ts !== null &&
          data.coverage.firstE15Ts > Math.floor(Date.now() / 1000) - ARCHIVE_SPAN[resKey])
      : (data.records ? data.records.length < RES[resKey].count : true);
    var items = withSeparators(rows, resKey, coversFullRange);

    /* Pagination over display items (rows + separators counted). */
    var total = rows.length;
    var dataItems = items.filter(function (it) { return it.kind === 'row'; });
    var pages = Math.max(1, Math.ceil(total / pageSize));
    var cur = Math.min(page, pages - 1);
    var fromRow = cur * pageSize;
    var toRow = Math.min(fromRow + pageSize, total);
    /* slice display items so that exactly `pageSize` data rows show, keeping
       any separators that fall between them. */
    var visible = sliceItems(items, fromRow, toRow);

    function onRes(v) { setResKey(v); setPage(0); }
    function onSize(v) { setPageSize(+v); setPage(0); }

    /* ---- CSV export (FR-403): all rows, i18n+unit header, skip gaps ---- */
    function exportCsv() {
      var header = columns.map(function (c) {
        return c.label + (c.unit ? ' ' + c.unit : '');
      });
      var body = rows.map(function (r) { return rowToCsv(r, columns, resKey, rowKpis[r.ts]); });
      var text = csv.build(header, body);
      download(csv.filename(resKey), text);
    }

    /* ---- chart series ---- */
    var chart = useMemo(function () {
      return buildChart(chartWindow(rows, resKey), chartMode, chfMode);
    }, [rows, chartMode, chfMode, resKey]);

    /* ---- summary strip (FR-408) ---- */
    var summary = useMemo(function () {
      return buildSummary(rows, resKey, data.producer);
    }, [rows, resKey, data.producer]);

    var actions = html`
      <div class="verlauf-actions">
        <${ui.Select} label=${t('history.resolution')} value=${resKey}
          onChange=${onRes}
          options=${RES_ORDER.map(function (k) { return { value: k, label: t(RES[k].label) }; })} />
        <${ui.Button} secondary onClick=${exportCsv} disabled=${total === 0}>
          ${t('history.export')}<//>
      </div>`;

    return html`
      <div>
        <${ui.PageHeader} title=${t('page.history')} subtitle=${t('history.subtitle')}
          actions=${actions} />

        ${data.blocked ? html`
          <div class="banner banner-warn">${t('banner.archive', { days: DEV_CAP / 96 })}</div>` : null}

        ${data.archived ? html`<${ArchiveNote} coverage=${data.coverage}
          span=${ARCHIVE_SPAN[resKey]} />` : null}

        ${data.err ? html`
          <${ui.Card}><p class="placeholder-text">${t('common.nodata')}</p><//>` : null}

        ${!data.err && loading ? html`
          <${ui.Card}><p class="placeholder-text">${t('common.loading')}</p><//>` : null}

        ${!data.err && !loading ? html`
          <div>
            ${rows.length ? html`<${SummaryStrip} summary=${summary} kpis=${kpiSummary} showSaving=${showSaving} />` : null}

            <${ui.Card} group="grid" title=${t('history.chart.title')}>
              <div class="chart-toolbar">
                <div class="seg-toggle" role="tablist" aria-label=${t('history.chart.mode')}>
                  ${[['net', 'history.chart.mode_net'], ['bilanz', 'history.chart.mode_bilanz']].map(function (m) {
                    return html`<button key=${m[0]} type="button" role="tab"
                      class=${'seg-btn' + (chartMode === m[0] ? ' seg-btn-active' : '')}
                      aria-selected=${chartMode === m[0]}
                      onClick=${function () { setChartMode(m[0]); }}>${t(m[1])}</button>`;
                  })}
                </div>
                ${chartMode === 'net' ? html`
                  <label class="chf-toggle">
                    <input type="checkbox" checked=${chfMode}
                      onChange=${function (e) { setChfMode(e.target.checked); }} />
                    <span>${t('history.chart.onlychf')}</span>
                  </label>` : null}
              </div>
              ${chart.points.length ? html`
                <${ui.BarChart} height=${220}
                  yUnit=${chart.yUnit} xUnit=${t('history.chart.xunit')}
                  yFormat=${chart.yFormat}
                  signedMagnitude=${chart.signedMagnitude}
                  xTickFormat=${function (ts) { return chartTick(resKey, ts); }}
                  points=${chart.points} />
                <div class="chart-legend">
                  ${chart.legend.map(function (l, i) {
                    return html`<span key=${i} class="legend-item"><span class="legend-swatch" style=${'background:' + l.color}></span>${l.label}</span>`;
                  })}
                </div>` : html`<p class="placeholder-text">${t('common.nodata')}</p>`}
            <//>

            <${ui.Card} title=${t('history.table.title')}
              collapsible collapseKey="verlauf.table">
              <div class="table-wrap">
                <table class="table verlauf-table">
                  <thead>
                    <tr>
                      ${columns.map(function (c) {
                        return html`<th key=${c.key} class=${c.align === 'right' ? 'ta-r' : ''}>
                          ${c.label}${c.unit ? html`<span class="th-unit"> ${c.unit}</span>` : null}
                        </th>`;
                      })}
                    </tr>
                  </thead>
                  <tbody>
                    ${total === 0 ? html`
                      <tr><td class="table-empty" colspan=${columns.length}>${t('common.nodata')}</td></tr>` :
                      visible.map(function (it) { return renderItem(it, columns, resKey, peakTs, rowKpis); })}
                  </tbody>
                </table>

                <div class="table-footer">
                  <label class="table-pagesize">
                    <span>${t('table.perpage')}</span>
                    <span class="select-wrap select-wrap-small">
                      <select class="select select-small" value=${pageSize}
                        onChange=${function (e) { onSize(e.target.value); }}>
                        ${PAGE_SIZES.map(function (n) { return html`<option key=${n} value=${n}>${n}</option>`; })}
                      </select>
                      <svg class="select-caret" viewBox="0 0 12 8" aria-hidden="true"><path d="M1 1.5 6 6.5 11 1.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
                    </span>
                  </label>
                  <span class="table-pageinfo">
                    ${t('table.pageinfo', { from: total === 0 ? 0 : fromRow + 1, to: toRow, total: total })}
                  </span>
                  <span class="table-nav">
                    <button class="table-navbtn" aria-label=${t('table.prev')}
                      disabled=${cur === 0} onClick=${function () { setPage(cur - 1); }}>
                      <svg viewBox="0 0 8 12" aria-hidden="true"><path d="M6.5 1 1.5 6l5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
                    </button>
                    <button class="table-navbtn" aria-label=${t('table.next')}
                      disabled=${cur >= pages - 1} onClick=${function () { setPage(cur + 1); }}>
                      <svg viewBox="0 0 8 12" aria-hidden="true"><path d="M1.5 1l5 5-5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
                    </button>
                  </span>
                </div>
              </div>
              <p class="table-note">${t('history.tariff_note')}</p>
            <//>
          </div>` : null}
      </div>`;
  }

  /* ---- helpers below are pure-ish (build DOM only where noted) ---- */

  /* slice the display-item list so that data rows [fromRow, toRow) are shown,
     keeping boundary/gap separators that sit between shown rows. */
  function sliceItems(items, fromRow, toRow) {
    var out = [];
    var rowIdx = -1;
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (it.kind === 'row') {
        rowIdx++;
        if (rowIdx >= toRow) break;
        if (rowIdx >= fromRow) out.push(it);
      } else if (rowIdx >= fromRow && rowIdx < toRow) {
        /* separator follows the data row at rowIdx (the boundary/gap after the
           last shown row still renders, incl. the trailing boundary). */
        out.push(it);
      }
    }
    return out;
  }

  function renderItem(it, columns, resKey, peakTs, rowKpis) {
    if (it.kind === 'boundary') {
      return html`<tr key=${it.key} class="verlauf-boundary">
        <td colspan=${columns.length}>${t('history.boundary_finer_end')}</td></tr>`;
    }
    if (it.kind === 'gap') {
      return html`<tr key=${it.key} class="verlauf-gap">
        <td colspan=${columns.length}>${t('history.gap')}</td></tr>`;
    }
    var r = it.rec;
    var isPeak = !!peakTs[r.ts];
    var k = (rowKpis && rowKpis[r.ts]) || null;
    return html`
      <tr key=${'r' + r.ts}>
        ${columns.map(function (c) {
          return html`<td key=${c.key} class=${c.align === 'right' ? 'ta-r' : ''}>
            ${cellContent(c.key, r, resKey, isPeak, k)}
          </td>`;
        })}
      </tr>`;
  }

  function cellContent(key, r, resKey, isPeak, k) {
    switch (key) {
      case 'ts':
        return html`<span class="verlauf-ts">
          ${fmt.time(r.ts, RES[resKey].tk)}
          ${isPeak ? html`<span class="peak-mark" title=${t('tooltip.peakload')}><svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M1 9.5H4.3L6 3l1.7 6.5H11" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></span>` : null}
          ${r.partial ? html`<${ui.Tooltip} text=${t('history.partial')} />` : null}
        </span>`;
      case 'imp': return numCell(r.imp_wh);
      case 'impcost': return chfPlain(r.cost_import_chf, 'val-neg');
      case 'impcost_ht': return chfPlain(r.cost_import_ht_chf, 'val-neg');
      case 'impcost_nt': return chfPlain(r.cost_import_nt_chf, 'val-neg');
      case 'exp': return numCell(r.exp_wh);
      case 'batchg': return numCell(r.bat_chg_wh);
      case 'batdis': return numCell(r.bat_dis_wh);
      case 'saving': return chfPlain(r.saving_selfuse_chf, r.saving_selfuse_chf > 0 ? 'val-pos' : '');
      case 'autarky': return pctCell(k && k.autarky);
      case 'selfuserate': return pctCell(k && k.selfuse);
      case 'ersparnis': return chfPlain(k && k.savingChf, (k && k.savingChf > 0) ? 'val-pos' : '');
      default: return '';
    }
  }

  function rowToCsv(r, columns, resKey, k) {
    return columns.map(function (c) {
      switch (c.key) {
        case 'ts': return fmt.time(r.ts, RES[resKey].tk);
        case 'imp': return csvNum(r.imp_wh);
        case 'impcost': return csvChf(r.cost_import_chf);
        case 'impcost_ht': return csvChf(r.cost_import_ht_chf);
        case 'impcost_nt': return csvChf(r.cost_import_nt_chf);
        case 'exp': return csvNum(r.exp_wh);
        case 'batchg': return csvNum(r.bat_chg_wh);
        case 'batdis': return csvNum(r.bat_dis_wh);
        case 'saving': return csvChf(r.saving_selfuse_chf);
        case 'autarky': return csvPct(k && k.autarky);
        case 'selfuserate': return csvPct(k && k.selfuse);
        case 'ersparnis': return csvChf(k && k.savingChf);
        default: return '';
      }
    });
  }

  /* CSV percent: integer-point number 0..100, no unit (unit is in the header). */
  function csvPct(ratio) {
    if (ratio === null || ratio === undefined) return '';
    return (ratio * 100).toFixed(0);
  }

  /* CSV numbers: decimal point, no thousands separators, no units. */
  function csvNum(wh) {
    if (wh === null || wh === undefined) return '';
    return (wh / 1000).toFixed(2);
  }
  function csvChf(v) {
    if (v === null || v === undefined) return '';
    return Number(v).toFixed(2);
  }

  /* Compact per-resolution x-axis tick label. Decoupled from the table's `tk`
     token: intraday views show just the time (HH:MM) instead of the full
     datetime (which overflowed the axis), day/week show a year-less DD.MM. */
  function chartTick(resKey, ts) {
    switch (resKey) {
      case '15m':
      case '1h': return fmt.time(ts, 'hm');
      case '1d':
      case '1w': return fmt.time(ts, 'dm');
      case '1mo': return fmt.time(ts, '1mo');
      case '1q': return fmt.time(ts, 'q');
      default: return fmt.time(ts, RES[resKey].tk);
    }
  }

  /* ---- chart data ----
     One point per row; <BarChart> spaces bars ordinally (evenly by index, not
     by timestamp), so gaps/outliers can't skew the layout.

     Sign convention (issue #17, app-wide): what the site GIVES sits above the
     0-axis (Einspeisung, green; CHF credit), what it TAKES sits
     below it (Netzbezug, red; CHF cost). The Netz-kWh mode used to draw
     Netzbezug upward, which read the opposite way round from the Bilanz mode
     and from the CHF saldo — all three now agree. */
  function buildChart(rows, chartMode, chfMode) {
    var chron = rows.slice().sort(function (a, b) { return a.ts - b.ts; });
    var num2 = function (v) { return fmt.num(v, 2); };
    var toK = function (wh) { return (wh === null || wh === undefined) ? 0 : wh / 1000; };

    /* Bilanz (UC-803, reworked by issue #17): ONE signed stack per period.
       Above the 0-axis the production splits into «selbst verbraucht» +
       «eingespeist»; below it sits the grid import. The old layout drew two
       side-by-side stacks, and since prodSelf === consSelf the self-use share
       appeared as two identical yellow bars per slot, which read as double
       counting. Now self-use is drawn once: up-stack = PV production,
       |down-stack| + self-use = consumption. */
    if (chartMode === 'bilanz') {
      var COL_SELF = 'var(--c-production)';   /* selbst verbraucht / gedeckt */
      var COL_FEED = 'var(--c-export)';       /* eingespeist */
      var COL_IMP = 'var(--c-import)';        /* Netzbezug */
      var bpoints = chron.map(function (r) {
        if (r.__blank) return { t: r.ts, y: null }; /* missing slot → blank */
        /* A present slot is real data: coalesce absent Wh fields to 0 so
           insights.balance() doesn't treat it as a hole (isHole → all-null →
           zero-height bars). A producer that never feeds the grid has
           exp_wh === null, which otherwise blanked the whole Bilanz chart. */
        var b = insights.balance([{
          pv_wh: r.pv_wh || 0, exp_wh: r.exp_wh || 0, imp_wh: r.imp_wh || 0
        }]);
        return { t: r.ts, bars: [
          { segments: [
            { value: toK(b.prodSelf), color: COL_SELF, label: t('history.bilanz.selfuse') },
            { value: toK(b.prodFeedin), color: COL_FEED, label: t('history.bilanz.feedin') },
            { value: -toK(b.consImport), color: COL_IMP, label: t('history.bilanz.import') }
          ] }
        ] };
      });
      return {
        points: bpoints, yUnit: 'kWh', yFormat: num2,
        signedMagnitude: true,
        legend: [
          { color: COL_SELF, label: t('history.bilanz.selfuse') },
          { color: COL_FEED, label: t('history.bilanz.feedin') },
          { color: COL_IMP, label: t('history.bilanz.import') }
        ]
      };
    }

    /* Netz mode (spec 004, unchanged behaviour) */
    var points;
    if (chfMode) {
      points = chron.map(function (r) {
        if (r.__blank) return { t: r.ts, y: null }; /* missing slot → blank */
        var sld = rowGridSaldo(r);
        return { t: r.ts, y: sld === null ? null : sld, color: (sld || 0) < 0 ? 'var(--c-import)' : 'var(--c-export)' };
      });
    } else {
      points = chron.map(function (r) {
        if (r.__blank) return { t: r.ts, y: null }; /* missing slot → blank */
        var imp = r.imp_wh === null || r.imp_wh === undefined ? null : r.imp_wh / 1000;
        if (imp && imp > 0) {
          return { t: r.ts, y: -imp, color: 'var(--c-import)',
                   label: t('history.chart.legend_import') };
        }
        var ex = r.exp_wh;
        var exk = ex === null || ex === undefined ? null : ex / 1000;
        if (exk && exk > 0) {
          return { t: r.ts, y: exk, color: 'var(--c-export)',
                   label: t('history.chart.legend_export') };
        }
        return { t: r.ts, y: imp === null ? null : 0, color: 'var(--c-import)',
                 label: t('history.chart.legend_import') };
      });
    }
    return {
      points: points,
      yUnit: chfMode ? 'CHF' : 'kWh',
      yFormat: chfMode ? function (v) { return fmt.chf(v, true); } : num2,
      /* kWh: the bar sign is a direction, so the tooltip shows the magnitude
         next to the point's own label. CHF: the sign IS the value (a negative
         saldo is money owed), so it stays signed. */
      signedMagnitude: !chfMode,
      legend: chfMode ? [
        { color: 'var(--c-export)', label: t('history.chart.legend_saldo') },
        { color: 'var(--c-import)', label: t('history.chart.legend_import') }
      ] : [
        { color: 'var(--c-export)', label: t('history.chart.legend_export') },
        { color: 'var(--c-import)', label: t('history.chart.legend_import') }
      ]
    };
  }

  /* ---- summary (FR-408 + spec 008 UC-803) ----
     Returns { periodLabel, unit, metrics:[{name, avg, trend, yoy}] }. Daily
     view with ≥ 8 days → avg/trend; monthly with ≥ 13 → yoy. The trend/Vorjahr
     comparison now covers PV-Produktion as well as Netzbezug (008 UC-803). */
  function buildSummary(rows, resKey, producer) {
    var daily = resKey === '1d' && rows.length >= 8;
    var monthly = resKey === '1mo' && rows.length >= 8;
    if (!daily && !monthly) return null;

    var chron = rows.slice().sort(function (a, b) { return a.ts - b.ts; });
    var ser = function (field) {
      return chron.map(function (r) {
        return (r[field] === null || r[field] === undefined) ? null : r[field] / 1000;
      });
    };
    var wantYoy = monthly && rows.length >= 13;
    var mk = function (name, field) {
      var s = ser(field);
      return { name: name, avg: agg.avg(s), trend: agg.trend(s), yoy: wantYoy ? agg.yoy(s) : null };
    };

    var metrics = [mk(t('history.col.gridimport'), 'imp_wh')];
    if (producer) metrics.push(mk(t('history.summary.pv'), 'pv_wh'));
    return {
      periodLabel: t(daily ? 'history.summary.avg_day' : 'history.summary.avg_month'),
      unit: 'kWh',
      metrics: metrics
    };
  }

  function trendCell(name, trend) {
    var arrow = trend.dir === 'up' ? '▲' : trend.dir === 'down' ? '▼' : '▬';
    var cls = trend.dir === 'up' ? 'trend-up' : trend.dir === 'down' ? 'trend-down' : '';
    return html`
      <div class="summary-cell">
        <span class="summary-label">${t('history.summary.trend')} · ${name}</span>
        <span class=${'summary-value ' + cls}>
          ${arrow} ${trend.pct === null ? '–' : fmt.num(Math.abs(trend.pct), 0) + ' %'}
        </span>
      </div>`;
  }

  /* Summary strip: spec 008 KPI cells (Autarkie / Eigenverbrauch / Ersparnis
     for the visible selection) followed by the spec 004 avg/trend/Vorjahr
     cells when the resolution qualifies. */
  function SummaryStrip(props) {
    var s = props.summary;
    var k = props.kpis;
    function pct(v) { return (v === null || v === undefined) ? '–' : fmt.num(v * 100, 0) + ' %'; }
    return html`
      <div class="summary-strip">
        ${k ? html`
          <div class="summary-cell">
            <span class="summary-label">${t('kpi.autarky')}</span>
            <span class="summary-value">${k.incomplete ? '–' : pct(k.autarky)}</span>
          </div>
          <div class="summary-cell">
            <span class="summary-label">${t('kpi.selfuse')}</span>
            <span class="summary-value">${k.incomplete ? '–' : pct(k.selfuse)}</span>
          </div>
          ${props.showSaving ? html`
            <div class="summary-cell">
              <span class="summary-label">${t('kpi.saving')}</span>
              <span class="summary-value val-pos">${(k.incomplete || k.savingChf === null) ? '–' : fmt.chf(k.savingChf, false)}</span>
            </div>` : null}` : null}

        ${s ? s.metrics.map(function (m, i) {
          return html`
            <div key=${'a' + i} class="summary-cell">
              <span class="summary-label">${m.name} · ${s.periodLabel}</span>
              <span class="summary-value">${m.avg === null ? '–' : fmt.num(m.avg, 2) + ' ' + s.unit}</span>
            </div>
            ${trendCell(m.name, m.trend)}
            ${m.yoy !== null && m.yoy !== undefined ? html`
              <div key=${'y' + i} class="summary-cell">
                <span class="summary-label">${t('history.summary.yoy')} · ${m.name}</span>
                <span class=${'summary-value ' + (m.yoy > 0 ? 'trend-up' : m.yoy < 0 ? 'trend-down' : '')}>
                  ${(m.yoy > 0 ? '+' : '') + fmt.num(m.yoy, 0)} %
                </span>
              </div>` : null}`;
        }) : null}
      </div>`;
  }

  /* trigger a client-side file download of `text` as `name` (UTF-8). */
  function download(name, text) {
    var blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 0);
  }

export { Verlauf, chartWindow, prevSlot, CHART_SLOTS, buildChart };
