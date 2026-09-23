# EMS — developer guide

The EMS is the part that runs on the gPlug: a **Tasmota Berry backend**
(`backend/`) packaged as a `.tapp`, and a **Preact + htm frontend**
(`frontend/`) whose bundle is normally served from a CDN and only reaches the
device as a small `index.html` shell.

The two halves have a clear split (see the
[root README](../README.md#where-computation-happens)): the device runs the
allocation loop, samples power and stores raw 15-min records; **everything
derived — roll-ups, CHF costs, config validation — happens in the browser.** So most feature work is frontend work,
and the frontend can be developed on your laptop against a real device.

---

## Prerequisites

| Tool | Used for | Notes |
|------|----------|-------|
| `make`, `zip`, `python3` | building the `.tapp` | `python3` runs `minify.py` and `bundle.py` |
| [Berry CLI](https://github.com/berry-lang/berry) (`berry`) | running the backend tests | build it once from `master` (the `v1.1.0` tag lacks the `-m` option the tests use; CI pins a commit in `.github/workflows/ci.yml`), put it on `$PATH` |
| Node.js + npm | frontend dev server and Vite build | Node 20+ |
| `curl` | `make flash` | talks to the device's Tasmota HTTP API |
| A gPlug (ESP32-C3) with Tasmota | running the backend | any Tasmota build with Berry + the filesystem; **no `USE_CORS`** — see [CORS](#cors) |

---

## Backend development

Sources live in `backend/`; all `make` targets run from the repo root
(`make help` lists them).

```bash
make test-backend                           # all Berry tests
make test                                   # Berry + frontend tests
cd ems/backend/tests && berry -m .. test_ems_allocation.be   # one test file
```

`-m ..` puts `backend/` on the Berry module path so `import ems` resolves.
Tests run in the plain Berry CLI, which has no `tasmota`, `webserver` or
`webclient` — `tests/tasmota.be` and `tests/webserver.be` stub them, and the
fixtures live in `tests/site.json` (plus `tests/netgate/`, `tests/battery/`, `tests/modbus/`).
There is **no way to run the backend on a PC**: anything past the pure logic
needs the real firmware, so the loop is *write → test in the CLI → flash*.

### Build and flash

```bash
make                                # build/ems-v<version>.tapp  (CDN shell — default)
make build-self                     # assets + lang.json packed into the .tapp
make build-dev                      # shell loads the UI from your `make dev` server
make LANG=en                        # English build -> ems-v<version>-en.tapp

make flash DEVICE=192.168.1.42      # delete stale .tapps, upload, restart
make flash DEVICE=192.168.1.42 DRYRUN=1
make flash DEVICE=... WEBUSER=admin WEBPASS=secret
```

**Always flash with `make flash`, never by dragging the file into the
Tasmota file manager.** Tasmota runs `autoexec.be` from *every* `*.tapp` in the
filesystem root and the version is part of the filename, so a bare upload
leaves the previous release in place: both apps boot, the module graph is built
twice and the boot heap roughly doubles — which on
an ESP32-C3 is a reboot loop. `deploy.sh` deletes the stale ones first.

Bump `VERSION.txt` before a release; it names the `.tapp` and the CDN asset
directory. `make release` builds the CDN `.tapp` *and* publishes the matching
bundle to GitHub Pages (needs push access to `gplug-ch/gplug-cdn`);
`make deploy-cdn` publishes an already-built bundle only.

### On-device configuration

`site.json` is the only device config (loads, productions, grid, tariffs,
optional `meter` block, optional `modbusRegisters`). Three ways to get it there:

- the UI's **Einstellungen** page (`POST /api/config`, validated in the browser,
  reloaded with rollback on failure) — the normal path;
- the Tasmota file manager at `http://<device>/ufsd`;
- start from an example in `backend/examples/` (simulator, gPlug, Home Assistant,
  Shelly, Modbus TCP).

### Debugging on the device

Open the Tasmota **Berry console** (`http://<device>/bc`) and raise the log
level (default is Warn):

```berry
import logger
logger.setLevel(logger.lDebug)   # lOff 0, lInfo 1, lWarn 2, lDebug 3, lMore 4
```

All output is prefixed `EMS:`. Keep in mind that the ESP32-C3 heap is tiny —
f-strings are evaluated eagerly in Berry, so hot paths guard their logging with
`logger.enabled(...)`, and you should too.

---

## Frontend development

Preact + htm single-page app, built with **Vite**. The hashed JS/CSS bundle and
the compiled `lang.json` dictionary are served from a CDN (GitHub Pages) so the
`.tapp` only ships a tiny `index.html` shell. Both can also be self-hosted for
restricted networks (spec `specs/002-ui-shell-design-i18n`) — that mode packs
`lang.json` into the `.tapp` and the app loads it via `/fs?name=lang.json`.

```bash
cd ems/frontend
npm install
npm run dev      # Vite dev server (HMR) on http://localhost:5173, bound to 0.0.0.0
npm test         # node --test on the pure helpers (aggregate, archive, metercat, …)
```

`#/demo` renders every shared component with sample data — useful when working
on `components.js` / `charts.js` without a backend.

### Layout and conventions

```
index.html      Vite entry document (dev) / shell template
style.css       design system (tokens in :root, sampled from the Figma prototype)
src/            ES modules — core.js is the Preact/htm seam; ui.js the barrel
i18n/de.json    reference translation (authoritative, must be complete)
i18n/<lang>.json further languages, merged over de.json at build time
vite.config.js  build config; ASSET_BASE selects CDN vs self-host output
bundle.py       --lang-only: emits lang.json (packed only by ASSET_BASE=self)
                + runs the i18n completeness check, which gates every build.
                The Makefile passes --quiet; run it by hand (no --quiet) to
                list unused keys
```

Modules use real ES imports. `src/core.js` re-exports Preact + `html = htm.bind(h)`;
`src/ui.js` is the component barrel (`import * as ui from '../ui.js'`); pages import
`t` (i18n), `fmt` (format), `api`, `router` from their owning modules.

### Connecting to a backend

There are three ways to give the UI real data. **A is the default choice.**

### A. Frontend on your computer, backend on the gPlug (proxy)

```bash
DEV_DEVICE_URL=http://192.168.1.42 npm run dev
# open http://localhost:5173
```

Vite proxies `/api`, `/loads`, `/productions`, `/site`, `/fs` and `/cm` to the
device, so the browser only ever talks to `localhost:5173` — **same origin, no
CORS involved at all**. This is the fastest loop: HMR on your machine, real
device data, nothing to flash.

Do *not* add `?host=` in this mode — it bypasses the proxy (see [CORS](#cors)).

### B. Frontend on your computer, page served by the gPlug (dev shell)

```bash
make build-dev && make flash DEVICE=192.168.1.42
make dev
# open http://192.168.1.42  (the device, not localhost)
```

The flashed shell loads `@vite/client` and `src/entry.js` from *your* dev
server, so you get HMR while the page is served from the device origin and the
API calls are same-origin against the device. Use this to test things that
depend on the real device origin (file serving via `/fs`, the shell itself,
`lang.json` loading).

The shell's dev-server URL defaults to this machine's auto-detected LAN IP —
your laptop and the device must be on the same network. Override a wrong NIC
with `DEV_SERVER_URL=http://<ip>:5173` on the `make` line. Vite's dev server
reflects the requesting origin (`cors: { origin: true }`), which is what lets
the device-origin page fetch modules from it.

### C. Against the simulator

Run the Spring Boot simulator (`cd simulator/backend && ./gradlew bootRun`,
port 9090) and point a *device's* `site.json` at it — the simulator is a
backend for the **device's** integrations (loads, productions, grid and,
with the `meter` block, a synthetic Tasmota-SMI smart meter), not a drop-in
replacement for the EMS HTTP API. The UI still talks to the gPlug.

---

## CORS

**The gPlug firmware is built without Tasmota's `USE_CORS`, so it never sends
an `Access-Control-Allow-Origin` header.** Any cross-origin request from
`http://localhost:5173` to `http://<device>` is therefore blocked by the
browser, and no frontend change can fix that — the header has to come from the
server. (The Spring Boot simulator sends no CORS headers either.)

The way around it is to never be cross-origin in the first place:

| Setup | Origin of the page | Origin of the API | CORS needed? |
|-------|--------------------|-------------------|--------------|
| `DEV_DEVICE_URL=… npm run dev` (**A**) | `localhost:5173` | `localhost:5173` → proxied | no |
| `ASSET_BASE=dev` shell (**B**) | the device | the device | no (only Vite serves the modules cross-origin, and it allows that) |
| Flashed `.tapp`, CDN bundle (production) | the device | the device | no — only the CDN serves the bundle, and it sends `Access-Control-Allow-Origin: *` (the `_headers` file emitted by the Vite build) |
| `http://localhost:5173/?host=192.168.1.42` | `localhost:5173` | the device | **yes — and the device sends none, so this fails** |

`?host=<ip>` (`src/api.js`) is kept for backends that *do* send CORS headers;
against a stock gPlug it will fail with a CORS error in the console. If you
really need it, rebuild the firmware with `USE_CORS`. Otherwise use A or B.

---

## Frontend build & CDN deploy

The **asset base** decides where the shipped `index.html` loads its JS/CSS from:

| Mode | Command | index.html references |
|------|---------|-----------------------|
| CDN (default) | `npm run build` | `https://<CDN_BASE_URL>/<version>/assets/…` |
| Self-host | `npm run build:self` | `/fs?name=…` (assets served on-device) |
| Dev server | `npm run build:dev` | `<DEV_SERVER_URL>/src/entry.js` + HMR client |
| Internal mirror | `ASSET_BASE=https://host npm run build` | `https://host/<version>/assets/…` |

The version comes from the repo-root `VERSION.txt` (or `APP_VERSION`). Output is
nested under the version in `dist/<version>/` (or `dist/self/`, `dist/dev/`), so
the deployed paths match the base baked into the shell.

Normally you do not call these directly — the root Makefile drives the Vite
build and packs the shell into the `.tapp` (see
[Build and flash](#build-and-flash)); `make CDN_BASE_URL=https://cdn.example`
points a build at a different host.

Deploy the CDN bundle to GitHub Pages (the `gplug-ch/gplug-cdn` repo):

```bash
cd ems/frontend && npm run deploy      # scripts/deploy-gh-pages.sh
```

The script clones `github.com/gplug-ch/gplug-cdn`, copies `dist/<version>/`
(JS/CSS + `lang.json`; the `index.html` shell ships in the `.tapp`) into
`/<version>/`, commits and pushes. The repo's Pages workflow then publishes it
at `https://gplug-ch.github.io/gplug-cdn/<version>/…`, matching the URLs baked
into the shell. Version directories already in the repo are never touched, so
devices flashed with an older version keep resolving their assets. Needs push
access to the repo (an authenticated `git`); override the target with
`CDN_REPO=<url>`. `make deploy-cdn` runs this script; `make release` does the
`.tapp` build and this deploy in one step.

The old Cloudflare Pages deploy is still available as `npm run
deploy:cloudflare` (needs `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID`).

## i18n

`i18n/de.json` is the authoritative dictionary; other languages are merged over
it at build time. The build **fails** if a key referenced in the code is missing
from `de.json`; keys missing from a non-German language fall back to German with
a warning. Both checks run via `bundle.py --lang-only`, which the Makefile
executes on every build regardless of where the dictionary ends up being served
from.

Adding a language:

1. Copy `i18n/de.json` to `i18n/<lang>.json` and translate the values
   (`meta.lang` is set automatically at build time).
2. Build with `make LANG=<lang>` at the repo root (and `LANG=<lang>` on
   `npm run build` for the CDN bundle).

---

## Where things live

```
backend/
  autoexec.be        Tasmota entry point; load()s main.be only
  main.be            service lifecycle, lazy module loading
  ems.be             allocation algorithm (every second)
  site.be            digital twin + one-op-per-tick outbound HTTP scheduler
  meter.be           10 s sampling -> 15-min Wh slots
  store.be           append-only raw record storage (see STORAGE.md)
  webservice.be      HTTP endpoints          configservice.be  GET/POST /api/config
  integrations/      homeassistant, shelly, gplug, modbustcp, simulator, nethost
  tests/             Berry CLI tests + stubs + fixtures
  examples/          example site.json files
frontend/
  src/lib/           the browser-side math: aggregate, archive, insights, metercat, csv
  src/pages/         one module per screen
  i18n/              de.json (authoritative) + further languages
```

Deeper detail: `backend/CLAUDE.md` (module pattern, heap constraints,
endpoint list), `backend/STORAGE.md` (on-flash format), `../docs/features.md`
(feature-level spec).
