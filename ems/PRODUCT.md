# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

The design surface is the **on-device EMS frontend** — the Preact single-page app served at
`http://<gplug-ip>/app` from each gPlug device. Its users are the **end customers who own the
site** (a household with PV and controllable loads), not installers or engineers. Two confirmed
personas drive the product (specs 007–008):

- **A — Technik-affiner Nutzer** (electrical background). Wants full smart-meter transparency:
  per-phase V/A/P/Q, registers with OBIS meaning, raw values, data age, min/max, tariff status —
  Tasmota/Home-Assistant power-user depth. Served by the «Zähler» page.
- **B — PV-Besitzer** (no technical background). Wants at-a-glance monitoring comparable to
  Solar.web / mySolarEdge: energy-flow diagram, Autarkie/Eigenverbrauch %, Bilanz, Ersparnis in
  CHF, CO₂. Served by «Übersicht», «Verlauf», and the flow/KPI views.

Usage context is domestic and self-serve: a homeowner glancing at the dashboard on a phone or
laptop on the local network, occasionally reviewing a month's history and costs.

## Product Purpose

The **gPlug EMS** is an Energy Management System for a single site. It runs as firmware on a
gPlug (ESP32 / Tasmota Berry) device at the grid connection point and distributes the available
renewable (PV) surplus to the site's controllable loads (boiler, heat pump, wallbox, dryer) by a
greedy priority-threshold algorithm — so surplus is self-consumed before it is exported to the
public grid.

The frontend's job is to make that invisible optimisation **legible and trustworthy**: show what
is flowing right now, what it saved, and where the energy and money went, with the arithmetic always one click away. Success is a customer who trusts the
number on the screen without needing to phone anyone.

## Positioning

Two positions a neighbouring product could not truthfully copy:

1. **The device serves raw data; the browser computes the analytics.** To keep the tiny
   ESP32-C3 heap free, the gPlug does no cost or roll-up math for display. It
   streams raw Wh/meter records (`/api/energy`, `/api/meter`) and the browser derives CHF,
   KPIs and flow buckets (`frontend/src/lib/aggregate.js`, `lib/insights.js`,
   `lib/metercat.js`). This is the load-bearing
   architectural stance behind almost every UI decision.
2. **Privacy-first self-consumption optimisation on commodity hardware.** No cloud account, no
   data leaves the local network; the device talks only to the integrations the site configures
   (gPlug smart meter, Home Assistant, Shelly, Modbus TCP).

## Operating Context

- **Runtime:** Preact SPA, no build step required for the device; a Vite build bakes versioned
  CDN URLs into a tiny `index.html` shell served from the `.tapp`. The JS/CSS bundle loads from
  Cloudflare Pages in CDN mode; `make build-self` packs assets into the `.tapp` for
  offline/restricted networks.
- **Network:** local LAN only; the frontend polls the device (`/loads`, `/productions` every 2 s;
  raw `/api/*` for analytics). Each device is standalone.
- **Pages (routes):** Übersicht (live monitor), Verlauf (history/cost table + CSV), Zähler
  (smart-meter detail), Modbus (standalone Modbus registers), Einstellungen (Site/Lasten/
  Produktion/Netzanschluss/Tarife/Daten). See `frontend/src/pages/`.
- **Data reality to design for:** device RTC may be unsynced (time caveat banner); connection can
  drop (auto-retry offline state); slots may be *partial* (a sensor failed during the slot — shown
  as such, never zero-filled); pure-export/holiday and null-power scenarios are normal.

## Capabilities and Constraints

- **C-2 No external servers.** The shipped UI transmits no data to third parties — a legal/privacy
  requirement («Es werden keine Daten an externe Server übertragen»). No telemetry, no third-party
  fonts/CDN scripts in self-host mode.
- **C-3 Device limits.** ESP32 flash + RAM are tight. Total on-device UI assets (html+js+css+i18n)
  ≤ **150 KB uncompressed**; flash writes ≤ 1 per 15 min per file; RAM timeseries are fixed-capacity
  ring buffers. Design and dependency choices must respect this budget.
