// PanelScanner - the QR scanner opened inside the panel that asked for it
// (desktop Pay column, Multichain Transfer panel) instead of switching the
// whole screen to /scanner. Portalled and pinned over the anchor element's
// box, so it covers exactly that panel; Escape or ✕ closes it.
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'framer-motion'
import { ScannerPage, type EmbeddedScan } from './ScannerPage'

export function PanelScanner({ anchor, ...scan }: EmbeddedScan & { anchor: HTMLElement | null }) {
  const [, setTick] = useState(0)
  useEffect(() => {
    const onResize = () => setTick(t => t + 1)
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') scan.onClose() }
    window.addEventListener('resize', onResize)
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('resize', onResize); window.removeEventListener('keydown', onKey) }
  }, [scan])
  const r = anchor?.getBoundingClientRect()
  if (!r) return null
  return createPortal(
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.15 }}
      style={{ position: 'fixed', top: r.top, left: r.left, width: r.width, height: r.height, zIndex: 70, padding: 12, boxSizing: 'border-box', background: 'var(--bg)' }}>
      <ScannerPage embedded={scan} />
    </motion.div>,
    document.body,
  )
}
