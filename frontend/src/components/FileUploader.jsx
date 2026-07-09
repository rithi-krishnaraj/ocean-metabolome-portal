import { useEffect, useRef, useState } from 'react'
import Papa from 'papaparse'
import { Upload, FileText, AlertTriangle } from 'lucide-react'

const LAT_ALIASES = ['latitude', 'lat', 'attribute_latitude']
const LON_ALIASES = ['longitude', 'lon', 'long', 'attribute_longitude']

function hasCoordinates(headers) {
  const lower = headers.map((h) => h.toLowerCase())
  const hasLat = lower.some((h) => LAT_ALIASES.includes(h))
  const hasLon = lower.some((h) => LON_ALIASES.includes(h))
  return { hasLat, hasLon }
}

export function FileDrop({ label, accept, onFile, file, hint = '' }) {
  const inputRef = useRef()
  const [dragging, setDragging] = useState(false)

  const handle = (f) => {
    if (f) onFile(f)
  }

  return (
    <div
      className={`border-2 border-dashed rounded-lg p-4 text-center cursor-pointer transition-colors
        ${dragging ? 'border-ocean-400 bg-ocean-900/20' : 'border-slate-600 hover:border-slate-500'}`}
      onClick={() => inputRef.current?.click()}
      onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => { e.preventDefault(); setDragging(false); handle(e.dataTransfer.files[0]) }}
    >
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        className="hidden"
        onChange={(e) => handle(e.target.files[0])}
      />
      {file ? (
        <div className="flex items-center justify-center gap-2 text-ocean-400">
          <FileText size={16} />
          <span className="text-sm font-medium">{file.name}</span>
        </div>
      ) : (
        <div className="text-slate-500">
          <Upload size={20} className="mx-auto mb-1" />
          <p className="text-sm">{label}</p>
          {hint && <p className="text-xs mt-0.5">{hint}</p>}
        </div>
      )}
    </div>
  )
}

/** Validates that the metadata file contains lat/lon BEFORE uploading. */
export function MetadataUploader({ onFile, file, onValidationChange = () => {} }) {
  const [warning, setWarning] = useState('')

  useEffect(() => {
    if (!file) {
      setWarning('')
      onValidationChange(false)
    }
  }, [file, onValidationChange])

  const handle = (f) => {
    setWarning('')

    // Let backend validate XLSX content; client-side header parse is CSV/TSV/TXT only.
    if (f.name.toLowerCase().endsWith('.xlsx')) {
      onValidationChange(true)
      onFile(f)
      return
    }

    // Quick client-side parse to check headers
    Papa.parse(f, {
      preview: 2,
      skipEmptyLines: true,
      error: () => {
        setWarning(
          `⚠️ Could not read metadata headers from "${f.name}". ` +
          `Please upload a valid csv/tsv/txt metadata file with Latitude/Longitude columns.`
        )
        onValidationChange(false)
        onFile(f)
      },
      complete: (results) => {
        const headers = results.data[0] ?? []
        if (!Array.isArray(headers) || headers.length === 0) {
          setWarning(
            `⚠️ Could not detect metadata headers in "${f.name}". ` +
            `Please upload a valid metadata table with Latitude/Longitude columns.`
          )
          onValidationChange(false)
          onFile(f)
          return
        }

        const { hasLat, hasLon } = hasCoordinates(headers)
        if (!hasLat || !hasLon) {
          setWarning(
            `⚠️ No latitude/longitude columns detected in "${f.name}". ` +
            `Expected columns like: Latitude, longitude, lat, lon. ` +
            `This dataset cannot be submitted to the dataset library.`
          )
          onValidationChange(false)
        } else {
          onValidationChange(true)
        }
        onFile(f)
      },
    })
  }

  return (
    <div className="space-y-2">
      <FileDrop
        label="Meta Data Table"
        accept=".csv,.tsv,.txt,.xlsx"
        onFile={handle}
        file={file}
        hint="Must include Latitude & Longitude columns for map display"
      />
      {warning && (
        <div className="flex gap-2 text-xs text-yellow-400 bg-yellow-900/20 border border-yellow-700/50 rounded p-2">
          <AlertTriangle size={14} className="shrink-0 mt-0.5" />
          <span>{warning}</span>
        </div>
      )}
    </div>
  )
}
