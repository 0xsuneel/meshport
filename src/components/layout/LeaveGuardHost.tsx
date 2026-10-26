// components/layout/LeaveGuardHost.tsx
//
// The one place that enforces lib/leaveGuard.ts. Mounted once per shell
// (AppLayout and AuthShell - they never render together, and React Router
// allows one blocker at a time).
//
// While a money-moving step is running:
//   - a route change (sidebar, bottom nav, header, links, browser / phone
//     Back) is held, the flow's panel border blinks amber and an ask offers
//     Stay / Leave. Stay (or Escape) closes the ask and stops the blink;
//     another leave attempt brings both back.
//   - closing or refreshing the tab gets the browser's "Leave site?" prompt.
// When the step completes the ask closes by itself and the person stays on
// the result.

import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useBlocker } from 'react-router-dom'
import { leaveGuardLabel, shouldHoldNavigation, useLeaveGuardStore, isLeaveGuarded, isPassingThrough } from '@/lib/leaveGuard'

const BLINK_CLASS = 'mp-leave-blink'
/** On <html> while a desktop flow is processing (cursor rule in index.css). */
const BUSY_CLASS = 'mp-app-busy'
/** What stays live while held: the running flow's panel and the Stay/Leave ask. */
const LIVE_AREAS = '[data-leave-guard], [data-hub-page], [data-leave-ask]'

/** The panel that blinks: a marked flow panel, else the open Hub panel. */
function findTarget(): HTMLElement | null {
  const marked = document.querySelectorAll<HTMLElement>('[data-leave-guard]')
  if (marked.length) return marked[marked.length - 1]
  const hub = document.querySelectorAll<HTMLElement>('[data-hub-page]')
  return hub.length ? hub[hub.length - 1] : null
}

