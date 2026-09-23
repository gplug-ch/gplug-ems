# Feature Specification: vZEV Community — Members, Allocation & Abrechnung

**Feature Branch:** `005-vzev-community`
**Created:** 2026-07-14
**Status:** Implemented
**Depends on:** `001-energy-data-and-storage`, `002-ui-shell-design-i18n`
(read `specs/README.md` for shared constraints and the glossary)

> **Implementation note (reconciled 2026-07-27).** Delivered. Backend in
> `vzev.be` (registry, deterministic largest-remainder allocation, UDP
> ann/slot/req exchange, `store.set_vzev`, `/api/vzev/*` handlers). Two
> reconciliations vs. this draft: (1) the `/api/vzev/*` endpoints (FR-507) are
> registered by `vzev.be` itself, not an `apiservice.be` module; (2) FR-508
> wiring is now real — `vzev.be` is loaded in `autoexec.be` and started from
> `main.be` after `udpclient` (it had been fully written but never wired, so the
> whole vZEV backend was dead code on-device), and `meter.be` hands each sealed
> 15-min slot to `vzev.announce_slot()`. Frontend `vzev.js` (graph) and
> `vzev_member.js` (form) are converted to ES modules and routed in `main.js`;
> `abrechnung.js` was already live. `examples/vzev.json` ships a sample registry.
>
> **Spec 011 step 3a (2026-09-05).** Peer slots are archived in the browser
> (`vz15` store), so Abrechnung settles the **whole** quarter instead of the device's
> buffer, and each site's own `vzev_in_wh`/`vzev_out_wh` are derived by
> `lib/vzev.js` `ownShare()` instead of the device's `store.set_vzev()` write-back.
> Peer-slot retention on the device is `VZ_KEEP_DAYS = 14`.
>
> **Spec 011 step 3b (2026-09-05, v1.0.13).** The device no longer allocates at all:
> `vzev.allocate`, `_try_allocate`, the per-slot `pending` map with its 5-min grace
> timeout and the `store.set_vzev` bridge are deleted, so FR-505/FR-506 are fulfilled
> in the browser (`lib/vzev.js` `allocate()`/`ownShare()`) over the archived peer slots.
> `announce_slot()` is reduced to «store the own slot → multicast it»; the registry,
> discovery, the ann/slot/req protocol, the peer-slot buckets and `/api/vzev/*` are
> unchanged. Determinism (NFR-503) now holds per browser archive.

## Overview

Three gPlug devices form a vZEV over the local network: one producer site (PV) and consumer
sites. The distribution of locally produced energy is **computational, not physical**: per
15-minute slot, the producer's grid export is allocated to the members' grid imports; the
allocation and its money value (vZEV tariff vs. grid tariff) must come out **identical on every
device**, and per quarter must reconcile with the grid operator's meter data.

This spec adds:
1. **Backend:** member registry (`vzev.json`), 15-min slot exchange over the existing UDP
   multicast (`messaging/udpclient.be`, group `239.3.0.1:5007`), the deterministic allocation
   algorithm, peer-data ring storage, retransmission for missed slots, and `/api/vzev/*`
   endpoints.
2. **Frontend:** «vZEV» page (member/energy-flow graph, Figma `40:835`), member add/edit form
   (Figma `40:868`), and «Abrechnung» quarterly settlement pages (Figma `40:882`, `40:922`,
   old-quarter variants `40:936`/`40:963`).

## Use Cases

### UC-501: Onboard a member (answers review question "Wie funktioniert das Onboarding?")
**Actor:** Administrator of a site
**Flow:** Each gPlug periodically announces itself on the multicast group. On the vZEV page,
«+ vZEV Mitglied hinzufügen» lists discovered, not-yet-added devices (site id, name, IP). The
admin adds one; the local device stores it in `vzev.json` and starts exchanging slot data with
it. The same is done on the other device (mutual add — no central authority).

