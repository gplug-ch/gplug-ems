# STORAGE.md — gPlug EMS on-device data & flash budget

This document is the single source of truth for **what the gPlug EMS persists to flash, how
much space it takes, and why it fits** the 320 KB firmware partition. It covers the energy
store (`store.be`, spec 001), which uses the **append-only bucket-file** design introduced in
issue #4. Since spec 011 step 3b the device only ever *appends*: the day/month roll-ups and
their rewrite are gone, so no file on the device is ever read and written back. All arithmetic below is reproducible with the
Berry CLI against the files in this directory.

---

## 1. Data strategy overview

The device records two fundamentally different kinds of data:

| Kind | German term | Cadence | Where | Persisted? |
|---|---|---|---|---|
| **Power** (instantaneous W) | Leistungsdaten | 10 s sample | RAM ring (90 samples, `meter.be`) | **No** — RAM only |
| **Energy** (Wh per slot) | Abrechnungsdaten | 15-min slot | flash bucket files (`store.be`) | **Yes** |
| **Costs** (CHF) | — | on read | computed in the **browser** | **Never stored** |

Power is volatile and only feeds live charts, so it never touches flash (NFR-102: ≤ 4 KB RAM).
Energy is billing-relevant and must survive reboots, so it is written to flash — but under a
strict write budget to protect flash wear (§4).

### Append-only bucket files, not RAM-resident rings (issue #4)

