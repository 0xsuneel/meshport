import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode, type Ref } from 'react'
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion'
import { ArrowLeft, Check, ChevronDown, Clock, Copy, ExternalLink, Share2, X, Zap } from 'lucide-react'
import { useUIStore } from '@/store'
import { DESKTOP_QUERY, EASE_OUT, SPRING_SOFT, springProgress, stableLayer } from '@/lib/motion'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { usePopupOpen } from '@/hooks/usePopupOpen'
import { SuccessPromo, type PromoFeature } from '@/components/ui/SuccessPromo'

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
  /** Shown as a full page (header, check on the page, rows under "Details",
   *  buttons at the foot) instead of the card. */
  page?: {
    title?: string; onBack?: () => void; onShare?: () => void; sections?: ReactNode; noDone?: boolean
    /** Beside Share in the header (the payment page's scratch-card gift); replaces the "+20 points" line. */
    gift?: ReactNode
    /** No Share in the header (a receipt nobody needs to send - a swap). */
    noShare?: boolean
    /** The big line and the line under it (default: title / subtitle). */
    hero?: { amount: ReactNode; line: ReactNode }
    /** A record with a person: their initial with a tick instead of the check. */
    person?: { initial: string; line: ReactNode; amount: string; unit?: string; status: 'success' | 'pending' | 'failed'; statusText: string; when?: string; note?: ReactNode }
    /** The Details card's rows (default: rows + detailRows). */
    rows?: ReceiptRow[]
    /** Who was paid: the receipt card's top line (initials with a tick, name,
     *  handle with copy, the amount they got). */
    payee?: { name: string; initial: string; handle?: string; amount?: string; copy?: { value: string; what: string } }
  }
  /** A "From MeshPort" card under the receipt (full-page receipts): `true`,
   *  or this screen's own feature so it isn't the one shown. */
  promo?: PromoFeature | true
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
  /** Header state - history can open failed or still-processing records. */
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
  /** The scratch-card gift (rewards/ScratchGift) at the card's top-right corner -
   *  flows whose transaction wins a card. Replaces the points line. */
  gift?: ReactNode
  /** Fills its box edge to edge (a sheet holding it, chat Pay): no card
   *  frame or margin around it, the header from the very top, the button at
   *  the foot - instead of a card floating in white space. */
  fill?: boolean
}

/** Size of the header's white check circle - the traveling checkmark's target. */
export const RECEIPT_CHECK = 76

const statusColorOf = (s: 'success' | 'pending' | 'failed') => s === 'failed' ? 'var(--danger-text)' : s === 'pending' ? 'var(--warning-text)' : 'var(--success-text)'
const shortHash = (h: string) => `${h.slice(0, 6)}…${h.slice(-4)}`
const GOOD = 'color-mix(in srgb, var(--success) 70%, var(--text-primary))'
const HEADER_BG = {
  success: 'var(--brand)',
  pending: 'color-mix(in srgb, var(--warning) 80%, #3A2A00)',
  failed:  'color-mix(in srgb, var(--danger) 85%, black)',
} as const
const HEADER_ICON_COLOR = { success: 'var(--success)', pending: 'var(--warning)', failed: 'var(--danger)' } as const
const CONFETTI = ['var(--success)', '#F5B82E', 'var(--avatar-3)', 'var(--avatar-4)', '#FFFFFF']

// Nearest ancestor (or the element itself) that actually scrolls - the
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
            {row.copied ? <Check data-tick size={16} color="var(--success)" /> : <Copy size={16} />}
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
      // Each row rises on a spring, 70 ms after the one above (17 Nov).
      transition={revealed ? { ...SPRING_SOFT, delay: i * 0.07 } : { duration: 0.2, ease: EASE_OUT }} style={style} transformTemplate={stableLayer}>
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

