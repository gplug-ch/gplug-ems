# Technology vZEV

The vZEV consists of multiple sites. One site is the master site with role EMS and it controls the power distribution within the vZEV.

## Site

- Each site provides a webservice backend and a preact frontend.
- A site is always acting in role SITE, but can also have a role of EMS

### Role SITE

#### Backend SITE

- runs on a gPlug device
- uses [Tasmota](https://tasmota.github.io/docs/) as firmware
- is a berry script application, based on [berry spec](./BERRY_LANGUAGE_REFERENCE.txt)
- is using [module webserver](https://tasmota.github.io/docs/Berry/#webserver-module) to provide a webservice backend
- the webservice has only HTTP GET support, maturity model level 1, see [Richardson Maturity Model](https://restfulapi.net/richardson-maturity-model/)
  - has a webservice endpoint to set the state of a load (consumer) of the site. Example `GET .../loads?id=dryer-1&action=transition&to=active`
  - supports the following states: `inactive, waiting, active` ; else respond with an error
  - has a webservice endpoint to read the power productions of the site. Example `GET .../productions`
  - item-level reads (`?id=`), `action=read-state` and `action=set-power` were removed with spec 011 step 1 — no client ever called them
  - serves raw data only: `GET /api/power` (10 s sample ring), `GET /api/energy?res=15m` (raw Wh records), `GET /api/meter` (the Tasmota SMI sensor object verbatim), `GET /api/meta`, `GET /site`
  - the single exception to GET-only is `POST /api/config`, which writes `site.json` and reloads (spec 006)
- has access to consumption (IN: power from the grid) and export (OUT: power to the grid) values over its smartmeter
- is based on the configuration file 'site.json' (the former 'ems.json' is gone — one file per device); the vZEV member registry lives in '/vzev.json'
- represents the configured loads as digital twins, polling their state
- computes only what must run on hardware: load allocation, 10 s power sampling / 15-min Wh integration, and raw record storage. Roll-ups, costs, vZEV allocation and billing are computed in the browser (see [README](../README.md#where-computation-happens))

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

#### Frontend SITE

- uses [preact](https://preactjs.com/) with [htm](https://github.com/developit/htm) as javascript single page application — tagged templates instead of JSX
- built with [Vite](https://vite.dev/); no runtime CSS or charting framework: the styling is hand-written CSS and the graphs are hand-rolled SVG (`src/charts.js`)
- the device ships only a small `index.html` shell in the `.tapp`; the hashed JS/CSS bundle and the `lang.json` dictionary are downloaded from a CDN (GitHub Pages, `gplug-ch/gplug-cdn`), versioned by `VERSION.txt`. `make ASSET_BASE=self` packs them back into the `.tapp` for offline networks
- visualize one site, represented by its backend
- shows the state of all loads: inactive, waiting, active
- shows for each load its data as a 2d-graph
- derives everything the device does not: day/month roll-ups and CHF costs (`src/lib/aggregate.js`), the vZEV allocation, flows and quarterly billing (`src/lib/vzev.js`), the smart-meter labelling (`src/lib/metercat.js`), and the local IndexedDB history archive (`src/lib/archive.js`)
- validates the whole `site.json` configuration before POSTing it (`src/pages/einstellungen.js`); the device only checks that the body is a loadable JSON object
  
### Role EMS

The EMS controls the power distribution within the vZEV. The vZEV runs on a site, which is the master site, and slave sites, which joins the vZEV using an advertize udp multicast message.

#### Backend EMS

- runs on a gPlug device
- uses [Tasmota](https://tasmota.github.io/docs/) as firmware
- is a berry script application, based on [berry spec](./BERRY_LANGUAGE_REFERENCE.txt)
- is using [module webserver](https://tasmota.github.io/docs/Berry/#webserver-module) to provide a webservice backend
- the webservice has only HTTP GET support, maturity model level 1, see [Richardson Maturity Model](https://restfulapi.net/richardson-maturity-model/)
  - adds the vZEV endpoints `GET /api/vzev/members`, `/discovered`, `/info` and `/raw`
  - `/api/vzev/raw` returns the producer id, the community tariffs and every member's raw `ts,imp,exp` triples; the per-slot allocation and the billing are computed by the browser (the former `/api/vzev/flows` and `/api/vzev/billing` were removed with spec 011 step 3b)
- has access to consumption (IN: power from the grid) and export (OUT: power to the grid) values over its smartmeter
- is based on the configuration file 'site.json' plus the member registry '/vzev.json'
- uses [UDP](https://tasmota.github.io/docs/Berry/#udp-class) multicast (default `239.3.0.1:5007`) to:
  - advertise the URL of its backend webservice on startup (a bare `http://...` string)
  - exchange three JSON payloads inside the existing `{from,timestamp,msg}` envelope:
    - `ann` — periodic member announcement (id, name, location, type, url; the producer also carries the community `tar` tariffs so every site prices identically)
    - `slot` — the just-sealed 15-min slot of the sending site (id, ts, imp, exp; nothing else leaves the device — FR-509)
    - `req` — retransmission request for a missing slot range, optionally addressed at one peer
- does listen for these messages using udp multicast, see [UDP](https://tasmota.github.io/docs/Berry/#udp-class)
- a vZEV member is typed `PRODUCER` (exactly one, the PV site) or `CONSUMER`
- implements the following algorithm (every second, `ems.be`):
  
  ```text
  Prioritized threshold algorithm with sequence

  Surplus = PV_Power − Household_Consumption
  For each consumer in order of priority:

  If consumer is not active AND Surplus ≥ Consumer_Minimum_Power AND Consumer.State is not blocked, then:
    – Switch consumer on
    – Reduce “Surplus” by the target charging power

  If consumer is running, but Surplus drops below a lower threshold (e.g. 200 W), then:
    – Check whether the minimum runtime has been reached
    – If yes → switch consumer off
    – If no → keep the consumer running until the minimum runtime is reached
  ```

#### Frontend EMS

- same stack and delivery as the SITE frontend above (Preact + htm, Vite, hand-written CSS, hand-rolled SVG charts, CDN-served bundle)
- polls the backend to read the state of the loads
- visualize one site with an ems, represented by its backend
- shows the state of all its loads: inactive, waiting, active
- shows for each load its data as a 2d-graph

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
  