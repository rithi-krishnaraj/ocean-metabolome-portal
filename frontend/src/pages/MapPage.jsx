import { useEffect, useState, useMemo, useCallback, useRef } from 'react'
import DeckGL from '@deck.gl/react'
import { ScatterplotLayer } from '@deck.gl/layers'
import MapLibreMap from 'react-map-gl/maplibre'
import 'maplibre-gl/dist/maplibre-gl.css'
import StatsPanel from '../components/StatsPanel'
import Plot from 'react-plotly.js'
import { 
  getMapData, 
  getMapSampleDetails, 
  getMetaboliteFeatureMatches, 
  getDatasetMetadataSchema, 
  runMapPcoa,
  getDatasetMetabolites,
  getBoxplotData,
  getVanKrevelenData,
  getCarbonOxStateData,
  getFormulaCoverage,
  runDatasetAnnotation,
  getUnannotatedCount
} from '../api'
import { Filter, X, RefreshCw, AlertTriangle, BarChart3, Grid, Layers, Sliders, Flame, ChevronDown, ChevronRight } from 'lucide-react'

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

// Sequential cool→warm ramp for intensity; returns [r, g, b] for t in [0, 1].
function intensityRamp(t) {
  const clamped = Math.max(0, Math.min(1, t))
  // Cool blue (#3b82f6) → cyan → yellow → warm red (#ef4444)
  const stops = [
    [0.0, [59, 130, 246]],
    [0.35, [34, 211, 238]],
    [0.65, [250, 204, 21]],
    [1.0, [239, 68, 68]],
  ]
  let lower = stops[0]
  let upper = stops[stops.length - 1]
  for (let i = 0; i < stops.length - 1; i++) {
    if (clamped >= stops[i][0] && clamped <= stops[i + 1][0]) {
      lower = stops[i]
      upper = stops[i + 1]
      break
    }
  }
  const range = upper[0] - lower[0]
  if (range === 0) return lower[1]
  const localT = (clamped - lower[0]) / range
  return lower[1].map((c, i) => Math.round(c + (upper[1][i] - c) * localT))
}

function getIntensityScaleValue(intensity, scale) {
  const num = Number(intensity)
  if (!Number.isFinite(num) || num < 0) return null
  if (num === 0) return 'zero'
  if (scale === 'log') return Math.log10(num)
  return num
}

function getPointSampleKey(p, datasetSafeMap) {
  const sampleId = String(p._sample_id || p.index || p.filename || '').trim()
  const datasetSafe = String(
    p._dataset_safe
    || datasetSafeMap?.[String(p._dataset ?? '')]
    || ''
  ).trim()
  if (!datasetSafe || !sampleId) return null
  return `${datasetSafe}::${sampleId}`
}

