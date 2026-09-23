/* Hash router (FR-213). Routes: #/, #/verlauf, #/vzev, #/vzev/mitglied/:id?,
   #/vzev/abrechnung, #/einstellungen/:tab? — unknown routes render Übersicht.
   #/demo is a hidden route rendering every shared component. */
import { useState, useEffect } from './core.js';

  /* pattern: '/vzev/mitglied/:id?' — ':name' = required, ':name?' = optional */
  function match(pattern, path) {
    var pp = pattern.split('/').filter(function (s) { return s !== ''; });
    var pa = path.split('/').filter(function (s) { return s !== ''; });
    var params = {};
    var i;
    for (i = 0; i < pp.length; i++) {
      var seg = pp[i];
      if (seg.charAt(0) === ':') {
        var optional = seg.slice(-1) === '?';
        var name = seg.replace(/^:/, '').replace(/\?$/, '');
        if (pa[i] === undefined) {
          if (optional) continue;
          return null;
        }
        params[name] = decodeURIComponent(pa[i]);
      } else if (seg !== pa[i]) {
        return null;
      }
    }
    if (pa.length > pp.length) return null;
    return params;
  }

  function parse(routes) {
    var hash = window.location.hash || '#/';
    var path = hash.replace(/^#/, '').split('?')[0] || '/';
    for (var i = 0; i < routes.length; i++) {
      var params = match(routes[i].path, path);
      if (params) return { route: routes[i], params: params, path: path };
    }
    /* unknown -> Übersicht (FR-213) */
    return { route: routes[0], params: {}, path: '/' };
  }

  function useRoute(routes) {
    var st = useState(function () { return parse(routes); });
    var setCur = st[1];
    useEffect(function () {
      function onHash() { setCur(parse(routes)); }
      window.addEventListener('hashchange', onHash);
      return function () { window.removeEventListener('hashchange', onHash); };
    }, []);
    return st[0];
  }

export const router = {
  match: match,
  parse: parse,
  useRoute: useRoute,
  navigate: function (path) { window.location.hash = '#' + path; }
};