// What Share sends (18 Nov 2026): the receipt as text - amount, who, status,
// every detail row, the full transaction hash and EVERY explorer link (a
// transfer has two: the source chain's and the destination chain's).
const plain = (n: ReactNode): string => {
  if (n == null || typeof n === 'boolean') return ''
  if (typeof n === 'string' || typeof n === 'number') return String(n)
  if (Array.isArray(n)) return n.map(plain).join('')
  const kids = (n as { props?: { children?: ReactNode } }).props?.children
  return kids !== undefined ? plain(kids) : ''
}
export function receiptText({ amount, line, fallbackTitle, status, when, rows, fullHash, links }: {
  amount: ReactNode; line: ReactNode; fallbackTitle: ReactNode; status: string; when?: string
  rows: ReceiptRow[]; fullHash?: string; links?: ReceiptLink[]
}): string {
  const out: string[] = ['MeshPort receipt', '']
  const a = plain(amount) || plain(fallbackTitle)
  if (a) out.push(a)
  const l = plain(line)
  if (l) out.push(l)
  out.push(`Status: ${status === 'success' ? 'Successful' : status === 'pending' ? 'Processing' : 'Failed'}`)
  if (when) out.push(`Time: ${when}`)
  for (const r of rows) {
    // The short hash row gives way to the full hash below.
    if (fullHash && /hash|transaction/i.test(r.label)) continue
    const v = plain(r.value).trim()
    if (v) out.push(`${r.label}: ${v}`)
  }
  if (fullHash) out.push(`Transaction: ${fullHash}`)
  for (const k of links ?? []) out.push('', `${k.title}:`, k.href)
  return out.join('\n')
}

