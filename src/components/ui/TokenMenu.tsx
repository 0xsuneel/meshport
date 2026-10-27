import { useEffect, type ReactNode } from 'react'
import { motion } from 'framer-motion'
import { MENU_MOTION } from '@/lib/motion'

// Token choice that floats down from a token pill (Swap, Pay, Chat Pay):
// one shared panel exactly the pill's width, shown only while open, over the
// content below (nothing moves). Tap outside or Esc closes it. Render it
// inside a `position: relative` wrapper around the pill, inside AnimatePresence.
export type TokenMenuOption = { id: string; label: string; icon: ReactNode; disabled?: boolean }

// `width` (with right-aligned placement) floats it under a small button instead,
// e.g. Activity's filter icon. `maxHeight` makes a long list (networks) scroll.
// `children` instead of `options`: the same floating panel around your own
// content (Rewards' "How it works", a filter list) - THE dropdown look.
export function TokenMenu({ options = [], selected = '', onSelect = () => {}, onClose, width, maxHeight, ariaLabel = 'Choose token', children }: {
  options?: TokenMenuOption[]
  selected?: string
  onSelect?: (id: string) => void
  children?: ReactNode
  onClose: () => void
  width?: number
  maxHeight?: number
  ariaLabel?: string
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (<>
    <div aria-hidden onClick={e => { e.stopPropagation(); onClose() }} style={{ position: 'fixed', inset: 0, zIndex: 40 }} />
    <motion.div role={children ? 'menu' : 'listbox'} aria-label={ariaLabel}
      {...MENU_MOTION}
      style={{ position: 'absolute', top: 'calc(100% + 6px)', right: 0, ...(width ? { width } : { left: 0 }), zIndex: 41, transformOrigin: width ? 'top right' : 'top center',
        display: 'flex', flexDirection: 'column', gap: 2, padding: 4, borderRadius: 22,
        ...(maxHeight ? { maxHeight, overflowY: 'auto', overflowX: 'hidden', overscrollBehavior: 'contain' } : {}),
        background: 'var(--surface)', border: '1px solid var(--border)', boxShadow: '0 12px 28px rgba(0,0,0,0.3)' }}>
      {children ?? options.map(o => {
        const on = o.id === selected
        return (
          <button key={o.id} role="option" aria-selected={on} disabled={o.disabled}
            onClick={e => { e.stopPropagation(); onSelect(o.id); onClose() }}
            className="flex items-center gap-2 rounded-full active:opacity-70 transition-opacity"
            style={{ height: 38, flexShrink: 0, padding: '0 8px 0 4px', minWidth: 0, cursor: o.disabled ? 'default' : 'pointer',
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
