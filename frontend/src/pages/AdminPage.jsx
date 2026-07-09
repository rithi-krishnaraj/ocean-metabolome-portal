import { useState, useCallback } from 'react'
import { FileDrop, MetadataUploader } from '../components/FileUploader'
import DataTable from '../components/DataTable'
import DataCleanup from '../components/DataCleanup'
import {
  uploadManual,
  uploadGnps,
  getSessionMdInfo,
  saveDataset,
  listDatasets,
  deleteDataset,
} from '../api'
import { useEffect } from 'react'
import {
  Upload,
  Link,
  CheckCircle,
  X,
  Trash2,
  AlertTriangle,
  Save,
  RefreshCw,
  Database,
} from 'lucide-react'

const STEPS = ['Load Data', 'Preview Tables', 'Data Cleanup', 'Save Dataset']

export default function AdminPage() {
  const [step, setStep] = useState(0)
  const [inputMode, setInputMode] = useState('manual') // 'manual' | 'gnps'

  // Files
  const [ftFile, setFtFile] = useState(null)
  const [mdFile, setMdFile] = useState(null)
  const [anFile, setAnFile] = useState(null)
  const [isMetadataValid, setIsMetadataValid] = useState(false)

  // GNPS
  const [taskId, setTaskId] = useState('')
  const [workflow, setWorkflow] = useState('fbmn')

  // Session data returned by backend
  const [session, setSession] = useState(null)
  const [mdColumnsInfo, setMdColumnsInfo] = useState([])

  // Cleanup config
  const [cleanupState, setCleanupState] = useState({
    blankRemovalApplied: false,
    imputeEnabled: false,
  })

  // Name
  const [datasetName, setDatasetName] = useState('')

  // UI state
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [successMsg, setSuccessMsg] = useState('')

  // Dataset library
  const [datasets, setDatasets] = useState([])
  const [activeTab, setActiveTab] = useState('ft')

  const normalizeTaskId = (value) => String(value ?? '').trim().toLowerCase()
  const isTaskIdLike = (value) => /^[a-f0-9]{32}$/i.test(String(value ?? '').trim())

  const duplicateGnpsTask = inputMode === 'gnps'
    ? datasets.find((ds) => {
        const current = normalizeTaskId(taskId)
        if (!current || !isTaskIdLike(current)) return false

        const sourceTask = normalizeTaskId(ds.source_task_id)
        const name = normalizeTaskId(ds.name)
        const safeName = normalizeTaskId(ds.safe_name)

        // source_task_id is authoritative for newly saved GNPS datasets.
        if (sourceTask && sourceTask === current) return true

        // Legacy fallback: older datasets may only have name/safe_name set to task id.
        return (isTaskIdLike(name) && name === current) || (isTaskIdLike(safeName) && safeName === current)
      })
    : null

  // Fetch library
  const refreshLibrary = useCallback(async () => {
    try {
      const data = await listDatasets()
      setDatasets(data)
    } catch (_) {}
  }, [])

  useEffect(() => { refreshLibrary() }, [refreshLibrary])

  // ── Step 0: Load files ─────────────────────────────────────────────────────

  const handleLoad = async () => {
    setError('')
    setLoading(true)
    try {
      let result
      if (inputMode === 'manual') {
        if (!ftFile || !mdFile) throw new Error('Please select both a feature table and a metadata table.')
        const fd = new FormData()
        fd.append('ft_file', ftFile)
        fd.append('md_file', mdFile)
        if (anFile) fd.append('an_file', anFile)
        result = await uploadManual(fd)
      } else {
        if (!taskId.trim()) throw new Error('Please enter a GNPS task ID.')
        if (duplicateGnpsTask) {
          throw new Error(
            `GNPS task ID "${taskId.trim()}" is already present in Dataset Library as "${duplicateGnpsTask.name}".`
          )
        }
        result = await uploadGnps(taskId.trim(), workflow)
      }

      if (!result.has_coords) {
        throw new Error(
          'Metadata table is missing required Latitude/Longitude columns. ' +
          'This dataset cannot be submitted to the dataset library.'
        )
      }

      setSession(result)
      setDatasetName(result.default_name || '')

      // Fetch md column info for blank removal
      const info = await getSessionMdInfo(result.session_id)
      setMdColumnsInfo(info.columns_info ?? [])

      setStep(1)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  // ── Step 3: Save ──────────────────────────────────────────────────────────

  const handleSave = async () => {
    if (!datasetName.trim()) { setError('Dataset name is required.'); return }
    if (!session?.has_coords) {
      setError('Cannot save dataset: metadata must include Latitude and Longitude columns.')
      return
    }
    setError('')
    setLoading(true)
    try {
      await saveDataset({
        session_id: session.session_id,
        name: datasetName.trim(),
        impute: cleanupState.imputeEnabled,
      })
      setSuccessMsg(`Dataset "${datasetName}" saved successfully!`)
      setSession(null)
      setStep(0)
      setFtFile(null); setMdFile(null); setAnFile(null)
      setTaskId('')
      refreshLibrary()
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  const handleDelete = async (safeName) => {
    if (!window.confirm(`Delete dataset "${safeName}"?`)) return
    await deleteDataset(safeName)
    refreshLibrary()
  }

  const tableData = (key) => {
    if (!session) return []
    const map = {
      ft: session.ft_preview,
      md: session.md_preview,
      an: session.an_preview,
      combined: session.combined_preview,
    }
    return map[key] ?? []
  }

  const clearManualInputs = () => {
    setFtFile(null)
    setMdFile(null)
    setAnFile(null)
    setIsMetadataValid(false)
    setError('')
  }

  const clearGnpsInputs = () => {
    setTaskId('')
    setWorkflow('fbmn')
    setError('')
  }

  const loadDisabled = inputMode === 'manual'
    ? (loading || !ftFile || !mdFile || !isMetadataValid)
    : (loading || !taskId.trim() || !!duplicateGnpsTask)

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="flex h-full overflow-hidden">
      {/* Main content */}
      <div className="flex-1 overflow-y-auto p-6 space-y-6">

        {/* Step indicator */}
        <div className="flex items-center gap-0">
          {STEPS.map((s, i) => (
            <div key={s} className="flex items-center">
              <button
                onClick={() => session && i <= step && setStep(i)}
                className={`flex items-center gap-2 px-3 py-1.5 rounded text-sm font-medium transition-colors
                  ${i === step ? 'bg-ocean-600 text-white' : i < step ? 'text-ocean-400 hover:text-ocean-300' : 'text-slate-600 cursor-default'}`}
              >
                <span className={`w-5 h-5 rounded-full flex items-center justify-center text-xs font-bold
                  ${i === step ? 'bg-white text-ocean-600' : i < step ? 'bg-ocean-600 text-white' : 'bg-slate-700 text-slate-500'}`}>
                  {i < step ? '✓' : i + 1}
                </span>
                {s}
              </button>
              {i < STEPS.length - 1 && <div className="w-6 h-0.5 bg-slate-700" />}
            </div>
          ))}
        </div>

        {error && (
          <div className="flex gap-2 text-sm text-red-400 bg-red-900/20 border border-red-700/50 rounded-lg p-3">
            <AlertTriangle size={16} className="shrink-0 mt-0.5" />
            {error}
          </div>
        )}
        {successMsg && (
          <div className="flex gap-2 text-sm text-green-400 bg-green-900/20 border border-green-700/50 rounded-lg p-3">
            <CheckCircle size={16} className="shrink-0 mt-0.5" />
            {successMsg}
            <button className="ml-auto underline" onClick={() => setSuccessMsg('')}>dismiss</button>
          </div>
        )}

        {/* ── STEP 0: Load ─────────────────────────────────────────────── */}
        {step === 0 && (
          <div className="space-y-6">
            <h2 className="text-lg font-bold text-slate-100">Load Dataset</h2>

            {/* Toggle */}
            <div className="flex gap-2">
              <ModeBtn active={inputMode === 'manual'} onClick={() => setInputMode('manual')} icon={<Upload size={14} />}>
                Manual Upload
              </ModeBtn>
              <ModeBtn active={inputMode === 'gnps'} onClick={() => setInputMode('gnps')} icon={<Link size={14} />}>
                GNPS Task ID
              </ModeBtn>
            </div>

            {inputMode === 'manual' ? (
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-1">
                    <label className="text-xs text-slate-400 font-medium">Feature Quantification Table *</label>
                    <FileDrop
                      label="Drag or click to upload"
                      accept=".csv,.tsv,.txt,.xlsx"
                      onFile={setFtFile}
                      file={ftFile}
                      hint="csv, tsv, txt, xlsx"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs text-slate-400 font-medium">Metadata Table * (must include Latitude & Longitude)</label>
                    <MetadataUploader
                      onFile={setMdFile}
                      file={mdFile}
                      onValidationChange={setIsMetadataValid}
                    />
                  </div>
                </div>
                <div className="space-y-1">
                  <label className="text-xs text-slate-400 font-medium">Annotation Table (optional)</label>
                  <FileDrop
                    label="Drag or click to upload annotation table"
                    accept=".csv,.tsv,.txt,.xlsx"
                    onFile={setAnFile}
                    file={anFile}
                    hint="optional"
                  />
                </div>
              </div>
            ) : (
              <div className="space-y-4 max-w-lg">
                <div className="space-y-1">
                  <label className="text-xs text-slate-400 font-medium">GNPS Task ID</label>
                  <input
                    className="w-full bg-slate-800 border border-slate-600 rounded px-3 py-2 text-sm text-slate-200 font-mono"
                    placeholder="e.g. b661d12ba88745639664988329c1363e"
                    value={taskId}
                    onChange={(e) => setTaskId(e.target.value)}
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-xs text-slate-400 font-medium">Workflow type</label>
                  <select
                    className="bg-slate-800 border border-slate-600 rounded px-3 py-2 text-sm text-slate-200"
                    value={workflow}
                    onChange={(e) => setWorkflow(e.target.value)}
                  >
                    <option value="fbmn">FBMN (Feature-Based Molecular Networking)</option>
                    <option value="cmn">CMN (Classical Molecular Networking)</option>
                  </select>
                </div>
                <p className="text-xs text-slate-500">
                  Supports GNPS1 and GNPS2 task IDs. Note: metadata with Latitude/Longitude is required for map display.
                </p>
                {duplicateGnpsTask && (
                  <div className="flex gap-2 text-xs text-yellow-400 bg-yellow-900/20 border border-yellow-700/50 rounded p-2">
                    <AlertTriangle size={14} className="shrink-0 mt-0.5" />
                    <span>
                      This GNPS task ID already exists in Dataset Library as "{duplicateGnpsTask.name}". Please use a different task ID.
                    </span>
                  </div>
                )}
              </div>
            )}

            <div className="flex items-center gap-2">
              <button
                onClick={handleLoad}
                disabled={loadDisabled}
                className="px-6 py-2.5 bg-ocean-600 hover:bg-ocean-500 text-white font-medium rounded-lg text-sm disabled:opacity-50 flex items-center gap-2"
              >
                {loading ? <><RefreshCw size={14} className="animate-spin" /> Loading…</> : <><Upload size={14} /> Load Files</>}
              </button>

              {inputMode === 'manual' ? (
                <button
                  onClick={clearManualInputs}
                  disabled={loading || (!ftFile && !mdFile && !anFile)}
                  className="px-4 py-2.5 bg-slate-700 hover:bg-slate-600 text-slate-200 rounded-lg text-sm font-medium disabled:opacity-50 flex items-center gap-2"
                >
                  <X size={14} /> Clear Inputs
                </button>
              ) : (
                <button
                  onClick={clearGnpsInputs}
                  disabled={loading || (!taskId.trim() && workflow === 'fbmn')}
                  className="px-4 py-2.5 bg-slate-700 hover:bg-slate-600 text-slate-200 rounded-lg text-sm font-medium disabled:opacity-50 flex items-center gap-2"
                >
                  <X size={14} /> Clear Input
                </button>
              )}
            </div>
          </div>
        )}

        {/* ── STEP 1: Preview ──────────────────────────────────────────── */}
        {step === 1 && session && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-bold text-slate-100">Preview Tables</h2>
              {!session.has_coords && (
                <div className="flex items-center gap-2 text-xs text-yellow-400 bg-yellow-900/20 border border-yellow-700/50 rounded px-3 py-1.5">
                  <AlertTriangle size={12} />
                  No latitude/longitude detected — dataset cannot be plotted on the map.
                </div>
              )}
              {session.has_coords && (
                <div className="flex items-center gap-2 text-xs text-green-400 bg-green-900/20 border border-green-700/50 rounded px-3 py-1.5">
                  <CheckCircle size={12} />
                  Coordinates found: {session.lat_col} / {session.lon_col}
                </div>
              )}
            </div>

            {/* Shapes */}
            <div className="flex gap-4 text-xs text-slate-400">
              <span>FT: {session.ft_shape?.[0]} features × {session.ft_shape?.[1]} samples</span>
              <span>MD: {session.md_shape?.[0]} samples × {session.md_shape?.[1]} columns</span>
              {session.an_shape?.[0] > 0 && <span>AN: {session.an_shape?.[0]} rows</span>}
            </div>

            {/* Table tabs */}
            <div className="flex gap-1 border-b border-slate-700">
              {['ft', 'md', 'an', 'combined'].map((t) => (
                <button
                  key={t}
                  onClick={() => setActiveTab(t)}
                  className={`px-3 py-1.5 text-sm rounded-t transition-colors
                    ${activeTab === t ? 'bg-slate-800 text-slate-100 border-b-2 border-ocean-500' : 'text-slate-500 hover:text-slate-300'}`}
                >
                  {t === 'ft' ? 'Feature Table' : t === 'md' ? 'Metadata' : t === 'an' ? 'Annotations' : 'Combined (preview)'}
                </button>
              ))}
            </div>

            <DataTable data={tableData(activeTab)} pageSize={10} />

            <div className="flex gap-3">
              <button onClick={() => setStep(2)} className="px-5 py-2 bg-ocean-600 hover:bg-ocean-500 text-white text-sm rounded-lg font-medium">
                Next: Data Cleanup →
              </button>
              <button onClick={() => setStep(3)} className="px-5 py-2 bg-slate-700 hover:bg-slate-600 text-slate-200 text-sm rounded-lg">
                Skip to Save
              </button>
            </div>
          </div>
        )}

        {/* ── STEP 2: Cleanup ──────────────────────────────────────────── */}
        {step === 2 && session && (
          <div className="space-y-4">
            <h2 className="text-lg font-bold text-slate-100">Data Cleanup</h2>
            <DataCleanup
              sessionId={session.session_id}
              mdColumnsInfo={mdColumnsInfo}
              onUpdate={setCleanupState}
            />
            <button
              onClick={() => setStep(3)}
              className="px-5 py-2 bg-ocean-600 hover:bg-ocean-500 text-white text-sm rounded-lg font-medium"
            >
              Next: Save Dataset →
            </button>
          </div>
        )}

        {/* ── STEP 3: Save ─────────────────────────────────────────────── */}
        {step === 3 && session && (
          <div className="space-y-6">
            <h2 className="text-lg font-bold text-slate-100">Save Dataset</h2>

            <div className="max-w-md space-y-4 bg-slate-800 border border-slate-700 rounded-lg p-4">
              <div className="space-y-1">
                <label className="text-xs text-slate-400 font-medium">Dataset Name *</label>
                <input
                  className="w-full bg-slate-700 border border-slate-600 rounded px-3 py-2 text-sm text-slate-200"
                  placeholder={session.default_name || 'My Ocean Dataset'}
                  value={datasetName}
                  onChange={(e) => setDatasetName(e.target.value)}
                />
                <p className="text-xs text-slate-500">GNPS task ID used as default name if left unchanged.</p>
              </div>

              <div className="space-y-1 text-sm text-slate-400 border-t border-slate-700 pt-3">
                <p>Summary:</p>
                <ul className="space-y-0.5 text-xs">
                  <li className={cleanupState.blankRemovalApplied ? 'text-green-400' : 'text-slate-500'}>
                    {cleanupState.blankRemovalApplied ? '✓' : '○'} Blank removal
                  </li>
                  <li className={cleanupState.imputeEnabled ? 'text-green-400' : 'text-slate-500'}>
                    {cleanupState.imputeEnabled ? '✓' : '○'} Missing value imputation
                  </li>
                  <li className={session.has_coords ? 'text-green-400' : 'text-yellow-400'}>
                    {session.has_coords ? '✓ Has coordinates (will appear on map)' : '⚠ No coordinates (map display disabled)'}
                  </li>
                </ul>
              </div>

              <button
                onClick={handleSave}
                disabled={loading || !datasetName.trim() || !session?.has_coords}
                className="w-full px-5 py-2.5 bg-green-700 hover:bg-green-600 text-white text-sm rounded-lg font-medium flex items-center justify-center gap-2 disabled:opacity-50"
              >
                {loading ? <><RefreshCw size={14} className="animate-spin" /> Saving…</> : <><Save size={14} /> Save Dataset</>}
              </button>
            </div>
          </div>
        )}

        {/* ── Dataset Library ───────────────────────────────────────────── */}
        <div className="mt-8">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-lg font-bold text-slate-100 flex items-center gap-2">
              <Database size={18} className="text-ocean-400" /> Dataset Library
            </h2>
            <button onClick={refreshLibrary} className="text-xs text-slate-400 hover:text-slate-200 flex items-center gap-1">
              <RefreshCw size={12} /> Refresh
            </button>
          </div>

          {datasets.length === 0 ? (
            <p className="text-slate-500 text-sm">No datasets saved yet.</p>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
              {datasets.map((ds) => (
                <div key={ds.safe_name} className="bg-slate-800 border border-slate-700 rounded-lg p-4 space-y-2">
                  <div className="flex items-start justify-between">
                    <h3 className="font-semibold text-slate-200 text-sm">{ds.name}</h3>
                    <button
                      onClick={() => handleDelete(ds.safe_name)}
                      className="text-red-400 hover:text-red-300 p-1"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                  <div className="text-xs text-slate-400 space-y-0.5">
                    <p>{ds.n_samples} samples · {ds.n_features} features</p>
                    <p className={ds.has_coords ? 'text-green-400' : 'text-yellow-500'}>
                      {ds.has_coords ? `📍 ${ds.lat_col} / ${ds.lon_col}` : '⚠ No coordinates'}
                    </p>
                    {ds.has_annotation && <p className="text-ocean-400">✓ Annotated</p>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function ModeBtn({ active, onClick, children, icon }) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium border transition-colors
        ${active ? 'bg-ocean-600 border-ocean-500 text-white' : 'bg-slate-800 border-slate-700 text-slate-400 hover:text-slate-200'}`}
    >
      {icon} {children}
    </button>
  )
}
