import { useEffect, useRef, useState, type CSSProperties, type ReactNode, type Ref } from 'react'
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion'
import { Check, ChevronDown, Copy, ExternalLink, Zap } from 'lucide-react'
import { EASE_OUT } from '@/lib/motion'
import { usePopupOpen } from '@/hooks/usePopupOpen'

// The receipt card every success flow lands on after SuccessFlash:
// gradient header holding the check (the traveling checkmark flies into
// checkRef), title + subtitle, a "Completed in …" pill, the key rows, and a
// "More details" drawer (process steps, extra rows, full hash, explorer
// links). Content rises in one row at a time once `revealed` flips, with a
// short confetti burst from the header.

export interface ReceiptRow {
  label: string
  value: ReactNode
  /** Green value text (recipient, amount received, "Confirmed"). */
  positive?: boolean
  /** Shows a copy button after the value. */
  onCopy?: () => void
  copied?: boolean
}

export interface ReceiptLink { title: string; explorer?: string; hash?: string; href: string }

interface SuccessReceiptProps {
  title: string
  subtitle: ReactNode
  pill?: string
  /** Chat-style bubble under the subtitle (Chat Pay). */
  bubble?: ReactNode
  rows: ReceiptRow[]
  steps?: ReactNode[]
  detailRows?: ReceiptRow[]
  fullHash?: string
  links?: ReceiptLink[]
  /** Shown under the explorer links, e.g. why a destination link is missing. */
  linksNote?: ReactNode
  primaryLabel?: string
  onPrimary: () => void
  checkRef?: Ref<HTMLDivElement>
  /** Header check + content stay hidden until the traveling checkmark lands. */
  revealed: boolean
  /** Replaces the plain tick inside the header circle (e.g. biometric toggle). */
  checkContent?: ReactNode
  /** Overrides for the scrolling root, e.g. flex sizing inside a sheet. */
  style?: CSSProperties
  /** Header state — history can open failed or still-processing records. */
  status?: 'success' | 'pending' | 'failed'
  /** Confetti on reveal. On for a live payment, off when reopening history. */
  celebrate?: boolean
  /** Heading of the extra rows inside "More details". */
  detailsTitle?: string
  /** Rubber-stamp label on the header, e.g. 'History' for a reopened record. */
  stamp?: string
  /**
   * Buttons pinned to the bottom of the screen instead of the in-card
   * primary button, so they stay visible while "More details" is open.
   */
  actions?: Array<{ label: string; onClick: () => void; primary?: boolean }>
}

/** Size of the header's white check circle — the traveling checkmark's target. */
export const RECEIPT_CHECK = 76

const shortHash = (h: string) => `${h.slice(0, 6)}…${h.slice(-4)}`
const GOOD = 'color-mix(in srgb, var(--success) 70%, var(--text-primary))'
const HEADER_BG = {
  success: 'linear-gradient(160deg, var(--success), var(--brand))',
  pending: 'linear-gradient(160deg, var(--warning), color-mix(in srgb, var(--warning) 55%, var(--brand)))',
  failed:  'linear-gradient(160deg, var(--danger), color-mix(in srgb, var(--danger) 55%, black))',
} as const
const HEADER_ICON_COLOR = { success: 'var(--success)', pending: 'var(--warning)', failed: 'var(--danger)' } as const
const CONFETTI = ['var(--success)', '#F5B82E', 'var(--avatar-3)', 'var(--avatar-4)', '#FFFFFF']

// Nearest ancestor (or the element itself) that actually scrolls — the
// receipt is its own scroller on Pay/Claim, but sits inside the page's
// scroller on Swap/Transfer and inside the sheet on Chat Pay.
function scrollParent(el: HTMLElement | null): HTMLElement {
  for (let n = el; n; n = n.parentElement) {
    const oy = getComputedStyle(n).overflowY
    if ((oy === 'auto' || oy === 'scroll') && n.scrollHeight > n.clientHeight) return n
  }
  return (document.scrollingElement as HTMLElement) || document.documentElement
}

function Row({ row, i, revealed }: { row: ReceiptRow; i?: number; revealed?: boolean }) {
  const body = (
    <>
      <span style={{ color: 'var(--text-secondary)', flexShrink: 0 }}>{row.label}</span>
      <b style={{ fontWeight: 700, color: row.positive ? GOOD : 'var(--text-primary)', display: 'flex', alignItems: 'center', minWidth: 0, textAlign: 'right' }}>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.value}</span>
        {row.onCopy && (
          <button onClick={row.onCopy} aria-label={`Copy ${row.label.toLowerCase()}`}
            style={{ border: 0, background: 'none', cursor: 'pointer', color: 'var(--text-secondary)', marginLeft: 8, padding: 0, display: 'flex' }}>
            {row.copied ? <Check size={16} color="var(--success)" /> : <Copy size={16} />}
          </button>
        )}
      </b>
    </>
  )
  const style = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, padding: '10px 0', fontSize: 13, borderTop: '1px solid var(--border)' } as const
  if (i === undefined) return <div style={style}>{body}</div>
  return <Reveal i={i} revealed={!!revealed} style={style}>{body}</Reveal>
}

