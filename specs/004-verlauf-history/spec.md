# Feature Specification: «Verlauf» — Energy & Cost History

**Feature Branch:** `004-verlauf-history`
**Created:** 2026-07-14
**Status:** Implemented
**Depends on:** `001-energy-data-and-storage`, `002-ui-shell-design-i18n`
(read `specs/README.md` for shared constraints and the glossary)

> **Implementation note (reconciled 2026-07-27).** Delivered in
> `src/pages/verlauf.js` + `src/lib/aggregate.js` + `src/lib/csv.js` (table with
> resolutions 15min…Quartale, boundary/gap separators, peak marks, summary strip,
> 0-anchored bar chart, CSV export). The page is now imported and routed in
> `main.js` (it had been written but left unwired, so `#/verlauf` rendered
> blank).
>
> **Spec 011 step 3a (2026-09-05).** Every resolution is now derived from the
> browser archive's 15-min records (`archive.range()` + `aggregate()`), so «Monat»
> covers the full archived period incl. the HT/NT split, and `res=1d`/`1mo` are no
> only requested for buckets older than the archive (so a fresh archive does not shorten
> the visible history; that fallback disappears with spec 011 step 3b). A coverage badge shows how many days the archive
> holds; a period touching a gap is marked «provisorisch». Without a usable archive
> the page falls back to the device rings exactly as before.

## Overview

Route `#/verlauf`. Tabular history of energy amounts and their costs, per resolution, with CSV
export — the "billing view" of the site. Figma frames `22:182` (producer / vZEV-Export variant)
and `33:486` (consumer / vZEV-Import variant); one implementation, data-driven columns.

Data source: `GET /api/energy` (spec 001). Native resolutions are 15 min (60 h), 1 day
(4 months), 1 month (18 months); coarser resolutions (Stunden, Wochen, Quartale) are aggregated
client-side from the finest ring that covers the requested range.

## Use Cases

### UC-401: Review recent energy and costs
**Actor:** Resident
**Flow:** Opens Verlauf, sees a paginated table (newest first): Zeitpunkt, Netzbezug,
Netzbezug-Kosten, vZEV Export (producer) or vZEV Import (consumer), vZEV Saldo, Eigenverbrauch
(gespart).

**Acceptance Scenarios**
- **Given** 15 min resolution, **Then** rows show `24.05.2026 17:15`-style timestamps and
  quantities as plain numbers — **units appear only in the column headers** («Netzbezug [kWh]»,
  «Saldo [CHF]») (review feedback + brain dump).
- **Given** a row with positive vZEV Saldo, **Then** the CHF value renders green with `+`;
  negative renders red with `−` (matches Figma).
- **Given** the producer site, **Then** the vZEV Export cell shows the total and an indented
  per-member breakdown (e.g. «0.87 Familie Müller / 0.41 Peter Schneider», from spec 005 data;
  without 005 the breakdown line is omitted).

### UC-402: Change resolution
**Acceptance Scenarios**
- **Given** the «Auflösung» select (15min · Stunden · Tage · Wochen · Monate · Quartale),
  **When** the user picks «Tage», **Then** the table shows daily rows for the last ≈ 4 months
  and the pagination resets to page 1.
- **Given** «Quartale», **Then** rows are calendar quarters (from monthly ring, max 6 rows).

### UC-403: Export CSV
**Acceptance Scenarios**
- **Given** any resolution, **When** «CSV exportieren» is clicked, **Then** the browser downloads
  `gplug-verlauf-<res>-<YYYYMMDD>.csv` containing **all** rows of the current resolution (not
  just the visible page), with an i18n header row incl. units, `;`-separated (Swiss Excel),
  decimal point, UTF-8 BOM.

### UC-404: Spot patterns & anomalies
**Acceptance Scenarios**
- **Given** a resolution is selected, **Then** above the table a `<BarChart>` (002 FR-211,
  0-axis anchored) shows the table's quantities over time — Netzbezug red bars vs. vZEV/Export
  green bars — sharing the table's data (brain dump "Chart 0-Achse und mit Balkendiagramm";
  optional toggle «nur CHF» renders the saldo series in CHF instead).
  *Amended by issue #17:* the bars follow the app-wide sign convention — what the site gives
  (Einspeisung/vZEV-Abgabe, green) sits above the 0-axis, what it takes (Netzbezug, red) below
  it. Netzbezug was drawn upward before, mirrored against the Bilanz mode and the CHF saldo.
- **Given** daily resolution and ≥ 8 days of data, **Then** a summary strip shows: Durchschnitt
  pro Tag, Trend (▲/▼ vs. previous equal-length period), and — if ≥ 13 months of monthly data —
  Vorjahresvergleich (review feedback: Durchschnitt/Vergleich/Trends).
- **Given** the 15 min view, **Then** the row(s) with the highest Netzbezug of the loaded range
  are marked with a ⚡ peak indicator + tooltip `tooltip.peakload` («Spitzenlast erhöht
  Netzkosten …») (review feedback: peak loads).

## Functional Requirements

