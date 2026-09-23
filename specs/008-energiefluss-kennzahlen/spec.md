# Feature Specification: Energiefluss & Kennzahlen — Autarkie, Eigenverbrauch, Ersparnis

**Feature Branch:** `008-energiefluss-kennzahlen`
**Created:** 2026-07-28
**Status:** Draft
**Depends on:** `001-energy-data-and-storage`, `002-ui-shell-design-i18n`,
`003-uebersicht-live-monitor`, `004-verlauf-history`
(read `specs/README.md` for shared constraints, personas and the glossary)

> **Issue #1 (2026-09-23).** The community variants (flow node, «inkl.» Autarkie, Saldo
> component, former FR-807) were removed together with spec 005.

## Overview

Target persona: **Kunde B — der PV-Besitzer ohne Technik-Hintergrund**, der über den
Smart Meter «einfach sehen will, was seine Anlage bringt». Benchmark research (Fronius
Solar.web, SolarEdge/mySolarEdge, SMA Sunny Portal, HA Energy Dashboard) shows a stable
canon of what this persona expects and current pages don't yet show:

1. an **energy-flow diagram** (PV — Haus — Netz, live arrows) as the signature at-a-glance
   view,
2. the two headline KPIs **Autarkiegrad** and **Eigenverbrauchsgrad**,
3. an **energy-balance view** per period (production vs. consumption, split into
   selbst verbraucht / eingespeist bzw. selbst gedeckt / bezogen),
4. **money and CO₂**: Ersparnis in CHF per period, CO₂-Äquivalent.

This is the core of the project goal («Energieproduktion, Eigenverbrauch sowie die Verteilung
des lokal erzeugten Stroms in Echtzeit nachvollziehen»). Everything here is **pure frontend**:
all inputs already exist in `/api/power`, `/api/energy` and `/api/meta` — the device is not
touched at all (C-3). New pure module `src/lib/insights.js`, rendered into the existing
Übersicht and Verlauf pages.

## Use Cases

### UC-801: Grasp the current energy flow in one look
**Actor:** Kunde B («Familie Huber»)
**Flow:** Opens Übersicht; the first panel is now a flow diagram showing where power flows
*right now*.

**Acceptance Scenarios**
- **Given** live data (newest `/api/power` sample), **Then** a diagram shows nodes **PV**
  (blue), **Haus** (yellow), **Netz** (navy) — plus **Batterie** when a BATTERY production is
  configured — with directed edges labeled `fmtW`:
  PV→Haus (Eigenverbrauch = pv − export), PV→Netz (Einspeisung), Netz→Haus (Bezug),
  Batterie↔Haus (signed).
- **Given** an edge's power is 0 (e.g. no export at night), **Then** the edge is dimmed/hidden
  rather than showing «0 W» arrows everywhere.
- **Given** flows change on the next poll, **Then** edge labels/weights update in place; edge
  stroke width scales with power (min/max clamped) so «viel/wenig» is visible pre-attentively.

### UC-802: Understand «wie unabhängig bin ich?»
**Acceptance Scenarios**
- **Given** the Übersicht is open, **Then** a KPI strip shows **Autarkie** and
  **Eigenverbrauch** for «Heute» (from `/api/energy?res=15m`, today's slots):
  - Autarkiegrad = (Verbrauch − Netzbezug) / Verbrauch
  - Eigenverbrauchsgrad = (PV-Produktion − Einspeisung) / PV-Produktion
  each as % with a small donut/gauge and a `<Tooltip>` giving the plain-language definition
  («Anteil deines Verbrauchs, den deine eigene Produktion gedeckt hat»).
- **Given** PV-Produktion is 0 in the period (night, winter day), **Then** Eigenverbrauch shows
  «—» (not 0 %, not NaN); Autarkie likewise when Verbrauch is 0.

### UC-803: Compare periods and see the balance
**Acceptance Scenarios**
- **Given** the Verlauf page, **Then** the chart offers a second mode «Bilanz» (toggle next to
  the existing import/export mode): per period two bars — **Produktion** split into
  selbst verbraucht (blue) / eingespeist (green), and **Verbrauch** split into selbst gedeckt
  (blue) / Netzbezug (red) — with legend and labeled axes (002 FR-211).
  *Amended by issue #17:* the two side-by-side bars drew the self-use share twice (prodSelf ===
  consSelf), which read as double counting. The mode now renders ONE signed stack per period —
  selbst verbraucht + eingespeist above the 0-axis, Netzbezug below it — so self-use appears
  once; consumption is the yellow segment plus the magnitude of the downward bar.
- **Given** the summary strip (004 FR-408), **Then** it additionally shows Autarkie %,
  Eigenverbrauch % and Ersparnis CHF for the visible selection, and the existing
  trend/Vorjahr comparison covers PV-Produktion as well as Netzbezug.
- **Given** CSV export, **Then** the derived per-period columns (Autarkie, Eigenverbrauch,
  Ersparnis) are included with units in the header (004 conventions).

### UC-804: See what the PV yields in money and CO₂
**Acceptance Scenarios**
- **Given** tariffs configured (001), **Then** «Ersparnis» per period = existing
  `saving_selfuse_chf` + `revenue_feedin_chf`, presented as one
  headline CHF number with a tooltip breaking down the components — *show the result,
  not the arithmetic*; the breakdown is one click away, never the default view.
