# Feature Specification: Browser-Archiv & Backend-Verschlankung

**Feature Branch:** `011-browser-archive-backend-slimming`
**Created:** 2026-09-05
**Status:** Implemented — steps 1, 2, 3a and 3b (2026-09-05, v1.0.10 / v1.0.11 / v1.0.12 / v1.0.13)
**Depends on:** `001-energy-data-and-storage`, `004-verlauf-history`, `006-einstellungen`
(read `specs/README.md` for shared constraints C-1…C-7 and the glossary)

> **Issue #1 (2026-09-23).** The virtual energy community (former specs 005/009) was removed
> entirely after this spec shipped: the community module, its UDP protocol, peer-slot buckets,
> the `vz15` archive store and the quarterly settlement are gone. The community-specific
> parts of this spec (analysis rows A2-community and A7, UC-1102, FR-1123, the peer-slot
> share of FR-1120/FR-1124) are reduced to short notes below; the device-own 15-min archive is
> unaffected.

> **Constraint note.** This spec deliberately *removes* device-side behaviour and therefore
> overrides **C-1 (preserve behaviour)** for the endpoints and modules listed in §«Backend
> removals». Every removal is either dead (no caller in the frontend or simulator) or replaced
> by an equivalent browser-side computation. All other constraints stay binding; in
> particular the established rule **«the device serves raw data, the browser computes»**
> (specs 007–010) is extended to **«…and the browser stores»**.

## Overview

The `.tapp` is **94.5 KB** minified, of which the UI shell is 0.5 KB — the package is
Berry bytecode source. The community module (26 KB), `store.be` (15 KB) and `webservice.be`
(11 KB) account for more than half. A code-verified analysis (2026-09-05) found three classes of
device-side work that the browser can take over:

1. **Dead surface** — endpoints and fields no frontend or simulator code calls
   (`/grid`, `/reload`, `/productions?action=set-power`, single-load `GET /loads?id=`,
   `meta.version`, `meta.language`, the `conflict` discovery flag, boot heap marks).
2. **Duplicated logic** — the browser already implements it: config validation
   (`einstellungen.js` `validate*` vs `configservice.validate`), and the former community
   allocation.
3. **Roll-ups and late corrections** — day/month records (`store.be` FR-104) and the
   device's own community share written back into sealed slots (the line-wise rewrite
   path). These exist only because the browser used to see just the last 4 days of
   15-min slots.

Class 3 is unlocked by a **browser-side archive**: the browser persists every 15-min record
it has fetched in **IndexedDB**, syncs incrementally on each visit, and derives day/month
roll-ups and costs from its own history. The device shrinks to a **short raw buffer**
(15-min buckets, append-only), retention lengthened from 4 to 30 days so a browser that visits at least once
a month never misses a slot.

Expected result: **≈ 19–20 KB (~20 %) less Berry** in the `.tapp`, `store.be` from 15 KB to
≈ 4 KB, **no read-modify-rewrite on flash at all** (appends only), and — as a functional
gain — Verlauf history derived at 15-min resolution for the whole archived period.

### Size analysis (minified estimates, ±20 %)

