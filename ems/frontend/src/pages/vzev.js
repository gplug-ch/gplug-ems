/* vZEV community graph (spec 005 FR-510, UC-501/502/505).
   Member cards (house icon, amber outline, name pill); own site centred with a
   navy «Netz» node below. Arrows show current 15-min flow direction: green from
   the producer, navy from the grid. Pencil icon → member form; discovery list
   («+ vZEV Mitglied hinzufügen») and «Abrechnung ›» in the header. Degrades to a
   vertical list with direction chips below 768 px.

   Privacy (UC-505): only vZEV flows are shown — never a peer's total
   Netzbezug/Verbrauch. */
import { html, useState, useEffect, useRef } from '../core.js';
import { t } from '../i18n.js';
import { fmt } from '../format.js';
import { api } from '../api.js';
import { router } from '../router.js';
import { toast } from '../components.js';
import * as ui from '../ui.js';
import * as vzevLib from '../lib/vzev.js';
import { SlotExplain } from './explain.js';

/* spec 009 FR-908: «So funktioniert die Zuteilung» info box — dismissal is
   persisted for the app session (module scope, like verlauf.js `prefs` / the
   003 hints), so it does not reappear on every navigation but resets on
   reload. */
var infoDismissed = false;

/* no-data badge threshold (FR-906): a member that has delivered nothing for
   more than 2 h gets the «keine Daten seit HH:MM» warning. */
var NODATA_SECONDS = 2 * 3600;

