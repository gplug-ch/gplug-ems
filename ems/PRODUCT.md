# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

The design surface is the **on-device EMS frontend** — the Preact single-page app served at
`http://<gplug-ip>/app` from each gPlug device. Its users are the **end customers who own or
share a site** in a virtual energy community, not installers or engineers. Three confirmed
personas drive the product (specs 007–009):

- **A — Technik-affiner Nutzer** (electrical background). Wants full smart-meter transparency:
  per-phase V/A/P/Q, registers with OBIS meaning, raw values, data age, min/max, tariff status —
  Tasmota/Home-Assistant power-user depth. Served by the «Zähler» page.
- **B — PV-Besitzer** (no technical background). Wants at-a-glance monitoring comparable to
  Solar.web / mySolarEdge: energy-flow diagram, Autarkie/Eigenverbrauch %, Bilanz, Ersparnis in
  CHF, CO₂. Served by «Übersicht», «Verlauf», and the flow/KPI views.
- **C — vZEV-Betreiber & -Teilnehmer**. Wants to operate and trust the community: HT/NT tariffs,
  the legal 80 %-cap on the internal price, data completeness, complete statements, and a
  comprehensible allocation. Served by «vZEV» and «Abrechnung».

Usage context is domestic and self-serve: a homeowner glancing at the dashboard on a phone or
laptop on the local network, occasionally a community operator reviewing a quarterly statement.

## Product Purpose

**vZEV** is an Energy Management System for a *virtual* energy community (virtueller
Zusammenschluss zum Eigenverbrauch). Multiple physical sites behind a shared grid connection
point run EMS firmware on gPlug (ESP32 / Tasmota Berry) devices; the EMS distributes available
renewable (PV) energy across sites — activating controllable loads (boiler, heat pump, wallbox,
dryer) by a greedy priority-threshold algorithm — so surplus is self-consumed and shared within
the community before it is exported to the public grid.

The frontend's job is to make that invisible optimisation **legible and trustworthy**: show what
is flowing right now, what it saved, and — for the community — how the money and energy were
allocated, with the arithmetic always one click away. Success is a customer who trusts the
number on the screen without needing to phone anyone.

## Positioning

Two positions a neighbouring product could not truthfully copy:

1. **The device serves raw data; the browser computes the analytics.** To keep the tiny
   ESP32-C3 heap free, the gPlug does no cost, roll-up, or allocation math for display. It
   streams raw Wh/slot/meter records (`/api/energy`, `/api/vzev/raw`, `/api/meter`) and the
   browser derives CHF, KPIs, flow buckets, and quarterly billing
   (`frontend/src/lib/aggregate.js`, `lib/vzev.js`, `lib/metercat.js`). This is the load-bearing
   architectural stance behind almost every UI decision.
2. **Swiss-legal, privacy-first community billing on commodity hardware.** Allocation and
   settlement follow the Swiss frame (EnG 17/18, EnV 14/16a/16b/18 — including the 80 %-cap on
   the internal price, ElCom / VSE HER-CH 2025, BFE Leitfaden Eigenverbrauch). No data leaves the
   local network; members never see each other's grid purchases — only the shared vZEV flows.

## Operating Context

- **Runtime:** Preact SPA, no build step required for the device; a Vite build bakes versioned
  CDN URLs into a tiny `index.html` shell served from the `.tapp`. The JS/CSS bundle loads from
  Cloudflare Pages in CDN mode; `make ASSET_BASE=self` packs assets into the `.tapp` for
  offline/restricted networks.
- **Network:** local LAN only; the frontend polls the device (`/loads`, `/productions` every 2 s;
  raw `/api/*` for analytics). The EMS master coordinates sibling sites over UDP multicast
  (`239.3.0.1:5007`).
