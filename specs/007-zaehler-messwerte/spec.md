# Feature Specification: «Zähler» — Smart-Meter-Messwerte & Phasen

**Feature Branch:** `007-zaehler-messwerte`
**Created:** 2026-07-28
**Status:** Implemented (2026-07-29)
**Depends on:** `001-energy-data-and-storage`, `002-ui-shell-design-i18n`
(read `specs/README.md` for shared constraints, personas and the glossary)

## Overview

Target persona: **Kunde A — der technisch versierte Nutzer** (Elektro-/Elektronik-Hintergrund),
der *alle* verfügbaren Zählerdetails sehen will: Phasenwerte, Register, Blindleistung,
Tarifstatus — vergleichbar mit der Tasmota-Web-UI oder dem Home-Assistant-Energiedashboard.

Today the gPlug integration (`integrations/gplug.be`) parses the full Tasmota
Smart-Meter-Interface sensor object (JSON key `z` from `tasmota.read_sensors()`) but surfaces
only the two configured power fields (`Pi`/`Po`). Everything else the meter descriptor decodes
— per Swiss standard CIP list typically: import/export energy totals (OBIS 1.8.0/2.8.0),
reactive energy (3.8.0/4.8.0), instantaneous power (1.7.0/2.7.0), per-phase voltage
(32/52/72.7.0) and current (31/51/71.7.0), on newer firmware per-phase active/reactive power
(21/41/61.7.0 …), active tariff (96.14.0), device ID — is parsed and then discarded.

This spec adds one tiny passthrough endpoint (`GET /api/meter`) and a new page **«Zähler»**
(`#/zaehler`) that renders whatever the meter delivers. All interpretation (labels, units,
grouping, derived values, min/max) happens in the browser (device-serves-raw principle,
001/C-3). The page degrades gracefully across the real-world meter heterogeneity: full
extended CIP list, 15-element Basisliste (no per-phase power), legacy smart-me lists, or a
descriptor exposing only `Pi`/`Po`.

## Use Cases

### UC-701: Inspect live per-phase values
**Actor:** Kunde A (Elektroniker)
**Flow:** Opens «Zähler»; sees a live phase table L1/L2/L3 and the signed total power,
refreshed every 10 s.

**Acceptance Scenarios**
- **Given** a meter pushing the extended CIP list, **When** the page is open, **Then** a table
  shows per phase: Spannung [V], Strom [A], Wirkleistung Bezug/Einspeisung [W], Blindleistung
  [var], plus a derived row «Schieflast» (max−min phase active power, marked as derived).
- **Given** a meter pushing only the Basisliste (no per-phase power), **Then** the table shows
  only Spannung and Strom per phase; the Wirkleistung/Blindleistung rows and the Schieflast row
  are absent — no empty cells, no «—»-filled skeleton rows.
- **Given** 10 s pass, **Then** values update without reload (poll `GET /api/meter`).

### UC-702: See the authoritative meter registers
**Acceptance Scenarios**
- **Given** energy registers exist in the data, **Then** a «Zählerstände» section shows
  Bezug total [kWh], Einspeisung total [kWh] and — when present — Blindenergie registers and
  per-tariff registers, each labeled with its OBIS-style meaning and marked **Register**
  (authoritative billing value) as opposed to **berechnet** (derived).
- **Given** the meter reports the active tariff (96.14.0-style field), **Then** a badge shows
  «Hochtarif»/«Niedertarif» (mapping 1→HT, 2→NT, tooltip with raw value).

### UC-703: Raw register view
**Acceptance Scenarios**
- **Given** the user enables «Rohdaten anzeigen» (toggle, default off), **Then** *every* field
  of the sensor object is listed: field name as delivered by the meter descriptor, raw value,
  unit (if known from the catalog), i18n label or «unbekanntes Register». Nothing the device
  delivers is hidden — including fields unknown to the catalog.
- **Given** an unknown field, **Then** it appears under «Weitere Register» with its raw name —
  the page must never crash or skip on unexpected fields.

### UC-704: Judge data freshness and quality
**Acceptance Scenarios**
- **Given** live data, **Then** the page header shows «zuletzt aktualisiert HH:MM:SS» and the
  poll age; **Given** the energy import register has not increased across ≥ 6 consecutive polls
  (≈ 1 min) while total power indicates import, **Then** a stale-data hint appears («Zähler
  liefert möglicherweise keine neuen Daten») — the CII push is ≤ 10 s, so frozen counters
  indicate a stuck link.
- **Given** `GET /api/meter` returns no values (no sensor data), **Then** the page shows an
  empty state («Keine Zählerdaten — gPlug-Integration prüfen») instead of zeros.

### UC-705: Session statistics
**Acceptance Scenarios**
- **Given** the page has been open for a while, **Then** a «Min/Max (Sitzung)» section shows,
  per phase, min/max Spannung and the peak import/export power since page open (browser RAM
  only, reset on reload; clearly labeled «seit Seitenaufruf»).

