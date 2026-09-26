import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { CheckCircle, XCircle, Info } from 'lucide-react'
import { useUIStore } from '@/store'
import { TOAST_MOTION } from '@/lib/motion'

export function Toast() {
  const { toast } = useUIStore()

  const icons = {
    success: <CheckCircle className="w-5 h-5 text-success" />,
    error: <XCircle className="w-5 h-5 text-danger" />,
    info: <Info className="w-5 h-5 text-brand" />,
    warning: <Info className="w-5 h-5 text-warning" />,
  }

  const colors = {
    success: 'border-success/30 bg-surface',
    error: 'border-danger/30 bg-surface',
    info: 'border-brand/30 bg-surface',
    warning: 'border-warning/30 bg-surface',
  }

  // Portalled straight to <body> — this component used to render as a
  // sibling of the page content inside a `position: sticky` shell.
  // `position: sticky` establishes a containing block for `position:
  // absolute` descendants (same as `relative`/`fixed` would), so the
  // toast's "centered on screen" math was actually being computed relative
  // to that 430px-wide sticky shell, not the real viewport — on a device
  // whose actual viewport is wider than that shell, this shifts the toast
  // off-center and can clip it at the screen edge, exactly as reported.
  // Rendering into `document.body` via a portal removes it from that
  // ancestor chain entirely, so `fixed` here always centers on the true
  // viewport regardless of any layout happening elsewhere in the app.
  // Positioning lives on this plain wrapper div, untouched by Framer
  // Motion. The motion.div below only ever controls its own fade/slide —
  // Framer Motion takes ownership of the `transform` CSS property on any
  // element it animates (composing its own value for the y-animation), so
  // a manually-set `transform: translateX(-50%)` on that SAME element gets
  // silently overwritten the moment Framer Motion touches it. That's what
  // was actually causing the toast to sit right-of-center: `left: 50%`
  // alone (its compensating translateX dropped) positions the box's LEFT
  // EDGE at center, not the box itself.
  return createPortal(
    <div style={{ position: 'fixed', top: 16, left: '50%', transform: 'translateX(-50%)', zIndex: 9999 }} className="max-w-xs w-full px-4">
      {/* Always mounted, so a toast also animates OUT (it used to vanish). */}
      <AnimatePresence>
        {toast && (
        <motion.div
          key={toast.message}
          {...TOAST_MOTION}
        >
          <div role="status" className={`flex items-start gap-3 px-4 py-3 rounded-2xl border shadow-elevation-2 backdrop-blur-md ${colors[toast.type]}`}>
            <span className="flex-shrink-0 mt-px">{icons[toast.type]}</span>
            {/* Long messages wrap inside the screen (never run off it). */}
            <p className="flex-1 min-w-0 text-sm font-medium text-text-primary" style={{ overflowWrap: 'anywhere', wordBreak: 'break-word' }}>{toast.message}</p>
          </div>
        </motion.div>
        )}
      </AnimatePresence>
    </div>,
    document.body
  )
}
