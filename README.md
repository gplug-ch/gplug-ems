# gPlug EMS

The **gPlug EMS** is an **Energy Management System** that runs locally on a
[gPlug device](https://gplug.ch/) (ESP32 with Tasmota). It routes your PV
surplus to controllable loads — heat pump, wallbox, dryer, boiler — by priority
before it is exported to the grid, and records 15-minute energy data that the
web UI turns into history and costs (CHF). Each device manages one site on its
own; no cloud service or server is involved.

## Installation

### Prerequisites

- A gPlug (ESP32-C3) running Tasmota with Berry and the filesystem enabled
- The gPlug on your LAN, able to reach the devices it reads or switches
  (Home Assistant, Shelly relays, Modbus TCP inverters, …)
- A browser **with internet access**: the device serves only a small page shell,
  the UI itself (JS/CSS and translations) loads from a CDN

### 1. Get the `.tapp`

Download **one** file from the
[latest GitHub Release](https://github.com/jluthiger/gplug-ems/releases/latest):
`ems-v<VERSION>.tapp` (German UI) or `ems-v<VERSION>-en.tapp` (English UI).

Or build it from a checkout (Node.js + npm, Python 3, `make`, `zip`):
`make` at the repo root → `build/ems-v<VERSION>.tapp` (`make LANG=en` for English).

### 2. Upload it to the gPlug

```sh
make flash DEVICE=<gplug-ip>                          # built from this checkout
ems/backend/deploy.sh <gplug-ip> ems-v<VERSION>.tapp  # a downloaded release
```

Or by hand in the Tasmota web UI (`http://<gplug-ip>/`) under
**Tools → Manage File system**:

1. **Delete every existing `ems-*.tapp`** — Tasmota starts every `.tapp` in the
   filesystem root, and two EMS versions side by side send the gPlug into a
   reboot loop.
2. Upload the new `.tapp`.
3. Restart the device. An existing `site.json` is kept.

### 3. Configure the site

The EMS reads everything from one file, `site.json`: site name, loads,
productions (PV, battery), grid meter, tariffs. Start from the example closest to
your setup in [`ems/backend/examples/`](ems/backend/examples/) (simulator, gPlug
meter, Home Assistant, Shelly, Modbus TCP), adapt IDs, URLs and powers, and upload
it through the same Tasmota file manager. After that, edit it in the EMS UI under
**Einstellungen**. The field reference is in [USAGE.md](USAGE.md#configure-the-site).

## Usage

Open the EMS at

```
http://<gplug-ip>/app
```

| Page | What it shows |
|------|---------------|
| **Übersicht** | Live power flow of grid, productions and loads; move a load between `inactive`, `waiting` and `active` |
| **Verlauf** | Energy and cost history from 15 minutes up to quarters, CSV export |
| **Zähler** | Smart-meter readings (only when the device has meter data) |
| **Modbus** | Standalone Modbus registers, e.g. submeters (only when configured) |
| **Einstellungen** | Site, loads, productions, grid, Modbus, tariffs, data, gPlug and pro settings |

**Loads.** A load the EMS may switch must be in state `waiting`. Whenever the PV
surplus covers its power, the EMS activates it, highest priority (lowest number)
first, and returns it to `waiting` once the surplus is gone and its minimum
runtime has passed. `inactive` loads are left alone. Only `shelly` and
`simulator` loads can actually be switched.

**Integrations.** Each load, production and the grid names where its values come
from: `gplug` (the gPlug's own smart-meter or attached-inverter data),
`homeassistant`, `shelly`, `modbustcp` or `simulator`. Configure them per item in
**Einstellungen**; see [USAGE.md](USAGE.md) for the fields.

**Data.** The gPlug keeps the last 30 days of 15-minute records. The browser
copies them into its own archive on every visit, so history older than that lives
in the browser. **Einstellungen → Daten** shows the covered period and gaps and
exports or imports the archive as CSV — export regularly, or always use the same
browser.

## Further reading

| Document | Content |
|----------|---------|
| [USAGE.md](USAGE.md) | `site.json` reference, running the simulator |
| [docs/architecture.md](docs/architecture.md) | System overview, allocation algorithm, device vs. browser computation, repository layout |
| [docs/features.md](docs/features.md) | Feature-level spec of backend and frontend |
| [ems/README.md](ems/README.md) | Developer guide: build, test, flash, frontend dev server, CDN release |
| [simulator/](simulator/) | Spring Boot + React simulator for loads, PV and smart meter |