export function SuccessReceipt({
  title, subtitle, pill, bubble, rows, steps, detailRows, fullHash, links, linksNote,
  primaryLabel = 'Done', onPrimary, checkRef, revealed, checkContent, style,
  status = 'success', celebrate = true, detailsTitle = 'Transaction details', stamp, actions, fill = false, promo, page, gift,
}: SuccessReceiptProps) {
  // The check: handed to the caller (it aims the flying checkmark at it) and
  // kept here for its landing pop.
  // Phones only: a computer keeps the card (it sits in a side panel there).
  const desktop = useMediaQuery(DESKTOP_QUERY)
  const ownCheck = useRef<HTMLDivElement | null>(null)
  const setCheck = useCallback((el: HTMLDivElement | null) => {
    ownCheck.current = el
    if (typeof checkRef === 'function') checkRef(el)
    else if (checkRef) (checkRef as { current: HTMLDivElement | null }).current = el
  }, [checkRef])
  // Landing (17 Nov "premium motion"): once the receipt is revealed on a
  // success, the check gives a small spring pop (~4% past full size, via the
  // separate `scale` property so the flight's transform is untouched). The
  // sound and buzz already came with the success flash (successFeedback).
  // Not with reduced motion.
  const [shown, setShown] = useState(false)
  useEffect(() => { const f = requestAnimationFrame(() => setShown(true)); return () => cancelAnimationFrame(f) }, [])
  const landed = useRef(false)
  useEffect(() => {
    if (!revealed) { landed.current = false; return }
    if (landed.current || status !== 'success') return
    landed.current = true
    if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
    const el = ownCheck.current
    if (el && typeof el.animate === 'function') {
      const { values, ms } = springProgress()
      el.animate(values.map((p, i) => ({ scale: String(0.86 + 0.14 * p), offset: i / (values.length - 1) })), { duration: ms })
    }
  }, [revealed, status])
  // Takes over from the success flash, which switches the page's blurs off
  // while it's up. Holding them off here too means the hand-off doesn't turn
  // them back on for a frame (Android repaints the blurred header - a flash).
  usePopupOpen()
  const [open, setOpen] = useState(false)
  const [payeeCopied, setPayeeCopied] = useState(false)
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

  // A hash already shown in a row (with its copy button) isn't shown again as
  // a "Full hash" block, nor under its explorer link.
  const hashInRows = [...rows, ...(detailRows ?? [])].some(r => /hash|\btx\b/i.test(r.label))
  const showFullHash = !!fullHash && !hashInRows
  const hasMore = !!(steps?.length || detailRows?.length || showFullHash || links?.length || linksNote)
  const hasActions = !!actions?.length
  const promoShown = !!promo && status === 'success' && !fill
  const h5 = { fontSize: 12, fontWeight: 700, color: 'var(--text-secondary)', margin: '10px 0 2px' } as const

  const heroText = (<>
          <Reveal i={0} revealed={shown}>
            <h2 style={{ fontSize: 25, fontWeight: 800, letterSpacing: '-0.5px', margin: 0 }}>{title}</h2>
          </Reveal>
          <Reveal i={1} revealed={shown}>
            <p style={{ fontSize: 14, color: 'var(--text-secondary)', margin: '6px 0 12px', overflowWrap: 'anywhere' }}>{subtitle}</p>
          </Reveal>
          {bubble && (
            <Reveal i={1} revealed={shown} style={{ display: 'flex', marginBottom: 6 }}>
              <span style={{
                display: 'inline-block', margin: '0 0 10px auto', padding: '10px 14px', textAlign: 'left',
                borderRadius: '16px 16px 4px 16px', fontSize: 14, fontWeight: 600,
                color: GOOD, background: 'color-mix(in srgb, var(--success) 15%, transparent)',
              }}>{bubble}</span>
            </Reveal>
          )}
          {pill && (
            <Reveal i={2} revealed={shown}>
              <div style={{
                display: 'inline-flex', gap: 7, alignItems: 'center', padding: '8px 15px', borderRadius: 999,
                fontSize: 13, fontWeight: 700, color: GOOD, background: 'color-mix(in srgb, var(--success) 15%, transparent)',
              }}>
                <Zap size={15} color="#F5B82E" fill="#F5B82E" />{pill}
              </div>
            </Reveal>
          )}
  </>)
  const rowsBlock = (<>
            {rows.map((r, i) => <Row key={r.label} row={r} i={i + 3} revealed={shown} />)}

            {hasMore && (
              <Reveal i={rows.length + 3} revealed={shown}>
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
                  {showFullHash && (
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
                            <small style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{[l.explorer, l.hash && !hashInRows && !showFullHash && shortHash(l.hash)].filter(Boolean).join(' · ')}</small>
                          </span>
                          <ExternalLink size={16} color="var(--text-secondary)" />
                        </a>
                      ))}
                      {linksNote && <p style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.45, margin: 0, padding: '8px 2px 2px' }}>{linksNote}</p>}
                    </>
                  )}
                </motion.div>
              )}
            </AnimatePresence>
  </>)

  // ── Page layout (18 Nov): a full page, as approved in the preview -
  // header (back arrow, title, share), the check and the amount on the page
  // (or, for a record with a person, their avatar with a tick), the page's
  // own sections (To / From), one flat "Details" card whose last rows open
  // the explorer, "For you", and Share + Done at the foot.
  if (page && !desktop) {
    const heroAmount = page.hero?.amount ?? title
    const heroLine = page.hero ? page.hero.line : subtitle
    const share = page.onShare ?? (async () => {
      const text = receiptText({
        amount: page.person ? `${page.person.amount}${page.person.unit ? ` ${page.person.unit}` : ''}` : heroAmount,
        line: page.person ? page.person.line : heroLine,
        fallbackTitle: title, status, when: page.person?.when,
        rows: page.rows ?? [...rows, ...(detailRows ?? [])], fullHash, links,
      })
      try {
        if (navigator.share) { await navigator.share({ title: page.title || title, text }); return }
        await navigator.clipboard.writeText(text)
        useUIStore.getState().showToastMessage('Copied - paste it anywhere', 'success')
      } catch { /* closed the share sheet */ }
    })
    // Success pages (no back arrow): Share beside Done. History: no buttons
    // unless there's something to do (e.g. Open Recover).
    const footer: Array<{ label: string; onClick: () => void; primary?: boolean }> = page.noDone
      ? (actions ?? [])
      : [...(actions?.length ? actions : [{ label: primaryLabel, onClick: onPrimary, primary: true }])]
    const ring = status === 'success' ? 'var(--brand)' : status === 'pending' ? 'var(--warning)' : 'var(--danger)'
    const detailRowsAll = page.rows ?? [...rows, ...(detailRows ?? [])]
    const cardStyle = { background: 'var(--surface)', border: '1px solid var(--soft-edge)', boxShadow: 'var(--soft-card)', borderRadius: 16 } as const
    const label = (t: string) => <p className="text-xs font-bold text-text-secondary" style={{ margin: '20px 4px 8px' }}>{t}</p>
    const person = page.person
    const statusColor = person?.status === 'failed' ? 'var(--danger-text)' : person?.status === 'pending' ? 'var(--warning-text)' : 'var(--success-text)'

    // ── Success page (18 Nov, approved preview): a band in the status colour
    // holding the header, the white check (the flying checkmark lands in it),
    // the amount and the settled pill; a receipt card over its lower edge -
    // who was paid, a torn line, the rows, the explorer - then "For you", and
    // Done inset at the foot. History records (a person) keep the layout below.
    if (!person) {
      const top = status === 'success' ? 'color-mix(in srgb, var(--brand) 70%, #3FD0B8)' : HEADER_BG[status]
      const band = `linear-gradient(180deg, ${top} 0%, ${status === 'success' ? 'var(--brand)' : HEADER_BG[status]} 58%, color-mix(in srgb, ${status === 'success' ? 'var(--brand)' : HEADER_BG[status]} 72%, black) 100%)`
      const hasHead = !!(page.title || page.onBack)
      const giftNode = page.gift ?? gift
      const payee = page.payee
      const copyPayee = async () => {
        if (!payee?.copy) return
        try { await navigator.clipboard.writeText(payee.copy.value) } catch { return }
        setPayeeCopied(true)
        useUIStore.getState().showToastMessage(`${payee.copy.what} copied`, 'success')
        setTimeout(() => setPayeeCopied(false), 1500)
      }
      const got = status === 'success' ? 'Received' : status === 'pending' ? 'On its way' : 'Not sent'
      const round = { width: 38, height: 38, margin: 0, padding: 0, borderRadius: '50%', background: 'rgba(255,255,255,.16)' } as const
      return (
        <div ref={rootRef} style={{ height: '100%', display: 'flex', flexDirection: 'column', background: 'var(--bg)', overflow: 'hidden', color: 'var(--text-primary)', ...style }}>
          {/* On the band: the header's icons (and the gift's) are white. */}
          <style>{`.sr-band .back-btn{width:38px;height:38px;margin:0;padding:0;border-radius:50%;background:rgba(255,255,255,.16)}.sr-band .back-btn svg{color:#fff!important}`}</style>
          {hasHead && (
            <div className="sr-band header-row flex-shrink-0 gap-3 px-4 pt-header pb-header" style={{ position: 'relative', zIndex: 2, background: top }}>
              {page.onBack && (
                <button type="button" onClick={page.onBack} className="back-btn" aria-label="Back" style={round}>
                  <ArrowLeft className="w-5 h-5" />
                </button>
              )}
              <div style={{ flex: 1, minWidth: 0 }}>
                <h1 style={{ fontSize: 17, fontWeight: 700, color: '#fff', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{page.title}</h1>
              </div>
              {giftNode}
              {!page.noShare && (
                <button type="button" onClick={() => { void share() }} className="back-btn" aria-label="Share" style={round}>
                  <Share2 className="w-5 h-5" />
                </button>
              )}
            </div>
          )}
          <div ref={scrollRef} style={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden' }}>
            <div className="sr-band" style={{ position: 'relative', background: band, color: '#fff', textAlign: 'center', padding: `${hasHead ? 14 : 26}px 20px 64px` }}>
              {/* No page header (a page inside the Hub): the gift at the band's corner. */}
              {!hasHead && giftNode && <div style={{ position: 'absolute', top: 14, right: 16, zIndex: 2 }}>{giftNode}</div>}
              {burst && <Confetti />}
              <div ref={setCheck} style={{
                width: RECEIPT_CHECK, height: RECEIPT_CHECK, borderRadius: '50%', margin: '0 auto', background: '#fff',
                display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: revealed ? 1 : 0,
                boxShadow: '0 0 0 10px rgba(255,255,255,.12), 0 0 0 22px rgba(255,255,255,.06)',
              }}>
                {checkContent ?? (
                  <svg viewBox="0 0 24 24" width="50%" height="50%" fill="none" stroke={status === 'success' ? 'var(--brand)' : HEADER_ICON_COLOR[status]} strokeWidth={3} strokeLinecap="round" strokeLinejoin="round">
                    {status === 'failed' ? <><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></>
                      : status === 'pending' ? <><circle cx="12" cy="12" r="9" /><polyline points="12 7 12 12 15.5 14" /></>
                      : <polyline points="20 6 9 17 4 12" />}
                  </svg>
                )}
              </div>
              <Reveal i={0} revealed={shown}>
                <div style={{ fontSize: 40, fontWeight: 900, letterSpacing: '-1.4px', marginTop: 22, lineHeight: 1.1, overflowWrap: 'anywhere', fontVariantNumeric: 'tabular-nums' }}>{heroAmount}</div>
              </Reveal>
              {heroLine && (
                <Reveal i={1} revealed={shown}>
                  <div style={{ fontSize: 15, opacity: 0.85, marginTop: 6, overflowWrap: 'anywhere' }}>{heroLine}</div>
                </Reveal>
              )}
              {pill && (
                <Reveal i={2} revealed={shown}>
                  <div style={{ display: 'inline-flex', gap: 6, alignItems: 'center', marginTop: 14, padding: '7px 13px', borderRadius: 999, fontSize: 13, fontWeight: 700, background: 'rgba(0,0,0,.18)' }}>
                    <Zap size={14} color="#FFD25E" fill="#FFD25E" />{pill}
                  </div>
                </Reveal>
              )}
            </div>
            <div style={{ maxWidth: 480, margin: '0 auto', padding: '0 16px 20px', boxSizing: 'border-box' }}>
              {(payee || detailRowsAll.length > 0 || !!links?.length) && (
                <Reveal i={3} revealed={shown} style={{ position: 'relative', marginTop: -44 }}>
                  <div ref={cardRef} style={{ background: 'var(--surface)', border: '1px solid var(--soft-edge)', boxShadow: '0 10px 30px rgba(0,0,0,.10)', borderRadius: 22 }}>
                    {payee && (<>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '16px 16px 14px' }}>
                        <span style={{ position: 'relative', width: 46, height: 46, borderRadius: '50%', flex: 'none', display: 'grid', placeItems: 'center', fontSize: 17, fontWeight: 800,
                          color: 'var(--brand-text)', background: 'color-mix(in srgb, var(--brand) 14%, transparent)' }}>
                          {payee.initial}
                          <span style={{ position: 'absolute', right: -2, bottom: -2, width: 18, height: 18, borderRadius: '50%', display: 'grid', placeItems: 'center', border: '2px solid var(--surface)',
                            background: status === 'failed' ? 'var(--danger)' : status === 'pending' ? 'var(--warning)' : 'var(--success)' }}>
                            {status === 'failed' ? <X size={9} color="#fff" strokeWidth={4} /> : status === 'pending' ? <Clock size={9} color="#fff" strokeWidth={3.4} /> : <Check size={9} color="#fff" strokeWidth={4} />}
                          </span>
                        </span>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <b style={{ display: 'block', fontSize: 16, fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{payee.name}</b>
                          {payee.handle && (
                            <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13.5, color: 'var(--text-secondary)', minWidth: 0 }}>
                              <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{payee.handle}</span>
                              {payee.copy && (
                                <button type="button" onClick={() => { void copyPayee() }} aria-label={`Copy ${payee.copy.what.toLowerCase()}`}
                                  style={{ border: 0, background: 'none', padding: 0, display: 'flex', cursor: 'pointer', color: 'var(--text-secondary)', flexShrink: 0 }}>
                                  {payeeCopied ? <Check data-tick size={15} color="var(--success)" /> : <Copy size={15} />}
                                </button>
                              )}
                            </span>
                          )}
                        </div>
                        {payee.amount && (
                          <div style={{ flex: 'none', textAlign: 'right' }}>
                            <b style={{ display: 'block', fontSize: 16, fontWeight: 800 }}>{payee.amount}</b>
                            <small style={{ fontSize: 12, fontWeight: 700, color: statusColorOf(status) }}>{got}</small>
                          </div>
                        )}
                      </div>
                      {/* Torn line: notches at both edges, dashes between. */}
                      <div aria-hidden style={{ position: 'relative', height: 18 }}>
                        <span style={{ position: 'absolute', left: 16, right: 16, top: '50%', borderTop: '2px dashed var(--border)' }} />
                        <span style={{ position: 'absolute', top: 0, left: -10, width: 18, height: 18, borderRadius: '50%', background: 'var(--bg)' }} />
                        <span style={{ position: 'absolute', top: 0, right: -10, width: 18, height: 18, borderRadius: '50%', background: 'var(--bg)' }} />
                      </div>
                    </>)}
                    <div style={{ padding: payee ? '4px 16px 4px' : '10px 16px 4px' }}>
                      {detailRowsAll.map(r => (
                        <div key={r.label} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '10px 0', fontSize: 14.5 }}>
                          <span style={{ color: 'var(--text-secondary)', flexShrink: 0 }}>{r.label}</span>
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontWeight: 600, minWidth: 0, color: r.positive ? 'var(--success-text)' : 'var(--text-primary)' }}>
                            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.value}</span>
                            {r.onCopy && (
                              <button type="button" onClick={r.onCopy} aria-label={`Copy ${r.label.toLowerCase()}`}
                                style={{ border: 0, background: 'none', padding: 0, display: 'flex', cursor: 'pointer', color: 'var(--text-secondary)', flexShrink: 0 }}>
                                {r.copied ? <Check data-tick size={15} color="var(--success)" /> : <Copy size={15} />}
                              </button>
                            )}
                          </span>
                        </div>
                      ))}
                    </div>
                    {!!links?.length && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '4px 16px 16px' }}>
                        {links.map(l => (
                          <a key={l.href} href={l.href} target="_blank" rel="noopener noreferrer"
                            style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7, padding: '11px 12px', borderRadius: 14, fontSize: 14, fontWeight: 700,
                              color: 'var(--brand-text)', background: 'color-mix(in srgb, var(--brand) 10%, transparent)', textDecoration: 'none' }}>
                            {links.length > 1 ? `${l.title}${l.explorer ? ` · ${l.explorer}` : ''}` : `View on ${l.explorer || 'explorer'}`}
                            <ExternalLink size={15} />
                          </a>
                        ))}
                      </div>
                    )}
                    {!links?.length && <div style={{ height: 8 }} />}
                  </div>
                  {linksNote && <p style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.45, margin: '8px 4px 0' }}>{linksNote}</p>}
                </Reveal>
              )}
              {page.sections}
              {promoShown && <Reveal i={4} revealed={shown}>{label('For you')}<SuccessPromo exclude={promo === true ? undefined : promo} revealed={shown} instant /></Reveal>}
            </div>
          </div>
          {footer.length > 0 && (
            <motion.div initial={false} animate={shown ? { opacity: 1 } : { opacity: 0 }} transition={{ duration: 0.3 }}
              style={{ flexShrink: 0, display: 'flex', gap: 10, padding: '10px 16px calc(var(--safe-bottom) + 16px)', background: 'var(--bg)' }}>
              {footer.map(a => (
                <motion.button key={a.label} onClick={a.onClick} whileTap={{ scale: 0.98 }}
                  style={{
                    flex: 1, height: 54, borderRadius: 999, cursor: 'pointer', fontSize: 16, fontWeight: 800, fontFamily: 'inherit',
                    ...(a.primary
                      ? { border: 0, background: 'var(--brand)', color: '#fff' }
                      : { border: '1.5px solid var(--brand)', background: 'transparent', color: 'var(--brand-text)' }),
                  }}>
                  {a.label}
                </motion.button>
              ))}
            </motion.div>
          )}
        </div>
      )
    }
    return (
      <div ref={rootRef} style={{ height: '100%', display: 'flex', flexDirection: 'column', background: 'var(--bg)', overflow: 'hidden', color: 'var(--text-primary)', ...style }}>
        {(page.title || page.onBack) && (
          <div className="header-row mp-glass-header flex-shrink-0 gap-3 px-5 pt-header pb-header" style={{ position: 'relative', zIndex: 2 }}>
            {page.onBack && (
              <button type="button" onClick={page.onBack} className="back-btn" aria-label="Back">
                <ArrowLeft className="w-5 h-5 text-text-primary" />
              </button>
            )}
            <div style={{ flex: 1, minWidth: 0 }}>
              <h1 className="text-xl font-bold text-text-primary" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{page.title}</h1>
            </div>
            {page.gift ?? gift}
            {!page.noShare && (
              <button type="button" onClick={() => { void share() }} className="back-btn" aria-label="Share">
                <Share2 className="w-5 h-5 text-text-primary" />
              </button>
            )}
          </div>
        )}
        <div ref={scrollRef} style={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden', padding: '6px 16px 20px', boxSizing: 'border-box' }}>
          <div style={{ maxWidth: 480, margin: '0 auto' }}>
            {person ? (
              // A record with a person: their initial with a tick.
              <div style={{ textAlign: 'center', padding: '10px 0 4px' }}>
                <div style={{ position: 'relative', width: 64, height: 64, margin: '0 auto' }}>
                  <div ref={setCheck} style={{ width: 64, height: 64, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 24, fontWeight: 800, color: 'var(--brand-text)', background: 'color-mix(in srgb, var(--brand) 12%, transparent)' }}>{person.initial}</div>
                  <div style={{ position: 'absolute', right: -2, bottom: -2, width: 24, height: 24, borderRadius: '50%', background: person.status === 'failed' ? 'var(--danger)' : person.status === 'pending' ? 'var(--warning)' : 'var(--success)', border: '3px solid var(--bg)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    {person.status === 'failed' ? <X size={12} color="#fff" strokeWidth={3.4} /> : person.status === 'pending' ? <Clock size={12} color="#fff" strokeWidth={3} /> : <Check size={12} color="#fff" strokeWidth={3.4} />}
                  </div>
                </div>
                <div style={{ fontSize: 15, color: 'var(--text-secondary)', marginTop: 12 }}>{person.line}</div>
                <div style={{ fontSize: 32, fontWeight: 800, letterSpacing: '-1px', marginTop: 2, overflowWrap: 'anywhere' }}>{person.amount}{person.unit && <span style={{ fontSize: 20, marginLeft: 6 }}>{person.unit}</span>}</div>
                <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 6 }}><span style={{ color: statusColor, fontWeight: 700 }}>{person.statusText}</span>{person.when ? ` · ${person.when}` : ''}</div>
                {person.note}
              </div>
            ) : (
              <div style={{ position: 'relative', textAlign: 'center', padding: '14px 0 6px' }}>
                {/* No page header (a page inside the Hub): the gift sits at the hero's corner. */}
                {!(page.title || page.onBack) && (page.gift ?? gift) && (
                  <div style={{ position: 'absolute', top: 4, right: 0, zIndex: 2 }}>{page.gift ?? gift}</div>
                )}
                {burst && <Confetti />}
                <div ref={setCheck} style={{
                  width: RECEIPT_CHECK, height: RECEIPT_CHECK, borderRadius: '50%', margin: '0 auto', background: ring,
                  display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: revealed ? 1 : 0,
                  boxShadow: `0 0 0 10px color-mix(in srgb, ${ring} 12%, transparent)`,
                }}>
                  {checkContent ?? (
                    <svg viewBox="0 0 24 24" width="50%" height="50%" fill="none" stroke="#fff" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round">
                      {status === 'failed' ? <><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></>
                        : status === 'pending' ? <><circle cx="12" cy="12" r="9" /><polyline points="12 7 12 12 15.5 14" /></>
                        : <polyline points="20 6 9 17 4 12" />}
                    </svg>
                  )}
                </div>
                <Reveal i={0} revealed={shown}>
                  <div style={{ fontSize: 32, fontWeight: 800, letterSpacing: '-1px', marginTop: 20, overflowWrap: 'anywhere' }}>{heroAmount}</div>
                </Reveal>
                <Reveal i={1} revealed={shown}>
                  <div style={{ fontSize: 15, color: 'var(--text-secondary)', marginTop: 4, overflowWrap: 'anywhere' }}>{heroLine}</div>
                </Reveal>
                {pill && (
                  <Reveal i={2} revealed={shown}>
                    <div style={{ display: 'inline-flex', gap: 6, alignItems: 'center', marginTop: 12, padding: '7px 14px', borderRadius: 999, fontSize: 13, fontWeight: 700, color: 'var(--success-text)', background: 'color-mix(in srgb, var(--success) 15%, transparent)' }}>
                      <Zap size={14} color="#F5B82E" fill="#F5B82E" />{pill}
                    </div>
                  </Reveal>
                )}
              </div>
            )}
            {page.sections}
            {(detailRowsAll.length > 0 || !!links?.length) && (
              <Reveal i={3} revealed={shown}>
                {label('Details')}
                <div ref={cardRef} style={{ ...cardStyle, overflow: 'hidden' }}>
                  {detailRowsAll.map((r, i) => (
                    <div key={r.label} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '12px 14px', borderTop: i ? '1px solid var(--border)' : 'none', fontSize: 14 }}>
                      <span style={{ color: 'var(--text-secondary)', flexShrink: 0 }}>{r.label}</span>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontWeight: 600, minWidth: 0, color: r.positive ? 'var(--success-text)' : 'var(--text-primary)' }}>
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.value}</span>
                        {r.onCopy && (
                          <button type="button" onClick={r.onCopy} aria-label={`Copy ${r.label.toLowerCase()}`}
                            style={{ border: 0, background: 'none', padding: 0, display: 'flex', cursor: 'pointer', color: 'var(--brand-text)', flexShrink: 0 }}>
                            {r.copied ? <Check data-tick size={15} color="var(--success)" /> : <Copy size={15} />}
                          </button>
                        )}
                      </span>
                    </div>
                  ))}
                  {links?.map((l, i) => (
                    <a key={l.href} href={l.href} target="_blank" rel="noopener noreferrer"
                      style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 14px', borderTop: detailRowsAll.length || i ? '1px solid var(--border)' : 'none', fontSize: 14, fontWeight: 700, color: 'var(--brand-text)', textDecoration: 'none' }}>
                      {links.length > 1 ? `${l.title}${l.explorer ? ` · ${l.explorer}` : ''}` : `View on ${l.explorer || 'explorer'}`}
                      <ExternalLink size={16} />
                    </a>
                  ))}
                </div>
                {linksNote && <p style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.45, margin: '8px 4px 0' }}>{linksNote}</p>}
              </Reveal>
            )}
            {promoShown && <Reveal i={4} revealed={shown}>{label('For you')}<SuccessPromo exclude={promo === true ? undefined : promo} revealed={shown} instant /></Reveal>}
          </div>
        </div>
        {footer.length > 0 && (
          <motion.div initial={false} animate={shown ? { opacity: 1 } : { opacity: 0 }} transition={{ duration: 0.3 }}
            style={{ flexShrink: 0, display: 'flex', gap: 10, padding: '12px 16px calc(var(--safe-bottom) + 18px)', background: 'var(--bg)', borderTop: '1px solid var(--border)' }}>
            {footer.map(a => (
              <motion.button key={a.label} onClick={a.onClick} whileTap={{ scale: 0.98 }}
                style={{
                  flex: 1, padding: '13px 0', borderRadius: 999, cursor: 'pointer', fontSize: 15, fontWeight: 700, fontFamily: 'inherit',
                  ...(a.primary
                    ? { border: 0, background: 'var(--brand)', color: '#fff' }
                    : { border: '1.5px solid var(--brand)', background: 'transparent', color: 'var(--brand-text)' }),
                }}>
                {a.label}
              </motion.button>
            ))}
          </motion.div>
        )}
      </div>
    )
  }

  return (
    <div ref={rootRef} style={hasActions ? {
      // With pinned actions: the card scrolls in its own region and the
      // button bar sits below it, outside the scroll - so the bar can never
      // cover any of the details text.
      height: '100%', display: 'flex', flexDirection: 'column', background: 'var(--bg)', boxSizing: 'border-box', overflow: 'hidden',
      ...style,
    } : {
      // Column so the card can centre itself (margin: auto below).
      height: '100%', overflowY: 'auto', overflowX: 'hidden', background: 'var(--bg)', boxSizing: 'border-box',
      display: 'flex', flexDirection: 'column',
      padding: 'calc(var(--safe-top) + 24px) 16px calc(var(--safe-bottom) + 24px)',
      ...style,
    }}>
      <div ref={scrollRef} style={hasActions ? {
        flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden', boxSizing: 'border-box',
        display: 'flex', flexDirection: 'column',
        padding: 'calc(var(--safe-top) + 24px) 16px 16px',
      } : { display: 'contents' }}>
      <div ref={cardRef} className={fill ? undefined : 'shadow-elevation-1'} style={fill ? {
        // The whole box: grows to fill it (taller when details open, then it scrolls).
        // overflow clip (not hidden): clips the same, but isn't a scroll box -
        // so the button below can stick to the bottom of the real scroller.
        position: 'relative', width: '100%', flex: '1 0 auto', minHeight: '100%', boxSizing: 'border-box',
        display: 'flex', flexDirection: 'column', background: 'var(--surface)', overflow: 'clip',
        paddingBottom: 'calc(16px + var(--safe-bottom))',
      } : {
        // margin auto: centred top-to-bottom with equal space above and below
        // when it fits; when it's taller than the screen (details open) the
        // auto margins collapse to 0 and it scrolls from the top as before.
        // With a promo under it the two are centred as one group (no gap between).
        position: 'relative', maxWidth: 480, margin: promoShown ? 'auto auto 0' : 'auto', width: '100%', flexShrink: 0, boxSizing: 'border-box',
        background: 'var(--surface)', border: '1px solid var(--soft-edge)', boxShadow: 'var(--soft-card)', borderRadius: 30, overflow: 'hidden', paddingBottom: 16,
      }}>
        {burst && <Confetti />}
        <div style={{ position: 'relative', height: 140, display: 'flex', alignItems: 'center', justifyContent: 'center', background: HEADER_BG[status] }}>
          {gift && !stamp && <div style={{ position: 'absolute', top: 10, right: 10, zIndex: 3 }}>{gift}</div>}
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
          <div ref={setCheck} style={{
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

        <div style={{ padding: '16px 20px 0', textAlign: 'center', color: 'var(--text-primary)', ...(fill ? { flex: 1, display: 'flex', flexDirection: 'column' } : null) }}>
          {heroText}

          <div style={{ textAlign: 'left', marginTop: 10 }}>
            {rowsBlock}
          </div>

          {!actions?.length && (
            // Filling a sheet: the button stays at the sheet's bottom while
            // the receipt scrolls under it - with the points line, four rows
            // and More details it is taller than chat Pay's sheet, and the
            // button sat cut off below the edge (17 Nov).
            <Reveal i={rows.length + 4} revealed={shown} style={fill ? {
              marginTop: 'auto', paddingTop: 12, paddingBottom: 10,
              position: 'sticky', bottom: 0, zIndex: 1, background: 'var(--surface)',
            } : undefined}>
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
      {promoShown && (
        <div style={{ maxWidth: 480, width: '100%', margin: '0 auto auto', flexShrink: 0 }}>
          <p className="text-xs font-bold text-text-secondary" style={{ margin: '18px 4px 8px' }}>For you</p>
          <SuccessPromo exclude={promo === true ? undefined : promo} revealed={shown} />
        </div>
      )}
      </div>
      {hasActions && (
        <motion.div initial={false} animate={revealed ? { opacity: 1 } : { opacity: 0 }} transition={{ duration: 0.3 }}
          style={{
            flexShrink: 0, display: 'flex', gap: 10,
            padding: '12px 16px calc(var(--safe-bottom) + 16px)',
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
