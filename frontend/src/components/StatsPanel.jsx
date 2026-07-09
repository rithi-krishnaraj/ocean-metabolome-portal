import { useState, useRef, useEffect } from 'react'
import { Database, MapPin, FlaskConical, X } from 'lucide-react'

export default function StatsPanel({ datasets = [], samples = 0, features = 0 }) {
  const [showDropdown, setShowDropdown] = useState(false)
  const dropdownRef = useRef(null)

  const isArray = Array.isArray(datasets)
  const count = isArray ? datasets.length : Number(datasets)
  const hasDetails = isArray && datasets.length > 0

  // Close dropdown when clicking outside
  useEffect(() => {
    if (!showDropdown) return
    const handleClickOutside = (e) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
        setShowDropdown(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [showDropdown])

  return (
    <div className="relative flex flex-col gap-2" ref={dropdownRef}>
      <div className="flex gap-3 flex-wrap">
        <StatCard
          icon={<Database size={14} />}
          label="Datasets"
          value={count}
          onClick={hasDetails ? () => setShowDropdown(!showDropdown) : undefined}
          clickable={hasDetails}
        />
        <StatCard icon={<MapPin size={14} />} label="Total Samples" value={samples.toLocaleString()} />
        <StatCard icon={<FlaskConical size={14} />} label="Total Features" value={features.toLocaleString()} />
      </div>

      {showDropdown && hasDetails && (
        <div className="absolute top-12 left-0 z-50 w-96 bg-slate-900/95 border border-slate-700 rounded-xl p-4 shadow-2xl max-h-[70vh] overflow-y-auto space-y-3">
          <div className="flex items-center justify-between border-b border-slate-800 pb-2">
            <h4 className="font-semibold text-slate-200 text-xs tracking-wider uppercase">Dataset Information</h4>
            <button
              onClick={() => setShowDropdown(false)}
              className="text-slate-500 hover:text-slate-300 transition-colors"
            >
              <X size={14} />
            </button>
          </div>
          <div className="space-y-2.5 max-h-[50vh] overflow-y-auto pr-1">
            {datasets.map((ds, idx) => (
              <div
                key={ds.safe_name || idx}
                className="bg-slate-950/40 border border-slate-800/60 rounded-lg p-2.5 space-y-1 hover:border-slate-700 transition-colors"
              >
                <div className="flex items-start justify-between gap-2">
                  <span className="font-medium text-xs text-ocean-300 break-all leading-tight">
                    {ds.name}
                  </span>
                  {!ds.has_coords && (
                    <span className="shrink-0 text-[9px] bg-amber-950/40 text-amber-400 border border-amber-800/40 px-1.5 py-0.5 rounded-full uppercase tracking-wider">
                      No coordinates
                    </span>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-4 pt-1 text-[11px] text-slate-400">
                  <div className="flex flex-col">
                    <span className="text-[10px] text-slate-500 uppercase tracking-wider">Samples</span>
                    <span className="text-slate-200 font-semibold mt-0.5">{ds.n_samples?.toLocaleString() ?? 0}</span>
                  </div>
                  <div className="flex flex-col">
                    <span className="text-[10px] text-slate-500 uppercase tracking-wider">Features</span>
                    <span className="text-slate-200 font-semibold mt-0.5">{ds.n_features?.toLocaleString() ?? 0}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function StatCard({ icon, label, value, onClick, clickable }) {
  return (
    <div
      onClick={onClick}
      className={`bg-slate-800/90 border border-slate-700 rounded-lg px-3 py-2 flex items-center gap-2 ${
        clickable ? 'cursor-pointer hover:bg-slate-700/90 hover:border-slate-600 transition-all select-none active:scale-[0.98]' : ''
      }`}
    >
      <span className="text-ocean-400">{icon}</span>
      <div>
        <div className="flex items-center gap-1">
          <p className="text-xs text-slate-400">{label}</p>
        </div>
        <p className="text-sm font-bold text-slate-100">{value}</p>
      </div>
    </div>
  )
}
