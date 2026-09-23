# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

A Tasmota Berry scripting backend for an Energy Management System (EMS) targeting the vZEV (virtual energy community) use case. It runs as a `.tapp` (Tasmota app) on ESP32-based devices running Tasmota firmware.

## Build commands

```bash
make          # clean + build .tapp file (full build)
make tapp     # minify Berry sources, copy frontend, package into .tapp zip
make minify   # only minify Berry sources into build/
make test     # run all Berry tests with the Berry CLI
make clean    # remove build/ directory
```

Deploy to a device (deletes the older `.tapp`s first — Tasmota runs
`autoexec.be` from EVERY `*.tapp` in the root, and the filename carries the
version, so a bare upload boots two copies of the app):
```bash
make deploy DEVICE=192.168.1.42            # delete stale tapps, upload, Restart 1
make deploy DEVICE=192.168.1.42 DRYRUN=1   # show what would be deleted
```

Run a single test file:
```bash
cd tests && berry -m .. test_ems_allocation.be
```

The `-m ..` flag adds the parent directory (backend/) to the Berry module path so `import ems` etc. resolve correctly.

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
`autoexec.be` is the Tasmota entry point. It stashes the `.tapp` working directory in `global._tapp_wd`, adds it to `sys.path()`, waits for the WiFi station to be up (bounded, ~30 s) plus a 5 s settle, and only then `load()`s ONLY `main.be` — compiling the graph at the first tick overlaps WiFi association on the ESP32-C3 and hard-faults into a boot loop (2026-09-07). `main.be` imports the rest of the graph (`webservice`, `udpdriver`, `site -> integrations`, `ems`, `store`, `meter`, `configservice`, `vzev`), so every module is built exactly once through the import cache — load()'ing each module explicitly compiled them twice and doubled the boot heap.

### Service lifecycle (`main.be`)
`main.be` calls `webservice.start()` and `udpdriver.start()` after a 2-second delay (to ensure the Tasmota runtime is ready). Both services register themselves as Tasmota drivers via `tasmota.add_driver(self)`.

### Core modules

