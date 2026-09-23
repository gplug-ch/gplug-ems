# Feature Specification: vZEV Betrieb — Tarife, Datenqualität & Abrechnungs-Transparenz

**Feature Branch:** `009-vzev-betrieb-transparenz`
**Created:** 2026-07-28
**Status:** Draft
**Depends on:** `004-verlauf-history`, `005-vzev-community`, `006-einstellungen`
(read `specs/README.md` for shared constraints, personas and the glossary)

## Overview

Target persona: **Kunde C — vZEV-Betreiber und -Teilnehmer**. Since 1.1.2025 (Mantelerlass:
EnG Art. 17/18, EnV Art. 14 Abs. 3/16a/16b/18) a vZEV operator receives **one** DSO bill on
the 15-min-netted virtual metering point and must himself allocate internal solar and bill the
participants. Research on Swiss ZEV tooling (Exnaton, zevvy/ewz, Smart Energy Link, Blockstrom,
CKW) and on trust in energy communities (Quartierstrom field study; billing-comprehension
experiments) yields four operator/participant needs the current 005 implementation doesn't
cover:

1. **Tarifmodell**: external tariffs are HT/NT in most of Switzerland; the internal solar
   price is legally capped (Pauschalmethode: ≤ 80 % of the external Standardprodukt,
   EnV Art. 16b) — the UI must support HT/NT and make the cap visible.
2. **Datenqualität**: billing is only trustworthy when slot data is complete — operators need
   a completeness monitor and per-slot provisional/missing flags (Austrian EDA L1/L2/L3
   precedent), participants need to see when numbers are provisional.
3. **Nachvollziehbare Abrechnung**: statements need proper line items (period, member,
   Zählpunkt, internal kWh × internal tariff, residual external reference, disclosed
   allocation key) and a print view.
4. **Sichtbarer Mechanismus**: the Quartierstrom study shows trust erodes when allocation is
   an invisible automatism — participants accept the result when the mechanism stays visible.
   One click from any allocated number must lead to a plain-language per-slot explanation
   («show the result, not the arithmetic» — but keep the arithmetic reachable).

All computation stays in the browser (`lib/vzev.js` extensions); the device only gains config
passthrough (tariff fields, vZEV master data, member fields) — no new Berry math (C-3, spec
005 architecture).

## Use Cases

### UC-901: Configure HT/NT tariffs and the internal price
**Actor:** Betreiber
**Acceptance Scenarios**
- **Given** Einstellungen → Tarife, **Then** the external tariff supports optional HT/NT:
  `grid_import_ht_chf_kwh`, `grid_import_nt_chf_kwh` plus weekly HT windows (default
  Mo–Fr 06–21, Sa 06–13 — editable start/end per day-group); when unset, the existing flat
  `grid_import_chf_kwh` applies unchanged (backward compatible).
- **Given** vZEV tariffs, **Then** the internal price (`vzev_import_chf_kwh` /
  `vzev_export_chf_kwh`) shows a **cap indicator**: computed reference = 80 % of the weighted
  external Standardprodukt (weighting from the configured HT/NT windows); internal price above
  the reference → amber warning «über der 80%-Obergrenze (EnV Art. 16b)» with tooltip. The UI
  warns, it does not block (the Effektivmethode may justify up to 100 %).

### UC-902: Monitor data completeness
**Actor:** Betreiber
**Acceptance Scenarios**
- **Given** the vZEV page, **When** a registered member has delivered no slot for > 2 h,
  **Then** its member card shows a warning badge («keine Daten seit HH:MM») — the
  meter-failure alarm every commercial ZEV tool ships.
- **Given** the Abrechnung page, **Then** a «Datenqualität» line per quarter shows:
  completeness % (slots with data from all registered members ÷ expected slots), count of
  provisional slots (≥ 1 member missing) and missing slots (own data absent); < 100 % renders
  the affected totals with a «provisorisch» marker.
- **Given** a slot where a member's data is missing, **Then** allocation for that slot treats
  the member's import as 0 (existing 005 behavior) — the UI must *say* so («Mitglied X fehlt
  in 7 Slots — dessen Anteil ist dort 0») instead of silently under-allocating.

### UC-903: Read a complete, comprehensible statement
**Actor:** Teilnehmer (und Betreiber für den Versand)
**Acceptance Scenarios**
- **Given** the Abrechnung page for a quarter, **Then** each member row expands to a
  statement detail: Zeitraum, Mitglied (Name, Ort), Zählpunkt-ID (if configured), bezogene
  vZEV-Energie [kWh] × interner Tarif (HT/NT split when configured) = Betrag CHF, plus an
  informational line «restlicher Netzbezug wird direkt vom Netzbetreiber abgerechnet», the
  disclosed Verteilschlüssel («dynamisch, verbrauchsanteilig pro 15 Minuten») and the
  Datenqualität note (UC-902).