function Reveal({ i, revealed, children, style }: { i: number; revealed: boolean; children: ReactNode; style?: CSSProperties }) {
  return (
    <motion.div initial={false} animate={revealed ? { opacity: 1, y: 0 } : { opacity: 0, y: 12 }}
      transition={{ duration: 0.45, delay: revealed ? i * 0.07 : 0, ease: EASE_OUT }} style={style}>
      {children}
    </motion.div>
  )
}

function Confetti() {
  const reduce = useReducedMotion()
  const [pieces] = useState(() => Array.from({ length: 34 }, (_, i) => {
    const a = Math.random() * Math.PI * 2, d = 90 + Math.random() * 130
    return { x: Math.cos(a) * d, y: Math.sin(a) * d + 60, color: CONFETTI[i % CONFETTI.length], round: i % 2 === 1 }
  }))
  if (reduce) return null
  return (
    <div aria-hidden style={{ position: 'absolute', left: '50%', top: 70, width: 0, height: 0, zIndex: 2, pointerEvents: 'none' }}>
      {pieces.map((p, i) => (
        <motion.i key={i}
          initial={{ opacity: 1, x: 0, y: 0, rotate: 0 }}
          animate={{ opacity: 0, x: p.x, y: p.y, rotate: 540 }}
          transition={{ duration: 1.3, ease: 'easeOut' }}
          style={{ position: 'absolute', width: 8, height: 12, background: p.color, borderRadius: p.round ? '50%' : 2 }} />
      ))}
    </div>
  )
}

