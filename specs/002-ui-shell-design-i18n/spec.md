# Feature Specification: UI Shell, Design System & i18n

**Feature Branch:** `002-ui-shell-design-i18n`
**Created:** 2026-07-14
**Status:** Implemented
**Depends on:** — (read `specs/README.md` for shared constraints C-1…C-7 and the glossary)

> **Implementation note (reconciled 2026-07-27).** Delivered, but the build
> pipeline evolved away from this draft's "no-build `bundle.py` concatenation +
> committed `vendor.js`" plan (FR-201/FR-202/FR-215/FR-216). The shipped app is
> built with **Vite** (ES modules under `src/`, `npm`-managed `preact` + `htm` —
> not committed vendor files) and served in one of three modes selected by
> `ASSET_BASE`: **`cdn`** (default — hashed JS/CSS on Cloudflare Pages, the
> device ships only the `index.html` shell + `lang.json`), **`self`** (assets
> packed into the `.tapp`, served via `/fs?name=…` for restricted networks), and
> **`dev`** (HMR from a `npm run dev` server). `bundle.py --lang-only` survives
> only to emit `lang.json` and run the i18n key-completeness check. The 150 KB
> budget (C-3) applies to the **self-host** bundle (currently ≈ 121 KB + lang);
> in CDN mode the on-device payload is far smaller. Everything else — shell,
> hash router, design tokens, i18n, formatters, shared components, hand-rolled
> SVG `LineChart`/`BarChart` with labeled axes — is as specified. The
> per-language `make LANG=en` build (UC-203) still holds.

## Overview

Replace the prototype frontend (`ems/frontend/index.html` + `app.js`, currently Preact/htm/D3
loaded **from CDNs**) with a self-hosted **Preact** application that implements the Figma design
system, ships fully inside the `.tapp` (constraint C-2), renders German by default and is
translatable via per-language JSON with **one build per language** (constraint C-4).

This spec delivers the app shell only: layout, navigation, routing, design tokens, shared
components (cards, charts, badges, tooltips, tables, forms), the i18n mechanism and the build
pipeline. Pages themselves are specs 003–006; this spec mounts placeholder routes.

**Figma:** `https://www.figma.com/design/dZIKVwxjD12gcPUAHVuzkx/gPlug-UI` — main frames:
Übersicht `10:310`/`10:458`, Verlauf `22:182`/`33:486`, vZEV `40:835`, Abrechnung `40:882`,
Einstellungen `41:1508…41:1688`. If a Figma MCP/design skill is available at implementation
time, pull exact values from these nodes; otherwise use the tokens below (sampled from the file).

## Use Cases

### UC-201: Navigate the app
**Actor:** End user without technical background
**Flow:** User opens `http://<device>/app`, sees the sidebar (gPlug logo, Übersicht, Verlauf,
vZEV, Einstellungen), the active item highlighted, and the Übersicht page. Navigation is instant
(client-side hash routing), the URL is bookmarkable.

**Acceptance Scenarios**
- **Given** the app is open, **When** the user clicks «Verlauf», **Then** the URL becomes
  `#/verlauf`, the sidebar marks Verlauf active, and the Verlauf route renders without a page
  reload.
- **Given** a bookmarked `#/einstellungen`, **When** opened, **Then** the settings route renders
  directly.

