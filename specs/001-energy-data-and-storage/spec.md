# Feature Specification: Energy Data & Ring Storage

**Feature Branch:** `001-energy-data-and-storage`
**Created:** 2026-07-14
**Status:** Implemented
**Depends on:** — (read `specs/README.md` for shared constraints C-1…C-7 and the glossary)

> **Implementation note (reconciled 2026-07-27).** Delivered. One divergence
> from this draft: the JSON API endpoints (FR-106) and the read-time cost
> computation (FR-108) live in the existing **`webservice.be`**, not a new
> `apiservice.be` module — Tasmota supports only one webserver driver, so a
> separate module would have to register on the same server anyway. Read
> `apiservice.be` as "the `/api/*` handlers in `webservice.be`" throughout.
> `meter.be`, `store.be`, `site.get_tariffs()` and the three flash rings are as
> specified; an example `tariffs` block now ships in `examples/site-1.json`.
>
> **Spec 011 step 3a (2026-09-05).** Retention grew to `KEEP_DAYS = 30`, and
> `GET /api/energy` with `from` now pages **forward** (oldest matching slot first)
> so the browser archive can walk the whole buffer; without `from` it still returns
> the newest `count`. The long history and the day/month roll-ups moved to the
> browser (`ems/frontend/src/lib/archive.js` + `lib/aggregate.js`).
>
> **Spec 011 step 3b (2026-09-05, v1.0.13).** The device-side roll-ups are **gone**:
> `/e1d`, `/e1mo`, the running day/month accumulators, `store.set_vzev()` and the
> `.tmp` line-wise rewrite were deleted, so FR-104 (roll-ups) and the `set_vzev`
> half of FR-106 are now fulfilled by the browser archive, not the device.
> `GET /api/energy` accepts `res=15m` only (400 otherwise) and its records carry
> no `vzev_in_wh`/`vzev_out_wh`. Writes are append-only (FR-105 strengthened);
> only the 15-min flash ring of the three specified here survives. Buckets written
> by an older firmware still load — their 6-field lines parse with the vZEV tail
> ignored — and `/e1d`/`/e1mo` are removed once at the first boot.

## Overview

The gPlug measures grid power (import/export), PV production and load power. Today those values
only exist as instantaneous `currentPower` fields in `site.be`; nothing is recorded. This feature
adds the project's **data strategy**:

- **Leistungsdaten (power):** sampled every **10 s**, kept in **RAM only** (ring buffer),
  exposed via HTTP for live charts.
- **Abrechnungsdaten (energy):** accumulated into **15-minute slots** (Wh), persisted to flash in
  ring buffers with three retentions —
  **240 × ¼ h (= 60 h)**, **124 × 1 day (≈ 4 months)**, **18 × 1 month**.
  These values must reconcile with the grid operator per quarter, so slot boundaries are aligned
  to wall-clock quarter hours / days / months.
- **Costs are never stored** — they are computed at read time from the configured tariffs
  (see spec 006 for the tariff editor; this spec defines the tariff config format and the
  cost computation).

Two new Berry modules (`meter.be`, `store.be`) and one new webservice module (`apiservice.be`)
implement this. Prior-art drafts exist (constraint C-7) but used 30 s slots and a smaller schema —
this spec supersedes them.

## Use Cases

### UC-101: Live power for charts
**Actor:** Frontend (Übersicht page)
**Precondition:** Device running, sensors configured in `site.json`.
**Flow:** The frontend polls `GET /api/power` every 10 s and receives the last 90 samples
(15 min) of grid/PV/load power, so a freshly opened page immediately shows 15 min of history.

**Acceptance Scenarios**
- **Given** the device has been running ≥ 15 min, **When** the UI requests `/api/power`,
  **Then** it receives 90 samples, each ≤ 10 s apart, newest last.
- **Given** the device rebooted 1 min ago, **When** the UI requests `/api/power`,
  **Then** it receives only the ~6 samples collected since boot (no fabricated data).

