const BASE = '/api'

async function req(method, path, body) {
  const opts = { method, headers: {} }
  if (body instanceof FormData) {
    opts.body = body
  } else if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json'
    opts.body = JSON.stringify(body)
  }
  const res = await fetch(BASE + path, opts)
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`)
  return data
}

// Upload
export const uploadManual = (formData) => req('POST', '/upload/manual', formData)
export const uploadGnps = (task_id, workflow) => req('POST', '/upload/gnps', { task_id, workflow })

// Session
export const getSessionMdInfo = (id) => req('GET', `/session/${id}/md-info`)
export const blankRemovalPreview = (id, body) => req('POST', `/session/${id}/blank-removal-preview`, body)

// Dataset management
export const saveDataset = (body) => req('POST', '/dataset/save', body)
export const listDatasets = () => req('GET', '/datasets')
export const deleteDataset = (safeName) => req('DELETE', `/datasets/${safeName}`)
export const getDatasetTable = (safeName, table) => req('GET', `/datasets/${safeName}/table/${table}`)

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
export const runMapPcoa = (body) => req('POST', '/map/pcoa', body)
export const getDatasetHeatmap = (safeName) => req('GET', `/datasets/${safeName}/heatmap`)
