# Feature Specification: Batterie als beobachteter Speicher

**Feature Branch:** `feat/20-battery-storage` (GitLab issue #20)
**Created:** 2026-09-21
**Status:** Implemented (2026-09-21)
**Depends on:** `001-energy-data-and-storage`, `003-uebersicht-live-monitor`, `004-verlauf-history`,
`006-einstellungen`, `008-energiefluss-kennzahlen`, `010-live-energiefluss-ux`,
`011-browser-archive-backend-slimming`
(read `specs/README.md` for shared constraints C-1…C-7 and the glossary)

## Overview

Before this spec a battery was a passive production item (`productionType: "BATTERY"`, signed
`currentPower`, + = discharging). It was sampled as `bat_w` for the live view only, excluded
from the 15-min energy records, had no state of charge, and the allocation (`ems.be`) summed its
signed power into the available surplus, so a discharging battery could switch on deferrable
loads and a charging battery took surplus away from them.

This spec makes the battery a **storage item that the EMS observes**. The EMS does not control it:
the battery's own inverter logic decides whether it charges or discharges. The EMS
reads the battery's signed power and SoC, keeps it out of the load allocation, and accounts
charge and discharge energy **behind the meter**.

### Decisions (issue #20 open questions)

| Question | Decision |
|---|---|
| Active control or observe? | **Observe only.** No setpoint write path. Active control is a later issue. |
| Allocation | **Loads before battery**: `available` = non-battery productions. Discharge never activates a load; power a battery charges with counts as surplus a load may take (a self-consumption inverter charges from surplus only). |
| First integrations | gplug (SunSpec/Modbus), Home Assistant, Simulator. |

**Reference device:** Home Assistant instance `192.168.0.138:8123` (Loxone battery):
`sensor.speicher_leistung` (kW, signed, + = discharging, observed −8.6…+9.5 kW) and
`sensor.speicher_ladestand` (%, observed 10…100). See `ems/backend/examples/site-ha.json`.

## Functional requirements

- **FR-1201 Config.** A BATTERY production takes these optional keys:
  - `capacity` (Wh), `maxChargePower` and `maxDischargePower` (W). They are used for display and the SoC energy.
  - `invert` (bool): flips the sign of a device that reports charging as positive. It is applied in `site._refresh_item` for every integration.
  - SoC source:
    - gplug: `soc_field` in the same sensor object, with an optional SunSpec scale factor `soc_scale_field`/`soc_scale_base` (e.g. model 124 `ChaState`/`ChaState_SF`).
    - URL integrations (Home Assistant): `soc_url`, a second entity. It is polled as its own round-robin sentinel, so each tick still makes one webclient call.
    - simulator: the fetched `soc` key.
  - A SoC outside 0…100 is dropped.
- **FR-1202 Live.** The item reports `soc` (%) next to `currentPower`. `/productions` streams it without
  endpoint changes.
- **FR-1203 Allocation.** `ems.be` leaves `productionType == "BATTERY"` out of `available`.
- **FR-1204 Energy.** `meter.be` integrates `bat_w` split by sign into charge / discharge Wh. A slot with
  battery samples is sealed as a **7-field line** `delta,imp,exp,pv,chg,dis,` (reserved empty 7th
  field, so the line can't be confused with a legacy 6-field line, whose two-field tail is ignored) and served as `bat_chg_wh`/`bat_dis_wh`. A
  site without a battery writes the 4-field line unchanged. imp/exp/pv are untouched. Append-only.
  The SoC is **not** recorded: with it the worst-case flash headroom fell below the 40 KB rule
  (STORAGE.md §4).
- **FR-1205 HA robustness.** A non-numeric Home Assistant state (`unavailable`, `unknown`) reports no
  value instead of a fake 0.
- **FR-1206 Browser archive.** `archive.js` stores and serves the battery Wh when present. The CSV
  export format is `2` (`e` rows gain two columns), and import accepts `1` and `2`. `aggregate.js` sums the
  battery fields only when present, so a site without a battery aggregates exactly as before.
- **FR-1207 Formulas.** Verbrauch = pv − exp + imp + dis − chg. Autarkiegrad = (Verbrauch − Netzbezug)
  / Verbrauch. Eigenverbrauch = pv − exp (charged PV counts as used). Bilanz «selbst gedeckt» =
  pv − exp − chg + dis. The composition bars use «PV direkt» = pv − exp − chg, so the charge is no longer
  counted twice (live and «Heute»). «Heute» shows the battery segments once the slots carry battery
  Wh. Until then a battery site shows a note.
- **FR-1208 Übersicht.** A battery item shows its direction (Laden / Entladen / Ruhe), `Ladestand n %`,
  the stored energy («x von y», when `capacity` is set) and a SoC bar. The flow diagram's battery node
  shows the SoC (capacity-weighted over several batteries).
- **FR-1209 Verlauf.** When records carry battery Wh, the table and CSV gain «Batterie laden» /
  «Batterie entladen» columns.
- **FR-1210 Einstellungen.** A BATTERY production shows a «Batterie» section with the FR-1201 keys and
  their validation (form and Pro-JSON `validateDocument`). Blank keys and a false `invert` are
  dropped on save, and battery keys are removed from an item that is no longer a battery.
- **FR-1211 Simulator.** A BATTERY production takes `capacityWh`, `maxChargePower` and `initialSoc`:
  - It accepts a signed power `-maxChargePower…maxPower`.
  - It integrates the SoC lazily on read.
  - At 0 % / 100 % it clamps and stops the flow.
  - The UI slider is signed and shows the SoC.

## Out of scope / follow-ups

- Active charge/discharge control (setpoints, SoC reserve, hysteresis).
- Counter-based battery slot energy from HA `sensor.speicher_ladung`/`_entladung` (like PV
  `energy_field`, issue #14). Each counter would cost another poll slot.
- The battery node sliding between the source and sink tier of the flow diagram.
