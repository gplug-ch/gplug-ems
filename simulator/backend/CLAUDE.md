# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
./gradlew bootRun        # Run the application
./gradlew build          # Build and run all tests
./gradlew test           # Run tests only
./gradlew bootJar        # Build executable JAR
./gradlew clean          # Clean build output
```

Run a single test class:
```bash
./gradlew test --tests "ch.gplug.simulator.SimulatorApplicationTests"
```

## Architecture

Spring Boot 4 / Kotlin / Java 21 backend that simulates energy loads and photovoltaic systems for the VZEV (Virtual Zero Energy Vehicle) project. It is the backend counterpart of a React frontend and exposes a REST API consumed by both the frontend simulator UI and by EMS (Energy Management System) logic.

**Package root:** `ch.gplug.simulator`

**Spring Modulith modules** (each a package under `ch.gplug.simulator`; public API at the
package root, wiring in `*/internal`; boundaries verified by `ModularityTests`):
- **site** — site registry + `SimulatorAutoConfig` (central `@Bean` wiring) + YAML config (`application.yaml`, prop prefix `simulator.sites`)
- **load** — dryer/wallbox/heat pump/boiler with a `inactive → waiting → active` state machine
- **production** — PV + battery power sources
- **grid** — `GridMeter` import/output power per site
- **meter** — synthesises a realistic Tasmota Smart-Meter-Interface descriptor from the site's
  live grid state for the EMS «Zähler» page (spec 007). `GET /sites/{siteId}/meter[?variant=full|basis|minimal]`
  returns the raw `z`-shaped object; energy registers are integrated on read. `full` = extended
  CIP list, `basis` = 15-element Basisliste (no per-phase power), `minimal` = Pi/Po only.

REST endpoints live under context-path `/simulator`, e.g. `GET /simulator/sites/{id}/meter`.

**Tech stack:**
- Spring Web MVC (servlet-based, not reactive), Spring Modulith
- Jackson + Kotlin module for JSON
- Spring Boot DevTools (hot-reload in dev)
- Docker Compose integration (`compose.yaml`). NOTE: `bootRun` tries to reach the Docker daemon
  at boot; without Docker running, start with `--args='--spring.docker.compose.enabled=false'`.
