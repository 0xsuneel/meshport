// An action sheet: the chat's Request / Bill sheets and the Business tab's
// Collect payment (Charge / Bill) - one look everywhere.
// Phone: slides up from the bottom. In a chat it sits in the conversation,
// which itself shrinks to the space above the keyboard (`absolute`); on a
// page it's `fixed` to the app shell, which also follows the visible area -
// either way the sheet sits on top of the keyboard, never behind it.
// Desktop: a centred dialog. Same look as the chat's Pay sheet.
import { type ReactNode } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { X } from 'lucide-react'
import { Avatar } from '@/components/ui/Avatar'
import { DesktopDialogFrame } from '@/components/ui/DesktopDialogFrame'
import { PopupOpen } from '@/hooks/usePopupOpen'
import { SHEET_SPRING, SHEET_BACKDROP, SHEET_EXIT } from '@/lib/motion'
import { sheetDrag } from '@/lib/sheetDrag'

export function ActionSheet({ open, onClose, isDesktop, id, fixed = false, children }: {
  open: boolean
  onClose: () => void
  isDesktop: boolean
  /** Unique per sheet (drag-to-close bookkeeping). */
  id: string
  /** Over the whole app (a page) instead of inside the chat panel. */
  fixed?: boolean
  children: ReactNode
}) {
  if (isDesktop) {
    return (
      <AnimatePresence>
        {open && (
          <DesktopDialogFrame key={id} onClose={onClose} maxWidth={440}>
            <div className="flex flex-col" style={{ maxHeight: 'min(86dvh, 760px)' }}>{children}</div>
          </DesktopDialogFrame>
        )}
      </AnimatePresence>
    )
  }
  const pos = fixed ? 'fixed' : 'absolute'
  return (
    <>
      {open && <PopupOpen />}
      <AnimatePresence>
        {open && [
          <motion.div key={id + '-dim'} transition={SHEET_BACKDROP.transition} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className={`${pos} inset-0 bg-black/70 ${fixed ? 'z-50' : 'z-40'}`} onClick={onClose} />,
          <motion.div key={id} {...sheetDrag(id, onClose)} initial={{ y: '100%' }} animate={{ y: 0 }} exit={SHEET_EXIT} transition={SHEET_SPRING}
            role="dialog" aria-modal="true"
            className={`${pos} bottom-0 left-0 right-0 z-50 bg-surface border-t border-border rounded-t-3xl flex flex-col${fixed ? ' mx-auto max-w-md' : ''}`}
            style={{ maxHeight: 'calc(100% - 40px)' }}>
            <div data-sheet-handle className="flex justify-center pt-2.5 pb-1 flex-shrink-0">
              <div style={{ width: 38, height: 5, borderRadius: 3, background: 'var(--border)' }} />
            </div>
            {children}
          </motion.div>,
        ]}
      </AnimatePresence>
    </>
  )
}

/** "Request from / Bill to" + the person (or store). `compact`: one line (keyboard open). */
export function SheetPerson({ label, name, username, avatar, compact, onClose, sub }: {
  label: string
  name: string
  /** Their MeshPort username; shown as name.arc (left out when empty). */
  username?: string | null
  avatar?: string | null
  compact?: boolean
  onClose?: () => void
  sub?: string | null
}) {
  const handle = username ? `${username.replace(/\.arc$/i, '')}.arc` : ''
  const close = onClose && (
    <button type="button" onClick={onClose} aria-label="Close" className="mp-popup-close ml-auto flex-shrink-0" style={compact ? { width: 30, height: 30 } : undefined}>
      <X className="w-[17px] h-[17px]" strokeWidth={2.4} />
    </button>
  )
  if (compact) {
    return (
      <div className="flex items-center gap-2.5 min-w-0">
        <Avatar name={name || handle} src={avatar ?? null} size="xs" />
        <p className="min-w-0 truncate text-[14.5px] font-bold text-text-primary">
          <span className="text-[12.5px] font-medium text-text-secondary mr-1">{label}</span>{name}
          {handle && <span className="text-[13px] font-semibold text-link ml-1.5">{handle}</span>}
        </p>
        {close}
      </div>
    )
  }
  return (
    <div>
      <div className="flex items-center gap-3 min-w-0">
        <Avatar name={name || handle} src={avatar ?? null} size="sm" />
        <div className="min-w-0">
          <p className="text-[12.5px] font-medium text-text-secondary">{label}</p>
          <p className="truncate text-[16.5px] font-bold text-text-primary leading-tight">
            {name}{handle && <span className="text-[14px] font-semibold text-link ml-1.5">{handle}</span>}
          </p>
        </div>
        {close}
      </div>
      {sub && <p className="text-[12px] text-text-secondary mt-1" style={{ marginLeft: 52 }}>{sub}</p>}
    </div>
  )
}

/** Small section label in a sheet ("ITEMS", "DUE DATE"). */
export function SheetLabel({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex items-center justify-between px-0.5 mb-2">
      <span className="text-[12px] font-bold uppercase tracking-[0.06em] text-text-secondary">{children}</span>
      {right}
    </div>
  )
}

/** One-of chips (due date, valid for). */
export function SheetChips<T extends string>({ options, value, onChange, label }: {
  options: readonly { id: T; label: string }[]
  value: T
  onChange: (id: T) => void
  /** Accessible name of the group. */
  label: string
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-1.5">
      {options.map(d => {
        const on = value === d.id
        return (
          <button key={d.id} type="button" role="radio" aria-checked={on} onClick={() => onChange(d.id)}
            className="px-3 rounded-full text-[13px] font-semibold"
            style={{ height: 32, border: `1px solid ${on ? 'var(--brand-text)' : 'var(--border)'}`, cursor: 'pointer',
              background: on ? 'color-mix(in srgb, var(--brand) 12%, transparent)' : 'var(--bg)', color: on ? 'var(--brand-text)' : 'var(--text-secondary)' }}>
            {d.label}
          </button>
        )
      })}
    </div>
  )
}

/** The sheet's text box (note, customer): soft filled, brand ring on focus. */
export const sheetInputClass = 'w-full rounded-[14px] px-3.5 py-3 text-[14.5px] text-text-primary outline-none placeholder:text-text-muted border border-border focus:border-[var(--brand-text)]'
export const sheetInputStyle: React.CSSProperties = { background: 'var(--bg)' }
