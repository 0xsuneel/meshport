// The phone's transaction page (approved preview, 18 Nov 2026): one card -
// the amount with the status check at its corner, the note, the type, the
// people (name and address each with a copy button, Pay / Chat), the steps,
// the time and transaction hash(es) with copy, and "details" that open.
// Used by every history record kind that has one (payments, swaps,
// multichain transfers, bridges in, reward claims, bulk payments) and by a
// chat's payment cards - so a payment looks the same from everywhere.
import { useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { ArrowLeft, BadgeCheck, Check, ChevronDown, Clock, Copy, ExternalLink, Share2, X, Zap } from 'lucide-react'
import { useBackLayer } from '@/lib/backLayers'
import { DESKTOP_QUERY, EASE_OUT, PAGE_TRANSITION } from '@/lib/motion'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { DesktopDialogFrame } from './DesktopDialogFrame'
import { copyToClipboard } from '@/lib/utils'
import { useUIStore } from '@/store'
import type { PromoFeature } from './SuccessPromo'
import { PoweredByFooter } from './PoweredByFooter'
import { ActionIcon, type ActionIconName } from './ActionIcon'
import { UserPhoto } from './PhotoFill'

export interface TxParty {
  label: 'From' | 'To'
  name: string
  /** A MeshPort name (copyable), e.g. "suneel.arc". */
  handle?: string
  /** Full address (copyable; shown shortened). */
  address?: string
  /** A chain chip before the handle / address, e.g. "Base Sepolia". */
  chain?: string
  /** Extra line, e.g. "MeshPort wallet · USDC on Arc". */
  sub?: string
  you?: boolean
  /** A small tag beside the name, e.g. "SHOP". */
  tag?: string
  /** A verified business: a check after its name. */
  verified?: boolean
  /** A picture for the circle (a store's logo) instead of the person's photo. */
  photo?: string
  actions?: { label: string; onClick: () => void; busy?: boolean }[]
}

export interface TxDetail {
  title: string
  status: 'success' | 'pending' | 'failed'
  amountLabel: string
  amount: string
  unit?: string
  note?: string
  /** The band's tag. A kind of record: the app's own icon for it and its
   *  name ({ icon: 'chat', text: 'Paid in chat' }). A plain string is a speed
   *  line ("Settled in 1.2s on Arc") and gets the lightning mark. */
  pill?: string | { icon: ActionIconName; text: string }
  /** A swap: what was paid and what came back. */
  exchange?: { paid: string; got: string }
  parties?: TxParty[]
  /** A bulk payment's people. */
  recipients?: { name: string; amount: string }[]
  steps: ReactNode[]
  whenLabel: string
  when: string
  hashes: { label: string; hash: string }[]
  detailsTitle: string
  details: { label: string; value: ReactNode; href?: string; tone?: 'ok' | 'bad' }[]
  /** A failure or recovery note under the amount. */
  reason?: ReactNode
  /** A button at the foot (e.g. "Open Recover"). */
  action?: { label: string; onClick: () => void }
  /** Unused since 19 Nov 2026 (history cards show no offers); kept so callers needn't change. */
  promo?: PromoFeature | boolean
}

const short = (a: string) => (a.length > 16 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a)
const initials = (name: string) => {
  const w = name.replace(/\.arc$/i, '').replace(/^0x/i, '').split(/[\s._-]+/).filter(Boolean)
  return ((w[0]?.[0] ?? '?') + (w.length > 1 ? w[1][0] : '')).toUpperCase()
}

function CopyBtn({ value, what }: { value: string; what: string }) {
  const copy = async () => {
    const ok = await copyToClipboard(value)
    useUIStore.getState().showToastMessage(ok ? `${what} copied` : `Could not copy ${what.toLowerCase()}`, ok ? 'success' : 'error')
  }
  return (
    <button type="button" onClick={() => { void copy() }} aria-label={`Copy ${what.toLowerCase()}`}
      style={{ width: 24, height: 24, borderRadius: 7, border: 0, flexShrink: 0, display: 'inline-grid', placeItems: 'center', cursor: 'pointer',
        color: 'var(--brand-text)', background: 'color-mix(in srgb, var(--brand) 12%, transparent)' }}>
      <Copy size={13} strokeWidth={2.4} />
    </button>
  )
}

const BAND = {
  success: 'linear-gradient(160deg, color-mix(in srgb, var(--brand) 70%, #3FD0B8) 0%, var(--brand) 60%, color-mix(in srgb, var(--brand) 75%, black) 100%)',
  pending: 'linear-gradient(160deg, color-mix(in srgb, var(--warning) 85%, white) 0%, color-mix(in srgb, var(--warning) 80%, #3A2A00) 100%)',
  failed: 'linear-gradient(160deg, color-mix(in srgb, var(--danger) 85%, white) 0%, color-mix(in srgb, var(--danger) 85%, black) 100%)',
} as const

function StatusMark({ status }: { status: TxDetail['status'] }) {
  const bg = status === 'success' ? 'var(--brand)' : status === 'pending' ? 'var(--warning)' : 'var(--danger)'
  return (
    <motion.span aria-label={status === 'success' ? 'Completed' : status === 'pending' ? 'Processing' : 'Failed'}
      style={{ position: 'absolute', top: 20, right: 18, width: 44, height: 44, borderRadius: '50%', display: 'grid', placeItems: 'center', background: '#fff',
        boxShadow: '0 0 0 6px rgba(255,255,255,.14)' }}>
      {status === 'success' ? <Check size={22} color={bg} strokeWidth={3.2} /> : status === 'pending' ? <Clock size={21} color={bg} strokeWidth={2.6} /> : <X size={21} color={bg} strokeWidth={3.2} />}
    </motion.span>
  )
}

// Staggered reveal: the parts under the band fade and rise in turn, 0.05 s
// apart, while the page slides in - not after it (18 Nov 2026: waiting for
// the slide left the card blank, then a second animation). The band's own
// content (amount, check, pill) comes in with the page. Off with reduce motion.
function Rv({ i, children }: { i: number; children: ReactNode }) {
  const reduce = useReducedMotion()
  // Phone: no reveal - the record opens with everything in place. Computer keeps it.
  const desktop = useMediaQuery(DESKTOP_QUERY)
  if (!desktop) return <div>{children}</div>
  return (
    <motion.div initial={reduce ? false : { opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }}
      // A tween, not a spring (a spring's slow start made rows look late),
      // slow enough to see each part arrive in turn: 0.45 s each, 0.1 s apart,
      // starting at once (no wait for the slide).
      transition={{ duration: 0.45, ease: EASE_OUT, delay: Math.max(0, i - 1) * 0.1 }}>
      {children}
    </motion.div>
  )
}

export function TxDetailPage({ detail, onClose }: { detail: TxDetail; onClose: () => void }) {
  useBackLayer(true, onClose)
  // Phones: a page that slides in. Computers: the app's centred popup (as before).
  const desktop = useMediaQuery(DESKTOP_QUERY)
  const [open, setOpen] = useState(false)
  const d = detail
  const infoRows = d.details.filter(r => !r.href)
  const linkRows = d.details.filter(r => r.href)
  const line = <div style={{ height: 1, background: 'var(--border)', margin: '18px 0' }} />
  const muted = 'var(--text-secondary)'

  const share = async () => {
    const text = [
      'MeshPort receipt', '',
      `${d.amount}${d.unit ? ` ${d.unit}` : ''}`,
      `Status: ${d.status === 'success' ? 'Successful' : d.status === 'pending' ? 'Processing' : 'Failed'}`,
      ...(d.parties ?? []).map(p => `${p.label}: ${p.you ? 'You' : p.name}${p.handle ? ` (${p.handle})` : ''}${p.address ? ` ${p.address}` : ''}${p.chain ? ` on ${p.chain}` : ''}`),
      `${d.whenLabel}: ${d.when}`,
      ...d.hashes.map(h => `${h.label}: ${h.hash}`),
      ...d.details.filter(r => typeof r.value === 'string' && !r.href).map(r => `${r.label}: ${r.value}`),
      ...d.details.filter(r => r.href).flatMap(r => ['', `${typeof r.value === 'string' ? r.value : r.label}:`, r.href!]),
    ].join('\n')
    try {
      if (navigator.share) { await navigator.share({ title: d.title, text }); return }
      await navigator.clipboard.writeText(text)
      useUIStore.getState().showToastMessage('Copied - paste it anywhere', 'success')
    } catch { /* share sheet closed */ }
  }

  const stepMark = (i: number) => {
    const done = d.status === 'success' || i === 0
    const bad = d.status === 'failed' && i === 1
    return (
      <span style={{ width: 24, height: 24, borderRadius: '50%', flex: 'none', display: 'grid', placeItems: 'center', position: 'relative', zIndex: 1,
        background: bad ? 'var(--danger)' : done ? 'var(--success)' : 'var(--surface)', border: done || bad ? 'none' : '2px solid var(--border)' }}>
        {bad ? <X size={13} color="#fff" strokeWidth={3.2} /> : done ? <Check size={13} color="#fff" strokeWidth={3.2} /> : null}
      </span>
    )
  }

  const head = (
      <div className="header-row mp-glass-header flex-shrink-0 gap-3 px-5 pt-header pb-header" style={{ position: 'relative', zIndex: 2 }}>
        <button type="button" onClick={onClose} className="back-btn" aria-label="Back"><ArrowLeft className="w-5 h-5 text-text-primary" /></button>
        <h1 className="text-xl font-bold text-text-primary" style={{ flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{d.title}</h1>
        <button type="button" onClick={() => { void share() }} className="back-btn" aria-label="Share"><Share2 className="w-5 h-5 text-text-primary" /></button>
      </div>
  )
  // A computer: the same card in the app's centred popup, with a close button.
  const deskHead = (
      <div className="flex items-center flex-shrink-0 gap-3 px-5 pt-4 pb-3" style={{ position: 'relative', zIndex: 2 }}>
        <h1 className="text-xl font-bold text-text-primary" style={{ flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{d.title}</h1>
        <button type="button" onClick={() => { void share() }} className="back-btn" aria-label="Share"><Share2 className="w-5 h-5 text-text-primary" /></button>
        <button type="button" onClick={onClose} className="back-btn" aria-label="Close" style={{ marginLeft: 8 }}><X className="w-5 h-5 text-text-primary" /></button>
      </div>
  )
  const body = (
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden', padding: '6px 14px calc(var(--safe-bottom) + 20px)' }}>
        <div style={{ maxWidth: 480, margin: '0 auto' }}>
          <div style={{ position: 'relative', background: 'var(--surface)', border: '1px solid var(--soft-edge)', boxShadow: 'var(--soft-card)', borderRadius: 24, overflow: 'hidden' }}>
            {/* Band in the brand / status colour (as the success page): the label, amount, check and pill. */}
            <div style={{ position: 'relative', padding: '20px 18px 18px', color: '#fff', background: BAND[d.status] }}>
            <StatusMark status={d.status} />
            <div>
            <div style={{ fontSize: 13, fontWeight: 700, opacity: 0.8, paddingRight: 80 }}>{d.amountLabel}</div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginTop: 6, paddingRight: 80, flexWrap: 'wrap' }}>
              <b style={{ fontSize: 40, fontWeight: 800, letterSpacing: '-1.5px', overflowWrap: 'anywhere' }}>{d.amount}</b>
              {d.unit && <span style={{ fontSize: 18, fontWeight: 700, opacity: 0.8 }}>{d.unit}</span>}
            </div>
            {/* The tag on the left, when it happened on the right (19 Nov 2026). */}
            {/* One row, side by side: the date never wraps, a long tag shortens with "…". */}
            <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
              {d.pill ? (
                <span title={typeof d.pill === 'string' ? d.pill : d.pill.text}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 12px', borderRadius: 999, fontSize: 13, fontWeight: 700, background: 'rgba(0,0,0,.18)', flex: '0 1 auto', minWidth: 0 }}>
                  {typeof d.pill === 'string'
                    ? <Zap size={14} color="#FFD25E" fill="#FFD25E" style={{ flexShrink: 0 }} />
                    : <span style={{ display: 'inline-flex', flexShrink: 0 }}><ActionIcon name={d.pill.icon} size={15} color="#fff" /></span>}
                  <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {typeof d.pill === 'string' ? d.pill : d.pill.text}
                  </span>
                </span>
              ) : <span />}
              <span style={{ textAlign: 'right', lineHeight: 1.3, marginLeft: 'auto', flexShrink: 0, whiteSpace: 'nowrap' }}>
                <span style={{ display: 'block', fontSize: 11.5, fontWeight: 600, opacity: 0.75 }}>{d.whenLabel}</span>
                <span style={{ display: 'block', fontSize: 13, fontWeight: 700 }}>{d.when}</span>
              </span>
            </div>
            </div>
            </div>
            <div style={{ padding: '0 18px 6px' }}>
            <Rv i={1}>
            {d.exchange && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr auto 1fr', alignItems: 'center', gap: 8, marginTop: 14 }}>
                {[['You paid', d.exchange.paid], ['You got', d.exchange.got]].map(([k, v], i) => (
                  <div key={k} style={{ gridColumn: i ? 3 : 1, border: '1px solid var(--soft-edge)', borderRadius: 14, padding: '9px 11px', minWidth: 0 }}>
                    <small style={{ display: 'block', fontSize: 11.5, color: muted, fontWeight: 700 }}>{k}</small>
                    <b style={{ display: 'block', fontSize: 15.5, fontWeight: 800, marginTop: 2, overflowWrap: 'anywhere' }}>{v}</b>
                  </div>
                ))}
                <span style={{ gridColumn: 2, gridRow: 1, width: 28, height: 28, borderRadius: '50%', display: 'grid', placeItems: 'center', fontWeight: 800,
                  color: 'var(--brand-text)', background: 'color-mix(in srgb, var(--brand) 12%, transparent)' }}>→</span>
              </div>
            )}
            {d.note && (
              <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, marginTop: 14, padding: '9px 14px', borderRadius: '16px 16px 16px 4px', border: '1px solid var(--soft-edge)', fontSize: 14, fontWeight: 600, maxWidth: '100%' }}>
                <span style={{ overflowWrap: 'anywhere' }}>“{d.note}”</span>
              </div>
            )}
            {d.reason && <div style={{ marginTop: 12 }}>{d.reason}</div>}
            </Rv>

            {(d.parties ?? []).map((p, k) => (
              <Rv key={p.label} i={2 + k}>
                {/* Straight under the band: space, not a divider. */}
                {k === 0 && !d.exchange && !d.note && !d.reason ? <div style={{ height: 18 }} /> : line}
                <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: muted }}>{p.label}</div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 19, fontWeight: 800, letterSpacing: '-.3px', marginTop: 4, minWidth: 0 }}>
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.you ? 'You' : p.name}</span>
                      {p.verified && <BadgeCheck size={19} color="#fff" fill="var(--success)" aria-label="Verified business" style={{ flexShrink: 0 }} />}
                      {p.tag && <span style={{ fontSize: 10.5, fontWeight: 800, padding: '2px 7px', borderRadius: 6, color: 'var(--brand-text)', background: 'color-mix(in srgb, var(--brand) 12%, transparent)', flexShrink: 0 }}>{p.tag}</span>}
                    </div>
                    {p.chain && (
                      <div style={{ marginTop: 5 }}>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 700, padding: '3px 9px', borderRadius: 999, background: 'color-mix(in srgb, var(--text-primary) 7%, transparent)' }}>
                          <i style={{ width: 9, height: 9, borderRadius: '50%', background: 'var(--brand)', display: 'inline-block' }} />{p.chain}
                        </span>
                      </div>
                    )}
                    {p.handle && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13.5, color: muted, marginTop: 5 }}>
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.handle}</span><CopyBtn value={p.handle} what="Username" />
                      </div>
                    )}
                    {p.address && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13.5, color: muted, marginTop: 4 }}>
                        <span>{short(p.address)}</span><CopyBtn value={p.address} what="Address" />
                      </div>
                    )}
                    {p.sub && <div style={{ fontSize: 13.5, color: muted, marginTop: 4 }}>{p.sub}</div>}
                    {!!p.actions?.length && (
                      <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
                        {p.actions.map(a => (
                          <button key={a.label} type="button" onClick={a.onClick} disabled={a.busy}
                            style={{ whiteSpace: 'nowrap', padding: '7px 14px', borderRadius: 999, border: '1.5px solid var(--brand)', background: 'transparent', color: 'var(--brand-text)',
                              fontSize: 13.5, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', opacity: a.busy ? 0.6 : 1 }}>{a.busy ? 'Opening…' : a.label}</button>
                        ))}
                      </div>
                    )}
                  </div>
                  <span aria-hidden style={{ position: 'relative', overflow: 'hidden', width: 50, height: 50, borderRadius: '50%', flex: 'none', display: 'grid', placeItems: 'center', fontWeight: 800, fontSize: 17,
                    color: p.you ? 'var(--warning-text)' : 'var(--brand-text)',
                    background: p.you ? 'color-mix(in srgb, var(--warning) 16%, transparent)' : 'color-mix(in srgb, var(--brand) 12%, transparent)' }}>
                    {initials(p.photo ? p.name : p.handle || p.name)}
                    {p.photo
                      ? <img src={p.photo} alt="" onError={e => { e.currentTarget.style.display = 'none' }} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', background: 'var(--surface)' }} />
                      : <UserPhoto name={p.handle} />}
                  </span>
                </div>
              </Rv>
            ))}

            {!!d.recipients?.length && (<Rv i={2}>
              {line}
              <div style={{ fontSize: 13, fontWeight: 700, color: muted, marginBottom: 2 }}>To</div>
              {d.recipients.map((r, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderTop: i ? '1px solid var(--border)' : 'none', fontSize: 14 }}>
                  <span style={{ position: 'relative', overflow: 'hidden', width: 30, height: 30, borderRadius: '50%', flex: 'none', display: 'grid', placeItems: 'center', fontWeight: 800, fontSize: 12,
                    color: 'var(--brand-text)', background: 'color-mix(in srgb, var(--brand) 12%, transparent)' }}>{initials(r.name)}<UserPhoto name={r.name} /></span>
                  <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name}</span>
                  <b style={{ fontWeight: 700 }}>{r.amount}</b>
                </div>
              ))}
            </Rv>)}

            <Rv i={2 + Math.max(d.parties?.length ?? 0, d.recipients?.length ? 1 : 0)}>
            {d.hashes.length > 0 && line}
            <div style={{ fontSize: 14, lineHeight: 1.9 }}>
              {d.hashes.map(h => (
                <div key={h.label} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ color: muted }}>{h.label}</span> {short(h.hash)} <CopyBtn value={h.hash} what="Transaction hash" />
                </div>
              ))}
            </div>

            {/* Explorer links stay visible under the details toggle (19 Nov
                2026); the details open above them and push them down. */}
            {(infoRows.length > 0 || d.steps.length > 0) && (<>
              <button type="button" onClick={() => setOpen(o => !o)} aria-expanded={open}
                style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--brand-text)', fontWeight: 700, fontSize: 14.5, padding: '14px 0 12px', background: 'none', border: 0, cursor: 'pointer', fontFamily: 'inherit' }}>
                {d.detailsTitle} <ChevronDown size={16} style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform .2s' }} />
              </button>
              <AnimatePresence initial={false}>
              {open && (
                <motion.div key="more" initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.28, ease: EASE_OUT }} style={{ overflow: 'hidden' }}>
                <div style={{ borderTop: '1px solid var(--border)', padding: '6px 0 10px' }}>
                  {/* The steps it went through (18 Nov 2026: inside the details). */}
                  {d.steps.length > 0 && (
                    <div style={{ position: 'relative', padding: '6px 0 8px', marginBottom: 6, borderBottom: '1px solid var(--border)' }}>
                      <span aria-hidden style={{ position: 'absolute', left: 11, top: 20, bottom: 22, width: 2, background: 'color-mix(in srgb, var(--success) 35%, transparent)' }} />
                      {d.steps.map((st, i) => (
                        <motion.div key={i} initial={desktop ? { opacity: 0, x: -10 } : false} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.4, ease: EASE_OUT, delay: desktop ? i * 0.09 : 0 }}
                          style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 12, padding: '7px 0', fontSize: 14 }}>
                          {stepMark(i)}<span style={{ minWidth: 0 }}>{st}</span>
                        </motion.div>
                      ))}
                    </div>
                  )}
                  {infoRows.map(r => (
                    <div key={r.label} style={{ display: 'flex', justifyContent: 'space-between', gap: 14, fontSize: 14, padding: '8px 0' }}>
                      <span style={{ color: muted, flexShrink: 0 }}>{r.label}</span>
                      <span style={{ fontWeight: 600, textAlign: 'right', overflowWrap: 'anywhere', color: r.tone === 'ok' ? 'var(--success-text)' : r.tone === 'bad' ? 'var(--danger-text)' : undefined }}>{r.value}</span>
                    </div>
                  ))}
                </div>
                </motion.div>
              )}
              </AnimatePresence>
            </>)}
            {linkRows.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: infoRows.length > 0 || d.steps.length > 0 ? '2px 0 16px' : '14px 0 16px' }}>
                {linkRows.map((r, i) => (
                  <a key={`${r.href}-${i}`} href={r.href} target="_blank" rel="noopener noreferrer"
                    style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7, padding: '11px 12px', borderRadius: 14, fontSize: 14, fontWeight: 700,
                      color: 'var(--brand-text)', background: 'color-mix(in srgb, var(--brand) 10%, transparent)', textDecoration: 'none' }}>
                    {r.value}<ExternalLink size={15} />
                  </a>
                ))}
              </div>
            )}
            {infoRows.length === 0 && d.steps.length === 0 && linkRows.length === 0 && <div style={{ height: 14 }} />}
            </Rv>
            </div>
          </div>

          <Rv i={4 + (d.parties?.length ?? 0)}>
          {d.action && (
            <button type="button" onClick={d.action.onClick}
              style={{ width: '100%', marginTop: 14, border: 'none', borderRadius: 14, padding: 14, fontSize: 15, fontWeight: 800, color: '#fff', background: 'var(--brand)', cursor: 'pointer' }}>
              {d.action.label}
            </button>
          )}
          {/* No "For you" offers on a history card (19 Nov 2026) - only on success screens. */}
          </Rv>
          <PoweredByFooter />
        </div>
      </div>
  )

  if (desktop) return (
    <DesktopDialogFrame onClose={onClose} maxWidth={440} zIndex={1000} backClose={false} bare>
      <div role="dialog" aria-label={d.title} onMouseDown={e => e.stopPropagation()} onTouchStart={e => e.stopPropagation()}
        style={{ display: 'flex', flexDirection: 'column', maxHeight: 'min(88vh, 900px)', borderRadius: 30, overflow: 'hidden', background: 'var(--bg)', color: 'var(--text-primary)' }}>
        {deskHead}
        {body}
      </div>
    </DesktopDialogFrame>
  )
  return createPortal(
    <motion.div role="dialog" aria-modal="true" aria-label={d.title}
      initial={{ x: '100%' }} animate={{ x: 0 }} exit={{ x: '100%' }} transition={PAGE_TRANSITION}
      onMouseDown={e => e.stopPropagation()} onTouchStart={e => e.stopPropagation()}
      style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'var(--bg)', display: 'flex', flexDirection: 'column', willChange: 'transform', color: 'var(--text-primary)' }}>
      {head}
      {body}
    </motion.div>,
    document.body,
  )
}
