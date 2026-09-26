// components/admin/ModeToggle.tsx
//
// Global "Normal Mode / Admin Panel" switch. Renders as a small floating
// circular button in a corner of the screen, on top of whichever mode is
// currently showing (mounted once in AppLayout for normal mode, once in
// AdminLayout for admin mode — see the bottom of this file for why two
// mount points). Tapping the circle opens a small popup with both mode
// options; the circle itself stays draggable to anywhere on screen exactly
// as before.
//
// VISIBILITY: only ever renders for someone already authenticated as an
// admin in THIS browser (useAdminStore().isAdminAuthenticated — the same
// flag AdminGuard checks, set the moment /adminsun/login's email+OTP
// check succeeds). A regular user who has never logged into the admin
// panel in this browser never sees this toggle at all — there is nothing
// on-screen hinting an admin mode exists for them. This is the actual
// "only admin account can see it" requirement; ADMIN_PATH (see
// lib/adminPath.ts) separately keeps the URL itself from being guessable,
// but this component is what keeps it invisible in the UI for everyone
// else regardless of URL.
import { useNavigate, useLocation } from 'react-router-dom'
import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { ShieldCheck, Smartphone } from 'lucide-react'
import { useAdminStore } from '@/store/adminStore'
import { ADMIN_PATH } from '@/lib/adminPath'

const POS_KEY = 'meshport_mode_toggle_pos'
const CIRCLE = 52 // rendered diameter, used to keep it on-screen when clamping
const MENU_W = 176
const MENU_H = 96

