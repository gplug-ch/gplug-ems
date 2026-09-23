/* vZEV member add/edit form (spec 005 FR-511, UC-501/502).
   Fields: Anzeige-Name, Ort, Typ (Produzent/Konsument). New members are
   pre-filled from discovery announcement data. Validation: exactly one
   Produzent across the community — save is blocked otherwise with an inline
   message (FR-505 single-producer rule). Save via GET upsert, remove via GET
   remove; on success navigate back to #/vzev. */
import { html, useState, useEffect } from '../core.js';
import { t } from '../i18n.js';
import { api } from '../api.js';
import { router } from '../router.js';
import { toast } from '../components.js';
import * as ui from '../ui.js';

function typOf(m) {
    if (!m) return 'C';
    if (m.type === 'PRODUCER' || m.typ === 'P') return 'P';
    return 'C';
  }

  /* epoch-seconds -> yyyy-mm-dd (local) for the date input, '' when unset */
  function tsToDate(ts) {
    if (ts === null || ts === undefined || ts === 0) return '';
    var d = new Date(ts * 1000);
    function p2(n) { return (n < 10 ? '0' : '') + n; }
    return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate());
  }

  /* yyyy-mm-dd -> local-midnight epoch seconds, or null when blank/invalid */
  function dateToTs(s) {
    if (!s) return null;
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s));
    if (!m) return null;
    var d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0, 0);
    return Math.floor(d.getTime() / 1000);
  }

  function VzevMember(props) {
    var id = (props.params && props.params.id) || null;   /* absent → new member */

    var stName = useState('');
    var name = stName[0], setName = stName[1];
    var stLoc = useState('');
    var loc = stLoc[0], setLoc = stLoc[1];
    var stTyp = useState('C');
    var typ = stTyp[0], setTyp = stTyp[1];
    /* spec 009 FR-902 optional fields */
    var stMp = useState('');
    var mp = stMp[0], setMp = stMp[1];
    var stEntry = useState('');       /* yyyy-mm-dd for the date input */
    var entry = stEntry[0], setEntry = stEntry[1];

    var stMembers = useState([]);    /* all members (for single-producer check) */
    var members = stMembers[0], setMembers = stMembers[1];
    var stExisting = useState(!!id); /* is this an edit of a stored member? */
    var existing = stExisting[0], setExisting = stExisting[1];
    var stReady = useState(false);
    var ready = stReady[0], setReady = stReady[1];
    var stSaving = useState(false);
    var saving = stSaving[0], setSaving = stSaving[1];
    var stValErr = useState('');
    var valErr = stValErr[0], setValErr = stValErr[1];

    useEffect(function () {
      var done = false;
      Promise.all([
        api.getVzevMembersList().catch(function () { return []; }),
        id ? api.getVzevDiscovered().catch(function () { return []; })
           : Promise.resolve([])
      ]).then(function (res) {
        if (done) return;
        var mem = res[0] || [];
        var disc = res[1] || [];
        setMembers(mem);

        var found = null;
        for (var i = 0; i < mem.length; i++) {
          if (mem[i].id === id) { found = mem[i]; break; }
        }
        if (found) {
          setExisting(true);
          setName(found.name || '');
          setLoc(found.location || found.loc || '');
          setTyp(typOf(found));
          setMp(found.metering_point || '');
          setEntry(tsToDate(found.entry_ts));
        } else if (id) {
          /* new member being onboarded: pre-fill from the discovery entry */
          setExisting(false);
          var dv = null;
          for (var j = 0; j < disc.length; j++) {
            if (disc[j].id === id) { dv = disc[j]; break; }
          }
          if (dv) {
            setName(dv.name || '');
            setLoc(dv.location || dv.loc || '');
            setTyp(typOf(dv));
          }
        }
        setReady(true);
      });
      return function () { done = true; };
    }, [id]);

    /* Single-producer validation (FR-505): count producers other than the one
       being edited; if this form sets Produzent and another already exists,
       block. */
    function producerConflict() {
      if (typ !== 'P') return false;
      for (var i = 0; i < members.length; i++) {
        var m = members[i];
        if (m.id === id) continue;                    /* skip self */
        if (m.type === 'PRODUCER' || m.typ === 'P') return true;
      }
      return false;
    }

    function save() {
      setValErr('');
      if (!name.trim()) { setValErr(t('vzev.form.err.name')); return; }
      if (producerConflict()) { setValErr(t('vzev.form.err.producer')); return; }
      setSaving(true);
      var q = '/api/vzev/members?action=upsert' +
        '&id=' + encodeURIComponent(id || '') +
        '&name=' + encodeURIComponent(name.trim()) +
        '&loc=' + encodeURIComponent(loc.trim()) +
        '&typ=' + encodeURIComponent(typ) +
        '&mp=' + encodeURIComponent(mp.trim());
      /* entry_ts is only sent when a valid date is given (backend leaves any
         existing value untouched when the arg is absent) */
      var ets = dateToTs(entry);
      if (ets !== null) q += '&entry=' + ets;
      api.get(q)
        .then(function () {
          toast(t('vzev.saved'), { type: 'info' });
          router.navigate('/vzev');
        })
        .catch(function () {
          setSaving(false);
          toast(t('vzev.saveerror'), { type: 'error' });
        });
    }

    function remove() {
      setSaving(true);
      api.get('/api/vzev/members?action=remove&id=' + encodeURIComponent(id))
        .then(function () {
          toast(t('vzev.removed'), { type: 'info' });
          router.navigate('/vzev');
        })
        .catch(function () {
          setSaving(false);
          toast(t('vzev.saveerror'), { type: 'error' });
        });
    }

    var title = existing ? t('vzev.form.edit') : t('vzev.form.add');
    var header = html`<${ui.PageHeader} title=${title} subtitle=${t('vzev.form.subtitle')} />`;

    if (!ready) {
      return html`<div>${header}<${ui.Card}><p class="placeholder-text">${t('common.loading')}</p><//></div>`;
    }

    return html`
      <div>
        ${header}
        <${ui.Card} class="vz-form-card">
          <div class="vz-form">
            <${ui.TextField} label=${t('vzev.form.name')} value=${name}
              placeholder=${t('vzev.form.name.ph')}
              onInput=${function (v) { setName(v); }} />
            <${ui.TextField} label=${t('vzev.form.loc')} value=${loc}
              placeholder=${t('vzev.form.loc.ph')}
              onInput=${function (v) { setLoc(v); }} />
            <${ui.Select} label=${t('vzev.form.typ')} value=${typ}
              onChange=${function (v) { setTyp(v); setValErr(''); }}
              options=${[
                { value: 'C', label: t('vzev.type.consumer') },
                { value: 'P', label: t('vzev.type.producer') }
              ]} />

            <${ui.TextField} label=${t('vzev.form.metering_point')} value=${mp}
              placeholder=${t('vzev.form.metering_point.ph')} maxlength=${40}
              onInput=${function (v) { setMp(v); }} />
            <p class="vz-form-hint">${t('vzev.form.metering_point.hint')}</p>

            <label class="field field-block">
              <span class="field-label">${t('vzev.form.entry_ts')}</span>
              <input class="textfield" type="date" value=${entry}
                onInput=${function (e) { setEntry(e.target.value); }} />
            </label>
            <p class="vz-form-hint">${t('vzev.form.entry_ts.hint')}</p>

            ${valErr ? html`<p class="vz-form-err" role="alert">${valErr}</p>` : null}

            <div class="vz-form-actions">
              <${ui.Button} onClick=${save} disabled=${saving}>${t('vzev.form.save')}<//>
              <${ui.Button} secondary onClick=${function () { router.navigate('/vzev'); }}
                disabled=${saving}>${t('vzev.form.cancel')}<//>
              ${existing ? html`
                <${ui.Button} danger onClick=${remove} disabled=${saving}>${t('vzev.remove')}<//>` : null}
            </div>
          </div>
        <//>
      </div>`;
  }

export { VzevMember };
