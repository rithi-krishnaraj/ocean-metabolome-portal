import { useEffect, useState, useMemo, useCallback, useRef } from 'react'
import DeckGL from '@deck.gl/react'
import { ScatterplotLayer } from '@deck.gl/layers'
import MapLibreMap from 'react-map-gl/maplibre'
import 'maplibre-gl/dist/maplibre-gl.css'
import StatsPanel from '../components/StatsPanel'
import { getMapData, getMapSampleDetails, getMetaboliteFeatureMatches, getDatasetMetadataSchema, runMapPcoa } from '../api'
import { Filter, X, RefreshCw, AlertTriangle, BarChart3, Grid, Layers, Sliders, Flame } from 'lucide-react'

// Free CARTO dark basemap â€” no API key required
const MAP_STYLE = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json'

const INITIAL_VIEW = {
  longitude: 0,
  latitude: 20,
  zoom: 1.5,
  pitch: 0,
  bearing: 0,
}

// Deterministic colour from a string
function strColor(str) {
  let h = 0
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0
  const hue = h % 360
  const s = 0.75, l = 0.6
  const a = s * Math.min(l, 1 - l)
  const f = (n) => {
    const k = (n + hue / 30) % 12
    return Math.round((l - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)))) * 255)
  }
  return [f(0), f(8), f(4)]
}

