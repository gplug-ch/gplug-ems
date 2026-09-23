# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development server

```sh
npm ci        # once (package-lock.json; yarn.lock is stale — don't use yarn)
npm run dev   # Vite dev server (HMR) on http://localhost:5173
```

## Configuring the backend URL

The frontend targets the same host it is served from by default. To point at a Tasmota device running the Berry backend:

```sh
DEV_DEVICE_URL=http://<device-ip> npm run dev   # then open http://localhost:5173
```

The gPlug firmware is built **without** Tasmota's `USE_CORS`, so the device never
sends `Access-Control-Allow-Origin` and a cross-origin fetch from the dev server
is blocked by the browser. `DEV_DEVICE_URL` therefore makes Vite **proxy** every
device path (`/api`, `/loads`, `/productions`, `/site`, `/fs`, `/cm`, see
`server.proxy` in `vite.config.js`) so the app talks same-origin — no CORS
needed, and IndexedDB (the spec 011 archive) stays under one stable origin.

```
http://localhost:5173/?host=<device-ip>
```

The `?host=` override in `src/api.js` still exists and bypasses the proxy — it
only works against a backend that sends CORS headers itself (a Tasmota build
with `USE_CORS` + the `Cors` command set; the Spring Boot simulator sends none).

## Architecture

Vite + Preact + HTM (template literals — no JSX). ES modules with real imports;
npm-managed dependencies. See `README.md` for the full build/deploy flow.

- `index.html` — mounts `#app`, loads `/src/entry.js` as a module. Vite rewrites
  this to the hashed, base-prefixed asset URLs at build time.
- `src/core.js` — the dependency seam: re-exports Preact `h`/`render`/`Fragment`,
  the hooks, and `html = htm.bind(h)`. Every module imports framework primitives
  from here (replaces the old vendored UMD + `window.App` globals).
- `src/ui.js` — component barrel; pages do `import * as ui from '../ui.js'`.
- Ownership: `t`/`i18n` (`i18n.js`), `fmt` (`format.js`), `api` (`api.js`),
  `router` (`router.js`), `toast`/components (`components.js`), charts
  (`charts.js`), `DataTable` (`table.js`), `Shell` (`shell.js`), pages
  (`pages/*.js`), boot + routes (`main.js`).

**Build modes** (`ASSET_BASE`, in `vite.config.js`): `cdn` (default) serves the
bundle *and* `lang.json` (`lang-<lang>.json` for a non-German build, so de and
en share one CDN version dir) from a CDN — device ships only `index.html` (the ~23 KB
dictionary is not packed: if the CDN is down the JS bundle is gone too, so an
on-device copy saves nothing); `<url>` does the same from an internal mirror;
`dev` makes the
shell load from a running `npm run dev` server (HMR) for developing the UI
against a real device — the URL defaults to this machine's auto-detected LAN IP
(override with `DEV_SERVER_URL`); the dev server binds to all interfaces on 5173.
The `<html lang>` attribute and the `self`/`dev` shell rewrites are done by a
`transformIndexHtml` plugin.

**Charts:** hand-rolled SVG (`charts.js` — `LineChart`, `BarChart`), no chart lib.

