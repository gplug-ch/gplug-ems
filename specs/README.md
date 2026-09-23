# gPlug UI — Feature Specifications

Spec-kit format specifications for the gPlug Energy-Monitoring UI (EMS on a gPlug site).

> **Virtual energy community removed (issue #1).** Specs 005 (community exchange) and 009
> (community operation) were deleted together with the feature; their numbers are not reused.
> The HT/NT tariff split that 009 introduced survives as a plain grid-import tariff feature.

Each spec is a **vertical slice implementable with a single prompt**, e.g.:

> Implement `specs/003-uebersicht-live-monitor/spec.md`. Read the spec and every spec it
> depends on first. Only extend the existing codebase — all existing behaviour, endpoints
> and tests must keep working. If a frontend-design skill is available, load it before
> writing UI code.

## Implementation order & dependencies

| # | Spec | Status | Scope | Depends on |
|---|------|--------|-------|-----------|
| 001 | [energy-data-and-storage](001-energy-data-and-storage/spec.md) | Implemented | Berry backend: 10 s power sampling, 15 min energy accumulation, flash ring storage, `/api/*` endpoints | — |
| 002 | [ui-shell-design-i18n](002-ui-shell-design-i18n/spec.md) | Implemented | Preact app shell, routing, design system, i18n (per-language build), on-device serving, Makefile integration | — |
| 003 | [uebersicht-live-monitor](003-uebersicht-live-monitor/spec.md) | Implemented | «Übersicht» page: live power panels (Netzanschluss, Erzeuger, Lasten) | 001, 002 |
| 004 | [verlauf-history](004-verlauf-history/spec.md) | Implemented | «Verlauf» page: energy/cost table, resolutions, CSV export | 001, 002 |
| 006 | [einstellungen](006-einstellungen/spec.md) | Implemented | «Einstellungen» page: Site / Lasten / Produktion / Netzanschluss / Tarife, config write API | 002 |
| 007 | [zaehler-messwerte](007-zaehler-messwerte/spec.md) | Implemented | «Zähler» page: full smart-meter detail (phases, registers, raw view), `/api/meter` passthrough | 001, 002 |
| 008 | [energiefluss-kennzahlen](008-energiefluss-kennzahlen/spec.md) | Draft¹ | Energy-flow diagram, Autarkie/Eigenverbrauch KPIs, Bilanz view, Ersparnis/CO₂ — pure frontend | 001–004 |
| 010 | [live-energiefluss-ux](010-live-energiefluss-ux/spec.md) | Draft¹ | Live flow view UX: Swiss color conventions, direction legibility, producer-visibility fixes, Herkunft/Verwendung stacked bars — pure frontend | 002, 003, 008 |
| 011 | [browser-archive-backend-slimming](011-browser-archive-backend-slimming/spec.md) | Implemented | Browser-side IndexedDB archive of raw 15-min data (incremental sync, roll-ups/costs in the browser, export/import); device shrinks to an append-only 30-day buffer; dead endpoints, device-side validation and roll-ups removed (~20 KB less Berry) | 001, 004, 006 |
| 012 | [battery-storage](012-battery-storage/spec.md) | Implemented | Battery as an observed storage item (issue #20): SoC/capacity/limits config, SoC via gplug field or HA entity, battery left out of the load allocation, charge/discharge Wh in the 15-min records (behind the meter), Übersicht SoC, Verlauf columns, Einstellungen, simulator SoC model | 001, 003, 004, 006, 008, 010, 011 |

¹ The spec header still says *Draft*, but most of it ships (energy-flow view and KPIs —
`kpi.*` / `flow.*` / `comp.*` UI in `ems/frontend/src/`); the spec status has not yet been
reconciled with the code.

001 and 002 are independent of each other and can be built in parallel.
003, 004 and 006 each assume 001 + 002 are merged.
007 and 008 are independent of each other and can be built in parallel.
010 assumes 008 is merged.
011 assumes 001–008 are merged and is the first spec that *removes* device behaviour.

> **Status (2026-09-05): spec 011 fully implemented (v1.0.10 / v1.0.11 / v1.0.12 /
> v1.0.13).** Step 3a moved the history into the browser: `ems/frontend/src/lib/archive.js`
> keeps every raw 15-min record in IndexedDB, and Verlauf / KPIs derive from it; the
> device's retention grew to 30 days and
> `/api/energy?from=` pages forward. Step 3b (v1.0.13, pre-repo versioning) then deleted the redundant
> device side — day/month roll-ups and the former community allocation — so the device
> is now an **append-only** raw buffer that serves `res=15m` only. `.tapp` 94 541 → 74 836 B.
>
> **Status (2026-09-05): spec 011 added (Draft)** — size analysis of the v1.0.9 `.tapp`
> (94.5 KB, all Berry). Introduces a browser-side IndexedDB archive so the device keeps only
> an append-only raw buffer; deletes dead endpoints (`/grid`, `/reload`, `set-power`,
> `meta.version/language`), device-side config validation, day/month roll-ups and the
> file-rewrite path. Overrides C-1 for the listed removals. Three shippable steps.
>
> **Status (2026-07-29): spec 010 added (Draft)** — UX review of the live flow view:
> Swiss/DACH color-convention alignment (Produktion gelb / Verbrauch blau / Bezug rot /
> Einspeisung grün), direction legibility, five code-verified producer-visibility defects
> (D-1…D-5, incl. missing `flow.*`/`kpi.*` i18n keys and null-power fake zeros), and a
> Herkunft/Verwendung composition-bar pair. Pure frontend.
>
> **Status (2026-07-28): specs 001–007 are Implemented; 008 is Draft** (persona-driven
> extension round, see «Personas» below). 007 «Zähler» added `GET /api/meter` (raw SMI
> passthrough), the browser field catalog `lib/metercat.js` + page `pages/zaehler.js`, and a
> smart-meter generator in the simulator (`/simulator/sites/{id}/meter`) for meterless dev.
>
> **Status (2026-07-27): all six base specs are Implemented.** Each `spec.md` carries
> an "Implementation note" reconciling it with the shipped code. The two notable
> architecture divergences from these drafts: (a) the frontend is built with
> **Vite** (CDN / dev modes; the self-host mode was removed later) rather than the no-build `bundle.py`
> concatenation described in spec 002; (b) the `/api/*` handlers live in the
> existing **`webservice.be`** / **`configservice.be`** modules,
> not a single new `apiservice.be`.

## Shared, non-negotiable constraints

These apply to **every** spec below and are not repeated in full each time:

- **C-1 Preserve behaviour.** The existing Berry modules (`ems.be`, `site.be`, `webservice.be`,
  `integrations/*.be`, `logger.be`, `main.be`, `autoexec.be`) and their HTTP
  contracts must keep working unchanged. `make test` (existing `tests/test_ems_allocation.be`)
  must still pass. New functionality is added in **new modules / new endpoints**; existing files
  are only touched for wiring (imports and start calls in `main.be`, Makefile — `autoexec.be`
  now `load()`s only `main.be`, which imports the whole module graph).
- **C-2 No external servers.** The UI must be fully served from the device (`.tapp`). No CDN
  (`esm.sh`, Bootstrap CDN, Google Fonts, …), no telemetry, no third-party requests. This is a
  legal/privacy requirement of the project ("Es werden keine Daten an externe Server übertragen").
  *Superseded for asset delivery:* the default build now loads the JS/CSS bundle and `lang.json`
  from a CDN (GitHub Pages, see spec 002's implementation note and the root `CLAUDE.md`);
  there is no self-hosted build any more (`make build-self` was removed). No site data leaves the device.
- **C-3 Device limits.** ESP32 flash filesystem and RAM are highly limited:
  - Total new UI assets (html + js + css + i18n) ≤ **150 KB** uncompressed.
  - Flash writes for data storage ≤ 1 write per 15 minutes per file (flash wear).
  - RAM-resident timeseries bounded (ring buffers with fixed capacity).
- **C-4 Language.** All user-facing text in **German** by default, via i18n keys (spec 002).
  Terminology is consistent and defined in the shared glossary below. No mixed-language UI.
- **C-5 Design.** Follow the Figma prototype design system (spec 002). Figma file:
  `https://www.figma.com/design/dZIKVwxjD12gcPUAHVuzkx/gPlug-UI`.
- **C-6 Berry conventions.** New backend modules follow the existing module singleton pattern
  (module() + class + `_instance` + lambda delegation), are imported from `main.be`, minified by
  `ems/backend/minify.py` (no `#` in string literals it can't handle — keep comments on their own
  lines), and get Berry CLI tests under `ems/backend/tests/` using the existing `tests/tasmota.be` stub.
- **C-7 Prior art** *(obsolete — historical only: neither commit exists in this repository, which
  starts at the initial import, and `ems/backend/build/` holds no such copies).* Commits `cc41a90` ("store EMS data in storage") and `ff709a0` ("move UI to
  ems code") were intentionally reset away but remain in the git object store, and stale copies of
  `meter.be`, `store.be`, `uiwebservice.be` sit in `ems/backend/build/` (git-ignored build output).
  They are **drafts, not the contract** — where this spec differs (e.g. 15-min slots instead of
  30 s slots), the spec wins. They may be consulted for Berry idioms (`tasmota.rtc()`, driver
  hooks, `path`/`json` usage).

## Personas (specs 007–008)

The extension round is driven by end-customer personas; each maps to one spec:

| Persona | Wants | Spec |
|---|---|---|
| **A — Technik-affiner Nutzer** (Elektro-Hintergrund) | All smart-meter details: per-phase V/A/P/Q, registers with OBIS meaning, raw values, data age, min/max, tariff status — Tasmota/HA power-user level | 007 |
| **B — PV-Besitzer** (kein Technik-Hintergrund) | At-a-glance monitoring like Solar.web/mySolarEdge: energy-flow diagram, Autarkie/Eigenverbrauch %, Bilanz, Ersparnis CHF, CO₂ | 008 |

Research grounding (2026-07-28): Tasmota Smart-Meter-Interface metric set & Swiss standard
CIP list (Landis+Gyr E450/E360, StromVV Art. 8a Kundenschnittstelle, ≤ 10 s push, per-phase
V/A(+P/Q on newer firmware), no frequency/power factor/tariff-split registers in the standard
push); PV-portal KPI canon (Fronius/SolarEdge/SMA/HA Energy).

## Glossary (binding terminology, German UI)

The second column names representative keys as they exist in `ems/frontend/lang.json` (keys are
namespaced by UI area, e.g. `panel.*`, `stat.*`, `history.col.*`), or the raw record field where
the term is a data field.

| Term (UI) | i18n key / field | Meaning |
|---|---|---|
| Netzanschluss | `panel.grid` | The site's grid connection point (smart-meter measurement). Panel name — replaces the prototype's "GRID" per review feedback. |
| Netzbezug | `history.col.gridimport` / field `imp_wh` | Energy imported from the public grid (Wh). |
| Netzeinspeisung | `history.col.feedin` / field `exp_wh` | Energy exported to the public grid (Wh). |
| Verbrauch | `stat.consumption`, `tooltip.consumption` | Total site consumption = PV-Produktion − Netzeinspeisung + Netzbezug. Includes *all* consumers, not only controllable loads. |
| Lasten | `panel.loads`, `tooltip.loads` | The **controllable** loads managed by the EMS (subset of Verbrauch). |
| Erzeuger / Produktion | `panel.production` / field `pv_wh` | Energy sources: PV, battery discharge. |
| Anteil PVA / Eigenverbrauch | `kpi.selfuse_short`, `tooltip.selfuse` | Self-consumed PV = PV-Produktion − Netzeinspeisung. |
| Zähler | `meter.*` | The smart meter read via the gPlug (Tasmota SMI, sensor key `z`). Page name (007). |
| Register / berechnet | `meter.register` / `meter.derived` | Register = authoritative value from the meter; berechnet = derived in the browser (007). |
| Schieflast | `meter.imbalance` | Phase imbalance: max−min per-phase active power (007, derived). |
| Blindleistung | `meter.reactive` | Reactive power ±Q [var]; cosφ derived from P and Q (007). |
| Autarkiegrad | `kpi.autarky` | (Verbrauch − Netzbezug) / Verbrauch — share of consumption covered locally (008). |
| Batterie laden / entladen | `history.col.batcharge` / `history.col.batdischarge`; fields `bat_chg_wh` / `bat_dis_wh` | Battery charge / discharge energy per slot, behind the meter; Verbrauch then = PV − Netzeinspeisung + Netzbezug + Entladen − Laden (012). |
| Eigenverbrauchsgrad | `kpi.selfuse` | (PV-Produktion − Netzeinspeisung) / PV-Produktion (008). |
| Bilanz | `history.chart.mode_bilanz`, `history.bilanz.*` | Verlauf chart mode: production vs. consumption, split self/grid (008). |
| Hochtarif / Niedertarif | `tariff.ht` / `tariff.nt` | External grid-import tariff periods (HT windows configurable); slot tariff derived in the browser. |

The distinction *Verbrauch vs. Lasten* answers review feedback ("Macht es Sinn, 'Lasten' und
'Verbrauch' gleich zu benennen?"): they are different concepts, never used interchangeably, and
both get an explanatory tooltip in the UI.

### Removed / superseded terms

Older spec text still mentions these; none of them exists in the current code:

| Term | Status |
|---|---|
| vZEV / virtuelle Energiegemeinschaft, community allocation, peer slots, `vz15` archive store, quarterly settlement, `vzev.json` | Removed with specs 005/009 (issue #1). Only cleanup code remains: `store.be` deletes a leftover `/vzev.json` and peer buckets on load, `lib/archive.js` drops the `vz15` IndexedDB store. |
| UDP messaging between devices (community protocol, `udpclient.json`) | Removed (issue #1). Each device is standalone; there is no inter-device communication. |
| Device roll-ups `/e1d` (day) and `/e1mo` (month) | Removed in spec 011 step 3b; roll-ups are computed in the browser (`lib/archive.js`, `lib/aggregate.js`). `GET /api/energy` serves `res=15m` only; `store.be` deletes leftover files on load. |
| `ems.json` | Superseded: `site.json` is the only device config. |
| `apiservice.be`, `uiwebservice.be` | Never shipped: the `/api/*` handlers live in `webservice.be` / `configservice.be`. |
| Flash ring storage (spec 001) | Superseded by the append-only raw 15-min buffer (`KEEP_DAYS = 30`, spec 011). |

## Review feedback traceability

Feedback on the Figma prototype is folded into the specs as requirements:

| Feedback | Spec / Requirement |
|---|---|
| Axis labels + dimensions on every chart | 003 FR-303, 004 FR-405 |
| Erzeuger / Lasten groups visually distinct | 002 FR-207, 003 FR-302 |
| Consistent language, i18n support | 002 FR-203…FR-206 |
| "GRID" panel name | Glossary: «Netzanschluss» (003 FR-301) |
| Verlauf: consistent dimensions, units only in header | 004 FR-404 |
| Verlauf: scrollable? how many entries? | 004 FR-402 (pagination, 10/25/50) |
| Verlauf: resolution boundaries highlighted | 004 FR-403 |
| Titles aligned | 002 FR-208 |
| Readability of yellow/green/red on cream | 002 FR-209 (contrast-checked palette) |
| Same time range across Übersicht panels | 003 FR-304 |
| «Lasten» vs. «Verbrauch» naming | Glossary + 003 FR-306 |
| Battery influence | 003 FR-305 (signed battery power) |
| Eigenverbrauch in CHF | 004 FR-407 |
| Holiday / pure-export scenario | 004 Edge cases |
| Averages, year-over-year, trends | 004 FR-408 |
| Peak-load detection | 004 FR-409 |
| Optimization hints (shift load into PV hours) | 003 FR-308 — removed 2026-09-21; the Stromfluss headline covers it |
| Tooltips / explanations of technical terms | 002 FR-210, used by 003–006 |
