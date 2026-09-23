# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

**gPlug EMS** is an Energy Management System (EMS) for a single site, running on a Tasmota gPlug device. It distributes the site's PV surplus to its controllable loads (dryer, heat pump, wallbox, boiler) using a greedy priority-based allocation algorithm, and records raw 15-min energy data that the browser UI turns into history and costs.

## Repository structure

```
ems/
  backend/    # Tasmota Berry scripting backend — runs on ESP32 gPlug devices
  frontend/   # Preact web UI — served from the .tapp, no build step
simulator/
  backend/    # Spring Boot 4 / Kotlin simulation backend
  frontend/   # React 19 + Vite simulator UI
docs/         # Feature and architecture documentation
```

Each subdirectory has its own `CLAUDE.md` with component-specific commands and architecture detail.

## Quick command reference

All `make` targets run from the repo root (single root `Makefile`; `make help` lists them).

| Component | Command | Purpose |
|-----------|---------|---------|
| EMS | `make` / `make build` | Build `build/ems-v<VERSION>.tapp` (CDN shell; `LANG=en` for English) |
| EMS | `make build-self` | Self-hosted `.tapp` (JS/CSS + `lang.json` packed in) |
| EMS | `make build-dev` | `.tapp` whose shell loads the UI from `make dev` (HMR on a device) |
| EMS | `make test` | Berry tests + frontend tests (`test-backend`, `test-frontend`) |
| EMS backend | `cd ems/backend/tests && berry -m .. test_ems_allocation.be` | Single test |
| EMS | `make release` | Production release (clean `main` = `origin/main`, new `VERSION.txt`): build de/en × CDN/self `.tapp`s into `release/`, deploy the CDN bundle to GitHub Pages (gplug-cdn), create GitHub Release `v<VERSION>` with the `.tapp`s + generated notes (`DRYRUN=1` builds only) |
| EMS | `make deploy-cdn` | Publish the already-built frontend bundle to the CDN only |
| EMS | `make flash DEVICE=<ip>` | Upload `.tapp` to a device (removes stale `.tapp`s first; `DRYRUN=1`) |
| EMS frontend | `make dev` | Dev server (Vite HMR) |
| Simulator backend | `make sim-run` | Run simulator |
| Simulator backend | `make sim-test` | Run tests |
| Simulator frontend | `cd simulator/frontend && yarn dev` | Dev server (HMR) |
| Simulator frontend | `make sim-ui` | Build + copy to backend |

## High-level architecture

### Two runtimes, one domain model

**EMS (production):** Berry scripts packaged as a `.tapp` deployed on Tasmota ESP32 firmware. The device ships only a tiny `index.html` shell; the Vite-built JS/CSS bundle and the `lang.json` dictionary are served from a CDN (GitHub Pages, gplug-ch/gplug-cdn), versioned by `VERSION.txt`. A self-host mode (`make build-self`) packs the assets back into the `.tapp` for offline/restricted networks. Each device is standalone: it runs the allocation algorithm for its own site only; there is no inter-device communication.

**Simulator:** Spring Boot backend + React frontend running on a PC/server. Mirrors the EMS domain model for testing and demonstration without physical devices.

### Shared domain model

Both runtimes implement the same concepts:

