import { useState, useCallback, useEffect } from 'react'
import { FileDrop, MetadataUploader } from '../components/FileUploader'
import DataTable from '../components/DataTable'

import {
  uploadManual,
  uploadGnps,
  saveDataset,
  listDatasets,
  deleteDataset,
  getDatasetSettings,
  updateDataset,
} from '../api'
import {
  Upload,
  Link,
  CheckCircle,
  X,
  Trash2,
  Pencil,
  AlertTriangle,
  Save,
  RefreshCw,
  Database,
} from 'lucide-react'

const STEPS = ['Load Data', 'Preview Tables', 'Save Dataset']

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
  // Metadata columns shown publicly (hover panel, sample filters, analyses)
  const [visibleMdColumns, setVisibleMdColumns] = useState(new Set())
  // Name
  const [datasetName, setDatasetName] = useState('')

  // UI state
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [successMsg, setSuccessMsg] = useState('')

  // Dataset library
  const [datasets, setDatasets] = useState([])
  const [editingSafe, setEditingSafe] = useState(null) // safe_name of the library card being edited
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
      setVisibleMdColumns(new Set(result.md_columns ?? [])) // all visible by default
      setDatasetName(result.default_name || '')

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
        visible_md_columns: (session.md_columns ?? []).filter((c) => visibleMdColumns.has(c)),
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
    try {
      await deleteDataset(safeName)
    } catch (e) {
      setError(e.message)
    }
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
                    <option value="eb">EB (Everything Bagel)</option>
                  </select>
                </div>
                <p className="text-xs text-slate-500">
                  {workflow === 'eb'
                    ? 'Supports GNPS2 Everything Bagel task IDs.'
                    : 'Supports GNPS1 and GNPS2 task IDs.'}{' '}
                  Note: metadata with Latitude/Longitude is required for map display.
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
            {session.preview_max_cols && (
              <p className="text-xs text-slate-500">
                Preview shows up to the first {session.preview_max_rows} rows and {session.preview_max_cols} columns
                of each table (all columns for Metadata); the full tables are saved.
              </p>
            )}

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
                Next: Save Dataset →
              </button>
            </div>
          </div>
        )}

        {/* ── STEP 2: Save ─────────────────────────────────────────────── */}
        {step === 2 && session && (
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

              {(session.md_columns ?? []).length > 0 && (
                <div className="space-y-1.5 border-t border-slate-700 pt-3">
                  <div className="flex items-center justify-between">
                    <label className="text-xs text-slate-400 font-medium">
                      Public metadata ({visibleMdColumns.size} of {session.md_columns.length})
                    </label>
                    <div className="flex gap-2 text-[11px]">
                      <button
                        onClick={() => setVisibleMdColumns(new Set(session.md_columns))}
                        className="text-ocean-400 hover:text-ocean-300"
                      >
                        Select all
                      </button>
                      <button
                        onClick={() => setVisibleMdColumns(new Set())}
                        className="text-slate-400 hover:text-slate-200"
                      >
                        None
                      </button>
                    </div>
                  </div>
                  <p className="text-xs text-slate-500">
                    Checked columns are shown when hovering over a sample and can be used in Sample Filtering and the
                    statistical analyses. Unchecked columns are never sent to the public map. The sample filename is
                    always shown, and {session.lat_col} / {session.lon_col} still position samples on the map.
                  </p>
                  <div className="max-h-56 overflow-y-auto border border-slate-700 rounded bg-slate-900/40 p-2 space-y-0.5">
                    {session.md_columns.map((col) => (
                      <label key={col} className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer hover:bg-slate-700/40 rounded px-1 py-0.5">
                        <input
                          type="checkbox"
                          checked={visibleMdColumns.has(col)}
                          onChange={() => setVisibleMdColumns((prev) => {
                            const next = new Set(prev)
                            next.has(col) ? next.delete(col) : next.add(col)
                            return next
                          })}
                          className="rounded accent-ocean-500"
                        />
                        <span className="truncate" title={col}>{col}</span>
                      </label>
                    ))}
                  </div>
                </div>
              )}

              <div className="space-y-1 text-sm text-slate-400 border-t border-slate-700 pt-3">
                <p>Summary:</p>
                <ul className="space-y-0.5 text-xs">
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
                    <div className="flex">
                      <button
                        onClick={() => setEditingSafe(editingSafe === ds.safe_name ? null : ds.safe_name)}
                        className="text-slate-400 hover:text-slate-200 p-1"
                        title="Edit name and public metadata"
                      >
                        <Pencil size={14} />
                      </button>
                      <button
                        onClick={() => handleDelete(ds.safe_name)}
                        className="text-red-400 hover:text-red-300 p-1"
                        title="Delete dataset"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                  {editingSafe === ds.safe_name && (
                    <DatasetEditor
                      safeName={ds.safe_name}
                      onCancel={() => setEditingSafe(null)}
                      onSaved={(updated) => {
                        setEditingSafe(null)
                        setSuccessMsg(`Dataset "${updated.name}" updated.`)
                        refreshLibrary()
                      }}
                    />
                  )}
                  <div className="text-xs text-slate-400 space-y-0.5">
                    <p>{ds.n_samples} samples · {ds.n_features} features</p>
                    <p className={ds.has_coords ? 'text-green-400' : 'text-yellow-500'}>
                      {ds.has_coords ? `📍 ${ds.lat_col} / ${ds.lon_col}` : '⚠ No coordinates'}
                    </p>
                    {ds.has_annotation && <p className="text-ocean-400">✓ Annotated</p>}
                    {ds.n_md_columns_total > 0 && (
                      <p>{ds.md_columns?.length ?? 0} of {ds.n_md_columns_total} metadata fields public</p>
                    )}
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

// Edit a saved dataset's display name and which metadata columns are public.
function DatasetEditor({ safeName, onCancel, onSaved }) {
  const [settings, setSettings] = useState(null)
  const [name, setName] = useState('')
  const [publicCols, setPublicCols] = useState(new Set())
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    getDatasetSettings(safeName)
      .then((s) => {
        if (cancelled) return
        setSettings(s)
        setName(s.name)
        setPublicCols(new Set(s.md_columns))
      })
      .catch((e) => { if (!cancelled) setError(e.message) })
    return () => { cancelled = true }
  }, [safeName])

  const handleSave = async () => {
    if (!name.trim()) { setError('Dataset name is required.'); return }
    setSaving(true)
    setError('')
    try {
      const updated = await updateDataset(safeName, {
        name: name.trim(),
        md_columns: settings.md_columns_all.filter((c) => publicCols.has(c)),
      })
      onSaved(updated)
    } catch (e) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  if (!settings) {
    return error
      ? <p className="text-xs text-red-400">{error}</p>
      : <p className="text-xs text-slate-500 flex items-center gap-1"><RefreshCw size={12} className="animate-spin" /> Loading settings…</p>
  }

  return (
    <div className="space-y-2 border-t border-slate-700 pt-2">
      <div className="space-y-1">
        <label className="text-xs text-slate-400 font-medium">Name</label>
        <input
          className="w-full bg-slate-900 border border-slate-600 rounded px-2 py-1 text-sm text-slate-200 focus:outline-none focus:border-ocean-500"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <div className="space-y-1">
        <div className="flex items-center justify-between">
          <label className="text-xs text-slate-400 font-medium">
            Public metadata ({publicCols.size} of {settings.md_columns_all.length})
          </label>
          <div className="flex gap-2 text-[11px]">
            <button onClick={() => setPublicCols(new Set(settings.md_columns_all))} className="text-ocean-400 hover:text-ocean-300">
              Select all
            </button>
            <button onClick={() => setPublicCols(new Set())} className="text-slate-400 hover:text-slate-200">
              None
            </button>
          </div>
        </div>
        <p className="text-[11px] text-slate-500">
          {settings.lat_col} / {settings.lon_col} always position samples on the map.
        </p>
        <div className="max-h-48 overflow-y-auto border border-slate-700 rounded bg-slate-900/40 p-2 space-y-0.5">
          {settings.md_columns_all.map((col) => (
            <label key={col} className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer hover:bg-slate-700/40 rounded px-1 py-0.5">
              <input
                type="checkbox"
                checked={publicCols.has(col)}
                onChange={() => setPublicCols((prev) => {
                  const next = new Set(prev)
                  next.has(col) ? next.delete(col) : next.add(col)
                  return next
                })}
                className="rounded accent-ocean-500"
              />
              <span className="truncate" title={col}>{col}</span>
            </label>
          ))}
        </div>
      </div>
      {error && <p className="text-xs text-red-400">{error}</p>}
      <div className="flex gap-2">
        <button
          onClick={handleSave}
          disabled={saving}
          className="px-3 py-1.5 bg-ocean-600 hover:bg-ocean-500 text-white rounded text-xs font-medium disabled:opacity-50 flex items-center gap-1"
        >
          {saving ? <RefreshCw size={12} className="animate-spin" /> : <Save size={12} />} Save changes
        </button>
        <button onClick={onCancel} className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 text-slate-200 rounded text-xs font-medium">
          Cancel
        </button>
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