var houseIcon = html`<svg viewBox="0 0 24 24" class="vz-house" aria-hidden="true"><path d="M3 11 12 3l9 8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M5 10v9h14v-9" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><rect x="10" y="13" width="4" height="6" fill="currentColor"/></svg>`;
  var pencilIcon = html`<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M13.5 3.5l3 3L7 16l-3.6.6.6-3.6z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  var plusIcon = html`<svg viewBox="0 0 20 20" class="vz-plus" aria-hidden="true"><path d="M10 4v12M4 10h12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;
  var gridIcon = html`<svg viewBox="0 0 24 24" class="vz-grid-ico" aria-hidden="true"><path d="M6 3v18M18 3v18M6 8h12M6 14h12M3 6l3 2 3-2M15 6l3 2 3-2M3 16l3 2 3-2M15 16l3 2 3-2" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

  function isProducer(m) {
    return m && (m.type === 'PRODUCER' || m.typ === 'P');
  }

  /* Build a { site-id -> allocated Wh } map from the newest /api/vzev/flows
     slot; graceful when flows is empty/malformed. */
  function latestFlows(flows) {
    if (!flows || !flows.length) return {};
    var last = flows[flows.length - 1];
    return (last && last.members) || {};
  }

  /* A member card: house icon, amber outline, name pill, edit pencil.
     `noData` (spec 009 FR-906): {lastTs} | null — when set renders a warning
     badge «keine Daten seit HH:MM» (or «noch keine Daten» when lastTs is null). */
  function MemberCard(props) {
    var m = props.member;
    var name = m.name || m.id;
    var nd = props.noData;
    return html`
      <div class=${'vz-card' + (props.own ? ' vz-card-own' : '') + (props.producer ? ' vz-card-producer' : '')}>
        <button class="vz-edit" aria-label=${t('vzev.edit')}
          onClick=${function () { router.navigate('/vzev/mitglied/' + encodeURIComponent(m.id)); }}>
          ${pencilIcon}
        </button>
        <div class="vz-house-wrap">${houseIcon}</div>
        <span class="vz-name">${name}</span>
        <span class="vz-type">${t(props.producer ? 'vzev.type.producer' : 'vzev.type.consumer')}</span>
        ${props.own ? html`<span class="vz-ownbadge">${t('vzev.own')}</span>` : null}
        ${nd ? html`
          <span class="vz-nodata" role="status">
            ${nd.lastTs
              ? t('vzev.nodata.badge', { time: fmt.time(nd.lastTs, '15m') })
              : t('vzev.nodata.never')}
          </span>` : null}
        ${!props.own && props.onRemove ? html`
          <button class="vz-remove" onClick=${props.onRemove}>${t('vzev.remove')}</button>` : null}
      </div>`;
  }

  /* A direction chip used by the mobile vertical-list fallback. */
  function FlowChip(props) {
    var wh = props.wh;
    var cls = 'vz-chip vz-chip-' + (props.dir === 'grid' ? 'grid' : 'vzev');
    return html`
      <span class=${cls}>
        <span class="vz-chip-dir">${t(props.dir === 'grid' ? 'vzev.flow.fromgrid' : 'vzev.flow.fromproducer')}</span>
        <span class="vz-chip-val">${fmt.wh(wh)}</span>
      </span>`;
  }

  function Vzev() {
    var stM = useState(null);        /* members: null=loading, []=empty */
    var members = stM[0], setMembers = stM[1];
    var stF = useState({});          /* flows: site-id -> Wh */
    var flowMap = stF[0], setFlowMap = stF[1];
    var stD = useState([]);          /* discovered devices */
    var discovered = stD[0], setDiscovered = stD[1];
    var stErr = useState(false);
    var err = stErr[0], setErr = stErr[1];
    var stRaw = useState(null);      /* /api/vzev/raw for no-data badges + drill-down */
    var raw = stRaw[0], setRaw = stRaw[1];
    var stInfo = useState(infoDismissed); /* info box dismissed? (session) */
    var infoHidden = stInfo[0], setInfoHidden = stInfo[1];
    var stDrill = useState(null);    /* member id whose allocation is drilled down */
    var drillId = stDrill[0], setDrillId = stDrill[1];
    /* guards setState against promises resolving after unmount */
    var mounted = useRef(true);

    function reload() {
      api.getVzevMembersList()
        .then(function (d) {
          if (!mounted.current) return;
          setMembers(d);
          setErr(false);
        })
        .catch(function () { if (mounted.current) { setMembers([]); setErr(true); } });
      /* raw rings drive the no-data badges (FR-906) and the drill-down
         (FR-908); tolerate a device without spec 005 raw endpoint. */
      api.getVzevRaw()
        .then(function (d) { if (mounted.current) setRaw(d || null); })
        .catch(function () { if (mounted.current) setRaw(null); });
    }

    useEffect(function () {
      mounted.current = true;
      reload();
      api.getVzevDiscovered()
        .then(function (d) { if (mounted.current) setDiscovered(d); })
        .catch(function () { if (mounted.current) setDiscovered([]); });
      /* poll live flows every 2 s for arrow direction/labels */
      var stop = api.poll(function () {
        api.getVzevFlows('15m', 1)
          .then(function (d) { if (mounted.current) setFlowMap(latestFlows(d && d.flows)); })
          .catch(function () { /* keep last known; page still renders */ });
      }, 2000);
      return function () { mounted.current = false; stop(); };
    }, []);

    function dismissInfo() { infoDismissed = true; setInfoHidden(true); }

    function removeMember(m) {
      api.get('/api/vzev/members?action=remove&id=' + encodeURIComponent(m.id))
        .then(function () { toast(t('vzev.removed'), { type: 'info' }); reload(); })
        .catch(function () { toast(t('vzev.saveerror'), { type: 'error' }); });
    }

    /* Abrechnung is producer-only (the settlement is authored on the producer
       device and distributed as the quarterly statement). Show the entry only
       when THIS device is the producer — self_id === producer_id from the raw
       rings, the same role signal the billing page uses. */
    var ownIsProducer = !!(raw && raw.self_id != null && raw.self_id === raw.producer_id);
    var actions = ownIsProducer ? html`
      <${ui.Button} secondary onClick=${function () { router.navigate('/vzev/abrechnung'); }}>
        ${t('vzev.billing')} ›
      <//>` : null;

    var header = html`<${ui.PageHeader} title=${t('page.vzev')} subtitle=${t('vzev.subtitle')} actions=${actions} />`;

    if (members === null) {
      return html`<div>${header}<${ui.Card}><p class="placeholder-text">${t('common.loading')}</p><//></div>`;
    }

    var own = null;
    var peers = [];
    members.forEach(function (m) {
      if (m.own || m.is_own) own = m; else peers.push(m);
    });
    /* Fallback: if the API doesn't flag the own site, treat none as own and
       render all as peers so the page still works. */

    var producer = null;
    members.forEach(function (m) { if (isProducer(m)) producer = m; });

    /* Discovery list: not-yet-added devices. */
    var discoveryCard = html`
      <${ui.Card} class="vz-discovery">
        <div class="vz-discovery-head">
          <h2 class="card-title">${t('vzev.discovery.title')}</h2>
          <span class="card-subtitle">${t('vzev.discovery.hint')}</span>
        </div>
        ${discovered.length === 0
          ? html`<p class="placeholder-text">${t('vzev.discovery.empty')}</p>`
          : html`
            <ul class="vz-discovery-list">
              ${discovered.map(function (dv) {
                return html`
                  <li key=${dv.id} class="vz-discovery-item">
                    <span class="vz-disc-name">${dv.name || dv.id}</span>
                    <span class="vz-disc-meta">${dv.id}${dv.url ? ' · ' + dv.url : ''}</span>
                    <${ui.Button} small onClick=${function () {
                      router.navigate('/vzev/mitglied/' + encodeURIComponent(dv.id));
                    }}>
                      ${plusIcon} ${t('vzev.add')}
                    <//>
                  </li>`;
              })}
            </ul>`}
      <//>`;

    /* helper: allocated Wh for a member from the live flow map */
    function whFor(m) {
      var v = flowMap[m.id];
      return (typeof v === 'number') ? v : null;
    }

    /* no-data badge (FR-906): a peer with no slot for > 2 h (relative to the
       newest slot seen across the community, so a clock-skewed browser doesn't
       false-alarm) gets {lastTs}. Own site is never badged here. Returns null
       when raw is unavailable or the member is current. */
    var newestSlot = 0;
    if (raw && raw.data) {
      for (var _id in raw.data) {
        var _last = vzevLib.lastSlotTs(raw, _id);
        if (_last && _last > newestSlot) newestSlot = _last;
      }
    }
    function noDataFor(m) {
      if (!raw || !raw.data) return null;
      var last = vzevLib.lastSlotTs(raw, m.id);
      var ref = newestSlot || Math.floor(Date.now() / 1000);
      if (last === null) return { lastTs: null };
      if (ref - last > NODATA_SECONDS) return { lastTs: last };
      return null;
    }

    /* «So funktioniert die Zuteilung» dismissible info box (FR-908). */
    var infoBox = infoHidden ? null : html`
      <${ui.Card} class="vz-info">
        <div class="vz-info-head">
          <h2 class="card-title">${t('vzev.info.title')}</h2>
          <button class="vz-info-close" aria-label=${t('common.close')} onClick=${dismissInfo}>×</button>
        </div>
        <p class="vz-info-body">${t('vzev.info.body')}</p>
        <${ui.Button} small secondary onClick=${dismissInfo}>${t('vzev.info.dismiss')}<//>
      <//>`;

    /* drill-down (FR-908): a slot-by-slot allocation explanation for one member,
       opened from the graph/list; shared SlotExplain component. */
    var drillMember = drillId ? (function () {
      for (var i = 0; i < members.length; i++) if (members[i].id === drillId) return members[i];
      return null;
    })() : null;
    var drillBox = (drillMember && raw) ? html`
      <${ui.Card} class="vz-drill">
        <${SlotExplain} raw=${raw} memberId=${drillId}
          title=${t('explain.title') + ' – ' + (drillMember.name || drillId)}
          onClose=${function () { setDrillId(null); }} />
      <//>` : null;

    /* ---- Desktop graph: producer/consumers around own, «Netz» below ---- */
    function graphCard() {
      /* peers to draw around the centre (exclude own; own is centred) */
      var ring = peers;
      return html`
        <${ui.Card} group="vzev" class="vz-graph-card">
          <div class="vz-graph" role="img" aria-label=${t('vzev.graph.aria')}>
            <div class="vz-ring">
              ${ring.length === 0
                ? html`<p class="placeholder-text vz-ring-empty">${t('vzev.empty')}</p>`
                : ring.map(function (m) {
                    var prod = isProducer(m);
                    var wh = whFor(m);
                    return html`
                      <div key=${m.id} class="vz-node vz-node-peer">
                        <${MemberCard} member=${m} producer=${prod} noData=${noDataFor(m)}
                          onRemove=${function () { removeMember(m); }} />
                        ${wh !== null && wh > 0 ? html`
                          <span class=${'vz-flow ' + (prod ? 'vz-flow-vzev' : 'vz-flow-grid')}>
                            <span class="vz-flow-arrow">${prod ? '→' : '←'}</span>
                            ${fmt.wh(wh)}
                          </span>` : null}
                        ${!prod && raw ? html`
                          <button class="vz-explain-btn" onClick=${function () { setDrillId(m.id); }}>
                            ${t('explain.open')}
                          </button>` : null}
                      </div>`;
                  })}
            </div>

            ${own ? html`
              <div class="vz-node vz-node-own">
                <${MemberCard} member=${own} own=${true} producer=${isProducer(own)} />
              </div>` : null}

            <div class="vz-arrow-grid" aria-hidden="true">
              <span class="vz-arrow-line"></span>
            </div>

            <div class="vz-node vz-node-net">
              <div class="vz-netnode">
                <div class="vz-grid-icowrap">${gridIcon}</div>
                <span class="vz-net-label">${t('vzev.net')}</span>
              </div>
            </div>
          </div>
        <//>`;
    }

    /* ---- Mobile fallback: vertical list with direction chips ---- */
    function listView() {
      return html`
        <div class="vz-list">
          ${own ? html`
            <div class="vz-list-item vz-list-own">
              <${MemberCard} member=${own} own=${true} producer=${isProducer(own)} />
            </div>` : null}
          ${peers.map(function (m) {
            var prod = isProducer(m);
            var wh = whFor(m);
            return html`
              <div key=${m.id} class="vz-list-item">
                <${MemberCard} member=${m} producer=${prod} noData=${noDataFor(m)}
                  onRemove=${function () { removeMember(m); }} />
                ${wh !== null && wh > 0
                  ? html`<${FlowChip} dir=${prod ? 'producer' : 'grid'} wh=${wh} />`
                  : null}
                ${!prod && raw ? html`
                  <button class="vz-explain-btn" onClick=${function () { setDrillId(m.id); }}>
                    ${t('explain.open')}
                  </button>` : null}
              </div>`;
          })}
          <div class="vz-list-item vz-list-net">
            <div class="vz-netnode vz-netnode-row">
              <div class="vz-grid-icowrap">${gridIcon}</div>
              <span class="vz-net-label">${t('vzev.net')}</span>
            </div>
          </div>
        </div>`;
    }

    return html`
      <div>
        ${header}
        ${err ? html`<div class="banner banner-warn">${t('vzev.loaderror')}</div>` : null}
        ${infoBox}
        <div class="vz-graph-wrap">${graphCard()}</div>
        <div class="vz-list-wrap">${listView()}</div>
        ${drillBox}
        ${discoveryCard}
      </div>`;
  }

export { Vzev };
