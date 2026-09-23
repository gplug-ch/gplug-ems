/* App shell (FR-213): navy sidebar with logo + nav (desktop), top bar with
   burger menu (< 1024 px), content area, RTC banner, offline handling. */
import { html, useState, useEffect } from './core.js';
import { t } from './i18n.js';
import { router } from './router.js';
import { api } from './api.js';
import { fmt } from './format.js';
import { toast, ToastHost } from './components.js';
import * as archive from './lib/archive.js';

  /* ---- Icons (inline SVG, stroke = currentColor) ---- */
  var icons = {
    overview: html`<svg viewBox="0 0 20 20" class="nav-icon" aria-hidden="true"><rect x="2.5" y="2.5" width="6" height="6" rx="1.5" fill="currentColor"/><rect x="11.5" y="2.5" width="6" height="6" rx="1.5" fill="currentColor"/><rect x="2.5" y="11.5" width="6" height="6" rx="1.5" fill="currentColor"/><rect x="11.5" y="11.5" width="6" height="6" rx="1.5" fill="currentColor"/></svg>`,
    history: html`<svg viewBox="0 0 20 20" class="nav-icon" aria-hidden="true"><path d="M3 3v13.5h14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M5.5 12.5l3.5-4 3 2.5 4.5-5.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    meter: html`<svg viewBox="0 0 20 20" class="nav-icon" aria-hidden="true"><circle cx="10" cy="10" r="7.5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M10 10l3.5-2.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M4.2 11.5h1.6M14.2 11.5h1.6M10 4.2v1.4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`,
    modbus: html`<svg viewBox="0 0 20 20" class="nav-icon" aria-hidden="true"><rect x="3.5" y="6" width="13" height="8" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M6.5 6V3.8M10 6V3.8M13.5 6V3.8M6.5 14v2.2M10 14v2.2M13.5 14v2.2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`,
    vzev: html`<svg viewBox="0 0 20 20" class="nav-icon" aria-hidden="true"><circle cx="10" cy="4" r="2.2" fill="currentColor"/><circle cx="4" cy="15" r="2.2" fill="currentColor"/><circle cx="16" cy="15" r="2.2" fill="currentColor"/><path d="M10 6.5v4M10 10.5l-4.5 3M10 10.5l4.5 3" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>`,
    settings: html`<svg width="16" height="17" viewBox="0 0 16 17" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M7.96387 10.7915C9.27554 10.7915 10.3389 9.72818 10.3389 8.4165C10.3389 7.10483 9.27554 6.0415 7.96387 6.0415C6.65219 6.0415 5.58887 7.10483 5.58887 8.4165C5.58887 9.72818 6.65219 10.7915 7.96387 10.7915Z" stroke="currentColor"/>
      <path d="M9.36127 0.620333C9.07073 0.5 8.70181 0.5 7.96398 0.5C7.22615 0.5 6.85723 0.5 6.56669 0.620333C6.37446 0.699906 6.19979 0.816584 6.05268 0.963698C5.90556 1.11081 5.78889 1.28548 5.70931 1.47771C5.63648 1.65425 5.60719 1.86088 5.5961 2.16092C5.59095 2.37778 5.53087 2.58979 5.4215 2.77711C5.31212 2.96444 5.15701 3.12096 4.97069 3.23204C4.78133 3.33794 4.56819 3.39407 4.35123 3.39518C4.13427 3.39629 3.92058 3.34234 3.73015 3.23838C3.46415 3.09746 3.27177 3.01988 3.08098 2.99454C2.66482 2.93981 2.24395 3.05258 1.9109 3.30804C1.66231 3.50042 1.47706 3.81946 1.10815 4.45833C0.73923 5.09721 0.55398 5.41625 0.513605 5.72896C0.486399 5.93515 0.500083 6.14468 0.553874 6.34558C0.607665 6.54649 0.70051 6.73482 0.827105 6.89983C0.944271 7.05183 1.10815 7.17929 1.36227 7.33921C1.73673 7.57433 1.9774 7.97492 1.9774 8.41667C1.9774 8.85842 1.73673 9.259 1.36227 9.49333C1.10815 9.65404 0.94348 9.7815 0.827105 9.9335C0.70051 10.0985 0.607665 10.2868 0.553874 10.4878C0.500083 10.6887 0.486399 10.8982 0.513605 11.1044C0.554771 11.4163 0.73923 11.7361 1.10735 12.375C1.47706 13.0139 1.66152 13.3329 1.9109 13.5253C2.07591 13.6519 2.26424 13.7447 2.46515 13.7985C2.66605 13.8523 2.87558 13.866 3.08177 13.8388C3.27177 13.8135 3.46415 13.7359 3.73015 13.595C3.92058 13.491 4.13427 13.437 4.35123 13.4382C4.56819 13.4393 4.78133 13.4954 4.97069 13.6013C5.35306 13.823 5.58027 14.2307 5.5961 14.6724C5.60719 14.9733 5.63569 15.1791 5.70931 15.3556C5.78889 15.5479 5.90556 15.7225 6.05268 15.8696C6.19979 16.0167 6.37446 16.1334 6.56669 16.213C6.85723 16.3333 7.22615 16.3333 7.96398 16.3333C8.70181 16.3333 9.07073 16.3333 9.36127 16.213C9.5535 16.1334 9.72817 16.0167 9.87528 15.8696C10.0224 15.7225 10.1391 15.5479 10.2186 15.3556C10.2915 15.1791 10.3208 14.9733 10.3319 14.6724C10.3477 14.2307 10.5749 13.8222 10.9573 13.6013C11.1466 13.4954 11.3598 13.4393 11.5767 13.4382C11.7937 13.437 12.0074 13.491 12.1978 13.595C12.4638 13.7359 12.6562 13.8135 12.8462 13.8388C13.0524 13.866 13.2619 13.8523 13.4628 13.7985C13.6637 13.7447 13.8521 13.6519 14.0171 13.5253C14.2664 13.3337 14.4509 13.0139 14.8198 12.375C15.1887 11.7361 15.374 11.4171 15.4144 11.1044C15.4416 10.8982 15.4279 10.6887 15.3741 10.4878C15.3203 10.2868 15.2274 10.0985 15.1009 9.9335C14.9837 9.7815 14.8198 9.65404 14.5657 9.49413C14.3804 9.38123 14.2267 9.22317 14.1192 9.03473C14.0116 8.84629 13.9536 8.63363 13.9506 8.41667C13.9506 7.97492 14.1912 7.57433 14.5657 7.34C14.8198 7.17929 14.9845 7.05183 15.1009 6.89983C15.2274 6.73482 15.3203 6.54649 15.3741 6.34558C15.4279 6.14468 15.4416 5.93515 15.4144 5.72896C15.3732 5.41704 15.1887 5.09721 14.8206 4.45833C14.4509 3.81946 14.2664 3.50042 14.0171 3.30804C13.8521 3.18145 13.6637 3.0886 13.4628 3.03481C13.2619 2.98102 13.0524 2.96734 12.8462 2.99454C12.6562 3.01988 12.4638 3.09746 12.197 3.23838C12.0067 3.3422 11.7931 3.39607 11.5763 3.39496C11.3595 3.39386 11.1465 3.3378 10.9573 3.23204C10.7709 3.12096 10.6158 2.96444 10.5065 2.77711C10.3971 2.58979 10.337 2.37778 10.3319 2.16092C10.3208 1.86008 10.2923 1.65425 10.2186 1.47771C10.1391 1.28548 10.0224 1.11081 9.87528 0.963698C9.72817 0.816584 9.5535 0.699906 9.36127 0.620333Z" stroke="currentColor"/>
    </svg>
    `,
    burger: html`<svg viewBox="0 0 20 20" class="nav-icon" aria-hidden="true"><path d="M3 5h14M3 10h14M3 15h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`
  };

  /* gPlug logo: amber connector glyph + wordmark */
  function Logo() {
    return html`
      <a class="logo" href="#/" aria-label="gPlug">
        <svg class="logo-mark" id="Layer_1" data-name="Layer 1" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 475.26 114.24">
          <defs>
            <style>
              .cls-1 {
                fill: #fac453;
              }
            </style>
          </defs>
          <g id="cdmtXP.tif">
            <g>
              <g>
                <g>
                  <path class="cls-1" d="M170.68,108.49c-1.4-.58-2.32-1.85-2.64-3.11-.42-1.66.25-3.06,1.24-4.44.89-1.23,2.98-2.12,4.59-1.39,4.35,1.96,8.7,3.69,13.51,4.17l5.49.54c3.62.36,7.5-.34,10.78-1.92,3.47-1.67,5.88-4.55,7.12-8.1.84-2.41,1.34-4.96,1.33-7.53l-.04-9.5c-5.16,5.04-10.2,8-17.22,8.69-9.18.9-18.42-2.82-24.37-9.94s-7.53-15.56-6.65-24.63c.87-8.98,5.35-16.66,12.96-21.56,6.79-4.37,15.28-5.89,23.15-3.46,4.66,1.44,8.62,4.31,12.14,7.75.06-2.03-.06-3.74.68-5.27,1.03-2.11,2.94-3.16,5.3-2.85,2.39.12,4.01,1.99,4.71,4.39v56.06s-.46,3.55-.46,3.55c-.52,4.14-1.51,8.11-3.51,11.75-4.97,9.02-13.64,12.73-23.81,12.54l-6.76-.46c-4.07-.28-7.97-1.28-11.71-2.83l-5.84-2.44ZM204.28,73.97c2.87-1.78,5.34-3.84,7.84-6.23v-24.28c-3.69-3.57-8.46-7.44-13.37-8.21-7.97-1.46-16.93.75-21.32,7.7-3.3,5.22-3.46,10.39-3.07,16.44l.5,2.71c.99,5.31,4.42,9.75,9.3,12.13,5.98,2.91,14.52,3.2,20.12-.27Z"/>
                  <path class="cls-1" d="M305.69,33.23c-1.31,13.44-11.81,21.48-24.93,22.68l-4.22.31-23.49.05-.02,25.06c0,1.54-.55,3-1.7,3.87-2.2,2.05-5.33,1.98-7.39-.16-.82-.85-1.45-1.79-1.45-3.14V9.52c0-2.5,1.93-5.11,4.57-5.11h32.26s2.98.41,2.98.41c6.38.88,12.76,3.38,17.09,8.13,5.07,5.57,7.05,12.79,6.31,20.28ZM295.07,27.73c-.69-4.81-3.33-8.62-7.7-10.83-3.11-1.47-6.54-2.5-10.16-2.52l-24.17-.14v32s24.52-.06,24.52-.06l3.57-.43c3.6-.54,6.71-1.93,9.49-4.28,3.71-3.13,5.16-8.82,4.45-13.73Z"/>
                </g>
                <g>
                  <path class="cls-1" d="M423.18,108.49c-1.4-.58-2.32-1.85-2.64-3.11-.41-1.64.25-3.09,1.23-4.42,1.06-1.45,3.23-2.1,4.96-1.29,4.67,2.19,9.55,3.78,14.73,4.24l4.12.37c3.57.32,7.36-.38,10.58-1.94,3.46-1.68,5.88-4.55,7.12-8.1.84-2.4,1.34-4.96,1.33-7.53l-.05-9.5c-5.15,5.04-10.21,8-17.22,8.69-9.18.9-18.42-2.82-24.37-9.94s-7.53-15.56-6.65-24.63,5.35-16.69,12.96-21.56c6.87-4.4,15.42-5.93,23.34-3.4,4.43,1.42,8.31,4.11,11.59,7.39l.41.06c-.03-1.75-.1-3.51.63-5.02,1.02-2.11,2.94-3.16,5.3-2.84,2.39.11,4.01,1.99,4.71,4.39l-.04,56.29-.6,4.71c-.7,5.48-2.8,10.65-6.4,14.76-5.39,6.17-12.94,8.29-21,8.13l-6.51-.46c-4.07-.29-7.97-1.27-11.71-2.83l-5.84-2.44ZM444.08,76.36c4.74.2,8.72.08,12.7-2.4,2.91-1.81,5.49-3.91,7.85-6.28v-24.23c-3.7-3.57-8.45-7.43-13.38-8.21-12.17-2.09-22.89,3.72-24.35,16.35l-.05,7.8.51,2.7c1.28,6.79,6.42,11.92,13.12,13.56l3.6.71Z"/>
                  <path class="cls-1" d="M400.95,30.87v50.29c.01,3.02-2.06,5.39-4.93,5.51-2.86.12-5.48-1.94-5.57-5l-.15-5.08-6.41,5.57c-6.62,5.75-19.7,7.03-27.22,1.72-1.96-1.38-3.66-2.94-5.02-5.01-2.67-4.07-4.2-8.74-4.21-13.77l-.03-34.28c0-3.2,3.04-5.25,6-4.91,1.97.22,4.42,1.79,4.43,4.09l.13,33.85.45,3.57c.36,2.82,1.59,5.56,3.82,7.4,4.38,3.61,12.33,3.28,17.28.7,4.31-2.25,7.84-5.61,10.86-9.32l.03-35.42c0-3.13,2.86-5.08,5.77-4.88,2.54.17,4.75,2.12,4.75,4.97Z"/>
                </g>
                <path class="cls-1" d="M329.38,81.48c-.31,2.95-2.21,4.78-4.78,5.18-2.54.31-5.05-1.34-5.8-3.99V4.04c.6-2.58,2.76-4.09,5.29-4.04,2.99.05,4.9,2.14,5.28,5.17v76.31Z"/>
              </g>
              <g>
                <path class="cls-1" d="M0,4.23h122.44v107.79H0V4.23ZM79,100.42l.03-5.82h12.03s.01-12.27.01-12.27h14.33s-.01-67.07-.01-67.07H16.39s-.03,67.05-.03,67.05l12.58.02.02,12.26h12.64s.08,5.83.08,5.83h37.33Z"/>
                <g>
                  <rect class="cls-1" x="29.56" y="21.98" width="7.03" height="45.47"/>
                  <rect class="cls-1" x="40.34" y="21.98" width="7.05" height="45.28"/>
                  <rect class="cls-1" x="62.06" y="21.98" width="7.08" height="45.28"/>
                  <rect class="cls-1" x="83.73" y="21.98" width="7.15" height="45.28"/>
                  <rect class="cls-1" x="72.84" y="21.98" width="7.06" height="45.28"/>
                  <rect class="cls-1" x="51.3" y="21.98" width="6.93" height="45.28"/>
                </g>
              </g>
            </g>
          </g>
        </svg>
      </a>`;
  }

  var NAV = [
    { path: '/', key: 'nav.overview', icon: 'overview', active: function (p) { return p === '/'; } },
    { path: '/verlauf', key: 'nav.history', icon: 'history', active: function (p) { return p.indexOf('/verlauf') === 0; } },
    /* «Zähler» is meter-specific (spec 007 FR-703): shown only when the device
       actually delivers smart-meter data (real gPlug sensor or a simulated
       meter source) — hidden on simulator/HA-only sites. */
    { path: '/zaehler', key: 'nav.meter', icon: 'meter', gate: 'meter', active: function (p) { return p.indexOf('/zaehler') === 0; } },
    /* «Modbus» is opt-in the same way «Zähler» is: shown only once the site
       actually has at least one configured register (Einstellungen -> Modbus,
       site.json "modbusRegisters") — hidden on sites without one. */
    { path: '/modbus', key: 'nav.modbus', icon: 'modbus', gate: 'modbus', active: function (p) { return p.indexOf('/modbus') === 0; } },
    /* «vZEV» is opt-in (default off, most sites have no energy community):
       shown only once the user flips the toggle in Einstellungen → vZEV. */
    { path: '/vzev', key: 'nav.vzev', icon: 'vzev', gate: 'vzev', active: function (p) { return p.indexOf('/vzev') === 0; } },
    { path: '/einstellungen', key: 'nav.settings', icon: 'settings', active: function (p) { return p.indexOf('/einstellungen') === 0; } }
  ];

  function NavList(props) {
    return html`
      <nav class="nav" aria-label=${t('nav.menu')}>
        ${NAV.filter(function (item) {
          return (item.gate !== 'meter' || props.showMeter) &&
                 (item.gate !== 'modbus' || props.showModbus) &&
                 (item.gate !== 'vzev' || props.showVzev);
        }).map(function (item) {
          var active = item.active(props.path);
          return html`
            <a key=${item.path} href=${'#' + item.path}
              class=${'nav-item' + (active ? ' nav-item-active' : '')}
              aria-current=${active ? 'page' : 'false'}
              onClick=${props.onNavigate}>
              ${icons[item.icon]}
              <span>${t(item.key)}</span>
            </a>`;
        })}
      </nav>`;
  }

  /* ---- Shell ---- */
  function Shell(props) {
    var cur = router.useRoute(props.routes);
    var menuSt = useState(false);
    var menuOpen = menuSt[0], setMenuOpen = menuSt[1];
    var rtcSt = useState(false);
    var rtcUnsynced = rtcSt[0], setRtcUnsynced = rtcSt[1];
    var staleSt = useState(null);
    var staleSince = staleSt[0], setStaleSince = staleSt[1];
    var meterSt = useState(false);
    var showMeter = meterSt[0], setShowMeter = meterSt[1];
    var modbusSt = useState(false);
    var showModbus = modbusSt[0], setShowModbus = modbusSt[1];
    var vzevSt = useState(false);
    var showVzev = vzevSt[0], setShowVzev = vzevSt[1];
    var archSt = useState(false);
    var archBlocked = archSt[0], setArchBlocked = archSt[1];

    /* offline toast + stale note (edge cases) */
    useEffect(function () {
      return api.onStatus(function (online, lastOk) {
        if (!online) {
          toast(t('error.offline'), { type: 'error' });
          setStaleSince(lastOk ? new Date(lastOk) : new Date());
        } else {
          setStaleSince(null);
        }
      });
    }, []);

    /* spec 011 FR-1111: storage blocked (private window, quota, SecurityError)
       -> every page still renders from the live device buffer, but the user is
       told that only the last few days are visible. */
    useEffect(function () {
      var warned = false;
      function apply(st) {
        setArchBlocked(st.available === false);
        /* FR-1102: a second site id under this origin (device renamed or
           replaced) keeps its own archive — say it once, don't merge them. */
        if (!warned && st.otherSites && st.otherSites.length) {
          warned = true;
          toast(t('banner.archive_site_changed', { id: st.siteId }), { type: 'warn' });
        }
      }
      var stop = archive.onChange(apply);
      archive.ready().then(apply);
      return stop;
    }, []);

    /* RTC-synced check via /api/meta (banner edge case); re-check via poll */
    useEffect(function () {
      return api.poll(function () {
        api.getMeta()
          .then(function (meta) {
            setRtcUnsynced(!!meta && typeof meta.time === 'number' && meta.time < 1e9);
          })
          .catch(function () { /* offline toast already handled by onStatus */ });
      }, 60000);
    }, []);

    /* reveal the «Zähler» nav entry once the device confirms it has meter data
       (FR-703). One probe on mount; keep it hidden on any error / null values. */
    useEffect(function () {
      api.getMeter()
        .then(function (m) { setShowMeter(!!(m && m.values)); })
        .catch(function () { /* keep hidden; offline handled by onStatus */ });
    }, []);

    /* reveal the «Modbus» nav entry once the site has at least one configured
       register. One probe on mount; keep it hidden on any error / empty list. */
    useEffect(function () {
      api.getModbus()
        .then(function (list) { setShowModbus(Array.isArray(list) && list.length > 0); })
        .catch(function () { /* keep hidden; offline handled by onStatus */ });
    }, []);

    /* reveal the «vZEV» nav entry only once enabled from Einstellungen (default
       off — most sites have no energy community). One probe on mount PLUS a
       live subscription (api.onVzevInfo) so saving the toggle in Einstellungen
       updates the menu immediately, without waiting for a reload. */
    useEffect(function () {
      var stop = api.onVzevInfo(function (info) { setShowVzev(!!(info && info.enabled)); });
      api.getVzevInfo().catch(function () { /* keep hidden; offline handled by onStatus */ });
      return stop;
    }, []);

    /* close the mobile menu whenever the route changes */
    useEffect(function () { setMenuOpen(false); }, [cur.path]);

    var Page = cur.route.component;

    return html`
      <div class="shell">
        <aside class="sidebar">
          <${Logo} />
          <${NavList} path=${cur.path} showMeter=${showMeter} showModbus=${showModbus} showVzev=${showVzev} />
          <div class="sidebar-foot">${__APP_VERSION__}</div>
        </aside>

        <div class="topbar">
          <${Logo} />
          <button class="burger" aria-label=${t('nav.menu')} aria-expanded=${menuOpen}
            onClick=${function () { setMenuOpen(!menuOpen); }}>${icons.burger}</button>
        </div>
        ${menuOpen ? html`
          <div class="drawer">
            <${NavList} path=${cur.path} showMeter=${showMeter} showModbus=${showModbus} showVzev=${showVzev} onNavigate=${function () { setMenuOpen(false); }} />
          </div>` : null}

        <main class="content">
          ${rtcUnsynced ? html`<div class="banner banner-warn">${t('banner.rtc')}</div>` : null}
          ${archBlocked ? html`<div class="banner banner-warn">${t('banner.archive')}</div>` : null}
          ${staleSince ? html`
            <div class="stale-note">${t('common.stale', {
              time: fmt.time(Math.floor(staleSince.getTime() / 1000), 'hm')
            })}</div>` : null}
          <${Page} params=${cur.params} />
        </main>

        <${ToastHost} />
      </div>`;
  }

export { Shell };
