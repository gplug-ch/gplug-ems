/* Hand-rolled SVG charts (FR-211) — LineChart + BarChart.
   Axis labels with units are mandatory (review feedback): y-unit top-left
   ("[kW]"), x-unit bottom-right ("[h]" or localized time ticks).
   Both accept an explicit timeWindow=[t0,t1] (epoch seconds) so multiple
   charts can share the exact same x-range (003 FR-304). */
import { html, useState, useEffect, useRef } from './core.js';
import { fmt } from './format.js';

  var M = { top: 22, right: 14, bottom: 24, left: 46 };

  /* measure the rendered width of a container element */
  function useWidth(ref) {
    var st = useState(0);
    var width = st[0], setWidth = st[1];
    useEffect(function () {
      function measure() {
        if (ref.current) {
          var w = ref.current.clientWidth;
          if (w && w !== width) setWidth(w);
        }
      }
      measure();
      window.addEventListener('resize', measure);
      return function () { window.removeEventListener('resize', measure); };
    });
    return width;
  }

  /* "nice" tick values for a numeric domain, ~n ticks */
  function niceTicks(min, max, n) {
    if (min === max) { max = min + 1; }
    var span = max - min;
    var step = Math.pow(10, Math.floor(Math.log10(span / n)));
    var err = span / (n * step);
    if (err >= 7.5) step *= 10;
    else if (err >= 3.5) step *= 5;
    else if (err >= 1.5) step *= 2;
    var ticks = [];
    var start = Math.ceil(min / step) * step;
    for (var v = start; v <= max + step * 1e-9; v += step) {
      ticks.push(Math.abs(v) < step * 1e-9 ? 0 : v);
    }
    return ticks;
  }

  function tickLabel(v) {
    if (Math.abs(v) >= 1000) return fmt.num(v / 1000, 1).replace(/\.0$/, '') + 'k';
    return fmt.num(Math.round(v * 100) / 100, Math.abs(v) < 10 && v % 1 !== 0 ? 1 : 0);
  }

  function timeTicks(t0, t1, n) {
    var ticks = [];
    for (var i = 0; i <= n; i++) ticks.push(t0 + (t1 - t0) * (i / n));
    return ticks;
  }

  /* Bar-chart x-ticks: pick ticks at ACTUAL bar timestamps (evenly sampled by
     index, always incl. first + last), never at interpolated positions. This
     guarantees every label lines up with a bar and — since each bar is a
     distinct time bucket — that coarse formats (day/month/quarter) can't emit
     the same label twice for two adjacent ticks. `fmtLabel` is consulted to
     drop a tick that would repeat the previous one (belt-and-suspenders). */
  function barTickIdx(pts, innerW, fmtLabel) {
    var n = pts.length;
    if (!n) return [];
    var maxTicks = Math.max(2, Math.min(n, Math.floor(innerW / 64)));
    var idxs = [];
    if (n <= maxTicks) {
      for (var i = 0; i < n; i++) idxs.push(i);
    } else {
      for (var k = 0; k < maxTicks; k++) idxs.push(Math.round(k * (n - 1) / (maxTicks - 1)));
    }
    var out = [], prev = null, lastI = -1;
    idxs.forEach(function (idx) {
      if (idx === lastI) return; /* rounding can repeat an index */
      lastI = idx;
      var lab = fmtLabel(pts[idx].t);
      if (lab === prev) return;  /* never repeat the previous label */
      prev = lab;
      out.push(idx);
    });
    return out;
  }

  /* ts-returning wrapper (kept for tests / external callers). */
  function barTicks(pts, innerW, fmtLabel) {
    return barTickIdx(pts, innerW, fmtLabel).map(function (i) { return pts[i].t; });
  }

  /* Signed stack extents of one (sub-)bar → [up, down]. Positive and negative
     segment totals stay separate: a slot stacking 3 kWh up and 2 kWh down must
     size the y-domain to [-2, 3], not to their sum (issue #17). */
  function stackExtents(bar) {
    var up = 0, down = 0;
    ((bar && bar.segments) || []).forEach(function (s) {
      var v = s.value || 0;
      if (v > 0) up += v; else down += v;
    });
    return [up, down];
  }

  function yDomain(values, forceZero) {
    var min = Infinity, max = -Infinity;
    values.forEach(function (v) {
      if (v === null || v === undefined || isNaN(v)) return;
      if (v < min) min = v;
      if (v > max) max = v;
    });
    if (min === Infinity) { min = 0; max = 1; }
    if (forceZero || min > 0) min = Math.min(0, min);
    if (max < 0) max = 0;
    if (min === max) max = min + 1;
    var pad = (max - min) * 0.08;
    return [min < 0 ? min - pad : min, max + pad];
  }

  /* shared frame: gridlines, axes, unit labels */
  function Frame(o) {
    return html`
      <g>
        ${o.yTicks.map(function (v) {
          var y = o.sy(v);
          return html`
            <g key=${'y' + v}>
              <line x1=${M.left} x2=${o.width - M.right} y1=${y} y2=${y}
                class=${v === 0 ? 'ch-zero' : 'ch-grid'} />
              <text x=${M.left - 8} y=${y + 3.5} class="ch-tick" text-anchor="end">${tickLabel(v)}</text>
            </g>`;
        })}
        ${o.xTicks.map(function (tk, i) {
          /* xTicks are precomputed {x, label}: line charts position by time,
             bar charts by ordinal bar centre — Frame just places the text. */
          if (tk.x > o.width - M.right - 34) return null;
          return html`
            <text key=${'x' + i} x=${tk.x} y=${o.height - 7} class="ch-tick" text-anchor="middle">${tk.label}</text>`;
        })}
        <line x1=${M.left} x2=${M.left} y1=${M.top - 6} y2=${o.height - M.bottom}
          class="ch-axis" />
        <text x=${M.left - 40} y=${M.top - 9} class="ch-unit">[${o.yUnit}]</text>
        <text x=${o.width - M.right} y=${o.height - 7} class="ch-unit" text-anchor="end">[${o.xUnit}]</text>
      </g>`;
  }

  /* nearest sample index in pts for time tx */
  function nearestIdx(pts, tx) {
    var best = -1, bd = Infinity;
    for (var i = 0; i < pts.length; i++) {
      if (pts[i].y === null || pts[i].y === undefined) continue;
      var d = Math.abs(pts[i].t - tx);
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }

  /* pair up two point arrays by shared timestamp (points missing on either
     side are dropped — a band segment needs both values) */
  function mergeByTime(top, bottom) {
    var bm = {};
    bottom.forEach(function (p) {
      if (p.y !== null && p.y !== undefined) bm[p.t] = p.y;
    });
    var out = [];
    top.forEach(function (p) {
      if (p.y === null || p.y === undefined) return;
      if (bm[p.t] === undefined) return;
      out.push({ t: p.t, top: p.y, bottom: bm[p.t] });
    });
    return out;
  }

  /* filled polygons covering only the stretches where top > bottom, with an
     interpolated point inserted at each crossing so the fill edge meets the
     two lines exactly instead of jumping between samples. */
  function bandPaths(top, bottom, sx, sy) {
    var m = mergeByTime(top, bottom);
    var polys = [];
    if (m.length < 2) return polys;

    var run = [];
    function flush() {
      if (run.length >= 2) {
        var d = 'M' + sx(run[0].t).toFixed(1) + ' ' + sy(run[0].top).toFixed(1);
        var i;
        for (i = 1; i < run.length; i++) d += 'L' + sx(run[i].t).toFixed(1) + ' ' + sy(run[i].top).toFixed(1);
        for (i = run.length - 1; i >= 0; i--) d += 'L' + sx(run[i].t).toFixed(1) + ' ' + sy(run[i].bottom).toFixed(1);
        polys.push(d + 'Z');
      }
      run = [];
    }

    for (var idx = 0; idx < m.length; idx++) {
      var p = m[idx];
      var diff = p.top - p.bottom;
      if (diff > 0) run.push(p); else flush();

      if (idx < m.length - 1) {
        var q = m[idx + 1];
        var dq = q.top - q.bottom;
        if ((diff > 0) !== (dq > 0) && diff !== dq) {
          var frac = diff / (diff - dq);
          run.push({
            t: p.t + (q.t - p.t) * frac,
            top: p.top + (q.top - p.top) * frac,
            bottom: p.bottom + (q.bottom - p.bottom) * frac
          });
          if (diff > 0) flush();
        }
      }
    }
    flush();
    return polys;
  }

  function hoverBox(ref, wrapWidth, x, lines) {
    var flip = x > wrapWidth - 150;
    return html`
      <div class="ch-hover" style=${'left:' + x + 'px;' + (flip ? 'transform:translateX(calc(-100% - 10px))' : 'transform:translateX(10px)')}>
        ${lines.map(function (l, i) {
          return html`
            <div key=${i} class="ch-hover-line">
              ${l.color ? html`<span class="ch-hover-dot" style=${'background:' + l.color}></span>` : null}
              <span>${l.text}</span>
            </div>`;
        })}
      </div>`;
  }

  /* ---- LineChart ----
     series: [{points:[{t,y|null}], color, fill?, label}]
     null y values render as gaps (missing data — spec 001 UC-104).
     bands?: [{top:points, bottom:points, color}] — fills the area between
     two point arrays, only where top > bottom (e.g. production surplus). */
  function LineChart(props) {
    var wrapRef = useRef(null);
    var width = useWidth(wrapRef);
    var hovSt = useState(null);
    var hover = hovSt[0], setHover = hovSt[1];

    var height = props.height || 180;
    var series = props.series || [];

    var tw = props.timeWindow;
    if (!tw) {
      var lo = Infinity, hi = -Infinity;
      series.forEach(function (s) {
        s.points.forEach(function (p) {
          if (p.t < lo) lo = p.t;
          if (p.t > hi) hi = p.t;
        });
      });
      tw = lo === Infinity ? [0, 1] : [lo, hi];
    }
    var t0 = tw[0], t1 = tw[1] > tw[0] ? tw[1] : tw[0] + 1;

    var allY = [];
    series.forEach(function (s) {
      s.points.forEach(function (p) { allY.push(p.y); });
    });
    var dom = yDomain(allY, false);

    var innerW = Math.max(10, width - M.left - M.right);
    var innerH = height - M.top - M.bottom;
    function sx(ts) { return M.left + ((ts - t0) / (t1 - t0)) * innerW; }
    function sy(v) { return M.top + (1 - (v - dom[0]) / (dom[1] - dom[0])) * innerH; }

    var yTicks = niceTicks(dom[0], dom[1], 4);
    var xTickFormat = props.xTickFormat || function (ts) { return fmt.time(ts, 'hm'); };
    var xTicks = timeTicks(t0, t1, Math.max(2, Math.min(5, Math.floor(innerW / 90))))
      .map(function (ts) { return { x: sx(ts), label: xTickFormat(ts) }; });

    /* build line + area paths, splitting at null gaps */
    function paths(pts) {
      var segs = [], cur = [];
      pts.forEach(function (p) {
        if (p.y === null || p.y === undefined) {
          if (cur.length) segs.push(cur);
          cur = [];
        } else cur.push(p);
      });
      if (cur.length) segs.push(cur);
      var y0 = sy(Math.max(0, dom[0]));
      return segs.map(function (seg) {
        var line = seg.map(function (p, i) {
          return (i === 0 ? 'M' : 'L') + sx(p.t).toFixed(1) + ' ' + sy(p.y).toFixed(1);
        }).join('');
        var area = line +
          'L' + sx(seg[seg.length - 1].t).toFixed(1) + ' ' + y0.toFixed(1) +
          'L' + sx(seg[0].t).toFixed(1) + ' ' + y0.toFixed(1) + 'Z';
        return { line: line, area: area };
      });
    }

    function onMove(e) {
      if (!wrapRef.current) return;
      var rect = wrapRef.current.getBoundingClientRect();
      var px = e.clientX - rect.left;
      if (px < M.left || px > width - M.right) { setHover(null); return; }
      var tx = t0 + ((px - M.left) / innerW) * (t1 - t0);
      setHover(tx);
    }

    var hoverX = null, hoverLines = [];
    if (hover !== null) {
      hoverLines.push({ text: xTickFormat(hover) });
      series.forEach(function (s) {
        var i = nearestIdx(s.points, hover);
        if (i >= 0) {
          if (hoverX === null) hoverX = sx(s.points[i].t);
          hoverLines.push({
            color: s.color,
            text: (s.label ? s.label + ': ' : '') + (props.yFormat || tickLabel)(s.points[i].y) +
                  (props.yFormat ? '' : ' ' + props.yUnit)
          });
        }
      });
      if (hoverX === null) hoverX = sx(hover);
    }

    return html`
      <div class="chart" ref=${wrapRef}
        onPointerMove=${onMove}
        onPointerLeave=${function () { setHover(null); }}>
        ${width > 0 ? html`
          <svg width=${width} height=${height} role="img" aria-label=${props.label || ''}>
            <${Frame} width=${width} height=${height} sy=${sy}
              yTicks=${yTicks} xTicks=${xTicks}
              yUnit=${props.yUnit || 'kW'} xUnit=${props.xUnit || 'h'} />
            ${(props.bands || []).map(function (band, bandi) {
              return bandPaths(band.top, band.bottom, sx, sy).map(function (d, bi) {
                return html`<path key=${bandi + '-' + bi} class="ch-band" d=${d} fill=${band.color} stroke="none"/>`;
              });
            })}
            ${series.map(function (s, si) {
              return paths(s.points).map(function (p, pi) {
                return html`
                  <g key=${si + '-' + pi}>
                    ${s.fill ? html`<path class="ch-area" d=${p.area} fill=${s.fill} opacity="0.55" stroke="none"/>` : null}
                    <path class="ch-line" pathLength="1" d=${p.line} fill="none" stroke=${s.color} stroke-width="2"
                      stroke-linejoin="round" stroke-linecap="round"/>
                  </g>`;
              });
            })}
            ${hoverX !== null ? html`
              <line x1=${hoverX} x2=${hoverX} y1=${M.top - 4} y2=${height - M.bottom} class="ch-crosshair"/>
              ${series.map(function (s, si) {
                var i = nearestIdx(s.points, hover);
                return i >= 0 ? html`
                  <circle key=${si} cx=${sx(s.points[i].t)} cy=${sy(s.points[i].y)} r="3.5"
                    fill=${s.color} stroke="#fff" stroke-width="1.5"/>` : null;
              })}` : null}
          </svg>
          ${hoverX !== null ? hoverBox(wrapRef, width, hoverX, hoverLines) : null}` : null}
      </div>`;
  }

  /* ---- BarChart ----
     Sign convention (issue #17, app-wide): what the site GIVES is drawn above
     the 0-axis, what it TAKES below it. `signedMagnitude` says the sign encodes
     that direction rather than the quantity, so the tooltip prints |value| next
     to the point's/segment's own label.

     Simple mode:  points: [{t, y, color?, label?}] — one bar per point, anchored
       at a visible 0-axis; negative values render below the axis.
     Grouped/stacked mode (spec 008 Bilanz):  points: [{t, bars:[{segments:
       [{value, color, label?}]}, …]}] — each point holds N side-by-side bars,
       each a SIGNED stack: positive segments stack upward from the 0-axis,
       negative ones downward (issue #17 — grid import below the axis). The
       y-domain uses each sub-bar's positive and negative totals separately, so
       an up-stack and a down-stack can never cancel each other out. Existing
       simple-mode call sites are unaffected (the `bars` branch only triggers
       when present).
   */
  function BarChart(props) {
    var wrapRef = useRef(null);
    var width = useWidth(wrapRef);
    var hovSt = useState(null);
    var hover = hovSt[0], setHover = hovSt[1];

    var height = props.height || 180;
    var pts = props.points || [];

    function pointValues(p) {
      if (!p.bars) return [p.y];
      var out = [];
      p.bars.forEach(function (b) {
        stackExtents(b).forEach(function (v) { out.push(v); });
      });
      return out;
    }
    var nBars = pts.reduce(function (m, p) {
      return p.bars ? Math.max(m, p.bars.length) : m;
    }, 1);

    var domVals = [];
    pts.forEach(function (p) { pointValues(p).forEach(function (v) { domVals.push(v); }); });
    var dom = yDomain(domVals, true);

    var innerW = Math.max(10, width - M.left - M.right);
    var innerH = height - M.top - M.bottom;
    function sy(v) { return M.top + (1 - (v - dom[0]) / (dom[1] - dom[0])) * innerH; }

    /* Ordinal x-axis: one evenly-spaced slot per point. A bar chart is
       categorical, so bars are placed by index — NOT by timestamp. This makes
       the layout immune to timestamp gaps, outliers and irregular month/quarter
       lengths (a time-proportional x-axis collapsed every bar into one edge when
       the span was large, e.g. the 15-min/hour views). */
    var n = pts.length;
    var pitch = n > 0 ? innerW / n : innerW;
    function slotCenter(i) { return M.left + (i + 0.5) * pitch; }
    /* leave a proportional gap between bars; never wider than ~46px, never < 1 */
    var barW = Math.max(1, Math.min(pitch - 1, pitch * 0.72, 46));

    var yTicks = niceTicks(dom[0], dom[1], 4);
    var xTickFormat = props.xTickFormat || function (ts) { return fmt.time(ts, 'hm'); };
    var xTicks = barTickIdx(pts, innerW, xTickFormat).map(function (i) {
      return { x: slotCenter(i), label: xTickFormat(pts[i].t) };
    });
    var y0px = sy(0);

    /* Data signature: keys the bar layer so the grow-in animation REPLAYS when
       the data/mode changes (resolution switch, net↔bilanz, kWh↔CHF) but NOT on
       hover or resize (those keep the same signature, so the DOM persists). */
    var sig = pts.length + '|' + (pts.length ? pts[0].t + '-' + pts[pts.length - 1].t : '') +
      '|' + nBars + '|' + (props.yUnit || '');

    function onMove(e) {
      if (!wrapRef.current || !n) { setHover(null); return; }
      var rect = wrapRef.current.getBoundingClientRect();
      var px = e.clientX - rect.left;
      if (px < M.left || px > width - M.right) { setHover(null); return; }
      var idx = Math.floor((px - M.left) / pitch);
      setHover(idx < 0 ? 0 : idx >= n ? n - 1 : idx);
    }

    var fmtY = props.yFormat || tickLabel;
    function valText(v) { return fmtY(v) + (props.yFormat ? '' : ' ' + (props.yUnit || '')); }

    var hoverX = null, hoverLines = [];
    if (hover !== null && pts[hover]) {
      var hp = pts[hover];
      hoverX = slotCenter(hover);
      hoverLines.push({ text: xTickFormat(hp.t) });
      if (hp.bars) {
        hp.bars.forEach(function (b) {
          (b.segments || []).forEach(function (s) {
            if (!s.value) return;
            /* a downward segment is a magnitude on the other side of the axis,
               not a negative quantity — the label/colour carries the direction */
            var sv = props.signedMagnitude ? Math.abs(s.value) : s.value;
            hoverLines.push({ color: s.color, text: (s.label ? s.label + ': ' : '') + valText(sv) });
          });
        });
      } else if (hp.y !== null && hp.y !== undefined) {
        var yv = props.signedMagnitude ? Math.abs(hp.y) : hp.y;
        hoverLines.push({ color: hp.color || props.color,
          text: (hp.label ? hp.label + ': ' : '') + valText(yv) });
      }
    }

    return html`
      <div class="chart" ref=${wrapRef}
        onPointerMove=${onMove}
        onPointerLeave=${function () { setHover(null); }}>
        ${width > 0 ? html`
          <svg width=${width} height=${height} role="img" aria-label=${props.label || ''}>
            <${Frame} width=${width} height=${height} sy=${sy}
              yTicks=${yTicks} xTicks=${xTicks}
              yUnit=${props.yUnit || 'kWh'} xUnit=${props.xUnit || 't'} />
            <g class="ch-bars" key=${sig}>
            ${pts.map(function (p, i) {
              var op = hover === i ? '1' : '0.85';
              if (p.bars) {
                /* grouped/stacked: split the slot width into nBars sub-bars,
                   each stacking its segments upward from the 0-axis. The grow
                   animation lives on each segment <rect> (not the sub-bar <g>):
                   transform-box:fill-box is reliable on rects but flaky on <g>,
                   where it could leave the whole bar stuck at scaleY(0). */
                var gLeft = slotCenter(i) - barW / 2;
                var subW = barW / nBars;
                return html`<g key=${i}>${p.bars.map(function (b, bi) {
                  var bx = gLeft + bi * subW + 1;
                  var bw = Math.max(1, subW - 2);
                  var accUp = 0, accDown = 0;
                  return (b.segments || []).map(function (s, si) {
                    var val = s.value || 0;
                    if (!val) return null;
                    var from, to;
                    if (val > 0) { from = accUp; to = accUp + val; accUp = to; }
                    else { from = accDown; to = accDown + val; accDown = to; }
                    var yTopPx = Math.min(sy(from), sy(to));
                    var hPx = Math.max(1, Math.abs(sy(to) - sy(from)));
                    return html`
                      <rect key=${bi + '-' + si}
                        class=${'ch-bar ' + (val > 0 ? 'ch-bar-up' : 'ch-bar-down')}
                        x=${bx.toFixed(1)} y=${yTopPx.toFixed(1)}
                        width=${bw.toFixed(1)} height=${hPx.toFixed(1)} rx="1.5"
                        fill=${s.color} opacity=${op}/>`;
                  });
                })}</g>`;
              }
              if (p.y === null || p.y === undefined) return null;
              var x = slotCenter(i) - barW / 2;
              var yv = sy(p.y);
              var yTop = Math.min(yv, y0px);
              var h = Math.max(1, Math.abs(yv - y0px));
              return html`
                <rect key=${i} class=${'ch-bar ' + (p.y < 0 ? 'ch-bar-down' : 'ch-bar-up')}
                  x=${x.toFixed(1)} y=${yTop.toFixed(1)}
                  width=${barW.toFixed(1)} height=${h.toFixed(1)} rx="2"
                  fill=${p.color || props.color || 'var(--c-consumption)'}
                  opacity=${op}/>`;
            })}
            </g>
            <line x1=${M.left} x2=${width - M.right} y1=${y0px} y2=${y0px} class="ch-zero-strong"/>
          </svg>
          ${hoverX !== null ? hoverBox(wrapRef, width, hoverX, hoverLines) : null}` : null}
      </div>`;
  }

export { LineChart, BarChart, barTicks, stackExtents, yDomain };