- **Pages (routes):** Übersicht (live monitor), Verlauf (history/cost table + CSV), vZEV (community
  graph) & vZEV-Mitglied, Abrechnung (quarterly statement), Einstellungen (Site/Lasten/Produktion/
  Netzanschluss/Tarife), Zähler (smart-meter detail). See `frontend/src/pages/`.
- **Data reality to design for:** device RTC may be unsynced (time caveat banner); connection can
  drop (auto-retry offline state); slots may be *provisorisch* (incomplete member data — shown,
  never silently billed as final); pure-export/holiday and null-power scenarios are normal.

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
  loads. Panel names: Netzanschluss (not "GRID"), Erzeuger/Produktion, Lasten, vZEV. Others:
  Netzbezug/Netzeinspeisung, Eigenverbrauch/Anteil PVA, vZEV Export/Import, vZEV Saldo, Abrechnung,
  Zähler, Register vs. berechnet, Autarkiegrad, Eigenverbrauchsgrad, Bilanz, Hochtarif/Niedertarif,
  Zählpunkt, Verteilschlüssel, provisorisch. Full definitions: `specs/README.md` glossary.

## Brand Commitments

- **Name:** vZEV (virtueller Zusammenschluss zum Eigenverbrauch); devices are **gPlug** (gplug.ch).
- **Design system origin:** a Figma prototype defines the incumbent visual world
  (`https://www.figma.com/design/dZIKVwxjD12gcPUAHVuzkx/gPlug-UI`), refined through documented
  review feedback (contrast-checked palette; distinct Erzeuger/Lasten/vZEV groupings; aligned
  titles; tooltips explaining technical terms). Record the world in DESIGN.md via `document`;
  do not invent one here.
- **Swiss/DACH colour conventions** are a stated intent for the live flow view (spec 010):
  Produktion gelb, Verbrauch blau, Bezug rot, Einspeisung grün — align to these rather than
  arbitrary category colours.
- **Voice:** plain, trustworthy German aimed at non-experts, with a technical layer available on
  demand. Explanations of technical terms belong in tooltips, not inline jargon.

## Evidence on Hand

- Real product docs: `README.md`, `USAGE.md`, `docs/features.md`, and ten implemented/draft specs
  under `specs/` with an implementation-note reconciliation to shipped code.
- Real shipped UI and copy: `frontend/src/pages/*`, `frontend/i18n/de.json` (authoritative German
  strings), `frontend/src/lib/*` (the browser-side analytics).
- Research grounding cited in `specs/README.md` (2026-07-28): Tasmota SMI metric set, Swiss CIP
  list, PV-portal KPI canon, Swiss vZEV legal frame, ZEV-tooling patterns, and trust findings
  (Quartierstrom, AT-EDA provisional-vs-validated precedent).
- **Absences future work must not fabricate:** no invented customers, testimonials, benchmarks,
  pricing, or deployment counts. Billing/legal figures must trace to the cited Swiss frame or
  actual device data — never made up.

## Product Principles

1. **Legible over impressive.** The frontend exists to make an invisible optimisation
   understandable and believable; comprehension beats spectacle.
2. **Show the result, keep the arithmetic one click away.** Especially for money and allocation —
   trust comes from being able to drill down, not from being asked to take it on faith.
3. **Honour the device budget.** Every asset, font, and dependency is weighed against the 150 KB /
   ESP32 constraint; the device serves raw data and the browser computes.
4. **Never overstate certainty.** Provisional slots, stale RTC, and dropped connections are
   first-class states, surfaced honestly — never papered over with fake zeros or silent finals.
5. **Terminology is a contract.** Use the binding glossary exactly; Verbrauch and Lasten are
   different things and are never conflated.

## Accessibility & Inclusion

Target **WCAG 2.x AA** (confirmed). This makes the contrast-checked palette a floor, not a nicety,
and extends to keyboard operability, visible focus, semantic structure, and non-colour-only
encoding of state — the latter especially load-bearing given the Swiss colour conventions
(gelb/blau/rot/grün) carry meaning in the flow views.