**Acceptance Scenarios**
- **Given** two gPlugs on the same LAN, **When** the admin opens «Mitglied hinzufügen»,
  **Then** the other device appears in the discovery list within 30 s with its site name and id.
- **Given** a member was added, **Then** it persists across reboot (`vzev.json`) and appears on
  the vZEV graph.
- **Given** a device that is *not* added, **Then** its slot data is ignored (no silent joins).

### UC-502: Edit / remove a member (answers "Was wird hier editiert und was bei den Einstellungen?")
The vZEV page edits the **local view of remote members** (display name «Anzeige-Name», Ort, Typ
Produzent/Konsument — Figma `40:868`); «Einstellungen» (spec 006) edits the **own site**.
The form's initial values come from the member's own announcement but can be overridden locally.

**Acceptance Scenarios**
- **Given** the pencil icon on a member card, **When** the admin renames «site-b» to «Familie
  Müller» and saves, **Then** the name shows everywhere on this device (graph, Übersicht vZEV
  panel, Verlauf breakdown, Abrechnung) without affecting the remote device.
- **Given** «Entfernen» on a member, **Then** its data stops being collected; already stored
  slots remain until their rings roll over (documented behaviour).

### UC-503: Exchange 15-min slot data
**Actor:** Devices (automatic)
**Flow:** When a slot closes (001 FR-102), each device multicasts its slot record. Every device
stores peers' records, runs the allocation, and updates its own `vzev_in_wh`/`vzev_out_wh` via
`store.set_vzev` (001).

**Acceptance Scenarios**
- **Given** producer exports 2000 Wh in slot T while members import 1500 Wh and 500 Wh,
  **Then** all three devices compute the identical allocation for T:
  member A 1500 Wh, member B 500 Wh, producer `vzev_out_wh=2000`.
- **Given** producer exports 1000 Wh while members import 1500/500 Wh (total 2000),
  **Then** allocation is proportional: A 750 Wh, B 250 Wh.
- **Given** members import 300 Wh total while producer exports 1000 Wh, **Then** allocated 300
  Wh; the remaining 700 Wh stay Netzeinspeisung (holiday scenario — see Edge Cases).
- **Given** a device missed slot T (offline), **When** it comes back, **Then** it requests the
  missing slots from peers and converges to the same values (retransmission).

### UC-504: Quarterly settlement («Abrechnung»)
**Actor:** Resident
**Flow:** From the vZEV page, «Abrechnung» opens `#/vzev/abrechnung` with a quarter selector
(current + past quarters from the 18-month monthly ring).

**Acceptance Scenarios**
- **Given** the producer device, **Then** the page shows a **Total** card (Energie
  Fremdverbrauch [kWh], Gewinn [CHF], chart) and one card per consumer member (Energieverbrauch,
  Gewinn) — Figma `40:882`.
- **Given** a consumer device, **Then** one card: Energie Import [kWh] and Kosten [CHF] — but
  priced at the vZEV tariff with the **saving vs. grid tariff** shown («… statt … beim
  Netzbetreiber») — Figma `40:922` + economic-transparency goal.
- **Given** «2025 Q4» selected, **Then** historical data renders identically (old-quarter
  variants `40:936`/`40:963`).

### UC-505: Privacy (answers "Sehe ich, wie viel Müller beim Netzbetreiber eingekauft hat?")
**Acceptance Scenarios**
- **Given** any UI on Familie Huber's device, **Then** no view shows another member's total
  Netzbezug or Verbrauch — only the **vZEV-relevant flows** (what that member received from /
  delivered to the community). The protocol enforces this: slot messages carry only the fields
  needed for allocation (FR-509).

## Functional Requirements

### Backend
- **FR-501** New module `ems/backend/vzev.be`. Member registry persisted at `/vzev.json`:
  ```json
  {"members":[{"id":"site-b","name":"Familie Müller","location":"Hofstettenstrasse 13",
    "type":"CONSUMER|PRODUCER","url":"http://192.168.0.52/","added_ts":123}]}
  ```
  API (module lambdas): `get_members()`, `upsert_member(m)`, `remove_member(id)`,
  `get_discovered()`.