- **Given** the user clicks «Drucken», **Then** a print-friendly view (CSS `@media print`,
  one member per page, site + Vertreter header) opens — PDF via the browser's print dialog,
  no libraries (C-2). CSV export gains the new columns (HT/NT kWh, quality flags).
- **Given** HT/NT is configured, **Then** Verlauf cost columns split Netzbezug into HT/NT
  (slot tariff derived in the browser from the windows — 15-min slots align with tariff
  windows by construction).

### UC-904: Understand «warum bekomme ich so viel?»
**Actor:** Teilnehmer
**Acceptance Scenarios**
- **Given** any allocated number (vZEV page flow, Abrechnung row), **When** the user opens its
  detail, **Then** a drill-down lists the underlying 15-min slots (paginated, newest first)
  and per slot a plain-language sentence: «12:00–12:15: Produzent speiste 3.2 kWh ein; du
  bezogst 1.4 kWh von total 3.4 kWh Bezug (41 %) → dir zugeteilt: 1.3 kWh.» — generated from
  the same `allocate()` inputs the billing uses (one source of truth).
- **Given** the vZEV page, **Then** a static, dismissible info box «So funktioniert die
  Zuteilung» explains the mechanism in ≤ 4 sentences (largest-remainder pro-rata per 15 min,
  identical on all devices, key as fixed in the vZEV-Vereinbarung).

### UC-905: Maintain vZEV master data
**Actor:** Betreiber
**Acceptance Scenarios**
- **Given** Einstellungen (new tab «vZEV», visible only when 005 is active), **Then** the
  operator can edit: Vertreter (Name, Kontakt), Netzanschlusspunkt-ID, and see read-only the
  producer/member count. Saved via the vZEV info endpoint (FR-905), shown on statements.
