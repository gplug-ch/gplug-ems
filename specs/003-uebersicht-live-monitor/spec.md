# Feature Specification: «Übersicht» — Live Energy Monitor

**Feature Branch:** `003-uebersicht-live-monitor`
**Created:** 2026-07-14
**Status:** Implemented
**Depends on:** `001-energy-data-and-storage`, `002-ui-shell-design-i18n`
(read `specs/README.md` for shared constraints and the glossary)

> **Implementation note (reconciled 2026-07-27).** Delivered in
> `src/pages/uebersicht.js`.
>
> **Issue #1 (2026-09-23).** The virtual-energy-community panel (former UC-304), its
> stat and its tooltip were removed together with spec 005.

## Overview

The landing page (`#/`). Shows, in real time (10 s), what the site produces, consumes,
imports and exports — understandable for end users without technical
background. Figma frames: `10:310` (exporting site) and `10:458`
(importing site). The page renders the same component tree for both —
which panels/labels appear is purely data-driven.

Layout (Figma): page header = site name + address (from `GET /site`), then stacked full-width
panel cards: **Netzanschluss** (was "GRID"), **Erzeuger**, **Lasten**.

## Use Cases

### UC-301: See the current energy situation at a glance
**Actor:** Resident (e.g. «Familie Huber»)
**Flow:** Opens the app; within one poll cycle sees current grid power, PV production, active
loads, each with a 15-minute live chart.

**Acceptance Scenarios**
- **Given** live data, **When** the page is open, **Then** the Netzanschluss panel shows the
  stat row — Verbrauch (yellow), Erzeugung (blue), Export (green), Import
  Netzbetreiber (red) — each as `fmtW` of the newest sample, and a combined chart of the last
  15 min where import periods are red-filled and export periods green-filled (as in Figma).
- **Given** 10 s pass, **Then** new samples appear without page reload (poll `GET /api/power`).

### UC-302: Understand each producer's contribution
**Acceptance Scenarios**
- **Given** productions `PV` and `Batterie` configured, **Then** the Erzeuger panel shows one
  sub-chart per production (2-up grid on desktop, stacked on mobile) with its friendly name and
  current power (`fmtW`, blue line).
- **Given** the battery discharges 600 W, **Then** its value shows `600 W` and the line is above
  zero; charging shows negative values below the visible 0-axis (answers the battery feedback —
  the battery is a signed producer here).

### UC-303: See what the EMS is doing with loads
**Acceptance Scenarios**
- **Given** loads from `GET /loads`, **Then** the Lasten panel shows one sub-chart per load with
  friendly name, rated power (`fmtW(currentPower)` + «Nennleistung», not "2000kWh rated" — the
  prototype's unit was wrong), priority («Priorität 1»), a state `<Badge>` (Aktiv/Wartend/
  Inaktiv) and its power line (yellow) — power = rated power while ACTIVE, else 0, from
  `/api/power` `load_w` split? **No:** per-load history is client-side: each poll, record
  `state=="ACTIVE" ? currentPower : 0` per load id (15 min RAM window in the frontend).
- **Given** the user taps a load card, **Then** a state toggle is offered: Inaktiv → Wartend
  («Anfordern») and Aktiv/Wartend → Inaktiv («Deaktivieren»), calling the existing
  `GET /loads?id=<id>&action=transition&to=<state>` and reflecting the response. (This preserves
  the existing API contract, C-1.)

### UC-304: (removed)
The community-partner panel was removed with issue #1.

