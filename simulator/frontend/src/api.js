const BASE = '/simulator'

export async function fetchSites() {
  const res = await fetch(`${BASE}/sites`)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

export async function activateLoad(siteId, loadId) {
  const res = await fetch(`${BASE}/sites/${siteId}/loads/${loadId}/state`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ state: 'WAITING' }),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

export async function setProductionPower(siteId, productionId, power) {
  const res = await fetch(`${BASE}/sites/${siteId}/productions/${productionId}/power`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ power }),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

export async function fetchGrid(siteId) {
  const res = await fetch(`${BASE}/sites/${siteId}/grid`)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

export async function setGridPower(siteId, gridId, power) {
  const res = await fetch(`${BASE}/sites/${siteId}/grid/${gridId}/power`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ power }),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

export async function fetchModbus() {
  const res = await fetch(`${BASE}/modbus`)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

export async function setModbusValue(unit, table, address, value) {
  const res = await fetch(`${BASE}/modbus/${unit}/${table}/${address}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value }),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}