- **FR-502** Announcements: every 10 s (reuse a driver tick), multicast
  `{"t":"ann","site":"<id>","name":"<name>","loc":"<location>","typ":"P|C","url":"http://<ip>/"}`
  via `udpclient.send`. `typ` = P if the site has productions. Received announcements from
  unknown sites populate the discovery list (RAM, expire after 60 s). **The existing startup
  URL-advertisement in `main.be` stays untouched** (C-1) — new messages are JSON payloads whose
  first byte `{` distinguishes them; non-JSON messages are ignored by the new handler.
- **FR-503** Slot exchange: on 15-min close, multicast
  `{"t":"slot","site":"<id>","ts":<slot_ts>,"imp":<wh>,"exp":<wh>}` (only these fields —
  FR-509). Received slot messages from **registered** members are stored in a per-member RAM+
  flash ring (240 slots each, file `/vzevdata.json`, same write discipline as 001 FR-105 —
  piggyback on the same 15-min write moment).
- **FR-504** Retransmission: `{"t":"req","site":"<id>","from_ts":…,"to_ts":…}` asks peers to
  re-send their slots in range; peers answer with the corresponding `slot` messages (rate-limit:
  ≤ 8 slots per request, one request per minute). On boot, a device requests the gap since its
  newest stored peer slot.
- **FR-505** Allocation (pure function `vzev.allocate(producer_exp, imports_map) → alloc_map`,
  unit-testable): per slot, `alloc_i = min(imp_i, round(producer_exp × imp_i / Σ imp))` with
  largest-remainder rounding so `Σ alloc = min(producer_exp, Σ imp)` exactly (determinism across
  devices; integer Wh). Multi-producer vZEV: out of scope, exactly one member may be type P
  (validate on add).
- **FR-506** After allocating slot T (all inputs present, or a 5-min grace timeout with the
  data at hand), each device writes its own share via `store.set_vzev(T, in_wh, out_wh)` (001).
  Late-arriving data (retransmission) re-runs allocation for T and overwrites — convergence
  beats first-write.
- **FR-507** Endpoints (`apiservice.be` extension, GET-only):
  - `GET /api/vzev/members` → registry incl. live state (`last_seen`, discovered flag)
  - `GET /api/vzev/discovered` → discovery list
  - `GET /api/vzev/members?action=upsert&id=…&name=…&loc=…&typ=…` /
    `…?action=remove&id=…` → mutate registry (URL-encoded; GET-only API per existing convention)
  - `GET /api/vzev/flows?res=15m|1d|1mo&count=N` → per-member allocated Wh series
    `[{ts, members:{"site-b":wh,…}},…]` (basis for Übersicht vZEV panel, Verlauf breakdown)
  - `GET /api/vzev/billing?quarter=2026-Q2` → per-member quarter aggregation
    `{quarter, months:[…], total:{exp_wh, revenue_chf}, members:[{id,name,wh,chf}]}` with CHF
    from `site.get_tariffs()` (001 FR-107/108).
- **FR-508** `main.be`/`autoexec.be` wiring only; `vzev.be` starts after `udpclient.start()` and
  registers its receive handling via `udpclient.set_on_receive` **chaining** any previously set
  callback (do not steal existing consumers).
- **FR-509** Privacy by protocol: slot messages contain only `imp`/`exp` Wh (needed for
  allocation); no load states, no production detail, no consumption. `/api/vzev/*` never exposes
  a peer's un-allocated import/export beyond what allocation requires locally. Document this in
  the module header.

### Frontend
- **FR-510** vZEV page `#/vzev` (Figma `40:835`): member cards (house icon, amber outline,
  name pill; own site centered, «Netz» node in navy below) connected by arrows showing the
  **current flow direction** (from live 15-min data: producer → consumer green arrows with
  `fmtW`/`fmtWh` labels; grid → member navy arrow when importing from Netzbetreiber). Pencil
  icon → member form; «+ vZEV Mitglied hinzufügen» (discovery list) and «Abrechnung ›» buttons
  in the page header. Layout: simple flex/grid (own site center), SVG arrows; must degrade to a
  vertical list with direction chips on < 768 px.