export default function MapPage({
  colorBy = '_dataset',
  onColorByChange = () => {},
  onColorOptionsChange = () => {},
  resetTrigger = 0,
}) {
  const [mapData, setMapData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [tooltip, setTooltip] = useState(null)
  const [hoverPoint, setHoverPoint] = useState(null)
  const [hoverTab, setHoverTab] = useState('metadata')
  const [hoverMetabolites, setHoverMetabolites] = useState([])
  const [hoverMetabolitesLoading, setHoverMetabolitesLoading] = useState(false)
  const [hoverMetabolitesError, setHoverMetabolitesError] = useState('')
  const [hoverPanelActive, setHoverPanelActive] = useState(false)
  const [hoverExpanded, setHoverExpanded] = useState(false)
  const [clickPinned, setClickPinned] = useState(false)
  const [appliedColorBy, setAppliedColorBy] = useState(colorBy)
  const [analysisOpen, setAnalysisOpen] = useState(false)
  const [metaboliteFilterOpen, setMetaboliteFilterOpen] = useState(false)
  const [globalAnalysisOption, setGlobalAnalysisOption] = useState('PCoA')
  const [metaboliteSearch, setMetaboliteSearch] = useState('')
  const [metaboliteSearchDebounced, setMetaboliteSearchDebounced] = useState('')
  const [metaboliteQuery, setMetaboliteQuery] = useState({
    row_id: '',
    row_retention_time: '',
    row_mz: '',
    annotation: '',
    metabolite: '',
    has_annotation: false,
  })
  const [metaboliteMatches, setMetaboliteMatches] = useState([])
  const [metaboliteMatchesLoading, setMetaboliteMatchesLoading] = useState(false)
  const [metaboliteMatchesError, setMetaboliteMatchesError] = useState('')
  const [selectedFeature, setSelectedFeature] = useState(null)
  const [metaboliteSampleKeys, setMetaboliteSampleKeys] = useState(new Set())
  const metaboliteSearchTimerRef = useRef(null)

  // Filters
  const [filters, setFilters] = useState({})
  const [sampleSearch, setSampleSearch] = useState('')
  const [selectedSamples, setSelectedSamples] = useState(new Set())
  const [filterOpen, setFilterOpen] = useState(false)
  const [legendPos, setLegendPos] = useState({ left: 16, bottom: 16, top: 'auto', transform: 'none' })
  const [legendDragging, setLegendDragging] = useState(false)
  const legendRef = useRef(null)
  const legendDragOffset = useRef({ x: 0, y: 0 })
  const hoverClearTimeoutRef = useRef(null)
  const hoverDetailsCacheRef = useRef(new globalThis.Map())
  const colorByRef = useRef(colorBy)
  const colorLookupRef = useRef(new globalThis.Map())
  const colorByForAfterRender = useRef(colorBy)
  colorByForAfterRender.current = colorBy

  // PCoA State
  const [pcoaDatasetSafe, setPcoaDatasetSafe] = useState('')
  const [pcoaDistanceMetric, setPcoaDistanceMetric] = useState('braycurtis')
  const [pcoaAttribute, setPcoaAttribute] = useState('')
  const [pcoaCategories, setPcoaCategories] = useState([])
  const [pcoaSamples, setPcoaSamples] = useState([])
  const [pcoaColorBy, setPcoaColorBy] = useState('')
  const [pcoaXAxis, setPcoaXAxis] = useState('PC1')
  const [pcoaYAxis, setPcoaYAxis] = useState('PC2')
  const [pcoaResult, setPcoaResult] = useState(null)
  const [pcoaLoading, setPcoaLoading] = useState(false)
  const [pcoaError, setPcoaError] = useState('')
  const [pcoaActiveTab, setPcoaActiveTab] = useState('plot')
  const [pcoaDashboardExpanded, setPcoaDashboardExpanded] = useState(true)
  const [pcoaTooltip, setPcoaTooltip] = useState(null)

  const [pcoaMetadataColumns, setPcoaMetadataColumns] = useState([])
  const [pcoaAllCategories, setPcoaAllCategories] = useState([])

  // Added States for Granular Sample Filtering & Interactive Zoom
  const [pcoaAllSamples, setPcoaAllSamples] = useState([])
  const [expandedGroups, setExpandedGroups] = useState({})
  const [sampleGroupSearch, setSampleGroupSearch] = useState({})
  const [pcoaZoom, setPcoaZoom] = useState(1)
  const [pcoaPan, setPcoaPan] = useState({ x: 0, y: 0 })
  const [pcoaDragStart, setPcoaDragStart] = useState(null)

  // Heatmap State
  const [heatmapOpen, setHeatmapOpen] = useState(false)

  const pcoaSamplesByGroup = useMemo(() => {
    if (!pcoaAllSamples || !pcoaAttribute) return {}
    const groups = {}
    pcoaAllSamples.forEach((sample) => {
      const grpVal = sample[pcoaAttribute] || 'N/A'
      if (!groups[grpVal]) groups[grpVal] = []
      groups[grpVal].push(sample)
    })
    return groups
  }, [pcoaAllSamples, pcoaAttribute])

  const toggleCategorySelection = (cat, isChecked) => {
    let nextCategories
    let nextSamples = new Set(pcoaSamples)
    
    if (isChecked) {
      nextCategories = [...pcoaCategories, cat]
      const samplesInCat = pcoaSamplesByGroup[cat] || []
      samplesInCat.forEach(s => nextSamples.add(s.sample_id))
    } else {
      nextCategories = pcoaCategories.filter(c => c !== cat)
      const samplesInCat = pcoaSamplesByGroup[cat] || []
      samplesInCat.forEach(s => nextSamples.delete(s.sample_id))
    }
    
    setPcoaCategories(nextCategories)
    setPcoaSamples(Array.from(nextSamples))
  }

  const toggleSampleSelection = (sampleId) => {
    setPcoaSamples((prev) => {
      const next = new Set(prev)
      if (next.has(sampleId)) {
        next.delete(sampleId)
      } else {
        next.add(sampleId)
      }
      return Array.from(next)
    })
  }

  const toggleAllSamplesInCategory = (cat, isSelectAll) => {
    const samplesInCat = pcoaSamplesByGroup[cat] || []
    setPcoaSamples((prev) => {
      const next = new Set(prev)
      samplesInCat.forEach(s => {
        if (isSelectAll) {
          next.add(s.sample_id)
        } else {
          next.delete(s.sample_id)
        }
      })
      return Array.from(next)
    })
  }

  const runPcoaAnalysis = async () => {
    if (!pcoaDatasetSafe) return
    setPcoaLoading(true)
    setPcoaError('')
    try {
      const data = await runMapPcoa({
        dataset_safe: pcoaDatasetSafe,
        distance_metric: pcoaDistanceMetric,
        attribute: pcoaAttribute || undefined,
        categories: pcoaCategories.length > 0 ? pcoaCategories : undefined,
        samples: pcoaSamples.length > 0 ? pcoaSamples : undefined,
        color_by: pcoaColorBy || undefined,
      })
      if (data.error) {
        setPcoaError(data.error)
        setPcoaResult(null)
      } else {
        setPcoaResult(data)
        if (!pcoaAttribute && data.metadata_columns?.length > 0) {
          setPcoaAttribute(data.metadata_columns[0])
        }
        if (!pcoaColorBy && data.metadata_columns?.length > 0) {
          setPcoaColorBy(data.metadata_columns[0])
        }
      }
    } catch (err) {
      setPcoaError(err.message || 'Failed to run PCoA filtering.')
      setPcoaResult(null)
    } finally {
      setPcoaLoading(false)
    }
  }

  const handleAttributeChange = async (newAttr) => {
    setPcoaAttribute(newAttr)
    setPcoaCategories([])
    if (!newAttr) {
      setPcoaAllCategories([])
      return
    }
    setPcoaLoading(true)
    try {
      const data = await getDatasetMetadataSchema(pcoaDatasetSafe)
      if (data?.categories?.[newAttr]) {
        setPcoaAllCategories(data.categories[newAttr])
        setPcoaCategories(data.categories[newAttr])
        
        const samples = data.samples || []
        setPcoaAllSamples(samples)
        setPcoaSamples(samples.map(s => s.sample_id))
      } else {
        setPcoaAllCategories([])
      }
    } catch (err) {
      console.error(err)
    } finally {
      setPcoaLoading(false)
    }
  }

  // Load defaults when dataset safe is set/loaded
  useEffect(() => {
    if (mapData?.datasets_details?.length > 0 && !pcoaDatasetSafe) {
      setPcoaDatasetSafe(mapData.datasets_details[0].safe_name)
    }
  }, [mapData, pcoaDatasetSafe])

  // Get available attributes/metadata columns and all samples with details
  useEffect(() => {
    if (pcoaDatasetSafe) {
      const loadMetadataOptions = async () => {
        setPcoaLoading(true)
        setPcoaResult(null)
        setPcoaError('')
        try {
          const data = await getDatasetMetadataSchema(pcoaDatasetSafe)
          if (data?.columns?.length > 0) {
            setPcoaMetadataColumns(data.columns)
            const defaultAttr = data.columns[0]
            setPcoaAttribute(defaultAttr)
            setPcoaColorBy(defaultAttr)
            
            const cats = data.categories?.[defaultAttr] || []
            setPcoaAllCategories(cats)
            setPcoaCategories(cats)

            const samples = data.samples || []
            setPcoaAllSamples(samples)
            setPcoaSamples(samples.map(s => s.sample_id))
          } else {
            setPcoaMetadataColumns([])
            setPcoaAttribute('')
            setPcoaColorBy('')
            setPcoaAllCategories([])
            setPcoaCategories([])
            setPcoaAllSamples([])
            setPcoaSamples([])
          }
        } catch (err) {
          setPcoaError(err.message || 'Failed to initialize PCoA configuration.')
        } finally {
          setPcoaLoading(false)
        }
      }
      loadMetadataOptions()
    }
  }, [pcoaDatasetSafe])

  // Expose a way to bust the cache when needed (e.g. after backend restart)
  const bustCache = () => { hoverDetailsCacheRef.current.clear() }

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const data = await getMapData()
      setMapData(data)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  // Clear all filters when the reset trigger at the top nav is incremented
  useEffect(() => {
    if (resetTrigger > 0) {
      setFilters({})
      setSelectedSamples(new Set())
      setSampleSearch('')
      setMetaboliteSampleKeys(new Set())
      setSelectedFeature(null)
      setMetaboliteQuery({
        row_id: '',
        row_retention_time: '',
        row_mz: '',
        annotation: '',
        metabolite: '',
        has_annotation: false,
      })
      setMetaboliteMatches([])
      setMetaboliteMatchesError('')
    }
  }, [resetTrigger])

  const resolveDatasetSafe = useCallback((point) => {
    if (!point) return ''
    return String(
      point._dataset_safe
      || mapData?.dataset_safe_map?.[String(point._dataset ?? '')]
      || ''
    ).trim()
  }, [mapData])

  const resolveSampleId = useCallback((point) => {
    if (!point) return ''

    const direct = String(point._sample_id || point.index || point.filename || '').trim()
    if (direct && direct !== 'N/A') return direct

    const dataset = String(point._dataset ?? '')
    const lat = Number.parseFloat(point._lat)
    const lon = Number.parseFloat(point._lon)
    if (!dataset || !Number.isFinite(lat) || !Number.isFinite(lon) || !mapData?.points?.length) return ''

    const matched = mapData.points.find((p) => {
      if (String(p._dataset ?? '') !== dataset) return false
      const pLat = Number.parseFloat(p._lat)
      const pLon = Number.parseFloat(p._lon)
      return Number.isFinite(pLat)
        && Number.isFinite(pLon)
        && Math.abs(pLat - lat) < 1e-10
        && Math.abs(pLon - lon) < 1e-10
        && String(p._sample_id ?? '').trim() !== ''
        && String(p._sample_id ?? '').trim() !== 'N/A'
    })

    return matched ? String(matched._sample_id).trim() : ''
  }, [mapData])

  const datasetFilter = useMemo(
    () => filters._dataset ?? new Set(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [filters._dataset]
  )

  const datasetScopedPoints = useMemo(() => {
    if (!mapData?.points) return []
    if (datasetFilter.size === 0) return mapData.points
    return mapData.points.filter((p) => datasetFilter.has(String(p._dataset ?? 'N/A')))
  }, [mapData, datasetFilter])

  const availableMetadataCols = useMemo(() => {
    if (!datasetScopedPoints.length) return []

    const datasetToCols = new globalThis.Map()

    for (const p of datasetScopedPoints) {
      const datasetName = String(p._dataset ?? 'N/A')
      if (!datasetToCols.has(datasetName)) {
        datasetToCols.set(datasetName, new globalThis.Set())
      }

      const cols = datasetToCols.get(datasetName)
      for (const [k, v] of Object.entries(p)) {
        if (k.startsWith('_') || k === 'index') continue
        const value = String(v ?? 'N/A')
        if (value !== 'N/A' && value !== '') cols.add(k)
      }
    }

    const selectedDatasets = [...datasetToCols.keys()]
    if (selectedDatasets.length === 1) {
      return [...datasetToCols.get(selectedDatasets[0])].sort((a, b) => a.localeCompare(b))
    }

    let intersection = null
    for (const cols of datasetToCols.values()) {
      if (!intersection) {
        intersection = new globalThis.Set(cols)
        continue
      }
      intersection = new globalThis.Set([...intersection].filter((c) => cols.has(c)))
    }

    return intersection ? [...intersection].sort((a, b) => a.localeCompare(b)) : []
  }, [datasetScopedPoints])

  const allowedColumns = useMemo(() => {
    return ['_dataset', ...availableMetadataCols]
  }, [availableMetadataCols])

  useEffect(() => {
    onColorOptionsChange(allowedColumns)
  }, [allowedColumns, onColorOptionsChange])

  // Keep colorBy valid when allowed columns change
  useEffect(() => {
    const allowed = new globalThis.Set(allowedColumns)
    if (!allowed.has(colorBy)) onColorByChange('_dataset')
  }, [allowedColumns, colorBy, onColorByChange])

  // Drop filters for columns that are no longer available.
  useEffect(() => {
    setFilters((prev) => {
      const allowed = new globalThis.Set(allowedColumns)
      const next = {}
      for (const [k, v] of Object.entries(prev)) {
        if (allowed.has(k)) next[k] = v
      }
      return next
    })
  }, [allowedColumns])

  // Unique values per metadata/dataset column (for filter dropdowns)
  const columnValues = useMemo(() => {
    if (!mapData?.points?.length && !datasetScopedPoints.length) return {}
    const out = {}
    const cols = allowedColumns
    for (const col of cols) {
      // Keep dataset options global so users can always jump back to all datasets.
      const source = col === '_dataset' ? (mapData?.points ?? []) : datasetScopedPoints
      const vals = [...new Set(source.map((p) => String(p[col] ?? 'N/A')))]
      out[col] = vals.sort()
    }
    return out
  }, [mapData, datasetScopedPoints, allowedColumns])

  // Filtered points — apply active metadata filters
  const points = useMemo(() => {
    if (!datasetScopedPoints.length) return []
    return datasetScopedPoints.filter((p) => {
      for (const [col, included] of Object.entries(filters)) {
        if (!allowedColumns.includes(col)) continue
        if (included.size > 0 && !included.has(String(p[col] ?? 'N/A'))) return false
      }

      const sampleId = String(p._sample_id || p.index || p.filename || '').trim()
      const datasetSafe = String(
        p._dataset_safe
        || mapData?.dataset_safe_map?.[String(p._dataset ?? '')]
        || ''
      ).trim()
      const sampleKey = `${datasetSafe}::${sampleId}`

      if (selectedSamples.size > 0 && !selectedSamples.has(sampleKey)) {
        return false
      }

      if (metaboliteSampleKeys.size > 0) {
        if (!datasetSafe || !sampleId) return false
        if (!metaboliteSampleKeys.has(sampleKey)) return false
      }

      return true
    })
  }, [datasetScopedPoints, filters, allowedColumns, selectedSamples, metaboliteSampleKeys, mapData])

  // Precompute colours for selected category values so recolouring is immediate.
  const colorLookup = useMemo(() => {
    const lookup = new globalThis.Map()
    for (const val of columnValues[colorBy] ?? []) {
      lookup.set(val, strColor(val))
    }
    colorByRef.current = colorBy
    colorLookupRef.current = lookup
    return lookup
  }, [columnValues, colorBy])

  // Deck.gl layer
  const layer = useMemo(() => {
    if (!points.length) return null
    return new ScatterplotLayer({
      id: 'metabolome-points',
      data: points,
      getPosition: (d) => [parseFloat(d._lon), parseFloat(d._lat)],
      getColor: (d) => {
        const key = colorByRef.current ? String(d[colorByRef.current] ?? 'N/A') : String(d._dataset ?? 'N/A')
        return colorLookupRef.current.get(key) ?? strColor(key)
      },
      getRadius: 55000,
      radiusUnits: 'meters',
      radiusMinPixels: 4,
      radiusMaxPixels: 18,
      pickable: true,
      opacity: 0.75,
      updateTriggers: {
        getColor: [colorBy, colorLookup],
      },
      onHover: ({ object, x, y }) => {
        if (hoverClearTimeoutRef.current) {
          clearTimeout(hoverClearTimeoutRef.current)
          hoverClearTimeoutRef.current = null
        }

        if (object) {
          setHoverPoint(object)
          setTooltip({ object, x, y })
          return
        }

        if (hoverPanelActive) return

        // Small delay prevents flicker while moving between nearby points.
        hoverClearTimeoutRef.current = setTimeout(() => {
          setHoverPoint(null)
          setTooltip(null)
          hoverClearTimeoutRef.current = null
        }, 180)
      },
      onClick: ({ object }) => {
        if (!object) return
        setHoverPoint(object)
        setTooltip({ object, x: 0, y: 0 })
        setClickPinned(true)
        setHoverExpanded(true)
        setHoverPanelActive(true)
      },
    })
  }, [points, hoverPanelActive, colorBy, colorLookup])

  const onAfterRender = useCallback(() => {
    setAppliedColorBy(colorByForAfterRender.current)
  }, [])

  useEffect(() => {
    return () => {
      if (hoverClearTimeoutRef.current) {
        clearTimeout(hoverClearTimeoutRef.current)
      }
    }
  }, [])

  useEffect(() => {
    if (!hoverPoint) {
      setHoverMetabolites([])
      setHoverMetabolitesError('')
      setHoverMetabolitesLoading(false)
      return
    }

    setHoverTab('metadata')
    setMetaboliteSearch('')
    setMetaboliteSearchDebounced('')
    if (!clickPinned) setHoverExpanded(false)
    const datasetSafe = resolveDatasetSafe(hoverPoint)
    const sampleIdHint = resolveSampleId(hoverPoint)
    const lat = Number.parseFloat(hoverPoint?._lat)
    const lon = Number.parseFloat(hoverPoint?._lon)

    if (!datasetSafe || !Number.isFinite(lat) || !Number.isFinite(lon)) {
      setHoverMetabolites([])
      setHoverMetabolitesError('')
      setHoverMetabolitesLoading(false)
      return
    }

    const cacheKey = `${datasetSafe}::${lat.toFixed(8)}::${lon.toFixed(8)}`
    if (hoverDetailsCacheRef.current.has(cacheKey)) {
      const cached = hoverDetailsCacheRef.current.get(cacheKey)
      setHoverMetabolites(cached.metabolites ?? [])
      setHoverMetabolitesError('')
      setHoverMetabolitesLoading(false)
      return
    }

    let cancelled = false
    setHoverMetabolitesLoading(true)
    setHoverMetabolitesError('')
    setHoverMetabolites([])

    getMapSampleDetails(datasetSafe, lat, lon, sampleIdHint)
      .then((data) => {
        if (cancelled) return
        hoverDetailsCacheRef.current.set(cacheKey, data)
        setHoverMetabolites(data?.metabolites ?? [])
        setHoverMetabolitesError('')
      })
      .catch(() => {
        if (cancelled) return
        setHoverMetabolites([])
        setHoverMetabolitesError('')
      })
      .finally(() => {
        if (cancelled) return
        setHoverMetabolitesLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [hoverPoint, resolveDatasetSafe, resolveSampleId, clickPinned])

  const beginLegendDrag = (e) => {
    if (!legendRef.current) return
    const rect = legendRef.current.getBoundingClientRect()
    legendDragOffset.current = {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    }
    setLegendPos({ left: rect.left, top: rect.top, bottom: 'auto', transform: 'none' })
    setLegendDragging(true)
  }

  useEffect(() => {
    if (!legendDragging) return

    const onMove = (e) => {
      const nextLeft = Math.max(8, e.clientX - legendDragOffset.current.x)
      const nextTop = Math.max(8, e.clientY - legendDragOffset.current.y)
      setLegendPos({ left: nextLeft, top: nextTop, bottom: 'auto', transform: 'none' })
    }

    const onUp = () => setLegendDragging(false)

    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [legendDragging])

  const toggleFilter = (col, val) => {
    setFilters((prev) => {
      const cur = new Set(prev[col] ?? [])
      cur.has(val) ? cur.delete(val) : cur.add(val)
      return { ...prev, [col]: cur }
    })
  }

  const clearFilter = (col) => setFilters((prev) => ({ ...prev, [col]: new Set() }))

  const filterCols = useMemo(() => {
    return allowedColumns.filter((c) => {
      if (c === '_dataset') return (columnValues[c]?.length ?? 0) > 0
      return (columnValues[c]?.length ?? 0) > 1
    })
  }, [allowedColumns, columnValues])

  const hoverSummary = useMemo(() => {
    if (!tooltip?.object) return null
    const p = tooltip.object
    const metadata = Object.entries(p)
      .filter(([k]) => !k.startsWith('_') && k !== 'index')
      .filter(([, v]) => String(v ?? '').trim() !== '' && String(v) !== 'N/A')
      .sort(([a], [b]) => a.localeCompare(b))

    return { metadata }
  }, [tooltip])

  const analysisSummary = useMemo(() => {
    const visibleSamples = points.length
    const visibleDatasets = new globalThis.Set(points.map((p) => String(p._dataset ?? 'N/A'))).size

    const topColorGroups = Object.entries(
      points.reduce((acc, p) => {
        const key = String(p[colorBy] ?? 'N/A')
        acc[key] = (acc[key] ?? 0) + 1
        return acc
      }, {})
    )
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)

    const intensityValues = hoverMetabolites
      .map((m) => Number(m.intensity))
      .filter((v) => Number.isFinite(v))

    const meanIntensity = intensityValues.length
      ? intensityValues.reduce((sum, v) => sum + v, 0) / intensityValues.length
      : null

    return {
      visibleSamples,
      visibleDatasets,
      topColorGroups,
      meanIntensity,
      metabolitesInSelectedSample: hoverMetabolites.length,
    }
  }, [points, colorBy, hoverMetabolites])

  const runMetaboliteFilter = async () => {
    setMetaboliteMatchesLoading(true)
    setMetaboliteMatchesError('')
    try {
      const datasetSafes = [...datasetFilter].map((datasetName) => String(mapData?.dataset_safe_map?.[datasetName] ?? '')).filter(Boolean)
      const data = await getMetaboliteFeatureMatches({
        ...metaboliteQuery,
        dataset_safes: datasetSafes,
        limit: 500,
      })
      setMetaboliteMatches(data?.features ?? [])
    } catch (e) {
      setMetaboliteMatches([])
      setMetaboliteMatchesError(e.message || 'Failed to run metabolite filtering.')
    } finally {
      setMetaboliteMatchesLoading(false)
    }
  }

  const applyFeatureMapFilter = (feature) => {
    const keys = new Set(
      (feature.present_samples ?? []).map((s) => `${String(s.dataset_safe)}::${String(s.sample_id)}`)
    )
    setMetaboliteSampleKeys(keys)
    setSelectedFeature(feature)
  }

  const clearFeatureMapFilter = () => {
    setMetaboliteSampleKeys(new Set())
    setSelectedFeature(null)
  }

  const formatRt = (value) => {
    const num = Number(value)
    return Number.isFinite(num) ? num.toFixed(2) : 'N/A'
  }

  const formatMz = (value) => {
    const num = Number(value)
    return Number.isFinite(num) ? num.toFixed(4) : 'N/A'
  }

  const renderPcoaScatterPlot = () => {
    if (!pcoaResult?.coordinates || pcoaResult.coordinates.length === 0) {
      return (
        <div className="text-center py-12 text-xs text-slate-500">
          No coordinates available. Try adjusting filters or select a different dataset.
        </div>
      )
    }

    const pcXValues = pcoaResult.coordinates.map((s) => s.coordinates[pcoaXAxis] ?? 0)
    const pcYValues = pcoaResult.coordinates.map((s) => s.coordinates[pcoaYAxis] ?? 0)

    const minX = Math.min(...pcXValues)
    const maxX = Math.max(...pcXValues)
    const minY = Math.min(...pcYValues)
    const maxY = Math.max(...pcYValues)

    const xSpan = maxX - minX || 1
    const ySpan = maxY - minY || 1
    const padXMin = minX - xSpan * 0.1
    const padXMax = maxX + xSpan * 0.1
    const padYMin = minY - ySpan * 0.1
    const padYMax = maxY + ySpan * 0.1

    const width = 450
    const height = 300
    const margin = { top: 20, right: 20, bottom: 40, left: 50 }

    const scaleX = (val) => margin.left + ((val - padXMin) / (padXMax - padXMin)) * (width - margin.left - margin.right)
    const scaleY = (val) => height - margin.bottom - ((val - padYMin) / (padYMax - padYMin)) * (height - margin.top - margin.bottom)

    const uniqueColors = Array.from(new Set(pcoaResult.coordinates.map((s) => s.color_value)))
    const colorPalette = ['#38bdf8', '#f43f5e', '#10b981', '#fbbf24', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316', '#a3e635', '#c084fc']
    const colorMap = {}
    uniqueColors.forEach((val, i) => {
      colorMap[val] = colorPalette[i % colorPalette.length]
    })

    const uniqueAttrs = Array.from(new Set(pcoaResult.coordinates.map((s) => s.shape_value)))
    const attrColorMap = {}
    uniqueAttrs.forEach((val, i) => {
      attrColorMap[val] = colorPalette[(i + 5) % colorPalette.length]
    })

    const renderShapeNode = (cx, cy, color, sampleId, s) => {
      const size = 5
      const handleMouseOver = (e) => {
        const bounds = e.currentTarget.getBoundingClientRect()
        setPcoaTooltip({
          sample_id: sampleId,
          color_value: s.color_value,
          shape_value: s.shape_value,
          x: s.coordinates[pcoaXAxis],
          y: s.coordinates[pcoaYAxis],
          clientX: bounds.left + window.scrollX,
          clientY: bounds.top + window.scrollY - 100,
        })
      }

      return (
        <circle
          cx={cx}
          cy={cy}
          r={size}
          fill={color}
          className="hover:stroke-white hover:stroke-2 cursor-pointer transition-all duration-150"
          onMouseOver={handleMouseOver}
          onMouseOut={() => setPcoaTooltip(null)}
        />
      )
    }

    const pcXIndex = parseInt(pcoaXAxis.replace('PC', '')) - 1
    const pcYIndex = parseInt(pcoaYAxis.replace('PC', '')) - 1
    const pcXExplained = ((pcoaResult.proportion_explained[pcXIndex] || 0) * 100).toFixed(1)
    const pcYExplained = ((pcoaResult.proportion_explained[pcYIndex] || 0) * 100).toFixed(1)

    // Interactivity: Drag to Pan
    const handlePcoaMouseDown = (e) => {
      if (e.button !== 0) return
      setPcoaDragStart({
        x: e.clientX - pcoaPan.x,
        y: e.clientY - pcoaPan.y,
      })
    }

    const handlePcoaMouseMove = (e) => {
      if (!pcoaDragStart) return
      setPcoaPan({
        x: e.clientX - pcoaDragStart.x,
        y: e.clientY - pcoaDragStart.y,
      })
    }

    const handlePcoaMouseUp = () => {
      setPcoaDragStart(null)
    }

    // Interactivity: Wheel Scroll Zoom
    const handlePcoaWheel = (e) => {
      e.preventDefault()
      const zoomFactor = 1.15
      let nextZoom = pcoaZoom
      if (e.deltaY < 0) {
        nextZoom = Math.min(nextZoom * zoomFactor, 25)
      } else {
        nextZoom = Math.max(nextZoom / zoomFactor, 0.4)
      }

      const rect = e.currentTarget.getBoundingClientRect()
      const mouseX = e.clientX - rect.left
      const mouseY = e.clientY - rect.top

      const dx = mouseX - pcoaPan.x
      const dy = mouseY - pcoaPan.y

      setPcoaPan({
        x: mouseX - dx * (nextZoom / pcoaZoom),
        y: mouseY - dy * (nextZoom / pcoaZoom),
      })
      setPcoaZoom(nextZoom)
    }

    const handlePcoaReset = () => {
      setPcoaZoom(1)
      setPcoaPan({ x: 0, y: 0 })
    }

    return (
      <div className="relative grid grid-cols-12 gap-4">
        <div className="col-span-8 bg-slate-950 border border-slate-800 rounded-lg p-2 flex flex-col items-center select-none relative">
          
          {/* Legend / Info bar */}
          <div className="absolute top-2 right-2 flex items-center gap-1.5 z-10">
            <span className="text-[9px] text-slate-500 font-medium">Scroll to Zoom • Drag to Pan</span>
            <button
              onClick={handlePcoaReset}
              className="text-[9px] bg-slate-800 hover:bg-slate-700 hover:text-slate-100 text-slate-300 rounded px-1.5 py-0.5 border border-slate-700 transition-colors"
            >
              Reset View
            </button>
          </div>

          <svg
            width={width}
            height={height}
            className="overflow-visible cursor-grab active:cursor-grabbing"
            onMouseDown={handlePcoaMouseDown}
            onMouseMove={handlePcoaMouseMove}
            onMouseUp={handlePcoaMouseUp}
            onMouseLeave={handlePcoaMouseUp}
            onWheel={handlePcoaWheel}
          >
            {/* Cliping path definitions so zoomed elements don't spill outside grid margins */}
            <defs>
              <clipPath id="pcoa-plot-clip">
                <rect
                  x={margin.left}
                  y={margin.top}
                  width={width - margin.left - margin.right}
                  height={height - margin.top - margin.bottom}
                />
              </clipPath>
            </defs>

            {/* Static Outer Border */}
            <rect
              x={margin.left}
              y={margin.top}
              width={width - margin.left - margin.right}
              height={height - margin.top - margin.bottom}
              fill="none"
              stroke="#334155"
              strokeWidth={1}
              style={{ zIndex: 10 }}
            />

            {/* Zoomable & Pannable Plot Content Area */}
            <g clipPath="url(#pcoa-plot-clip)">
              <g transform={`translate(${pcoaPan.x}, ${pcoaPan.y}) scale(${pcoaZoom})`}>
                
                {/* Horizontal grid lines */}
                {Array.from({ length: 5 }).map((_, i) => {
                  const val = padYMin + (i * (padYMax - padYMin)) / 4
                  const cy = scaleY(val)
                  return (
                    <line
                      key={`h-${i}`}
                      x1={margin.left - 1000}
                      y1={cy}
                      x2={width - margin.right + 1000}
                      y2={cy}
                      stroke="#111827"
                      strokeWidth={0.5 / pcoaZoom}
                      strokeDasharray="4,4"
                    />
                  )
                })}

                {/* Vertical grid lines */}
                {Array.from({ length: 5 }).map((_, i) => {
                  const val = padXMin + (i * (padXMax - padXMin)) / 4
                  const cx = scaleX(val)
                  return (
                    <line
                      key={`v-${i}`}
                      x1={cx}
                      y1={margin.top - 1000}
                      x2={cx}
                      y2={height - margin.bottom + 1000}
                      stroke="#111827"
                      strokeWidth={0.5 / pcoaZoom}
                      strokeDasharray="4,4"
                    />
                  )
                })}

                {/* Main Zero Center Lines */}
                {padXMin < 0 && padXMax > 0 && (
                  <line
                    x1={scaleX(0)}
                    y1={margin.top - 1000}
                    x2={scaleX(0)}
                    y2={height - margin.bottom + 1000}
                    stroke="#1e293b"
                    strokeWidth={1 / pcoaZoom}
                  />
                )}
                {padYMin < 0 && padYMax > 0 && (
                  <line
                    x1={margin.left - 1000}
                    y1={scaleY(0)}
                    x2={width - margin.right + 1000}
                    y2={scaleY(0)}
                    stroke="#1e293b"
                    strokeWidth={1 / pcoaZoom}
                  />
                )}

                {/* Render Circular Data Points */}
                {pcoaResult.coordinates.map((s) => {
                  const cx = scaleX(s.coordinates[pcoaXAxis] ?? 0)
                  const cy = scaleY(s.coordinates[pcoaYAxis] ?? 0)
                  const color = colorMap[s.color_value] || '#e2e8f0'
                  return (
                    <g key={s.sample_id}>
                      {renderShapeNode(cx, cy, color, s.sample_id, s)}
                    </g>
                  )
                })}
              </g>
            </g>

            {/* Static Axis Labels */}
            <text
              x={margin.left + (width - margin.left - margin.right) / 2}
              y={height - 10}
              fill="#94a3b8"
              fontSize={10}
              textAnchor="middle"
              className="font-medium"
            >
              {pcoaXAxis} ({pcXExplained}%)
            </text>

            <text
              transform="rotate(-90)"
              x={-(margin.top + (height - margin.top - margin.bottom) / 2)}
              y={15}
              fill="#94a3b8"
              fontSize={10}
              textAnchor="middle"
              className="font-medium"
            >
              {pcoaYAxis} ({pcYExplained}%)
            </text>

            {/* Dynamic Axis Coordinates */}
            {[padXMin, padXMin + (padXMax - padXMin)/2, padXMax].map((val, i) => {
              const rawX = scaleX(val)
              const cx = rawX * pcoaZoom + pcoaPan.x
              
              if (cx < margin.left || cx > width - margin.right) return null

              return (
                <text
                  key={`xl-${i}`}
                  x={cx}
                  y={height - margin.bottom + 12}
                  fill="#64748b"
                  fontSize={8}
                  textAnchor="middle"
                >
                  {val.toFixed(2)}
                </text>
              )
            })}

            {[padYMin, padYMin + (padYMax - padYMin)/2, padYMax].map((val, i) => {
              const rawY = scaleY(val)
              const cy = rawY * pcoaZoom + pcoaPan.y
              
              if (cy < margin.top || cy > height - margin.bottom) return null

              return (
                <text
                  key={`yl-${i}`}
                  x={margin.left - 6}
                  y={cy + 3}
                  fill="#64748b"
                  fontSize={8}
                  textAnchor="end"
                >
                  {val.toFixed(2)}
                </text>
              )
            })}
          </svg>

          {pcoaTooltip && (
            <div
              className="fixed z-50 bg-slate-900 border border-slate-700 rounded p-2 shadow-xl text-[10px] text-slate-300 space-y-1 select-none pointer-events-none"
              style={{ left: pcoaTooltip.clientX, top: pcoaTooltip.clientY }}
            >
              <div className="font-bold text-slate-100 border-b border-slate-850 pb-1 mb-1 truncate max-w-[180px]">
                {pcoaTooltip.sample_id}
              </div>
              <div>
                <span className="text-slate-500 font-semibold">{pcoaColorBy}:</span> {pcoaTooltip.color_value}
              </div>
              {pcoaAttribute !== pcoaColorBy && (
                <div>
                  <span className="text-slate-500 font-semibold">{pcoaAttribute}:</span> {pcoaTooltip.shape_value}
                </div>
              )}
              <div>
                <span className="text-slate-500 font-semibold">{pcoaXAxis}:</span> {pcoaTooltip.x.toFixed(4)}
              </div>
              <div>
                <span className="text-slate-500 font-semibold">{pcoaYAxis}:</span> {pcoaTooltip.y.toFixed(4)}
              </div>
            </div>
          )}
        </div>

        <div className="col-span-4 space-y-3 max-h-[300px] overflow-y-auto pr-1">
          <div className="space-y-1">
            <h4 className="text-[10px] uppercase font-bold text-slate-400 tracking-wide border-b border-slate-800 pb-0.5">
              Groups ({pcoaColorBy})
            </h4>
            <div className="space-y-0.5 max-h-[120px] overflow-y-auto">
              {Object.entries(colorMap).map(([val, color]) => (
                <div key={val} className="flex items-center gap-2 text-xs text-slate-300 py-0.5">
                  <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: color }} />
                  <span className="truncate text-[11px]" title={val}>{val}</span>
                </div>
              ))}
            </div>
          </div>

          {pcoaAttribute && pcoaAttribute !== pcoaColorBy && (
            <div className="space-y-1">
              <h4 className="text-[10px] uppercase font-bold text-slate-400 tracking-wide border-b border-slate-800 pb-0.5">
                Filter ({pcoaAttribute})
              </h4>
              <div className="space-y-0.5 max-h-[100px] overflow-y-auto">
                {Object.entries(attrColorMap).map(([val, color]) => {
                  return (
                    <div key={val} className="flex items-center gap-2 text-xs text-slate-300 py-0.5">
                      <span className="w-2.5 text-center flex-shrink-0 text-[10px]" style={{ color }}>
                        ●
                      </span>
                      <span className="truncate text-[11px]" title={val}>{val}</span>
                    </div>
                  )
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    )
  }

  const renderVarianceBarChart = () => {
    if (!pcoaResult?.proportion_explained || pcoaResult.proportion_explained.length === 0) {
      return (
        <div className="text-center py-12 text-xs text-slate-500">
          No variance data available.
        </div>
      )
    }

    const variancePercents = pcoaResult.proportion_explained.map((v) => v * 100)
    const maxVal = Math.max(...variancePercents) || 1

    const width = 450
    const height = 280
    const margin = { top: 20, right: 20, bottom: 40, left: 40 }

    const barWidth = 24
    const spacing = 12

    return (
      <div className="bg-slate-950 border border-slate-800 rounded-lg p-3 flex flex-col items-center">
        <h4 className="text-xs font-semibold text-slate-200 mb-3 self-start">PCoA Scree Plot (Explained Variance)</h4>
        <svg width={width} height={height} className="overflow-visible">
          {Array.from({ length: 5 }).map((_, i) => {
            const val = (i * maxVal) / 4
            const cy = height - margin.bottom - (val / maxVal) * (height - margin.top - margin.bottom)
            return (
              <line
                key={`v-grid-${i}`}
                x1={margin.left}
                y1={cy}
                x2={width - margin.right}
                y2={cy}
                stroke="#1e293b"
                strokeWidth={0.5}
              />
            )
          })}

          {variancePercents.map((v, i) => {
            const barHeight = (v / maxVal) * (height - margin.top - margin.bottom)
            const x = margin.left + i * (barWidth + spacing) + spacing
            const y = height - margin.bottom - barHeight

            return (
              <g key={`bar-${i}`} className="group cursor-pointer">
                <rect
                  x={x}
                  y={y}
                  width={barWidth}
                  height={barHeight}
                  fill={pcoaXAxis === `PC${i+1}` || pcoaYAxis === `PC${i+1}` ? '#38bdf8' : '#475569'}
                  className="hover:fill-ocean-500 transition-colors duration-150"
                  rx={1}
                />
                <text
                  x={x + barWidth / 2}
                  y={y - 4}
                  fill="#cbd5e1"
                  fontSize={8}
                  textAnchor="middle"
                  className="opacity-0 group-hover:opacity-100 transition-opacity font-medium"
                >
                  {v.toFixed(1)}%
                </text>
                <text
                  x={x + barWidth / 2}
                  y={height - margin.bottom + 12}
                  fill="#94a3b8"
                  fontSize={8}
                  textAnchor="middle"
                  className="font-medium"
                >
                  PC{i+1}
                </text>
              </g>
            )
          })}

          <line
            x1={margin.left}
            y1={height - margin.bottom}
            x2={width - margin.right}
            y2={height - margin.bottom}
            stroke="#475569"
            strokeWidth={1}
          />
          <line
            x1={margin.left}
            y1={margin.top}
            x2={margin.left}
            y2={height - margin.bottom}
            stroke="#475569"
            strokeWidth={1}
          />

          {[0, maxVal / 2, maxVal].map((val, i) => {
            const cy = height - margin.bottom - (val / maxVal) * (height - margin.top - margin.bottom)
            return (
              <text
                key={`y-label-${i}`}
                x={margin.left - 6}
                y={cy + 3}
                fill="#64748b"
                fontSize={8}
                textAnchor="end"
              >
                {val.toFixed(1)}%
              </text>
            )
          })}
        </svg>
      </div>
    )
  }



  const renderCoordinatesData = () => {
    if (!pcoaResult?.coordinates || pcoaResult.coordinates.length === 0) {
      return (
        <div className="text-center py-12 text-xs text-slate-500">
          No coordinate data available.
        </div>
      )
    }

    return (
      <div className="bg-slate-950 border border-slate-800 rounded-lg p-3 space-y-2">
        <div className="flex items-center justify-between pb-1 border-b border-slate-800">
          <h4 className="text-xs font-semibold text-slate-200">Principal Coordinates Table (Top 10 PCs)</h4>
          <span className="text-[10px] text-slate-400">{pcoaResult.coordinates.length} samples</span>
        </div>

        <div className="max-h-[220px] overflow-auto border border-slate-800 rounded">
          <table className="w-full text-[10px] text-slate-300 text-left border-collapse">
            <thead>
              <tr className="bg-slate-900 border-b border-slate-800 text-slate-400 sticky top-0">
                <th className="px-2 py-1 font-semibold border-r border-slate-800">Sample ID</th>
                <th className="px-2 py-1 font-semibold text-right border-r border-slate-800">PC1</th>
                <th className="px-2 py-1 font-semibold text-right border-r border-slate-800">PC2</th>
                <th className="px-2 py-1 font-semibold text-right border-r border-slate-800">PC3</th>
                <th className="px-2 py-1 font-semibold text-right border-r border-slate-800">PC4</th>
                <th className="px-2 py-1 font-semibold text-right">PC5</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-850">
              {pcoaResult.coordinates.map((row) => (
                <tr key={row.sample_id} className="hover:bg-slate-800/30">
                  <td className="px-2 py-1 font-mono text-slate-200 font-medium truncate max-w-[120px] border-r border-slate-850" title={row.sample_id}>
                    {row.sample_id}
                  </td>
                  <td className="px-2 py-1 text-right font-mono border-r border-slate-850">{(row.coordinates.PC1 ?? 0).toFixed(4)}</td>
                  <td className="px-2 py-1 text-right font-mono border-r border-slate-850">{(row.coordinates.PC2 ?? 0).toFixed(4)}</td>
                  <td className="px-2 py-1 text-right font-mono border-r border-slate-850">{(row.coordinates.PC3 ?? 0).toFixed(4)}</td>
                  <td className="px-2 py-1 text-right font-mono border-r border-slate-850">{(row.coordinates.PC4 ?? 0).toFixed(4)}</td>
                  <td className="px-2 py-1 text-right font-mono">{(row.coordinates.PC5 ?? 0).toFixed(4)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    )
  }

  const selectedFeatureSamples = useMemo(() => {
    if (!selectedFeature?.present_samples?.length) return []
    const uniq = new globalThis.Map()

    for (const sample of selectedFeature.present_samples) {
      const datasetSafe = String(sample.dataset_safe ?? '').trim()
      const sampleId = String(sample.sample_id ?? '').trim()
      if (!datasetSafe || !sampleId) continue
      const key = `${datasetSafe}::${sampleId}`
      if (!uniq.has(key)) {
        uniq.set(key, {
          dataset: String(sample.dataset ?? 'N/A'),
          dataset_safe: datasetSafe,
          sample_id: sampleId,
        })
      }
    }

    return [...uniq.values()].sort((a, b) => a.sample_id.localeCompare(b.sample_id))
  }, [selectedFeature])

  const focusSampleFromFeatureList = useCallback((sample) => {
    const datasetSafe = String(sample?.dataset_safe ?? '').trim()
    const sampleId = String(sample?.sample_id ?? '').trim()
    if (!datasetSafe || !sampleId) return

    const findMatch = (arr) => (arr ?? []).find((p) => {
      const pDatasetSafe = String(
        p?._dataset_safe
        || mapData?.dataset_safe_map?.[String(p?._dataset ?? '')]
        || ''
      ).trim()
      const pSampleId = String(p?._sample_id || p?.index || p?.filename || '').trim()
      return pDatasetSafe === datasetSafe && pSampleId === sampleId
    })

    const match = findMatch(points) || findMatch(mapData?.points)
    if (!match) return

    setHoverTab('metadata')
    setHoverPoint(match)
    setTooltip({ object: match, x: 24, y: 104 })
    setClickPinned(true)
    setHoverExpanded(true)
    setHoverPanelActive(true)
  }, [mapData, points])

  return (
    <div className="relative w-full h-full">
      {/* Map */}
      <DeckGL
        initialViewState={INITIAL_VIEW}
        controller
        layers={layer ? [layer] : []}
        style={{ width: '100%', height: '100%' }}
        onAfterRender={onAfterRender}
      >
        <MapLibreMap mapStyle={MAP_STYLE} />
      </DeckGL>

      {/* Loading overlay */}
      {(loading || colorBy !== appliedColorBy) && (
        <div className="absolute inset-0 flex items-center justify-center bg-slate-900/60 z-10">
          <div className="flex flex-col items-center gap-3 text-slate-200">
            <RefreshCw size={32} className="animate-spin text-ocean-400" />
            <span className="text-sm">{colorBy !== appliedColorBy ? 'Recoloring points…' : 'Loading samples…'}</span>
          </div>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 bg-red-900/90 border border-red-700 rounded-lg px-4 py-2 flex items-center gap-2 text-red-300 text-sm z-10">
          <AlertTriangle size={14} /> {error}
        </div>
      )}

      {/* No data */}
      {!loading && !error && !points.length && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="bg-slate-800/90 border border-slate-700 rounded-xl px-6 py-4 text-center">
            <p className="text-slate-400 text-sm">No samples to display.</p>
            <p className="text-slate-500 text-xs mt-1">
              {mapData?.points?.length > 0 
                ? 'Try adjusting or clearing your filters (e.g. Dataset, Samples, or Metabolites).'
                : 'Go to Admin → load a dataset with Latitude & Longitude columns.'
              }
            </p>
          </div>
        </div>
      )}

      {/* Stats panel */}
      {mapData && (
        <div className="absolute top-3 left-3 z-10 flex flex-col gap-2">
          <StatsPanel
            datasets={mapData.datasets_details || mapData.datasets || []}
            samples={mapData.total_samples ?? 0}
            features={mapData.total_features ?? 0}
          />
          <button
            onClick={() => setHeatmapOpen(true)}
            className="self-start bg-slate-800/95 hover:bg-slate-700/95 border border-slate-700 rounded-lg px-3 py-1.5 flex items-center gap-1.5 text-xs text-slate-200 hover:text-white transition-all shadow-lg active:scale-[0.98] font-semibold"
          >
            <Grid size={13} className="text-ocean-400" /> View Intensity Heatmap
          </button>
        </div>
      )}

      {/* Top-right controls */}
      <div className="absolute top-3 right-3 z-10 flex items-center gap-2">
        <button
          onClick={() => setAnalysisOpen((o) => !o)}
          className="bg-slate-800/90 border border-slate-700 rounded-lg px-3 py-2 flex items-center gap-2 text-sm text-slate-300 hover:text-slate-100 hover:bg-slate-700/90"
        >
          <BarChart3 size={14} /> Statistical Analysis
        </button>
        <button
          onClick={() => setMetaboliteFilterOpen((o) => !o)}
          className="bg-slate-800/90 border border-slate-700 rounded-lg px-3 py-2 flex items-center gap-2 text-sm text-slate-300 hover:text-slate-100 hover:bg-slate-700/90"
        >
          <Filter size={14} /> Metabolite Filtering
        </button>
        <button
          onClick={() => setFilterOpen((o) => !o)}
          className="bg-slate-800/90 border border-slate-700 rounded-lg px-3 py-2 flex items-center gap-2 text-sm text-slate-300 hover:text-slate-100 hover:bg-slate-700/90"
        >
          <Filter size={14} /> Sample Filtering
        </button>
      </div>

      {selectedFeature && metaboliteSampleKeys.size > 0 && (
        <div className="absolute top-14 right-3 z-10 bg-ocean-900/80 border border-ocean-700 rounded-lg px-3 py-2 text-[11px] text-ocean-100 max-w-md">
          Showing samples for <span className="font-semibold">{selectedFeature.metabolite}</span> ({metaboliteSampleKeys.size.toLocaleString()} samples)
        </div>
      )}

      {/* Global analysis dashboard */}
      {analysisOpen && (
        <div className={`absolute top-12 right-3 z-20 bg-slate-900/95 border border-slate-700 rounded-xl p-4 shadow-xl transition-all duration-300 max-h-[85vh] overflow-y-auto ${
          globalAnalysisOption === 'PCoA' && pcoaDashboardExpanded ? 'w-[60rem]' : 'w-80'
        }`}>
          <div className="flex items-center justify-between pb-3 border-b border-slate-800">
            <div className="flex items-center gap-2">
              <h3 className="font-semibold text-slate-200 text-sm">Statistical Analysis</h3>
              {globalAnalysisOption === 'PCoA' && (
                <button
                  onClick={() => setPcoaDashboardExpanded(!pcoaDashboardExpanded)}
                  className="text-[10px] text-ocean-400 hover:text-ocean-300 bg-ocean-950/40 border border-ocean-800 rounded px-1.5 py-0.5"
                >
                  {pcoaDashboardExpanded ? 'Collapse' : 'Expand'}
                </button>
              )}
            </div>
            <button onClick={() => setAnalysisOpen(false)} className="text-slate-500 hover:text-slate-300">
              <X size={16} />
            </button>
          </div>

          <div className="flex flex-wrap gap-x-4 gap-y-1.5 py-2 border-b border-slate-850">
            {['PCoA', 'Metabolite Boxplots', 'Van Krevelen', 'Carbon Ox State'].map((opt) => (
              <label key={opt} className="flex items-center gap-2 text-[11px] text-slate-200 cursor-pointer">
                <input
                  type="radio"
                  name="global-analysis-option"
                  value={opt}
                  checked={globalAnalysisOption === opt}
                  onChange={() => setGlobalAnalysisOption(opt)}
                  className="accent-ocean-400"
                />
                <span>{opt}</span>
              </label>
            ))}
          </div>

          {globalAnalysisOption === 'PCoA' && pcoaDashboardExpanded ? (
            <div className="grid grid-cols-12 gap-4 mt-3 pt-1">
              {/* Left Column: Filters */}
              <div className="col-span-4 space-y-3 pr-3 border-r border-slate-800">
                <div className="space-y-1">
                  <label className="text-[10px] uppercase tracking-wider font-semibold text-slate-400">Dataset for PCoA</label>
                  <select
                    value={pcoaDatasetSafe}
                    onChange={(e) => setPcoaDatasetSafe(e.target.value)}
                    className="w-full rounded bg-slate-800 border border-slate-700 px-2 py-1 text-xs text-slate-200 focus:outline-none"
                  >
                    <option value="">-- Select a Dataset --</option>
                    {(mapData?.datasets_details || []).map((d) => (
                      <option key={d.safe_name} value={d.safe_name}>{d.name}</option>
                    ))}
                  </select>
                </div>

                <div className="space-y-1">
                  <label className="text-[10px] uppercase tracking-wider font-semibold text-slate-400">Distance matrix</label>
                  <select
                    value={pcoaDistanceMetric}
                    onChange={(e) => setPcoaDistanceMetric(e.target.value)}
                    className="w-full rounded bg-slate-800 border border-slate-700 px-2 py-1 text-xs text-slate-200 focus:outline-none"
                  >
                    {["braycurtis", "canberra", "chebyshev", "cityblock", "correlation", "cosine", "euclidean", "hamming", "jaccard", "matching", "minkowski", "seuclidean", "sqeuclidean"].map((m) => (
                      <option key={m} value={m}>{m}</option>
                    ))}
                  </select>
                </div>

                <div className="space-y-1">
                  <label className="text-[10px] uppercase tracking-wider font-semibold text-slate-400">Attribute for Filtering</label>
                  <select
                    value={pcoaAttribute}
                    onChange={(e) => handleAttributeChange(e.target.value)}
                    className="w-full rounded bg-slate-800 border border-slate-700 px-2 py-1 text-xs text-slate-200 focus:outline-none"
                  >
                    <option value="">-- Select Attribute --</option>
                    {(pcoaMetadataColumns || []).map((col) => (
                      <option key={col} value={col}>{col}</option>
                    ))}
                  </select>
                </div>

                {(pcoaAllCategories || []).length > 0 && (
                  <div className="space-y-1">
                    <div className="flex items-center justify-between pb-1 border-b border-slate-800">
                      <label className="text-[10px] uppercase tracking-wider font-semibold text-slate-400">
                        Group Filtering & Sample Removal
                      </label>
                      <button
                        onClick={() => {
                          setPcoaCategories(pcoaAllCategories)
                          setPcoaSamples(pcoaAllSamples.map(s => s.sample_id))
                        }}
                        className="text-[9px] text-ocean-400 hover:text-ocean-300"
                      >
                        Reset All Selection
                      </button>
                    </div>
                    
                    <div className="max-h-60 overflow-y-auto border border-slate-800 rounded bg-slate-950 p-1.5 space-y-2">
                      {(pcoaAllCategories || []).map((cat) => {
                        const samplesInCat = pcoaSamplesByGroup[cat] || []
                        const selectedSamplesInCat = samplesInCat.filter(s => pcoaSamples.includes(s.sample_id))
                        const isCatChecked = pcoaCategories.includes(cat)
                        const isExpanded = !!expandedGroups[cat]
                        const searchVal = sampleGroupSearch[cat] || ""
                        
                        const filteredSamples = samplesInCat.filter(s => 
                          !searchVal || s.sample_id.toLowerCase().includes(searchVal.toLowerCase())
                        )

                        return (
                          <div key={cat} className="border border-slate-850 rounded p-1.5 bg-slate-900/20 space-y-1.5">
                            {/* Group Header */}
                            <div className="flex items-center justify-between">
                              <label className="flex items-center gap-2 text-xs text-slate-200 cursor-pointer select-none min-w-0 flex-1">
                                <input
                                  type="checkbox"
                                  checked={isCatChecked}
                                  onChange={(e) => toggleCategorySelection(cat, e.target.checked)}
                                  className="rounded accent-ocean-500"
                                />
                                <span className="font-medium truncate text-[11px]" title={cat}>
                                  {cat}
                                </span>
                                <span className="text-[10px] text-slate-500 shrink-0">
                                  ({selectedSamplesInCat.length}/{samplesInCat.length})
                                </span>
                              </label>
                              
                              <button
                                onClick={() => setExpandedGroups(prev => ({ ...prev, [cat]: !prev[cat] }))}
                                className="text-[10px] text-slate-400 hover:text-slate-200 px-1.5 py-0.5 rounded bg-slate-800 hover:bg-slate-700/60 ml-2"
                              >
                                {isExpanded ? 'Hide Samples' : 'Show Samples'}
                              </button>
                            </div>

                            {/* Nested Expandable Sample List */}
                            {isExpanded && (
                              <div className="pl-4 pt-1 border-l border-slate-800 space-y-1.5">
                                <div className="flex items-center gap-1.5">
                                  <input
                                    type="text"
                                    placeholder="Search samples in group..."
                                    value={searchVal}
                                    onChange={(e) => setSampleGroupSearch(prev => ({ ...prev, [cat]: e.target.value }))}
                                    className="flex-1 rounded bg-slate-800 border border-slate-700 px-1.5 py-0.5 text-[10px] text-slate-200 focus:outline-none placeholder:text-slate-500"
                                  />
                                  <button
                                    onClick={() => toggleAllSamplesInCategory(cat, true)}
                                    className="text-[9px] bg-slate-800 hover:bg-slate-700 px-1 py-0.5 rounded text-slate-400 hover:text-slate-200"
                                  >
                                    All
                                  </button>
                                  <button
                                    onClick={() => toggleAllSamplesInCategory(cat, false)}
                                    className="text-[9px] bg-slate-800 hover:bg-slate-700 px-1 py-0.5 rounded text-slate-400 hover:text-slate-200"
                                  >
                                    None
                                  </button>
                                </div>

                                {/* Checklist */}
                                <div className="max-h-24 overflow-y-auto space-y-0.5 border border-slate-800/50 rounded bg-slate-950/40 p-1">
                                  {filteredSamples.length === 0 ? (
                                    <span className="text-[10px] text-slate-500 italic block py-0.5">No matching samples</span>
                                  ) : (
                                    filteredSamples.map((sample) => {
                                      const isSampleChecked = pcoaSamples.includes(sample.sample_id)
                                      return (
                                        <label key={sample.sample_id} className="flex items-center gap-1.5 text-[10px] text-slate-300 cursor-pointer select-none hover:bg-slate-800/20 py-0.5 px-1 rounded truncate">
                                          <input
                                            type="checkbox"
                                            checked={isSampleChecked}
                                            onChange={() => toggleSampleSelection(sample.sample_id)}
                                            className="rounded scale-75 accent-ocean-500"
                                          />
                                          <span className="font-mono truncate" title={sample.sample_id}>
                                            {sample.sample_id}
                                          </span>
                                        </label>
                                      )
                                    })
                                  )}
                                </div>
                              </div>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )}

                <div className="space-y-1">
                  <label className="text-[10px] uppercase tracking-wider font-semibold text-slate-400">Color By (PERMANOVA grouping)</label>
                  <select
                    value={pcoaColorBy}
                    onChange={(e) => setPcoaColorBy(e.target.value)}
                    className="w-full rounded bg-slate-800 border border-slate-700 px-2 py-1 text-xs text-slate-200 focus:outline-none"
                  >
                    <option value="">-- Select Color By --</option>
                    {(pcoaMetadataColumns || []).map((col) => (
                      <option key={col} value={col}>{col}</option>
                    ))}
                  </select>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1">
                    <label className="text-[10px] uppercase tracking-wider font-semibold text-slate-400">X-Axis</label>
                    <select
                      value={pcoaXAxis}
                      onChange={(e) => setPcoaXAxis(e.target.value)}
                      className="w-full rounded bg-slate-800 border border-slate-700 px-2 py-1 text-xs text-slate-200 focus:outline-none"
                    >
                      {Array.from({ length: pcoaResult?.proportion_explained?.length || 2 }).map((_, i) => (
                        <option key={i} value={`PC${i+1}`}>PC{i+1}</option>
                      ))}
                    </select>
                  </div>
                  <div className="space-y-1">
                    <label className="text-[10px] uppercase tracking-wider font-semibold text-slate-400">Y-Axis</label>
                    <select
                      value={pcoaYAxis}
                      onChange={(e) => setPcoaYAxis(e.target.value)}
                      className="w-full rounded bg-slate-800 border border-slate-700 px-2 py-1 text-xs text-slate-200 focus:outline-none"
                    >
                      {Array.from({ length: pcoaResult?.proportion_explained?.length || 2 }).map((_, i) => (
                        <option key={i} value={`PC${i+1}`}>PC{i+1}</option>
                      ))}
                    </select>
                  </div>
                </div>

                <button
                  onClick={runPcoaAnalysis}
                  className="w-full bg-ocean-700 hover:bg-ocean-600 text-white rounded py-1.5 text-xs font-semibold transition-colors flex items-center justify-center gap-1.5"
                  disabled={pcoaLoading}
                >
                  {pcoaLoading ? <RefreshCw size={12} className="animate-spin" /> : null}
                  Calculate PCoA
                </button>
              </div>

              {/* Right Column: Graphs */}
              <div className="col-span-8 space-y-3 pl-1">
                {pcoaResult ? (
                  <>
                    {/* Tabs */}
                    <div className="flex border-b border-slate-800 text-[11px] font-medium text-slate-400">
                      {[
                        { id: 'plot', label: 'Scatter Plot' },
                        { id: 'variance', label: 'Explained Variance' },
                        { id: 'data', label: 'Coordinates Data' },
                      ].map((t) => (
                        <button
                          key={t.id}
                          onClick={() => setPcoaActiveTab(t.id)}
                          className={`px-3 py-1.5 border-b-2 transition-colors ${
                            pcoaActiveTab === t.id
                              ? 'border-ocean-500 text-ocean-400 font-semibold'
                              : 'border-transparent hover:text-slate-200'
                          }`}
                        >
                          {t.label}
                        </button>
                      ))}
                    </div>

                    {/* Tab Content area */}
                    {pcoaLoading ? (
                      <div className="flex flex-col items-center justify-center py-24 text-slate-400 gap-2">
                        <RefreshCw className="animate-spin text-ocean-500" size={24} />
                        <span className="text-xs">Running multivariate scaling calculations...</span>
                      </div>
                    ) : pcoaError ? (
                      <div className="rounded bg-red-950/20 border border-red-900/40 p-4 text-xs text-red-400 flex items-start gap-2">
                        <AlertTriangle size={16} className="mt-0.5 flex-shrink-0" />
                        <div>{pcoaError}</div>
                      </div>
                    ) : (
                      <div>
                        {pcoaActiveTab === 'plot' && renderPcoaScatterPlot()}
                        {pcoaActiveTab === 'variance' && renderVarianceBarChart()}
                        {pcoaActiveTab === 'data' && renderCoordinatesData()}
                      </div>
                    )}
                  </>
                ) : (
                  <div className="flex flex-col items-center justify-center py-24 border border-dashed border-slate-800 rounded-lg bg-slate-950/50">
                    <BarChart3 size={32} className="text-slate-650 mb-3" />
                    <h4 className="text-xs font-semibold text-slate-300">PCoA Analysis is ready to run</h4>
                    <p className="text-[10px] text-slate-500 mt-1 max-w-xs text-center">
                      Configure your settings on the left pane and click <strong className="text-ocean-400">Calculate PCoA</strong> to generate coordinate plots, explained variance, and data matrices.
                    </p>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="space-y-3 mt-2">
              {globalAnalysisOption === 'PCoA' ? (
                <div className="text-center py-6">
                  <p className="text-xs text-slate-400">PCoA analysis is active but collapsed.</p>
                  <button
                    onClick={() => setPcoaDashboardExpanded(true)}
                    className="mt-2 rounded bg-ocean-700 hover:bg-ocean-600 px-3 py-1.5 text-xs text-white"
                  >
                    Expand PCoA Dashboard
                  </button>
                </div>
              ) : (
                <div className="rounded bg-yellow-900/20 border border-yellow-700/40 px-2 py-1.5 text-[10px] text-yellow-300">
                  <strong>{globalAnalysisOption}</strong> dashboard view is ready. Plot rendering can be connected next.
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Metabolite filter dashboard */}
      {metaboliteFilterOpen && (
        <div className="absolute top-12 right-[10.75rem] z-10 w-96 bg-slate-900/95 border border-slate-700 rounded-xl p-4 space-y-3 max-h-[80vh] overflow-y-auto shadow-xl">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold text-slate-200 text-sm">Metabolite Filtering</h3>
            <button onClick={() => setMetaboliteFilterOpen(false)} className="text-slate-500 hover:text-slate-300">
              <X size={16} />
            </button>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <input
              value={metaboliteQuery.row_id}
              onChange={(e) => setMetaboliteQuery((q) => ({ ...q, row_id: e.target.value }))}
              placeholder="row ID"
              className="rounded bg-slate-800 border border-slate-700 px-2 py-1.5 text-[11px] text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-ocean-500"
            />
            <input
              value={metaboliteQuery.row_retention_time}
              onChange={(e) => setMetaboliteQuery((q) => ({ ...q, row_retention_time: e.target.value }))}
              placeholder="row retention time"
              className="rounded bg-slate-800 border border-slate-700 px-2 py-1.5 text-[11px] text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-ocean-500"
            />
            <input
              value={metaboliteQuery.row_mz}
              onChange={(e) => setMetaboliteQuery((q) => ({ ...q, row_mz: e.target.value }))}
              placeholder="row m/z"
              className="rounded bg-slate-800 border border-slate-700 px-2 py-1.5 text-[11px] text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-ocean-500"
            />
            <input
              value={metaboliteQuery.annotation}
              onChange={(e) => setMetaboliteQuery((q) => ({ ...q, annotation: e.target.value }))}
              placeholder="annotation / name"
              className="rounded bg-slate-800 border border-slate-700 px-2 py-1.5 text-[11px] text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-ocean-500"
            />
          </div>

          <input
            value={metaboliteQuery.metabolite}
            onChange={(e) => setMetaboliteQuery((q) => ({ ...q, metabolite: e.target.value }))}
            placeholder="metabolite key contains..."
            className="w-full rounded bg-slate-800 border border-slate-700 px-2 py-1.5 text-[11px] text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-ocean-500"
          />

          <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer hover:bg-slate-800/30 p-1 rounded transition-colors select-none">
            <input
              type="checkbox"
              checked={!!metaboliteQuery.has_annotation}
              onChange={(e) => setMetaboliteQuery((q) => ({ ...q, has_annotation: e.target.checked }))}
              className="rounded"
            />
            <span className="text-[11px] text-slate-300">Only show annotated metabolites</span>
          </label>

          <div className="flex items-center gap-2">
            <button
              onClick={runMetaboliteFilter}
              className="rounded bg-ocean-700 hover:bg-ocean-600 px-3 py-1.5 text-[11px] text-white"
            >
              {metaboliteMatchesLoading ? 'Filtering...' : 'Run Filter'}
            </button>
            <button
              onClick={() => {
                setMetaboliteQuery({ row_id: '', row_retention_time: '', row_mz: '', annotation: '', metabolite: '', has_annotation: false })
                setMetaboliteMatches([])
                setMetaboliteMatchesError('')
              }}
              className="rounded border border-slate-700 px-3 py-1.5 text-[11px] text-slate-300 hover:text-slate-100"
            >
              Clear Query
            </button>
            <button
              onClick={clearFeatureMapFilter}
              className="rounded border border-slate-700 px-3 py-1.5 text-[11px] text-slate-300 hover:text-slate-100"
            >
              Show All Samples
            </button>
          </div>

          {metaboliteMatchesError && (
            <p className="text-[11px] text-red-300">{metaboliteMatchesError}</p>
          )}

          <div className="text-[11px] text-slate-400">
            {metaboliteMatchesLoading ? 'Loading feature matches...' : `${metaboliteMatches.length.toLocaleString()} matching features`}
          </div>

          <div className="space-y-1 max-h-[46vh] overflow-y-auto border border-slate-800 rounded p-2">
            {metaboliteMatches.length === 0 && !metaboliteMatchesLoading ? (
              <p className="text-[11px] text-slate-500">No metabolite features match current filters.</p>
            ) : metaboliteMatches.map((feature) => {
              const isSelected = selectedFeature?.metabolite === feature.metabolite && selectedFeature?.dataset_safe === feature.dataset_safe;
              return (
                <div
                  key={`${feature.dataset_safe}::${feature.metabolite}`}
                  className={`border-b border-slate-800 py-2 px-1.5 rounded transition-colors ${
                    isSelected ? 'bg-ocean-950/40 border-ocean-800' : ''
                  }`}
                >
                  <button
                    onClick={() => applyFeatureMapFilter(feature)}
                    className="text-[11px] text-slate-200 font-semibold break-all text-left hover:text-ocean-400 hover:underline transition-colors w-full focus:outline-none"
                    title="Click to select metabolite and see present samples"
                  >
                    {feature.metabolite}
                  </button>
                  <p className="text-[10px] text-slate-400 mt-1">
                    row ID: {feature.row_id} | m/z: {formatMz(feature.row_mz)} | RT: {formatRt(feature.row_retention_time)}
                  </p>
                  <p className="text-[10px] text-slate-400">{feature.annotation ?? 'No annotation'} • {feature.sample_count} samples</p>
                  
                  {isSelected && (
                    <div className="mt-2 pl-2 border-l-2 border-ocean-600 space-y-1">
                      <p className="text-[10px] font-semibold text-slate-300">Samples containing this metabolite:</p>
                      <div className="max-h-36 overflow-y-auto space-y-0.5 border border-slate-800/60 rounded px-1.5 py-1 bg-slate-900/40">
                        {(feature.present_samples ?? []).map((s) => (
                          <div
                            key={`${s.dataset_safe}::${s.sample_id}`}
                            className="text-[10px] text-slate-300 flex items-center justify-between border-b border-slate-800/40 py-0.5"
                          >
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                focusSampleFromFeatureList({ ...s, dataset: feature.dataset });
                              }}
                              className="truncate pr-2 text-left text-ocean-300 hover:text-ocean-100"
                              title="Focus this sample on map"
                            >
                              {s.sample_id}
                            </button>
                            <span className="text-[9px] text-slate-500 truncate max-w-[80px]" title={feature.dataset}>
                              {feature.dataset}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  <div className="flex gap-2 mt-1">
                    <button
                      onClick={() => applyFeatureMapFilter(feature)}
                      className="rounded border border-ocean-700 px-2 py-0.5 text-[10px] text-ocean-300 hover:text-ocean-100"
                    >
                      Show Samples On Map
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Filter sidebar */}
      {filterOpen && (
        <div className="absolute top-12 right-3 z-10 w-72 bg-slate-900/95 border border-slate-700 rounded-xl p-4 space-y-4 max-h-[80vh] overflow-y-auto shadow-xl">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold text-slate-200 text-sm">Sample Filtering</h3>
            <button onClick={() => setFilterOpen(false)} className="text-slate-500 hover:text-slate-300">
              <X size={16} />
            </button>
          </div>
          {filterCols.length > 1 && (
            <p className="text-[10px] text-slate-500 -mt-2">
              {datasetFilter.size > 0
                ? `Common columns across ${datasetFilter.size} selected dataset${datasetFilter.size !== 1 ? 's' : ''}`
                : mapData?.datasets?.length > 1
                  ? `Common columns across all ${mapData.datasets.length} datasets`
                  : `Columns for this dataset`
              }
            </p>
          )}

          {/* Dataset section - rendered specifically first at the top */}
          {filterCols.includes('_dataset') && (() => {
            const activeFilters = filters['_dataset'] ?? new Set()
            return (
              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <p className="text-xs text-slate-400 font-medium">Dataset</p>
                  {activeFilters.size > 0 && (
                    <button onClick={() => clearFilter('_dataset')} className="text-xs text-ocean-400 hover:text-ocean-300">Clear</button>
                  )}
                </div>
                <div className="max-h-32 overflow-y-auto space-y-0.5">
                  {(columnValues['_dataset'] ?? []).map((v) => {
                    const datasetInfo = (mapData?.datasets_details ?? []).find(
                      (d) => String(d.name) === String(v)
                    )
                    return (
                      <label key={v} className="flex items-start gap-2 text-xs text-slate-300 cursor-pointer hover:bg-slate-800/30 p-1 rounded transition-colors">
                        <input
                          type="checkbox"
                          checked={activeFilters.has(v)}
                          onChange={() => toggleFilter('_dataset', v)}
                          className="rounded mt-0.5"
                        />
                        <div className="flex flex-col min-w-0 flex-1">
                          <span className="truncate font-medium text-slate-200" title={v}>{v}</span>
                          {datasetInfo && (
                            <span className="text-[10px] text-slate-400">
                              {datasetInfo.n_samples?.toLocaleString() ?? 0} samples • {datasetInfo.n_features?.toLocaleString() ?? 0} features
                            </span>
                          )}
                        </div>
                      </label>
                    )
                  })}
                </div>
              </div>
            )
          })()}

          {/* Sample Specific search/filter listing (rendered specifically second at the top) */}
          {mapData?.points && (
            <div className="space-y-2 border-t border-slate-800 pt-3">
              <div className="flex items-center justify-between">
                <p className="text-xs text-slate-400 font-medium">Individual Samples</p>
                {selectedSamples.size > 0 && (
                  <button
                    onClick={() => setSelectedSamples(new Set())}
                    className="text-xs text-ocean-400 hover:text-ocean-300"
                  >
                    Clear ({selectedSamples.size})
                  </button>
                )}
              </div>
              <input
                type="text"
                value={sampleSearch}
                onChange={(e) => setSampleSearch(e.target.value)}
                placeholder="Search sample filename..."
                className="w-full rounded bg-slate-800 border border-slate-700 px-2 py-1 text-xs text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-ocean-500"
              />
              <div className="max-h-40 overflow-y-auto space-y-1 pr-1 border border-slate-800 rounded p-1.5 bg-slate-950/20">
                {(() => {
                  const query = sampleSearch.trim().toLowerCase()
                  // Get points scoped by the currently selected dataset filters
                  const filteredList = datasetScopedPoints.filter((p) => {
                    const name = String(p._sample_id || p.index || p.filename || '')
                    return !query || name.toLowerCase().includes(query)
                  })

                  if (filteredList.length === 0) {
                    return <p className="text-[10px] text-slate-500 py-1 italic">No samples match search.</p>
                  }

                  return filteredList.map((p) => {
                    const sampleId = String(p._sample_id || p.index || p.filename || '').trim()
                    const datasetSafe = String(
                      p._dataset_safe
                      || mapData?.dataset_safe_map?.[String(p._dataset ?? '')]
                      || ''
                    ).trim()
                    const sampleKey = `${datasetSafe}::${sampleId}`
                    const isChecked = selectedSamples.has(sampleKey)

                    return (
                      <div key={sampleKey} className="flex items-center gap-1 text-xs text-slate-300 py-0.5 border-b border-slate-800/40 last:border-0">
                        <label className="flex items-center gap-2 cursor-pointer truncate min-w-0 flex-1">
                          <input
                            type="checkbox"
                            checked={isChecked}
                            onChange={() => {
                              setSelectedSamples((prev) => {
                                const next = new Set(prev)
                                if (next.has(sampleKey)) {
                                  next.delete(sampleKey)
                                } else {
                                  next.add(sampleKey)
                                }
                                return next
                              })
                            }}
                            className="rounded shrink-0"
                          />
                          <span className="truncate" title={sampleId}>{sampleId}</span>
                        </label>
                      </div>
                    )
                  })
                })()}
              </div>
            </div>
          )}

          {/* Filters per metadata column (rendered below the dataset & sample filter sections) */}
          {filterCols.map((col) => {
            const activeFilters = filters[col] ?? new Set()
            
            // Only render non-dataset and non-filename columns here; dataset and individual samples are already handled at the top
            if (col === '_dataset' || col.toLowerCase() === 'filename') return null;

            return (
              <div key={col} className="space-y-1 border-t border-slate-800 pt-3">
                <div className="flex items-center justify-between">
                  <p className="text-xs text-slate-400 font-medium">{col}</p>
                  {activeFilters.size > 0 && (
                    <button onClick={() => clearFilter(col)} className="text-xs text-ocean-400 hover:text-ocean-300">Clear</button>
                  )}
                </div>
                <div className="max-h-32 overflow-y-auto space-y-0.5">
                  {(columnValues[col] ?? []).map((v) => (
                    <label key={v} className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={activeFilters.has(v)}
                        onChange={() => toggleFilter(col, v)}
                        className="rounded"
                      />
                      <span className="truncate">{v}</span>
                    </label>
                  ))}
                </div>
              </div>
            )
          })}

          <button
            onClick={() => {
              setFilters({})
              setSelectedSamples(new Set())
              setSampleSearch('')
            }}
            className="w-full text-xs text-slate-400 hover:text-slate-200 py-1 border border-slate-700 rounded"
          >
            Clear All Filters
          </button>
        </div>
      )}

      {/* Floating legend */}
      {colorBy && columnValues[colorBy] && columnValues[colorBy].length > 0 && (
        <div
          ref={legendRef}
          className="absolute z-20 w-72 bg-slate-900/95 border border-slate-700 rounded-xl shadow-xl"
          style={legendPos}
        >
          <div
            onMouseDown={beginLegendDrag}
            className={`px-3 py-2 border-b border-slate-700 flex items-center justify-between cursor-move ${legendDragging ? 'select-none' : ''}`}
          >
            <p className="text-xs text-slate-300 font-semibold">Legend ({colorBy})</p>
            <span className="text-[10px] text-slate-500">drag</span>
          </div>
          <div className="p-3 max-h-40 overflow-y-auto space-y-1">
            {columnValues[colorBy].slice(0, 24).map((val) => {
              const [r, g, b] = colorLookup.get(val) ?? strColor(val)
              return (
                <div key={val} className="flex items-center gap-2 text-xs text-slate-300">
                  <span className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: `rgb(${r},${g},${b})` }} />
                  <span className="truncate">{val}</span>
                </div>
              )
            })}
            {columnValues[colorBy].length > 24 && (
              <p className="text-xs text-slate-500">+{columnValues[colorBy].length - 24} more…</p>
            )}
          </div>
        </div>
      )}

      {/* Hover metadata tooltip */}
      {hoverSummary && (
        <div
          className={`absolute z-40 bg-slate-900/95 border border-slate-700 rounded-lg px-3 py-2 shadow-xl overflow-auto ${
            hoverExpanded ? 'resize' : ''
          }`}
          style={clickPinned
            ? { left: 12, bottom: 12, width: '42rem', maxWidth: '90vw', minWidth: '18rem', minHeight: '12rem', maxHeight: '90vh' }
            : {
                left: Math.min((tooltip?.x ?? 0) + 14, (typeof window !== 'undefined' ? window.innerWidth : 1200) - (hoverExpanded ? 680 : 390)),
                top: Math.max((tooltip?.y ?? 0) - 12, 64),
                width: hoverExpanded ? '42rem' : '24rem',
                maxWidth: '90vw',
                ...(hoverExpanded ? { minWidth: '18rem', minHeight: '12rem', maxHeight: '90vh' } : {}),
              }
          }
          onMouseEnter={() => {
            if (hoverClearTimeoutRef.current) {
              clearTimeout(hoverClearTimeoutRef.current)
              hoverClearTimeoutRef.current = null
            }
            setHoverPanelActive(true)
          }}
          onMouseLeave={() => {
            setHoverPanelActive(false)
            if (!clickPinned) {
              setHoverPoint(null)
              setTooltip(null)
            }
          }}
        >
          <div className="mb-2 flex items-center justify-between border-b border-slate-700">
            <div className="flex gap-1">
            {[
              { key: 'metadata', label: 'Metadata' },
              { key: 'metabolites', label: 'Metabolites' },
            ].map((tab) => (
              <button
                key={tab.key}
                onClick={() => setHoverTab(tab.key)}
                className={`px-3 py-1.5 text-xs rounded-t transition-colors ${
                  hoverTab === tab.key
                    ? 'bg-slate-800 text-slate-100 border-b-2 border-ocean-500'
                    : 'text-slate-500 hover:text-slate-300'
                }`}
              >
                {tab.label}
              </button>
            ))}
            </div>
            <button
              onClick={() => {
                setHoverExpanded((e) => !e)
                if (hoverExpanded) {
                  setClickPinned(false)
                  setHoverPoint(null)
                  setTooltip(null)
                }
              }}
              className="ml-2 mb-1 shrink-0 text-[10px] px-2 py-0.5 rounded bg-slate-800 text-slate-400 hover:text-slate-200 hover:bg-slate-700"
              title={hoverExpanded ? 'Collapse' : 'Expand'}
            >
              {hoverExpanded ? '⊟ Collapse' : '⊞ Expand'}
            </button>
          </div>

          {hoverTab === 'metadata' && (
            <div className="space-y-1">
              <div className="pb-1.5 mb-1.5 border-b border-slate-800">
                <p className="text-[11px] text-slate-200">
                  <span className="text-ocean-400 font-semibold">Sample Filename:</span>{' '}
                  <span className="font-mono bg-slate-950/40 px-1.5 py-0.5 rounded text-slate-100">
                    {resolveSampleId(hoverPoint) || 'N/A'}
                  </span>
                </p>
              </div>
              {hoverSummary.metadata.length > 0 ? (
                <div className={`space-y-0.5 overflow-y-auto ${hoverExpanded ? 'max-h-[60vh]' : 'max-h-56'}`}>
                  {hoverSummary.metadata.map(([k, v]) => (
                    <p key={k} className="text-[10px] text-slate-300 truncate">
                      <span className="text-slate-500">{k}:</span> {String(v)}
                    </p>
                  ))}
                </div>
              ) : (
                <p className="text-[10px] text-slate-400">No metadata available for this sample.</p>
              )}
            </div>
          )}

          {hoverTab === 'metabolites' && (
            <div className="flex flex-col gap-1.5">
              {hoverMetabolitesLoading && (
                <div className="flex items-center gap-2 text-slate-300 text-xs">
                  <RefreshCw size={12} className="animate-spin text-ocean-400" /> Loading metabolites…
                </div>
              )}
              {!hoverMetabolitesLoading && hoverMetabolites.length > 0 && (() => {
                const searchLower = metaboliteSearchDebounced.toLowerCase()
                const filtered = hoverMetabolites.filter((m) =>
                  !searchLower
                  || (m.label ?? '').toLowerCase().includes(searchLower)
                  || (m.annotation ?? '').toLowerCase().includes(searchLower)
                  || (m.metabolite ?? '').toLowerCase().includes(searchLower)
                )
                return (
                  <>
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] text-slate-400">
                        {filtered.length} of {hoverMetabolites.length} feature{hoverMetabolites.length !== 1 ? 's' : ''}
                        {metaboliteSearchDebounced ? ' match' : ''}
                      </span>
                    </div>
                    <input
                      type="text"
                      placeholder="Search by feature ID or annotation…"
                      value={metaboliteSearch}
                      onChange={(e) => {
                        const val = e.target.value
                        setMetaboliteSearch(val)
                        if (metaboliteSearchTimerRef.current) clearTimeout(metaboliteSearchTimerRef.current)
                        metaboliteSearchTimerRef.current = setTimeout(() => setMetaboliteSearchDebounced(val), 120)
                      }}
                      className="w-full rounded bg-slate-800 border border-slate-700 px-2 py-1 text-[10px] text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-ocean-500"
                    />
                    {/* Column headers */}
                    <div className="grid grid-cols-[1fr_auto] gap-2 px-0.5 pb-0.5 border-b border-slate-600">
                      <span className="text-[9px] font-semibold uppercase tracking-wide text-slate-500">
                        Feature ID · Annotation (if available)
                      </span>
                      <span className="text-[9px] font-semibold uppercase tracking-wide text-slate-500 text-right whitespace-nowrap">
                        Intensity
                      </span>
                    </div>
                    <div className={`overflow-y-auto space-y-0.5 ${hoverExpanded ? 'max-h-[52vh]' : 'max-h-44'}`}>
                      {filtered.length === 0 ? (
                        <p className="text-[10px] text-slate-400 py-1">No features match your search.</p>
                      ) : filtered.map((m, idx) => (
                        <div key={`${m.metabolite ?? 'met'}-${idx}`} className="grid grid-cols-[1fr_auto] gap-2 py-0.5 border-b border-slate-800">
                          <span className="text-[10px] text-slate-200 break-all leading-tight">
                            {m.annotation
                              ? <><span className="text-slate-400">{m.metabolite}</span> · <span className="text-ocean-300">{m.annotation}</span></>
                              : <span>{m.metabolite}</span>
                            }
                          </span>
                          <span className="text-[10px] text-slate-400 tabular-nums whitespace-nowrap">
                            {m.intensity == null ? 'N/A' : m.intensity.toExponential(2)}
                          </span>
                        </div>
                      ))}
                    </div>
                  </>
                )
              })()}
              {!hoverMetabolitesLoading && hoverMetabolites.length === 0 && (
                <p className="text-[10px] text-slate-400">No metabolites available for this sample.</p>
              )}
            </div>
          )}
        </div>
      )}

      {/* Heatmap Overlay Modal */}
      {heatmapOpen && (
        <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm z-50 flex items-center justify-center p-4 animate-fade-in">
          <div className="bg-slate-900 border border-slate-700 rounded-xl w-[32rem] max-w-full p-6 shadow-2xl flex flex-col gap-4 text-center">
            {/* Modal Header */}
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <div className="flex items-center gap-2">
                <Grid className="text-ocean-400 animate-pulse" size={18} />
                <h3 className="font-semibold text-slate-200 text-sm tracking-wide">
                  Dataset Intensity Heatmap
                </h3>
              </div>
              <button
                onClick={() => setHeatmapOpen(false)}
                className="text-slate-500 hover:text-slate-300 transition-colors"
              >
                <X size={18} />
              </button>
            </div>

            {/* Modal Content - Work in Progress Indicator */}
            <div className="py-8 flex flex-col items-center justify-center gap-4">
              <div className="w-14 h-14 rounded-full bg-ocean-950/50 border border-ocean-700/60 flex items-center justify-center text-ocean-400">
                <RefreshCw size={24} className="animate-spin" />
              </div>
              <div className="space-y-1">
                <h4 className="font-bold text-slate-200 text-sm">Feature in Progress</h4>
                <p className="text-slate-400 text-xs max-w-sm leading-relaxed">
                  The high-resolution hierarchical clustering heatmap calculations and visualizations are currently being optimized for large-scale marine dissolved organic matter datasets.
                </p>
              </div>
            </div>

            {/* Modal Footer */}
            <div className="border-t border-slate-800 pt-3.5 flex justify-end">
              <button
                onClick={() => setHeatmapOpen(false)}
                className="bg-slate-800 hover:bg-slate-700 text-slate-200 hover:text-white rounded-lg px-4 py-1.5 text-xs font-semibold transition-colors"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
