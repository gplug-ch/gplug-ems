/* Pure CSV builder for the Verlauf export (spec 004 FR-403, UC-403). No DOM —
   unit-testable under `node`. Swiss-Excel dialect: `;` field separator,
   decimal point, UTF-8 BOM prepended, CRLF line endings. The header row and
   the value strings are supplied by the caller (already i18n'd / formatted),
   so this module only handles structure + escaping. */
var BOM = '﻿';
  var SEP = ';';
  var EOL = '\r\n';

  /* Escape one field for `;`-separated CSV: wrap in double quotes and double
     any embedded quote when the value contains a separator, quote, or newline.
     null/undefined → empty field. */
  function escapeField(v) {
    if (v === null || v === undefined) return '';
    var s = String(v);
    if (s.indexOf(SEP) >= 0 || s.indexOf('"') >= 0 ||
        s.indexOf('\n') >= 0 || s.indexOf('\r') >= 0) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  }

  function row(fields) {
    return (fields || []).map(escapeField).join(SEP);
  }


  /* parse(text) — inverse of build() for the archive export/import round-trip
     (spec 011 FR-1110). Strips the BOM, accepts CRLF or LF, honours quoted
     fields with doubled quotes, and returns an array of string arrays. A
     trailing newline does not produce an empty row. */
  function parse(text) {
    var s = String(text || '');
    if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1);
    var rows = [], row = [], field = '', quoted = false, i = 0;
    function endField() { row.push(field); field = ''; }
    function endRow() { endField(); rows.push(row); row = []; }
    while (i < s.length) {
      var c = s[i];
      if (quoted) {
        if (c === '"') {
          if (s[i + 1] === '"') { field += '"'; i += 2; continue; }
          quoted = false; i++; continue;
        }
        field += c; i++; continue;
      }
      if (c === '"' && field === '') { quoted = true; i++; continue; }
      if (c === SEP) { endField(); i++; continue; }
      if (c === '\r') { i++; continue; }
      if (c === '\n') { endRow(); i++; continue; }
      field += c; i++;
    }
    if (field !== '' || row.length) endRow();
    return rows;
  }

  /* build(header, rows) — header: array of strings; rows: array of arrays.
     Returns the full CSV text including the BOM. */
  function build(header, rows) {
    var lines = [row(header)];
    (rows || []).forEach(function (r) { lines.push(row(r)); });
    return BOM + lines.join(EOL) + EOL;
  }

  /* filename(res, date?) — `gplug-verlauf-<res>-<YYYYMMDD>.csv`. `date` is a
     JS Date (defaults to now); the stamp is local date. */
  function filename(res, date) {
    var d = date || new Date();
    function p2(n) { return (n < 10 ? '0' : '') + n; }
    var stamp = d.getFullYear() + p2(d.getMonth() + 1) + p2(d.getDate());
    return 'gplug-verlauf-' + res + '-' + stamp + '.csv';
  }

export { escapeField, row, build, parse, filename };
