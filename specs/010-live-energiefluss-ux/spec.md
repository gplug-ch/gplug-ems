# Feature Specification: Live-Energiefluss — UX-Validierung, Farbleitsystem & Herkunft/Verwendung

**Feature Branch:** `010-live-energiefluss-ux`
**Created:** 2026-07-29
**Status:** Draft
**Depends on:** `002-ui-shell-design-i18n`, `003-uebersicht-live-monitor`,
`008-energiefluss-kennzahlen`
(read `specs/README.md` for shared constraints, personas and the glossary)

> **Issue #1 (2026-09-23).** The community parts (flow node, D-2, FR-1003, composition
> segments) were removed together with spec 005.

## Overview

Target persona: **Kunde B — der PV-Besitzer ohne Technik-Hintergrund**. The spec-008 flow
diagram shipped, but a review of the live Übersicht found it does not yet deliver its core
promise — *"auf einen Blick sehen, wohin der Strom fliesst und woher er kommt"*:

1. **Direction is not pre-attentively legible.** Arrowheads are small, edges are static, and
   the node layout (PV top-left, Netz top-right, Haus bottom-centre) does not follow the
   reading direction sources → house → sinks that PV portals use.
2. **The colors do not match the conventions Swiss users know.** The app colors *production
   blue* and *consumption yellow* — the dominant convention in Swiss/DACH energy apps is the
   opposite (see «Research» below): **PV/Produktion = gelb (Sonne), Hausverbrauch = blau,
   Netzbezug = rot, Einspeisung/lokale Energie = grün**.
3. **Producers are effectively invisible in the charts** — a chain of verified defects (see
   «Defects» below): missing i18n keys render raw key names as node labels, `null` production
   samples are silently coerced to `0 W`, and a `productionType` mismatch silently drops a producer from `/api/power` sums while it
   still appears in the Erzeuger panel.
4. **The flow diagram shows *that* energy flows, but not the composition.** There is no view
   answering «aus welchen Komponenten setzt sich mein Verbrauch zusammen / wohin geht meine
   Produktion?» — the *Verbrauchsdeckung / Erzeugungsnutzung* pair that SMA Sunny Portal and
   the Home-Assistant energy distribution popularised.

Everything here is **pure frontend** (C-3: the device serves raw data, the browser computes);
the only non-frontend touch is an i18n/test guard. No new endpoints, no Berry changes.

## Research — color conventions in Swiss/DACH energy monitoring (2026-07-29)

No formal SN/SIA norm prescribes UI colors for energy flows; the "industry standard" is the
de-facto convention of the tools Swiss PV owners use daily:

| Tool (market) | Produktion | Verbrauch | Netzbezug | Einspeisung / lokal |
|---|---|---|---|---|
| Solar Manager (CH market leader) | Gelbtöne (hellgelb = PV→Batterie, dunkelgelb = Einspeisung) | Blautöne (alle Blau = Hausverbrauch, Abstufung nach Quelle) | rot | gelb/grün |
| evcc (open source, DACH) | grün = selbst produziert (Sonne & Batterie) | — | rot/grau | grün |
| Home Assistant Energy | orange/gelb (Solar) | blau/violett | violett/rot | — |
| PV-Forums-Konsens (photovoltaikforum, energiesparhaus.at) | gelb/grün | blau | rot | grün |

Binding conclusion for this spec (**the semantic color system**):

| Semantik | Token | Farbe (Richtwert, AA-geprüft per 002 FR-209) |
|---|---|---|
| PV / Erzeugung | `--c-production` | **Gelb/Ocker** (Sonne) — z. B. das bisherige `#D99A06` |
| Verbrauch / Haus / Lasten | `--c-consumption` | **Blau** — z. B. abgedunkeltes `#2D9CDB` |
| Netzbezug (Import) | `--c-import` | **Rot** `#C62D20` (unverändert) |
| Netzeinspeisung (lokale Energie) | `--c-export` | **Grün** `#3E7C28` (unverändert) |
| Batterie | `--c-battery` (neu) | **Türkis/Petrol** — eigenständig, nicht mit PV-Gelb oder Akzent-Amber verwechselbar |
| Netz (Knoten, neutral) | `--c-navy` | Navy (unverändert) |

