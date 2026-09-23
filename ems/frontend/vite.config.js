import { defineConfig } from 'vite';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { networkInterfaces } from 'node:os';

// First non-internal IPv4 address of this machine — the dev shell runs on the
// IoT device, so the browser must reach the dev server over the LAN, not
// localhost. Override with DEV_SERVER_URL when auto-detection picks the wrong NIC.
function lanIPv4() {
  for (const nets of Object.values(networkInterfaces())) {
    for (const net of nets || []) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return 'localhost';
}

const DEV_PORT = Number(process.env.DEV_SERVER_PORT || 5173);

/* -------------------------------------------------------------------------
 * Build modes (see README "Build & deploy"). The *asset base* is the single
 * knob that decides where the shipped index.html loads its JS/CSS from:
 *
 *   ASSET_BASE unset | "cdn"  -> https://<CDN_BASE_URL>/<version>/   (default)
 *   ASSET_BASE = "self"       -> /fs?name=...  (assets packed into the .tapp,
 *                                served on-device; restricted-network fallback)
 *   ASSET_BASE = "dev"        -> <DEV_SERVER_URL>/src/entry.js  (loads from a
 *                                running `npm run dev` server, with HMR)
 *   ASSET_BASE = "<url>"      -> https://<url>/<version>/  (internal mirror)
 *
 * The version comes from the repo-root VERSION.txt (the Makefile passes it in as
 * APP_VERSION); a standalone `npm run build` reads the file directly. Output is
 * nested under the version (dist/<version>/) so `wrangler pages deploy dist`
 * publishes assets at https://<host>/<version>/... matching the baked-in base.
 * ------------------------------------------------------------------------- */

const versionFile = fileURLToPath(new URL('../../VERSION.txt', import.meta.url));
const version = (process.env.APP_VERSION ||
  'v' + readFileSync(versionFile, 'utf8').trim()).trim();

const uilang = process.env.UILANG || 'de';
const assetBase = process.env.ASSET_BASE || 'cdn';
const cdnBaseUrl = (process.env.CDN_BASE_URL || 'https://gplug-ch.github.io/gplug-cdn').replace(/\/+$/, '');
const devServerUrl = (process.env.DEV_SERVER_URL || `http://${lanIPv4()}:${DEV_PORT}`).replace(/\/+$/, '');

const isSelf = assetBase === 'self';
const isDev = assetBase === 'dev';

// Tasmota serves every static file through GET /fs?name=<file>. Vite collapses
// a real query string in `base` during URL joining, so self-host builds use a
// sentinel path base and rewrite it to /fs?name= in a post-HTML transform.
const FS_SENTINEL = '/__fs__/';

let base, outDir;
if (isDev) {
  // Shell loads the app straight from a running `npm run dev` server (HMR).
  // The built JS/CSS is discarded; the post-HTML transform swaps in dev tags.
  base = '/';
  outDir = 'dist/dev';
} else if (isSelf) {
  // no directory support on-device -> flatten filenames (no assets/ prefix)
  base = FS_SENTINEL;
  outDir = 'dist/self';
} else {
  const host = assetBase === 'cdn' ? cdnBaseUrl : assetBase.replace(/\/+$/, '');
  base = `${host}/${version}/`;
  outDir = `dist/${version}`;
}

// Merged UI dictionary (de overlaid by <uilang>), mirroring bundle.py:build_lang.
// The device no longer serves lang.json (~21 KB) on every UI load — serving it
// from the .tapp exhausted the ESP32-C3 heap (MEMORY ALLOCATION FAILED in
// _serve_file/_open_bundled). Instead the build publishes it next to the JS/CSS
// bundle, so the browser fetches it from the CDN (or, self-host/dev, on-device
// via /fs?name=lang.json). See __LANG_URLS__ below.
function buildLangDict() {
  const i18nDir = fileURLToPath(new URL('./i18n/', import.meta.url));
  const merged = JSON.parse(readFileSync(i18nDir + 'de.json', 'utf8'));
  if (uilang !== 'de') {
    const overlay = JSON.parse(readFileSync(i18nDir + `${uilang}.json`, 'utf8'));
    Object.assign(merged, overlay);
    merged['meta.lang'] = uilang;
  }
  return merged;
}

// Device endpoints proxied in dev (see `server.proxy` below). `/api` covers
// /api/power|energy|meta|meter|modbus|config; /cm is the Tasmota command
// endpoint used for Wi-Fi settings and restart.
const DEV_DEVICE_URL = process.env.DEV_DEVICE_URL || '';
const DEVICE_PATHS = ['/api', '/loads', '/productions', '/site', '/fs', '/cm'];

export default defineConfig(({ command }) => {
  // Production dictionary URL, baked into the app via __LANG_URLS__: the CDN
  // bundle host for CDN/mirror builds, or /fs?name=lang.json for self-host.
  // Dev does NOT use this — main.js derives the dev-server URL from
  // import.meta.url when import.meta.env.DEV, so the flashed ASSET_BASE=dev
  // shell always loads lang.json from `npm run dev`, never the device.
  const langUrl = isSelf ? '/fs?name=lang.json' : `${base}lang.json`;

  // Ordered fetch list baked into main.js. Only self-host packs lang.json into
  // the .tapp, so only self-host may fall back to the device: in CDN mode that
  // file is absent and, more to the point, an unreachable CDN means the JS
  // bundle never loaded either — there is no app left to translate.
  const langUrls = isSelf
    ? [langUrl, 'lang.json', 'i18n/de.json']
    : [langUrl];

  return {
  // The CDN/self base only applies to the built bundle; the dev server always
  // serves from root so http://<ip>:5173/ works and /i18n/de.json resolves.
  base: command === 'build' ? base : '/',
  define: {
    __LANG_URLS__: JSON.stringify(langUrls),
    __APP_VERSION__: JSON.stringify(version)
  },
  // Bind to all interfaces + fixed port so an ASSET_BASE=dev shell running on
  // the IoT device can reach this server over the LAN. Vite 6 tightened the
  // default CORS policy, so allow cross-origin requests (the shell is served
  // from the device origin, modules are fetched from here) — reflect the
  // requesting origin so the HMR client and module fetches aren't blocked.
  //
  // Talking to a real device from `npm run dev`: the gPlug firmware is built
  // WITHOUT Tasmota's USE_CORS, so it never sends Access-Control-Allow-Origin
  // and a cross-origin `?host=<ip>` fetch from localhost:5173 is blocked by the
  // browser. Set DEV_DEVICE_URL and every device path is proxied through this
  // server instead, so the app talks SAME-ORIGIN and needs no CORS at all:
  //
  //   DEV_DEVICE_URL=http://192.168.1.42 npm run dev   # then open localhost:5173
  //
  // (Leave `?host=` off in that case — it would bypass the proxy.)
  server: {
    host: true,
    port: DEV_PORT,
    strictPort: true,
    cors: { origin: true },
    proxy: DEV_DEVICE_URL ? DEVICE_PATHS.reduce(function (acc, p) {
      acc[p] = { target: DEV_DEVICE_URL, changeOrigin: true };
      return acc;
    }, {}) : undefined,
  },
  build: {
    outDir,
    emptyOutDir: true,
    assetsDir: isSelf ? '.' : 'assets',
    rollupOptions: isSelf
      ? {
          output: {
            entryFileNames: '[name]-[hash].js',
            chunkFileNames: '[name]-[hash].js',
            assetFileNames: '[name]-[hash][extname]',
          },
        }
      : {},
  },
  plugins: [
    {
      // Publish the compiled dictionary alongside the JS/CSS bundle so the
      // browser fetches it from the CDN instead of the device. Cross-origin
      // fetch() needs CORS, so also drop a Cloudflare Pages `_headers` at the
      // deploy root (dist/) granting Access-Control-Allow-Origin. Both are
      // emitted for every build mode — harmless where lang.json is served
      // on-device (self/dev), and it keeps `npm run build && npm run deploy`
      // self-contained (no dependency on the Makefile's bundle.py step).
      name: 'gplug-lang',
      apply: 'build',
      generateBundle() {
        this.emitFile({
          type: 'asset',
          fileName: 'lang.json',
          source: JSON.stringify(buildLangDict()),
        });
      },
      writeBundle() {
        const distRoot = resolve(dirname(outDir));
        writeFileSync(
          resolve(distRoot, '_headers'),
          '/*\n  Access-Control-Allow-Origin: *\n',
        );
      },
    },
    {
      name: 'gplug-html',
      // Runs after Vite injects the hashed asset tags: set <html lang> to the
      // build language (replaces the old Makefile sed) and, for self-host
      // builds, rewrite the sentinel base to the on-device /fs?name= form.
      transformIndexHtml: {
        order: 'post',
        handler(html) {
          html = html.replace(/<html lang="[^"]*">/, `<html lang="${uilang}">`);
          if (isSelf) html = html.split(FS_SENTINEL).join('/fs?name=');
          if (isDev) {
            // Drop the bundled asset tags and load from the dev server instead:
            // the Vite HMR client + the unbundled entry (CSS is injected by JS).
            html = html
              .replace(/\s*<script type="module"[^>]*><\/script>/g, '')
              .replace(/\s*<link rel="stylesheet"[^>]*>/g, '')
              .replace(
                '</head>',
                `  <script type="module" src="${devServerUrl}/@vite/client"></script>\n` +
                `  <script type="module" src="${devServerUrl}/src/entry.js"></script>\n</head>`,
              );
          }
          return html;
        },
      },
    },
  ],
  };
});