## Functional Requirements

Backend (Berry, minimal by design):

- **FR-701** New endpoint `GET /api/meter` in `webservice.be` →
  `{"now": <utc>, "values": {…}}` where `values` is the parsed sensor object under key `z`
  verbatim (no per-field processing, no allocation-heavy transforms on device). When no sensor
  data is available: `{"now": <utc>, "values": null}`. Reuses the same guarded
  read-and-parse path as `integrations/gplug.be` (extract the shared helper rather than
  duplicating the parse).
- **FR-702** The endpoint performs no `webclient` call and no flash access — `read_sensors()`
  is local. It must not interfere with the one-op-per-tick outbound scheduler (`site.be`).

Frontend:

- **FR-703** New nav entry «Zähler» (i18n `nav.meter`), route `#/zaehler`, page
  `src/pages/zaehler.js`. Hidden entirely when the grid config contains no `gplug` integration
  item (the page is meter-specific; simulator/HA-only sites don't show it).
- **FR-704** Field catalog `src/lib/metercat.js` (pure data + lookup): maps common Tasmota-SMI
  json field names and OBIS-derived names to `{group, i18nKey, unit, kind}` where
  `kind ∈ {register, live, meta}` and `group ∈ {power, phases, energy, reactive, tariff, meta}`.
  Must cover at minimum: `Pi`/`Po` (gPlug default fields), the Swiss standard CIP list
  (1.8.0, 2.8.0, 3.8.0, 4.8.0, 1.7.0, 2.7.0, 16.7.0, per-phase 21/41/61.7.0, 22/42/62.7.0,
  23/43/63.7.0, 24/44/64.7.0, 31/51/71.7.0, 32/52/72.7.0, 96.14.0) under their typical
  descriptor json names, and meter serial/device-id fields. Unknown → `null` (caller renders
  raw). Catalog lookup is case-insensitive and tolerates common name variants
  (`volt_l1`, `U_L1`, `32_7_0`, …).
- **FR-705** Page sections in order: ① Leistung (big signed total power stat, import red /
  export green per 002 palette), ② Phasen (table per UC-701), ③ Zählerstände (UC-702),
  ④ Min/Max Sitzung (UC-705), ⑤ Rohdaten (UC-703, collapsed by default). Sections render
  only when at least one of their fields exists (UC-701 degradation).
- **FR-706** Derived values are computed in the browser and visually marked (i18n
  `meter.derived`, dashed underline + tooltip explaining the formula): Schieflast, cosφ
  (= P/√(P²+Q²), only when both P and Q are present), kW→W normalization. Register values are
  shown exactly as delivered (no rounding beyond display precision from the catalog).
- **FR-707** Polling `GET /api/meter` every 10 s, pause when tab hidden (002 FR-214); the page
  keeps its own RAM window (≤ 90 samples) for min/max and staleness detection — no new device
  storage.
- **FR-708** All labels/units via i18n keys (`meter.*`); tooltips explain every technical term
  (Blindleistung, Schieflast, cosφ, Register vs. berechnet, Hoch-/Niedertarif) per 002 FR-210.

## Non-Functional Requirements

- **NFR-701** `/api/meter` handler adds ≤ ~30 lines minified Berry; response is the sensor JSON
  re-serialized once; no ring buffers, no timers, no flash writes on device.
- **NFR-702** Page + catalog add ≤ 12 KB to the JS bundle (C-3 budget: total assets ≤ 150 KB).
- **NFR-703** Rendering tolerates any `values` shape (missing keys, strings, nested objects)
  without exceptions — catalog misses degrade to raw display.

## Key Entities

- **MeterSnapshot** — `{now, values}` from `/api/meter`; `values` is the untyped meter
  descriptor output.
- **FieldDescriptor** (frontend catalog) — `{group, i18nKey, unit, kind}`.
- **SessionStats** (frontend RAM) — per-field min/max since page open.

## Edge Cases

- Meter descriptor delivers strings (serial numbers) → rendered under Meta/Rohdaten, never
  passed to number formatting.
- Values in kW instead of W → catalog `unit` drives normalization for display; totals keep the
  meter's unit in the Register section.
- Only `Pi`/`Po` present → page shows section ① from those two fields (signed total derived
  as Pi−Po, marked derived), sections ②–④ hidden except Rohdaten.
- Sensor JSON present but no `z` key (foreign Tasmota sensors) → treated as `values: null`.
- Negative/zero voltage or absurd outliers (decode glitch) → shown raw; min/max tracker ignores
  exact zeros for voltage (typical glitch value) — documented in a tooltip.

## Out of Scope

- Historic storage of per-phase values (no new flash rings; 001's `[imp,exp,pv]` slots stay
  the only persisted series).
- Tariff-split *energy accumulation* (T1/T2 kWh derivation over time) — dependent on 009's
  HT/NT window config; a later iteration can integrate 1.8.0 deltas against 96.14.0.
- Meter configuration/descriptor editing (descriptors are provisioned on the gPlug, not in
  this UI).
- Non-gPlug integrations (HA/Shelly/simulator expose no meter registers).

## Existing Code — Extend, Don't Break

- `integrations/gplug.be` keeps its contract; the sensor read/parse guard is extracted into a
  shared helper both the integration and the new endpoint use (C-1: `fetch_item` behavior
  unchanged, existing tests keep passing).
- New endpoint added in `webservice.be` next to the existing `/api/*` handlers; frontend code
  exclusively in `src/pages/zaehler.js` + `src/lib/metercat.js`, wired into the 002 router
  and shell nav.

## Testing (required)

- Berry test (`tests/`): `/api/meter` with stubbed `tasmota.read_sensors()` — valid `z`,
  missing `z`, malformed JSON, empty string → correct `{now, values}` shapes, no exceptions.
- JS unit tests (node:test): catalog lookup incl. variants and unknowns; Schieflast; cosφ;
  kW normalization; staleness heuristic (frozen counter detection); min/max tracker incl.
  zero-voltage glitch rule.
- Manual checklist: page rendered against three fixture payloads — extended CIP list,
  Basisliste only, `Pi`/`Po` only — at 360/768/1440 px.

## Implementation note (2026-07-28, Implemented)

Shipped as specified, with two reconciliations against the codebase:

- **Endpoint location.** `GET /api/meter` lives in the existing `webservice.be`
  (next to `/api/power`/`/api/energy`/`/api/meta`), not a new module — matching
  the 001–006 divergence noted in `specs/README.md`. The shared read-and-parse
  guard was extracted as `gplug.read_z()` (used by both `gplug.fetch_item` and
  the endpoint). The payload is built by the pure `WebService.meter_payload`
  (unit-tested via `tests/test_meter_api.be`).
- **Dev meter source (no physical meter).** To develop the page without a real
  smart meter, an *optional* `"meter": {integration, url}` block in `site.json`
  lets the device pull a synthesised descriptor from the Kotlin simulator's new
  `GET /simulator/sites/{siteId}/meter[?variant=full|basis|minimal]` endpoint.
  It is polled through site.be's existing **one-op-per-tick** scheduler and
  cached, so `/api/meter` still fires no webclient (FR-702) — on a real gPlug
  the block is omitted and the endpoint reads the local sensor directly. The
  `variant` param serves the three fixtures the manual checklist needs. The
  nav-gate (FR-703) reveals «Zähler» whenever `/api/meter` returns non-null
  `values` (covers both the real gPlug sensor and the simulated source),
  instead of inspecting the grid config for a `gplug` item.

## Acceptance Checklist

- [x] `/api/meter` serves the raw sensor object with the shared parse guard (Berry-tested)
      — `webservice.be:meterrequest` via `gplug.read_z()`; `tests/test_meter_api.be` (7 checks).
- [x] «Zähler» page shows phases, registers, min/max and raw view per UC-701…705
      — `pages/zaehler.js`; verified live against the simulator (full/basis/minimal/empty).
- [x] Sections/rows absent (not empty) when the meter doesn't deliver their fields
      — Basisliste hides Wirkleistung/Blindleistung/cos φ/Schieflast + reactive registers; Pi/Po-only shows section ① only.
- [x] Register vs. derived values visually distinguished, every term has a tooltip
      — REGISTER/BERECHNET tags, dashed-underline derived values, tooltips on Blindleistung/Schieflast/cos φ/Register/Tarif.
- [x] Stale-data hint fires on frozen counters; empty state on missing sensor data
      — `metercat.isStale` (frozen import register + importing, ≥6 polls); «Keine Zählerdaten» on `values: null`.
- [x] Nav entry hidden without meter data
      — gated on `/api/meter` returning non-null `values` (see Implementation note); covers real gPlug sensor + simulated source, hidden on simulator/HA-only sites.
- [x] Bundle growth ≤ 12 KB; no new flash writes; existing tests green
      — total assets ≈ 142 KB (< 150 KB C-3 budget); device does no flash writes on the meter path; `make test` + `npm test` green.

## Testing status

- **Berry:** `make test` green, incl. new `tests/test_meter_api.be` (parse guard + payload shape).
- **JS:** `npm test` green — `tests/test_metercat.mjs` (catalog variants/unknowns, Schieflast, cos φ,
  kW→W, staleness, Min/Max zero-voltage glitch), 19 checks.
- **Kotlin:** `./gradlew test` green (Spring Modulith boundary verification passes with the new `meter` module).
- **Manual (browser, 2026-07-29):** page driven against the simulator at the three fixture payloads
  (extended CIP list, Basisliste, Pi/Po-only) plus the empty and unknown-field cases; nav-gate confirmed both ways.
