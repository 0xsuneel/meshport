// DesktopTwoColumn - THE desktop page layout for a flow with something beside
// it (Pay, Swap, P2P, Receive, the Hub, Business, …): the main column on the
// left (65%), the side column on the right (35%, usually DesktopHistoryPanel).
// Both fill the content area's height and scroll on their own; the same
// padding and gap on every page.
//
// Pages that are one tree on phone and desktop (Business) pass `isDesktop`:
// on a phone the same two wrappers stay (no side column), styled by
// `phoneClassName` / `phoneMainClassName` (default: no box at all), so
// resizing across the breakpoint never remounts what's inside.
import { type HTMLAttributes, type ReactNode, type Ref } from 'react'

type DivProps = HTMLAttributes<HTMLDivElement> & { [data: `data-${string}`]: string | undefined }

export function DesktopTwoColumn({ main, side, mainRef, sideRef, mainProps, sideProps, extra, isDesktop = true, stage = false, className, phoneClassName, phoneMainClassName }: {
  main: ReactNode
  side: ReactNode
  /** The main column (e.g. the anchor PinSheet centres its desktop dialog over). */
  mainRef?: Ref<HTMLDivElement>
  sideRef?: Ref<HTMLDivElement>
  /** Extra attributes on the desktop columns (aria-busy, data-leave-guard,
   *  handlers); their `style` is merged over the column's own. */
  mainProps?: DivProps
  sideProps?: DivProps
  /** Rendered after the columns (dialogs that belong to the page). */
  extra?: ReactNode
  /** False: the phone version of a page that is one tree for both. */
  isDesktop?: boolean
  /** The main column is a stage screens push over (Business: PushLayer is
   *  absolute inside it) - positioned, clipped, a flex column - instead of
   *  a scrolling block. */
  stage?: boolean
  /** Extra classes on the desktop row (e.g. the page background). */
  className?: string
  /** The row and main column on a phone (default: `contents`, no box). */
  phoneClassName?: string
  phoneMainClassName?: string
}) {
  if (!isDesktop) {
    return (
      <div className={phoneClassName ?? 'contents'}>
        <div ref={mainRef} className={phoneMainClassName ?? 'contents'}>{main}</div>
        {extra}
      </div>
    )
  }
  return (
    <div className={className} style={{ display: 'flex', height: '100%', minHeight: 0, gap: 28, padding: '20px 24px 14px', boxSizing: 'border-box' }}>
      <div {...mainProps} ref={mainRef} style={{ flex: '65 1 0%', minWidth: 0, minHeight: 0,
        ...(stage ? { position: 'relative', display: 'flex', flexDirection: 'column', overflow: 'hidden' } : { overflowY: 'auto' }), ...mainProps?.style }}>{main}</div>
      <div {...sideProps} ref={sideRef} style={{ flex: '35 1 0%', minWidth: 0, minHeight: 0, overflowY: 'auto', ...sideProps?.style }}>{side}</div>
      {extra}
    </div>
  )
}
