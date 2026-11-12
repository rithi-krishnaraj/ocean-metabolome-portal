import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, RefreshCw, X } from 'lucide-react'

// Each step points at the element marked data-tour="<target>".
const STEPS = [
  { target: 'color-by', title: 'Color By', text: 'Color the samples by dataset or any metadata field.' },
  { target: 'reset', title: 'Reset Filters', text: 'Clear every filter and return to the full map.' },
  { target: 'sample-filter', title: 'Sample Filtering', text: 'Show only samples from the metadata categories you pick.' },
  {
    target: 'metabolite-filter',
    title: 'Metabolite Filtering',
    text: 'Search features by row ID, m/z, RT or annotation. Show one on the map to see its intensity across samples.',
  },
  {
    target: 'stats-dashboard',
    title: 'Statistical Analysis',
    text: 'Run PCoA, box plots, Van Krevelen and other analyses on the samples shown.',
  },
  {
    target: 'map-summary',
    title: 'Map Summary',
    text: 'Datasets, samples and metabolites currently on the map. Updates as you filter.',
  },
]

const CARD_WIDTH = 300
const GAP = 12
const PAD = 6 // spotlight padding around the target

// Set once the tour has shown, so returning to the map from Admin doesn't show it again.
// A page load or refresh resets it.
let shownThisPageLoad = false

// Welcome screen with the portal logo, shown while the map loads, followed by a short
// tour that spotlights the main controls. Shown once per page load; Esc or Skip closes it,
// and the tour button next to Reset Filters (restartSignal) replays it.
export default function WelcomeTour({ loading, restartSignal = 0 }) {
  const [open, setOpen] = useState(() => !shownThisPageLoad)

  useEffect(() => {
    shownThisPageLoad = true
  }, [])

  // The tour button replays the steps (skipping the welcome screen). Only a change after
  // mount counts: the map page remounts with the old value when returning from Admin.
  const initialSignal = useRef(restartSignal)
  useEffect(() => {
    if (restartSignal === initialSignal.current) return
    initialSignal.current = restartSignal
    setStep(0)
    setOpen(true)
  }, [restartSignal])
  const [step, setStep] = useState(-1) // -1 = welcome screen
  const [rect, setRect] = useState(null)

  const close = useCallback(() => setOpen(false), [])
  const next = useCallback(() => {
    if (step + 1 < STEPS.length) setStep(step + 1)
    else setOpen(false)
  }, [step])
  const back = useCallback(() => setStep((s) => Math.max(-1, s - 1)), [])

  // Track the current target's position. Polled because some targets (the map summary)
  // only appear once the map data arrives, and panels can shift as the page lays out.
  useEffect(() => {
    if (!open || step < 0) return
    const measure = () => {
      const el = document.querySelector(`[data-tour="${STEPS[step].target}"]`)
      const r = el?.getBoundingClientRect()
      setRect((prev) => {
        if (!r || r.width === 0) return null
        if (prev && prev.top === r.top && prev.left === r.left && prev.width === r.width && prev.height === r.height) return prev
        return { top: r.top, left: r.left, width: r.width, height: r.height }
      })
    }
    measure()
    const id = setInterval(measure, 250)
    window.addEventListener('resize', measure)
    return () => {
      clearInterval(id)
      window.removeEventListener('resize', measure)
    }
  }, [open, step])

  useEffect(() => {
    if (!open) return
    const onKey = (e) => {
      if (e.key === 'Escape') close()
      else if (e.key === 'ArrowRight') next()
      else if (e.key === 'ArrowLeft') back()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, close, next, back])

  if (!open) return null

  if (step < 0) {
    return (
      <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/85 backdrop-blur-sm px-4">
        <div className="w-full max-w-lg p-8 text-center space-y-5">
          <img src="/logo2.png" alt="Ocean Metabolome Portal" className="mx-auto w-72 h-72 object-contain" />
          <p className="text-base text-white">
            Explore marine dissolved organic matter metabolomics data on an interactive world map.
          </p>
          {loading && (
            <p className="flex items-center justify-center gap-2 text-sm text-white">
              <RefreshCw size={14} className="animate-spin text-ocean-400" /> Loading the map…
            </p>
          )}
          <div className="flex gap-3 justify-center">
            <button
              onClick={close}
              className="px-5 py-2.5 text-sm rounded-lg text-white hover:bg-white/10"
            >
              {loading ? 'Skip tour' : 'Go to map'}
            </button>
            <button
              onClick={next}
              autoFocus
              className="px-5 py-2.5 text-sm rounded-lg bg-ocean-600 hover:bg-ocean-500 text-white font-medium"
            >
              Take the tour
            </button>
          </div>
        </div>
      </div>
    )
  }

  const current = STEPS[step]
  const last = step === STEPS.length - 1

  // Card below the target, or above it when there is no room; centred without a target.
  let cardStyle = { top: '50%', left: '50%', transform: 'translate(-50%, -50%)' }
  if (rect) {
    const left = Math.min(
      Math.max(GAP, rect.left + rect.width / 2 - CARD_WIDTH / 2),
      window.innerWidth - CARD_WIDTH - GAP,
    )
    const below = rect.top + rect.height + PAD + GAP
    cardStyle = below + 180 < window.innerHeight
      ? { top: below, left }
      : { bottom: window.innerHeight - rect.top + PAD + GAP, left }
  }

  return (
    <div className="fixed inset-0 z-[100]" onClick={(e) => e.target === e.currentTarget && close()}>
      {rect ? (
        // The spotlight's huge shadow dims everything around the target.
        <div
          className="fixed rounded-lg ring-2 ring-ocean-400 pointer-events-none transition-all duration-200"
          style={{
            top: rect.top - PAD,
            left: rect.left - PAD,
            width: rect.width + PAD * 2,
            height: rect.height + PAD * 2,
            boxShadow: '0 0 0 9999px rgba(2, 6, 23, 0.75)',
          }}
        />
      ) : (
        <div className="fixed inset-0 bg-slate-950/75 pointer-events-none" />
      )}

      <div
        className="fixed bg-slate-900 border border-slate-700 rounded-xl shadow-2xl p-4 space-y-2"
        style={{ width: CARD_WIDTH, ...cardStyle }}
        role="dialog"
        aria-label={current.title}
      >
        <div className="flex items-center justify-between">
          <span className="text-[10px] uppercase tracking-wide text-slate-500">
            {step + 1} of {STEPS.length}
          </span>
          <button onClick={close} className="text-slate-500 hover:text-slate-300" title="Close tour">
            <X size={14} />
          </button>
        </div>
        <h3 className="text-sm font-semibold text-ocean-300">{current.title}</h3>
        <p className="text-sm text-slate-300">{current.text}</p>
        {!rect && <p className="text-xs text-slate-500">This appears once the map has loaded.</p>}
        <div className="flex items-center justify-between pt-1">
          <button
            onClick={back}
            className="flex items-center gap-1 px-2 py-1 text-xs rounded text-slate-400 hover:text-slate-200 hover:bg-slate-800"
          >
            <ChevronLeft size={14} /> Back
          </button>
          <button
            onClick={next}
            autoFocus
            className="flex items-center gap-1 px-3 py-1 text-xs rounded bg-ocean-600 hover:bg-ocean-500 text-white font-medium"
          >
            {last ? 'Finish' : <>Next <ChevronRight size={14} /></>}
          </button>
        </div>
      </div>
    </div>
  )
}
