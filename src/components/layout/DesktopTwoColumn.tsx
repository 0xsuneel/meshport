// DesktopTwoColumn - THE desktop page layout for a flow with something beside
// it (Pay, Swap, P2P, Receive, Bulk Pay, the Hub, Business, …): the main
// column on the left (65%), the side column on the right (35%, usually
// DesktopHistoryPanel). Both fill the content area's height and scroll on
// their own; the same padding and gap on every page.
import { type ReactNode, type Ref } from 'react'

export function DesktopTwoColumn({ main, side, mainRef, sideRef, extra }: {
  main: ReactNode
  side: ReactNode
  /** The main column (e.g. the anchor PinSheet centres its desktop dialog over). */
  mainRef?: Ref<HTMLDivElement>
  sideRef?: Ref<HTMLDivElement>
  /** Rendered after the columns (dialogs that belong to the page). */
  extra?: ReactNode
}) {
  return (
    <div style={{ display: 'flex', height: '100%', minHeight: 0, gap: 28, padding: '20px 24px 14px', boxSizing: 'border-box' }}>
      <div ref={mainRef} style={{ flex: '65 1 0%', minWidth: 0, minHeight: 0, overflowY: 'auto' }}>{main}</div>
      <div ref={sideRef} style={{ flex: '35 1 0%', minWidth: 0, minHeight: 0, overflowY: 'auto' }}>{side}</div>
      {extra}
    </div>
  )
}
