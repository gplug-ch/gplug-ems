# gPlug EMS Simulator — UI

Browser UI for the gPlug EMS simulator (React 19 + Vite 7). It shows every simulated site
and lets you drive it by hand while an EMS device pointed at the simulator reacts:

- **Overview** — number of sites, active and waiting loads, total production.
- **One tab per site** — grid import/export sliders, a slider per production (PV; battery
  signed charge/discharge with SoC), and load cards (boiler, heat pump, wallbox, dryer) with
  their state `inactive → waiting → active`. «Activate» (per load or «Activate all») puts an
  inactive load into `waiting`; the EMS decides when it becomes `active`.

The UI polls the simulator backend every 3 s. All calls go to `/simulator/…` on the
Spring Boot backend in `../backend` (port 9090); see `src/api.js`.

## Run

Requires Node and Yarn 4 (Berry, Plug'n'Play — `.pnp.cjs` and `yarn.lock` are committed).
Start the backend first
(`make sim-run` at the repo root), then:

```bash
yarn install --immutable
yarn dev          # http://localhost:5173, proxies /simulator → http://localhost:9090
yarn dev:local    # same, reachable from other devices on the LAN
```

## Build & deploy

```bash
yarn build        # → dist/ (base path /simulator/)
yarn deploy       # build + copy dist/ into ../backend/src/main/resources/static/
```

`make sim-ui` at the repo root does the same as `yarn deploy`. The backend then serves the
UI at `http://localhost:9090/simulator/`.

## Lint

```bash
yarn lint
```
