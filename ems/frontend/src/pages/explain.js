/* Slot drill-down (spec 009 FR-908, UC-904). A shared, self-contained modal
   component used by both the vZEV page and the Abrechnung page: given the raw
   peer rings and a member id, it lists the underlying 15-minute slots (newest
   first, paginated ≤ 50 per NFR-902) and renders one plain-language sentence
   per slot, generated from the SAME lib/vzev.js:explainSlot() inputs the
   billing uses (one source of truth — «show the result, not the arithmetic»).

   Pure-ish: the only side effect is local pagination state. All numbers come
   from explainSlot()/allocate(); this component never re-implements allocation. */
import { html, useState } from '../core.js';
import { t } from '../i18n.js';
import { fmt } from '../format.js';
import * as vzev from '../lib/vzev.js';

var PAGE = 50; /* NFR-902: keep the DOM bounded */

  /* All slot timestamps a member appears in, within [range[0], range[1]) when a
     range is given, newest-first. Derived from the producer ring so the set of
     slots matches what allocation actually ran on. */
  function slotTimestamps(raw, range) {
    if (!raw || !raw.data) return [];
    var pid = raw.producer_id;
    var prod = pid && raw.data[pid];
    var seen = {};
    var out = [];
    /* prefer the producer ring (every allocated slot has a producer entry);
       fall back to the union of all rings when the producer id is unknown. */
    var rings = prod ? [prod] : Object.keys(raw.data).map(function (k) { return raw.data[k]; });
    rings.forEach(function (ring) {
      if (!ring) return;
      for (var i = 0; i + 2 < ring.length; i += 3) {
        var ts = ring[i];
        if (range && (ts < range[0] || ts >= range[1])) continue;
        if (!seen[ts]) { seen[ts] = true; out.push(ts); }
      }
    });
    out.sort(function (a, b) { return b - a; }); /* newest first */
    return out;
  }

  /* One sentence for a slot, from explainSlot() (UC-904). */
  function slotSentence(ts, raw, memberId) {
    var e = vzev.explainSlot(ts, raw, memberId);
    var from = fmt.time(ts, 'hm');
    var to = fmt.time(ts + 900, 'hm');
    if (!e || e.prodWh <= 0) {
      return t('explain.noprod', { from: from, to: to });
    }
    return t('explain.sentence', {
      from: from, to: to,
      prod: fmt.wh(e.prodWh),
      member: fmt.wh(e.memberImpWh),
      total: fmt.wh(e.totalImpWh),
      share: fmt.num(e.sharePct, 0),
      alloc: fmt.wh(e.allocatedWh)
    });
  }

  /* SlotExplain — a dismissible panel. Props:
       raw       : /api/vzev/raw payload
       memberId  : id whose allocation is explained
       range     : optional [from,to) epoch-seconds bound
       title     : optional heading (defaults to explain.title)
       onClose   : callback for the close button (optional) */
  function SlotExplain(props) {
    var pageSt = useState(0);
    var page = pageSt[0], setPage = pageSt[1];

    var all = slotTimestamps(props.raw, props.range);
    var shown = all.slice(0, (page + 1) * PAGE);
    var hasMore = shown.length < all.length;

    return html`
      <div class="explain-panel" role="region" aria-label=${props.title || t('explain.title')}>
        <div class="explain-head">
          <div>
            <h3 class="explain-title">${props.title || t('explain.title')}</h3>
            <p class="explain-subtitle">${t('explain.subtitle')}</p>
          </div>
          ${props.onClose ? html`
            <button class="explain-close" aria-label=${t('explain.close')} onClick=${props.onClose}>×</button>` : null}
        </div>
        ${all.length === 0
          ? html`<p class="placeholder-text">${t('explain.empty')}</p>`
          : html`
            <ul class="explain-list">
              ${shown.map(function (ts) {
                return html`<li key=${ts} class="explain-slot">${slotSentence(ts, props.raw, props.memberId)}</li>`;
              })}
            </ul>
            ${hasMore ? html`
              <button class="explain-more" onClick=${function () { setPage(page + 1); }}>
                ${t('explain.more')}
              </button>` : null}`}
      </div>`;
  }

export { SlotExplain, slotSentence, slotTimestamps };