Earlier revisions kept three ring buffers fully resident in RAM (flat int lists) and rewrote a
single `/energy.json` on every 15-min slot close. That cost ~18 KB of RAM at full retention and
a multi-KB read+write on every write (`_rename()`'s full-file copy). Sealed records are only
ever *streamed* to the browser one at a time, so none of that needs to sit in RAM: **sealed
records now live directly on flash**, in small text files, and the device holds only the
running (open) accumulators plus a handful of bookkeeping ints.

| Series | Files | Line format | Retention |
|---|---|---|---|
| `15m` | `/.e15_<dayno>` (`dayno = ts/86400`, UTC), 30 kept | `<ts−dayno·86400>,<imp>,<exp>,<pv>\n`, on a battery site `…,<pv>,<chg>,<dis>,\n` | today + 29 previous days → up to 2 880 slots |

A record is `[ts, imp_wh, exp_wh, pv_wh]`. `imp`/`exp`/`pv` may be `nil` (empty field on disk)
when a sensor failed during the slot. A line is valid only if it is `\n`-terminated and has 4
comma-separated fields — a torn trailing append (a crash mid-write) is
therefore never counted or served, and self-heals on the next `load()`. Lines written before
spec 011 step 3b carry a trailing two-field legacy tail; the parser still accepts those
6-field lines and ignores the tail, so buckets survive the firmware upgrade.

**Battery (issue #20).** A slot with battery samples appends `,<chg>,<dis>,` — the charge and
discharge Wh (served as `bat_chg_wh`/`bat_dis_wh`) plus a **reserved, empty 7th field**. Seven
fields keep the line distinguishable from the legacy six-field line. The SoC would fit in
the reserved field but is deliberately not recorded: with it the worst-case headroom dropped to
38.7 KB, below the 40 KB rule (§4); the SoC is live only (`/productions`). A site without a
battery writes the four-field line unchanged.

**The day/month roll-ups are gone (spec 011 step 3b).** `/e1d` and `/e1mo` and the
`<file>.tmp` copy-back rewrite they needed were removed once the browser archive
(`ems/frontend/src/lib/archive.js`) had shipped: the browser mirrors every raw 15-min record
into IndexedDB and derives the day/month roll-ups and costs from its own copy. Both files (and any stray `.tmp`) are
deleted once, at the first `load()` of this firmware.

### Retention is what the browser archive needs (spec 011 FR-1120)

`KEEP_DAYS = 30` since spec 011 step 3a. The device is no longer the archive: the browser
mirrors every raw record it fetches into IndexedDB (`ems/frontend/src/lib/archive.js`) and
derives day/month roll-ups and costs from its own copy. The device buffer only has to be long
enough that a browser visiting **at least once a month** never misses a slot.

It is a build-time constant with a documented ceiling — raising it means re-running
the §5 measurement and keeping ≥ 40 KB of the partition free.

### Partial-data (nil) handling (FR-109 / UC-104)

- A slot where **no** sensor produced a sample is **not stored** — the `ts` sequence simply has a
  hole. The API never fabricates zero-filled slots for downtime.
- A slot where **some** sensors failed stores an empty field (`nil` on read) and is flagged
  `"partial": true`. The browser's roll-up is **nil-aware**: a `nil` contribution is skipped, and
  a roll-up field stays `nil` until at least one real contribution arrives
  (`frontend/src/lib/aggregate.js`; parity with the former device roll-up is frozen in
  `frontend/tests/test_aggregate_parity.mjs`).

### Public API

`count(res)`, `open_cursor(res, skip)` / `next_into(cur, m)` / `close_cursor(cur)`, `read(res, n)`,
`push_15m(ts, imp, exp, pv, chg, dis)`, `capacity(res)`, `load`, `reset`, `set_prefix`. `res` is `'15m'` —
the only resolution left; `count` answers `-1` and `capacity` `0` for anything else, and
`GET /api/energy?res=1d` is a 400 (spec 011 FR-1122). Consumers (`meter.be`, `webservice.be`)
read one record at a time via the streaming cursor — no whole-ring materialisation.

---

## 2. In-RAM layout

Resident state is just a small map and a string:

- `store.be`: `nb` (≤ `KEEP_DAYS` = 30 dayno → line-count entries) and the filename prefix —
  that is all that is left after spec 011 step 3b (NFR-1103).

This stays **well under 1 KB** even at full retention — replacing the ~18 KB RAM-resident
flat-ring design.

Writes are a single `open(path,'a')` + one line — a few dozen bytes of peak allocation. There is
no other write path. Reads stream one record/line at a time via the cursor API, so
peak transient allocation stays small even for a multi-hundred-record `/api/energy` response.

---

## 3. Flash-write cadence & wear (FR-105)

- **One append per 15-min slot close** (`push_15m()` → one `/.e15_<dayno>` line), and nothing
  else. There are **no writes on the 10 s sampling path** (that stays in RAM), and since spec 011
  step 3b **no rewrite of any kind** (NFR-1102) — no seal files, no `.tmp`.
- LittleFS commits an append as roughly one block program regardless of line size. At 4 slot
  closes/hour that is **96 appends/day** on the hot path, each a few dozen bytes.
- ESP32 SPI-flash endurance is ~100 000 erase cycles per sector, and Tasmota's LittleFS spreads
  writes across the filesystem area (wear levelling). The 15-min cadence — not 10 s — remains the
  deliberate lever that keeps this safe; append-only writes touch fewer distinct blocks per slot
  than the old full-file rewrite did.
- **Power-loss resilience (UC-103):** at most the current open slot is lost; every previously
  appended line is already on flash. A torn trailing line is self-healing — `load()` never counts or serves it.

---

## 4. Flash budget — proving it fits in 320 KB

The firmware app partition is **320 KB = 327 680 bytes**. The persistent footprint is the
`.tapp` plus every data file the EMS writes.

Worst-case bucket-file sizes (measured with the Berry CLI, §5):

| Series | Scenario | Size |
|---|---:|---:|
| `15m` buckets (30 files) | 2 880 slots at capacity, four-digit imp/exp/pv | **54 240 B** |
| `15m` buckets (30 files), **battery site** | as above plus four-digit chg/dis (issue #20) | **85 920 B** |

Spec 011 step 3b cut the `15m` set from 82 012 B to 54 240 B: the two-field legacy tail is no
longer written (a line is ≈ 18.8 B instead of ≈ 26.8 B) and the `/e1d` + `/e1mo` seal files
(4 740 B) are gone.

| Item | Size (bytes) | Basis |
|---|---:|---|
| `.tapp` (app + UI shell) | **131 072** (128 KB budget) | measured **58 682 B** today (v0.1.0, CDN build — `lang.json` and the JS bundle are not packed); budgeted 128 KB to absorb future Berry growth. There is no self-host build; the JS/CSS bundle always comes from the CDN |
| `store.be` bucket files | **85 920** | worst case: battery site, all 30 days full (§ above; 54 240 without a battery) |
| `site.json` | **2 708** | largest bundled example (`examples/site-ha.json`) |
| `lang.json` (runtime language file) | **0** (CDN) | always served from GitHub Pages, never packed |
| **Total** | **219 700** | 131 072 + 85 920 + 2 708 |

```
Partition                : 327 680 B  (320 KB)
Persistent footprint     : 219 700 B  (≈ 215 KB)
--------------------------------------------------
Remaining headroom       : 107 980 B  (≈ 105 KB, 33 % free)
```

Using the measured `.tapp` (58 682 B, v0.1.0) instead of the 128 KB growth budget leaves
180 370 B ≈ 176 KB free (212 050 B ≈ 207 KB on a site without a battery). Either way the device stays well inside budget with the ≥ 40 KB margin spec 011
FR-1124 requires.

### `.tapp` size history (NFR-1101)

| Version | Packed sources | `.tapp` | Change |
|---|---:|---:|---|
| v1.0.9 (spec 011 baseline) | — | **94 541 B** | — |
| v1.0.11 (step 2, validation → browser) | 85 247 B | — | −3 391 B |
| v1.0.12 (step 3a, browser archive) | 85 347 B | 88 479 B | — |
| v1.0.13 (step 3b) | 71 704 B | 74 836 B | −13 643 B |
| **v0.1.0 (current; version numbering restarted with this repository)** | **55 297 B** (minified Berry) | **58 682 B** | **−16 154 B** (issue #1 energy-community removal, issue #9, plus `modbustcp`/battery additions) |

With step 3b `store.be` went 15 334 → 5 323 B minified (5 099 B today). Against the v1.0.9 baseline
the `.tapp` is **35 859 B smaller**, past the ≥ 15 KB NFR-1101 requires.

### Notes on the budget

- No bucket file can grow past the sizes above: the `15m` bucket set is capped at
  `KEEP_DAYS = 30` kept days, a build-time constant — raising it means re-running §5 and keeping ≥ 40 KB of the partition free.
- **No migration (issue #4 / spec 011 step 3b / issue #1):** the pre-bucket `/energy.json`, the `/e1d` + `/e1mo` seal files, any stray `.tmp` and the former energy-community files (`/vzev.json`, `.vz_<id>_<dayno>` peer buckets) are removed at boot (`store._remove_obsolete()`) the first time this
  firmware runs — history from before the upgrade lives in the browser archive, not on the device.
- The largest single lever remaining is the `.tapp` itself; the 128 KB budget now reserves
  ~71 KB over the measured build. The follow-ups spec 011 listed as out of scope (e.g.
  de-duplicating the bucket helpers into `fsx.be`) landed with issue #9 (−1.4 KB minified
  Berry); the energy-community removal (issue #1) dropped the community module and its UDP transport.

---

## 5. Reproducing the measurements

From `ems/backend/tests/` with the Berry CLI (`berry -m .. …`):

```berry
import os
import store

def total_size(dir, pat)
    var t = 0
    for n : os.listdir(dir)
        if size(n) >= size(pat) && n[0 .. size(pat) - 1] == pat
            t += size(open(dir + '/' + n, 'r').read())
        end
    end
    return t
end

store.set_prefix('/tmp/msz_')
store.reset()
var T = 1767225600
var i = 0
while i < 30 * 96                        # KEEP_DAYS days at capacity
    store.push_15m(T + i * 900, 1234, 567, 890)
    i += 1
end
print(total_size('/tmp', 'msz_.e15_'))   # -> 54240
```

The battery-site figure pushes `push_15m(T + i * 900, 1234, 567, 890, 2345, 1678)` instead
(-> 85920).

`tests/test_store.be` asserts the bucket-rotation, legacy-line,
boot-cleanup and torn-line-tolerance behaviour this budget depends on.
