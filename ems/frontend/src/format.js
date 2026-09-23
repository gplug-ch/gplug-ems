/* Formatters — single module used by all pages (FR-205, "Dimensionen konsistent").
   Number style: de-CH with apostrophe thousands separator, e.g. 2'247.86. */

  var NBSP = ' ';
  var MINUS = '−';

  /* de-CH number: apostrophe thousands, fixed decimals. */
  function fmtNum(v, decimals) {
    if (v === null || v === undefined || isNaN(v)) return '–';
    var neg = v < 0;
    var s = Math.abs(Number(v)).toFixed(decimals);
    var parts = s.split('.');
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, "'");
    s = parts.join('.');
    return (neg ? MINUS : '') + s;
  }

  /* Trim a fixed-decimal string: 1.0 -> 1, 1.40 -> 1.4 */
  function trim(s) {
    return s.indexOf('.') >= 0 ? s.replace(/\.?0+$/, '') : s;
  }

  /* fmtW(w) -> "1.4 kW" / "350 W" (auto-scale, 1 decimal max) */
  function fmtW(w) {
    if (w === null || w === undefined || isNaN(w)) return '–';
    if (Math.abs(w) >= 1000) return trim(fmtNum(w / 1000, 1)) + NBSP + 'kW';
    return fmtNum(Math.round(w), 0) + NBSP + 'W';
  }

  /* fmtWh(wh) -> "1.28 kWh" / "917 Wh" */
  function fmtWh(wh) {
    if (wh === null || wh === undefined || isNaN(wh)) return '–';
    if (Math.abs(wh) >= 1000) return fmtNum(wh / 1000, 2) + NBSP + 'kWh';
    return fmtNum(Math.round(wh), 0) + NBSP + 'Wh';
  }

  /* fmtChf(v, signed?) -> "+0.19 CHF" / "−367.32 CHF" (signed for balances) */
  function fmtChf(v, signed) {
    if (v === null || v === undefined || isNaN(v)) return '–';
    var s = fmtNum(v, 2);
    if (signed && v > 0) s = '+' + s;
    return s + NBSP + 'CHF';
  }

  function p2(n) { return (n < 10 ? '0' : '') + n; }

  /* fmtTime(ts, res) — ts: UTC epoch seconds, rendered in local time.
     res: '15m' -> 24.05.2026 17:15 | '1d' -> 24.05.2026 | '1mo' -> 05.2026
     'q' -> 2026 Q2 | 'hm' -> 17:15 | 'dm' -> 24.05. (compact axis ticks) */
  function fmtTime(ts, res) {
    if (ts === null || ts === undefined) return '–';
    var d = new Date(ts * 1000);
    var date = p2(d.getDate()) + '.' + p2(d.getMonth() + 1) + '.' + d.getFullYear();
    var hm = p2(d.getHours()) + ':' + p2(d.getMinutes());
    switch (res) {
      case '1d': return date;
      case 'dm': return p2(d.getDate()) + '.' + p2(d.getMonth() + 1) + '.';
      case '1mo': return p2(d.getMonth() + 1) + '.' + d.getFullYear();
      case 'q': return d.getFullYear() + ' Q' + (Math.floor(d.getMonth() / 3) + 1);
      case 'hm': return hm;
      case '15m':
      default: return date + ' ' + hm;
    }
  }

export const fmt = {
  num: fmtNum,
  w: fmtW,
  wh: fmtWh,
  chf: fmtChf,
  time: fmtTime,
  MINUS: MINUS
};
