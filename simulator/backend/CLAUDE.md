# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

From the repo root: `make sim-run` (= `./gradlew bootRun`) and `make sim-test` (= `./gradlew test`).
In this directory:

```bash
./gradlew bootRun        # Run the application (http://localhost:9090/simulator)
./gradlew build          # Build and run all tests
./gradlew test           # Run tests only
./gradlew bootJar        # Build executable JAR
./gradlew clean          # Clean build output
```

Run a single test class:
```bash
./gradlew test --tests "ch.gplug.simulator.production.ProductionServiceTest"
```

Tests: `SimulatorApplicationTests` (context, Modbus on port 0), `ModularityTests` (Spring Modulith boundaries),
`production/ProductionServiceTest` (battery SoC model), `modbus/*Test` (codec, FC 3/4/6/16 +
exceptions, bindings, MBAP over a real socket).

## Architecture

Spring Boot 4.0 / Kotlin 2.2 / Java 21 backend (Gradle 9 wrapper) that simulates sites with
loads, productions (PV, battery) and a grid meter for the gPlug EMS project. It serves the
simulator UI (`../frontend`, deployed as static files into `src/main/resources/static/`) and
exposes a REST API that an EMS device's `simulator` integration polls.

**Package root:** `ch.gplug.simulator`

**Spring Modulith modules** (each a package under `ch.gplug.simulator`; public API at the
package root, controllers/wiring in `*/internal`; boundaries verified by `ModularityTests`):
- **site** — site registry + `SimulatorAutoConfig` (central `@Bean` wiring) + YAML config (`application.yaml`, prop prefix `simulator.sites`)
- **load** — dryer/wallbox/heat pump/boiler with an `inactive → waiting → active` state machine;
  an active load falls back to `inactive` after its configured `duration`
- **production** — PV + battery power sources; a battery takes signed power (+ discharge,
  − charge) and integrates its SoC on read (`capacityWh`, `initialSoc`, clamped at 0/100 %)
- **grid** — `GridMeter` import/output power per site (set manually via the API/UI)
- **meter** — synthesises a realistic Tasmota Smart-Meter-Interface descriptor from the site's
  live grid state for the EMS «Zähler» page (spec 007). Returns the raw `z`-shaped object;
  energy registers are integrated on read. `full` (default) = extended CIP list,
  `basis` = 15-element Basisliste (no per-phase power), `minimal` = Pi/Po only.
- **modbus** — Modbus TCP slave (issue #16) for the EMS `modbustcp` integration, see below.

**Modbus TCP server** (`modbus/`, hand-rolled MBAP/PDU on a plain `ServerSocket`, one virtual
thread per connection, started as a `SmartLifecycle`). Config under `simulator.modbus` in
`application.yaml`: `enabled`, `port` (default 5020 — 502 needs root), `slaves[]` of
`{unit, registers[]}`. Each register:

| Key | Meaning |
|-----|---------|
| `address` | Wire address, no 40001 offset; 32-bit types occupy `address` and `address+1` |
| `table` | `holding` (FC 3, writable via FC 6/16) or `input` (FC 4, read-only over Modbus) |
| `dtype` | `int16`, `uint16`, `int32`, `uint32`, `float32` (big-endian ABCD) |
| `swapWords` | CDAB word order for 32-bit types |
| `scale` | Raw register = value / scale (the EMS decodes raw × `scale`); ints rounded + clamped |
| `source` | Live value `<siteId>/<itemId>/<field>`: production `currentPower`\|`soc`, grid `input`\|`output` (or meter id) `currentPower`, load `state` (0 INACTIVE, 1 WAITING, 2 ACTIVE). Without it the register is static |
| `value` | Static initial value |
| `action` | Simulator action run on write: production/grid `currentPower`, load `state` |
| `name` | Label for the UI |

Bound registers without `action` are read-only. Exceptions: 01 unsupported function, 02
unmapped address or write to a read-only register (the whole write is rejected), 03 bad
quantity/length or a value the action rejects, 0B unknown unit id. Try it:
`mbpoll -m tcp -p 5020 -a 1 -0 -1 -t 3:float -B -r 106 localhost` (`-t 3` = input, `-t 4` =
holding, `-0` = wire addresses; append a value to write). EMS example:
`ems/backend/examples/site-sim-modbus.json`.

**REST endpoints** (context-path `/simulator`, port 9090 — see `application.yaml`):

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/sites`, `/sites/{siteId}` | Sites incl. loads, productions, grid |
| GET | `/sites/{siteId}/loads[/{loadId}]` | Loads |
| PUT | `/sites/{siteId}/loads/{loadId}/state` | Body `{"state":"WAITING"\|"ACTIVE"\|"INACTIVE"}` |
| GET | `/sites/{siteId}/productions[/{productionId}]` | Productions |
| PUT | `/sites/{siteId}/productions/{productionId}/power` | Body `{"power":<W>}` |
| GET | `/sites/{siteId}/grid[/input\|/output]` | Grid meters |
| PUT | `/sites/{siteId}/grid/{meterId}/power` | Body `{"power":<W>}` (≥ 0) |
| GET | `/sites/{siteId}/meter[?variant=full\|basis\|minimal]` | Synthetic smart-meter descriptor |
| GET | `/modbus` | Modbus server status + registers (config, raw `words`, decoded `value`, `settable`, `writable`) |
| PUT | `/modbus/{unit}/{holding\|input}/{address}` | Body `{"value":<n>}` — set a static register or run its `action` (400 if bound read-only) |

OpenAPI UI: `http://localhost:9090/simulator/swagger-ui.html` (springdoc).

**Tech stack:**
- Spring Web MVC (servlet-based, not reactive), Spring Modulith, Bean Validation
- Jackson 3 (`tools.jackson`) + Kotlin module for JSON
- springdoc-openapi (Swagger UI)
- Spring Boot DevTools (hot-reload in dev)
- Docker: `Dockerfile` + `compose.yaml` (service `simulator`, port 9090). The Docker Compose
  integration is on the dev classpath with `lifecycle-management: none`; if `bootRun` fails
  because no Docker daemon is reachable, start with `--args='--spring.docker.compose.enabled=false'`.
