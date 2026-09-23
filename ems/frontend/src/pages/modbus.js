/* «Modbus» — raw values of the standalone Modbus registers configured in
   Einstellungen -> Modbus (site.json "modbusRegisters"): registers that don't
   fit loads (controllable) / productions (PV/battery) / grid (import/export),
   e.g. a heat or water submeter behind a Modbus TCP gateway. Polls
   GET /api/modbus every 10 s and renders one raw name/value/unit row per
   configured register — same table styling as the Zähler «Rohdaten» section
   (pages/zaehler.js), since the device serves these the same way: verbatim,
   no cost/roll-up math, all labelling already comes from the config itself. */
import { html, useState, useEffect } from '../core.js';
import { t } from '../i18n.js';
import { fmt } from '../format.js';
import { api } from '../api.js';
import * as ui from '../ui.js';

  var POLL_MS = 10000;

  /* coerce a raw value to a number, or null (mirrors zaehler.js:asNum) */
  function asNum(v) {
    if (typeof v === 'number' && !isNaN(v)) return v;
    if (typeof v === 'string' && v.trim() !== '' && !isNaN(Number(v))) return Number(v);
    return null;
  }

  function RawTable(props) {
    var items = props.items;
    return html`
      <${ui.Card} title=${t('modbus.section.raw')}>
        <div class="meter-table-wrap">
          <table class="meter-table meter-raw-table">
            <thead>
              <tr>
                <th>${t('modbus.raw.name')}</th>
                <th>${t('modbus.raw.value')}</th>
                <th>${t('modbus.raw.unit')}</th>
                <th>${t('modbus.raw.register')}</th>
              </tr>
            </thead>
            <tbody>
              ${items.map(function (m) {
                var v = asNum(m.currentPower);
                return html`
                  <tr>
                    <td class="meter-raw-name">${m.friendlyName || m.id}</td>
                    <td class="meter-raw-val">${v === null ? t('modbus.raw.no_value') : fmt.num(v, 3)}</td>
                    <td class="meter-raw-unit">${m.unitLabel || ''}</td>
                    <td class="meter-raw-label">${m.register}</td>
                  </tr>`;
              })}
            </tbody>
          </table>
        </div>
      <//>`;
  }

  function Modbus() {
    var itemsSt = useState(undefined);        /* undefined=loading, []=empty */
    var items = itemsSt[0], setItems = itemsSt[1];
    var updatedSt = useState(null);
    var updated = updatedSt[0], setUpdated = updatedSt[1];

    useEffect(function () {
      return api.poll(function () {
        api.getModbus().then(function (res) {
          setItems(Array.isArray(res) ? res : []);
          setUpdated(Math.floor(Date.now() / 1000));
        }).catch(function () { /* offline handled globally by api.onStatus */ });
      }, POLL_MS);
    }, []);

    var age = updated ? Math.max(0, Math.floor(Date.now() / 1000) - updated) : null;

    return html`
      <div>
        <${ui.PageHeader} title=${t('page.modbus')} subtitle=${t('modbus.subtitle')}
          actions=${updated ? html`
            <span class="meter-updated">
              ${t('meter.updated', { time: fmt.time(updated, 'hm') })}
              ${age !== null ? html`<span class="meter-age"> · ${t('meter.age', { s: age })}</span>` : null}
            </span>` : null} />

        ${items === undefined ? html`<${ui.Card}><p class="placeholder-text">${t('common.loading')}</p><//>` : null}
        ${items && items.length === 0 ? html`<${ui.Card}><p class="placeholder-text">${t('modbus.empty')}</p><//>` : null}
        ${items && items.length ? html`<${RawTable} items=${items} />` : null}
      </div>`;
  }

export { Modbus };