- **FR-401** Data loading: 15min → `/api/energy?res=15m&count=240`; Stunden → aggregate 4×15m;
  Tage → `res=1d&count=124`; Wochen → aggregate days (ISO week, Mo–So); Monate →
  `res=1mo&count=18`; Quartale → aggregate months. Aggregation sums Wh fields; cost fields are
  re-derived from summed Wh via the tariff formulas (001 FR-108) with tariffs from `/api/meta`
  — never by summing rounded CHF.
- **FR-402** Pagination (answers "Ist die Liste scrollbar? Wie viele Einträge?"): the table body
  is **not** internally scrollable; it paginates — «Einträge pro Seite» 10 / 25 / 50 (default
  25), footer `1–25 von 240` with ‹ › controls (Figma pagination bar). Selection persists per
  session.
- **FR-403** Resolution boundaries («Schnittstellen», review feedback): when the displayed range
  crosses a data-source boundary (e.g. 15-min ring ends and only daily data exists further
  back), insert a full-width separator row — amber left-accented, i18n
  `history.boundary_finer_end`: «Ältere Werte nur in Tagesauflösung verfügbar» — and stop the
  finer listing there instead of silently mixing resolutions (the prototype mixed 15-min, daily
  and monthly rows in one table — do not copy that).
- **FR-404** Column set (i18n keys, units only in header):
  | Column | Producer | Consumer |
  |---|---|---|
  | Zeitpunkt | ✓ | ✓ |
  | Netzbezug [kWh] | ✓ | ✓ |
  | Netzbezug Kosten [CHF] (red) | ✓ | ✓ |
  | Netzeinspeisung [kWh] | ✓ (if any `exp_wh>0`) | hidden if always 0 |
  | vZEV Export/Import [kWh] (+ member breakdown) | Export | Import |
  | vZEV Saldo [CHF] (signed, colored) | ✓ | ✓ |
  | Eigenverbrauch gespart [CHF] (green) | ✓ (PV sites) | hidden |
  Producer/consumer detection is data-driven: site has productions ⇒ producer columns.
- **FR-405** The chart above the table has labeled axes with dimensions (002 FR-211), x-ticks
  matching the resolution (`fmtTime(ts,res)`).
- **FR-406** Sort: fixed newest-first (no sortable columns in this iteration).
- **FR-407** «Eigenverbrauch gespart» uses `saving_selfuse_chf` from the API (001 FR-108) —
  answers "Eigenverbrauch in CHF darstellen?" with yes-as-savings.
- **FR-408** Summary strip per UC-404 (pure functions, unit-tested): `avg(series)`,
  `trend(series) → {dir, pct}`, `yoy(monthly) → pct|null`.
- **FR-409** Peak marking per UC-404: `peaks(rows, topN=3)` on the currently loaded (unpaged)
  15-min range.
- **FR-410** Missing slots (001 FR-109) render as an explicit row gap marker only when ≥ 1 slot
  is missing between adjacent rows: thin row «— keine Daten (Gerät offline) —»; CSV export
  skips gap markers.

## Non-Functional Requirements

- **NFR-401** Full 240-row dataset render (paged) + chart < 100 ms on desktop.
- **NFR-402** CSV generation client-side, no extra endpoint (data already loaded).

## Edge Cases

- Holiday / pure-export week (review feedback): Netzbezug 0.00 rows with positive Saldo — the
  colors must make this a *good* state (green saldo), covered by a fixture in tests.
- Tariff change mid-history: costs are computed with **current** tariffs; a footnote under the
  table states this (`history.tariff_note`). Per-slot historical tariffs are out of scope.
- `count` < requested (young device) → table just shorter, no padding rows.
- Quarter aggregation with missing months → mark row `partial` (ⓘ «unvollständig»).

## Out of Scope

- Editing anything; per-phase data; historical tariff versioning; comparing individual members
  (privacy — see 005 FR-509).

## Existing Code — Extend, Don't Break

- Consumes only spec-001 endpoints + `/api/meta`; no backend changes in this spec.
- New code in `ems/frontend/src/pages/verlauf.js` + `src/lib/aggregate.js`, `src/lib/csv.js`.

## Testing (required)

- Unit tests: aggregation (hour/week/quarter incl. DST-safe UTC bucketing), cost re-derivation
  vs. summed-rounded mismatch, `trend`/`yoy`/`peaks`, CSV escaping (`;`, quotes, BOM), boundary
  row insertion (FR-403) with a fixture spanning 15m→1d→1mo.
- Fixture: holiday scenario (UC/edge) and consumer-only scenario (no productions).

## Acceptance Checklist

- [ ] Matches Figma `22:182`/`33:486` structure with corrected unit handling & boundary rows
- [ ] Resolution select covers 15min…Quartale with correct row counts
- [ ] CSV downloads full range with i18n+unit headers
- [ ] Saldo coloring (green +, red −), savings column on producer
- [ ] Summary strip + peak markers unit-tested
- [ ] Bar chart anchored at 0-axis, labeled axes
