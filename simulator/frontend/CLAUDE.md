# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
yarn dev          # Start development server with HMR
yarn build        # Build for production (outputs to dist/)
yarn preview      # Preview production build locally
yarn lint         # Run ESLint
```

No test runner is configured yet.

## Architecture

React 19 + Vite 7 single-page application that serves as the **Frontend Simulator** for the gPlug EMS project. It is served by the Spring Boot backend (`../backend`) and polls its REST API to display and control energy loads.

**Planned features (from design docs):**
- Multi-site tabs — one tab per site, plus an overview of all active loads across sites
- Per-site load cards — dryer, wallbox, heat pump, boiler; each with state: `inactive` → `waiting` → `active`; buttons to transition a load from inactive to waiting
- PV device slider — adjust simulated photovoltaic output per site
- Polls the REST API periodically to refresh load states

**Planned dependencies (not yet installed):**
- [Bootstrap](https://getbootstrap.com/) — styling
- [Reactstrap](https://reactstrap.github.io/) — Bootstrap components for React

**Current state:** Early scaffold — default Vite+React template only; no application logic, routing, or API calls yet.

**Tech stack:**
- React 19 with hooks
- Vite 7 with `@vitejs/plugin-react` (Babel, Fast Refresh)
- Yarn Berry (PnP) as package manager
- ESLint 9 flat config
