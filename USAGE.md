# gPlug EMS Usage Guide

This guide covers how to set up, configure, and run the gPlug Energy Management System (EMS) — both the simulator (for testing and demonstration) and the production EMS on physical gPlug devices.

## Prerequisites

| Requirement | Purpose |
|-------------|---------|
| Docker + Docker Compose | Running the simulator |
| Node.js + Yarn | Building the simulator frontend (dev only) |
| Java 21 + Gradle | Running the simulator locally without Docker (dev only) |
| Berry CLI + Python 3 | Building the EMS `.tapp` (dev only) |
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
          productionType: PV
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

### 1. Configure the site

Create a `site.json` for your gPlug device. Start from one of the examples in `ems/backend/examples/`:

| Example | Description |
|---------|-------------|
| `site-1.json` | All devices via simulator integration |
| `site-gplug.json` | Native gPlug grid + Home Assistant PV |
| `site-ha.json` | Home Assistant grid, PV, and Shelly loads |

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

**Supported integrations:** `simulator`, `homeassistant`, `shelly`, `gplug`

**Load types:** `BOILER`, `HEATPUMP`, `WALLBOX`, `DRYER`

**Production types:** `PHOTOVOLTAIC`, `BATTERY`

### 2. Build the `.tapp`

```sh
cd ems/backend
make   # produces build/ems-v<VERSION>.tapp
```

### 3. Deploy to the gPlug device

1. Open the Tasmota web UI at `http://<gplug-ip>/`
2. Go to **Firmware Upgrade** and upload `build/ems-v<VERSION>.tapp`
3. After the upload completes, upload your `site.json` via the Tasmota filesystem manager
4. Restart the device

### 4. Access the EMS frontend

Once the device is running, the Preact UI is available at:

```
http://<gplug-ip>/app
```

This dashboard shows all loads and productions, their current states, and allows manual state transitions.

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
| Build EMS `.tapp` | `cd ems/backend && make` |
| EMS frontend (on device) | `http://<gplug-ip>/app` |
| Tasmota admin UI | `http://<gplug-ip>/` |
