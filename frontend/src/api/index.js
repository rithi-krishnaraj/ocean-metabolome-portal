const BASE = '/api'
const TOKEN_KEY = 'adminToken'

// Admin token from /admin/login, kept for this browser tab only.
export const getAdminToken = () => {
  try { return sessionStorage.getItem(TOKEN_KEY) } catch { return null }
}
export const clearAdminToken = () => {
  try { sessionStorage.removeItem(TOKEN_KEY) } catch { /* storage unavailable */ }
}
const setAdminToken = (token) => {
  try { sessionStorage.setItem(TOKEN_KEY, token) } catch { /* storage unavailable */ }
}

async function req(method, path, body) {
  const opts = { method, headers: {} }
  if (body instanceof FormData) {
    opts.body = body
  } else if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json'
    opts.body = JSON.stringify(body)
  }
  const token = getAdminToken()
  if (token) opts.headers.Authorization = `Bearer ${token}`

  const res = await fetch(BASE + path, opts)
  const data = await res.json().catch(() => ({}))
  if (res.status === 401 && token) {
    // Token expired or the server restarted: drop it so the admin page asks to log in again.
    clearAdminToken()
    window.dispatchEvent(new Event('admin-unauthorized'))
  }
  if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`)
  return data
}

// Admin auth
export const adminLogin = async (password) => {
  const data = await req('POST', '/admin/login', { password })
  setAdminToken(data.token)
  return data
}

// Upload (admin)
export const uploadManual = (formData) => req('POST', '/upload/manual', formData)
export const uploadGnps = (task_id, workflow) => req('POST', '/upload/gnps', { task_id, workflow })

// Dataset management
export const saveDataset = (body) => req('POST', '/dataset/save', body)
export const listDatasets = () => req('GET', '/datasets')
export const deleteDataset = (safeName) => req('DELETE', `/datasets/${safeName}`)
export const getDatasetSettings = (safeName) => req('GET', `/datasets/${safeName}/settings`)
export const updateDataset = (safeName, changes) => req('PATCH', `/datasets/${safeName}`, changes)

// Map
export const getMapData = () => req('GET', '/map/data')
export const getMapSampleDetails = (datasetSafe, lat, lon, sampleId) => {
  const params = new URLSearchParams({
    dataset_safe: String(datasetSafe),
    lat: String(lat),
    lon: String(lon),
  })
  if (sampleId) params.set('sample_id', String(sampleId))
  return req('GET', `/map/sample-details?${params.toString()}`)
}

export const getMetaboliteFeatureMatches = (body) => req('POST', '/map/metabolite-features', body)
export const getDatasetMetadataSchema = (safeName) => req('GET', `/datasets/${safeName}/metadata-schema`)
export const getDatasetMetabolites = (safeName) => req('GET', `/datasets/${safeName}/metabolites`)
export const getBoxplotData = (safeName, metabolite, samples) => req('POST', `/datasets/${safeName}/boxplot-data`, { metabolite, samples })
export const runMapPcoa = (body) => req('POST', '/map/pcoa', body)
export const getVanKrevelenData = (safeName, showMsbuddy = false) =>
  req('GET', `/datasets/${safeName}/vankrevelen${showMsbuddy ? '?show_msbuddy=true' : ''}`)
export const getCarbonOxStateData = (safeName, showMsbuddy = false) =>
  req('GET', `/datasets/${safeName}/carbon-ox-state${showMsbuddy ? '?show_msbuddy=true' : ''}`)