### UC-202: Use the app on phone, tablet, desktop
**Acceptance Scenarios**
- **Given** a viewport ≥ 1024 px, **Then** the sidebar is a fixed left rail (≈ 260 px) as in Figma.
- **Given** a viewport < 1024 px, **Then** the sidebar collapses to a top bar with a burger menu
  (or bottom tab bar — implementer's choice, one pattern used consistently); content is single
  column; charts and tables remain usable at 360 px width with horizontal scrolling only inside
  tables.

### UC-203: German UI, translatable builds
**Acceptance Scenarios**
- **Given** `make tapp` (default), **Then** every visible string comes from `i18n/de.json` and the
  built `index.html` has `<html lang="de">`.
- **Given** `make tapp LANG=en`, **Then** the build embeds `i18n/en.json` and produces
  `ems-v<VERSION>-en.tapp`; strings missing in `en.json` fall back to the `de.json` value at
  build time (build prints a warning listing missing keys).
- **Given** any page from specs 003–006, **Then** adding a language requires only a new JSON
  file — no JS changes.

### UC-204: Understand technical terms
**Acceptance Scenarios**
- **Given** a label marked with an info affordance (ⓘ), **When** the user hovers (desktop) or
  taps (touch), **Then** a tooltip with the glossary explanation appears (text from i18n, e.g.
  key `tooltip.consumption` explaining Verbrauch vs. Lasten).

## Functional Requirements

### Stack & serving
- **FR-201** Vendor **Preact ≥ 10** and **htm 3** as local files under `ems/frontend/vendor/`
  (module builds, no build-time transpilation). No other runtime dependency. **D3 and Bootstrap
  are removed** — charts are hand-rolled SVG Preact components (FR-211), styling is one custom
  stylesheet.
- **FR-202** The app is served by the existing `webservice.be` `/fs` mechanism: `GET /app`
  already redirects to `/fs?name=index.html` — keep that. Because `/fs?name=…` flattens paths,
  the build **concatenates all app modules into a single `app.js`** (simple deterministic
  concatenation in dependency order by a small `bundle.py` invoked from the Makefile — no npm,
  no bundler). `index.html` references exactly: `style.css`, `vendor.js` (preact+htm, prepared
  once, committed), `app.js`, `lang.json` (fetched at startup) — each ≤ one `/fs` request.
- **FR-203 (i18n)** Translations live in `ems/frontend/i18n/<lang>.json`, flat dot-keys:
  `{"nav.overview":"Übersicht","grid.import":"Netzbezug",…}`. `de.json` is the reference and
  must be complete for specs 002–006 (create keys as pages are built).
- **FR-204** Runtime helper `t(key, params?)` with `{count}`-style interpolation; missing key →
  returns the key itself and logs `console.warn` once.
- **FR-205** Formatters (single module, used by all pages — answers "Dimensionen konsistent"):
  - `fmtW(w)` → `"1.4 kW"` / `"350 W"` (auto-scale, 1 decimal max)
  - `fmtWh(wh)` → `"1.28 kWh"` / `"917 Wh"`
  - `fmtChf(v)` → `"+0.19 CHF"` / `"−367.32 CHF"` (signed where the context is a balance;
    Swiss format, `de-CH` number formatting: apostrophe thousands `2'247.86`)
  - `fmtTime(ts, res)` → local-time strings: 15m → `24.05.2026 17:15`, 1d → `24.05.2026`,
    1mo → `05.2026`, quarter → `2026 Q2`.
- **FR-206** Language build: Makefile target copies the selected `i18n/$(LANG).json` (merged over
  `de.json`) into the build as `lang.json`; app loads it before first render (tiny inline loading
  state, no flash of untranslated keys).

### Design system (tokens from Figma)
- **FR-207** CSS custom properties in `style.css` (`:root`):
  ```css
  --c-bg:        #F3EFE2;  /* page background, cream        */
  --c-surface:   #FFFFFF;  /* cards                          */
  --c-navy:      #1A1A38;  /* sidebar bg, headings, axes     */
  --c-navy-2:    #35355A;  /* sidebar active item bg         */
  --c-text:      #1A1A38;
  --c-text-mut:  #6B6B77;  /* secondary text, axis ticks (AA-darkened, FR-209) */
  --c-amber:     #F3B738;  /* brand, primary buttons, active nav text */
  --c-line:      #E3DED0;  /* card borders, separators       */
  /* chart / semantic palette — contrast-checked on cream & white (FR-209) */
  --c-consumption: #D99A06; /* yellow (darker than prototype for contrast) */
  --c-production:  #2D9CDB; /* blue                            */
  --c-vzev:        #3E7C28; /* green (vZEV flows, positive CHF) */
  --c-import:      #C62D20; /* red (grid import, negative CHF; AA-darkened) */
  --c-import-fill: #F5C1BC; /* area fill import                 */
  --c-vzev-fill:   #C4E3C9; /* area fill export/vZEV            */
  --c-active:      #2FA452; /* badge Aktiv                      */
  --c-inactive:    #6B6B77; /* badge Inaktiv                    */
  ```
  Panel groups get distinct accents (review feedback "farblich besser unterscheidbar"): each card
  carries a 4 px left border in its group color — Netzanschluss `--c-navy`, Erzeuger
  `--c-production`, Lasten `--c-consumption`, vZEV `--c-vzev`.
- **FR-208** Typography: system font stack (`system-ui, -apple-system, "Segoe UI", Roboto,
  sans-serif` — no webfont, C-2/C-3). Scale: page title 28/700, card title 20/700, section
  label 14/600, body 14/400, secondary 12/400 `--c-text-mut`. **All page titles share the same
  left alignment and top offset across pages** (review feedback "Titel ausrichten") — enforced
  by a shared `<PageHeader title subtitle actions>` component.
- **FR-209** Contrast: every text/foreground token pair used must reach WCAG AA (≥ 4.5:1 for
  text, ≥ 3:1 for chart lines on their background). The prototype's raw yellow `#F3B738` is
  **not** used for text on white/cream — value texts use the darkened variants above.
- **FR-210** `<Tooltip text>` component: ⓘ icon, hover + focus + tap, positioned within viewport,
  ESC/blur dismiss. Used for every glossary term (UC-204).

### Shared components
- **FR-211** Chart components (SVG, no external lib):
  - `<LineChart series=[{points,color,fill?,label}] yUnit xUnit …>` — live power charts;
    **axis labels mandatory**: y-axis unit top-left (`[kW]`), x-axis unit bottom-right (`[h]`
    resp. localized time ticks); light horizontal gridlines; hover crosshair with value
    tooltip; renders `null` points as gaps (missing data, spec 001 UC-104).
  - `<BarChart …>` — energy history, **bars anchored at a visible 0-axis**, negative values
    (signed CHF) render below the axis (brain-dump: "Chart 0-Achse und mit Balkendiagramm").
  - Both accept an explicit `timeWindow` so multiple charts can share the exact same x-range
    (needed by 003 FR-304).
- **FR-212** `<Card group title value…>`, `<Badge state>` (Aktiv/Inaktiv/Wartend — colors
  `--c-active`/`--c-inactive`/`--c-amber`), `<DataTable>` (headers with units, pagination
  footer), `<Select>`, `<TextField>`, `<Button primary|secondary|danger>` styled per Figma
  (rounded ≈ 10 px, amber primary with navy text, navy secondary with light text).
- **FR-213** App shell: sidebar (logo, 4 nav items with icons, active state = navy-2 pill with
  amber text + 3 px amber left indicator, as in Figma), `<main>` content area with `--c-bg`,
  max-width ≈ 1450 px, 24 px gutters. Hash router with routes `#/`, `#/verlauf`, `#/vzev`,
  `#/vzev/mitglied/:id?`, `#/vzev/abrechnung`, `#/einstellungen/:tab?` — unknown routes render
  Übersicht. Routes not yet implemented (003–006) render a placeholder card with the page title.
- **FR-214** Data layer: `api.js` with `getPower()`, `getEnergy(res,count)`, `getMeta()`,
  `getSite()`, `getLoads()`, `getProductions()`, `getGrid()`, plus a `poll(fn, ms)` helper that
  pauses when `document.hidden` (battery/network hygiene). Base URL derives from
  `window.location` with `?host=` override (preserve the existing prototype behaviour for
  development against a remote device).

### Build & packaging
- **FR-215** Makefile changes (extend, don't rewrite): a `frontend` target that (a) runs
  `python3 bundle.py` to concatenate `ems/frontend/src/*.js` → `build/app.js` (license headers
  stripped, order defined in `bundle.py`), (b) copies `index.html`, `style.css`, `vendor.js`,
  merged `lang.json` into `build/`, (c) keeps the existing `sed` patch rewriting asset
  references to `/fs?name=…`. `.tapp` naming: `ems-v<VERSION>.tapp` (de) /
  `ems-v<VERSION>-<lang>.tapp`.
- **FR-216** Size budget check in the Makefile: fail the build if `app.js + style.css +
  vendor.js + lang.json + index.html` exceeds **150 KB** (C-3).
- **FR-217** The old prototype UI files (`ems/frontend/app.js`, current `index.html`) are
  replaced. The backend REST API used by external callers stays untouched (C-1) — only the
  *frontend consumer* changes.

## Non-Functional Requirements

- **NFR-201** First render < 2 s on-device over LAN (few requests, small assets).
- **NFR-202** Works in evergreen Chrome/Firefox/Safari, incl. iOS Safari; no transpilation
  (native ES modules features only up to ES2020).
- **NFR-203** Keyboard accessible nav & tooltips; visible focus states; touch targets ≥ 40 px.

## Key Entities

- **Translation file** `i18n/<lang>.json` — flat map, `de.json` authoritative.
- **Design tokens** — CSS custom properties (FR-207), single source of truth for colors.

## Edge Cases

- Device unreachable / fetch fails → non-blocking toast «Verbindung zum gPlug verloren…» and
  automatic retry on next poll tick; stale data stays visible with a subtle timestamp note.
- `lang.json` missing (dev server) → fall back to `i18n/de.json` path.
- RTC not synced (`/api/meta.time` < 1e9) → show banner «Uhrzeit noch nicht synchronisiert».

## Out of Scope

- Page content (specs 003–006).
- Server-side language negotiation (one build per language by design).

## Existing Code — Extend, Don't Break

- `webservice.be` `/fs` file serving and `/app` redirect are reused as-is; if `.tapp`-internal
  file lookup needs extra MIME types (`.css`, `.json`), extend the MIME map in `webservice.be`
  without altering existing behaviour.
- Makefile: existing targets (`minify`, `test`, `clean`) keep working.
- Dev workflow `python -m http.server 3000` in `ems/frontend/` must still work (use `?host=` to
  point at a device/simulator) — document in `ems/README.md`.
  *(Superseded: the static-server workflow was replaced by the Vite dev server
  (`npm run dev`), and `?host=` only works against a backend that sends CORS
  headers — the gPlug firmware is built without `USE_CORS`. Use
  `DEV_DEVICE_URL=http://<device> npm run dev`, which proxies the device paths
  same-origin. See `ems/README.md`.)*

## Testing (required)

- `bundle.py` is deterministic (same input → byte-identical output) — assert via a make check.
- i18n completeness check at build: script fails for de.json keys referenced in `src/*.js`
  (regex `t\(['"]([a-z0-9.]+)`) but missing from `de.json`, and warns for unused keys.
- Manual viewport checklist in the PR description: 360 px, 768 px, 1440 px screenshots of the
  shell.

## Acceptance Checklist

- [ ] `make` produces a `.tapp` whose UI loads with zero external network requests
      (verify via devtools network tab)
- [ ] `make tapp LANG=en` produces an English build; missing-key warnings printed
- [ ] Sidebar navigation matches Figma (colors, active states, icons)
- [ ] All shared components render in a demo/placeholder route
- [ ] Size budget respected; `make test` still green
