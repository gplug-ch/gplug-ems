import { useState, useEffect, useCallback } from 'react'
import './App.css'
import { fetchSites, activateLoad, setProductionPower, fetchGrid, setGridPower } from './api.js'

const LOAD_TYPE_INFO = {
  DRYER:    { label: 'Dryer',      symbol: '⟳' },
  WALLBOX:  { label: 'EV Charger', symbol: '⚡' },
  HEATPUMP: { label: 'Heat Pump',  symbol: '≋' },
  BOILER:   { label: 'Boiler',     symbol: '◈' },
}

const PRODUCTION_TYPE_INFO = {
  PHOTOVOLTAIC: { label: 'PV Output',      icon: '☀' },
  BATTERY:      { label: 'Battery', icon: '⚟' },
}

function formatDuration(ms) {
  const mins = Math.round(ms / 60000)
  if (mins < 60) return `${mins}m`
  return `${Math.floor(mins / 60)}h ${mins % 60}m`
}

function StateBadge({ state }) {
  return (
    <span className={`state-badge state-badge--${state.toLowerCase()}`}>
      {state}
    </span>
  )
}

function LoadCard({ load, siteId, onActivate }) {
  const [pending, setPending] = useState(false)
  const info = LOAD_TYPE_INFO[load.loadType] ?? { label: load.loadType, symbol: '◉' }

  const handleActivate = async () => {
    setPending(true)
    try {
      await onActivate(siteId, load.id)
    } finally {
      setPending(false)
    }
  }

  return (
    <div className={`load-card load-card--${load.state.toLowerCase()}`}>
      <div className="load-card__header">
        <span className="load-card__symbol">{info.symbol}</span>
        <span className="load-card__type">{info.label}</span>
        <StateBadge state={load.state} />
      </div>
      <div className="load-card__name">{load.friendlyName}</div>
      <div className="load-card__meta">
        <span>dur: {formatDuration(load.duration)}</span>
        <span>min: {formatDuration(load.minimalDuration)}</span>
        <span>p{load.priority}</span>
      </div>
      {load.state === 'INACTIVE' && (
        <button
          className="load-card__activate"
          onClick={handleActivate}
          disabled={pending}
        >
          {pending ? 'ACTIVATING…' : 'ACTIVATE'}
        </button>
      )}
    </div>
  )
}