| # | Device code removed | Est. saving | Browser replacement |
|---|---|---|---|
| A1 | `store.be` day/month roll-ups: `_roll_day/_roll_month`, `_seal_day/_seal_month`, `_prune_seal/_prune_seal_to`, `_copy_over`, `_scan_seal_summary`, `_rebuild_running`, `_cursor_next_seal`, seal branch of `open_cursor`, `_day_of_month`, `month_start`, `c1d/c1mo` state, `/e1d`, `/e1mo` | ~5.5 KB | `lib/aggregate.js` `aggregate()` over the archive |
| A2 | `store.be` late community-share corrections: `_rewrite_bucket`, `_rewrite_seal`, `_flush_pending`, `_find_line`, `_prune_pv15_for_day`, `pv15/pd1d/pd1mo` overlays in the cursor, plus the device-side community allocation | ~6–7 KB | browser-side allocation (itself removed by issue #1) |
| A3 | `configservice.be` `validate`, `_validate_tariffs`, `_validate_ht_windows`, `_validate_url`, `_check_url_str`, `_validate_array`, `_is_number` | ~3 KB | `einstellungen.js` `validateLoad/Production/Grid/Site/Tariffs` (already enforced before POST) |
| A4 | `webservice.be` `_scan_version`, `_scan_language`, `_read_version`, `_read_language`, caches; `version`/`language` keys of `/api/meta` | ~1.3 KB | none needed — `i18n.js` reads `document.documentElement.lang`; nothing reads `meta.version` |
| A5 | `/productions?id&action=set-power` branch, `site.set_production_power`, `site._actuate_prod`, `'prod'` actuation kind, `set_power` in `gplug/homeassistant/shelly/simulator` | ~1.2 KB | none — no caller |
| A6 | `/grid` (`gridrequest`, `site.get_grid`), `/reload`, `GET /loads?id=` and `action=state` branches | ~0.9 KB | none — no caller (`api.getGrid`, `api.reload` unused; config POST reloads itself) |
| A7 | community-module conflict detection and member-state enrichment | ~0.7 KB | (removed by issue #1) |
| A8 | `main.be` `_mem_mark/_mem_dump` boot instrumentation | ~0.5 KB | none (debug aid, issue #2 closed) |
| | **Total** | **≈ 19–20 KB** | |

Not movable (device must act while no browser is open): `ems.be` allocation and relay
actuation, `site.be` scheduler, `meter.be` 10-s sampling and Wh integration, the 15-min
append, the streaming response buffers.

## Use Cases

### UC-1101: History survives on the user's device, not the gPlug

Persona B opens the Übersicht on the laptop once a week. Each visit the browser fetches the
15-min records newer than its last archived `ts`, appends them to IndexedDB and rebuilds the
Verlauf month view from *its own* 15-min history. The Verlauf «Monat» resolution shows 18
months as before — and now with the HT/NT split on every past month, because the
browser holds 15-min resolution for the whole period.

### UC-1102: (removed)

Quarterly community settlement — removed with issue #1.

### UC-1103: Nobody looked for a while

The site owner is on holiday for six weeks. The device keeps 30 days of 15-min buckets. On
return the browser syncs the last 30 days; the two weeks before are a **hole** the UI shows
as «keine Daten» (never zero-filled, spec 001 UC-104) with a hint that the archive has a gap
between `<from>` and `<to>`. A CSV exported by another client before the holiday can be
imported to fill it (FR-1110).

### UC-1104: The device's IP changes

DHCP hands the gPlug a new address. Browser storage is per origin, so the archive under
`http://192.168.1.42` is invisible from `http://192.168.1.57`. The Einstellungen page shows
the archive coverage (site id, first/last ts, gap count) and offers **Export / Import**, and
the Wi-Fi help text recommends a DHCP reservation.

### UC-1105: Settings saved from Pro mode with a malformed URL

Persona A pastes raw `site.json` with `"url": "ftp://…"` into the Pro editor. The editor
lists the finding as a **warning** but does not block: the device accepts any JSON object
that `site.load_config()` can load (unchanged rollback on failure). The integration then
fails at poll time and the load shows as unreachable in the Übersicht — the same behaviour
an unreachable host has today.

## Functional Requirements

### Frontend — archive (`ems/frontend/src/lib/archive.js`)

- **FR-1101** New pure module `lib/archive.js` wrapping **IndexedDB** (never `localStorage`:
  string-only, ~5 MB cap, synchronous). Database name `gplug-archive`, version 1. Object
  stores:
  | Store | Key | Value |
  |---|---|---|
  | `e15` | `[siteId, ts]` | `{ts, imp_wh, exp_wh, pv_wh, partial}` (raw device record, never a cost) |
  | `meta` | `siteId` | `{lastE15Ts, firstE15Ts, gaps:[[from,to],…], syncedAt}` |
  (A `vz15` store of raw community peer slots existed until issue #1.)
  All values integer Wh exactly as served. Costs, roll-ups and allocations are **never
  stored** (spec 001 «costs are never stored» extended to every derived series).
- **FR-1102** `siteId` is the device's `/site` `id` (not the origin). Records from a device
  whose `id` changed are a different archive; the UI warns once (toast) when the id under the
  current origin changes.
- **FR-1103** Incremental sync `archive.sync(api)`: on every page mount and every 15 min
  while a page is open, fetch `GET /api/energy?res=15m&count=<cap>&from=<lastE15Ts+900>`,
  upsert into `e15`, update `meta`. First sync on an empty
  archive fetches the full device buffer. Sync is idempotent (re-fetching a slot already
  stored overwrites with an identical value).
- **FR-1104** Gap detection: after sync, any run of missing 15-min `ts` between `firstE15Ts`
  and `lastE15Ts` that the device buffer no longer covers is recorded in `meta.gaps`. Gaps
  are shown, never filled (spec 001 FR-109 / UC-104).
- **FR-1105** Derived series come from the archive only:
  - Verlauf (spec 004) and the Übersicht KPI strip (spec 008) read `archive.range(siteId,
    from, to)` and call the existing `aggregate.js` for `1d`/`1mo` roll-ups; the
    `res=1d|1mo` device endpoint is no longer requested.
  - (The browser-side community share and settlement listed here were removed with issue #1.)
- **FR-1106** Roll-up parity: the browser day/month roll-up must equal the former device
  roll-up for the same input — nil-aware sums (`_add_field` semantics: a field stays `null`
  until at least one contribution exists), UTC day/calendar-month boundaries, `partial`
  propagates.
- **FR-1107** Coverage indicator (Einstellungen › «Daten» tab, new): site id, archived range
  `firstE15Ts … lastE15Ts`, record count, gaps list, last sync time, storage estimate
  (`navigator.storage.estimate()` where available). Also a compact «Archiv: n Tage» badge in
  the Verlauf header; a Verlauf period that touches a gap is marked
  «provisorisch» with the gap range in the tooltip.
- **FR-1108** Persistence request: on first successful sync call
  `navigator.storage.persist()` (best effort) so the browser does not evict the archive under
  storage pressure.
- **FR-1109** Multi-client note in the UI («Daten» tab help text): each browser keeps its
  own archive; a client that stayed away longer than the device buffer has a gap the other
  client may not have. Recommend one primary client or periodic export.
- **FR-1110** Export / Import: extend the existing CSV export (spec 004 FR-407) with a
  **full-archive** export (`e15`, one file, header row carries `siteId` and format
  version); an **Import** button (file input) merges a previously exported file into the
  archive (upsert by key, never deletes). Import validates the site id and refuses a
  mismatch with a clear message.
- **FR-1111** Storage failure is non-fatal: if IndexedDB is unavailable (private window,
  quota, `SecurityError`) every page still renders from the live device buffer exactly as
  today, with a persistent banner «Archiv nicht verfügbar — nur die letzten n Tage sichtbar».

### Frontend — validation (spec 006 FR-606 becomes the only validation)

- **FR-1112** `einstellungen.js` is the single source of truth for the field rules. The
  strict `validate*` helpers keep guarding the guided tabs; a new, **lenient**
  `validateDocument(cfg)` mirrors the deleted Berry validator for whole documents: `id` a
  non-empty string; `loads`/`productions`/`grid` arrays of objects; per load a unique
  non-empty `id`, `currentPower` numeric *when present*, `priority` a number ≥ 1 *when
  present*, and every `url` string (or every value of a shelly url map) starting with
  `http://`/`https://` *when non-empty*; `tariffs` numeric keys numbers ≥ 0 when present;
  `ht_windows` entries with numeric `from`/`to`, `0 ≤ from ≤ to ≤ 24`. It returns a list of
  `{path, key}` findings, is pure, and is node-tested.
  **Pro-mode raw save runs it and lists the findings as warnings — it does not block**
  (decided 2026-09-05, reconciling this FR with UC-1105: the Pro tab stays the escape hatch,
  and the device accepts the document either way). The form rules the device never had
  (required `name`, required `currentPower`, required tariff keys, HT/NT pairing, integer
  `co2_g_kwh`, url mandatory for a `gplug` load) are deliberately *not* applied to a raw
  document — they would flag configs the device accepts today.

### Backend — retention & buffer (`store.be`)

- **FR-1120** `store.KEEP_DAYS` 4 → **30**. Bucket file layout unchanged (`/e15_<dayno>`).
  (The community peer-slot retention defined here was removed with issue #1.)
- **FR-1121** `store.be` keeps **only** the 15-min path: `push_15m` (append one line),
  `_touch_dayno` eviction, `_list_daynos`, `_count_lines`, `load()` (prune + line counts),
  the 15-min cursor (`open_cursor/next_into/close_cursor`), `count/capacity` for `15m`.
  Removed: everything in analysis rows A1 and A2. Line format stays
  `<delta>,<imp>,<exp>,<pv>\n` — the optional two-field legacy tail is no longer written;
  the parser still accepts 6-field lines so existing buckets load (the tail is ignored). `/e1d`, `/e1mo`, `*.tmp` and the legacy `/energy.json` are
  removed at boot (one-time cleanup, like issue #4 did for the ring file).
- **FR-1122** `GET /api/energy`: `res` accepts only `15m` (any other value → HTTP 400
  `{"error":"invalid res"}` as before); record shape
  `{"ts","imp_wh","exp_wh","pv_wh","partial"?}` — the two former community fields are no
  longer present. `count` default 96, cap `KEEP_DAYS·96`; `from`/`to` filters unchanged and are
  what the incremental sync relies on.
- **FR-1123** (Community-module slimming — superseded: the module was removed entirely with
  issue #1.)
- **FR-1124** STORAGE.md flash budget updated. From the measured sizes in STORAGE.md §4
  (384 six-field slots = 10 296 B → ≈ 22 B per four-field line): 30 days of own 15-min
  lines ≈ 2 880 × 22 B ≈ **63 KB**. The retention is a **build-time constant with a
  documented ceiling**: default `KEEP_DAYS = 30`. (At the time, community peer slots also
  shared the budget; they were removed with issue #1.) Implementer MUST recompute the STORAGE.md table
  with the Berry CLI script in its §5 and pick the largest values that leave ≥ 40 KB free;
  the `.tapp` reserve may be lowered once NFR-1101 is measured.

### Backend — removals (`webservice.be`, `site.be`, `configservice.be`, `main.be`, integrations)

- **FR-1125** `/api/meta` → `{"time":<utc>,"tariffs":{…}}`. `_scan_version`,
  `_scan_language` and their caches removed (A4). `VERSION.txt` stays in the `.tapp` for the
  Makefile/CDN pinning only.
- **FR-1126** Removed endpoints/branches (A5, A6): `/grid`, `/reload`, `GET /loads?id=<id>`
  (bare), `GET /loads?id=<id>&action=state`, `GET /productions?id=…` (bare and
  `action=set-power`). `/loads` list, `/loads?id&action=transition&to=`, `/productions` list,
  `/site`, `/api/power`, `/api/energy`, `/api/meter`, `/api/config`, `/fs`, `/app` stay.
  `site.set_production_power`, `site._actuate_prod`, the `'prod'` actuation kind and the
  `set_power` function in all four integrations are deleted; `site._enqueue` keeps only the
  `load` kind.
- **FR-1127** `configservice.be` keeps `save()` = `json.load` → write `site.json.new` → copy
  over → `site.load_config()` → rollback if `get_site()==nil`. The whole `validate` family
  is deleted (A3). A body that is not a JSON object still returns 400 `{"error":"invalid
  json"}` (one `isinstance(cfg, map)` check is all that survives); a document
  `site.load_config()` cannot load still returns 500 and restores the previous file.
- **FR-1128** `main.be` `_mem_mark`/`_mem_dump` and the marks list are deleted (A8).
  `_load_integrations`, the lazy configservice stub and the boot gate are unchanged.
- **FR-1129** Docs: `CLAUDE.md` (root + backend + frontend), `docs/features.md`, spec 001
  «Implementation note» block get a one-paragraph pointer to this spec for every
  removed endpoint/field.

## Non-Functional Requirements

- **NFR-1101** `.tapp` shrinks by ≥ 15 KB against the v1.0.9 baseline (94 541 B); measured
  with `unzip -l` and recorded in STORAGE.md.
- **NFR-1102** Flash: the device performs **append-only** writes after this spec — no file
  is ever read and rewritten (the `.tmp` copy-back pattern disappears with A1/A2). One
  append per slot close per series, as before (spec 001 FR-105).
- **NFR-1103** Heap: no new RAM-resident state on the device; `store.be` state shrinks to
  `nb` + `last_ts`. `/api/energy` streaming (~1 KB batches) unchanged.
- **NFR-1104** Browser: a full sync of a 30-day buffer (≈ 2 880 records) must
  finish in < 3 s over Wi-Fi to the ESP32 — the sync respects the existing
  `MAX_INFLIGHT = 2` queue and fetches in `count ≤ 384` pages.
- **NFR-1105** The archive read for an 18-month Verlauf (≈ 52 000 records) must render in
  < 500 ms on a 2020 laptop: read by key range, aggregate once, memoise per
  `(range, resolution, tariffs)` as `verlauf.js` already does.
- **NFR-1106** (Community settlement determinism — removed with issue #1.)
- **NFR-1107** Privacy unchanged: the archive holds only what the device already served to
  that browser; nothing leaves the browser (C-2).

## Key Entities

- **Archive** — per `(origin, siteId)` IndexedDB database holding raw 15-min records plus a
  coverage record.
- **Coverage** — `{firstE15Ts, lastE15Ts, gaps, syncedAt}` — what the archive knows about
  its own completeness; drives the «provisorisch» markers.
- **Device buffer** — the 15-min bucket files kept on flash for `KEEP_DAYS`; the only source
  of truth for the most recent slots, and the *only* source at all for a browser that has
  never synced.

## Edge Cases

- **Clock step on the device** (spec 001 edge case): a slot with a `ts` older than the
  archive's `lastE15Ts` but not yet stored is still upserted — sync uses `from`, but the
  first sync of a session always re-fetches the last 2 days to catch late buckets.
- **Archive site id ≠ device site id** (owner renamed the site): warn, keep both archives;
  the coverage tab lists every siteId present and offers to delete one.
- **IndexedDB quota exceeded**: sync stops, banner as in FR-1111, existing archive stays
  readable.
- **Two tabs syncing concurrently**: upserts are idempotent; the `meta` write uses the
  larger `lastE15Ts`.
- **Pre-spec device (v1.0.9) with new frontend**: `/api/energy` still returns the two legacy
  community fields and accepts `res=1d`; the frontend ignores the fields (recomputes) and never asks
  for `1d/1mo`. Works.
- **New device with old cached frontend**: an old bundle requests `res=1d` → 400; the CDN
  version is pinned by `VERSION.txt` in the shell, so this only happens with a stale
  self-host build — acceptable, fixed by rebuilding.

## Out of Scope

- Moving `ems.be`, `meter.be`, or the 15-min accumulation to the browser.
- Cross-browser archive sync via the device (the device is not a relay for browser data).
- Retention beyond 30 days on the device; a longer own-series buffer would need the packed
  encoding that issue #4 replaced.
- De-duplicating `_sort_ints/_all_digits/_last_slash/_close_q` into `fsx.be` (~2 KB more)
  — recommended follow-up, not part of this slice.

## Existing Code — Extend, Don't Break

- `lib/aggregate.js`, `lib/insights.js` stay pure and DOM-free; `archive.js`
  is the only module touching IndexedDB and is injected (not imported) by pages so the
  existing node tests keep running without a browser.
- `api.js` keeps every wrapper that still has a device endpoint; `getGrid`, `reload` are
  deleted; `getEnergy(res, …)` asserts `res === '15m'`.
- `tests/test_store.be`, `tests/test_webservice_energy.be`,
  `tests/test_configservice.be`, `tests/test_ems_allocation.be` are reduced to the surviving
  behaviour (the roll-up, community-share write-back, `validate` and `set_production_power`
  cases are deleted, not skipped). `tests/test_ems_allocation.be` mutates the cached
  production map directly instead of calling `set_production_power`.
- Simulator (`simulator/backend`) is unaffected: it never calls the device.

## Testing (required)

- **Frontend (node, `npm test`)**
  - `tests/test_archive.mjs` with an in-memory IndexedDB shim (`fake-indexeddb` dev
    dependency): first sync fills from empty; incremental sync fetches `from = last+900`;
    upsert idempotent; gap detection across an evicted range; import merges and refuses a
    foreign siteId; export/import round-trip is byte-stable.
  - `tests/test_aggregate_parity.mjs`: the JS `1d`/`1mo` roll-up over a fixture of 15-min
    records equals the record set the Berry `store.read('1d'|'1mo')` produced for the same
    input (fixture generated once from the current `store.be` before deletion and committed).
  - `test_einstellungen_validate.mjs`: `validateDocument()` — the rules of FR-1112, the
    cases deleted from the Berry `test_configservice.be`, and the leniency (a gplug load
    without a url, an absent `name`/`currentPower`/`tariffs`) that the strict form
    validators do not have.
- **Backend (`make test`)**
  - `test_store.be`: 30-day eviction; 6-field legacy lines parse; `/e1d`/`/e1mo`/`.tmp`
    cleanup at `load()`; `count('1d')` → `-1`.
  - `test_webservice_energy.be`: `res=1d` → 400; record has no community keys; `from` filter.
  - `test_configservice.be`: invalid JSON and a non-object body → 400; unloadable config →
    500 + rollback; a syntactically valid config with `"url":"ftp://x"`, `"priority":0` and
    a non-numeric `currentPower` → 200 (validation moved).
- **On-device**: flash `.tapp`, confirm `unzip -l` size, `/api/meta` shape, 15-min append
  visible after one slot close, no `.tmp` files ever appear.

## Acceptance Checklist

- [ ] `make test` and `npm test` green
- [ ] `.tapp` ≥ 15 KB smaller than v1.0.9 (NFR-1101), number recorded in STORAGE.md
- [ ] STORAGE.md budget table recomputed for the chosen `KEEP_DAYS`, ≥ 40 KB
      headroom proven (FR-1124)
- [ ] Verlauf «Monat» and «Tag» render from the archive with values identical to the
      pre-spec device roll-up on a device that ran both versions for one day
- [ ] Coverage tab shows range/gaps; export → clear site data → import restores the Verlauf
- [ ] Private window / blocked storage: pages render from the device buffer with the FR-1111
      banner, no console errors
- [ ] No file on the device is ever rewritten (grep: no `open(…, 'w')` on a data file
      outside `configservice.be` and the registry)

## Rollout (three independently shippable steps)

1. **Dead code** (A4–A8, FR-1125/1126/1128): frontend unchanged, pure removal, ~4 KB.
   — **Done (2026-09-05, v1.0.10).** Also dropped as dead alongside the listed surface:
   `site.get_grid_by_id`, the `kind` parameter of `site._enqueue`, and the `api.getGrid` /
   `api.reload` wrappers in the frontend.
2. **Validation** (A3, FR-1112/1127): frontend validator first, device removal in the same
   release, ~3 KB.
   — **Done (2026-09-05, v1.0.11).** `validateDocument()` + `tests/test_einstellungen_validate.mjs`
   in the browser, the whole `validate` family gone from `configservice.be`
   (6 888 → 3 497 B minified). Packed sources 88 638 → 85 247 B (−3 391 B, −3.8 %).
   The Pro editor warns instead of blocking (FR-1112 as amended).
3. **Archive** (A1–A2, FR-1101–1111, 1120–1124): frontend archive ships **one release
   before** the device roll-up removal so every client has synced at least once from a
   device that still serves the full history; the device removal follows, ~12 KB.
   — **Step 3a done (2026-09-05, v1.0.12).** `lib/archive.js` (IndexedDB `gplug-archive`,
   stores `e15`/`meta` — plus a community store since removed — keyed by the `/site` id), incremental sync at boot + every
   15 min, gap detection, `navigator.storage.persist()`, CSV export/import, the
   Einstellungen «Daten» tab, the FR-1111 banner, and a browser-side community share
   replacing the device's write-back (removed with issue #1). Verlauf derives **every**
   resolution from archived 15-min records (so «Monat» now carries the HT/NT split; while
   the archive is younger than the device rings, buckets older than it still come from
   `res=1d|1mo` so nobody loses history at upgrade — that fallback dies with step 3b),
   Device side of 3a: `KEEP_DAYS` 4 → 30 (community peer slots 4 → 14 at the time), and
   `GET /api/energy` with `from` now pages **forward**
   from the oldest matching slot (it returned the newest `count` before, which no
   incremental sync could walk). STORAGE.md recomputed: 15m 30 d = 77 272 B,
   `.tapp` reserve lowered 160 → 128 KB, headroom ≈ 50 KB.
   Tests: `test_archive.mjs` (fake-indexeddb), `test_aggregate_parity.mjs` against a
   fixture generated from the pre-removal `store.be` (`tests/gen_rollup_fixture.be`),
   Berry `test_store.be`/`test_webservice_energy.be` updated.
   — **Step 3b done (2026-09-05, v1.0.13, issue #8).** `store.be` keeps only the 15-min
   append path (15 334 → 5 323 B minified): the day/month roll-ups, `/e1d`, `/e1mo`,
   the community-share write-back and the `.tmp` line-wise rewrite are gone, RAM state is `nb` alone (NFR-1103),
   and a 6-field legacy line still parses so existing buckets survive the upgrade.
   `GET /api/energy` serves `res=15m` only (400 otherwise) and records carry no community fields
   (FR-1122). The community module (25 624 → 22 021 B) lost its device-side allocation and
   no longer imported `store` at all (it was deleted entirely later, issue #1). Frontend: `verlauf.js` dropped the `res=1d|1mo` transition fallback and
   `api.getEnergy` asserts `res === '15m'`. `.tapp` 88 479 → **74 836 B**, i.e. 19 705 B
   under the v1.0.9 baseline (NFR-1101 asked for ≥ 15 KB); STORAGE.md §4 recomputed —
   15m 30 d = 54 240 B, footprint 248 678 B, headroom ≈ 77 KB (FR-1124). Retention is
   unchanged at 30 days.

   Deviations worth recording: `store.be`'s `last_ts` was dropped too (its only reader was
   the community-share write-back), and `day_start`/`month_start` went with the roll-ups — nothing outside the
   deleted code called them. `tests/gen_rollup_fixture.be` was deleted with the code it
   drove; its output stays frozen in `frontend/tests/fixtures/rollup_parity.json`.
   Removing the `verlauf.js` fallback also fixed a live off-by-one in that page's
   `Promise.all` destructuring, which had been feeding the wrong arrays to the community-share
   join and the roll-up prepend.
