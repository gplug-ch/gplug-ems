# Technology gPlug EMS

The gPlug EMS runs standalone on one gPlug device per site. It distributes the site's PV surplus to its controllable loads; there is no communication between devices.

## Site

- Each site provides a webservice backend and a preact frontend.

### Backend

- runs on a gPlug device
- uses [Tasmota](https://tasmota.github.io/docs/) as firmware
- is a berry script application, based on [berry spec](./BERRY_LANGUAGE_REFERENCE.txt)
- is using [module webserver](https://tasmota.github.io/docs/Berry/#webserver-module) to provide a webservice backend
- the webservice has only HTTP GET support, maturity model level 1, see [Richardson Maturity Model](https://restfulapi.net/richardson-maturity-model/)
  - has a webservice endpoint to set the state of a load (consumer) of the site. Example `GET .../loads?id=dryer-1&action=transition&to=active`
  - supports the following states: `inactive, waiting, active` ; else respond with an error
  - has a webservice endpoint to read the power productions of the site. Example `GET .../productions`
  - item-level reads (`?id=`), `action=state` and `action=set-power` were removed with spec 011 step 1 — no client ever called them
  - serves raw data only: `GET /api/power` (10 s sample ring, last 15 min), `GET /api/energy?res=15m` (raw Wh records), `GET /api/meter` (the Tasmota SMI sensor object verbatim), `GET /api/modbus` (standalone Modbus registers from `site.json` `modbusRegisters`), `GET /api/meta`, `GET /site`
  - the single exception to GET-only is `POST /api/config`, which writes `site.json` and reloads (spec 006)
- has access to consumption (IN: power from the grid) and export (OUT: power to the grid) values over its smartmeter
- is based on the configuration file 'site.json' (the former 'ems.json' is gone — one file per device)
- represents the configured loads as digital twins, polling their state
- computes only what must run on hardware: load allocation, 10 s power sampling / 15-min Wh integration, and raw record storage. Roll-ups and costs are computed in the browser (see [architecture](architecture.md#where-computation-happens))

##### HTTP Requests Examples

```shell
curl 'http://192.168.0.97/loads' | jq
```

```shell
curl 'http://192.168.0.97/loads?id=dryer-1&action=transition&to=waiting' | jq
```

```shell
curl 'http://192.168.0.97/productions' | jq
```

### Frontend

- uses [preact](https://preactjs.com/) with [htm](https://github.com/developit/htm) as javascript single page application — tagged templates instead of JSX
- built with [Vite](https://vite.dev/); no runtime CSS or charting framework: the styling is hand-written CSS and the graphs are hand-rolled SVG (`src/charts.js`)
- the device ships only a small `index.html` shell in the `.tapp`; the hashed JS/CSS bundle and the `lang.json` dictionary are downloaded from a CDN (GitHub Pages, `gplug-ch/gplug-cdn`), versioned by `VERSION.txt`. There is no self-hosted variant: the browser needs internet access to load the UI (see [The web UI is served from a CDN](../README.md#the-web-ui-is-served-from-a-cdn-gplug-cdn))
- visualize one site, represented by its backend
- shows the state of all loads: inactive, waiting, active
- shows for each load its data as a 2d-graph
- derives everything the device does not: day/month roll-ups and CHF costs (`src/lib/aggregate.js`), the smart-meter labelling (`src/lib/metercat.js`), and the local IndexedDB history archive (`src/lib/archive.js`)
- validates the whole `site.json` configuration before POSTing it (`src/pages/einstellungen.js`); the device only checks that the body is a loadable JSON object
  
### Load allocation

The backend controls the power distribution to the loads of its own site:

- implements the following algorithm (every second, `ems.be`):
  
  ```text
  Prioritized threshold algorithm with sequence

  Surplus = sum of currentPower of all non-battery productions (PV);
            a battery is only observed and never counts as surplus
  For each consumer in state waiting or active, in order of priority (ascending):

  If consumer is waiting AND Surplus ≥ its rated power (currentPower), then:
    – Switch consumer on (active)
    – Reduce “Surplus” by its rated power

  If consumer is active, but Surplus drops below its rated power minus a lower threshold (200 W), then:
    – Check whether the minimum runtime (minimalDuration) has been reached
    – If yes → switch consumer back to waiting
    – If no → keep the consumer running until the minimum runtime is reached
  ```

## Simulator

### Backend Simulator

- uses spring boot 4 (kotlin), with springdoc-openapi for the swagger-ui
- provides a REST-API (only GET and PUT) with swagger-ui for its resources
- the resources are read from a configuration file using yaml
- controls each load and pv based on its configuration
- following configuration settings must be supported:
  - priority
  - duration
  - minimal duration
  - id
  - friendly name
  - load type, which can be: dryer, wallbox, heatpump, boiler
- synthesises a Tasmota-SMI smart-meter descriptor at `GET /simulator/sites/{siteId}/meter[?variant=full|basis|minimal]` so a dev device without a physical meter can serve `/api/meter`
- each load has three states: inactive, waiting, active with following state management:
  - from waiting to active with following action: start a timer
  - from active to inactive: if timer stops
  - from inactive to waiting: if PUT request changes the state

### Frontend Simulator

- uses [react](https://react.dev/) 19 to implement a single page application, built with [Vite](https://vite.dev/)
- uses hand-written CSS for the styling (no Bootstrap / reactstrap)
- controls all sites and for each site their loads and if available the pv device
- add for each site a tab
- add an overview to show all active loads of all sites
- add buttons to set the state of a load from inactive to waiting
- polls the REST-API the actualize the state of the loads in the frontend
- adds a slider to control the pv device
- will be served from the backend, from the spring boot application
  