The practical change is a **role swap of the production/consumption tokens** (both existing
hex values already pass the FR-209 contrast checks) plus a dedicated battery token
(`--c-amber` is the brand/interaction accent and must no longer double as battery color).
Because red/green carries direction semantics, **direction must never be encoded by color
alone** (deuteranopia): arrowheads, position and labels stay redundant encodings.

## Defects found (code-verified, to be fixed by this spec)

- **D-1** `flow.*`, `kpi.*` and `tooltip.kpi_*`/`tooltip.flow` i18n keys used by
  `pages/uebersicht.js` are missing from `i18n/de.json`/`en.json` — node labels render as raw
  keys («flow.pv»), so the diagram reads as broken.
- **D-2** (removed with issue #1 — concerned the community flow node.)
- **D-3** `insights.flowsNow()` coerces `pv_w: null` to `0` (`n(sample.pv_w) || 0`): an
  unpolled/unreachable production renders as a dimmed 0-W-edge — indistinguishable from
  night. Same fake-zero in the Netzanschluss stat row (`s.pv_w + Math.max(0, s.bat_w)` with
  `null` → `0`) and in the Erzeuger panel history (`ratedW()` records `0` for unknown).
- **D-4** `GridPanel` nulls the *consumption* series whenever `pv` is null even though grid
  data alone is present — one missing producer blanks a second line.
- **D-5** `meter.be` sums only `productionType == 'PHOTOVOLTAIC' | 'BATTERY'` (exact match).
  A config typo (`"PV"`) silently removes the producer from `/api/power` while `/productions`
  still lists it → «Erzeuger im Panel sichtbar, im Chart nicht». (Contract stays as is — the
  fix is frontend-side validation, FR-1007.)

## Use Cases

### UC-1001: See at a glance where energy is flowing
**Actor:** Kunde B («Familie Huber»)
**Flow:** Opens Übersicht; within 5 seconds — without reading numbers — knows whether the
site is importing or exporting and which producers contribute.

**Acceptance Scenarios**
- **Given** the flow diagram, **Then** sources (PV, Batterie entladend) sit **left**, Haus
  **centre**, sinks (Netz, Batterie ladend) **right** — energy always reads
  left→right; a node that is currently a source renders on the source side (battery side
  switches with sign, with a transition, not a jump).
- **Given** an active edge, **Then** it shows an arrowhead scaled with stroke width **and** a
  slow animated dash drift in flow direction (`prefers-reduced-motion` disables the drift;
  direction stays legible from arrow + position alone).
- **Given** the diagram, **Then** a one-line status headline above it summarises the
  situation in words, e.g. «Ihre PV deckt den Verbrauch — 1.2 kW werden eingespeist» /
  «Sie beziehen 800 W vom Netz» (i18n `flow.status_*`, driven by the same edge data).
- **Given** a 5-second glance test with three fixture scenarios (import, export,
  battery-discharge) and a test user, **Then** flow direction is named correctly without
  zooming or reading edge labels (manual checklist).

### UC-1002: Colors mean the same thing here as in every Swiss PV app
**Acceptance Scenarios**
- **Given** any chart, stat, gauge, badge or edge on Übersicht, Verlauf and Zähler,
  **Then** it uses the semantic color system above: Produktion gelb, Verbrauch blau, Bezug
  rot, Einspeisung grün, Batterie türkis — no page-local deviations.
- **Given** the Netzanschluss combined chart, **Then** import periods stay red-filled and
  export periods green-filled (`--c-import-fill`/`--c-export-fill`, 003 UC-301 unchanged), the
  production line is yellow and the consumption line blue.
- **Given** a color-vision-deficient user (deuteranopia simulation), **Then** import vs.
  export remains distinguishable via position/arrow/label — verified in the manual checklist.
- **Given** the swap, **Then** all recolored text/background pairs still pass the 002 FR-209
  AA 4.5:1 checks (documented in the PR like the original palette).

### UC-1003: Producers are visible — and «unbekannt» is not «0»
**Acceptance Scenarios**
- **Given** the shipped bundle, **Then** every i18n key referenced by `uebersicht.js` exists
  in `de.json` and `en.json` (D-1) — enforced by an automated test (FR-1008), not review.
- **Given** a production whose live value is unknown (`pv_w === null` in the newest sample),
  **Then** the flow diagram renders its edge **grey-dashed with «—»** (state «keine Daten»),
  the Netzanschluss stat shows «—», and the Erzeuger panel history records a *gap*, not a
  0-line (D-3) — night (`0 W`, dimmed) and no-data (grey «—») are visually distinct.
- **Given** grid data is present but PV is unknown, **Then** the consumption line still
  renders from the available fields (D-4: null only where truly underivable).
- **Given** productions are configured but *every* sample in the window has `pv_w === null`,
  **Then** the Erzeuger panel shows a data-quality notice («Keine Live-Daten von der
  Produktion — Integration/Erreichbarkeit prüfen», i18n key) instead of silently flat charts.

### UC-1004: See the composition — where consumption comes from, where production goes
**Acceptance Scenarios**
- **Given** the flow card, **Then** below the diagram two horizontal 100 %-stacked bars show
  the live composition (newest sample, same poll):
  - **Stromherkunft** (Verbrauch gedeckt aus): PV (gelb) · Batterie (türkis) · Netz (rot)
  - **Stromverwendung** (Produktion verwendet für): Eigenverbrauch (blau) · Batterie laden
    (türkis) · Einspeisung (grün) —
  each segment ≥ 1 % gets its `fmtW` label on hover (chart hover pattern), the bar has a
  compact legend, and zero segments collapse.
- **Given** the toggle «Jetzt | Heute» on the card, **Then** «Heute» renders the same two
  bars from today's `/api/energy` slots (Wh); the battery segment is omitted there with a
  tooltip note (the energy rings deliberately exclude the battery — 001/`meter.be` contract).
- **Given** unknown inputs (null pv), **Then** the affected bar shows the grey «keine Daten»
  state — never a fabricated 100 % Netz share.
- **Given** a site without battery, **Then** the bars degrade to two-segment
  bars (PV/Netz bzw. Eigenverbrauch/Einspeisung) without empty legend entries.

## Functional Requirements

- **FR-1001** Semantic color tokens per the Research table: swap the roles of
  `--c-production` (→ gelb) and `--c-consumption` (→ blau), add `--c-battery`, retire
  `--c-amber` from energy semantics (stays UI accent). All usages across `style.css`,
  `charts.js`, `uebersicht.js`, `verlauf.js` and Zähler pages follow the tokens — no
  literal energy-color hex in components. AA evidence per 002 FR-209.
- **FR-1002** Flow diagram UX per UC-1001: source-left/sink-right layout, scaled arrowheads,
  animated dash drift (`prefers-reduced-motion`-guarded), status headline (i18n
  `flow.status_*` from a pure, tested function `flowStatus(edges) → key|null`).
- **FR-1003** (removed with issue #1 — wired the community flow.)
- **FR-1004** Null-safety (D-3/D-4): `insights.flowsNow` distinguishes `null` (unknown) from
  `0`; edges gain a `state: 'ok'|'zero'|'unknown'`; stat row and Erzeuger history render «—»/
  gaps for unknown; consumption derivation uses every field that *is* present. No fake zeros
  anywhere on the page (008 «never NaN, never fake zeros» extended to power).
- **FR-1005** Data-quality notice for the Erzeuger panel per UC-1003 (all-null window →
  hint; pure predicate in `insights.js`, i18n-keyed, dismiss per session like UC-305 hints).
- **FR-1006** Composition bars per UC-1004: new pure functions in `insights.js` —
  `sourcesNow(sample) → {cover: segments[], usage: segments[]}` and
  `sourcesToday(records) → same` (battery omitted, documented) — rendered by one new
  presentational component (hand-rolled SVG/JSX like `charts.js`; no external lib, C-2).
  Formulas: Deckung = PV-Eigenverbrauch + Batterie-Entladung + Netzbezug;
  Verwendung = Eigenverbrauch + Batterie-Ladung + Einspeisung; segments
  clamp ≥ 0 and sum to the respective total.
- **FR-1007** Guard against D-5 in Einstellungen (006 form): `productionType` becomes a
  select limited to `PHOTOVOLTAIC` / `BATTERY`; loading a config with another value shows a
  non-blocking warning («Typ unbekannt — wird in den Leistungsdaten nicht berücksichtigt»).
  The `meter.be` contract itself stays unchanged (C-1).
- **FR-1008** i18n completeness test: a node test walks `src/**` for `t('…')` keys and static
  key tables (e.g. `FLOW_NODES`) and fails when a key is missing in `de.json` or `en.json`;
  all currently missing keys (D-1) are added, German per C-4.
- **FR-1009** The 003 Netzanschluss chart, stats and panels keep their structure and
  endpoints — this spec only recolors, fixes null-handling and adds the composition bars;
  all 003/008 FRs remain satisfied (C-1).

## Non-Functional Requirements

- **NFR-1001** Pure frontend: zero Berry changes, zero new endpoints, zero new flash writes.
- **NFR-1002** Bundle growth ≤ 8 KB (C-3); animation via CSS/SVG dash only — no JS timers
  beyond the existing poll, re-render on poll ≤ 16 ms (003 NFR-301).
- **NFR-1003** The dash animation must not force continuous layout/paint on idle hidden tabs
  (respect the 002 FR-214 pause; CSS animation on a visible SVG only).

## Key Entities

- **FlowEdge** (extended) — `{from, to, watts, state: 'ok'|'zero'|'unknown'}`.
- **SourceSegments** — `{cover: [{key, watts|wh, color}], usage: […], unknown: bool}`.

## Edge Cases

- Night: all-zero flows → dimmed edges, «0 %» bars collapse to «100 % Netz» (real zero, not
  unknown-grey).
- Battery flipping sign frequently → side switch debounced (≥ 2 polls) to avoid jitter.
- Export > PV (measurement skew): segments clamp ≥ 0 (008 pattern).
- Legacy config with `productionType: "PV"`: warning per FR-1007, everything else renders.
- `prefers-reduced-motion` / `prefers-contrast: more`: drift off, tokens unchanged (AA holds).

## Out of Scope

- Backend acceptance of productionType aliases (contract change — separate decision).
- Battery energy accounting in `/api/energy` (001/meter contract keeps the battery live-only).
- Sankey-style historic flow diagrams on Verlauf (this spec covers the *live* view; the
  Verlauf Bilanz mode from 008 stays as is).
- Per-load composition (which load consumed the PV share) — not derivable from the meter.

## Existing Code — Extend, Don't Break

- `src/pages/uebersicht.js`: FlowDiagram layout/status/bars, null-safe stats, notice.
- `src/lib/insights.js`: `flowsNow` state field, `flowStatus`, `sourcesNow`, `sourcesToday`,
  data-quality predicate — all pure, node-tested; existing exports keep their signatures
  (extra field/args only).
- `style.css`: token remap + `--c-battery` + dash animation; `i18n/*.json`: missing + new keys.
- `src/pages/einstellungen.js`: productionType select + warning (006 field mechanism).
- No changes to `charts.js` call contracts, `api.js`, or any `.be` file.

## Testing (required)

- Node tests (`tests/` frontend pattern): `flowsNow` null/zero/unknown matrix;
  `flowStatus` for import/export/covered/no-data fixtures; `sourcesNow`/`sourcesToday`
  formulas incl. clamps, battery omission (Heute), unknown propagation; i18n
  completeness test (FR-1008).
- Manual checklist: 5-second direction test (3 fixtures, UC-1001); deuteranopia simulation
  (UC-1002); night vs. no-data distinction (UC-1003); bars with/without Batterie;
  «Jetzt | Heute» toggle; 360/768/1440 px; `prefers-reduced-motion`.

## Acceptance Checklist

- [ ] Flow direction legible in ≤ 5 s without reading numbers (layout, arrows, drift, headline)
- [ ] Semantic colors match the Swiss convention (Produktion gelb, Verbrauch blau, Bezug rot,
      Einspeisung grün, Batterie türkis) on every page, AA-documented
- [ ] D-1, D-3…D-5 defects fixed; producers visible; «unbekannt» ≠ «0» everywhere
- [ ] Herkunft/Verwendung stacked bars (Jetzt + Heute) with correct, tested formulas
- [ ] i18n completeness test in `make test`/node test run and green
- [ ] Zero Berry diffs; bundle growth ≤ 8 KB; existing 003/008 behaviour unchanged