### UC-102: Energy history for Verlauf & Abrechnung
**Actor:** Frontend (Verlauf, Abrechnung), vZEV peers
**Flow:** The frontend requests `GET /api/energy?res=15m|1d|1mo&count=N` and receives energy
records with Wh quantities and computed CHF costs.

**Acceptance Scenarios**
- **Given** the device has run for 2 h, **When** `/api/energy?res=15m&count=8` is requested,
  **Then** 8 records are returned whose `ts` values are exact quarter-hour boundaries (UTC)
  and whose `imp_wh`/`exp_wh`/`pv_wh` reflect the accumulated energy of each slot.
- **Given** tariffs `import=0.26, feedin=0.18` are configured, **When** a record with
  `imp_wh=1000, exp_wh=500` is returned, **Then** it contains `cost_import_chf=0.26`
  and `revenue_feedin_chf=0.09` (rounded to 2 decimals, Rappen).

### UC-103: Power-loss resilience
**Actor:** Device
**Flow:** Power is cut mid-slot and restored later. The persisted rings survive; at most the
current (unfinished) 15-min slot is lost.

**Acceptance Scenarios**
- **Given** 100 persisted 15-min records, **When** the device reboots, **Then** `/api/energy`
  still returns those 100 records (loaded from flash) and new slots continue after the gap.
- **Given** a reboot at 12:07, **Then** the slot 12:00–12:15 may be missing or partial-flagged,
  but slots up to 11:45–12:00 are intact.

### UC-104: Missing data is visible, not invented
**Actor:** Frontend
**Flow:** Sensor unreachable or device off → slots without data are represented as gaps.

**Acceptance Scenarios**
- **Given** the device was off from 13:00 to 14:00, **When** `/api/energy?res=15m&count=240`
  is requested, **Then** no records exist for the four missing slots (the `ts` sequence has a
  hole); the API does **not** return zero-filled records for that period.
- **Given** the grid sensor failed during a slot but PV was readable, **Then** the record is
  stored with `imp_wh`/`exp_wh` set to `null` and `pv_wh` set, plus flag `"partial": true`.

## Functional Requirements

- **FR-101** New module `ems/backend/meter.be` samples, every **10 s** (Tasmota `every_second()`
  driver hook with a modulo-10 tick counter, following the pattern in `ems.be`):
  - `grid_w` (signed W): import positive, export negative — from `site.get_grid()` items
    `id=="from"` (import) minus `id=="to"` (export), using each item's `currentPower`.
  - `pv_w` (W): sum of `currentPower` over `site.get_productions()` with
    `productionType=="PHOTOVOLTAIC"`.
  - `bat_w` (signed W): sum over productions with `productionType=="BATTERY"`
    (positive = discharging into the site).
  - `load_w` (W): sum of `currentPower` over loads with `state=="ACTIVE"`.
  Samples go into a RAM ring of **90 entries** `[ts, grid_w, pv_w, bat_w, load_w]`.
- **FR-102** `meter.be` integrates each sample into Wh accumulators (`Wh += W * dt/3600`) and, at
  every wall-clock quarter-hour boundary (`utc % 900 == 0`), closes the slot: computes
  `imp_wh` (positive grid), `exp_wh` (negative grid), `pv_wh`, and pushes it to the store.
  Slot `ts` = start of the quarter hour.
- **FR-103** New module `ems/backend/store.be` persists three ring buffers to the device
  filesystem, budgeted for the ESP32:
  | Ring | Slot | Capacity | Coverage |
  |---|---|---|---|
  | `15m` | 15 min | **240** | 60 h |
  | `1d` | 1 day (UTC) | **124** | ≈ 4 months |
  | `1mo` | 1 calendar month | **18** | 18 months |
  Record shape: `[ts, imp_wh, exp_wh, pv_wh, vzev_in_wh, vzev_out_wh]` (integers; `null` where
  unknown; the two vZEV fields default `0` and are written by spec 005).
