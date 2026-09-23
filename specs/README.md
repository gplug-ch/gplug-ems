# gPlug UI — Feature Specifications

Spec-kit format specifications for the gPlug Energy-Monitoring UI (vZEV).
Each spec is a **vertical slice implementable with a single prompt**, e.g.:

> Implement `specs/003-uebersicht-live-monitor/spec.md`. Read the spec and every spec it
> depends on first. Only extend the existing codebase — all existing behaviour, endpoints
> and tests must keep working. If a frontend-design skill is available, load it before
> writing UI code.

## Implementation order & dependencies

| # | Spec | Scope | Depends on |
|---|------|-------|-----------|
| 001 | [energy-data-and-storage](001-energy-data-and-storage/spec.md) | Berry backend: 10 s power sampling, 15 min energy accumulation, flash ring storage, `/api/*` endpoints | — |
| 002 | [ui-shell-design-i18n](002-ui-shell-design-i18n/spec.md) | Preact app shell, routing, design system, i18n (per-language build), on-device serving, Makefile integration | — |
| 003 | [uebersicht-live-monitor](003-uebersicht-live-monitor/spec.md) | «Übersicht» page: live power panels (Netzanschluss, Erzeuger, Lasten, vZEV) | 001, 002 |
| 004 | [verlauf-history](004-verlauf-history/spec.md) | «Verlauf» page: energy/cost table, resolutions, CSV export | 001, 002 |
| 005 | [vzev-community](005-vzev-community/spec.md) | vZEV member exchange over UDP, allocation, «vZEV» graph page, «Abrechnung» pages | 001, 002 |
| 006 | [einstellungen](006-einstellungen/spec.md) | «Einstellungen» page: Site / Lasten / Produktion / Netzanschluss / Tarife, config write API | 002 |
| 007 | [zaehler-messwerte](007-zaehler-messwerte/spec.md) | «Zähler» page: full smart-meter detail (phases, registers, raw view), `/api/meter` passthrough | 001, 002 |
| 008 | [energiefluss-kennzahlen](008-energiefluss-kennzahlen/spec.md) | Energy-flow diagram, Autarkie/Eigenverbrauch KPIs, Bilanz view, Ersparnis/CO₂ — pure frontend | 001–004 (005 opt.) |
| 009 | [vzev-betrieb-transparenz](009-vzev-betrieb-transparenz/spec.md) | vZEV operation: HT/NT tariffs, 80%-cap check, data quality, statement line items, allocation drill-down | 004, 005, 006 |
| 010 | [live-energiefluss-ux](010-live-energiefluss-ux/spec.md) | Live flow view UX: Swiss color conventions, direction legibility, producer-visibility fixes, Herkunft/Verwendung stacked bars — pure frontend | 002, 003, 008 (005 opt.) |
| 011 | [browser-archive-backend-slimming](011-browser-archive-backend-slimming/spec.md) | Browser-side IndexedDB archive of raw 15-min + peer-slot data (incremental sync, roll-ups/vZEV share/billing in the browser, export/import); device shrinks to an append-only 30-day buffer; dead endpoints, device-side validation and roll-ups removed (~20 KB less Berry) | 001, 004, 005, 006, 009 |
| 012 | [battery-storage](012-battery-storage/spec.md) | Battery as an observed storage item (issue #20): SoC/capacity/limits config, SoC via gplug field or HA entity, battery left out of the load allocation, charge/discharge Wh in the 15-min records (behind the meter, not vZEV), Übersicht SoC, Verlauf columns, Einstellungen, simulator SoC model | 001, 003, 004, 006, 008, 010, 011 |

001 and 002 are independent of each other and can be built in parallel.
003–006 each assume 001 + 002 are merged.
007–009 are independent of each other (007/008 can be built in parallel; 009 assumes 005 + 006).
010 assumes 008 is merged.
011 assumes 001–009 are merged and is the first spec that *removes* device behaviour.

> **Status (2026-09-05): spec 011 fully implemented (v1.0.10 / v1.0.11 / v1.0.12 /
> v1.0.13).** Step 3a moved the history into the browser: `ems/frontend/src/lib/archive.js`
> keeps every raw 15-min record and peer slot in IndexedDB, and Verlauf / Abrechnung /
> KPIs derive from it; the device's retention grew to 30 days (14 for peer slots) and
> `/api/energy?from=` pages forward. Step 3b (issue #8, v1.0.13) then deleted the redundant
> device side — day/month roll-ups, `store.set_vzev` and the vZEV allocation — so the device
> is now an **append-only** raw buffer that serves `res=15m` only. `.tapp` 94 541 → 74 836 B.
>
> **Status (2026-09-05): spec 011 added (Draft)** — size analysis of the v1.0.9 `.tapp`
> (94.5 KB, all Berry). Introduces a browser-side IndexedDB archive so the device keeps only
> an append-only raw buffer; deletes dead endpoints (`/grid`, `/reload`, `set-power`,
> `meta.version/language`), device-side config validation, day/month roll-ups and the
> `set_vzev` rewrite path. Overrides C-1 for the listed removals. Three shippable steps.
>
> **Status (2026-07-29): spec 010 added (Draft)** — UX review of the live flow view:
> Swiss/DACH color-convention alignment (Produktion gelb / Verbrauch blau / Bezug rot /
> Einspeisung grün), direction legibility, five code-verified producer-visibility defects
> (D-1…D-5, incl. missing `flow.*`/`kpi.*` i18n keys and null-power fake zeros), and a
> Herkunft/Verwendung composition-bar pair. Pure frontend.
>
> **Status (2026-07-28): specs 001–007 are Implemented; 008–009 are Draft** (persona-driven
> extension round, see «Personas» below). 007 «Zähler» added `GET /api/meter` (raw SMI
> passthrough), the browser field catalog `lib/metercat.js` + page `pages/zaehler.js`, and a
> smart-meter generator in the simulator (`/simulator/sites/{id}/meter`) for meterless dev.
>
> **Status (2026-07-27): all six base specs are Implemented.** Each `spec.md` carries
> an "Implementation note" reconciling it with the shipped code. The two notable
> architecture divergences from these drafts: (a) the frontend is built with
> **Vite** (CDN / self-host / dev modes) rather than the no-build `bundle.py`
> concatenation described in spec 002; (b) the `/api/*` handlers live in the
> existing **`webservice.be`** / **`configservice.be`** / **`vzev.be`** modules,
> not a single new `apiservice.be`.

## Shared, non-negotiable constraints

These apply to **every** spec below and are not repeated in full each time:

- **C-1 Preserve behaviour.** The existing Berry modules (`ems.be`, `site.be`, `webservice.be`,
  `integrations/*.be`, `messaging/*.be`, `logger.be`, `main.be`, `autoexec.be`) and their HTTP/UDP
  contracts must keep working unchanged. `make test` (existing `tests/test_ems_allocation.be`)
  must still pass. New functionality is added in **new modules / new endpoints**; existing files
  are only touched for wiring (imports in `autoexec.be`, start calls in `main.be`, Makefile).
- **C-2 No external servers.** The UI must be fully served from the device (`.tapp`). No CDN
  (`esm.sh`, Bootstrap CDN, Google Fonts, …), no telemetry, no third-party requests. This is a
  legal/privacy requirement of the project ("Es werden keine Daten an externe Server übertragen").
- **C-3 Device limits.** ESP32 flash filesystem and RAM are highly limited:
  - Total new UI assets (html + js + css + i18n) ≤ **150 KB** uncompressed.
  - Flash writes for data storage ≤ 1 write per 15 minutes per file (flash wear).
  - RAM-resident timeseries bounded (ring buffers with fixed capacity).
- **C-4 Language.** All user-facing text in **German** by default, via i18n keys (spec 002).
  Terminology is consistent and defined in the shared glossary below. No mixed-language UI.
- **C-5 Design.** Follow the Figma prototype design system (spec 002). Figma file:
  `https://www.figma.com/design/dZIKVwxjD12gcPUAHVuzkx/gPlug-UI`.
- **C-6 Berry conventions.** New backend modules follow the existing module singleton pattern
  (module() + class + `_instance` + lambda delegation), are loaded via `autoexec.be`, minified by
  `minify.py` (no `#` in string literals it can't handle — keep comments on their own lines), and
  get Berry CLI tests under `tests/` using the existing `tests/tasmota.be` stub.
- **C-7 Prior art.** Commits `cc41a90` ("store EMS data in storage") and `ff709a0` ("move UI to
  ems code") were intentionally reset away but remain in the git object store, and stale copies of
  `meter.be`, `store.be`, `uiwebservice.be` sit in `ems/backend/build/` (git-ignored build output).
  They are **drafts, not the contract** — where this spec differs (e.g. 15-min slots instead of
  30 s slots), the spec wins. They may be consulted for Berry idioms (`tasmota.rtc()`, driver
  hooks, `path`/`json` usage).

## Personas (specs 007–009)

The extension round is driven by three end-customer personas; each maps to one spec:

| Persona | Wants | Spec |
|---|---|---|
| **A — Technik-affiner Nutzer** (Elektro-Hintergrund) | All smart-meter details: per-phase V/A/P/Q, registers with OBIS meaning, raw values, data age, min/max, tariff status — Tasmota/HA power-user level | 007 |
| **B — PV-Besitzer** (kein Technik-Hintergrund) | At-a-glance monitoring like Solar.web/mySolarEdge: energy-flow diagram, Autarkie/Eigenverbrauch %, Bilanz, Ersparnis CHF, CO₂ | 008 |
| **C — vZEV-Betreiber & -Teilnehmer** | Operate & trust the community: HT/NT tariffs, legal 80%-cap on internal price (EnV Art. 16b), data completeness, complete statements, comprehensible allocation | 009 |

Research grounding (2026-07-28): Tasmota Smart-Meter-Interface metric set & Swiss standard
CIP list (Landis+Gyr E450/E360, StromVV Art. 8a Kundenschnittstelle, ≤ 10 s push, per-phase
V/A(+P/Q on newer firmware), no frequency/power factor/tariff-split registers in the standard
push); PV-portal KPI canon (Fronius/SolarEdge/SMA/HA Energy); Swiss vZEV legal frame
(EnG 17/18, EnV 14/16a/16b/18, ElCom FAQ Mantelerlass, VSE HER-CH 2025, BFE Leitfaden
Eigenverbrauch) and ZEV-tooling patterns (Exnaton, zevvy/ewz, Smart Energy Link); trust
findings (Quartierstrom: keep the mechanism visible; billing studies: show the result, keep
the arithmetic one click away; AT-EDA precedent: provisional vs. validated slot data).

## Glossary (binding terminology, German UI)

| Term (UI) | i18n key prefix | Meaning |
|---|---|---|
| Netzanschluss | `grid` | The site's grid connection point (smart-meter measurement). Panel name — replaces the prototype's "GRID" per review feedback. |
| Netzbezug | `grid.import` | Energy imported from the public grid (Wh). |
| Netzeinspeisung | `grid.export` | Energy exported to the public grid (Wh). |
| Verbrauch | `consumption` | Total site consumption = PV-Produktion − Netzeinspeisung + Netzbezug. Includes *all* consumers, not only controllable loads. |
| Lasten | `loads` | The **controllable** loads managed by the EMS (subset of Verbrauch). |
| Erzeuger / Produktion | `production` | Energy sources: PV, battery discharge. |
| Anteil PVA / Eigenverbrauch | `selfuse` | Self-consumed PV = PV-Produktion − Netzeinspeisung. |
| vZEV Export / Import | `vzev.export` / `vzev.import` | Energy computationally allocated to/from vZEV members (subset of Netzeinspeisung / Netzbezug). |
| vZEV Saldo | `vzev.balance` | Money balance from vZEV participation (CHF, signed). |
| Abrechnung | `billing` | Quarterly settlement between vZEV members. |
| Zähler | `meter` | The smart meter read via the gPlug (Tasmota SMI, sensor key `z`). Page name (007). |
| Register / berechnet | `meter.register` / `meter.derived` | Register = authoritative value from the meter; berechnet = derived in the browser (007). |
| Schieflast | `meter.imbalance` | Phase imbalance: max−min per-phase active power (007, derived). |
| Blindleistung | `meter.reactive` | Reactive power ±Q [var]; cosφ derived from P and Q (007). |
| Autarkiegrad | `kpi.autarky` | (Verbrauch − Netzbezug) / Verbrauch — share of consumption covered locally (008). |
| Batterie laden / entladen | `bat_chg_wh` / `bat_dis_wh` | Battery charge / discharge energy per slot, behind the meter; Verbrauch then = PV − Netzeinspeisung + Netzbezug + Entladen − Laden (012). |
| Eigenverbrauchsgrad | `kpi.selfuse` | (PV-Produktion − Netzeinspeisung) / PV-Produktion (008). |
| Bilanz | `history.balance` | Verlauf chart mode: production vs. consumption, split self/grid (008). |
| Hochtarif / Niedertarif | `tariff.ht` / `tariff.nt` | External tariff periods (HT windows configurable); slot tariff derived in the browser (009). |
| Zählpunkt | `vzev.metering_point` | Swiss metering point ID of a member (33 chars, optional, 009). |
| Verteilschlüssel | `vzev.allocation_key` | Disclosed allocation rule: dynamisch, verbrauchsanteilig pro 15 min (largest remainder) (009). |
| provisorisch | `vzev.provisional` | Slot/period with incomplete member data — shown, never silently billed as final (009). |

The distinction *Verbrauch vs. Lasten* answers review feedback ("Macht es Sinn, 'Lasten' und
'Verbrauch' gleich zu benennen?"): they are different concepts, never used interchangeably, and
both get an explanatory tooltip in the UI.

## Review feedback traceability

Feedback on the Figma prototype is folded into the specs as requirements:

| Feedback | Spec / Requirement |
|---|---|
| Axis labels + dimensions on every chart | 003 FR-303, 004 FR-405 |
| Erzeuger / Lasten / vZEV groups visually distinct | 002 FR-207, 003 FR-302 |
| Consistent language, i18n support | 002 FR-203…FR-206 |
| "GRID" panel name | Glossary: «Netzanschluss» (003 FR-301) |
| Verlauf: consistent dimensions, units only in header | 004 FR-404 |
| Verlauf: scrollable? how many entries? | 004 FR-402 (pagination, 10/25/50) |
| Verlauf: resolution boundaries highlighted | 004 FR-403 |
| vZEV: what is edited where; onboarding of members | 005 FR-505/FR-506, 006 FR-601 |
| Titles aligned | 002 FR-208 |
| Readability of yellow/green/red on cream | 002 FR-209 (contrast-checked palette) |
| Same time range across Übersicht panels | 003 FR-304 |
| «Lasten» vs. «Verbrauch» naming | Glossary + 003 FR-306 |
| Battery influence | 003 FR-305 (signed battery power) |
| Eigenverbrauch in CHF | 004 FR-407 |
| Holiday / pure-export scenario | 004 Edge cases, 005 Edge cases |
| Privacy: see other members' grid purchases? | 005 FR-509 (no — only vZEV flows are shared) |
| Averages, year-over-year, trends | 004 FR-408 |
| Peak-load detection | 004 FR-409 |
| Optimization hints (shift load into PV hours) | 003 FR-308 — removed 2026-09-21; the Stromfluss headline covers it |
| Tooltips / explanations of technical terms | 002 FR-210, used by 003–006 |
