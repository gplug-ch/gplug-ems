# Feature Specification: «Einstellungen» — Device Configuration UI

**Feature Branch:** `006-einstellungen`
**Created:** 2026-07-14
**Status:** Implemented
**Depends on:** `002-ui-shell-design-i18n` (and 001 for the tariffs schema). Read `specs/README.md` for shared constraints and the glossary.

> **Implementation note (reconciled 2026-07-27).** Delivered. `GET/POST
> /api/config` with JSON validation, atomic write (temp + rename) and reload
> rollback live in a dedicated **`configservice.be`** module (its own webserver
> handlers), not an `apiservice.be` extension as FR-601 phrased it.
>
> **Amended 2026-09-05 by spec 011 step 2 (A3, FR-1112/FR-1127).** The device
> no longer validates fields: `POST /api/config` rejects only a body that is
> not a JSON object (400) and a document `site.load_config()` cannot load (500
> + rollback). FR-601's step «parse + validate JSON» is now «parse JSON» —
> every rule below (UC-606, FR-606) is enforced in the browser by
> `einstellungen.js`, whose `validateDocument()` also guards the raw «Pro»
> editor. Saving a document with, say, an `ftp://` url succeeds and the load
> shows as unreachable at poll time (spec 011 UC-1105). Frontend
> `src/pages/einstellungen.js` implements the five pill tabs (Site, Lasten,
> Produktion, Netzanschluss, Tarife) over a single session config document, and
> is routed in `main.js`.

## Overview

Route `#/einstellungen/:tab?`. Edits the **own site's** configuration (`site.json`) from the
browser — today this requires editing JSON on the device. Figma frames: Site `41:1508`, Lasten
`41:1534`, Produktion `41:1592`, Netzanschluss `41:1644`, Tarife `41:1688`. Tabs as pill
buttons under the page title (active pill amber).