- **FR-104** Daily and monthly records are **rolled up on the device**: when a 15-min slot closes,
  the store adds it to the running day record; at day/month boundaries the day/month record is
  sealed into its ring. On boot, the current day/month record is rebuilt from the `15m` ring so a
  reboot does not corrupt roll-ups.
- **FR-105** Flash write discipline: the store writes at most **one file write per 15-min close**
  (single file or one file per ring — implementer's choice, e.g. `/energy15m.json`,
  `/energy1d.json`, `/energy1mo.json`). No writes on the 10 s path. Use compact JSON arrays
  (no whitespace). Total storage budget ≤ **16 KB**.
- **FR-106** New module `ems/backend/apiservice.be` (registered like `webservice.be` via
  `tasmota.add_driver` + `web_add_handler`) exposes **GET-only** JSON endpoints:
  - `GET /api/power` → `{"now":<utc>,"samples":[[ts,grid_w,pv_w,bat_w,load_w],…]}` (≤ 90, newest
    last).
  - `GET /api/energy?res=15m|1d|1mo&count=N[&from=<ts>&to=<ts>]` → array of records (newest last):
    `{"ts":…,"imp_wh":…,"exp_wh":…,"pv_wh":…,"vzev_in_wh":…,"vzev_out_wh":…,"partial":bool?,`
    `"cost_import_chf":…,"revenue_feedin_chf":…,"cost_vzev_chf":…,"revenue_vzev_chf":…,`
    `"saving_selfuse_chf":…}`
    Defaults: `res=15m`, `count=96`. `count` capped at ring capacity. Invalid `res` → HTTP 400
    `{"error":"invalid res"}`.
  - `GET /api/meta` → `{"version":"<VERSION.txt>","language":"de","time":<utc>,"tariffs":{…}}`.
- **FR-107** Tariff configuration lives in `site.json` under a new optional key `"tariffs"`
  (defaults in parentheses):
  ```json
  "tariffs": {
    "grid_import_chf_kwh": 0.26,
    "grid_feedin_chf_kwh": 0.18,
    "base_fee_chf_month": 12.5,
    "vzev_export_chf_kwh": 0.22,
    "vzev_import_chf_kwh": 0.22
  }
  ```
  `site.be` gains `site.get_tariffs()` returning this map merged over defaults. **Existing
  `site.json` files without the key must keep loading unchanged.**
- **FR-108** Cost computation (read time, in `apiservice.be`):
  - `cost_import_chf   = (imp_wh − vzev_in_wh)/1000 × grid_import_chf_kwh`
  - `revenue_feedin_chf= (exp_wh − vzev_out_wh)/1000 × grid_feedin_chf_kwh`
  - `cost_vzev_chf     = vzev_in_wh/1000 × vzev_import_chf_kwh`
  - `revenue_vzev_chf  = vzev_out_wh/1000 × vzev_export_chf_kwh`
  - `saving_selfuse_chf= (pv_wh − exp_wh)/1000 × (grid_import_chf_kwh − grid_feedin_chf_kwh)`,
    floored at 0 (answers feedback "Eigenverbrauch in CHF").
  All rounded to 2 decimals. `null` quantities → cost fields `null`.
- **FR-109** Missing data: no fabricated slots (see UC-104). Slots where every accumulator had
  zero *samples* are not stored; slots with some sensors failing store `null` for those fields
  and `"partial": true`.
- **FR-110** Wiring only (C-1): add `store.be`, `meter.be`, `apiservice.be` to `autoexec.be` load
  order (after `site.be`, before `main.be` usage) and start them from `main.be` after
  `site.load_config()`. Add the new files to the Makefile `SRC` list so they are minified into
  the `.tapp`. No changes to existing endpoint code paths.

## Non-Functional Requirements

