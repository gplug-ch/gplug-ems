/* DataTable (FR-212) — headers with units, pagination footer (10/25/50). */
import { html, useState } from './core.js';
import { t } from './i18n.js';

  var PAGE_SIZES = [10, 25, 50];

  /* columns: [{ key, label, unit?, align?, render?(row) }]
     rows: array of objects */
  function DataTable(props) {
    var pageState = useState(0);
    var page = pageState[0], setPage = pageState[1];
    var sizeState = useState(props.pageSize || 10);
    var pageSize = sizeState[0], setPageSize = sizeState[1];

    var rows = props.rows || [];
    var total = rows.length;
    var pages = Math.max(1, Math.ceil(total / pageSize));
    var cur = Math.min(page, pages - 1);
    var from = cur * pageSize;
    var to = Math.min(from + pageSize, total);
    var visible = rows.slice(from, to);

    return html`
      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              ${props.columns.map(function (c) {
                return html`
                  <th key=${c.key} class=${c.align === 'right' ? 'ta-r' : ''}>
                    ${c.label}${c.unit ? html`<span class="th-unit"> ${c.unit}</span>` : null}
                  </th>`;
              })}
            </tr>
          </thead>
          <tbody>
            ${total === 0 ? html`
              <tr><td class="table-empty" colspan=${props.columns.length}>${t('common.nodata')}</td></tr>` :
              visible.map(function (row, i) {
                return html`
                  <tr key=${row.id !== undefined ? row.id : from + i}>
                    ${props.columns.map(function (c) {
                      return html`
                        <td key=${c.key} class=${c.align === 'right' ? 'ta-r' : ''}>
                          ${c.render ? c.render(row) : row[c.key]}
                        </td>`;
                    })}
                  </tr>`;
              })}
          </tbody>
        </table>
        <div class="table-footer">
          <label class="table-pagesize">
            <span>${t('table.perpage')}</span>
            <span class="select-wrap select-wrap-small">
              <select class="select select-small" value=${pageSize}
                onChange=${function (e) { setPageSize(+e.target.value); setPage(0); }}>
                ${PAGE_SIZES.map(function (n) { return html`<option key=${n} value=${n}>${n}</option>`; })}
              </select>
              <svg class="select-caret" viewBox="0 0 12 8" aria-hidden="true"><path d="M1 1.5 6 6.5 11 1.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
            </span>
          </label>
          <span class="table-pageinfo">
            ${t('table.pageinfo', { from: total === 0 ? 0 : from + 1, to: to, total: total })}
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
      </div>`;
  }

export { DataTable };