- **Given** a CO₂ factor is configured (`tariffs.co2_g_kwh`, default 128 g CO₂eq/kWh ≈ Schweizer
  Verbrauchermix, editable in Einstellungen → Tarife, 0 hides the stat), **Then** the KPI strip
  shows «CO₂ vermieden» per period = self-consumed local energy × factor, formatted kg/t with
  a tooltip stating the factor and that it is an approximation.

## Functional Requirements

- **FR-801** Flow diagram component `src/lib/… / src/pages/uebersicht.js` top panel per UC-801;
  node set is data-driven (Batterie node only when present); SVG, hand-rolled like
  `charts.js` (C-2: no external libs).
- **FR-802** Pure module `src/lib/insights.js` (no DOM, node-testable):
  - `kpis(records, opts) → {autarky, selfuse, savingChf, co2Kg}` from summed
    `/api/energy` records (glossary formulas; `null` where undefined per UC-802).
  - `flowsNow(sample) → edges[]` for the diagram (edge list with from/to/watts).
  - `balance(records) → {prodSelf, prodFeedin, consSelf, consImport}` for the Bilanz bars.
  All integer-Wh in, display formatting stays in components.
- **FR-803** KPI strip on Übersicht (period «Heute», refreshed with the existing poll cycle)
  and in the Verlauf summary strip (visible selection); identical formulas from `insights.js`
  in both — never two implementations.
- **FR-804** Verlauf chart mode toggle «Netz | Bilanz», persisted per session; Bilanz mode per
  UC-803, reusing `BarChart` (extend for stacked segments rather than adding a new chart type).
  Since issue #17 the stack is signed: negative segments stack downward from the 0-axis and the
  y-domain sizes the up- and down-totals separately.
- **FR-805** New optional tariff field `co2_g_kwh` (int, g CO₂eq/kWh, default 128, 0 = hidden):
  Einstellungen → Tarife gets the input (spec 006 validation pattern: non-negative int);
  served via existing `/api/meta` tariffs passthrough — **no new endpoint**.
- **FR-806** Every KPI has an i18n label + tooltip (`kpi.*`, `tooltip.kpi_*`); definitions
  match the glossary (Autarkie, Eigenverbrauch join the glossary table).
- **FR-807** (removed with issue #1 — community-aware KPI variants.)

## Non-Functional Requirements

- **NFR-801** No device changes except the one passthrough tariff key (FR-805) — zero new
  Berry logic, zero new flash writes.
- **NFR-802** Diagram + insights + toggle add ≤ 10 KB to the JS bundle (C-3).
- **NFR-803** Flow diagram re-render on poll ≤ 16 ms (like 003 NFR-301); no re-layout per
  tick, only labels/weights update.

## Key Entities

- **FlowEdge** — `{from, to, watts}`; **KpiSet** — `{autarky, selfuse,
  savingChf, co2Kg}`; **BalanceSet** — the four Bilanz sums. All derived, never persisted.

## Edge Cases

- Battery charging while importing (grid → battery): Haus consumption formula (003 FR-305)
  already covers signed battery; the diagram shows Netz→Batterie only implicitly via
  Batterie↔Haus sign — tooltip explains.
- Export > PV in a slot (measurement skew): selfuse clamps at ≥ 0; balance segments never
  negative.
- `partial` current slot (001): today's KPIs include the running slot and are labeled «heute
  bis HH:MM» — no pretending the day is complete.
- Records with `null` Wh (gaps): excluded from KPI sums; if > 20 % of the period is missing,
  KPIs show «—» with tooltip «unvollständige Daten» (trust: no confident numbers from holes).
- Tariff = 0/unset: Ersparnis hidden (like CO₂ at factor 0), not «CHF 0.00».

## Out of Scope

- Wetter/Soll-Ertrag comparison and fault alerting (needs external data — violates C-2).
- Per-module/per-string PV detail (inverter-side, not meter-side).
- Battery simulation («was wäre mit Speicher») — later idea, not part of this slice.
- Persisting KPI history on device (always recomputed from raw Wh in the browser).

## Existing Code — Extend, Don't Break

- `uebersicht.js` gains the flow panel + KPI strip above the existing panels — the 003
  panels themselves stay untouched (C-1); `verlauf.js` gains the mode toggle + summary
  additions, existing table/CSV columns unchanged apart from the added derived columns.
- `charts.js` `BarChart` extended backward-compatibly (existing call sites unchanged).
- New logic exclusively in `src/lib/insights.js`; `einstellungen.js` Tarife tab gains one
  field via the existing field-config mechanism.

## Testing (required)

- JS unit tests (node:test) for `insights.js`: KPI formulas incl. all UC-802/Edge-case
  null/clamp rules; `flowsNow` edge derivation for producer/consumer/battery fixtures;
  `balance` sums; gap handling (> 20 % rule).
- Manual checklist: Übersicht with/without Batterie fixtures; Verlauf Bilanz mode at
  all six resolutions; KPI «—» states (night fixture); 360/768/1440 px.

## Acceptance Checklist

- [ ] Flow diagram shows live PV/Haus/Netz(+Batterie) flows, dimmed zero-edges
- [ ] Autarkie & Eigenverbrauch on Übersicht (Heute) and Verlauf (selection), one formula source
- [ ] Bilanz chart mode with stacked production/consumption bars, labeled axes, CSV columns
- [ ] Ersparnis headline with component breakdown tooltip; CO₂ stat driven by `co2_g_kwh`
- [ ] All KPIs «—» on undefined/incomplete data — never NaN, never fake zeros
- [ ] No new Berry logic beyond the tariff key; bundle growth ≤ 10 KB; existing tests green
