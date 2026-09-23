/* Shared UI components (FR-208, FR-210, FR-212): PageHeader, Card, Badge,
   Button, Select, TextField, Tooltip, Toast. */
import { html, useState, useEffect, useRef } from './core.js';
import { t } from './i18n.js';

  /* ---- PageHeader — identical title alignment on every page (FR-208) ---- */
  function PageHeader(props) {
    return html`
      <header class="page-header">
        <div class="page-header-titles">
          <h1 class="page-title">${props.title}</h1>
          ${props.subtitle ? html`<p class="page-subtitle">${props.subtitle}</p>` : null}
        </div>
        ${props.actions ? html`<div class="page-header-actions">${props.actions}</div>` : null}
      </header>`;
  }

  /* ---- Card — 4px left accent in group color (FR-207) ----
     group: 'grid' | 'production' | 'loads' | undefined
     collapsible: header gets a caret toggle that hides the body. With
     `collapseKey` the open/closed choice survives navigation and reloads via
     localStorage (per-browser convenience only — never app state). */
  function Card(props) {
    var cls = 'card' + (props.group ? ' card-' + props.group : '') +
              (props.class ? ' ' + props.class : '');
    var collapsible = !!props.collapsible;
    var storeKey = props.collapseKey ? 'ui.card.' + props.collapseKey : null;

    var [open, setOpen] = useState(function () {
      if (!collapsible) return true;
      if (storeKey) {
        try {
          var v = window.localStorage.getItem(storeKey);
          if (v === '0') return false;
          if (v === '1') return true;
        } catch (e) { /* private mode / blocked storage → fall through */ }
      }
      return props.defaultOpen === false ? false : true;
    });

    function toggle() {
      var next = !open;
      setOpen(next);
      if (storeKey) {
        try { window.localStorage.setItem(storeKey, next ? '1' : '0'); } catch (e) { /* ignore */ }
      }
    }

    var shown = !collapsible || open;
    return html`
      <section class=${cls + (collapsible && !open ? ' is-collapsed' : '')}>
        ${props.title || props.value || props.badge || props.tooltip ? html`
          <div class=${'card-head' + (shown ? '' : ' card-head-collapsed')}>
            <div class="card-head-left">
              ${collapsible ? html`
                <button type="button" class="card-toggle" aria-expanded=${open ? 'true' : 'false'}
                  aria-label=${open ? t('common.collapse') : t('common.expand')}
                  onClick=${toggle}>
                  <svg class="card-toggle-caret" viewBox="0 0 12 8" aria-hidden="true"><path d="M1 1.5 6 6.5 11 1.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
                <//>` : null}
              ${props.title ? html`<h2 class="card-title">${props.title}</h2>` : null}
              ${props.tooltip ? html`<${Tooltip} text=${props.tooltip} />` : null}
              ${props.subtitle ? html`<span class="card-subtitle">${props.subtitle}</span>` : null}
            </div>
            <div class="card-head-right">
              ${props.value ? html`<span class="card-value" style=${props.valueColor ? 'color:' + props.valueColor : ''}>${props.value}</span>` : null}
              ${props.badge ? props.badge : null}
            </div>
          </div>` : null}
        ${shown ? props.children : null}
      </section>`;
  }

  /* ---- Badge — Aktiv / Wartend / Inaktiv (FR-212) ---- */
  function Badge(props) {
    var state = String(props.state || '').toLowerCase();
    var key = 'state.' + state;
    var cls = 'badge badge-' + (state === 'active' ? 'active' : state === 'waiting' ? 'waiting' : 'inactive');
    return html`<span class=${cls}>${t(key)}</span>`;
  }

  /* ---- Button — primary (amber/navy) | secondary (navy/light) | danger ---- */
  function Button(props) {
    var variant = props.danger ? 'danger' : props.secondary ? 'secondary' : 'primary';
    return html`
      <button
        type=${props.type || 'button'}
        class=${'btn btn-' + variant + (props.small ? ' btn-small' : '')}
        disabled=${props.disabled}
        onClick=${props.onClick}>${props.children}</button>`;
  }

  /* ---- Select ---- */
  function Select(props) {
    return html`
      <label class="field">
        ${props.label ? html`<span class="field-label">${props.label}</span>` : null}
        <span class="select-wrap">
          <select class="select" value=${props.value} disabled=${props.disabled}
            onChange=${function (e) { if (props.onChange) props.onChange(e.target.value); }}>
            ${(props.options || []).map(function (o) {
              return html`<option key=${o.value} value=${o.value}>${o.label}</option>`;
            })}
          </select>
          <svg class="select-caret" viewBox="0 0 12 8" aria-hidden="true"><path d="M1 1.5 6 6.5 11 1.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
        </span>
      </label>`;
  }

  /* ---- TextField ---- */
  function TextField(props) {
    return html`
      <label class="field">
        ${props.label ? html`<span class="field-label">${props.label}</span>` : null}
        <input class="textfield" type=${props.type || 'text'}
          value=${props.value} placeholder=${props.placeholder || ''}
          disabled=${props.disabled}
          onInput=${function (e) { if (props.onInput) props.onInput(e.target.value); }} />
      </label>`;
  }

  /* ---- Tooltip — info icon, hover + focus + tap, ESC dismiss (FR-210) ---- */
  function Tooltip(props) {
    var open = useState(false);
    var isOpen = open[0], setOpen = open[1];
    var posSt = useState(null);                 /* {left, top} in viewport px, once measured */
    var pos = posSt[0], setPos = posSt[1];
    var bubbleRef = useRef(null);
    var wrapRef = useRef(null);

    useEffect(function () {
      if (!isOpen) return;
      function onKey(e) { if (e.key === 'Escape') setOpen(false); }
      function onDocTap(e) {
        if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
      }
      document.addEventListener('keydown', onKey);
      document.addEventListener('click', onDocTap);
      /* Position the bubble with viewport (fixed) coordinates so no ancestor's
         overflow — e.g. the horizontally-scrolling meter table — can clip it.
         Anchored above the icon, centred on it, clamped to the viewport; flips
         below when there is no room above. */
      var el = bubbleRef.current, wrap = wrapRef.current;
      if (el && wrap) {
        var a = wrap.getBoundingClientRect();
        var b = el.getBoundingClientRect();
        var cx = a.left + a.width / 2;
        var left = Math.max(8, Math.min(cx - b.width / 2, window.innerWidth - 8 - b.width));
        var top = a.top - b.height - 8;
        if (top < 8) top = a.bottom + 8;
        setPos({ left: left, top: top });
      }
      return function () {
        document.removeEventListener('keydown', onKey);
        document.removeEventListener('click', onDocTap);
        setPos(null);                           /* re-measure on next open, no stale flash */
      };
    }, [isOpen]);

    return html`
      <span class="tooltip-wrap" ref=${wrapRef}>
        <button type="button" class="tooltip-icon" aria-label=${props.text}
          aria-expanded=${isOpen}
          onMouseEnter=${function () { setOpen(true); }}
          onMouseLeave=${function () { setOpen(false); }}
          onFocus=${function () { setOpen(true); }}
          onBlur=${function () { setOpen(false); }}
          onClick=${function (e) { e.stopPropagation(); setOpen(!isOpen); }}>
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" stroke-width="1.4"/>
            <rect x="7.25" y="6.8" width="1.5" height="5" rx="0.75" fill="currentColor"/>
            <circle cx="8" cy="4.6" r="1" fill="currentColor"/>
          </svg>
        </button>
        ${isOpen ? html`
          <span class="tooltip-bubble" role="tooltip" ref=${bubbleRef}
            style=${pos ? ('left:' + pos.left + 'px;top:' + pos.top + 'px') : 'visibility:hidden'}>${props.text}</span>` : null}
      </span>`;
  }

  /* ---- Toast — non-blocking notifications (edge case: offline) ---- */
  var toastListeners = [];
  var toastSeq = 0;

  function toast(message, opts) {
    opts = opts || {};
    var item = { id: ++toastSeq, message: message, type: opts.type || 'info', ttl: opts.ttl || 5000 };
    toastListeners.forEach(function (cb) { cb(item); });
  }

  function ToastHost() {
    var st = useState([]);
    var items = st[0], setItems = st[1];

    useEffect(function () {
      function onToast(item) {
        setItems(function (prev) { return prev.concat([item]); });
        setTimeout(function () {
          setItems(function (prev) {
            return prev.filter(function (i) { return i.id !== item.id; });
          });
        }, item.ttl);
      }
      toastListeners.push(onToast);
      return function () {
        var i = toastListeners.indexOf(onToast);
        if (i >= 0) toastListeners.splice(i, 1);
      };
    }, []);

    return html`
      <div class="toast-host" aria-live="polite">
        ${items.map(function (i) {
          return html`
            <div key=${i.id} class=${'toast toast-' + i.type}>
              <span>${i.message}</span>
              <button class="toast-close" aria-label=${t('common.close')}
                onClick=${function () {
                  setItems(function (prev) {
                    return prev.filter(function (x) { return x.id !== i.id; });
                  });
                }}>×</button>
            </div>`;
        })}
      </div>`;
  }

export {
  PageHeader, Card, Badge, Button, Select, TextField, Tooltip, ToastHost, toast,
};