### UC-305: Get an optimization hint
**Acceptance Scenarios**
- **Given** grid import > 0 while PV export to grid was > 0 in the last 15 min — or waiting
  loads exist while `available power ≥ smallest waiting load` — **Then** a dismissible hint
  banner appears (ⓘ, amber left border), e.g. i18n `hint.shift_load`: «Aktuell wird Strom
  eingespeist — ein guter Zeitpunkt, um grosse Verbraucher einzuschalten.» (review feedback:
  Optimierungshinweise). At most one hint at a time; dismissed hints stay hidden for the session.
  **Superseded (2026-09-21, after issue #19):** the hint banner is removed. The Stromfluss
  headline already states the live situation («PV deckt 81 % des Verbrauchs · 241 W vom Netz»),
  so the banner only repeated it and pushed the flow card down.

## Functional Requirements

- **FR-301** Panel titles from i18n: `panel.grid` = «Netzanschluss» (replaces "GRID", review
  feedback), `panel.production` = «Erzeuger», `panel.loads` = «Lasten».
- **FR-302** Each panel card uses its group accent (002 FR-207 left border) so the three groups
  are immediately distinguishable.
- **FR-303** **Every chart has labeled axes with dimensions** (002 FR-211): y `[kW]`/`[W]`
  auto-scaled per chart, x-axis local-time ticks (`HH:MM`) plus `[h]`-style unit tag —
  no unlabeled axes anywhere (review feedback).
- **FR-304** All charts on the page share the **same x-time-window** (now − 15 min → now),
  driven by one clock in the page component — the Erzeuger/Lasten charts cover exactly the
  Netzanschluss range (review feedback "gleicher Zeitraum wie GRID").
- **FR-305** Netzanschluss stat semantics (from `/api/power` newest sample):
  - Verbrauch = `pv_w + bat_w − min(grid_w,0)·(−1) + max(grid_w,0)` → implement as
    `pv_w + bat_w + grid_w` where grid_w signed (import positive) — show tooltip
    `tooltip.consumption` (Verbrauch ≠ Lasten, glossary).
  - Erzeugung = `pv_w` (+ battery discharge if positive).
  - Import Netzbetreiber = `max(grid_w,0)`, red.
  - Export = `max(−grid_w,0)`, green.
- **FR-306** Stat values use the darkened contrast palette (002 FR-209), each stat labeled and
  with `<Tooltip>` for Verbrauch and Netzbetreiber terms (`tooltip.*` keys).
- **FR-307** Units in stats: **live power in W/kW** (`fmtW`). The prototype mixed kWh/W in stat
  rows — do not copy that; energy totals (kWh) belong to Verlauf. (Review feedback:
  consistent dimensions.)
- **FR-308** Hint banner engine per UC-305: pure function `computeHints(power, loads) →
  hint|null`, unit-testable, i18n-keyed texts.
  **Superseded (2026-09-21):** removed together with UC-305.
- **FR-309** Polling: `GET /api/power` + `GET /loads` every 10 s, `GET /productions` every 10 s
  (for names/battery split), `GET /site` once; pause when tab hidden (002 FR-214).
- **FR-310** Empty/error states: no productions → Erzeuger panel hidden; no loads → Lasten
  panel hidden; API error → shell toast (002) with last data retained and «zuletzt aktualisiert
  HH:MM:SS» note in the page header.

## Non-Functional Requirements

- **NFR-301** Chart re-render ≤ 16 ms for 90-point series on a mid-range phone (simple SVG
  path recompute; no full remount per poll).
- **NFR-302** Page works read-only: nothing here writes config; the only mutation is the load
  state transition (existing endpoint).

## Key Entities

- **PowerSample** (from 001), **Load/Production/Site** (existing endpoints).

## Edge Cases

- Fewer than 90 samples after boot → charts render the partial window, x-range still 15 min.
- `grid` not configured (404 from `/grid`) → Netzanschluss panel shows only Erzeugung/Verbrauch
  derived stats that are computable, others «—».
- Sample gaps (device paused) → line gap, not interpolation (001 UC-104 / 002 FR-211).
- Load with `url` object but unreachable device → state badge from last known state; toggling
  shows error toast on non-200.

## Out of Scope

- Historic/energy values (spec 004), settings (006).
- Peak-load detection (004 FR-409 — it is a history feature).

## Existing Code — Extend, Don't Break

- Uses existing `GET /site`, `/loads`, `/productions`, `/grid` and the transition action —
  unchanged contracts (C-1).
- New code exclusively in `ems/frontend/src/pages/uebersicht.js` (+ small shared additions),
  wired into the 002 router.

## Testing (required)

- Unit tests (plain JS run by `node --test` or an existing repo pattern; if none, a minimal
  `tests/frontend/` with node:test): `computeHints`, Verbrauch derivation (FR-305), per-load
  history recording (UC-303), window alignment (FR-304 helper).
- Manual checklist: both Figma variants reproduced (producer & consumer datasets), 360/768/1440
  px screenshots, axis labels visible on every chart.

## Acceptance Checklist

- [ ] Page matches Figma `10:310` / `10:458` structure with the corrected terminology & units
- [ ] All charts share one time window and have labeled axes with dimensions
- [ ] Group accent colors distinguish the three panels
- [ ] Load toggle round-trips through the existing GET transition endpoint
- [ ] Tooltips explain Verbrauch/Lasten/Netzbetreiber terms
- [ ] ~~Hint banner appears/disappears per UC-305 and is unit-tested~~ (removed 2026-09-21)
