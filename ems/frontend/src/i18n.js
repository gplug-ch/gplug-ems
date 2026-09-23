/* i18n — flat dot-key dictionary, loaded before first render (FR-203/204/206). */
var dict = {};
  var lang = 'de';
  var warned = {};

  /* t(key, params?) — {name}-style interpolation; missing key returns the
     key itself and warns once (FR-204). */
  function t(key, params) {
    var s = dict[key];
    if (s === undefined) {
      if (!warned[key]) {
        warned[key] = true;
        console.warn('i18n: missing key "' + key + '"');
      }
      return key;
    }
    if (params) {
      s = s.replace(/\{(\w+)\}/g, function (m, name) {
        return params[name] !== undefined ? String(params[name]) : m;
      });
    }
    return s;
  }

  /* Load the first reachable URL from `urls`. The build bakes the list (see
     main.js / vite.config.js __LANG_URLS__): the CDN dictionary alone, or
     /fs?name=lang.json plus on-device fallbacks for self-host; the dev server
     falls back to i18n/de.json (Edge case: lang.json missing on dev server). */
  function load(urls) {
    var i = 0;
    function tryNext() {
      if (i >= urls.length) {
        return Promise.reject(new Error('i18n: no language file reachable'));
      }
      var url = urls[i++];
      return fetch(url)
        .then(function (r) {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.json();
        })
        .then(function (d) {
          dict = d || {};
          lang = dict['meta.lang'] || document.documentElement.lang || 'de';
          return dict;
        })
        .catch(function () { return tryNext(); });
    }
    return tryNext();
  }

export { t };

export const i18n = {
  t: t,
  load: load,
  getLang: function () { return lang; },
  getDict: function () { return dict; }
};
