import { useState } from 'react'
import { blankRemovalPreview } from '../api'
import { Trash2, Droplets } from 'lucide-react'

export default function DataCleanup({ sessionId, mdColumnsInfo, onUpdate }) {
  const [blankEnabled, setBlankEnabled] = useState(false)
  const [sampleCol, setSampleCol] = useState('')
  const [sampleVals, setSampleVals] = useState([])
  const [blankCol, setBlankCol] = useState('')
  const [blankVals, setBlankVals] = useState([])
  const [cutoff, setCutoff] = useState(0.3)
  const [preview, setPreview] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const [imputeEnabled, setImputeEnabled] = useState(false)

  const columns = mdColumnsInfo ?? []

  const colLevels = (colName) =>
    columns.find((c) => c.column === colName)?.levels ?? []

  const toggle = (arr, val) =>
    arr.includes(val) ? arr.filter((v) => v !== val) : [...arr, val]

  const runPreview = async () => {
    if (!sampleCol || !sampleVals.length || !blankCol || !blankVals.length) {
      setError('Select sample and blank columns/values first.')
      return
    }
    setError('')
    setLoading(true)
    try {
      const result = await blankRemovalPreview(sessionId, {
        sample_column: sampleCol,
        sample_rows: sampleVals,
        blank_column: blankCol,
        blank_rows: blankVals,
        cutoff,
      })
      setPreview(result)
      onUpdate({ blankRemovalApplied: true, imputeEnabled })
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  // Propagate impute change upward
  const handleImputeToggle = (val) => {
    setImputeEnabled(val)
    onUpdate({ blankRemovalApplied: !!preview, imputeEnabled: val })
  }

  return (
    <div className="space-y-6">
      {/* Blank Removal */}
      <div className="bg-slate-800 rounded-lg border border-slate-700 p-4 space-y-4">
        <div className="flex items-center gap-3">
          <Trash2 size={16} className="text-red-400" />
          <h3 className="font-semibold text-slate-200">Blank Removal</h3>
          <label className="ml-auto flex items-center gap-2 text-sm text-slate-400 cursor-pointer">
            <input
              type="checkbox"
              checked={blankEnabled}
              onChange={(e) => setBlankEnabled(e.target.checked)}
              className="rounded"
            />
            Enable
          </label>
        </div>

        {blankEnabled && (
          <>
            {columns.length === 0 ? (
              <p className="text-slate-500 text-sm">No metadata loaded — blank removal unavailable.</p>
            ) : (
              <div className="grid grid-cols-2 gap-4">
                {/* Samples */}
                <div className="space-y-2">
                  <label className="text-xs text-slate-400 font-medium">Sample column</label>
                  <select
                    className="w-full bg-slate-700 border border-slate-600 rounded px-2 py-1.5 text-sm text-slate-200"
                    value={sampleCol}
                    onChange={(e) => { setSampleCol(e.target.value); setSampleVals([]) }}
                  >
                    <option value="">— select —</option>
                    {columns.map((c) => <option key={c.column} value={c.column}>{c.column}</option>)}
                  </select>

                  {sampleCol && (
                    <div className="border border-slate-700 rounded p-2 max-h-40 overflow-y-auto space-y-1">
                      <p className="text-xs text-slate-500 mb-1">Select sample values:</p>
                      {colLevels(sampleCol).map((lv) => (
                        <label key={lv} className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={sampleVals.includes(lv)}
                            onChange={() => setSampleVals(toggle(sampleVals, lv))}
                          />
                          {lv}
                        </label>
                      ))}
                    </div>
                  )}
                </div>

                {/* Blanks */}
                <div className="space-y-2">
                  <label className="text-xs text-slate-400 font-medium">Blank column</label>
                  <select
                    className="w-full bg-slate-700 border border-slate-600 rounded px-2 py-1.5 text-sm text-slate-200"
                    value={blankCol}
                    onChange={(e) => { setBlankCol(e.target.value); setBlankVals([]) }}
                  >
                    <option value="">— select —</option>
                    {columns.map((c) => <option key={c.column} value={c.column}>{c.column}</option>)}
                  </select>

                  {blankCol && (
                    <div className="border border-slate-700 rounded p-2 max-h-40 overflow-y-auto space-y-1">
                      <p className="text-xs text-slate-500 mb-1">Select blank values:</p>
                      {colLevels(blankCol).map((lv) => (
                        <label key={lv} className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={blankVals.includes(lv)}
                            onChange={() => setBlankVals(toggle(blankVals, lv))}
                          />
                          {lv}
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Cutoff */}
            <div className="flex items-center gap-4">
              <label className="text-xs text-slate-400">
                Cutoff (blank/sample ratio):
              </label>
              <input
                type="range"
                min={0.05}
                max={1}
                step={0.05}
                value={cutoff}
                onChange={(e) => setCutoff(parseFloat(e.target.value))}
                className="flex-1"
              />
              <span className="text-sm text-slate-200 w-10 text-right">{cutoff}</span>
            </div>

            {error && <p className="text-red-400 text-xs">{error}</p>}

            <button
              onClick={runPreview}
              disabled={loading}
              className="px-4 py-2 bg-red-700 hover:bg-red-600 text-white text-sm rounded font-medium disabled:opacity-50"
            >
              {loading ? 'Computing…' : 'Apply Blank Removal'}
            </button>

            {preview && (
              <div className="flex gap-6 text-sm">
                <Stat label="Background removed" value={preview.n_background} color="text-red-400" />
                <Stat label="Real features kept" value={preview.n_real} color="text-green-400" />
                <Stat label="New FT shape" value={preview.new_shape?.join(' × ')} color="text-slate-300" />
              </div>
            )}
          </>
        )}
      </div>

      {/* Imputation */}
      <div className="bg-slate-800 rounded-lg border border-slate-700 p-4">
        <div className="flex items-center gap-3">
          <Droplets size={16} className="text-blue-400" />
          <h3 className="font-semibold text-slate-200">Imputation of Missing Values</h3>
          <label className="ml-auto flex items-center gap-2 text-sm text-slate-400 cursor-pointer">
            <input
              type="checkbox"
              checked={imputeEnabled}
              onChange={(e) => handleImputeToggle(e.target.checked)}
              className="rounded"
            />
            Enable
          </label>
        </div>
        {imputeEnabled && (
          <p className="mt-2 text-xs text-slate-400">
            Zeros will be replaced with a random value between 1 and the lowest detected intensity (limit of detection).
          </p>
        )}
      </div>
    </div>
  )
}

function Stat({ label, value, color }) {
  return (
    <div>
      <p className="text-xs text-slate-500">{label}</p>
      <p className={`font-semibold ${color}`}>{value}</p>
    </div>
  )
}