function loadPos(): { x: number; y: number } | null {
  try {
    const raw = localStorage.getItem(POS_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (typeof parsed?.x === 'number' && typeof parsed?.y === 'number') return parsed
  } catch { /* ignore — falls back to default corner position */ }
  return null
}

function clamp(x: number, y: number) {
  const maxX = window.innerWidth - CIRCLE - 8
  const maxY = window.innerHeight - CIRCLE - 8
  return { x: Math.min(Math.max(8, x), Math.max(8, maxX)), y: Math.min(Math.max(8, y), Math.max(8, maxY)) }
}

export function ModeToggle() {
  const navigate = useNavigate()
  const location = useLocation()
  const { isAdminAuthenticated } = useAdminStore()

  // Position is stored in localStorage (not component state alone) so it
  // survives switching between the two mount points — AppLayout's copy and
  // AdminLayout's copy are technically different component instances, but
  // both read/write the same key, so wherever you drag it in Normal mode
  // is exactly where it'll be when you land in Admin mode, and vice versa.
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const [expanded, setExpanded] = useState(false)
  const dragging = useRef(false)
  const moved = useRef(false)
  const dragStart = useRef({ px: 0, py: 0, ox: 0, oy: 0 })

  useEffect(() => {
    const saved = loadPos()
    if (saved) setPos(clamp(saved.x, saved.y))
    else setPos(clamp(window.innerWidth - CIRCLE - 12, window.innerHeight - CIRCLE - 12))
    const onResize = () => setPos(p => p ? clamp(p.x, p.y) : p)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // Collapse the popup whenever the route actually changes (e.g. a mode
  // switch just navigated) so it never lingers open on the new screen.
  useEffect(() => { setExpanded(false) }, [location.pathname])

  if (!isAdminAuthenticated || !pos) return null

  const inAdminMode = location.pathname.startsWith(ADMIN_PATH)
  const goNormal = () => { setExpanded(false); if (inAdminMode) navigate('/', { replace: true }) }
  const goAdmin  = () => { setExpanded(false); if (!inAdminMode) navigate(`${ADMIN_PATH}/dashboard`) }

  const onPointerDown = (e: React.PointerEvent) => {
    dragging.current = true
    moved.current = false
    dragStart.current = { px: e.clientX, py: e.clientY, ox: pos.x, oy: pos.y }
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
  }
  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragging.current) return
    const dx = e.clientX - dragStart.current.px
    const dy = e.clientY - dragStart.current.py
    if (Math.abs(dx) > 4 || Math.abs(dy) > 4) moved.current = true
    if (moved.current) setPos(clamp(dragStart.current.ox + dx, dragStart.current.oy + dy))
  }
  const onPointerUp = () => {
    dragging.current = false
    if (moved.current && pos) {
      try { localStorage.setItem(POS_KEY, JSON.stringify(pos)) } catch { /* storage unavailable — position just won't persist across reloads */ }
      setTimeout(() => { moved.current = false }, 0)
      return
    }
    // A genuine tap (no drag movement) — toggle the popup.
    setExpanded(v => !v)
    setTimeout(() => { moved.current = false }, 0)
  }

  // Anchor the popup on whichever side of the circle has room, so it never
  // renders off-screen regardless of where the circle's been dragged to.
  const openLeft = pos.x + CIRCLE + 8 + MENU_W > window.innerWidth
  const openUp   = pos.y + CIRCLE + 8 + MENU_H > window.innerHeight
  const menuLeft = openLeft ? pos.x + CIRCLE - MENU_W : pos.x
  const menuTop  = openUp   ? pos.y + CIRCLE - MENU_H : pos.y + CIRCLE + 8

  const CurrentIcon = inAdminMode ? ShieldCheck : Smartphone

  return (
    <>
      {expanded && (
        <div
          onClick={() => setExpanded(false)}
          style={{ position: 'fixed', inset: 0, zIndex: 199 }}
          aria-hidden="true"
        />
      )}

      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ opacity: 0, scale: 0.9, y: openUp ? 6 : -6 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.9, y: openUp ? 6 : -6 }}
            transition={{ duration: 0.15 }}
            style={{
              position: 'fixed', left: menuLeft, top: menuTop, width: MENU_W, zIndex: 200,
              background: 'color-mix(in srgb, var(--surface) 96%, transparent)',
              border: '1px solid var(--border)', borderRadius: 16,
              boxShadow: 'var(--shadow-3)', backdropFilter: 'blur(8px)',
              padding: 6, display: 'flex', flexDirection: 'column', gap: 2,
            }}
            role="menu"
            aria-label="Switch between normal app and admin panel"
          >
            <button
              onClick={goNormal}
              style={{
                display: 'flex', alignItems: 'center', gap: 9,
                padding: '9px 10px', borderRadius: 11, border: 'none', cursor: 'pointer',
                background: !inAdminMode ? 'var(--brand)' : 'transparent',
                color: !inAdminMode ? '#fff' : 'var(--text-primary)',
                fontSize: 13, fontWeight: 600, textAlign: 'left', width: '100%',
              }}
              aria-pressed={!inAdminMode}
              role="menuitemradio"
            >
              <Smartphone size={16} /> Normal Mode
            </button>
            <button
              onClick={goAdmin}
              style={{
                display: 'flex', alignItems: 'center', gap: 9,
                padding: '9px 10px', borderRadius: 11, border: 'none', cursor: 'pointer',
                background: inAdminMode ? 'var(--brand)' : 'transparent',
                color: inAdminMode ? '#fff' : 'var(--text-primary)',
                fontSize: 13, fontWeight: 600, textAlign: 'left', width: '100%',
              }}
              aria-pressed={inAdminMode}
              role="menuitemradio"
            >
              <ShieldCheck size={16} /> Admin Panel
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      <div
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        style={{
          position: 'fixed',
          left: pos.x,
          top: pos.y,
          zIndex: 200,
          width: CIRCLE, height: CIRCLE, borderRadius: '50%',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'var(--brand)',
          border: '1px solid color-mix(in srgb, black 12%, transparent)',
          boxShadow: 'var(--shadow-2)',
          color: '#fff',
          cursor: 'grab',
          touchAction: 'none',
        }}
        role="button"
        aria-label="Switch between normal app and admin panel — tap to open, drag to move"
        aria-expanded={expanded}
      >
        <CurrentIcon size={20} />
      </div>
    </>
  )
}