export function LeaveGuardHost() {
  const guards = useLeaveGuardStore(s => s.guards)
  const ownAsk = useLeaveGuardStore(s => s.ask)
  const label = leaveGuardLabel(guards)
  const guarded = label !== null

  const blocker = useBlocker(useCallback(
    ({ currentLocation, nextLocation }) => !isPassingThrough() && shouldHoldNavigation(isLeaveGuarded(), currentLocation.pathname, nextLocation.pathname),
    [],
  ))
  const blocked = blocker.state === 'blocked'
  const asking = blocked || !!ownAsk

  // Blinking runs from a leave attempt until the person answers it (Stay or
  // Leave) or the step ends - not on and on after they chose to stay.
  const [alerting, setAlerting] = useState(false)
  useEffect(() => { if (asking) setAlerting(true) }, [asking])
  useEffect(() => {
    if (guarded) return
    setAlerting(false)
    if (blocker.state === 'blocked') blocker.reset()
  }, [guarded, blocker])

  // Keep the class on whichever element is the panel right now (screens
  // swap inside a flow, so re-resolve it while alerting).
  const [target, setTarget] = useState<HTMLElement | null>(null)
  useEffect(() => {
    if (!alerting) { setTarget(null); return }
    let el: HTMLElement | null = null
    const apply = () => {
      const next = findTarget()
      if (next === el) return
      el?.classList.remove(BLINK_CLASS)
      next?.classList.add(BLINK_CLASS)
      el = next
      setTarget(next)
    }
    apply()
    const iv = window.setInterval(apply, 400)
    return () => { window.clearInterval(iv); el?.classList.remove(BLINK_CLASS) }
  }, [alerting])

  // Back (phone button, gesture, browser arrow) is caught in lib/leaveGuard,
  // ahead of the router, and raised here as `ownAsk`.

  // Desktop: while a flow is processing, everything outside its own panel
  // (sidebar, top bar, other columns) is held - a not-allowed cursor and no
  // response to clicks or Enter/Space - instead of each click raising the
  // Stay/Leave ask. Back (browser arrow / keys) is untouched: it still asks.
  useEffect(() => {
    if (!guarded) return
    const desktop = window.matchMedia('(min-width: 980px)')
    const root = document.documentElement
    const sync = () => root.classList.toggle(BUSY_CLASS, desktop.matches)
    sync()
    desktop.addEventListener('change', sync)
    const hold = (e: Event) => {
      if (!desktop.matches) return
      if (e instanceof KeyboardEvent && e.key !== 'Enter' && e.key !== ' ') return
      const t = e.target
      if (t instanceof Element && t.closest(LIVE_AREAS)) return
      e.preventDefault()
      e.stopPropagation()
    }
    const kinds = ['click', 'pointerdown', 'mousedown', 'auxclick', 'dblclick', 'keydown'] as const
    kinds.forEach(k => window.addEventListener(k, hold, true))
    return () => {
      root.classList.remove(BUSY_CLASS)
      desktop.removeEventListener('change', sync)
      kinds.forEach(k => window.removeEventListener(k, hold, true))
    }
  }, [guarded])

  // Tab close / refresh: only the browser's own prompt is allowed here.
  useEffect(() => {
    if (!guarded) return
    const onBeforeUnload = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [guarded])

  const stay = () => {
    setAlerting(false)
    if (blocker.state === 'blocked') blocker.reset()
    ownAsk?.stay()
  }
  const leave = () => {
    setAlerting(false)
    if (blocker.state === 'blocked') blocker.proceed()
    ownAsk?.leave()
  }

  const stayRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!asking) return
    stayRef.current?.focus()
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') stay() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asking])

  // Place the ask at the bottom of the blinking panel (desktop right column),
  // or at the bottom of the screen when there's no panel or it's narrow.
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!asking) return
    const onResize = () => setTick(t => t + 1)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [asking])

  if (!alerting && !asking) return null

  // Where the ask goes: inside the bottom of a tall panel (the desktop right
  // column), just under a small card (a processing popup), else at the
  // bottom of the screen.
  const rect = target?.getBoundingClientRect()
  const vh = window.innerHeight
  const ASK_W = 400, ASK_H = 150
  const fits = !!rect && rect.width >= 300
  const tall = fits && rect!.height >= vh * 0.6
  const below = fits && !tall && rect!.bottom + 12 + ASK_H <= vh
  const vw = window.innerWidth
  const width = fits ? Math.min(rect!.width - 32, ASK_W, vw - 32) : ASK_W
  // Centred on the panel, but never off the screen's edges.
  const left = fits ? Math.min(Math.max(rect!.left + (rect!.width - width) / 2, 16), vw - width - 16) : 0
  const cardStyle: React.CSSProperties = tall
    ? { left, width, bottom: Math.max(vh - rect!.bottom + 16, 16) }
    : below
      ? { left, width, top: rect!.bottom + 12 }
      : { left: 16, right: 16, margin: '0 auto', maxWidth: ASK_W, bottom: 'calc(env(safe-area-inset-bottom, 0px) + 16px)' }

  const what = label ?? 'Payment'
  return createPortal(
    <>
      {/* No panel to blink (a full-screen flow): blink the screen edge. */}
      {alerting && !target && <div className={BLINK_CLASS} aria-hidden="true"
        style={{ position: 'fixed', inset: 0, zIndex: 999, pointerEvents: 'none' }} />}
      {asking && (
        <div data-leave-ask="" role="alertdialog" aria-modal="false" aria-labelledby="mp-leave-title" aria-describedby="mp-leave-body"
          className="mp-dialog-in"
          style={{
            position: 'fixed', zIndex: 1000, boxSizing: 'border-box', ...cardStyle,
            background: 'color-mix(in srgb, var(--warning) 10%, var(--surface))',
            border: '1px solid color-mix(in srgb, var(--warning) 45%, var(--border))',
            borderRadius: 16, padding: '14px 16px', boxShadow: '0 18px 44px -12px rgba(0,0,0,0.45)',
            display: 'flex', flexDirection: 'column', gap: 12,
          }}>
          <div>
            <div id="mp-leave-title" style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}>{what} in progress</div>
            <div id="mp-leave-body" style={{ fontSize: 14, lineHeight: 1.45, color: 'var(--text-secondary)', marginTop: 3 }}>
              Leaving won't stop it, but this screen will close. You can check the result in Activity.
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button ref={stayRef} onClick={stay}
              style={{ flex: 1, padding: '11px 12px', borderRadius: 12, border: '1px solid var(--brand)', background: 'var(--brand)', color: '#fff', fontSize: 14, fontWeight: 700, cursor: 'pointer' }}>
              Stay
            </button>
            <button onClick={leave}
              style={{ flex: 1, padding: '11px 12px', borderRadius: 12, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text-primary)', fontSize: 14, fontWeight: 700, cursor: 'pointer' }}>
              Leave
            </button>
          </div>
        </div>
      )}
    </>,
    document.body,
  )
}