**Chart sign convention (issue #17) — app-wide, no exceptions:** energy or money
the site **gives** is drawn **above** the 0-axis (Einspeisung,
green; a positive CHF saldo), energy or money it **takes** is drawn **below** it
(Netzbezug, red; a negative CHF saldo). This holds for the Verlauf Netz mode
(kWh and CHF), the Verlauf Bilanz stack — one signed stack per period, self-use
drawn once. `BarChart` takes
`signedMagnitude` when the sign is a *direction* rather than the quantity: the
tooltip then prints `|value|` next to the point's/segment's own label (kWh
views). CHF views leave it off, because there the sign is the value itself. The
underlying data keeps its own conventions (`grid_w` > 0 = import) — the direction is applied at the render site, never in the libs.

**Browser archive (spec 011 step 3a):** `src/lib/archive.js` mirrors the device's
raw 15-min records into IndexedDB (`gplug-archive`,
stores `e15` / `meta` / `live`, keyed by the `/site` id — never the origin) and
is the ONLY module touching IndexedDB; the pure libs never import it. `main.js`
calls `archive.start(api)` at boot, which syncs incrementally
(`GET /api/energy?res=15m&count=384&from=<last+900>` pages) and re-syncs every 15 min. Pages `await archive.ready()` and
read `archive.range()`; `verlauf.js` derives every
resolution from 15-min records (the device's `res=1d|1mo` rings are gone as of
spec 011 step 3b — `/api/energy` answers 400 for anything but `15m`). If IndexedDB is unavailable, every page falls
back to the live device buffer — which now reaches back 30 days, not 18 months —
and Verlauf (the only page whose content changes) shows the `banner.archive`
warning — only when storage is really blocked, not when `/site` lacks an `id`
(issue #11). Coverage, gaps and CSV export/import live in
the Einstellungen «Daten» tab.

The `live` store (DB v2) is the one non-archival use: the device serves a
snapshot per load/production (only the meter has a device-side ring, behind
`/api/power`), so `uebersicht.js` builds those sparkline series in the browser
and mirrors its 15-min rings via `archive.putLive()` / `getLive()` — otherwise a
reload leaves Erzeuger and Lasten empty for 15 min while Netzanschluss is
complete at once. Rows are rewritten whole on each 10 s poll and points outside
the chart window are dropped on read, so a long-closed tab rehydrates to
nothing rather than to a stale line.

**API contract** (Berry backend on the Tasmota device, HTTP GET only):

| Endpoint | Purpose |
|----------|---------|
| `GET /site` | Site metadata `{id, name, location, description}`; the archive keys IndexedDB by its `id` |
| `GET /loads` | All loads array |
| `GET /loads?id=<id>&action=transition&to=<state>` | Transition state (`inactive`/`waiting`/`active`) |
| `GET /productions` | All productions array |
| `GET /api/power` | `{now, samples}` — the device's 10 s meter sample ring (Übersicht charts) |
| `GET /api/energy?res=15m&count=&from=&to=` | Raw 15-min records (`ts`, `imp_wh`, `exp_wh`, `pv_wh`, `partial?`; battery sites add `bat_chg_wh`/`bat_dis_wh`); `count` defaults to 96; `res` must be `15m` (anything else → 400, spec 011 FR-1122); with `from` it pages forward from the oldest matching slot (FR-1103) |
| `GET /api/meta` | `{time, tariffs}` (spec 011 step 1 dropped `version`/`language`) |
| `GET /api/meter` | Raw smart-meter descriptor `{now, values}` (spec 007); browser interprets it via `lib/metercat.js` |
| `GET /api/modbus` | Standalone Modbus registers (site.json `modbusRegisters`, configured in Einstellungen → Modbus) — array of items (config fields + live `currentPower`), streamed like `/loads`/`/productions`. Rendered as a raw table in `pages/modbus.js`, same table styling as the Zähler «Rohdaten» section; nav entry gated on the list being non-empty (mirrors the `meter` gate) |
| `GET /api/config` / `POST /api/config` | Read / replace `site.json` (Einstellungen; field validation is browser-side, the device only rejects non-objects (400) or an unloadable doc (500 + rollback)) |
| `GET /fs?name=<file>` | Serve a file from the Tasmota filesystem (`/app` redirects to `/fs?name=index.html`) |
| `GET /cm?cmnd=<cmd>` | Tasmota command API (Einstellungen «gPlug» tab: restart, WLAN) |

**Load object fields:** the site.json config (`id`, `friendlyName`, `loadType`, `priority` (lower = higher priority), `integration`, `url`, `duration`, `minimalDuration`, …) plus live `state` and `currentPower` (W).
**Production object fields:** the site.json config (`id`, `friendlyName`, `productionType` `PHOTOVOLTAIC`/`BATTERY`, `integration`, …) plus live `currentPower` (W; the UI also accepts `current_power`); a battery adds `soc`, a gplug item with `stale_after` adds `stale`/`lastUpdate`, one with `energy_field` adds `energyCounter`.

**Build note:** `make` (repo root) runs the Vite build and packs the shell
into the `.tapp`. The shell references `<CDN_BASE_URL>/v<version>/…` (that version must be published to gplug-cdn — see the root README's CDN section); there is
no self-host mode (`ASSET_BASE=self` was removed and now fails the build). Don't hand-edit `index.html` asset refs — Vite owns them.
