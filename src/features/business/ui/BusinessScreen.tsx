/**
 * BusinessScreen — full-height slide-in screen that overlays the tab.
 * Slides from the right; back arrow + title in header; scrolling body; optional sticky footer.
 */
import React from 'react'
import { ArrowLeft } from 'lucide-react'
import type { ReactNode } from './types'
import { ScreenPush } from '@/components/ui/ScreenPush'
import { useBackLayer } from '@/lib/backLayers'
import { PushLayer } from './PushLayer'

export interface BusinessScreenProps {
  open: boolean
  title: string
  onBack: () => void
  children: ReactNode
  footer?: ReactNode
  /** A step inside this screen (a customer, a store being edited, a payout
   *  draft); '' or absent = the screen's first view. Changing it pushes the
   *  new view in like any other step (ScreenPush); going back to the first
   *  view slides back. */
  step?: string
  /** The body is a flex column that fills the screen and scrolls itself
   *  (Collect payment's forms, which pin their own buttons). */
  fill?: boolean
  /** Right of the title (e.g. the store chip on Collect payment / Shop QR). */
  action?: ReactNode
  /** Shown in place of the title text (Collect payment: the business and
   *  its store); `title` stays as the screen's name for screen readers. */
  heading?: ReactNode
}

/** Where a screen sits in the Business screen stack: `level` 0 is opened from
 *  the tab, 1 from a level-0 screen, …; `covered` = another screen is on top
 *  of it right now. Set by BusinessPage (and CashOut for its trade screen). */
export const ScreenLevel = React.createContext<{ level: number; covered: boolean }>({ level: 0, covered: false })
export const useScreenLevel = () => React.useContext(ScreenLevel)

// Opening/closing is the app's one page push (PageTransition / ScreenPush),
// run by PushLayer: the screen slides the full width in from the right over a
// dim veil with the edge shadow, while the screen (or tab) beneath it shifts
// 28% left; back slides it off to the right as the one beneath comes back -
// 300ms in, 250ms back, both on the same ease-out. Desktop: a quick fade in
// the content area, like desktop pages (no sliding over the sidebar).

export function BusinessScreen({ open, title, onBack, children, footer, step = '', fill = false, action, heading }: BusinessScreenProps) {
  const { level, covered } = useScreenLevel()
  // Phone / browser Back = the header's back arrow (a step inside first).
  useBackLayer(open, onBack)
  return (
    // Above the Manage orders / money panel (z-40), each level above the last.
    <PushLayer open={open} covered={covered} zIndex={41 + level}>
      {/* Its own views (a customer, a store being edited) are pushed like
          Pay's steps: in from the right, back to the first view from the left. */}
      <ScreenPush screenKey={step || '·'} back={!step} style={{ width: '100%', maxWidth: 448 }}>
        {/* Header — the app's standard page header (Profile, Receive…) */}
        <header className="shrink-0 header-row gap-3 px-5 pt-header pb-header bg-bg sticky top-0 z-10">
          <button type="button" aria-label="Go back" onClick={onBack} className="back-btn">
            <ArrowLeft className="w-5 h-5 text-text-primary" />
          </button>
          {heading ? <><h2 className="sr-only">{title}</h2>{heading}</> : <h2 className="header-title flex-1 truncate">{title}</h2>}
          {action}
        </header>

        {/* Scrollable body */}
        <div className={fill ? 'flex-1 min-h-0 flex flex-col' : 'flex-1 overflow-y-auto overscroll-contain'}>
          {children}
        </div>

        {/* Sticky footer — safe-area bottom */}
        {footer && (
          <footer className="shrink-0 px-5 pt-3 pb-[calc(env(safe-area-inset-bottom,0px)+16px)] bg-bg border-t border-border">
            {footer}
          </footer>
        )}
      </ScreenPush>
    </PushLayer>
  )
}