export function SuccessReceipt({
  title, subtitle, pill, bubble, rows, steps, detailRows, fullHash, links, linksNote,
  primaryLabel = 'Done', onPrimary, checkRef, revealed, checkContent, style,
  status = 'success', celebrate = true, detailsTitle = 'Transaction details', stamp, actions,
}: SuccessReceiptProps) {
  // Takes over from the success flash, which switches the page's blurs off
  // while it's up. Holding them off here too means the hand-off doesn't turn
  // them back on for a frame (Android repaints the blurred header — a flash).
  usePopupOpen()
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  // With pinned actions the card scrolls here rather than in rootRef.
  const scrollRef = useRef<HTMLDivElement>(null)
  // Which element scrolled and where it sat before "More details" opened,
  // so hiding the details glides the screen back down to exactly that spot.
  // Captured when the drawer finishes expanding (expanding never moves
  // scrollTop), since the scroller may only become scrollable once open.
  const savedScroll = useRef<{ el: HTMLElement; top: number } | null>(null)

  const toggleDetails = () => {
    if (open && savedScroll.current) {
      const { el, top } = savedScroll.current
      el.scrollTo({ top, behavior: 'smooth' })
      savedScroll.current = null
    }
    setOpen(v => !v)
  }

  // Once the drawer has finished expanding, glide the screen up so the
  // details and the button under them are fully in view.
  const revealDetails = () => {
    const card = cardRef.current
    if (!card) return
    const scroller = scrollParent(scrollRef.current ?? rootRef.current)
    savedScroll.current = { el: scroller, top: scroller.scrollTop }
    const isPage = scroller === document.scrollingElement || scroller === document.documentElement
    const viewBottom = isPage ? window.innerHeight : scroller.getBoundingClientRect().bottom
    const overflow = card.getBoundingClientRect().bottom + 16 - viewBottom
    if (overflow > 0) scroller.scrollBy({ top: overflow, behavior: 'smooth' })
  }
  const [burst, setBurst] = useState(false)
  useEffect(() => {
    if (!revealed || !celebrate || status !== 'success') { setBurst(false); return }
    setBurst(true)
    const t = setTimeout(() => setBurst(false), 1400)
    return () => clearTimeout(t)
  }, [revealed, celebrate, status])

  const hasMore = !!(steps?.length || detailRows?.length || fullHash || links?.length || linksNote)
  const hasActions = !!actions?.length
  const h5 = { fontSize: 12, fontWeight: 700, color: 'var(--text-secondary)', margin: '10px 0 2px' } as const

  return (
    <div ref={rootRef} style={hasActions ? {
      // With pinned actions: the card scrolls in its own region and the
      // button bar sits below it, outside the scroll — so the bar can never
      // cover any of the details text.
      height: '100%', display: 'flex', flexDirection: 'column', background: 'var(--bg)', boxSizing: 'border-box', overflow: 'hidden',
      ...style,
    } : {
      // Column so the card can centre itself (margin: auto below).
      height: '100%', overflowY: 'auto', background: 'var(--bg)', boxSizing: 'border-box',
      display: 'flex', flexDirection: 'column',
      padding: 'calc(env(safe-area-inset-top, 0px) + 24px) 16px calc(env(safe-area-inset-bottom, 0px) + 24px)',
      ...style,
    }}>
      <div ref={scrollRef} style={hasActions ? {
        flex: 1, minHeight: 0, overflowY: 'auto', boxSizing: 'border-box',
        display: 'flex', flexDirection: 'column',
        padding: 'calc(env(safe-area-inset-top, 0px) + 24px) 16px 16px',
      } : { display: 'contents' }}>
      <div ref={cardRef} className="shadow-elevation-1" style={{
        // margin auto: centred top-to-bottom with equal space above and below
        // when it fits; when it's taller than the screen (details open) the
        // auto margins collapse to 0 and it scrolls from the top as before.
        position: 'relative', maxWidth: 480, margin: 'auto', width: '100%', flexShrink: 0, boxSizing: 'border-box',
        background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 30, overflow: 'hidden', paddingBottom: 16,
      }}>
        {burst && <Confetti />}
        <div style={{ position: 'relative', height: 140, display: 'flex', alignItems: 'center', justifyContent: 'center', background: HEADER_BG[status] }}>
          {stamp && (
            <span aria-label={stamp} style={{
              position: 'absolute', top: 16, right: 16, transform: 'rotate(-8deg)',
              display: 'inline-flex', alignItems: 'center', gap: 5, padding: '4px 9px', borderRadius: 7,
              border: '2px solid rgba(255,255,255,0.85)', color: '#fff',
              fontSize: 11, fontWeight: 800, letterSpacing: '0.12em', textTransform: 'uppercase',
              background: 'rgba(255,255,255,0.08)',
            }}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><polyline points="3 3 3 8 8 8" /><polyline points="12 7 12 12 15 14" />
              </svg>
              {stamp}
            </span>
          )}
          <div ref={checkRef} style={{
            width: RECEIPT_CHECK, height: RECEIPT_CHECK, borderRadius: '50%', background: '#fff',
            display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: revealed ? 1 : 0,
          }}>
            {checkContent ?? (
              <svg viewBox="0 0 24 24" width="46%" height="46%" fill="none" stroke={HEADER_ICON_COLOR[status]} strokeWidth={3} strokeLinecap="round" strokeLinejoin="round">
                {status === 'failed' ? <><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></>
                  : status === 'pending' ? <><circle cx="12" cy="12" r="9" /><polyline points="12 7 12 12 15.5 14" /></>
                  : <polyline points="20 6 9 17 4 12" />}
              </svg>
            )}
          </div>
        </div>

        <div style={{ padding: '16px 20px 0', textAlign: 'center', color: 'var(--text-primary)' }}>
          <Reveal i={0} revealed={revealed}>
            <h2 style={{ fontSize: 25, fontWeight: 800, letterSpacing: '-0.5px', margin: 0 }}>{title}</h2>
          </Reveal>
          <Reveal i={1} revealed={revealed}>
            <p style={{ fontSize: 13.5, color: 'var(--text-secondary)', margin: '6px 0 12px', overflowWrap: 'anywhere' }}>{subtitle}</p>
          </Reveal>
          {bubble && (
            <Reveal i={1} revealed={revealed} style={{ display: 'flex', marginBottom: 6 }}>
              <span style={{
                display: 'inline-block', margin: '0 0 10px auto', padding: '10px 14px', textAlign: 'left',
                borderRadius: '16px 16px 4px 16px', fontSize: 14, fontWeight: 600,
                color: GOOD, background: 'color-mix(in srgb, var(--success) 15%, transparent)',
              }}>{bubble}</span>
            </Reveal>
          )}
          {pill && (
            <Reveal i={2} revealed={revealed}>
              <div style={{
                display: 'inline-flex', gap: 7, alignItems: 'center', padding: '8px 15px', borderRadius: 999,
                fontSize: 13, fontWeight: 700, color: GOOD, background: 'color-mix(in srgb, var(--success) 15%, transparent)',
              }}>
                <Zap size={15} color="#F5B82E" fill="#F5B82E" />{pill}
              </div>
            </Reveal>
          )}

          <div style={{ textAlign: 'left', marginTop: 10 }}>
            {rows.map((r, i) => <Row key={r.label} row={r} i={i + 3} revealed={revealed} />)}

            {hasMore && (
              <Reveal i={rows.length + 3} revealed={revealed}>
                <button onClick={toggleDetails} aria-expanded={open}
                  style={{
                    width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                    border: 0, borderTop: '1px solid var(--border)', background: 'none', cursor: 'pointer',
                    padding: '11px 0 4px', fontSize: 13, fontWeight: 700, color: 'var(--text-primary)', fontFamily: 'inherit',
                  }}>
                  <span>{open ? 'Hide details' : 'More details'}</span>
                  <ChevronDown size={16} style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform .25s' }} />
                </button>
              </Reveal>
            )}

            <AnimatePresence initial={false}>
              {open && (
                <motion.div key="more" initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.35, ease: EASE_OUT }} style={{ overflow: 'hidden' }}
                  onAnimationComplete={def => { if (open && (def as { height?: unknown }).height === 'auto') revealDetails() }}>
                  {!!steps?.length && (
                    <>
                      <h5 style={h5}>Process</h5>
                      {steps.map((s, i) => (
                        <div key={i} style={{ display: 'flex', gap: 10, alignItems: 'center', fontSize: 13, padding: '6px 0' }}>
                          <span style={{ width: 20, height: 20, borderRadius: '50%', background: 'var(--brand)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                            <Check size={12} strokeWidth={3} />
                          </span>
                          <span>{s}</span>
                        </div>
                      ))}
                    </>
                  )}
                  {!!detailRows?.length && (
                    <>
                      <h5 style={h5}>{detailsTitle}</h5>
                      {detailRows.map(r => <Row key={r.label} row={r} />)}
                    </>
                  )}
                  {fullHash && (
                    <>
                      <h5 style={h5}>Full hash</h5>
                      <span style={{ display: 'block', fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 11, wordBreak: 'break-all', lineHeight: 1.5, color: 'var(--text-secondary)', padding: '8px 0 4px' }}>{fullHash}</span>
                    </>
                  )}
                  {!!(links?.length || linksNote) && (
                    <>
                      <h5 style={h5}>View on explorer</h5>
                      {links?.map(l => (
                        <a key={l.href} href={l.href} target="_blank" rel="noopener noreferrer"
                          style={{
                            display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10,
                            padding: '10px 12px', marginTop: 6, border: '1px solid var(--border)', borderRadius: 14,
                            textDecoration: 'none', color: 'inherit',
                          }}>
                          <span>
                            <b style={{ display: 'block', fontSize: 13 }}>{l.title}</b>
                            <small style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>{[l.explorer, l.hash && shortHash(l.hash)].filter(Boolean).join(' · ')}</small>
                          </span>
                          <ExternalLink size={16} color="var(--text-secondary)" />
                        </a>
                      ))}
                      {linksNote && <p style={{ fontSize: 11.5, color: 'var(--text-secondary)', lineHeight: 1.45, margin: 0, padding: '8px 2px 2px' }}>{linksNote}</p>}
                    </>
                  )}
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {!actions?.length && (
            <Reveal i={rows.length + 4} revealed={revealed}>
              <motion.button onClick={onPrimary} whileTap={{ scale: 0.98 }}
                style={{
                  width: '100%', marginTop: 12, padding: 15, border: 0, borderRadius: 999, cursor: 'pointer',
                  background: 'var(--brand)', color: '#fff', fontSize: 16, fontWeight: 700, fontFamily: 'inherit',
                }}>
                {primaryLabel}
              </motion.button>
            </Reveal>
          )}
        </div>
      </div>
      </div>
      {hasActions && (
        <motion.div initial={false} animate={revealed ? { opacity: 1 } : { opacity: 0 }} transition={{ duration: 0.3 }}
          style={{
            flexShrink: 0, display: 'flex', gap: 10,
            padding: '12px 16px calc(env(safe-area-inset-bottom, 0px) + 16px)',
            background: 'var(--bg)', borderTop: '1px solid var(--border)',
          }}>
          {actions!.map(a => (
            <motion.button key={a.label} onClick={a.onClick} whileTap={{ scale: 0.98 }}
              style={{
                flex: 1, padding: 14, borderRadius: 999, cursor: 'pointer', fontSize: 15, fontWeight: 700, fontFamily: 'inherit',
                ...(a.primary
                  ? { border: 0, background: 'var(--brand)', color: '#fff' }
                  : { border: '1.5px solid var(--brand)', background: 'transparent', color: 'var(--accent-text)' }),
              }}>
              {a.label}
            </motion.button>
          ))}
        </motion.div>
      )}
    </div>
  )
}
