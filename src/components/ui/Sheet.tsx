import { AnimatePresence } from 'framer-motion'
import { X } from 'lucide-react'
import { type ReactNode } from 'react'
import { DesktopDialogFrame } from './DesktopDialogFrame'

interface SheetProps {
  isOpen: boolean
  onClose: () => void
  title?: string
  children: ReactNode
  fullHeight?: boolean
  /**
   * Kept for existing callers. Every Sheet now opens as a centred popup on
   * all screen sizes - only the amount and passcode keypads still slide up
   * from the bottom (they don't use this component).
   */
  variant?: 'bottom' | 'center'
}

export function Sheet({ isOpen, onClose, title, children, fullHeight }: SheetProps) {
  return (
    <AnimatePresence>
      {isOpen && (
        <DesktopDialogFrame onClose={onClose} maxWidth={480}>
          <div className="flex flex-col" style={fullHeight ? { minHeight: 'min(80dvh, 720px)' } : undefined}>
            <div className="flex items-center justify-between gap-3 px-5 pt-5 pb-3 flex-shrink-0">
              {title && <h2 className="text-[19px] font-extrabold tracking-tight text-text-primary">{title}</h2>}
              <button onClick={onClose} className="mp-popup-close ml-auto" aria-label="Close">
                <X className="w-[18px] h-[18px]" strokeWidth={2.4} />
              </button>
            </div>
            <div className="pb-2">{children}</div>
          </div>
        </DesktopDialogFrame>
      )}
    </AnimatePresence>
  )
}
