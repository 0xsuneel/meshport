// A chat action sheet (Request, Bill). Phone: slides up from the bottom of
// the conversation, which itself shrinks to the space above the keyboard -
// so the sheet always sits on top of the keyboard, never behind it.
// Desktop: a centred dialog. Same look as the chat's Pay sheet.
import { type ReactNode } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { X } from 'lucide-react'
import { Avatar } from '@/components/ui/Avatar'
import { DesktopDialogFrame } from '@/components/ui/DesktopDialogFrame'
import { PopupOpen } from '@/hooks/usePopupOpen'
import { SHEET_SPRING, SHEET_BACKDROP, SHEET_EXIT } from '@/lib/motion'
import { sheetDrag } from '@/lib/sheetDrag'

export function ChatSheet({ open, onClose, isDesktop, id, children }: {
  open: boolean
  onClose: () => void
  isDesktop: boolean
  /** Unique per sheet (drag-to-close bookkeeping). */
  id: string
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
  return (
    <>
      {open && <PopupOpen />}
      <AnimatePresence>
        {open && [
          <motion.div key={id + '-dim'} transition={SHEET_BACKDROP.transition} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="absolute inset-0 bg-black/70 z-40" onClick={onClose} />,
          <motion.div key={id} {...sheetDrag(id, onClose)} initial={{ y: '100%' }} animate={{ y: 0 }} exit={SHEET_EXIT} transition={SHEET_SPRING}
            role="dialog" aria-modal="true"
            className="absolute bottom-0 left-0 right-0 z-50 bg-surface border-t border-border rounded-t-3xl flex flex-col"
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

/** "Request from / Bill to" + the person. `compact`: one line (keyboard open). */
export function SheetPerson({ label, name, username, avatar, compact, onClose, sub }: {
  label: string
  name: string
  username: string
  avatar?: string | null
  compact?: boolean
  onClose?: () => void
  sub?: string | null
}) {
  const handle = `${username.replace(/\.arc$/i, '')}.arc`
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
          <span className="text-[13px] font-semibold text-link ml-1.5">{handle}</span>
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
            {name}<span className="text-[14px] font-semibold text-link ml-1.5">{handle}</span>
          </p>
        </div>
        {close}
      </div>
      {sub && <p className="text-[12px] text-text-secondary mt-1" style={{ marginLeft: 52 }}>{sub}</p>}
    </div>
  )
}