- **HTTP API is GET-only** (Richardson maturity level 1). State transitions and setpoints travel as
  query params. The browser owns all derived analytics (see Positioning #1).
- **C-4 Language.** All shipped user-facing text is **German**, via i18n keys, consistent with the
  binding glossary (below). English (`en.json`) is **dev/reference only** — only German ships.
  Design for German copy lengths; no mixed-language UI.
- **Binding terminology (glossary).** Terms are fixed and must not be used interchangeably. Notably
  **«Verbrauch» ≠ «Lasten»**: Verbrauch is total site consumption; Lasten are only the EMS-controllable
  loads. Panel names: Netzanschluss (not "GRID"), Erzeuger/Produktion, Lasten. Others:
  Netzbezug/Netzeinspeisung, Eigenverbrauch/Anteil PVA, Zähler, Register vs. berechnet,
  Autarkiegrad, Eigenverbrauchsgrad, Bilanz, Hochtarif/Niedertarif, Zählpunkt. Full definitions: `specs/README.md` glossary.

## Brand Commitments

- **Name:** gPlug EMS; devices are **gPlug** (gplug.ch).
- **Design system origin:** a Figma prototype defines the incumbent visual world
  (`https://www.figma.com/design/dZIKVwxjD12gcPUAHVuzkx/gPlug-UI`), refined through documented
  review feedback (contrast-checked palette; distinct Erzeuger/Lasten groupings; aligned
  titles; tooltips explaining technical terms). Record the world in DESIGN.md via `document`;
  do not invent one here.
- **Swiss/DACH colour conventions** are a stated intent for the live flow view (spec 010):
  Produktion gelb, Verbrauch blau, Bezug rot, Einspeisung grün — align to these rather than
  arbitrary category colours.
- **Voice:** plain, trustworthy German aimed at non-experts, with a technical layer available on
  demand. Explanations of technical terms belong in tooltips, not inline jargon.

## Evidence on Hand

- Real product docs: `README.md`, `USAGE.md`, `docs/features.md`, and the implemented/draft specs
  under `specs/` with an implementation-note reconciliation to shipped code.
- Real shipped UI and copy: `frontend/src/pages/*`, `frontend/i18n/de.json` (authoritative German
  strings), `frontend/src/lib/*` (the browser-side analytics).
- Research grounding cited in `specs/README.md` (2026-07-28): Tasmota SMI metric set, Swiss CIP
  list, PV-portal KPI canon, and trust findings
  (Quartierstrom, AT-EDA provisional-vs-validated precedent).
- **Absences future work must not fabricate:** no invented customers, testimonials, benchmarks,
  pricing, or deployment counts. Cost figures must trace to the configured tariffs and actual
  device data — never made up.

## Product Principles

1. **Legible over impressive.** The frontend exists to make an invisible optimisation
   understandable and believable; comprehension beats spectacle.
2. **Show the result, keep the arithmetic one click away.** Especially for money and load decisions —
   trust comes from being able to drill down, not from being asked to take it on faith.
3. **Honour the device budget.** Every asset, font, and dependency is weighed against the 150 KB /
   ESP32 constraint; the device serves raw data and the browser computes.
4. **Never overstate certainty.** Partial slots, stale RTC, and dropped connections are
   first-class states, surfaced honestly — never papered over with fake zeros or silent finals.
5. **Terminology is a contract.** Use the binding glossary exactly; Verbrauch and Lasten are
   different things and are never conflated.

## Accessibility & Inclusion

Target **WCAG 2.x AA** (confirmed). This makes the contrast-checked palette a floor, not a nicety,
and extends to keyboard operability, visible focus, semantic structure, and non-colour-only
encoding of state — the latter especially load-bearing given the Swiss colour conventions
(gelb/blau/rot/grün) carry meaning in the flow views.
