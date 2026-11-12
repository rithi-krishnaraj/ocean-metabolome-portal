import { useState } from 'react'
import { BrowserRouter, Routes, Route, NavLink, useLocation } from 'react-router-dom'
import { Globe, Settings, RotateCcw, HelpCircle } from 'lucide-react'
import MapPage from './pages/MapPage'
import AdminAuthWrapper from './components/AdminAuthWrapper'

export default function App() {
  return (
    <BrowserRouter>
      <AppShell />
    </BrowserRouter>
  )
}

function AppShell() {
  const location = useLocation()
  const [colorBy, setColorBy] = useState('_dataset')
  const [colorOptions, setColorOptions] = useState(['_dataset'])
  const [resetTrigger, setResetTrigger] = useState(0)
  const [tourRestart, setTourRestart] = useState(0) // bumped by the tour button to replay it

  const handleColorOptionsChange = (opts) => {
    setColorOptions(opts)
    if (!opts.includes(colorBy)) setColorBy('_dataset')
  }

  const showColorControl = location.pathname === '/'

  return (
    <div className="flex flex-col h-screen bg-slate-900">
      {/* Top nav */}
      <nav className="flex items-center gap-6 px-6 py-3 bg-slate-800 border-b border-slate-700 shrink-0">
        <span className="text-ocean-400 font-bold text-lg tracking-wide flex items-center gap-2 shrink-0">
          <img src="/logo.png" alt="" className="h-7 w-7" />
          <img src="/logo3.png" alt="Ocean Metabolome Portal" className="h-5 w-auto" />
        </span>
        <NavLink
          to="/"
          className={({ isActive }) =>
            `flex items-center gap-1.5 text-sm px-3 py-1.5 rounded transition-colors ${
              isActive ? 'bg-ocean-600 text-white' : 'text-slate-400 hover:text-slate-200'
            }`
          }
        >
          <Globe size={14} /> World Map
        </NavLink>
        <NavLink
          to="/admin"
          className={({ isActive }) =>
            `flex items-center gap-1.5 text-sm px-3 py-1.5 rounded transition-colors ${
              isActive ? 'bg-ocean-600 text-white' : 'text-slate-400 hover:text-slate-200'
            }`
          }
        >
          <Settings size={14} /> Admin
        </NavLink>

        {showColorControl && (
          <div className="ml-auto flex items-center gap-3">
            <div className="flex items-center gap-2" data-tour="color-by">
              <label className="text-xs text-slate-300 font-medium font-sans">Color By</label>
              <select
                className="bg-slate-900 border border-slate-600 rounded px-2 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-ocean-500"
                value={colorBy}
                onChange={(e) => {
                  setColorBy(e.target.value)
                }}
              >
                {colorOptions.map((option) => (
                  <option key={option} value={option}>
                    {option === '_dataset' ? 'Dataset' : option}
                  </option>
                ))}
              </select>
            </div>
            <button
              onClick={() => setResetTrigger((t) => t + 1)}
              data-tour="reset"
              className="bg-slate-900 border border-slate-600 rounded px-3 py-1.5 text-xs text-slate-300 hover:text-white hover:border-slate-400 transition-colors flex items-center gap-1.5 font-medium select-none active:scale-95"
              title="Clear all active filters"
            >
              <RotateCcw size={12} className="text-ocean-400" />
              Reset Filters
            </button>
            <button
              onClick={() => setTourRestart((n) => n + 1)}
              className="bg-slate-900 border border-slate-600 rounded p-1.5 text-slate-300 hover:text-white hover:border-slate-400 transition-colors"
              title="Take the tour"
              aria-label="Take the tour"
            >
              <HelpCircle size={14} />
            </button>
          </div>
        )}
      </nav>

      {/* Page content */}
      <div className="flex-1 overflow-hidden">
        <Routes>
          <Route
            path="/"
            element={
              <MapPage
                colorBy={colorBy}
                onColorByChange={setColorBy}
                onColorOptionsChange={handleColorOptionsChange}
                resetTrigger={resetTrigger}
                tourRestart={tourRestart}
              />
            }
          />
          <Route path="/admin" element={<AdminAuthWrapper />} />
        </Routes>
      </div>
    </div>
  )
}
