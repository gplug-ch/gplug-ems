/* Abrechnung — quarterly vZEV settlement page (spec 005 FR-512, UC-504/505).
   Route #/vzev/abrechnung. A quarter <Select> (current + past 18 months) drives
   api.getVzevBilling(q), which computes the settlement in the browser from the
   device's raw rings (/api/vzev/raw). Producer devices see a Total card plus one
   card per consumer member; consumer devices see a single card priced at the
   vZEV tariff with the saving vs. the grid tariff shown. Every card carries a
   kWh value (yellow), a CHF value (green) and a BarChart of the quarter's
   monthly values with labeled axes.

   Privacy (UC-505): the page only ever shows vZEV-relevant flows — what a member
   received from / delivered to the community — never a peer's total Netzbezug or
   Verbrauch. It renders whatever /api/vzev/billing returns and adds nothing. */
import { html, useState, useEffect } from '../core.js';
import { t } from '../i18n.js';
import { fmt } from '../format.js';
import { api } from '../api.js';
import * as ui from '../ui.js';
import * as csv from '../lib/csv.js';
import { SlotExplain } from './explain.js';
import { capReference, quarterRange } from '../lib/vzev.js';
import * as archive from '../lib/archive.js';

  var YELLOW = 'var(--c-production)';   /* spec 010: gelb now lives on --c-production */
  var GREEN = 'var(--c-vzev)';

  /* quarter completeness % from the quality summary; null when no expectation */
  function completeness(q) {
    if (!q || !q.expected) return null;
    return Math.round(q.complete / q.expected * 100);
  }

  /* a quarter is provisional when < 100% complete (FR-906). */
  function isProvisional(q) {
    var c = completeness(q);
    return c !== null && c < 100;
  }

  /* internal vZEV import tariff for the statement line (HT/NT split is shown as
     energy sub-lines; a single internal price applies to vZEV energy). */
  function internalTariff(tariffs) {
    tariffs = tariffs || {};
    var v = Number(tariffs.vzev_import_chf_kwh);
    return isNaN(v) ? null : v;
  }

  /* ---- Quarter helpers ---- */

  /* "2026-Q2" for a given year/quarter index (1-4) */
  function qLabel(year, q) { return year + '-Q' + q; }

  /* epoch seconds for the first day of a month (local time) */
  function monthTs(year, month0) {
    return Math.floor(new Date(year, month0, 1, 0, 0, 0, 0).getTime() / 1000);
  }

  /* current quarter + the past ones covered by the 18-month monthly ring.
     18 months back spans up to 7 distinct quarters; list is newest-first. */
  function availableQuarters(now) {
    var d = now ? new Date(now * 1000) : new Date();
    var year = d.getFullYear();
    var q = Math.floor(d.getMonth() / 3) + 1; /* current quarter 1-4 */
    var out = [];
    /* current + 6 past quarters (~21 months, comfortably covers 18) */
    for (var i = 0; i < 7; i++) {
      var qi = q - i;
      var yi = year;
      while (qi < 1) { qi += 4; yi -= 1; }
      out.push({ value: qLabel(yi, qi), label: qLabel(yi, qi) });
    }
    return out;
  }

  /* parse "2026-Q2" -> {year, q} or null */
  function parseQuarter(s) {
    var m = /^(\d{4})-Q([1-4])$/.exec(String(s || ''));
    if (!m) return null;
    return { year: parseInt(m[1], 10), q: parseInt(m[2], 10) };
  }

  /* the three month timestamps of a quarter, for a synthetic x-axis when the
     backend omits per-month timestamps */
  function quarterMonthTs(quarter) {
    var p = parseQuarter(quarter);
    if (!p) return [];
    var m0 = (p.q - 1) * 3;
    return [monthTs(p.year, m0), monthTs(p.year, m0 + 1), monthTs(p.year, m0 + 2)];
  }

  /* ---- Chart data ---- */

  /* Build BarChart points from a per-month series. Accepts either
     [{ts, y}] / [{ts, wh}] / [{ts, chf}] or bare numbers; falls back to the
     quarter's three months for the x-axis when timestamps are absent. */
  function seriesPoints(months, quarter, pick, color) {
    var fallbackTs = quarterMonthTs(quarter);
    var arr = Array.isArray(months) ? months : [];
    return arr.map(function (m, i) {
      var y;
      if (m === null || m === undefined) y = 0;
      else if (typeof m === 'number') y = m;
      else y = pick(m);
      var ts = (m && typeof m === 'object' && typeof m.ts === 'number')
        ? m.ts
        : (fallbackTs[i] !== undefined ? fallbackTs[i] : (fallbackTs[0] || 0) + i * 2592000);
      return { t: ts, y: (y === null || y === undefined || isNaN(y)) ? 0 : y, color: color };
    });
  }

  /* pickers tolerant of {y}|{wh}|{kwh}|{chf} shapes */
  function pickWh(m) {
    if (typeof m.wh === 'number') return m.wh / 1000;
    if (typeof m.kwh === 'number') return m.kwh;
    if (typeof m.y === 'number') return m.y;
    return 0;
  }
  function pickChf(m) {
    if (typeof m.chf === 'number') return m.chf;
    if (typeof m.revenue_chf === 'number') return m.revenue_chf;
    if (typeof m.y === 'number') return m.y;
    return 0;
  }

  /* Data-quality line (FR-906): completeness %, provisional/missing counts and
     per-member «fehlt in N Slots» notes. Renders nothing when no quality info. */
  function QualityLine(props) {
    var q = props.quality;
    if (!q || !q.expected) return null;
    var pct = completeness(q);
    var byId = props.byId || {};
    /* members that missed slots -> a plain-language note (UC-902) */
    var misses = [];
    var pm = q.perMember || {};
    for (var id in pm) {
      if (!Object.prototype.hasOwnProperty.call(pm, id)) continue;
      var n = (pm[id].expected || 0) - (pm[id].have || 0);
      if (n > 0) {
        var nm = byId[id] ? (byId[id].name || id) : id;
        misses.push(t('billing.quality.member_missing', { name: nm, n: n }));
      }
    }
    return html`
      <${ui.Card} class="billing-quality">
        <div class="billing-quality-head">
          <h2 class="card-title">${t('billing.quality.title')}
            <${ui.Tooltip} text=${t('tooltip.provisorisch')} /></h2>
          ${isProvisional(q) ? html`<span class="billing-provisional">${t('billing.provisional.badge')}</span>` : null}
        </div>
        <p class="billing-quality-line">${t('billing.quality.complete', { pct: pct })}</p>
        ${q.provisional > 0 ? html`<p class="billing-quality-line">${t('billing.quality.provisional', { n: q.provisional })}</p>` : null}
        ${q.missing > 0 ? html`<p class="billing-quality-line">${t('billing.quality.missing', { n: q.missing })}</p>` : null}
        ${misses.length === 0 && !isProvisional(q) ? html`<p class="billing-quality-line billing-quality-ok">${t('billing.quality.ok')}</p>` : null}
        ${misses.map(function (m, i) { return html`<p key=${i} class="billing-quality-line">${m}</p>`; })}
      <//>`;
  }

  /* Expandable per-member statement detail (FR-907, UC-903): period, member,
     Zählpunkt, vZEV energy × internal tariff = amount (HT/NT sub-lines when
     configured), residual note, disclosed Verteilschlüssel + method label. */
  function StatementDetail(props) {
    var mem = props.member;
    var tariffs = props.tariffs || {};
    var period = props.period; /* [from,to) epoch bounds */
    var tin = internalTariff(tariffs);
    var kwh = typeof mem.wh === 'number' ? mem.wh / 1000 : null;
    /* entry_ts trims the effective period start for this member (edge case). */
    var effFrom = (mem.entry_ts && period && mem.entry_ts > period[0]) ? mem.entry_ts : (period ? period[0] : null);
    var capRef = props.capReference;
    var method = (capRef !== null && capRef !== undefined && tin !== null && tin > capRef)
      ? t('billing.detail.method_effektiv') : t('billing.detail.method_pauschal');
    function line(label, value) {
      return html`<div class="stmt-line"><span class="stmt-key">${label}</span><span class="stmt-val">${value}</span></div>`;
    }
    return html`
      <div class="stmt">
        ${line(t('billing.detail.period'), period
          ? fmt.time(effFrom, '1d') + ' – ' + fmt.time(period[1] - 1, '1d') : '–')}
        ${line(t('billing.detail.member'), (mem.name || mem.id) + (mem.location ? ', ' + mem.location : ''))}
        ${mem.metering_point ? line(html`${t('billing.detail.meteringpoint')} <${ui.Tooltip} text=${t('tooltip.zaehlpunkt')} />`, mem.metering_point) : null}
        ${line(t('billing.detail.energy'), kwh === null ? '–' : fmt.num(kwh, 2) + ' kWh')}
        ${typeof mem.ht_wh === 'number' ? line(t('billing.detail.energy_ht'), fmt.num(mem.ht_wh / 1000, 2) + ' kWh') : null}
        ${typeof mem.nt_wh === 'number' ? line(t('billing.detail.energy_nt'), fmt.num(mem.nt_wh / 1000, 2) + ' kWh') : null}
        ${line(t('billing.detail.tariff'), tin === null ? '–' : fmt.num(tin, 2) + ' CHF/kWh')}
        ${line(t('billing.detail.amount'), typeof mem.chf === 'number' ? fmt.chf(mem.chf) : '–')}
        <p class="stmt-residual">${t('billing.detail.residual')}</p>
        ${line(html`${t('billing.detail.key')} <${ui.Tooltip} text=${t('tooltip.verteilschluessel')} />`, t('billing.detail.key_value'))}
        ${line(t('billing.detail.method'), method)}
      </div>`;
  }

  /* A card body: kWh value, CHF value and a monthly BarChart. `member`/`tariffs`/
     `period`/`raw` (spec 009) enable an expandable statement detail + slot
     drill-down; a `provisional` flag adds the «provisorisch» marker. */
  function BillingCard(props) {
    var kwh = props.wh !== null && props.wh !== undefined ? props.wh / 1000 : null;
    var expSt = useState(false);
    var expanded = expSt[0], setExpanded = expSt[1];
    var drillSt = useState(false);
    var drill = drillSt[0], setDrill = drillSt[1];
    var canExpand = !!props.member;
    return html`
      <${ui.Card} group="vzev" title=${props.title} subtitle=${props.subtitle}>
        ${props.provisional ? html`<span class="billing-provisional">${t('billing.provisional.badge')}</span>` : null}
        <div class="billing-metrics">
          <div class="billing-metric">
            <span class="billing-metric-label">${props.kwhLabel}</span>
            <span class="billing-metric-value" style=${'color:' + YELLOW}>
              ${kwh === null ? '–' : fmt.num(kwh, 2) + ' kWh'}
            </span>
          </div>
          <div class="billing-metric">
            <span class="billing-metric-label">${props.chfLabel}</span>
            <span class="billing-metric-value" style=${'color:' + GREEN}>
              ${props.chf === null || props.chf === undefined ? '–' : fmt.chf(props.chf)}
            </span>
          </div>
        </div>
        ${props.note ? html`<p class="billing-card-note">${props.note}</p>` : null}
        <${ui.BarChart} height=${180} yUnit="kWh" xUnit=${t('billing.axis.month')}
          xTickFormat=${function (ts) { return fmt.time(ts, '1mo'); }}
          yFormat=${function (v) { return fmt.num(v, 1) + ' kWh'; }}
          points=${props.points} />
        ${canExpand ? html`
          <div class="billing-card-actions no-print">
            <${ui.Button} small secondary onClick=${function () { setExpanded(!expanded); }}>
              ${t(expanded ? 'billing.member.collapse' : 'billing.member.expand')}
            <//>
            ${props.raw ? html`
              <${ui.Button} small secondary onClick=${function () { setDrill(!drill); }}>
                ${t('explain.open')}
              <//>` : null}
          </div>` : null}
        ${canExpand && expanded ? html`
          <${StatementDetail} member=${props.member} tariffs=${props.tariffs}
            period=${props.period} capReference=${props.capReference} />` : null}
        ${canExpand && drill && props.raw ? html`
          <${SlotExplain} raw=${props.raw} memberId=${props.member.id}
            range=${props.period} onClose=${function () { setDrill(false); }} />` : null}
      <//>`;
  }

  /* Producer layout: Total card + one card per consumer member (Figma 40:882). */
  function ProducerView(props) {
    var data = props.data;
    var quarter = props.quarter;
    var total = data.total || {};
    var totalPts = seriesPoints(total.months, quarter, pickWh, YELLOW);
    var members = Array.isArray(data.members) ? data.members : [];

    return html`
      <div class="billing-grid">
        <${BillingCard}
          title=${t('billing.total.title')}
          subtitle=${quarter}
          kwhLabel=${t('billing.producer.energy')}
          chfLabel=${t('billing.producer.profit')}
          wh=${typeof total.exp_wh === 'number' ? total.exp_wh : null}
          chf=${typeof total.revenue_chf === 'number' ? total.revenue_chf : null}
          points=${totalPts} />
        ${members.map(function (mem) {
          return html`
            <${BillingCard} key=${mem.id}
              title=${mem.name || mem.id}
              kwhLabel=${t('billing.producer.energy')}
              chfLabel=${t('billing.producer.profit')}
              wh=${typeof mem.wh === 'number' ? mem.wh : null}
              chf=${typeof mem.chf === 'number' ? mem.chf : null}
              points=${seriesPoints(mem.months, quarter, pickWh, YELLOW)}
              member=${mem} tariffs=${data.tariffs} period=${data.range}
              raw=${data.raw} capReference=${props.capReference}
              provisional=${props.provisional} />`;
        })}
      </div>`;
  }

  /* Statement header (FR-907): site + Vertreter/Netzanschlusspunkt block, shown
     above the cards and repeated on the print view. */
  function StatementHeader(props) {
    var info = props.info || {};
    var rep = info.representative_name;
    var cp = info.connection_point_id;
    if (!rep && !cp) return null;
    return html`
      <${ui.Card} class="billing-header-card">
        ${rep ? html`<p class="billing-hdr-line"><span class="billing-hdr-key">${t('billing.rep')}</span> ${rep}${info.representative_contact ? ' · ' + info.representative_contact : ''}</p>` : null}
        ${cp ? html`<p class="billing-hdr-line"><span class="billing-hdr-key">${t('billing.connpoint')}</span> ${cp}</p>` : null}
      <//>`;
  }

  /* CSV export (FR-907): one row per billed member with the new HT/NT + quality
     columns. Uses the shared csv builder; downloads client-side. */
  function exportBillingCsv(data, quarter) {
    var members = Array.isArray(data.members) ? data.members : (data.self ? [data.self] : []);
    var prov = isProvisional(data.quality);
    var header = [
      t('billing.detail.member'), t('billing.detail.meteringpoint'),
      t('billing.detail.energy') + ' [kWh]', t('billing.detail.energy_ht') + ' [kWh]',
      t('billing.detail.energy_nt') + ' [kWh]', t('billing.detail.amount') + ' [CHF]',
      t('billing.provisional.badge')
    ];
    var rows = members.map(function (m) {
      return [
        m.name || m.id,
        m.metering_point || '',
        typeof m.wh === 'number' ? (m.wh / 1000).toFixed(2) : '',
        typeof m.ht_wh === 'number' ? (m.ht_wh / 1000).toFixed(2) : '',
        typeof m.nt_wh === 'number' ? (m.nt_wh / 1000).toFixed(2) : '',
        typeof m.chf === 'number' ? m.chf.toFixed(2) : '',
        prov ? '1' : '0'
      ];
    });
    var text = csv.build(header, rows);
    var blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = 'gplug-abrechnung-' + quarter + '.csv';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 0);
  }

  /* ---- Page ---- */
  function Abrechnung() {
    var quarters = availableQuarters();
    var qSt = useState(quarters.length ? quarters[0].value : '');
    var quarter = qSt[0], setQuarter = qSt[1];

    var dataSt = useState(null);
    var data = dataSt[0], setData = dataSt[1];
    var statusSt = useState('loading'); /* loading | ready | empty | error */
    var status = statusSt[0], setStatus = statusSt[1];

    useEffect(function () {
      var cancelled = false;
      setStatus('loading');
      /* spec 011 UC-1102: settle over the archived quarter when the browser
         has one; otherwise over the device's short buffer, as before. */
      archive.ready().then(function (st) {
        var rng = quarterRange(quarter);
        if (!st.available || !st.siteId || !rng) return null;
        return archive.rawRange(st.siteId, rng[0], rng[1] - 1).then(function (r) {
          /* usable only with a producer id and at least one member's slots —
             otherwise fall back to the device's live rings */
          var ids = r && r.data ? Object.keys(r.data) : [];
          return (r && r.producer_id && ids.length) ? r : null;
        }, function () { return null; });
      }).then(function (archivedRaw) {
        if (cancelled) return;
        return api.getVzevBilling(quarter, archivedRaw)
        .then(function (d) {
          if (cancelled) return;
          if (!d || typeof d !== 'object') { setData(null); setStatus('empty'); return; }
          setData(d);
          setStatus('ready');
        })
        .catch(function () {
          if (cancelled) return;
          setData(null);
          setStatus('error');
        });
      });
      return function () { cancelled = true; };
    }, [quarter]);

    /* Producer vs. consumer detection from the billing response.
       Prefer an explicit role (FR-507); only fall back to the payload shape
       when it is absent. A consumer's own settlement carries self/import/
       grid-comparison fields and must never be misread as a producer just
       because the canonical shape also has `total`/`members`. */
    function isProducer(d) {
      if (!d) return false;
      var role = String(d.role || d.type || '').toUpperCase();
      if (role === 'PRODUCER' || role === 'P') return true;
      if (role === 'CONSUMER' || role === 'C') return false;
      /* explicit consumer-only fields win over shape heuristics */
      var self = d.self || {};
      if (d.self || typeof self.cost_grid_chf === 'number' ||
          typeof d.cost_grid_chf === 'number' || typeof d.import_wh === 'number') {
        return false;
      }
      /* otherwise the producer layout (Total + per-member cards) is signalled
         by a `total` block or a non-empty peer member list */
      return !!(d.total || (Array.isArray(d.members) && d.members.length));
    }

    var capRef = (data && data.tariffs) ? capReference(data.tariffs) : null;
    var prov = data ? isProvisional(data.quality) : false;
    var byId = {};
    if (data && Array.isArray(data.members)) {
      data.members.forEach(function (m) { if (m && m.id !== undefined) byId[m.id] = m; });
    }

    /* Abrechnung is producer-only: the billing (allocation → CHF over the whole
       community) is authored on the producer device and distributed as the
       quarterly statement. A consumer device never renders the settlement — it
       only knows its own share — so it shows a pointer to the statement instead
       of a second, partial computation. */
    var producerRole = !!data && isProducer(data);

    var body;
    if (status === 'loading') {
      body = html`<${ui.Card}><p class="placeholder-text">${t('common.loading')}</p><//>`;
    } else if (status === 'error') {
      body = html`<${ui.Card}><p class="placeholder-text">${t('billing.error')}</p><//>`;
    } else if (status === 'empty' || !data) {
      body = html`<${ui.Card}><p class="placeholder-text">${t('common.nodata')}</p><//>`;
    } else if (producerRole) {
      body = html`<${ProducerView} data=${data} quarter=${quarter}
        capReference=${capRef} provisional=${prov} />`;
    } else {
      body = html`<${ui.Card}><p class="placeholder-text">${t('billing.producer_only')}</p><//>`;
    }

    /* the settlement chrome (statement header, quality line, export/print) only
       makes sense for the producer's full billing view */
    var ready = status === 'ready' && producerRole;
    var actions = html`
      <div class="billing-actions">
        <${ui.Select} label=${t('billing.quarter')} value=${quarter}
          options=${quarters}
          onChange=${function (v) { setQuarter(v); }} />
        ${ready ? html`
          <${ui.Button} secondary small onClick=${function () { exportBillingCsv(data, quarter); }}>${t('billing.export')}<//>
          <${ui.Button} secondary small onClick=${function () { window.print(); }}>${t('billing.print')}<//>` : null}
      </div>`;

    return html`
      <div class="billing-page">
        <${ui.PageHeader} title=${t('page.billing')} subtitle=${t('billing.subtitle')}
          actions=${actions} />
        ${ready ? html`<${StatementHeader} info=${data.info} />` : null}
        ${body}
        ${ready ? html`<${QualityLine} quality=${data.quality} byId=${byId} />` : null}
        <${ui.Card} class="billing-note-card">
          <p class="billing-note">${t('billing.note')}</p>
        <//>
      </div>`;
  }

export { Abrechnung };
