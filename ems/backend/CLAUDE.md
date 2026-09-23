# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

A Tasmota Berry scripting backend for an Energy Management System (EMS) that distributes a site's PV surplus to controllable loads. It runs as a `.tapp` (Tasmota app) on ESP32-based devices running Tasmota firmware.

## Build commands

```bash
# all make targets run from the repo root (`make help` lists them)
make               # clean + build build/ems-v<VERSION>.tapp (CDN shell)
make build-dev     # .tapp whose shell loads the UI from a `make dev` server
make test-backend  # run all Berry tests with the Berry CLI
make test          # Berry + frontend tests
make clean         # remove build/ directory
```

Deploy to a device (deletes the older `.tapp`s first — Tasmota runs
`autoexec.be` from EVERY `*.tapp` in the root, and the filename carries the
version, so a bare upload boots two copies of the app):
```bash
make flash DEVICE=192.168.1.42            # delete stale tapps, upload, Restart 1
make flash DEVICE=192.168.1.42 DRYRUN=1   # show what would be deleted
```

Run a single test file:
```bash
cd tests && berry -m .. test_ems_allocation.be
cd tests/battery && berry -m ../.. test_battery_site.be   # tests in a tests/<group>/ subdir
```

The `-m ..` flag adds the parent directory (backend/) to the Berry module path so `import ems` etc. resolve correctly (`-m ../..` from a `tests/<group>/` subdirectory).

## Architecture

### Module pattern (functional)
Every `.be` file defines a plain module — no classes:
1. Declare `var mymodule = module()`
2. Constants as top-level `var UPPER_CASE = ...` (read-only after load)
3. ALL mutable state in ONE private map `var _s = {...}`, mutated IN PLACE only
4. Logic as top-level `def` functions (defined leaf-first — `import strict`
   forbids forward references)
5. Export the public API by direct assignment: `mymodule.fn = fn`
6. Return the module: `return mymodule`

**CRITICAL — never reassign a top-level `var` from inside a function.** Under
Berry 1.1.0 `import`, sibling closures get SEPARATE upvalue boxes, so such a
write is invisible to every other function in the module (`compile()()` shares
the boxes; `import` does not — verified in the CLI). In-place mutation of a
captured map/list (`_s['x'] = v`, `list.push(...)`) is safe because every box
holds the same object pointer. This caveat is documented at the `_s`
declaration in `integrations/nethost.be`.

Modules that register as Tasmota drivers CANNOT pass the module itself —
`tasmota.add_driver()` raises `value_error: instance required` on-device.
They register a `drivershim.be` instance instead: `var _driver` declared near
the top, `_driver = drivershim.make({'every_second': every_second, ...})`
assigned once at module load (top-level assignment is safe; only in-function
reassignment hits the upvalue caveat), then `tasmota.add_driver(_driver)`.
The shim stores the hook functions in instance vars; `tasmota.event()` finds
them via `introspect.get(d, event_type)` and calls `f(d, cmd, idx, payload,
raw)` — Berry drops the excess arguments on the zero-arg hooks.