- **FR-511** Member form `#/vzev/mitglied/:id?` (Figma `40:868`): Anzeige-Name, Ort, Typ
  (Produzent/Konsument select), Speichern/Abbrechen; for new members pre-filled from discovery
  announcement; validation: exactly one Produzent in the community (FR-505).
- **FR-512** Abrechnung page `#/vzev/abrechnung` (Figma `40:882`/`40:922`): quarter `<Select>`
  (from available monthly data), producer layout (Total + per-member cards) vs. consumer layout
  (single card) — data from `/api/vzev/billing`; each card: kWh (yellow), CHF (green), and a
  `<BarChart>` of the quarter's monthly (or daily, if within current quarter) values with
  labeled axes. A note explains the settlement basis (`billing.note`: 15-min Messwerte,
  Abgleich mit Netzbetreiber pro Quartal).
- **FR-513** Übersicht integration: the 003 vZEV panel and Verlauf member breakdown read
  `/api/vzev/flows` — this spec must keep those response shapes stable.

## Non-Functional Requirements

- **NFR-501** All UDP handling non-blocking, ≤ 1 KB per datagram (well under multicast MTU).
- **NFR-502** Peer storage budget: 3 members × 240 slots × ~16 B ≈ 12 KB flash (within C-3).
- **NFR-503** Allocation is integer-exact and idempotent (re-running on same inputs yields the
  same result) — property-tested.

## Edge Cases

- **Holiday/pure-export**: no member imports → allocation 0, full export = Netzeinspeisung at
  feed-in tariff; Abrechnung shows Gewinn from Netzeinspeisung separate from vZEV Gewinn.
- Producer offline for a day: consumers' slots have no counterparty → `vzev_in_wh=0`, cost
  falls back to grid tariff automatically (001 FR-108 formulas do this inherently).
- Duplicate slot messages (multicast) → dedupe by (site, ts), last write wins.
- Two devices claim the same site id → log warning, ignore the later announcement (ids must be
  unique; surfaced in the UI discovery list as a conflict).
- Clock skew between devices: slots are keyed by their quarter-hour `ts`; devices with unsynced
  RTC don't send (001 NFR-103).

## Out of Scope

- Multi-producer allocation, dynamic tariffs, authenticated/encrypted UDP (trusted-LAN
  assumption — note it in the module header), central vZEV coordinator, editing the *own* site
  (spec 006).

## Existing Code — Extend, Don't Break

- `messaging/udpclient.be` / `udpdriver.be` used as-is via `send` / `set_on_receive` (chained,
  FR-508). Existing envelope `{from, timestamp, msg}` is kept; new payloads live inside `msg`.
- `ems.be` allocation of loads is unrelated and untouched.

## Testing (required)

- `tests/test_vzev_allocation.be`: proportional/capped/zero cases from UC-503, rounding
  determinism (Σ alloc exact), idempotence, single-producer validation.
- `tests/test_vzev_protocol.be`: message parse/dispatch (ann/slot/req), unknown-member slot
  ignored, dedupe, chained receive callback preserved (stub `udpclient`).
- Frontend unit tests: quarter aggregation for the selector, billing card math from a fixture.

## Acceptance Checklist

- [ ] Two-device (or stubbed) exchange converges to identical `vzev_*` values per slot
- [ ] Onboarding via discovery works; members persist; edit affects only local display
- [ ] vZEV graph matches Figma `40:835` incl. flow arrows and mobile fallback
- [ ] Abrechnung producer & consumer variants incl. old quarters
- [ ] Privacy: protocol carries only imp/exp Wh; no peer totals in any UI
- [ ] `make test` green incl. new Berry tests