- **NFR-101** 10 s sampling must not block: reuse the already-fetched `currentPower` values in
  `site.be` state (integrations update them); `meter.be` performs no HTTP calls itself.
- **NFR-102** RAM for the power ring ≤ ~4 KB (90 × 5 ints).
- **NFR-103** All timestamps are UTC epoch seconds (`tasmota.rtc()['utc']`). If RTC is not yet
  synced (epoch < 1e9), sampling runs but slot-closing is deferred until time is valid.
- **NFR-104** JSON responses must be streamed/kept small enough for the Tasmota webserver
  (`count=240` 15m records ≈ 15 KB — acceptable; do not exceed).

## Key Entities

- **PowerSample** `[ts, grid_w, pv_w, bat_w, load_w]` — RAM only.
- **EnergyRecord** `[ts, imp_wh, exp_wh, pv_wh, vzev_in_wh, vzev_out_wh]` — flash rings.
- **Tariffs** — see FR-107.

## Edge Cases

- Clock jump after NTP sync → discard the accumulator of the in-progress slot if the jump crosses
  a slot boundary (never write a slot with a wrong `ts`).
- Counter overflow: Wh values stored as integers; a 15-min slot at 40 kW is 10 kWh = 10 000 Wh —
  far below Berry int limits. Monthly roll-up worst case ≈ 30 × 96 × 10 000 < 2^31. Safe.
- Battery (`bat_w`) is deliberately **not** part of the energy rings in this iteration (review
  question "Wie hat der Speicher Einfluss?"): it appears in live power only; energy accounting
  treats the battery as part of the site behind the meter. Document this in code comments.
- DST: slots are UTC; the frontend renders local time (spec 002 provides the formatter).

## Out of Scope

- vZEV allocation and peer exchange (spec 005 — it *writes* `vzev_in_wh`/`vzev_out_wh` via a
  store API `store.set_vzev(ts, in_wh, out_wh)` that this spec must provide as a stub updating
  the 15m record and its roll-ups).
- Any UI (specs 002–004).
- Per-phase load values ("Last zwischen den Phasen") — future work.

## Existing Code — Extend, Don't Break

- `webservice.be` endpoints (`/fs`, `/app`, `/reload`, `/loads`, `/productions`, `/site`,
  `/grid`) unchanged.
  **Superseded (spec 011 step 1, 2026-09-05):** `/reload` and `/grid` are removed, along with
  the bare `/loads?id=` / `/productions?id=` reads, `action=state`, `action=set-power` and the
  `version`/`language` keys of `/api/meta` — every one of them was dead surface. See
  `specs/011-browser-archive-backend-slimming/spec.md` §A4–A8.
- `ems.be` allocation loop unchanged.
- `tests/test_ems_allocation.be` must still pass via `make test`.

## Testing (required)

Berry CLI tests under `tests/`, run with `cd tests && berry -m .. test_store.be` etc., using the
existing `tests/tasmota.be` stub (extend the stub with `rtc()` if missing):

- `test_store.be`: push > capacity records → oldest evicted; save/load round-trip via a temp
  file; day/month roll-up correctness incl. rebuild-on-boot; `set_vzev` updates 15m + roll-ups.
- `test_meter.be`: feed synthetic samples across a quarter-hour boundary → correct Wh integration
  (e.g. constant 600 W for 15 min → 150 Wh); signed grid split into imp/exp; partial-null
  behaviour when a sensor value is `nil`.
- Cost math (FR-108) unit-tested with the UC-102 numbers.

## Acceptance Checklist

- [ ] `make test` green (old + new tests)
- [ ] `make` produces a `.tapp` containing the new minified modules
- [ ] `/api/power`, `/api/energy`, `/api/meta` respond as specified on-device and via the
      Berry-CLI-testable pure functions
- [ ] Reboot mid-slot loses at most the open slot (UC-103)
- [ ] No flash writes outside slot close (FR-105)