- **Loads** — controllable consumers; three states: `inactive → waiting → active`
- **Productions** — energy sources (PV, battery); provide `currentPower` in watts. A `BATTERY` production (issue #20, spec 012) is an *observed* storage item: signed power (+ discharging, − charging), optional `capacity`/`maxChargePower`/`maxDischargePower`, a live `soc` (%) from `soc_field` (gplug) or `soc_url` (a second HA entity, polled as its own sentinel), and `invert` for devices reporting charging as positive. The EMS never controls it
- **Grid** — smart meter tracking import/export
- **EMS allocation** — on each power update, sort waiting/active loads by ascending priority, activate loads greedily if `available_power ≥ load.power`, deactivate if power drops below threshold. `available_power` sums the non-battery productions only («loads before battery»: discharge never activates a load, charging power counts as surplus)

### EMS module dependency chain

`autoexec.be` waits for WiFi (bounded) and then `load()`s only `main.be`;
`main.be` imports the whole graph, so every module is built exactly once via
the import cache. Compiling at the first tick races WiFi association on the
ESP32-C3 heap and boot-loops (see `ems/backend/autoexec.be`).

```
autoexec.be → main.be
                ├── logger.be
                ├── webservice.be ──→ store.be (raw 15-min records)
                ├── site.be (loads + productions + outbound-HTTP scheduler)
                │      └── integrations/ (homeassistant, shelly, gplug, modbustcp, simulator)
                ├── ems.be (allocation algorithm, every_second driver)
                ├── meter.be (10 s sampling → 15-min Wh slots)
                └── configservice.be (GET/POST /api/config, lazily loaded)
```

### Integrations

The EMS backend supports four device integrations configured per-load in `site.json`:

| Integration | What it does |
|-------------|-------------|
| `homeassistant` | Reads sensors / controls via HA HTTP API (OAuth token in `/private/`). A non-numeric state (`unavailable`/`unknown`) reports no value, never a fake 0. Reference instance with a Loxone battery: `192.168.0.138:8123` (`sensor.speicher_leistung` kW signed, `sensor.speicher_ladestand` %, see `examples/site-ha.json`) |
| `shelly` | Controls Shelly relay devices; reads on/off status |
| `gplug` | Reads a `field` from the local `tasmota.read_sensors()` JSON — the smart-meter object `z` by default, or any other top-level object via `"sensor"` (e.g. `"sensor":"SMA","field":"P_AC"` for an attached SMA inverter, issue #10). Optional SunSpec dynamic scale factor (issue #12): `"scale_field":"Psf"` names the exponent register, `"scale_base"` the exponent the value is already scaled for (default 0 = raw register); the value becomes `value * 10^(sf - base)`. Opt-in only — nothing is derived from the field name. Optional `"max_power"` (W, issue #13) caps the scaled value: a read beyond it (e.g. the SunSpec N/A sentinel 0x8000 a script pre-scales to 327.68 kW at night) is dropped like a missing field. Optional stale detection (issue #15): `"stale_after"` (s) enables it — a Modbus script keeps publishing the last value after sunset, so freshness is inferred from change (the `"energy_field"` counter moving, else the power value changing; a 0 is always fresh). Past the limit the item reports `currentPower` 0, `stale: true` and `lastUpdate` (utc of the last fresh value), shown greyed in Übersicht. The same `"energy_field"` also reports the counter as `energyCounter` (Wh; unit `"energy_dimension"` Wh/kWh, default following `dimension`; own scale factor `"energy_scale_field"`/`"energy_scale_base"`), and `meter.be` then seals a PV production's 15-min energy from the counter difference instead of the power integral (issue #14) — falling back to the integral on the first/partial slot, a reset (negative difference), a jump beyond `max_power`, or a slot without readings. A battery reads its SoC from `"soc_field"` (+ `"soc_scale_field"`/`"soc_scale_base"`, e.g. SunSpec `ChaState`/`ChaState_SF`, issue #20) |
| `simulator` | REST calls to the Spring Boot simulator backend |
| `modbustcp` | Own Modbus TCP master (`integrations/modbustcp.be`) — reads ONE register (or register pair) directly over the LAN, no Tasmota-side script needed, unlike `gplug`'s local-sensor read. Config: `"url"` (`ip:port`), `"unit"` (slave id, default 1), `"function"` (3=Holding/4=Input, default 3), `"register"` (wire address, no 40001 offset math), `"dtype"` (`float32`/`int16`/`uint16`/`int32`/`uint32`), `"swap_words"` (CDAB word order), `"scale"` (static multiplier — for a fixed-point register with no SunSpec-style dynamic exponent register to read, unlike `gplug`'s `scale_field`). Produces `currentPower` only (no soc/energy yet). Also usable standalone via top-level `"modbusRegisters"` (below) for values that don't fit loads/productions/grid, e.g. a submeter |

### HTTP API (EMS/SITE, GET-only)

All endpoints are HTTP GET. State transitions and power setpoints are sent as query parameters. The frontend polls `/loads` and `/productions` every 2 seconds.

Key endpoints: `GET /loads`, `GET /loads?id=<id>&action=transition&to=<state>`, `GET /productions`, `GET /site`, `GET /api/meta` (`{time, tariffs}`), `GET /api/meter` (raw smart-meter passthrough, spec 007), `GET /api/modbus` (standalone Modbus registers — site.json `"modbusRegisters"`, array of config + live `currentPower`, streamed like `/loads`/`/productions`; not a foreign-descriptor passthrough like `/api/meter` since the device already owns the labels). Spec 011 step 1 deleted the dead surface: `/grid`, `/reload`, `action=set-power`, the bare `?id=` item reads and `meta.version`/`meta.language`. Spec 011 step 2 deleted the device-side config validator: `POST /api/config` now only rejects a body that is not a JSON object (400) or a document `site.load_config()` cannot load (500 + rollback) — every field rule lives in the browser (`frontend/src/pages/einstellungen.js`).

**Device serves raw data; the browser computes analytics.** To keep the tiny ESP32-C3 Berry heap free, the device does no cost or roll-up math: `GET /api/energy` streams raw Wh records (a battery site adds `bat_chg_wh`/`bat_dis_wh` — charge/discharge behind the meter; the SoC is live only) and the browser derives CHF (`frontend/src/lib/aggregate.js`). The smart-meter detail page (spec 007) follows the same rule: `GET /api/meter` returns the raw Tasmota SMI sensor object (`z`) verbatim and the browser labels/groups/derives everything (`frontend/src/lib/metercat.js`, `frontend/src/pages/zaehler.js`).

**…and the browser stores.** Since spec 011 step 3a the browser also keeps the
history: `ems/frontend/src/lib/archive.js` mirrors every raw 15-min record into
IndexedDB, syncs incrementally on each visit
(`/api/energy?res=15m&from=…` pages forward), and derives day/month roll-ups
and costs locally. The device shrank to a
short raw buffer — `KEEP_DAYS = 30` days of slots —
and the Einstellungen «Daten» tab shows coverage, gaps and CSV export/import.
Step 3b (issue #8, v1.0.13) then deleted the redundant device side: the day/month
roll-ups (`/e1d`, `/e1mo`) are gone,
`GET /api/energy` serves `res=15m` only, and **the device never rewrites a file** —
every data write is an append.

**Simulating a smart meter for development.** There is no physical meter on a dev bench, so the Spring Boot simulator synthesises a realistic Tasmota-SMI descriptor at `GET /simulator/sites/{siteId}/meter[?variant=full|basis|minimal]` (derived from the site's live grid state). Point a dev device's `site.json` at it with an optional top-level `"meter": {"integration":"simulator","url":"…/meter"}` block; the device polls it via the normal one-op-per-tick scheduler and serves it through `/api/meter`. On a real gPlug the block is omitted and `/api/meter` reads the local sensor.

### Configuration

- `site.json` (on the device) — the ONLY device config: site metadata, loads array, productions, grid, tariffs, optional `meter` block, optional `modbusRegisters` array (standalone Modbus registers, see `modbustcp` above and `GET /api/modbus`). Served and written by `GET/POST /api/config`. There is no `ems.json`.
- `ems/backend/examples/` — example `site.json` files (simulator, gPlug, Home Assistant, Shelly, Modbus TCP)
- `simulator/backend/src/main/resources/application.yaml` — Spring Boot config (port 9090, simulator site definitions)

### Build output

`make` at the repo root produces `build/ems-v<VERSION>.tapp` — a zip (no compression) containing minified Berry sources and the Vite-built `index.html` shell. The Makefile runs the Vite build (`ems/frontend`, which bakes the versioned CDN URLs into `index.html`) and always runs `bundle.py --lang-only` for the i18n completeness check. In CDN mode the JS/CSS **and `lang.json`** live on GitHub Pages (gplug-cdn repo), not in the `.tapp` (the ~23 KB dictionary would be a quarter of the package for a fallback nobody can reach — a dead CDN takes the JS bundle with it); the device reads its build language from `<html lang>` in the shell instead. `make build-self` packs the hashed assets *and* `lang.json` into the `.tapp` and points the shell at `/fs?name=`. File names: `ems-v<VERSION>[-<lang>][-self].tapp` (German has no language suffix). A non-German CDN build names its dictionary `lang-<lang>.json`, so `make release` can build de and en into one `dist/v<VERSION>/` (`KEEP_DIST=1` skips Vite's `emptyOutDir`) and publish both to the CDN. Release notes: `.github/release-notes.md` (header, `@VERSION@` placeholder) + `gh --generate-notes` grouped by `.github/release.yml`.
