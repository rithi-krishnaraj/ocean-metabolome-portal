import { useState } from 'react'
import { BrowserRouter, Routes, Route, NavLink, useLocation } from 'react-router-dom'
import { Globe, Settings, RotateCcw } from 'lucide-react'
import AdminPage from './pages/AdminPage'
import MapPage from './pages/MapPage'
import AdminAuthWrapper from './components/AdminAuthWrapper'; // Import the new component

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

  const handleColorOptionsChange = (opts) => {
    setColorOptions(opts)
    if (!opts.includes(colorBy)) setColorBy('_dataset')
  }
  const showColorControl = location.pathname === '/'

  return (
    <div className="flex flex-col h-screen bg-slate-900">
      {/* Top nav */}
      <nav className="flex items-center gap-6 px-6 py-3 bg-slate-800 border-b border-slate-700 shrink-0">
        <span className="text-ocean-400 font-bold text-lg tracking-wide flex items-center gap-2">
          <Globe size={20} /> Ocean Metabolome Portal
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
            <div className="flex items-center gap-2">
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
              className="bg-slate-900 border border-slate-600 rounded px-3 py-1.5 text-xs text-slate-300 hover:text-white hover:border-slate-400 transition-colors flex items-center gap-1.5 font-medium select-none active:scale-95"
              title="Clear all active filters"
            >
              <RotateCcw size={12} className="text-ocean-400" />
              Reset Filters
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
              />
            }
          />
          <Route path="/admin" element={<AdminAuthWrapper />} /> {/* Use the wrapper here */}
        </Routes>
      </div>
    </div>
  )
}
