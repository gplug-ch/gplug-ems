(function () {
  var RINGS = [
    { id: '15m',     label: '15-min intervals', count: 48 },
    { id: 'daily',   label: 'Daily',             count: 30 },
    { id: 'monthly', label: 'Monthly',            count: 18 }
  ];
  var FIELDS = ['import_wh', 'export_wh', 'pv_wh'];
  var COLORS = { import_wh: '#e74c3c', export_wh: '#2ecc71', pv_wh: '#f1c40f' };
  var LABELS = { import_wh: 'Import', export_wh: 'Export', pv_wh: 'PV' };

  function fmtTime(ts, ring) {
    var d = new Date(ts * 1000);
    if (ring === '15m')   return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (ring === 'daily') return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
    return d.toLocaleDateString([], { year: 'numeric', month: 'short' });
  }

  function fmtWh(v) {
    return v >= 1000 ? (v / 1000).toFixed(1) + 'k' : String(v);
  }

  function drawChart(records, ring) {
    if (!records.length) return '<p class="empty">No data yet</p>';

    var W = 760, H = 180, PL = 36, PR = 6, PT = 8, PB = 28;
    var cW = W - PL - PR, cH = H - PT - PB;
    var n = records.length;

    var max = 1;
    records.forEach(function (r) {
      FIELDS.forEach(function (f) { if (r[f] > max) max = r[f]; });
    });

    var groupW = cW / n;
    var bw = Math.max(1, Math.min(Math.floor(groupW / (FIELDS.length + 1)), 20));

    var bars = '', xlabels = '';
    var step = Math.max(1, Math.floor(n / 8));

    records.forEach(function (r, i) {
      var gx = PL + i * groupW;
      FIELDS.forEach(function (f, j) {
        var bh = Math.round((r[f] / max) * cH);
        if (bh < 1 && r[f] > 0) bh = 1;
        var x = Math.round(gx + j * (bw + 1));
        var y = PT + cH - bh;
        bars += '<rect x="' + x + '" y="' + y + '" width="' + bw + '" height="' + bh +
          '" fill="' + COLORS[f] + '" opacity="0.85"/>';
      });
      if (i % step === 0 || i === n - 1) {
        var lx = Math.round(gx + groupW / 2);
        xlabels += '<text x="' + lx + '" y="' + (H - 6) + '" font-size="9" text-anchor="middle" fill="#555">' +
          fmtTime(r.ts, ring) + '</text>';
      }
    });

    var ylines = '';
    for (var t = 0; t <= 4; t++) {
      var y = Math.round(PT + cH - (t / 4) * cH);
      ylines += '<line x1="' + PL + '" y1="' + y + '" x2="' + (W - PR) + '" y2="' + y +
        '" stroke="#1e2a4a" stroke-width="1"/>';
      ylines += '<text x="' + (PL - 3) + '" y="' + (y + 3) + '" font-size="9" text-anchor="end" fill="#444">' +
        fmtWh(Math.round((t / 4) * max)) + '</text>';
    }

    return '<svg viewBox="0 0 ' + W + ' ' + H + '" style="width:100%;height:auto;display:block">' +
      ylines + bars + xlabels + '</svg>';
  }

  function legend() {
    return '<div class="legend">' + FIELDS.map(function (f) {
      return '<span><i class="dot" style="background:' + COLORS[f] + '"></i>' + LABELS[f] + ' (Wh)</span>';
    }).join('') + '</div>';
  }

  function render(data, hasErr) {
    var html = '<h1>gPlug Energy Monitor</h1>';
    html += '<p class="ts">Updated: ' + new Date().toLocaleString() +
      (hasErr ? ' &mdash; <span class="err">fetch error</span>' : '') + '</p>';
    RINGS.forEach(function (ring) {
      var records = data[ring.id] || [];
      html += '<section>';
      html += '<h2>' + ring.label + ' <span class="cnt">(' + records.length + ' records)</span></h2>';
      html += legend();
      html += drawChart(records, ring.id);
      html += '</section>';
    });
    document.getElementById('app').innerHTML = html;
  }

  function fetchAll() {
    var data = {}, done = 0, hasErr = false;
    RINGS.forEach(function (ring) {
      fetch('/api/energy?ring=' + ring.id + '&count=' + ring.count)
        .then(function (r) { return r.json(); })
        .then(function (d) { data[ring.id] = d; })
        .catch(function () { data[ring.id] = []; hasErr = true; })
        .then(function () { if (++done === RINGS.length) render(data, hasErr); });
    });
  }

  fetchAll();
  setInterval(fetchAll, 5000);
}());
