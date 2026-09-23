# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
yarn install --immutable  # Install deps (Yarn 4 / PnP; plain `yarn install` may rewrite tracked .pnp.*/yarn.lock)
yarn dev          # Dev server with HMR (proxies /simulator → http://localhost:9090)
yarn dev:local    # Same, exposed on the LAN (vite --host)
yarn build        # Production build to dist/ (base path /simulator/)
yarn preview      # Preview the production build locally
yarn lint         # ESLint (flat config)
yarn deploy       # build + copy dist/ into ../backend/src/main/resources/static/
```

`make sim-ui` at the repo root runs `yarn deploy`. No test runner is configured.

## Architecture

React 19 + Vite 7 single-page application — the **Simulator UI** for the gPlug EMS project.
It is served by the Spring Boot backend (`../backend`) at `http://localhost:9090/simulator/`
and talks to its REST API under `/simulator` (in dev via the Vite proxy in `vite.config.js`).

**Source layout:**
- `src/api.js` — fetch wrappers: `GET /sites`, `GET /sites/{id}/grid`,
  `PUT …/loads/{id}/state` (`{state:"WAITING"}`), `PUT …/productions/{id}/power`,
  `PUT …/grid/{meterId}/power`
- `src/App.jsx` — the whole UI: overview tab (site/active/waiting counts, total production,
  active & waiting loads) plus one tab per site with grid import/export sliders, production
  sliders (battery signed, with SoC), and load cards whose «ACTIVATE» / «ACTIVATE ALL» buttons set inactive loads to `WAITING`;
  polls `/sites` every 3 s; dark/light theme persisted in `localStorage` (`ems-sim-theme`)
- `src/App.css`, `src/index.css` — plain CSS, no UI framework

The UI never sets a load `ACTIVE`: that transition is the EMS device's job.

**Tech stack:**
- React 19 with hooks
- Vite 7 with `@vitejs/plugin-react` (Babel, Fast Refresh)
- Yarn 4 (Berry, PnP) as package manager
- ESLint 9 flat config