- **Given** the member form (005 `#/vzev/mitglied/:id?`), **Then** it gains optional fields
  Zählpunkt-ID (Swiss 33-char metering point, free text + length hint) and Eintrittsdatum
  (used to exclude slots before entry from that member's billing).

## Functional Requirements

Backend (config passthrough only):

- **FR-901** `site.json` tariffs accept the new optional keys (`grid_import_ht_chf_kwh`,
  `grid_import_nt_chf_kwh`, `ht_windows`, `co2_g_kwh` from 008); `configservice.be` validates
  types/ranges (numbers ≥ 0; windows as `{days, from, to}` list with 0–24 h bounds); `/api/meta`
  serves them verbatim. Flat-tariff-only configs remain valid (all new keys optional).
- **FR-902** Member registry entries (`vzev.json`) accept optional `metering_point` (string
  ≤ 40) and `entry_ts` (utc int) via the existing upsert query args; `/api/vzev/members`
  returns them.
- **FR-903** New endpoint `GET /api/vzev/info` (read) / `GET /api/vzev/info?action=set&…`
  (mutate, same pattern as members) for vZEV master data: `representative_name`,
  `representative_contact`, `connection_point_id`; persisted in `vzev.json`.

Frontend:

- **FR-904** `lib/vzev.js` extensions (pure, tested):
  - `slotTariff(ts, tariffs) → 'ht'|'nt'|'flat'` from the window config (local time).
  - `quality(raw, members, range) → {expected, complete, provisional, missing, perMember}` —
    a slot is `provisional` when ≥ 1 registered member (entered before the slot) has no data,
    `missing` when own data is absent.
  - `explainSlot(ts, raw, memberId) → {prodWh, totalImpWh, memberImpWh, sharePct,
    allocatedWh}` — the UC-904 sentence inputs, derived from the same `allocate()` call.
  - `buildBilling` gains HT/NT split, `entry_ts` filtering and quality annotations.
- **FR-905** Cap indicator (UC-901): pure helper `capReference(tariffs) → chf_kwh` (80 % of
  HT/NT-weighted external price; flat external → 80 % of flat); rendered in Einstellungen →
  Tarife and on the Abrechnung header when exceeded.
- **FR-906** Data-quality UI per UC-902: member-card badge (vZEV page, from newest slot ts per
  member), Abrechnung quality line + «provisorisch» markers. Thresholds: badge > 2 h,
  quarter shown as provisional when completeness < 100 %.
- **FR-907** Statement view per UC-903: expandable member detail + print stylesheet + CSV
  columns; Vertreter/Netzanschlusspunkt from FR-903, Zählpunkt from FR-902.
- **FR-908** Allocation transparency per UC-904: slot drill-down component (shared by vZEV
  page and Abrechnung) + «So funktioniert die Zuteilung» info box (i18n, dismiss persisted
  per session like 003 hints).
- **FR-909** Verlauf HT/NT: when windows configured, cost derivation in `lib/aggregate.js`
  applies `slotTariff` per 15-min record before bucketing; coarser resolutions sum the split
  correctly (costs always derived from 15-min level, never from re-averaged coarse Wh).
- **FR-910** All new terms i18n'd with tooltips: Hochtarif/Niedertarif, Verteilschlüssel,
  Zählpunkt, provisorisch, 80%-Obergrenze, Vertreter (C-4, 002 FR-210).

## Non-Functional Requirements

- **NFR-901** Device: only config parsing/serving — no allocation, tariff or quality math in
  Berry; `vzev.json` grows by the master-data map and two member fields (flash budget
  unchanged: writes only on config mutation).
- **NFR-902** Frontend additions ≤ 14 KB bundle growth (C-3); slot drill-down renders
  paginated (≤ 50 slots per page) to keep DOM bounded.
- **NFR-903** `buildBilling` stays deterministic and integer-Wh; HT/NT and quality extensions
  must not change existing allocation results for flat-tariff configs (regression-tested).

## Key Entities

- **TariffConfig** (extended) — flat rates + optional HT/NT rates + `ht_windows`.
- **VzevInfo** — `{representative_name, representative_contact, connection_point_id}`.
- **Member** (extended) — `+ metering_point?, entry_ts?`.
- **SlotQuality** — per-slot `measured | provisional | missing`; **QualitySummary** per range.
- **SlotExplanation** — UC-904 inputs.

## Edge Cases

- HT/NT configured but windows empty → treated as flat with HT rate + config warning in
  Einstellungen (validation hint, not a save error).
- Member with `entry_ts` mid-quarter → slots before entry excluded from its billing and from
  the completeness denominator; statement shows the effective period.
- DST transitions: `slotTariff` uses local time (Europe/Zurich via browser TZ); the duplicated/
  missing hour keeps slot-level correctness (window match per slot start, no day-sum
  assumptions).
- Producer data missing in a slot → allocation 0 for everyone (existing behavior), quality
  marks the slot provisional; drill-down explains «keine Produktionsdaten».
- Legacy peers (pre-009 firmware) never send metering_point/entry_ts → all new fields
  optional end-to-end; mixed-version vZEV keeps allocating identically (NFR-903).
- Internal price legitimately above 80 % (Effektivmethode) → warning is dismissible per
  session, never blocking (UC-901).

## Out of Scope

- LEG (lokale Elektrizitätsgemeinschaft, 2026) — different metering/billing model (DSO bills
  participants directly).
- MWST/VAT invoice lines, QR-Rechnung generation, Inkasso.
- Effektivmethode cost accounting (Kapitalkosten-Annuität etc.) — the UI only distinguishes
  «Pauschal (80 %)» vs «Effektiv» as a label on the statement.
- Allgemeinstrom metering/keys; Mieterwechsel out-of-cycle billing runs (day-exact exit is
  covered only via `entry_ts` semantics for entry).
- DSO Lastgang import (CSV/ebIX/SDAT-CH) — the vZEV's own gPlug rings stay the data source.

## Existing Code — Extend, Don't Break

- `vzev.be`: registry/info persistence and query-arg parsing only — the slot exchange, pending
  queue and device-side `allocate()` are untouched (C-1); existing `/api/vzev/*` responses
  stay backward compatible (new fields additive).
- `configservice.be`: additive validation rules; existing configs must round-trip unchanged.
- Frontend: extensions live in `lib/vzev.js`, `lib/aggregate.js`, the three vZEV pages and
  `einstellungen.js`; `allocate()` itself is not modified (NFR-903).

## Testing (required)

- JS unit tests: `slotTariff` (windows, DST boundary fixtures), `capReference` (flat + HT/NT
  weighting), `quality` (complete/provisional/missing, entry_ts denominator), `explainSlot`
  (consistency with `allocate()` output), `buildBilling` HT/NT split + regression fixture
  proving flat-config results are bit-identical to pre-009.
- Berry tests: tariff/member/info config validation (accept/reject cases), `vzev.json`
  round-trip with and without the new fields.
- Manual checklist: statement print view (one member per page, header data), quality badges
  with a silenced member fixture, drill-down sentence against a hand-computed slot.

## Acceptance Checklist

- [ ] HT/NT tariffs + windows configurable; flat configs unchanged; Verlauf/Abrechnung split
      costs per tariff from the 15-min level
- [ ] 80%-cap indicator on internal price (warning, dismissible, never blocking)
- [ ] Member no-data badge, quarter completeness %, «provisorisch» markers wired to one
      `quality()` source
- [ ] Statement detail with Zählpunkt, Verteilschlüssel disclosure, print view, extended CSV
- [ ] Slot drill-down explanation matches `allocate()` results exactly; info box present
- [ ] vZEV master data editable (Einstellungen «vZEV» tab) and shown on statements
- [ ] Mixed-version vZEV and legacy configs fully functional; allocation regression tests green