### Module load order (`autoexec.be`)
`autoexec.be` is the Tasmota entry point. It stashes the `.tapp` working directory in `global._tapp_wd`, adds it to `sys.path()`, waits for the WiFi station to be up (bounded, ~30 s) plus a 5 s settle, and only then `load()`s ONLY `main.be` — compiling the graph at the first tick overlaps WiFi association on the ESP32-C3 and hard-faults into a boot loop (2026-09-07). `main.be` imports the rest of the graph (`logger`, `webservice`, `site`, `ems`, `store`, `meter`, `drivershim`, plus only the integrations `site.json` actually uses — the boot scan covers `loads`, `productions`, `grid` and `meter`, any other type falls back to `site.be`'s lazy import; `configservice` is imported lazily on the first `POST /api/config`), so every module is built exactly once through the import cache — load()'ing each module explicitly compiled them twice and doubled the boot heap.

### Service lifecycle (`main.be`)
`main.be` polls for WiFi association (first check after 5 s, then every second, giving up after ~30 s) and then runs `start_services()`: `webservice.start()`, the lazy `/api/config` stub, `site.load_config()`, `ems.start()`, `store.load()` and `meter.start()` — each as a separate `_stage()` so one failing service is logged by name and does not abort the rest. Driver modules register via a `drivershim.be` instance (see above).

### Core modules

| Module | Responsibility |
|--------|---------------|
| `ems.be` | EMS state machine: greedy priority-based allocation. `every_second` runs allocation (pure — it only updates cached state and QUEUES relay writes) and advances `site`'s outbound-HTTP scheduler by exactly one op. No HTTP is fired inline from allocation. |
| `site.be` | Digital twin + **outbound-HTTP scheduler**: ALL integration reads and relay writes go through a one-op-per-tick scheduler (round-robin `poll_step` + an actuation queue drained by `actuate_step`), deferred while a response streams (`serving_recent`). This one-`webclient()`-per-tick cap is the fix for the ESP32-C3 heap OOM caused by burst fetches. Never fetch inline. Standalone Modbus registers (`site.json` `"modbusRegisters"`) get the same treatment as `grid`: config copied into a persistent item list (`get_modbus_cached()`) at `load_config()`, each item pushed into `pollables`, the scheduler merges `currentPower` into it in place — no special-casing in `_refresh_item`, they just aren't loads/productions/grid. |
| `webservice.be` | HTTP endpoints: `GET /fs?name=<file>` (file serving from filesystem or tapp), `GET /app`, `GET /loads` (+ `?id=&action=transition&to=`), `GET /productions`, `GET /site`, `GET /api/power`, `GET /api/energy` (`?res=&count=&from=&to=`; **`res=15m` only** since spec 011 step 3b — anything else is a 400; `count` defaults to 96, capped at `store.capacity` = 2880; streamed via `store.open_cursor`/`next_into`; with `from` it pages FORWARD from the oldest matching slot so the browser archive can walk the whole buffer in `count`-sized pages — spec 011 FR-1103), `GET /api/meta` (`{time, tariffs}`), `GET /api/meter` (raw Tasmota-SMI `z` passthrough, spec 007 — via the shared `gplug.read_z()`, or the cached simulated meter for dev; no webclient), `GET /api/modbus` (standalone Modbus registers — `site.get_modbus_cached()`, streamed like `/productions`; config fields + live `currentPower`, not a foreign-descriptor passthrough since the device already owns the labels). Spec 011 step 1 removed `/grid`, `/reload`, the bare `?id=` reads, `action=state`, `action=set-power` and the `meta.version`/`meta.language` fields — the browser needs none of them. |
| `configservice.be` | `GET/POST /api/config`: serves `site.json` verbatim and writes it back (temp file + copy over, then `site.load_config()` with rollback). Lazily loaded by the `main.be` stub on the first POST. Since spec 011 step 2 it validates nothing beyond «is this a JSON object» — the browser owns the field rules (`einstellungen.js` `validateDocument`). |
| `store.be` | 15-min energy records (spec 001). **Append-only** bucket files on flash (`/.e15_<dayno>`, issue #4; the leading `.` hides them in Tasmota's file-manager view, issue #18), retention `KEEP_DAYS = 30`. Since spec 011 step 3b that is *all* it does: the day/month roll-ups (`/e1d`, `/e1mo`) and the `.tmp` line-wise rewrite are gone — the browser archive keeps the history and derives roll-ups and costs. RAM state is `nb` (per-bucket line counts) and nothing else; `push_15m()` appends one line per slot close (4 fields; 7 — `…,<chg>,<dis>,` with a reserved empty last field — on a battery site, issue #20) and no file is ever rewritten. `count`/`capacity` answer `-1`/`0` for any res but `15m`. See `STORAGE.md`. |
| `meter.be` | Samples grid / PV / battery / active-load power every 10 s from the cached site twin (never fetches itself), integrates `W * dt / 3600` into Wh and seals a record at each 15-min boundary via `store.push_15m()` — for a PV production reporting `energyCounter` (gplug `energy_field`, issue #14) the slot takes the counter difference instead of that production's integral share when trustworthy (not the first/partial slot, not negative, within `max_power`, at least one reading; a slot without readings breaks the chain). Keeps a 90-entry RAM sample ring for `GET /api/power`. |
| `fsx.be` | Filesystem seam (Berry CLI `os` vs Tasmota `path`: `remove`, `listdir`, `append_line` — the store's only write path) plus the bucket-file helpers of `store.be`: `split_prefix`, `dayno`, `list_daynos`, `sort_ints`, `close_q` (issue #9). |
| `drivershim.be` | `drivershim.make(hooks)` — the class instance Tasmota's `add_driver()` needs (see «Module pattern»). |
| `integrations/nethost.be` | Per-host outbound backoff shared by the network integrations (all but `gplug`): after a failed request the host is skipped for `BACKOFF_S = 30` s, doubling up to `BACKOFF_MAX_S = 600` s, reset on success (the ~9 s webclient connect timeout cannot be lowered on this firmware). |
| `logger.be` | Levels: `lOff=0, lInfo=1, lWarn=2, lDebug=3, lMore=4`. Default level is Warn (2). All output prefixed with `EMS:`. |

### Integrations (`integrations/`)

Selected per item by its `integration` key; each module exports `fetch_item(url, token, cfg)` (returns only the fields it read, or nil) and `set_state(url, token, state, cfg)` (`site._actuate_load` passes the load map as `cfg`; shelly/simulator ignore it). Common item keys handled in `site.be`: `url`, `token`, `invert` (flip the sign), `soc_url` (battery SoC from a second entity, own poll slot), `dimension` (`"kW"` → ×1000). The per-integration options are documented in the root `CLAUDE.md` (Integrations table).

| Integration | Module | Reads | Switches loads |
|---|---|---|---|
| `gplug` | `gplug.be` | a `field` of the local `tasmota.read_sensors()` object `sensor` (default `z`); SunSpec scale factors, `max_power`, `stale_after`, `energy_field`, `soc_field` | no |
| `homeassistant` | `homeassistant.be` | HA entity state via the HTTP API (bearer `token`); non-numeric states report no value | no (read-only) |
| `shelly` | `shelly.be` | Shelly Gen1 relay on/off status (`ison`) — `url` is a map `{on, off, status}` | yes (GETs `on`/`off`) |
| `modbustcp` | `modbustcp.be` | registers over Modbus TCP, one connection per poll: `unit`, `function`, `register`, `dtype`, `swap_words`, `scale`, plus `soc_register`, `energy_register`, `state_register` (issue #20) | yes (`write` block: FC 6/16, or FC 5 coil) |
| `simulator` | `simulator.be` | the Spring Boot simulator's REST API | yes |

### API / Webservice

All API endpoints are defined in `webservice.be`. Tasmota only supports a single webserver driver.

### EMS allocation algorithm (`ems.be:_update_load_allocation`)
Loads have three states: `inactive` (user-deselected), `waiting` (requested but insufficient power), `active` (running). On each power update, candidates (waiting/active loads) are sorted by ascending `priority` and greedily activated: a waiting load becomes active if remaining available power ≥ its `currentPower`; an active load is only shed once remaining power drops `LOWER_THRESHOLD_W` (200 W) below its draw AND its `minimalDuration` (s) has elapsed since the EMS switched it on. Available power sums the non-`BATTERY` productions only («loads before battery», issue #20). Allocation itself is pure: a transition calls `site.set_load_state()`, which updates RAM state and QUEUES the relay write; the actual integration HTTP call is issued later by `site.scheduler_step()`, one op per tick.

### Configuration files
- `site.json` — the only device config: site metadata, `loads` (id, friendlyName, loadType, priority, currentPower, minimalDuration, integration, url), `productions`, `grid` (`from`/`to` items; `gplug` items read `field` from the `read_sensors()` object named by the optional `sensor` key, default `z` — issue #10), `tariffs`, an optional top-level `meter` block (spec 007), an optional `modbusRegisters` array (standalone Modbus registers that don't fit loads/productions/grid — a submeter behind a Modbus TCP gateway; `modbustcp` config fields plus `friendlyName`/`unitLabel` for display, served live via `GET /api/modbus`). Read by `site.load_config()`, served and written by `configservice.be`.
- There is no `ems.json` — it was folded into `site.json`.

### Build artifacts
The Makefile minifies Berry sources (`*.be` and `integrations/*.be`, flattened into the `.tapp` root) with `minify.py` (strips `#` comments and indentation; blank lines are kept so line numbers in on-device errors match the source), runs the Vite build in `ems/frontend` (which bakes the versioned CDN URLs into the `index.html` shell) and always runs `bundle.py --lang-only` for the i18n completeness check, then zips everything into `build/ems-v<VERSION>.tapp` (`-<lang>` suffix when `LANG` is set). The `.tapp` is a standard zip with no compression (`-0`). The hashed JS/CSS **and `lang.json`** always stay on GitHub Pages (`gplug-ch/gplug-cdn`) and only the shell is packed (there is no self-host mode).

### Testing
`tests/tasmota.be` is a stub for the Tasmota built-in `tasmota` module (unavailable in Berry CLI). Tests that need `webclient` define their own stub at global scope before `import ems`. Test data fixtures are in `tests/site.json` (plus `tests/netgate/`, `tests/battery/` and `tests/modbus/` — each has its own `site.json` and compiles the REAL `site.be` by path, since `tests/site.be` is a stub that shadows it; `tests/battery/` covers the `soc_url` sentinel and `invert`, `tests/modbus/` the `modbusRegisters` polling, `tests/modbus_write/` FC 5/6/16 framing, write/read round-trips, extra registers and load switching through `site.be`). `make test-backend` runs `tests/test_*.be` with `berry -m ..` and `tests/*/test_*.be` with `berry -m ../..`.