Scope: **Einstellungen = own site** (identity, loads, productions, grid connection, tariffs).
(The former boundary against a community-member page disappeared with issue #1.)

## Use Cases

### UC-601: Edit site identity
**Acceptance Scenarios**
- **Given** the Site tab, **Then** fields ID (read-only after first save), Name, Ort, Beschreibung show current values from `GET /site`; «Speichern» persists
  and the sidebar/Übersicht header reflect the new name after reload of config.

### UC-602: Manage loads
**Acceptance Scenarios**
- **Given** the Lasten tab, **Then** a master-detail layout lists loads (left) and shows the
  selected load's form (right): ID, Nennleistung [W] (`currentPower`), Typ (loadType select),
  Priorität, Integration (simulator/shelly/homeassistant/gplug) and — depending on integration —
  the Integration-Konfiguration fields (Shelly: ON-URL/OFF-URL/Status-URL mapping to the `url`
  object; others: URL, Token).
- **Given** «Hinzufügen», **Then** a blank form creates a new load; **Given** the trash icon,
  **Then** a confirm dialog («Last löschen?») precedes deletion.
- **Given** a save, **Then** the EMS keeps running: config is written and `site.load_config()`
  reloaded; a load that was ACTIVE and disappears is turned off via its integration before
  removal (no orphaned running device).

### UC-603: Manage productions
As UC-602 with fields ID, Typ (Photovoltaik/Batterie), Dimension (W/kW), Integration, URL/Token
— Figma `41:1592`.

### UC-604: Configure grid connection (Netzanschluss)
**Acceptance Scenarios**
- **Given** the Netzanschluss tab, **Then** master-detail for the `grid` array entries
  «Eingehend» (`id:"from"`) and «Ausgehend» (`id:"to"`): Dimension, Integration, and for
  integration `gplug` the sensor `Field` (e.g. `Pi`/`Po`) — Figma `41:1644`.

### UC-605: Configure tariffs
**Acceptance Scenarios**
- **Given** the Tarife tab (Figma `41:1688`), **Then** the 001 FR-107 tariff fields are
  editable: Netzbezug (Einheitstarif toggle + Tarif CHF/kWh), Netzeinspeisung
  (Rückspeisevergütung CHF/kWh), Monatliche Grundgebühr (CHF/Monat). Saving updates `/api/meta`
  tariffs and thus all cost displays (Verlauf, KPIs) on next fetch. (The community
  Export/Bezug tariffs were removed with issue #1.)
- Einheitstarif is the only mode in this iteration; the toggle is on and disabled with tooltip
  «Hoch-/Niedertarif folgt in einer späteren Version» (honest UI over dead controls).

### UC-606: Validation & safety
**Acceptance Scenarios**
- **Given** invalid input (empty ID, non-numeric power, priority < 1, malformed URL, duplicate
  load ID), **Then** the field shows an inline error (i18n) and «Speichern» is disabled.
- **Given** a successful save, **Then** a success toast appears and the form reflects the
  server-confirmed state (re-fetch, no optimistic divergence).

## Functional Requirements

- **FR-601** Backend: extend `apiservice.be` (001) with a config endpoint. The device API is
  GET-only by convention; config writes use **`POST /api/config`** with the full updated
  `site.json` body — POST exists in Tasmota's webserver and avoids URL-length limits of GET for
  nested structures. Behaviour:
  1. parse + validate JSON (must contain `id`, arrays `loads`/`productions`/`grid` of maps)
     — **since spec 011 step 2 only the parse and the «is a JSON object» check remain on the
     device; the field rules moved to the browser**,
  2. write to `site.json` **atomically** (write `site.json.new`, then rename/replace),
  3. call `site.load_config()`,
  4. respond `{"saved":true}` or HTTP 400 `{"error":"…"}` without having written anything.
  A `GET /api/config` returns the current full `site.json` (including `tariffs`) so the frontend
  edits a complete, round-trippable document. **Existing endpoints stay untouched (C-1).**
- **FR-602** Frontend keeps one in-memory config document per settings session: load once
  (`GET /api/config`), edit per tab, each tab's «Speichern» POSTs the whole document (tabs
  don't clobber each other because they share the document).
- **FR-603** Integration-specific form fields (drive by `integration` select):
  | Integration | Load fields | Production/Grid fields |
  |---|---|---|
  | `simulator` | URL | URL |
  | `shelly` | ON-URL, OFF-URL, Status-URL | — |
  | `homeassistant` | URL, Token | URL, Token |
  | `gplug` | — | Field (sensor key), Dimension |
  Unknown keys already present in the JSON are preserved verbatim (forward compatibility).
- **FR-604** Deleting an ACTIVE/WAITING load first requests transition to INACTIVE via the
  existing `GET /loads?id=…&action=transition&to=INACTIVE`, then saves (UC-602 safety).
- **FR-605** All labels/units per glossary & i18n; page structure per Figma (pill tab bar,
  master-detail with left list — list rows amber-tinted when selected, «Hinzufügen» primary
  button top-right, trash icon top-right of the detail form).
- **FR-606** Tariff inputs numeric with step 0.01, CHF suffixes in labels only (unit
  consistency, 004 FR-404 spirit).

## Non-Functional Requirements

- **NFR-601** A failed/interrupted save never leaves a corrupt `site.json` (atomic write,
  FR-601). If the new config fails to load, the old file is restored and HTTP 500
  `{"error":"config rejected"}` returned.
- **NFR-602** Master-detail collapses on < 768 px: list first, form as its own view with back
  navigation.

## Edge Cases

- Config saved while EMS mid-allocation-tick → `site.load_config()` is already the existing
  reload path (`/reload` uses it); no new concurrency handling required, but the save endpoint
  must not run during a partially-written file (atomicity covers this).
- `site.json` on device larger than webserver POST limit → reject with clear error; budget-wise
  a 3-load site is ≈ 2 KB, far below limits.
- Token fields: render as password inputs, value masked; only overwritten when the user types a
  new value (never echo full tokens back into the DOM unnecessarily — but note the API itself is
  unauthenticated LAN HTTP; document as trusted-LAN assumption).

## Out of Scope

- User authentication / roles; Hoch-/Niedertarif (UC-605); firmware/
  device settings (Tasmota's own UI covers those); i18n language switching at runtime (002:
  per-language builds).

## Existing Code — Extend, Don't Break

- `site.be` `load_config()` reused; if it currently reads a fixed path, expose that path
  constant for the save endpoint rather than duplicating it.
- `webservice.be` `/reload` behaviour unchanged.
- Example configs in `ems/backend/examples/` must remain valid documents for the new
  `GET/POST /api/config` round-trip (test with `site-1.json`).

## Testing (required)

- Berry: `tests/test_config_api.be` — validation matrix (missing id, wrong types → 400 & file
  untouched), atomic-write behaviour with a temp dir, round-trip of `examples/site-1.json`.
- Frontend unit tests: form validation rules (UC-606), integration-field switching (FR-603),
  document-merge across tabs (FR-602).

## Acceptance Checklist

- [ ] All five tabs match their Figma frames with i18n German labels
- [ ] Round-trip: load `examples/site-1.json`, edit each tab, save, reload — no key loss
- [ ] Invalid saves rejected server-side, file untouched
- [ ] Deleting an active load switches it off first
- [ ] Tariff changes propagate to Verlauf cost displays
- [ ] `make test` green incl. new Berry tests
