# gPlug EMS Usage Guide

Reference for configuring the gPlug EMS (`site.json`) and for running the simulator. Installation and everyday use of the EMS are in the [README](README.md).

## Prerequisites

| Requirement | Purpose |
|-------------|---------|
| Docker + Docker Compose | Running the simulator |
| Node.js + Yarn 4 | Building the simulator frontend (dev only) |
| Java 21 | Running the simulator locally without Docker (dev only; Gradle comes via `./gradlew`) |
| Node.js + npm, Python 3 | Building the EMS `.tapp` yourself (dev only — releases ship it prebuilt) |
| Berry CLI | Running the EMS backend tests, `make test` (dev only) |
| gPlug ESP32 (Tasmota) | Production deployment |

---

## Simulator

The simulator runs as a Docker container and provides:
- A **React frontend** for controlling simulated loads and PV output
- A **Swagger UI** as the admin interface for the REST API

### 1. Deploy the simulator frontend

The React UI must be built and copied into the backend before the Docker image is created:

```sh
cd simulator/frontend
yarn install
yarn deploy   # builds and copies dist/ → simulator/backend/src/main/resources/static/
```

(`make sim-ui` at the repo root does the same.)

### 2. Build and start the Docker container

```sh
cd simulator/backend
docker compose up --build
```

### 3. Access the simulator

| Interface | URL |
|-----------|-----|
| React frontend | `http://localhost:9090/simulator/` |
| Swagger UI (admin) | `http://localhost:9090/simulator/swagger-ui.html` |

### 4. Configure the simulator

Edit `simulator/backend/src/main/resources/application.yaml` to define sites, loads, and productions:

```yaml
simulator:
  sites:
    - id: "site-1"
      name: "Site 1"
      grid:
        input:
          id: "in"
          name: "Grid Import"
        output:
          id: "out"
          name: "Grid Export"
      productions:
        - id: "pv-1"
          productionType: PHOTOVOLTAIC
          maxPower: 50000
      loads:
        - id: "heatpump-1"
          friendlyName: "Heat Pump"
          loadType: HEATPUMP
          priority: 1
          duration: 3600
          minimalDuration: 900
```

After changing this file, rebuild the Docker image:

```sh
docker compose up --build
```

---

## EMS on gPlug

### Configure the site

Create a `site.json` for your gPlug device. Start from one of the examples in `ems/backend/examples/`:

| Example | Description |
|---------|-------------|
| `site-1.json` | Simulator grid, PV and battery; simulator loads plus one Shelly relay load |
| `site-2.json`, `site-3.json` | Simulator grid and loads only (no productions) |
| `site-gplug.json` | Native gPlug grid; PV via Home Assistant and a gPlug-attached SMA inverter (SunSpec), gPlug battery; simulator loads |
| `site-ha.json` | Home Assistant grid, PV and battery; simulator loads plus one Shelly load |
| `site-shelly.json` | Same as `site-1.json` (Shelly relay load, simulator for the rest) |
| `site-modbustcp.json` | Modbus TCP PV and battery, standalone `modbusRegisters` (submeters) |
| `site-modbus-all.json` | Every item over Modbus TCP: PV with energy counter, battery with SoC, grid as one signed register, loads switched by a register write or a coil |
| `site-sim-modbus.json` | The simulator's Modbus TCP server (port 5020): PV, battery + SoC, grid and a switched boiler |

Key fields:

```json
{
  "id": "site-1",
  "name": "Site 1",
  "productions": [
    {
      "id": "pv-1",
      "friendlyName": "PV",
      "productionType": "PHOTOVOLTAIC",
      "integration": "simulator",
      "url": "http://<simulator-ip>:9090/simulator/sites/site-1/productions/pv-1"
    }
  ],
  "grid": [
    {
      "id": "from",
      "integration": "simulator",
      "url": "http://<simulator-ip>:9090/simulator/sites/site-1/grid/input"
    },
    {
      "id": "to",
      "integration": "simulator",
      "url": "http://<simulator-ip>:9090/simulator/sites/site-1/grid/output"
    }
  ],
  "loads": [
    {
      "id": "heatpump-1",
      "friendlyName": "Heat Pump",
      "loadType": "HEATPUMP",
      "priority": 1,
      "currentPower": 2000,
      "integration": "simulator",
      "url": "http://<simulator-ip>:9090/simulator/sites/site-1/loads/heatpump-1"
    }
  ]
}
```

**Supported integrations:** `simulator`, `homeassistant`, `shelly` (loads only), `gplug`, `modbustcp`

**Switching a load over Modbus TCP:** give the load a `"write"` block — `{"register": 1100, "dtype": "uint16", "on": 1, "off": 0}` (optional `"inactive"` value for a deselected load, `"function"` 6/16/5). An optional `"state_register"` reads the on/off state back.

**Load types:** `ELECTRICITY`, `HEATPUMP`, `DRYER`, `WALLBOX` (the choices in Einstellungen; the EMS itself does not evaluate `loadType`, and the simulator additionally knows `BOILER`)

**Production types:** `PHOTOVOLTAIC`, `BATTERY`

Installation (getting the `.tapp`, uploading it, first boot) and the
UI pages are described in the [README](README.md#installation).

---

## Network Requirements

- Each gPlug device runs standalone; there is no communication between devices
- The device must reach its configured integrations (Home Assistant, Shelly, Modbus TCP, simulator) over the **LAN**

---

## Quick Reference

| Task | Command / URL |
|------|--------------|
| Deploy simulator frontend | `cd simulator/frontend && yarn deploy` |
| Start simulator (Docker) | `cd simulator/backend && docker compose up --build` |
| Simulator React frontend | `http://localhost:9090/simulator/` |
| Simulator Swagger UI | `http://localhost:9090/simulator/swagger-ui.html` |
| Download EMS `.tapp` | https://github.com/gplug-ch/gplug-ems/releases/latest |
| Build EMS `.tapp` | `make` (repo root) |
| Upload `.tapp` to a device | `make flash DEVICE=<gplug-ip>` |
| Run simulator without Docker | `make sim-run` |
| EMS frontend (on device) | `http://<gplug-ip>/app` |
| Tasmota admin UI | `http://<gplug-ip>/` |
