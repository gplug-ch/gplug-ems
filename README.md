# gPlug EMS

The **gPlug EMS** is an **Energy Management System** running locally on a [gPlug device](https://gplug.ch/) (ESP32 / Tasmota Berry). It routes the site's surplus PV energy to controllable loads before it is exported to the grid, and records raw 15-minute energy data that the browser UI turns into history and costs.

## System overview

Each **site** (building) runs its own, standalone EMS. A site has:

- A **Smartmeter** — measures grid import/export at the site
- A **gPlug device** running **EMS** firmware — the local controller (ESP32 / Tasmota Berry)
- **Loads** — controllable consumers
- optional **Producers** — energy sources (PV panels, battery)

A **Simulator** (Spring Boot + React) can stand in for loads, PV and the smart meter for testing and demonstration without physical devices.

## Sites and loads

Each site can have a combination of the following loads, managed by priority:

| Load                         | Priority | Description                                                                                    |
| ---------------------------- | -------- | ---------------------------------------------------------------------------------------------- |
| **Boiler**                   | 1        | Heats water below a threshold temperature up to a target value; primarily heated via heat pump |
| **Heat pump**    | 1        | Heats boiler and building; has a minimum runtime                                               |
| **Wallbox**  | 2        | Charges if PV surplus is available; has a minimum runtime                                      |
| **Dryer**          | 3        | Switches on if surplus is available or a configured start time has passed; has a fixed runtime |

## EMS allocation algorithm

The EMS runs a **priority-based threshold algorithm** every second on the device
(`ems/backend/ems.be`):

```
Surplus = sum of currentPower of all non-battery productions (PV)
          (a battery is only observed: discharge never activates a load)

Consider only loads in state waiting or active, sorted by priority (ascending).
For each such load:
  if load is waiting AND Surplus ≥ load.currentPower (its rated power):
    → activate load, reduce Surplus by load.currentPower
  if load is active:
    if Surplus ≥ load.currentPower − 200 W  → keep running
    else if minimum runtime (minimalDuration) not reached → keep running
    else → back to waiting
    (a load kept running still reduces Surplus by its power)

Loads in state inactive are never touched; the user moves a load to waiting.
```

## PV producer

Each site can have zero, one or more PV systems. Surplus power is distributed to the site's loads first; anything remaining is exported to the grid.

## Where computation happens

The gPlug is an ESP32-C3 with a very small Berry heap, so the device does only
what *must* run on hardware. Everything derived — roll-ups and money —
is computed in the browser from raw data the device serves.

**On the device (`ems/backend/`):**

| Computation | Where | Why on device |
| ----------- | ----- | ------------- |
| Load allocation (priority sort, greedy activation, 200 W hysteresis, minimum runtime) | `ems.be` | Drives the relays; must run without a browser |
| Energy integration — samples grid / PV / active loads every 10 s, accumulates `W × dt / 3600` into Wh, seals a record at each 15-min boundary | `meter.be` | Needs continuous sampling |
| Raw record storage — delta encoding, per-day bucket files, retention pruning (30 days) | `store.be` | Local persistence; every write is an append, files are never rewritten |
| Unit conversion of integration readings (kW → W) | `integrations/` | Normalises vendor data at the source |

**In the browser (`ems/frontend/`):**

| Computation | Where |
| ----------- | ----- |
| Day / month roll-ups, energy costs in CHF | `src/lib/aggregate.js` |
| History archive in IndexedDB, incremental sync, gap detection, CSV export/import | `src/lib/archive.js` |
| Smart-meter labelling, grouping and derived values | `src/lib/metercat.js` |
| All `site.json` configuration validation | `src/pages/einstellungen.js` |

The device APIs are correspondingly plain: `GET /api/energy?res=15m` streams raw
Wh records and `GET /api/meter` returns the
Tasmota smart-meter sensor object verbatim. Neither computes a total or a price.

## Repository components

| Component              | Path                  | Description                                                                               |
| ---------------------- | --------------------- | ----------------------------------------------------------------------------------------- |
| **EMS backend**        | `ems/backend/`        | Tasmota Berry scripting backend, packaged as a `.tapp` app running on ESP32 gPlug devices |
| **EMS frontend**       | `ems/frontend/`       | Preact web UI; the `.tapp` ships an `index.html` shell, the bundle is served from a CDN   |
| **Simulator backend**  | `simulator/backend/`  | Spring Boot 4 / Kotlin backend that simulates loads and PV output                         |
| **Simulator frontend** | `simulator/frontend/` | React 19 + Vite UI for controlling the simulator                                          |

See the `CLAUDE.md` files in each component directory for commands and detailed architecture.