function ProductionControl({ production, siteId, onSetPower }) {
  const [value, setValue] = useState(production.currentPower)
  const [pending, setPending] = useState(false)
  const typeInfo = PRODUCTION_TYPE_INFO[production.productionType] ?? { label: production.productionType, icon: '◉' }

  useEffect(() => { setValue(production.currentPower) }, [production.currentPower])

  // a battery's power is signed (issue #20): + discharging, − charging
  const isBattery = production.productionType === 'BATTERY'
  const minPower = isBattery ? -(production.maxChargePower ?? production.maxPower) : 0
  const pct = production.maxPower > 0 ? Math.round((value / production.maxPower) * 100) : 0
  const direction = value > 0 ? 'discharging' : value < 0 ? 'charging' : 'idle'

  const handleSet = async () => {
    setPending(true)
    try {
      await onSetPower(siteId, production.id, value)
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="pv-control">
      <div className="pv-control__header">
        <span className="pv-control__icon">{typeInfo.icon}</span>
        <span className="pv-control__label">{typeInfo.label}</span>
        <span className="pv-control__value">
          {value} <span className="pv-control__unit">W</span>
        </span>
        {isBattery
          ? <span className="pv-control__pct">{production.soc != null ? `SoC ${Math.round(production.soc)}%` : direction}</span>
          : <span className="pv-control__pct">{pct}%</span>}
      </div>
      <div className="pv-control__slider-row">
        <input
          type="range"
          className="pv-control__slider"
          min={minPower}
          max={production.maxPower}
          value={value}
          onChange={e => setValue(Number(e.target.value))}
        />
        <button
          className="pv-control__set"
          onClick={handleSet}
          disabled={pending || value === production.currentPower}
        >
          {pending ? '…' : 'SET'}
        </button>
      </div>
      <div className="pv-control__max">
        {isBattery
          ? `${direction} · charge ≤ ${-minPower} W · discharge ≤ ${production.maxPower} W${production.capacityWh ? ` · ${production.capacityWh} Wh` : ''}`
          : `max ${production.maxPower} W`}
      </div>
    </div>
  )
}

const GRID_MAX_POWER = 10000

function GridControl({ grid, siteId, onSetPower }) {
  const [inputValue,  setInputValue]  = useState(grid.input.currentPower)
  const [outputValue, setOutputValue] = useState(grid.output.currentPower)
  const [pending, setPending] = useState(null)

  useEffect(() => { setInputValue(grid.input.currentPower)   }, [grid.input.currentPower])
  useEffect(() => { setOutputValue(grid.output.currentPower) }, [grid.output.currentPower])

  const handleSet = async (id, value) => {
    setPending(id)
    try {
      await onSetPower(siteId, id, value)
    } finally {
      setPending(null)
    }
  }

  return (
    <div className="pv-control pv-control--grid">
      <div className="pv-control__header">
        <span className="pv-control__label">{grid.input.name}</span>
        <span className="pv-control__value">{inputValue} <span className="pv-control__unit">W</span></span>
      </div>
      <div className="pv-control__slider-row">
        <input
          type="range"
          className="pv-control__slider"
          min={0}
          max={GRID_MAX_POWER}
          value={inputValue}
          onChange={e => setInputValue(Number(e.target.value))}
        />
        <button
          className="pv-control__set"
          onClick={() => handleSet(grid.input.id, inputValue)}
          disabled={pending !== null || inputValue === grid.input.currentPower}
        >
          {pending === grid.input.id ? '…' : 'SET'}
        </button>
      </div>

      <div className="pv-control__header" style={{ marginTop: '0.75rem' }}>
        <span className="pv-control__label">{grid.output.name}</span>
        <span className="pv-control__value">{outputValue} <span className="pv-control__unit">W</span></span>
      </div>
      <div className="pv-control__slider-row">
        <input
          type="range"
          className="pv-control__slider"
          min={0}
          max={GRID_MAX_POWER}
          value={outputValue}
          onChange={e => setOutputValue(Number(e.target.value))}
        />
        <button
          className="pv-control__set"
          onClick={() => handleSet(grid.output.id, outputValue)}
          disabled={pending !== null || outputValue === grid.output.currentPower}
        >
          {pending === grid.output.id ? '…' : 'SET'}
        </button>
      </div>
      <div className="pv-control__max">max {GRID_MAX_POWER} W</div>
    </div>
  )
}

function SitePanel({ site, grid, onActivate, onSetPower, onSetGridPower }) {
  const [pendingAll, setPendingAll] = useState(false)
  const inactiveLoads = site.loads.filter(l => l.state === 'INACTIVE')

  const handleActivateAll = async () => {
    setPendingAll(true)
    try {
      await Promise.all(inactiveLoads.map(l => onActivate(site.id, l.id)))
    } finally {
      setPendingAll(false)
    }
  }

  return (
    <div className="site-panel">
      {grid && (
        <div>
          <div className="loads-section-header">
            <div className="loads-section-title">Grid</div>
          </div>
          <GridControl grid={grid} siteId={site.id} onSetPower={onSetGridPower} />
        </div>
      )}
      {site.productions?.length > 0 && (
        <div>
          <div className="loads-section-header">
            <div className="loads-section-title">Productions</div>
          </div>
          {site.productions.map(production => (
            <ProductionControl key={production.id} production={production} siteId={site.id} onSetPower={onSetPower} />
          ))}
        </div>
      )}
      <div>
        <div className="loads-section-header">
          <div className="loads-section-title">Loads</div>
          {inactiveLoads.length > 0 && (
            <button
              className="activate-all-btn"
              onClick={handleActivateAll}
              disabled={pendingAll}
            >
              {pendingAll ? 'ACTIVATING…' : `ACTIVATE ALL (${inactiveLoads.length})`}
            </button>
          )}
        </div>
        <div className="loads-grid">
          {site.loads.map(load => (
            <LoadCard
              key={load.id}
              load={load}
              siteId={site.id}
              onActivate={onActivate}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

function Overview({ sites }) {
  const allLoads = sites.flatMap(site =>
    site.loads.map(load => ({ ...load, siteName: site.name }))
  )
  const activeCount  = allLoads.filter(l => l.state === 'ACTIVE').length
  const waitingCount = allLoads.filter(l => l.state === 'WAITING').length
  const totalSolar   = sites.reduce((sum, s) => sum + (s.productions?.reduce((a, p) => a + p.currentPower, 0) ?? 0), 0)
  const highlighted  = allLoads.filter(l => l.state !== 'INACTIVE')

  return (
    <div className="overview">
      <div className="overview__summary">
        <div className="overview__stat">
          <span className="overview__stat-value">{sites.length}</span>
          <span className="overview__stat-label">Sites</span>
        </div>
        <div className="overview__stat">
          <span className="overview__stat-value">{activeCount}</span>
          <span className="overview__stat-label">Active Loads</span>
        </div>
        <div className="overview__stat">
          <span className="overview__stat-value">{waitingCount}</span>
          <span className="overview__stat-label">Waiting</span>
        </div>
        <div className="overview__stat">
          <span className="overview__stat-value">{totalSolar}</span>
          <span className="overview__stat-label">W Production</span>
        </div>
      </div>

      <div className="overview__section-title">Active &amp; Waiting Loads</div>

      {highlighted.length === 0 ? (
        <div className="overview__empty">— all loads inactive —</div>
      ) : (
        <div className="overview__loads">
          {highlighted.map(load => {
            const info = LOAD_TYPE_INFO[load.loadType] ?? { label: load.loadType, symbol: '◉' }
            return (
              <div
                key={load.id}
                className={`overview__load state--${load.state.toLowerCase()}`}
              >
                <span className="overview__load-symbol">{info.symbol}</span>
                <div className="overview__load-info">
                  <div className="overview__load-name">{load.friendlyName}</div>
                  <div className="overview__load-site">{load.siteName}</div>
                </div>
                <StateBadge state={load.state} />
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

export default function App() {
  const [sites, setSites]         = useState([])
  const [grids, setGrids]         = useState({})
  const [activeTab, setActiveTab] = useState('overview')
  const [error, setError]         = useState(null)
  const [lastUpdate, setLastUpdate] = useState(null)
  const [theme, setTheme] = useState(() => localStorage.getItem('ems-sim-theme') ?? 'dark')

  const toggleTheme = () => {
    setTheme(t => {
      const next = t === 'dark' ? 'light' : 'dark'
      localStorage.setItem('ems-sim-theme', next)
      return next
    })
  }

  const poll = useCallback(async () => {
    try {
      const data = await fetchSites()
      setSites(data)
      const gridEntries = await Promise.all(
        data.map(async site => {
          try {
            const g = await fetchGrid(site.id)
            return [site.id, g]
          } catch {
            return [site.id, null]
          }
        })
      )
      setGrids(Object.fromEntries(gridEntries.filter(([, g]) => g !== null)))
      setLastUpdate(new Date())
      setError(null)
    } catch (e) {
      setError(e.message)
    }
  }, [])

  useEffect(() => {
    poll()
    const id = setInterval(poll, 3000)
    return () => clearInterval(id)
  }, [poll])

  const handleActivate = useCallback(async (siteId, loadId) => {
    await activateLoad(siteId, loadId)
    await poll()
  }, [poll])

  const handleSetPower = useCallback(async (siteId, productionId, power) => {
    await setProductionPower(siteId, productionId, power)
    await poll()
  }, [poll])

  const handleSetGridPower = useCallback(async (siteId, gridId, power) => {
    await setGridPower(siteId, gridId, power)
    await poll()
  }, [poll])

  const activeSite = sites.find(s => s.id === activeTab)

  return (
    <div className="app" data-theme={theme}>
      <header className="app-header">
        <div className="app-header__brand">
          <span className="app-header__logo">◈</span>
          <span className="app-header__title">GPLUG EMS SIMULATOR</span>
        </div>
        <div className="app-header__status">
          {error
            ? <span className="status-error">⚠ {error}</span>
            : <span className="status-ok">
                {lastUpdate ? `synced ${lastUpdate.toLocaleTimeString()}` : 'connecting…'}
              </span>
          }
          <button className="theme-toggle" onClick={toggleTheme} title="Toggle theme">
            {theme === 'dark' ? '☀' : '☾'}
          </button>
        </div>
      </header>

      <nav className="tabs">
        <button
          className={`tab ${activeTab === 'overview' ? 'tab--active' : ''}`}
          onClick={() => setActiveTab('overview')}
        >
          OVERVIEW
        </button>
        {sites.map(site => (
          <button
            key={site.id}
            className={`tab ${activeTab === site.id ? 'tab--active' : ''}`}
            onClick={() => setActiveTab(site.id)}
          >
            {site.name.toUpperCase()}
          </button>
        ))}
      </nav>

      <main className="app-main">
        {activeTab === 'overview' ? (
          <Overview sites={sites} />
        ) : activeSite ? (
          <SitePanel
            site={activeSite}
            grid={grids[activeSite.id] ?? null}
            onActivate={handleActivate}
            onSetPower={handleSetPower}
            onSetGridPower={handleSetGridPower}
          />
        ) : null}
      </main>
    </div>
  )
}