function describeActiveSampleFilters(filters, selectedSamples, sampleSearch) {
  const parts = []
  for (const [col, values] of Object.entries(filters)) {
    if (!values || values.size === 0) continue
    const label = col === '_dataset' ? 'Dataset' : col
    const joined = [...values].slice(0, 3).join(', ')
    const more = values.size > 3 ? ` +${values.size - 3} more` : ''
    parts.push(`${label}: ${joined}${more}`)
  }
  if (selectedSamples.size > 0) {
    parts.push(`Samples: ${selectedSamples.size} selected`)
  }
  if (sampleSearch.trim()) {
    parts.push(`Search: "${sampleSearch.trim()}"`)
  }
  return parts.length ? parts.join('; ') : 'none'
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
  const [mapFeature, setMapFeature] = useState(null)
  const [metaboliteSampleKeys, setMetaboliteSampleKeys] = useState(new Set())
  const [intensityScale, setIntensityScale] = useState('log')
  const metaboliteSearchTimerRef = useRef(null)

  // Filters
  const [filters, setFilters] = useState({})
  const [sampleSearch, setSampleSearch] = useState('')
  const [selectedSamples, setSelectedSamples] = useState(new Set())
  const [filterOpen, setFilterOpen] = useState(false)
  const [collapsedSections, setCollapsedSections] = useState({})
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

  // Boxplot State
  const [boxplotDatasetSafe, setBoxplotDatasetSafe] = useState('')
  const [boxplotMetabolite, setBoxplotMetabolite] = useState('')
  const [boxplotSamples, setBoxplotSamples] = useState([])
  const [boxplotGroupBy, setBoxplotGroupBy] = useState('')
  const [boxplotMetadataColumns, setBoxplotMetadataColumns] = useState([])
  const [boxplotAllMetabolites, setBoxplotAllMetabolites] = useState([])
  const [boxplotAllSamples, setBoxplotAllSamples] = useState([])
  const [boxplotResult, setBoxplotResult] = useState(null)
  const [boxplotLoading, setBoxplotLoading] = useState(false)
  const [boxplotError, setBoxplotError] = useState('')
  const [boxplotSearch, setBoxplotSearch] = useState('')
  const [boxplotSampleSearch, setBoxplotSampleSearch] = useState('')
  const [boxplotExpandedGroups, setBoxplotExpandedGroups] = useState({})

  // Van Krevelen State
  const [vankrevelenDatasetSafe, setVankrevelenDatasetSafe] = useState('')
  const [vankrevelenColorBy, setVankrevelenColorBy] = useState('superclass')
  const [vankrevelenFilterBy, setVankrevelenFilterBy] = useState('superclass')
  const [vankrevelenResult, setVankrevelenResult] = useState(null)
  const [vankrevelenLoading, setVankrevelenLoading] = useState(false)
  const [vankrevelenError, setVankrevelenError] = useState('')
  const [vankrevelenSearch, setVankrevelenSearch] = useState('')
  const [vankrevelenSelectedCategories, setVankrevelenSelectedCategories] = useState([])
  const [vankrevelenAllCategories, setVankrevelenAllCategories] = useState([])
  const [vankrevelenShowMsbuddy, setVankrevelenShowMsbuddy] = useState(false)

  // Carbon Oxidation State Plot states
  const [carbonOxStateDatasetSafe, setCarbonOxStateDatasetSafe] = useState('')
  const [carbonOxStateColorBy, setCarbonOxStateColorBy] = useState('superclass')
  const [carbonOxStateFilterBy, setCarbonOxStateFilterBy] = useState('superclass')
  const [carbonOxStateResult, setCarbonOxStateResult] = useState(null)
  const [carbonOxStateLoading, setCarbonOxStateLoading] = useState(false)
  const [carbonOxStateError, setCarbonOxStateError] = useState('')
  const [carbonOxStateSearch, setCarbonOxStateSearch] = useState('')
  const [carbonOxStateSelectedCategories, setCarbonOxStateSelectedCategories] = useState([])
  const [carbonOxStateAllCategories, setCarbonOxStateAllCategories] = useState([])

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
        x_axis: pcoaXAxis,
        y_axis: pcoaYAxis,
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
        const allCats = data.categories[newAttr]
        setPcoaAllCategories(allCats)
        setPcoaCategories(allCats) // Select all categories by default
        
        const samples = data.samples || []
        setPcoaAllSamples(samples)
        // Select all samples initially
        setPcoaSamples(samples.map(s => s.sample_id))
      } else {
        setPcoaAllCategories([])
        setPcoaCategories([])
        setPcoaAllSamples([])
        setPcoaSamples([])
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

  // Boxplot Logic
  useEffect(() => {
    if (boxplotDatasetSafe) {
      const loadOptions = async () => {
        setBoxplotLoading(true)
        setBoxplotError('')
        try {
          const [metas, schema] = await Promise.all([
            getDatasetMetabolites(boxplotDatasetSafe),
            getDatasetMetadataSchema(boxplotDatasetSafe)
          ])
          setBoxplotAllMetabolites(metas.metabolites || [])
          const samples = schema.samples || []
          setBoxplotAllSamples(samples)
          setBoxplotMetadataColumns(schema.columns || [])
          setBoxplotSamples(samples.map(s => s.sample_id)) // Select all by default
          setBoxplotGroupBy(schema.columns?.[0] || '') // Select first column by default
        } catch (err) {
          setBoxplotError(err.message || 'Failed to load dataset options')
        } finally {
          setBoxplotLoading(false)
        }
      }
      loadOptions()
    }
  }, [boxplotDatasetSafe])

  const runBoxplotAnalysis = async () => {
    if (!boxplotDatasetSafe || !boxplotMetabolite || boxplotSamples.length === 0) {
      setBoxplotError('Please select a dataset, metabolite, and at least one sample.')
      return
    }
    setBoxplotLoading(true)
    setBoxplotError('')
    try {
      const data = await getBoxplotData(boxplotDatasetSafe, boxplotMetabolite, boxplotSamples)
      setBoxplotResult(data)
    } catch (err) {
      setBoxplotError(err.message || 'Failed to fetch boxplot data')
      setBoxplotResult(null)
    } finally {
      setBoxplotLoading(false)
    }
  }

  const toggleBoxplotSample = (sid) => {
    setBoxplotSamples(prev => {
      const s = new Set(prev)
      if (s.has(sid)) s.delete(sid)
      else s.add(sid)
      return Array.from(s)
    })
  }

  // Clear boxplot results when filters change
  useEffect(() => {
    setBoxplotResult(null)
    setBoxplotError('')
  }, [boxplotDatasetSafe, boxplotMetabolite, boxplotSamples, boxplotGroupBy])

  // Van Krevelen Defaults & Data Fetching
  useEffect(() => {
    if (mapData?.datasets_details?.length > 0 && !vankrevelenDatasetSafe) {
      setVankrevelenDatasetSafe(mapData.datasets_details[0].safe_name)
    }
  }, [mapData, vankrevelenDatasetSafe])

  const runVanKrevelenAnalysis = useCallback(async () => {
    if (!vankrevelenDatasetSafe) return
    setVankrevelenLoading(true)
    setVankrevelenError('')
    try {
      const data = await getVanKrevelenData(vankrevelenDatasetSafe, vankrevelenShowMsbuddy)
      setVankrevelenResult(data)
    } catch (err) {
      setVankrevelenError(err.message || 'Failed to fetch Van Krevelen data.')
      setVankrevelenResult(null)
    } finally {
      setVankrevelenLoading(false)
    }
  }, [vankrevelenDatasetSafe, vankrevelenShowMsbuddy])

  // Clear stale result when dataset changes
  useEffect(() => {
    setVankrevelenResult(null)
    setVankrevelenAllCategories([])
    setVankrevelenSelectedCategories([])
  }, [vankrevelenDatasetSafe])

  useEffect(() => {
    if (!vankrevelenResult) return
    const pts = vankrevelenResult.points || []
    const key = vankrevelenFilterBy || 'superclass'
    const cats = Array.from(new Set(pts.map(p => String(p[key] || 'Unclassified')))).sort()
    setVankrevelenAllCategories(cats)
    setVankrevelenSelectedCategories(cats)
  }, [vankrevelenResult, vankrevelenFilterBy])

  const toggleVanKrevelenCategory = (cat) => {
    setVankrevelenSelectedCategories(prev => prev.includes(cat) ? prev.filter(c => c !== cat) : [...prev, cat])
  }

  // Carbon Ox State Defaults & Data Fetching
  useEffect(() => {
    if (mapData?.datasets_details?.length > 0 && !carbonOxStateDatasetSafe) {
      setCarbonOxStateDatasetSafe(mapData.datasets_details[0].safe_name)
    }
  }, [mapData, carbonOxStateDatasetSafe])

  const runCarbonOxStateAnalysis = useCallback(async () => {
    if (!carbonOxStateDatasetSafe) return
    setCarbonOxStateLoading(true)
    setCarbonOxStateError('')
    try {
      const data = await getCarbonOxStateData(carbonOxStateDatasetSafe)
      setCarbonOxStateResult(data)
    } catch (err) {
      setCarbonOxStateError(err.message || 'Failed to fetch Carbon Oxidation State data.')
      setCarbonOxStateResult(null)
    } finally {
      setCarbonOxStateLoading(false)
    }
  }, [carbonOxStateDatasetSafe])

  // Clear stale result when dataset changes
  useEffect(() => {
    setCarbonOxStateResult(null)
    setCarbonOxStateAllCategories([])
    setCarbonOxStateSelectedCategories([])
  }, [carbonOxStateDatasetSafe])

  useEffect(() => {
    if (!carbonOxStateResult) return
    const pts = carbonOxStateResult.points || []
    const key = carbonOxStateFilterBy || 'superclass'
    const cats = Array.from(new Set(pts.map(p => String(p[key] || 'Unclassified')))).sort()
    setCarbonOxStateAllCategories(cats)
    setCarbonOxStateSelectedCategories(cats)
  }, [carbonOxStateResult, carbonOxStateFilterBy])

  const toggleCarbonOxStateCategory = (cat) => {
    setCarbonOxStateSelectedCategories(prev => prev.includes(cat) ? prev.filter(c => c !== cat) : [...prev, cat])
  }

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

  const visiblePointKeys = useMemo(() => {
    const set = new globalThis.Set()
    for (const p of points) {
      const key = getPointSampleKey(p, mapData?.dataset_safe_map)
      if (key) set.add(key)
    }
    return set
  }, [points, mapData?.dataset_safe_map])

  // Summary stats reflecting the currently active filters
  const filteredStats = useMemo(() => {
    const datasetDetails = mapData?.datasets_details || []
    const visibleDatasetNames = new globalThis.Set(points.map((p) => String(p._dataset ?? 'N/A')))
    const filteredDatasets = datasetDetails.filter((ds) => visibleDatasetNames.has(ds.name))
    const features = filteredDatasets.reduce((sum, ds) => sum + (ds.n_features ?? 0), 0)
    return {
      datasets: filteredDatasets,
      samples: points.length,
      features,
    }
  }, [points, mapData?.datasets_details])

  // Count how many map points belong to each dataset so the filter list matches dashboard totals
  const datasetPointCounts = useMemo(() => {
    const counts = {}
    for (const p of mapData?.points ?? []) {
      const name = String(p._dataset ?? 'N/A')
      counts[name] = (counts[name] ?? 0) + 1
    }
    return counts
  }, [mapData?.points])

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

  // Intensity scale derived from the feature currently applied to the map,
  // restricted to positive-intensity samples that remain visible after current filters.
  // Zero-intensity samples are tracked separately and rendered grey.
  const intensityInfo = useMemo(() => {
    if (!mapFeature?.present_samples?.length || metaboliteSampleKeys.size === 0) return null
    const values = []
    const byKey = new globalThis.Map()
    for (const s of mapFeature.present_samples) {
      const scaled = getIntensityScaleValue(s.intensity, intensityScale)
      const datasetSafe = String(s.dataset_safe ?? '').trim()
      const sampleId = String(s.sample_id ?? '').trim()
      const key = `${datasetSafe}::${sampleId}`
      if (scaled === null) continue
      byKey.set(key, scaled)
      if (scaled === 'zero') continue
      if (visiblePointKeys.size === 0 || visiblePointKeys.has(key)) {
        values.push(scaled)
      }
    }
    if (!values.length) return null
    const min = Math.min(...values)
    const max = Math.max(...values)
    const range = max - min || 1
    return { byKey, min, max, range, scale: intensityScale }
  }, [mapFeature, metaboliteSampleKeys, visiblePointKeys, intensityScale])

  // Deck.gl layer
  const layer = useMemo(() => {
    if (!points.length) return null
    const intensityActive = !!intensityInfo
    return new ScatterplotLayer({
      id: 'metabolome-points',
      data: points,
      getPosition: (d) => [parseFloat(d._lon), parseFloat(d._lat)],
      getColor: (d) => {
        if (intensityActive) {
          const key = getPointSampleKey(d, mapData?.dataset_safe_map)
          const scaled = key ? intensityInfo.byKey.get(key) : undefined
          if (scaled === 'zero') return [128, 128, 128]
          if (scaled !== undefined && typeof scaled === 'number') {
            const t = (scaled - intensityInfo.min) / intensityInfo.range
            return intensityRamp(t)
          }
        }
        const key = colorByRef.current ? String(d[colorByRef.current] ?? 'N/A') : String(d._dataset ?? 'N/A')
        return colorLookupRef.current.get(key) ?? strColor(key)
      },
      getRadius: (d) => {
        if (!intensityActive) return 55000
        const key = getPointSampleKey(d, mapData?.dataset_safe_map)
        const scaled = key ? intensityInfo.byKey.get(key) : undefined
        if (scaled === 'zero') return 30000
        if (scaled === undefined || typeof scaled !== 'number') return 55000
        const t = (scaled - intensityInfo.min) / intensityInfo.range
        const minR = 25000
        const maxR = 105000
        return minR + (maxR - minR) * t
      },
      radiusUnits: 'meters',
      radiusMinPixels: 4,
      radiusMaxPixels: 24,
      pickable: true,
      opacity: 0.75,
      updateTriggers: {
        getColor: [colorBy, colorLookup, intensityInfo],
        getRadius: [intensityInfo],
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
  }, [points, hoverPanelActive, colorBy, colorLookup, intensityInfo, mapData])

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
    setMapFeature(feature)
    setSelectedFeature(feature)
  }

  const clearFeatureMapFilter = () => {
    setMetaboliteSampleKeys(new Set())
    setMapFeature(null)
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

  const renderMetaboliteBoxplots = () => {
    const filteredMetabolites = boxplotAllMetabolites.filter(m => 
      !boxplotSearch || m.id.toLowerCase().includes(boxplotSearch.toLowerCase())
    ).slice(0, 500) // Limit to 500 for performance

    const filteredSamples = boxplotAllSamples.filter(s => 
      !boxplotSampleSearch || s.sample_id.toLowerCase().includes(boxplotSampleSearch.toLowerCase())
    )

    const samplesByGroup = {}
    if (boxplotGroupBy) {
      filteredSamples.forEach(s => {
        const group = s[boxplotGroupBy] || 'N/A'
        if (!samplesByGroup[group]) samplesByGroup[group] = []
        samplesByGroup[group].push(s)
      })
    } else {
      samplesByGroup['All Samples'] = filteredSamples
    }

    const toggleGroup = (groupSamples, isChecked) => {
      setBoxplotSamples(prev => {
        const next = new Set(prev)
        groupSamples.forEach(s => {
          if (isChecked) next.add(s.sample_id)
          else next.delete(s.sample_id)
        })
        return Array.from(next)
      })
    }

    const toggleGroupExpand = (groupName) => {
      setBoxplotExpandedGroups(prev => ({
        ...prev,
        [groupName]: !prev[groupName]
      }))
    }

    return (
      <div className="grid grid-cols-12 gap-4 mt-3 pt-1">
        {/* Left Column: Selection */}
        <div className="col-span-4 space-y-4 pr-3 border-r border-slate-800">
          <div className="space-y-1">
            <label className="text-[10px] uppercase tracking-wider font-semibold text-slate-400">1. Select Dataset</label>
            <select
              value={boxplotDatasetSafe}
              onChange={(e) => setBoxplotDatasetSafe(e.target.value)}
              className="w-full rounded bg-slate-800 border border-slate-700 px-2 py-1 text-xs text-slate-200 focus:outline-none"
            >
              <option value="">-- Select a Dataset --</option>
              {(mapData?.datasets_details || []).map((d) => (
                <option key={d.safe_name} value={d.safe_name}>{d.name}</option>
              ))}
            </select>
          </div>

          <div className="space-y-1">
            <label className="text-[10px] uppercase tracking-wider font-semibold text-slate-400">2. Select Metabolite (Ordered by Intensity)</label>
            <input
              type="text"
              placeholder="Search metabolites..."
              value={boxplotSearch}
              onChange={(e) => setBoxplotSearch(e.target.value)}
              className="w-full rounded bg-slate-800 border border-slate-700 px-2 py-1 text-[11px] text-slate-200 placeholder:text-slate-500 focus:outline-none mb-1"
            />
            <div className="max-h-48 overflow-y-auto border border-slate-800 rounded bg-slate-950/40">
              {filteredMetabolites.length === 0 ? (
                <p className="p-2 text-[10px] text-slate-500 italic">No metabolites found</p>
              ) : (
                filteredMetabolites.map((m) => (
                  <button
                    key={m.id}
                    onClick={() => setBoxplotMetabolite(m.id)}
                    className={`w-full text-left px-2 py-1 text-[10px] flex items-center justify-between hover:bg-slate-800/60 ${
                      boxplotMetabolite === m.id ? 'bg-ocean-900/60 text-ocean-300 font-semibold' : 'text-slate-300'
                    }`}
                  >
                    <span className="truncate pr-2">{m.id}</span>
                    <span className="text-slate-500 text-[9px] tabular-nums shrink-0">{m.max_intensity.toExponential(1)}</span>
                  </button>
                ))
              )}
            </div>
          </div>

          <div className="space-y-1">
            <label className="text-[10px] uppercase tracking-wider font-semibold text-slate-400">3. Select Metadata Category (Required)</label>
            <select
              value={boxplotGroupBy}
              onChange={(e) => setBoxplotGroupBy(e.target.value)}
              className="w-full rounded bg-slate-800 border border-slate-700 px-2 py-1 text-xs text-slate-200 focus:outline-none"
            >
              <option value="">-- Select Category --</option>
              {boxplotMetadataColumns.map((col) => (
                <option key={col} value={col}>{col}</option>
              ))}
            </select>
          </div>

          <div className="space-y-1">
            <label className="text-[10px] uppercase tracking-wider font-semibold text-slate-400">4. Select Samples (Grouped by {boxplotGroupBy || 'Category'})</label>
            <div className="flex gap-1 mb-1">
              <input
                type="text"
                placeholder="Search samples..."
                value={boxplotSampleSearch}
                onChange={(e) => setBoxplotSampleSearch(e.target.value)}
                className="flex-1 rounded bg-slate-800 border border-slate-700 px-2 py-1 text-[11px] text-slate-200 placeholder:text-slate-500 focus:outline-none"
              />
              <button 
                onClick={() => setBoxplotSamples([])}
                className="text-[9px] text-slate-400 hover:text-slate-200 bg-slate-800 px-1.5 rounded"
              >
                None
              </button>
              <button 
                onClick={() => setBoxplotSamples(boxplotAllSamples.map(s => s.sample_id))}
                className="text-[9px] text-slate-400 hover:text-slate-200 bg-slate-800 px-1.5 rounded"
              >
                All
              </button>
            </div>
            <div className="max-h-64 overflow-y-auto border border-slate-800 rounded bg-slate-950/40 space-y-2 p-1">
              {Object.keys(samplesByGroup).sort().map(groupName => {
                const groupSamples = samplesByGroup[groupName]
                const selectedInGroup = groupSamples.filter(s => boxplotSamples.includes(s.sample_id))
                const isAllChecked = selectedInGroup.length === groupSamples.length
                const isPartial = selectedInGroup.length > 0 && selectedInGroup.length < groupSamples.length
                const isExpanded = !!boxplotExpandedGroups[groupName]

                return (
                  <div key={groupName} className="border border-slate-800 rounded bg-slate-900/40 overflow-hidden">
                    <div className="bg-slate-800/60 px-2 py-1 flex items-center justify-between">
                      <div className="flex items-center gap-2 min-w-0 flex-1">
                        <input
                          type="checkbox"
                          checked={isAllChecked}
                          ref={el => el && (el.indeterminate = isPartial)}
                          onChange={(e) => toggleGroup(groupSamples, e.target.checked)}
                          className="rounded scale-90 accent-ocean-500 shrink-0"
                        />
                        <button 
                          onClick={() => toggleGroupExpand(groupName)}
                          className="flex items-center gap-1.5 min-w-0 text-left"
                        >
                          <span className={`text-[10px] transition-transform ${isExpanded ? 'rotate-90' : ''}`}>▶</span>
                          <span className="text-[10px] font-semibold text-slate-300 truncate" title={groupName}>
                            {groupName}
                          </span>
                        </button>
                      </div>
                      <span className="text-[9px] text-slate-500 shrink-0">
                        ({selectedInGroup.length}/{groupSamples.length})
                      </span>
                    </div>
                    {isExpanded && (
                      <div className="p-1 space-y-0.5 border-t border-slate-800/40">
                        {groupSamples.map((s) => (
                          <label
                            key={s.sample_id}
                            className={`flex items-center gap-2 px-1.5 py-0.5 text-[9px] cursor-pointer rounded hover:bg-slate-800/40 ${
                              boxplotSamples.includes(s.sample_id) ? 'text-ocean-300' : 'text-slate-500'
                            }`}
                          >
                            <input
                              type="checkbox"
                              checked={boxplotSamples.includes(s.sample_id)}
                              onChange={() => toggleBoxplotSample(s.sample_id)}
                              className="rounded scale-75 accent-ocean-500"
                            />
                            <span className="truncate font-mono" title={s.sample_id}>{s.sample_id}</span>
                          </label>
                        ))}
                      </div>
                    )}
                  </div>
                )
              })}
              {Object.keys(samplesByGroup).length === 0 && (
                <p className="p-2 text-[10px] text-slate-500 italic">No samples match search.</p>
              )}
            </div>
            <p className="text-[9px] text-slate-500 mt-1">{boxplotSamples.length} samples selected</p>
          </div>

          <button
            onClick={runBoxplotAnalysis}
            disabled={boxplotLoading || !boxplotMetabolite || boxplotSamples.length === 0 || !boxplotGroupBy}
            className="w-full bg-ocean-700 hover:bg-ocean-600 disabled:bg-slate-800 disabled:text-slate-500 text-white rounded py-2 text-xs font-semibold transition-colors flex items-center justify-center gap-1.5"
          >
            {boxplotLoading ? <RefreshCw size={12} className="animate-spin" /> : <BarChart3 size={14} />}
            Generate Boxplot
          </button>
          
          {boxplotError && (
            <p className="text-[10px] text-red-400 bg-red-950/20 border border-red-900/40 p-2 rounded">{boxplotError}</p>
          )}
        </div>

        {/* Right Column: Plot */}
        <div className="col-span-8 flex flex-col items-center justify-center bg-slate-950/50 border border-dashed border-slate-800 rounded-lg p-4 min-h-[400px]">
          {boxplotLoading ? (
            <div className="flex flex-col items-center gap-2">
              <RefreshCw size={32} className="animate-spin text-ocean-400" />
              <p className="text-xs text-slate-400">Loading intensities...</p>
            </div>
          ) : boxplotResult ? (
            <div className="w-full h-full flex flex-col">
              <h4 className="text-xs font-semibold text-slate-200 mb-2 truncate px-2">
                Intensity Comparison: {boxplotMetabolite} {boxplotGroupBy ? `grouped by ${boxplotGroupBy}` : ''}
              </h4>
              <Plot
                data={(() => {
                  if (!boxplotGroupBy) {
                    return [{
                      x: boxplotResult.data.map(d => d.sample_id),
                      y: boxplotResult.data.map(d => d.intensity),
                      type: 'box',
                      name: boxplotMetabolite,
                      boxpoints: 'all',
                      jitter: 0.3,
                      pointpos: -1.8,
                      marker: { color: '#0ea5e9' },
                      line: { width: 1.5 }
                    }]
                  }
                  
                  // Group data by the selected metadata category
                  const groups = {}
                  boxplotResult.data.forEach(d => {
                    const val = d.metadata[boxplotGroupBy] || 'N/A'
                    if (!groups[val]) groups[val] = []
                    groups[val].push(d.intensity)
                  })
                  
                  return Object.keys(groups).sort().map((group, idx) => {
                    const [r, g, b] = strColor(group)
                    return {
                      y: groups[group],
                      type: 'box',
                      name: group,
                      boxpoints: 'all',
                      jitter: 0.3,
                      pointpos: -1.8,
                      marker: { color: `rgb(${r},${g},${b})` },
                      line: { width: 1.5 }
                    }
                  })
                })()}
                layout={{
                  autosize: true,
                  paper_bgcolor: 'white',
                  plot_bgcolor: 'white',
                  margin: { t: 30, r: 20, b: 80, l: 70 },
                  showlegend: !!boxplotGroupBy,
                  xaxis: {
                    tickangle: 45,
                    tickfont: { size: 10, color: '#334155' },
                    gridcolor: '#f1f5f9',
                    linecolor: '#cbd5e1',
                  },
                  yaxis: {
                    title: 'Intensity',
                    titlefont: { size: 12, color: '#1e293b', standoff: 15 },
                    tickfont: { size: 10, color: '#334155' },
                    gridcolor: '#f1f5f9',
                    zerolinecolor: '#e2e8f0'
                  },
                  font: { color: '#1e293b' }
                }}
                useResizeHandler={true}
                className="w-full h-[450px]"
                config={{ responsive: true, displaylogo: false }}
              />
            </div>
          ) : (
            <div className="text-center space-y-2">
              <BarChart3 size={48} className="text-slate-700 mx-auto" />
              <p className="text-xs text-slate-400 font-medium">Boxplot Preview</p>
            </div>
          )}
        </div>
      </div>
    )
  }

  const renderVanKrevelen = () => {
    const rawPoints = vankrevelenResult?.points || []
    
    // First, filter by selected categories
    const categoryFilteredPoints = rawPoints.filter(p => {
      const catVal = String(p[vankrevelenFilterBy] || 'Unclassified')
      return vankrevelenSelectedCategories.includes(catVal)
    })

    // Next, filter by search keyword
    const filteredPoints = categoryFilteredPoints.filter(p => {
      if (!vankrevelenSearch) return true
      const q = vankrevelenSearch.toLowerCase()
      return (
        p.metabolite.toLowerCase().includes(q) ||
        p.formula.toLowerCase().includes(q) ||
        p.compound_name.toLowerCase().includes(q) ||
        p.superclass.toLowerCase().includes(q) ||
        p.class.toLowerCase().includes(q) ||
        p.subclass.toLowerCase().includes(q)
      )
    })

    const groups = {}
    filteredPoints.forEach(p => {
      const groupVal = p[vankrevelenColorBy] || 'Unclassified'
      if (!groups[groupVal]) groups[groupVal] = []
      groups[groupVal].push(p)
    })

    const plotlyData = Object.entries(groups).map(([groupName, pts]) => {
      return {
        x: pts.map(p => p.o_c),
        y: pts.map(p => p.h_c),
        mode: 'markers',
        name: groupName,
        type: 'scatter',
        text: pts.map(p => {
          const intensityStr = p.intensity ? Number(p.intensity).toExponential(2) : 'N/A'
          return `<b>${p.compound_name || 'Unnamed Metabolite'}</b><br>` +
                 `ID: ${p.metabolite}<br>` +
                 `Formula: ${p.formula}<br>` +
                 `O/C: ${p.o_c.toFixed(3)} | H/C: ${p.h_c.toFixed(3)}<br>` +
                 `Mean Intensity: ${intensityStr}<br>` +
                 `CANOPUS Superclass: ${p.superclass}<br>` +
                 `CANOPUS Class: ${p.class}<br>` +
                 `NPClassifier Pathway: ${p.npclassifier_pathway}`
        }),
        hoverinfo: 'text',
        marker: {
          size: pts.map(p => {
            if (!p.intensity) return 6
            const size = Math.max(5, Math.min(18, Math.log10(p.intensity) * 1.5))
            return size
          }),
          opacity: 0.8,
          line: {
            color: 'rgba(255, 255, 255, 0.4)',
            width: 0.5
          }
        }
      }
    })

    return (
      <div className="grid grid-cols-12 gap-4 mt-3 pt-1">
        {/* Left column: Controls */}
        <div className="col-span-4 space-y-4 pr-3 border-r border-slate-800">
          <div className="space-y-1">
            <label className="text-[10px] uppercase tracking-wider font-semibold text-slate-400">Dataset</label>
            <select
              value={vankrevelenDatasetSafe}
              onChange={(e) => setVankrevelenDatasetSafe(e.target.value)}
              className="w-full rounded bg-slate-800 border border-slate-700 px-2 py-1.5 text-xs text-slate-200 focus:outline-none"
            >
              <option value="">-- Select a Dataset --</option>
              {(mapData?.datasets_details || []).map((d) => (
                <option key={d.safe_name} value={d.safe_name}>{d.name}</option>
              ))}
            </select>
          </div>

          <div className="space-y-1">
            <label className="text-[10px] uppercase tracking-wider font-semibold text-slate-400">Filter By</label>
            <select
              value={vankrevelenFilterBy}
              onChange={(e) => setVankrevelenFilterBy(e.target.value)}
              className="w-full rounded bg-slate-800 border border-slate-700 px-2 py-1.5 text-xs text-slate-200 focus:outline-none"
            >
              <optgroup label="SIRIUS / CANOPUS Classifications">
                <option value="superclass">CANOPUS Superclass</option>
                <option value="class">CANOPUS Class</option>
                <option value="subclass">CANOPUS Subclass</option>
              </optgroup>
              <optgroup label="NPClassifier Classifications">
                <option value="npclassifier_superclass">NPClassifier Superclass</option>
                <option value="npclassifier_class">NPClassifier Class</option>
                <option value="npclassifier_pathway">NPClassifier Pathway</option>
              </optgroup>
            </select>
          </div>

          <div className="space-y-1">
            <label className="text-[10px] uppercase tracking-wider font-semibold text-slate-400">Color By</label>
            <select
              value={vankrevelenColorBy}
              onChange={(e) => setVankrevelenColorBy(e.target.value)}
              className="w-full rounded bg-slate-800 border border-slate-700 px-2 py-1.5 text-xs text-slate-200 focus:outline-none"
            >
              <optgroup label="SIRIUS / CANOPUS Classifications">
                <option value="superclass">CANOPUS Superclass</option>
                <option value="class">CANOPUS Class</option>
                <option value="subclass">CANOPUS Subclass</option>
              </optgroup>
              <optgroup label="NPClassifier Classifications">
                <option value="npclassifier_superclass">NPClassifier Superclass</option>
                <option value="npclassifier_class">NPClassifier Class</option>
                <option value="npclassifier_pathway">NPClassifier Pathway</option>
              </optgroup>
            </select>
          </div>

          <div className="space-y-1">
            <label className="text-[10px] uppercase tracking-wider font-semibold text-slate-400">Search Metabolites</label>
            <input
              type="text"
              placeholder="Search ID, formula, compound, class..."
              value={vankrevelenSearch}
              onChange={(e) => setVankrevelenSearch(e.target.value)}
              className="w-full rounded bg-slate-800 border border-slate-700 px-2 py-1.5 text-xs text-slate-200 focus:outline-none placeholder-slate-500"
            />
          </div>

          <button
            onClick={runVanKrevelenAnalysis}
            disabled={vankrevelenLoading || !vankrevelenDatasetSafe}
            className="w-full bg-ocean-700 hover:bg-ocean-600 disabled:bg-slate-800 disabled:text-slate-500 text-white rounded py-2 text-xs font-semibold transition-colors flex items-center justify-center gap-1.5 mt-1"
          >
            {vankrevelenLoading ? <RefreshCw size={12} className="animate-spin" /> : <Layers size={14} />}
            Apply Filters & Generate Plot
          </button>

          {/* Category Filtering checklist */}
          {vankrevelenAllCategories.length > 0 && (
            <div className="space-y-1.5 border-t border-slate-800 pt-3 mt-2">
              <div className="flex items-center justify-between">
                <label className="text-[10px] uppercase tracking-wider font-semibold text-slate-400">Filter Groups</label>
                <div className="flex gap-2">
                  <button
                    onClick={() => setVankrevelenSelectedCategories(vankrevelenAllCategories)}
                    className="text-[9px] text-ocean-400 hover:text-ocean-300 font-medium"
                  >
                    Select All
                  </button>
                  <button
                    onClick={() => setVankrevelenSelectedCategories([])}
                    className="text-[9px] text-slate-500 hover:text-slate-400 font-medium"
                  >
                    Clear All
                  </button>
                </div>
              </div>
              <div className="max-h-[140px] overflow-y-auto border border-slate-800 rounded bg-slate-900/40 p-2 space-y-1">
                {vankrevelenAllCategories.map((cat) => {
                  const isChecked = vankrevelenSelectedCategories.includes(cat)
                  return (
                    <label
                      key={cat}
                      className={`flex items-center gap-2 text-[10px] cursor-pointer rounded px-1 py-0.5 hover:bg-slate-800/40 ${
                        isChecked ? 'text-slate-200' : 'text-slate-500'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={isChecked}
                        onChange={() => toggleVanKrevelenCategory(cat)}
                        className="rounded scale-90 accent-ocean-500"
                      />
                      <span className="truncate" title={cat}>{cat}</span>
                    </label>
                  )
                })}
              </div>
            </div>
          )}

          {!vankrevelenError && vankrevelenResult && (
            <div className="rounded bg-slate-850 border border-slate-800 p-2.5 text-[11px] text-slate-400 space-y-1 font-sans mt-3">
              <p className="font-semibold text-slate-300">Van Krevelen Statistics</p>
              <p>SIRIUS Annotated Features: <span className="text-emerald-400 font-medium">{vankrevelenResult.annotated_features ?? 0}</span></p>
              <p>Filtered points (via search): <span className="text-slate-200 font-medium">{filteredPoints.length}</span></p>
              <p>Unique color groups: <span className="text-slate-200 font-medium">{Object.keys(groups).length}</span></p>
            </div>
          )}
        </div>

        {/* Right column: Plot area with local loading */}
        <div className="col-span-8 bg-white border border-slate-200 rounded-lg flex flex-col items-center p-2 min-h-[420px] justify-center relative">
          {vankrevelenLoading ? (
            <div className="flex flex-col items-center justify-center py-12 text-slate-400 gap-2 text-center px-4">
              <RefreshCw className="animate-spin text-ocean-400" size={32} />
              <p className="text-sm font-medium text-slate-700">
                Retrieving Annotated Features...
              </p>
              <p className="text-[10px] text-slate-500 max-w-[200px]">
                Getting the top 1000 highest abundance features matching your precomputed SIRIUS annotations.
              </p>
            </div>
          ) : !vankrevelenResult ? (
            <div className="flex flex-col items-center justify-center text-center p-8 space-y-3">
              <div className="w-16 h-16 rounded-full bg-slate-100 flex items-center justify-center text-slate-400">
                <Layers size={32} />
              </div>
              <div>
                <h4 className="text-sm font-semibold text-slate-700">Ready to Plot</h4>
                <p className="text-[11px] text-slate-500 max-w-[240px] mt-1">
                  Configure your dataset, then click <strong>Apply Filters & Generate Plot</strong>.
                </p>
              </div>
            </div>
          ) : filteredPoints.length > 0 ? (
            <Plot
              data={plotlyData}
              layout={{
                autosize: true,
                paper_bgcolor: 'white',
                plot_bgcolor: 'white',
                font: { color: '#334155', size: 10 },
                title: {
                  text: `VAN KREVELEN PLOT (${vankrevelenDatasetSafe.replace('_', ' ')})`,
                  font: { color: '#0f172a', size: 12, weight: 'bold' }
                },
                xaxis: {
                  title: { text: 'Oxygen-to-Carbon Ratio (O/C)', font: { color: '#1e293b', size: 11 } },
                  gridcolor: '#f1f5f9',
                  linecolor: '#cbd5e1',
                  tickfont: { color: '#334155' },
                  range: [-0.05, 1.25]
                },
                yaxis: {
                  title: { text: 'Hydrogen-to-Carbon Ratio (H/C)', font: { color: '#1e293b', size: 11 } },
                  gridcolor: '#f1f5f9',
                  linecolor: '#cbd5e1',
                  tickfont: { color: '#334155' },
                  range: [0.1, 2.5]
                },
                margin: { l: 50, r: 20, t: 50, b: 50 },
                hovermode: 'closest',
                showlegend: true,
                legend: {
                  font: { size: 9 },
                  orientation: 'v',
                  x: 1.02,
                  y: 1
                }
              }}
              useResizeHandler={true}
              className="w-full h-full min-h-[400px]"
              config={{ responsive: true, displayModeBar: false }}
            />
          ) : (
            <div className="text-center py-12 text-xs text-slate-500">
              No points matched your filters. Adjust search or select another dataset.
            </div>
          )}
        </div>
      </div>
    )
  }

  const renderCarbonOxState = () => {
    const rawPoints = carbonOxStateResult?.points || []
    
    // First, filter by selected categories
    const categoryFilteredPoints = rawPoints.filter(p => {
      const catVal = String(p[carbonOxStateFilterBy] || 'Unclassified')
      return carbonOxStateSelectedCategories.includes(catVal)
    })

    // Next, filter by search keyword
    const filteredPoints = categoryFilteredPoints.filter(p => {
      if (!carbonOxStateSearch) return true
      const q = carbonOxStateSearch.toLowerCase()
      return (
        p.metabolite.toLowerCase().includes(q) ||
        p.formula.toLowerCase().includes(q) ||
        p.compound_name.toLowerCase().includes(q) ||
        p.superclass.toLowerCase().includes(q) ||
        p.class.toLowerCase().includes(q) ||
        p.subclass.toLowerCase().includes(q)
      )
    })

    const groups = {}
    filteredPoints.forEach(p => {
      const groupVal = p[carbonOxStateColorBy] || 'Unclassified'
      if (!groups[groupVal]) groups[groupVal] = []
      groups[groupVal].push(p)
    })

    const plotlyData = Object.entries(groups).map(([groupName, pts]) => {
      return {
        x: pts.map(p => p.cos),
        y: pts.map(p => p.intensity),
        mode: 'markers',
        name: groupName,
        type: 'scatter',
        text: pts.map(p => {
          const intensityStr = p.intensity ? Number(p.intensity).toExponential(2) : 'N/A'
          return `<b>${p.compound_name || 'Unnamed Metabolite'}</b><br>` +
                 `ID: ${p.metabolite}<br>` +
                 `Formula: ${p.formula}<br>` +
                 `COS: ${p.cos.toFixed(3)}<br>` +
                 `Mean Intensity: ${intensityStr}<br>` +
                 `CANOPUS Superclass: ${p.superclass}<br>` +
                 `CANOPUS Class: ${p.class}<br>` +
                 `NPClassifier Pathway: ${p.npclassifier_pathway}`
        }),
        hoverinfo: 'text',
        marker: {
          size: pts.map(p => {
            if (!p.intensity) return 6
            const size = Math.max(5, Math.min(18, Math.log10(p.intensity) * 1.5))
            return size
          }),
          opacity: 0.8,
          line: {
            color: 'rgba(255, 255, 255, 0.4)',
            width: 0.5
          }
        }
      }
    })

    return (
      <div className="grid grid-cols-12 gap-4 mt-3 pt-1">
        {/* Left column: Controls */}
        <div className="col-span-4 space-y-4 pr-3 border-r border-slate-800">
          <div className="space-y-1">
            <label className="text-[10px] uppercase tracking-wider font-semibold text-slate-400">Dataset</label>
            <select
              value={carbonOxStateDatasetSafe}
              onChange={(e) => setCarbonOxStateDatasetSafe(e.target.value)}
              className="w-full rounded bg-slate-800 border border-slate-700 px-2 py-1.5 text-xs text-slate-200 focus:outline-none"
            >
              <option value="">-- Select a Dataset --</option>
              {(mapData?.datasets_details || []).map((d) => (
                <option key={d.safe_name} value={d.safe_name}>{d.name}</option>
              ))}
            </select>
          </div>

          <div className="space-y-1">
            <label className="text-[10px] uppercase tracking-wider font-semibold text-slate-400">Filter By</label>
            <select
              value={carbonOxStateFilterBy}
              onChange={(e) => setCarbonOxStateFilterBy(e.target.value)}
              className="w-full rounded bg-slate-800 border border-slate-700 px-2 py-1.5 text-xs text-slate-200 focus:outline-none"
            >
              <optgroup label="SIRIUS / CANOPUS Classifications">
                <option value="superclass">CANOPUS Superclass</option>
                <option value="class">CANOPUS Class</option>
                <option value="subclass">CANOPUS Subclass</option>
              </optgroup>
              <optgroup label="NPClassifier Classifications">
                <option value="npclassifier_superclass">NPClassifier Superclass</option>
                <option value="npclassifier_class">NPClassifier Class</option>
                <option value="npclassifier_pathway">NPClassifier Pathway</option>
              </optgroup>
            </select>
          </div>

          <div className="space-y-1">
            <label className="text-[10px] uppercase tracking-wider font-semibold text-slate-400">Color By</label>
            <select
              value={carbonOxStateColorBy}
              onChange={(e) => setCarbonOxStateColorBy(e.target.value)}
              className="w-full rounded bg-slate-800 border border-slate-700 px-2 py-1.5 text-xs text-slate-200 focus:outline-none"
            >
              <optgroup label="SIRIUS / CANOPUS Classifications">
                <option value="superclass">CANOPUS Superclass</option>
                <option value="class">CANOPUS Class</option>
                <option value="subclass">CANOPUS Subclass</option>
              </optgroup>
              <optgroup label="NPClassifier Classifications">
                <option value="npclassifier_superclass">NPClassifier Superclass</option>
                <option value="npclassifier_class">NPClassifier Class</option>
                <option value="npclassifier_pathway">NPClassifier Pathway</option>
              </optgroup>
            </select>
          </div>

          <div className="space-y-1">
            <label className="text-[10px] uppercase tracking-wider font-semibold text-slate-400">Search Metabolites</label>
            <input
              type="text"
              placeholder="Search ID, formula, compound, class..."
              value={carbonOxStateSearch}
              onChange={(e) => setCarbonOxStateSearch(e.target.value)}
              className="w-full rounded bg-slate-800 border border-slate-700 px-2 py-1.5 text-xs text-slate-200 focus:outline-none placeholder-slate-500"
            />
          </div>

          <button
            onClick={runCarbonOxStateAnalysis}
            disabled={carbonOxStateLoading || !carbonOxStateDatasetSafe}
            className="w-full bg-ocean-700 hover:bg-ocean-600 disabled:bg-slate-800 disabled:text-slate-500 text-white rounded py-2 text-xs font-semibold transition-colors flex items-center justify-center gap-1.5 mt-1"
          >
            {carbonOxStateLoading ? <RefreshCw size={12} className="animate-spin" /> : <Flame size={14} />}
            Apply Filters & Generate Plot
          </button>

          {/* Category Filtering checklist */}
          {carbonOxStateAllCategories.length > 0 && (
            <div className="space-y-1.5 border-t border-slate-800 pt-3 mt-2">
              <div className="flex items-center justify-between">
                <label className="text-[10px] uppercase tracking-wider font-semibold text-slate-400">Filter Groups</label>
                <div className="flex gap-2">
                  <button
                    onClick={() => setCarbonOxStateSelectedCategories(carbonOxStateAllCategories)}
                    className="text-[9px] text-ocean-400 hover:text-ocean-300 font-medium"
                  >
                    Select All
                  </button>
                  <button
                    onClick={() => setCarbonOxStateSelectedCategories([])}
                    className="text-[9px] text-slate-500 hover:text-slate-400 font-medium"
                  >
                    Clear All
                  </button>
                </div>
              </div>
              <div className="max-h-[140px] overflow-y-auto border border-slate-800 rounded bg-slate-900/40 p-2 space-y-1">
                {carbonOxStateAllCategories.map((cat) => {
                  const isChecked = carbonOxStateSelectedCategories.includes(cat)
                  return (
                    <label
                      key={cat}
                      className={`flex items-center gap-2 text-[10px] cursor-pointer rounded px-1 py-0.5 hover:bg-slate-800/40 ${
                        isChecked ? 'text-slate-200' : 'text-slate-500'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={isChecked}
                        onChange={() => toggleCarbonOxStateCategory(cat)}
                        className="rounded scale-90 accent-ocean-500"
                      />
                      <span className="truncate" title={cat}>{cat}</span>
                    </label>
                  )
                })}
              </div>
            </div>
          )}

          {!carbonOxStateError && carbonOxStateResult && (
            <div className="rounded bg-slate-850 border border-slate-800 p-2.5 text-[11px] text-slate-400 space-y-1 font-sans mt-3">
              <p className="font-semibold text-slate-300">Carbon Oxidation State Statistics</p>
              <p>SIRIUS Annotated Features: <span className="text-emerald-400 font-medium">{carbonOxStateResult.annotated_features ?? 0}</span></p>
              <p>Filtered points (via search): <span className="text-slate-200 font-medium">{filteredPoints.length}</span></p>
              <p>Unique color groups: <span className="text-slate-200 font-medium">{Object.keys(groups).length}</span></p>
            </div>
          )}
        </div>

        {/* Right column: Plot area with local loading */}
        <div className="col-span-8 bg-white border border-slate-200 rounded-lg flex flex-col items-center p-2 min-h-[420px] justify-center relative">
          {carbonOxStateLoading ? (
            <div className="flex flex-col items-center justify-center py-12 text-slate-400 gap-2 text-center px-4">
              <RefreshCw className="animate-spin text-ocean-400" size={32} />
              <p className="text-sm font-medium text-slate-700">
                Calculating Carbon Oxidation State...
              </p>
              <p className="text-[10px] text-slate-500 max-w-[200px]">
                Computing COS values for the top 1000 highest abundance features matching SIRIUS annotations.
              </p>
            </div>
          ) : !carbonOxStateResult ? (
            <div className="flex flex-col items-center justify-center text-center p-8 space-y-3">
              <div className="w-16 h-16 rounded-full bg-slate-100 flex items-center justify-center text-slate-400">
                <Flame size={32} />
              </div>
              <div>
                <h4 className="text-sm font-semibold text-slate-700">Ready to Plot</h4>
                <p className="text-[11px] text-slate-500 max-w-[240px] mt-1">
                  Configure your dataset, then click <strong>Apply Filters & Generate Plot</strong>.
                </p>
              </div>
            </div>
          ) : filteredPoints.length > 0 ? (
            <Plot
              data={plotlyData}
              layout={{
                autosize: true,
                paper_bgcolor: 'white',
                plot_bgcolor: 'white',
                font: { color: '#334155', size: 10 },
                title: {
                  text: `CARBON OXIDATION STATE (${carbonOxStateDatasetSafe.replace('_', ' ')})`,
                  font: { color: '#0f172a', size: 12, weight: 'bold' }
                },
                xaxis: {
                  title: { text: 'Carbon Oxidation State (COS)', font: { color: '#1e293b', size: 11 } },
                  gridcolor: '#f1f5f9',
                  linecolor: '#cbd5e1',
                  tickfont: { color: '#334155' }
                },
                yaxis: {
                  title: { text: 'Mean Intensity (log scale)', font: { color: '#1e293b', size: 11 } },
                  gridcolor: '#f1f5f9',
                  linecolor: '#cbd5e1',
                  tickfont: { color: '#334155' },
                  type: 'log'
                },
                margin: { l: 50, r: 20, t: 50, b: 50 },
                hovermode: 'closest',
                showlegend: true,
                legend: {
                  font: { size: 9 },
                  orientation: 'v',
                  x: 1.02,
                  y: 1
                }
              }}
              useResizeHandler={true}
              className="w-full h-full min-h-[400px]"
              config={{ responsive: true, displayModeBar: false }}
            />
          ) : (
            <div className="text-center py-12 text-xs text-slate-500">
              No points matched your filters. Adjust search or select another dataset.
            </div>
          )}
        </div>
      </div>
    )
  }

  const renderPcoaScatterPlot = () => {
    if (!pcoaResult?.scatter_plot) {
      return (
        <div className="text-center py-12 text-xs text-slate-500">
          No coordinates available. Try adjusting filters or select a different dataset.
        </div>
      )
    }

    return (
      <div className="relative grid grid-cols-12 gap-4">
        <div className="col-span-12 bg-white border border-slate-200 rounded-lg flex flex-col items-center p-2">
          <Plot
            data={pcoaResult.scatter_plot.data}
            layout={{
              ...pcoaResult.scatter_plot.layout,
              autosize: true,
              paper_bgcolor: 'white',
              plot_bgcolor: 'white',
              font: { color: '#334155' },
              xaxis: {
                ...pcoaResult.scatter_plot.layout.xaxis,
                gridcolor: '#f1f5f9',
                linecolor: '#cbd5e1',
                tickfont: { color: '#334155' },
                title: { ...pcoaResult.scatter_plot.layout.xaxis?.title, font: { color: '#1e293b' } }
              },
              yaxis: {
                ...pcoaResult.scatter_plot.layout.yaxis,
                gridcolor: '#f1f5f9',
                linecolor: '#cbd5e1',
                tickfont: { color: '#334155' },
                title: { ...pcoaResult.scatter_plot.layout.yaxis?.title, font: { color: '#1e293b' } }
              }
            }}
            useResizeHandler={true}
            className="w-full min-h-[400px]"
            config={{ responsive: true, displayModeBar: true }}
          />
        </div>
      </div>
    )
  }

  const renderVarianceBarChart = () => {
    if (!pcoaResult?.variance_plot) {
      return (
        <div className="text-center py-12 text-xs text-slate-500">
          No variance data available.
        </div>
      )
    }

    return (
      <div className="bg-white border border-slate-200 rounded-lg p-3 flex flex-col items-center">
        <Plot
          data={pcoaResult.variance_plot.data}
          layout={{
            ...pcoaResult.variance_plot.layout,
            autosize: true,
            paper_bgcolor: 'white',
            plot_bgcolor: 'white',
            font: { color: '#334155' },
            xaxis: {
              ...pcoaResult.variance_plot.layout.xaxis,
              gridcolor: '#f1f5f9',
              linecolor: '#cbd5e1',
              tickfont: { color: '#334155' }
            },
            yaxis: {
              ...pcoaResult.variance_plot.layout.yaxis,
              gridcolor: '#f1f5f9',
              linecolor: '#cbd5e1',
              tickfont: { color: '#334155' }
            }
          }}
          useResizeHandler={true}
          className="w-full min-h-[300px]"
          config={{ responsive: true, displayModeBar: false }}
        />
      </div>
    )
  }



  const renderPermanovaStats = () => {
    if (!pcoaResult?.permanova) {
      return (
        <div className="text-center py-12 text-xs text-slate-500">
          PERMANOVA results not available (requires at least 2 categories and 2 samples per category).
        </div>
      )
    }

    return (
      <div className="bg-slate-950 border border-slate-800 rounded-lg p-3 space-y-2">
        <div className="flex items-center justify-between pb-1 border-b border-slate-800">
          <h4 className="text-xs font-semibold text-slate-200">PERMANOVA Statistics</h4>
        </div>
        <div className="overflow-hidden border border-slate-800 rounded">
          <table className="w-full text-[11px] text-left border-collapse">
            <thead className="bg-slate-900 border-b border-slate-800 text-slate-400">
              <tr>
                <th className="px-3 py-2 font-semibold border-r border-slate-800 w-1/2">Metric</th>
                <th className="px-3 py-2 font-semibold w-1/2">Value</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-850">
              {pcoaResult.permanova.map((row, i) => (
                <tr key={i} className="hover:bg-slate-800/30 text-slate-300">
                  <td className="px-3 py-1.5 font-medium border-r border-slate-850 bg-slate-900/20">{row.Metric}</td>
                  <td className="px-3 py-1.5 font-mono">{row.Value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
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

    // Determine how many PCs are actually returned (up to 10)
    const pcKeys = Object.keys(pcoaResult.coordinates[0]?.coordinates || {})
      .filter(k => k.startsWith('PC'))
      .sort((a, b) => parseInt(a.replace('PC', '')) - parseInt(b.replace('PC', '')))
      .slice(0, 10)

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
                {pcKeys.map((pc, idx) => (
                  <th key={pc} className={`px-2 py-1 font-semibold text-right ${idx < pcKeys.length - 1 ? 'border-r border-slate-800' : ''}`}>
                    {pc}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-850">
              {pcoaResult.coordinates.map((row) => (
                <tr key={row.sample_id} className="hover:bg-slate-800/30">
                  <td className="px-2 py-1 font-mono text-slate-200 font-medium truncate max-w-[120px] border-r border-slate-850" title={row.sample_id}>
                    {row.sample_id}
                  </td>
                  {pcKeys.map((pc, idx) => (
                    <td key={pc} className={`px-2 py-1 text-right font-mono ${idx < pcKeys.length - 1 ? 'border-r border-slate-850' : ''}`}>
                      {(row.coordinates[pc] ?? 0).toFixed(4)}
                    </td>
                  ))}
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
            visibleDatasets={filteredStats.datasets}
            samples={filteredStats.samples}
            features={filteredStats.features}
          />
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

      {mapFeature && metaboliteSampleKeys.size > 0 && (() => {
        const totalSamples = mapFeature.present_samples?.length ?? metaboliteSampleKeys.size
        const visibleCount = points.length
        const filterDescription = describeActiveSampleFilters(filters, selectedSamples, sampleSearch)
        return (
          <div className="absolute top-14 right-3 z-10 bg-ocean-900/80 border border-ocean-700 rounded-lg px-3 py-2 text-[11px] text-ocean-100 max-w-md">
            <p>
              Showing samples for <span className="font-semibold">{mapFeature.metabolite}</span>
            </p>
            <p className="text-ocean-200/80 mt-0.5">
              Filters: {filterDescription}
            </p>
            <p className="text-ocean-200/80">
              {visibleCount.toLocaleString()} of {totalSamples.toLocaleString()} metabolite samples visible
              {visibleCount < totalSamples && ` (${(totalSamples - visibleCount).toLocaleString()} filtered out)`}
            </p>
          </div>
        )
      })()}

      {/* Global analysis dashboard */}
      {analysisOpen && (
        <div className={`absolute top-12 right-3 z-20 bg-slate-900/95 border border-slate-700 rounded-xl p-4 shadow-xl transition-all duration-300 max-h-[85vh] overflow-y-auto ${
          (globalAnalysisOption === 'PCoA' && pcoaDashboardExpanded) || globalAnalysisOption === 'Metabolite Boxplots' || globalAnalysisOption === 'Van Krevelen' || globalAnalysisOption === 'Carbon Ox State' ? 'w-[60rem]' : 'w-80'
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
                    
                    <div className="max-h-60 overflow-y-auto border border-slate-800 rounded bg-slate-950/40 p-1.5 space-y-2">
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
                      {Array.from({ length: Math.min(10, pcoaResult?.proportion_explained?.length || 2) }).map((_, i) => (
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
                      {Array.from({ length: Math.min(10, pcoaResult?.proportion_explained?.length || 2) }).map((_, i) => (
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
                        { id: 'permanova', label: 'PERMANOVA' },
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
                      <div className="pt-2">
                        {pcoaActiveTab === 'plot' && renderPcoaScatterPlot()}
                        {pcoaActiveTab === 'variance' && renderVarianceBarChart()}
                        {pcoaActiveTab === 'permanova' && renderPermanovaStats()}
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
              ) : globalAnalysisOption === 'Metabolite Boxplots' ? (
                renderMetaboliteBoxplots()
              ) : globalAnalysisOption === 'Van Krevelen' ? (
                renderVanKrevelen()
              ) : globalAnalysisOption === 'Carbon Ox State' ? (
                renderCarbonOxState()
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

          <label className="flex items-start gap-2 text-[10px] text-slate-300 cursor-pointer select-none leading-tight">
            <input
              type="checkbox"
              checked={!!metaboliteQuery.has_annotation}
              onChange={(e) => setMetaboliteQuery((q) => ({ ...q, has_annotation: e.target.checked }))}
              className="rounded scale-90 accent-ocean-500 mt-0.5"
            />
            <span>
              Only show annotated metabolites
            </span>
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

          {metaboliteMatches.length > 0 && !metaboliteMatchesLoading && (
            <div className="flex items-center justify-between bg-slate-950/30 border border-slate-800 rounded px-2 py-1.5">
              <span className="text-[10px] text-slate-400">Intensity scale</span>
              <div className="flex items-center gap-1">
                {['log', 'linear'].map((mode) => (
                  <button
                    key={mode}
                    onClick={() => setIntensityScale(mode)}
                    className={`text-[10px] px-2 py-0.5 rounded border ${
                      intensityScale === mode
                        ? 'bg-ocean-700 border-ocean-600 text-white'
                        : 'bg-slate-800 border-slate-700 text-slate-300 hover:text-slate-100'
                    }`}
                  >
                    {mode === 'log' ? 'Log10' : 'Linear'}
                  </button>
                ))}
              </div>
            </div>
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
                    onClick={() => setSelectedFeature(feature)}
                    className="text-[11px] text-slate-200 font-semibold break-all text-left hover:text-ocean-400 hover:underline transition-colors w-full focus:outline-none"
                    title="Click to select metabolite and see present samples"
                  >
                    {feature.metabolite}
                  </button>
                  <p className="text-[10px] text-slate-400 mt-1">
                    row ID: {feature.row_id} | m/z: {formatMz(feature.row_mz)} | RT: {formatRt(feature.row_retention_time)}
                  </p>
                  <p className="text-[10px] text-slate-400">
                    {feature.annotation ?? 'No annotation'}
                    {' • '}
                    {(() => {
                      const detected = feature.detected_sample_count ?? feature.sample_count
                      const total = feature.sample_count
                      if (detected === total) return `${total.toLocaleString()} samples`
                      return `found in ${detected.toLocaleString()} of ${total.toLocaleString()} samples`
                    })()}
                  </p>
                  
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
            // Dataset is the only section expanded by default.
            const isCollapsed = collapsedSections['_dataset'] === true
            return (
              <div className="space-y-1">
                <button
                  onClick={() => setCollapsedSections((prev) => ({ ...prev, _dataset: !isCollapsed }))}
                  className="w-full flex items-center justify-between group"
                >
                  <span className="flex items-center gap-1 text-xs text-slate-400 font-medium group-hover:text-slate-200 transition-colors">
                    {isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                    Dataset
                  </span>
                  {activeFilters.size > 0 && (
                    <span className="flex items-center gap-2">
                      <span className="text-[10px] text-slate-500">{activeFilters.size} selected</span>
                      <button
                        onClick={(e) => { e.stopPropagation(); clearFilter('_dataset') }}
                        className="text-xs text-ocean-400 hover:text-ocean-300"
                      >
                        Clear
                      </button>
                    </span>
                  )}
                </button>
                {!isCollapsed && (
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
                                {(datasetPointCounts[datasetInfo.name] ?? datasetInfo.n_samples ?? 0).toLocaleString()} samples • {datasetInfo.n_features?.toLocaleString() ?? 0} features
                              </span>
                            )}
                          </div>
                        </label>
                      )
                    })}
                  </div>
                )}
              </div>
            )
          })()}

          {/* Sample Specific search/filter listing (rendered specifically second at the top) */}
          {mapData?.points && (() => {
            // All non-Dataset sections default to collapsed.
            const isCollapsed = collapsedSections['_samples'] !== false
            return (
              <div className="space-y-2 border-t border-slate-800 pt-3">
                <button
                  onClick={() => setCollapsedSections((prev) => ({ ...prev, '_samples': !isCollapsed }))}
                  className="w-full flex items-center justify-between group"
                >
                  <span className="flex items-center gap-1 text-xs text-slate-400 font-medium group-hover:text-slate-200 transition-colors">
                    {isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                    Individual Samples
                  </span>
                  {selectedSamples.size > 0 && (
                    <span className="flex items-center gap-2">
                      <span className="text-[10px] text-slate-500">{selectedSamples.size} selected</span>
                      <button
                        onClick={(e) => { e.stopPropagation(); setSelectedSamples(new Set()) }}
                        className="text-xs text-ocean-400 hover:text-ocean-300"
                      >
                        Clear
                      </button>
                    </span>
                  )}
                </button>
                {!isCollapsed && (
                  <>
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
                            || mapData?.dataset_safe_map?.[String(p?._dataset ?? '')]
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
                  </>
                )}
              </div>
            )
          })()}

          {/* Filters per metadata column (rendered below the dataset & sample filter sections) */}
          {filterCols.map((col) => {
            const activeFilters = filters[col] ?? new Set()
            
            // Only render non-dataset and non-filename columns here; dataset and individual samples are already handled at the top
            if (col === '_dataset' || col.toLowerCase() === 'filename') return null;

            // All non-Dataset sections default to collapsed.
            const isCollapsed = collapsedSections[col] !== false
            return (
              <div key={col} className="space-y-1 border-t border-slate-800 pt-3">
                <button
                  onClick={() => setCollapsedSections((prev) => ({ ...prev, [col]: !isCollapsed }))}
                  className="w-full flex items-center justify-between group"
                >
                  <span className="flex items-center gap-1 text-xs text-slate-400 font-medium group-hover:text-slate-200 transition-colors">
                    {isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                    {col}
                  </span>
                  {activeFilters.size > 0 && (
                    <span className="flex items-center gap-2">
                      <span className="text-[10px] text-slate-500">{activeFilters.size} selected</span>
                      <button
                        onClick={(e) => { e.stopPropagation(); clearFilter(col) }}
                        className="text-xs text-ocean-400 hover:text-ocean-300"
                      >
                        Clear
                      </button>
                    </span>
                  )}
                </button>
                {!isCollapsed && (
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
                )}
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
      {(intensityInfo || (colorBy && columnValues[colorBy] && columnValues[colorBy].length > 0)) && (
        <div
          ref={legendRef}
          className="absolute z-20 w-72 bg-slate-900/95 border border-slate-700 rounded-xl shadow-xl"
          style={legendPos}
        >
          <div
            onMouseDown={beginLegendDrag}
            className={`px-3 py-2 border-b border-slate-700 flex items-center justify-between cursor-move ${legendDragging ? 'select-none' : ''}`}
          >
            <p className="text-xs text-slate-300 font-semibold">
              {intensityInfo ? `${intensityInfo.scale === 'log' ? 'Log10' : 'Linear'} Intensity: ${mapFeature?.metabolite ?? 'Metabolite'}` : 'Legend'}
            </p>
            <span className="text-[10px] text-slate-500">drag</span>
          </div>
          <div className="p-3">
            {intensityInfo ? (
              <div className="space-y-1.5">
                <div
                  className="h-4 w-full rounded"
                  style={{ background: 'linear-gradient(to right, rgb(59,130,246), rgb(34,211,238), rgb(250,204,21), rgb(239,68,68))' }}
                />
                <div className="flex justify-between text-[10px] text-slate-400 font-mono">
                  <span title={`Min intensity: ${intensityInfo.scale === 'log' ? Math.pow(10, intensityInfo.min).toExponential(2) : intensityInfo.min.toExponential(2)}`}>
                    {intensityInfo.min.toFixed(2)}
                  </span>
                  <span title={`Max intensity: ${intensityInfo.scale === 'log' ? Math.pow(10, intensityInfo.max).toExponential(2) : intensityInfo.max.toExponential(2)}`}>
                    {intensityInfo.max.toFixed(2)}
                  </span>
                </div>
                <div className="flex items-center gap-2 text-[10px] text-slate-400">
                  <span className="w-3 h-3 rounded-full shrink-0 bg-gray-500" />
                  <span>Not detected (intensity = 0)</span>
                </div>
                <p className="text-[10px] text-slate-500">
                  Cool (low) → warm (high). Point size also scales with intensity.
                </p>
              </div>
            ) : (
              <div className="max-h-40 overflow-y-auto space-y-1">
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
    </div>
  )
}