| Module | Responsibility |
|--------|---------------|
| `ems.be` | EMS state machine: greedy priority-based allocation. `every_second` runs allocation (pure — it only updates cached state and QUEUES relay writes) and advances `site`'s outbound-HTTP scheduler by exactly one op. No HTTP is fired inline from allocation. |
| `site.be` | Digital twin + **outbound-HTTP scheduler**: ALL integration reads and relay writes go through a one-op-per-tick scheduler (round-robin `poll_step` + an actuation queue drained by `actuate_step`), deferred while a response streams (`serving_recent`). This one-`webclient()`-per-tick cap is the fix for the ESP32-C3 heap OOM caused by burst fetches. Never fetch inline. Standalone Modbus registers (`site.json` `"modbusRegisters"`) get the same treatment as `grid`: config copied into a persistent item list (`get_modbus_cached()`) at `load_config()`, each item pushed into `pollables`, the scheduler merges `currentPower` into it in place — no special-casing in `_refresh_item`, they just aren't loads/productions/grid. |
| `webservice.be` | HTTP endpoints: `GET /fs?name=<file>` (file serving from filesystem or tapp), `GET /app`, `GET /loads` (+ `?id=&action=transition&to=`), `GET /productions`, `GET /site`, `GET /api/power`, `GET /api/energy` (**`res=15m` only** since spec 011 step 3b — anything else is a 400; streamed via `store.open_cursor`/`next_into`; with `from` it pages FORWARD from the oldest matching slot so the browser archive can walk the whole buffer in `count`-sized pages — spec 011 FR-1103), `GET /api/meta` (`{time, tariffs}`), `GET /api/meter` (raw Tasmota-SMI `z` passthrough, spec 007 — via the shared `gplug.read_z()`, or the cached simulated meter for dev; no webclient), `GET /api/modbus` (standalone Modbus registers — `site.get_modbus_cached()`, streamed like `/productions`; config fields + live `currentPower`, not a foreign-descriptor passthrough since the device already owns the labels). Spec 011 step 1 removed `/grid`, `/reload`, the bare `?id=` reads, `action=state`, `action=set-power` and the `meta.version`/`meta.language` fields — the browser needs none of them. |
| `configservice.be` | `GET/POST /api/config`: serves `site.json` verbatim and writes it back (temp file + copy over, then `site.load_config()` with rollback). Lazily loaded by the `main.be` stub on the first POST. Since spec 011 step 2 it validates nothing beyond «is this a JSON object» — the browser owns the field rules (`einstellungen.js` `validateDocument`). |
| `store.be` | 15-min energy records (spec 001). **Append-only** bucket files on flash (`/.e15_<dayno>`, issue #4; the leading `.` hides them in Tasmota's file-manager view, issue #18), retention `KEEP_DAYS = 30`. Since spec 011 step 3b that is *all* it does: the day/month roll-ups (`/e1d`, `/e1mo`), `set_vzev()` and the `.tmp` line-wise rewrite are gone — the browser archive keeps the history and derives roll-ups, the vZEV share, costs and billing. RAM state is `nb` (per-bucket line counts) and nothing else; `push_15m()` appends one line per slot close (4 fields; 7 — `…,<chg>,<dis>,` with a reserved empty last field — on a battery site, issue #20) and no file is ever rewritten. `count`/`capacity` answer `-1`/`0` for any res but `15m`. See `STORAGE.md`. |
| `vzev.be` | vZEV community backend (spec 005): registry, UDP protocol (`ann`/`slot`/`req`), `/api/vzev/*`. It does **not** allocate — since spec 011 step 3b the browser derives the per-slot allocation, the own share and the billing from `/api/vzev/raw` (`frontend/src/lib/vzev.js`); `announce_slot()` is just «store the own slot, then multicast it» and the module never touches `store`. `/api/vzev/members` serves registry state only — liveness (`discovered`/`last_seen`) comes from `/api/vzev/discovered` and is joined by id in the browser (spec 011 step 1). Peer slots (issue #4) live in per-member append-only bucket files `/.vz_<sanitized-id>_<dayno>` (dot-prefixed, issue #18) (`VZ_KEEP_DAYS = 14`, spec 011 step 3a) — no ring in RAM, only a lazily-populated per-member line-count/newest-ts cache. A correction is appended (never rewritten); readers treat a duplicate ts as last-line-wins. |
| `messaging/udpdriver.be` | UDP multicast transport: reads the group/port from `site.json`'s `messaging.udp` block (defaults `239.3.0.1:5007`), exposes one receive callback (`set_on_receive`/`get_on_receive` — vzev chains the prior one, FR-508). Wraps each payload in a `{from,timestamp,msg}` JSON envelope and polls the socket via the `every_250ms()` Tasmota driver hook. (The former `udpclient.be` pass-through was folded in here, issue #9.) |
| `meter.be` | Samples grid / PV / battery / active-load power every 10 s from the cached site twin (never fetches itself), integrates `W * dt / 3600` into Wh and seals a record at each 15-min boundary via `store.push_15m()` — for a PV production reporting `energyCounter` (gplug `energy_field`, issue #14) the slot takes the counter difference instead of that production's integral share when trustworthy (not the first/partial slot, not negative, within `max_power`, at least one reading; a slot without readings breaks the chain), then hands the slot to `vzev.announce_slot()`. Keeps a 90-entry RAM sample ring for `GET /api/power`. |
| `fsx.be` | Filesystem seam (Berry CLI `os` vs Tasmota `path`) plus the bucket-file helpers `store.be` and `vzev.be` share: `split_prefix`, `dayno`, `list_daynos`, `sort_ints`, `close_q` (issue #9). |
| `logger.be` | Levels: `lOff=0, lInfo=1, lWarn=2, lDebug=3, lMore=4`. Default level is Warn (2). All output prefixed with `gUDP:`. |

### API / Webservice

All API endpoints are defined in `webservice.be`. Tasmota only supports a single webserver driver.

### EMS allocation algorithm (`ems.be:_update_load_allocation`)
Loads have three states: `inactive` (user-deselected), `waiting` (requested but insufficient power), `active` (running). On each power update, candidates (waiting/active loads) are sorted by ascending `priority` and greedily activated: a load becomes active if remaining available power ≥ its rated `power`. Allocation itself is pure: a transition calls `site.set_load_state()`, which updates RAM state and QUEUES the relay write; the actual integration HTTP call is issued later by `site.scheduler_step()`, one op per tick.

### Configuration files
- `site.json` — the only device config: site metadata, `loads` (id, friendlyName, loadType, priority, currentPower, minimalDuration, integration, url), `productions`, `grid` (`from`/`to` items; `gplug` items read `field` from the `read_sensors()` object named by the optional `sensor` key, default `z` — issue #10), `tariffs`, an optional top-level `meter` block (spec 007), an optional `modbusRegisters` array (standalone Modbus registers that don't fit loads/productions/grid — a submeter behind a Modbus TCP gateway; `modbustcp` config fields plus `friendlyName`/`unitLabel` for display, served live via `GET /api/modbus`) and `messaging.udp` (`multicast_ip`, `port`; defaults `239.3.0.1:5007`). Read by `site.load_config()`, served and written by `configservice.be`.
- `/vzev.json` — vZEV member registry (id, name, location, type `PRODUCER`/`CONSUMER`, url), written by `vzev.be`.
- There is no `ems.json` and no `udpclient.json` — both were folded into `site.json`.

### Build artifacts
The Makefile minifies Berry sources with `minify.py` (strips `#` comments, collapses blank lines), runs the Vite build in `../frontend` (which bakes the versioned CDN URLs into the `index.html` shell) and always runs `bundle.py --lang-only` for the i18n completeness check, then zips everything into `build/ems-v<VERSION>.tapp` (`-<lang>` suffix when `LANG` is set). The `.tapp` is a standard zip with no compression (`-0`). In the default CDN mode the hashed JS/CSS **and `lang.json`** stay on GitHub Pages (`gplug-ch/gplug-cdn`) and only the shell is packed; `make ASSET_BASE=self` packs the assets and `lang.json` into the `.tapp` and points the shell at `/fs?name=`.

### Testing
`tests/tasmota.be` is a stub for the Tasmota built-in `tasmota` module (unavailable in Berry CLI). Tests that need `webclient` define their own stub at global scope before `import ems`. Test data fixtures are in `tests/site.json` (plus `tests/vzev/`, `tests/netgate/` and `tests/battery/` — the latter two compile the REAL `site.be` by path to test the poll scheduler; `tests/battery/` covers the `soc_url` sentinel and `invert`).
