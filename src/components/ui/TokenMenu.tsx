import { useEffect, type ReactNode } from 'react'
import { motion } from 'framer-motion'

// Token choice that floats down from a token pill (Swap, Pay, Chat Pay):
// one shared panel exactly the pill's width, shown only while open, over the
// content below (nothing moves). Tap outside or Esc closes it. Render it
// inside a `position: relative` wrapper around the pill, inside AnimatePresence.
export type TokenMenuOption = { id: string; label: string; icon: ReactNode; disabled?: boolean }

export function TokenMenu({ options, selected, onSelect, onClose }: {
  options: TokenMenuOption[]
  selected: string
  onSelect: (id: string) => void
  onClose: () => void
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (<>
    <div aria-hidden onClick={e => { e.stopPropagation(); onClose() }} style={{ position: 'fixed', inset: 0, zIndex: 40 }} />
    <motion.div role="listbox" aria-label="Choose token"
      initial={{ opacity: 0, y: -6, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -6 }}
      transition={{ duration: 0.16, ease: [0.32, 0.72, 0, 1] }}
      style={{ position: 'absolute', top: 'calc(100% + 6px)', left: 0, right: 0, zIndex: 41, transformOrigin: 'top center',
        display: 'flex', flexDirection: 'column', gap: 2, padding: 4, borderRadius: 22,
        background: 'var(--surface)', border: '1px solid var(--border)', boxShadow: '0 12px 28px rgba(0,0,0,0.3)' }}>
      {options.map(o => {
        const on = o.id === selected
        return (
          <button key={o.id} role="option" aria-selected={on} disabled={o.disabled}
            onClick={e => { e.stopPropagation(); onSelect(o.id); onClose() }}
            className="flex items-center gap-2 rounded-full active:opacity-70 transition-opacity"
            style={{ height: 38, padding: '0 8px 0 4px', minWidth: 0, cursor: o.disabled ? 'default' : 'pointer',
              background: on ? 'var(--brand)' : 'transparent', border: 'none' }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, opacity: o.disabled ? 0.4 : 1 }}>
              {o.icon}
              <span className="text-[15px] font-bold" style={{ color: on ? '#fff' : 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{o.label}</span>
            </span>
          </button>
        )
      })}
    </motion.div>
  </>)
}
