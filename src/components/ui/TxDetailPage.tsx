// The phone's transaction page (approved preview, 18 Nov 2026): one card -
// the amount with the status check at its corner, the note, the type, the
// people (name and address each with a copy button, Pay / Chat), the steps,
// the time and transaction hash(es) with copy, and "details" that open.
// Used by every history record kind that has one (payments, swaps,
// multichain transfers, bridges in, reward claims, bulk payments) and by a
// chat's payment cards - so a payment looks the same from everywhere.
import { useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { motion, useReducedMotion } from 'framer-motion'
import { ArrowLeft, Check, ChevronDown, Clock, Copy, ExternalLink, Share2, X } from 'lucide-react'
import { useBackLayer } from '@/lib/backLayers'
import { PAGE_TRANSITION, SPRING_SOFT } from '@/lib/motion'
import { copyToClipboard } from '@/lib/utils'
import { useUIStore } from '@/store'
import { SuccessPromo, type PromoFeature } from './SuccessPromo'

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
  actions?: { label: string; onClick: () => void; busy?: boolean }[]
}

export interface TxDetail {
  title: string
  status: 'success' | 'pending' | 'failed'
  amountLabel: string
  amount: string
  unit?: string
  note?: string
  pill?: string
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

function StatusMark({ status }: { status: TxDetail['status'] }) {
  const reduce = useReducedMotion()
  const bg = status === 'success' ? 'var(--brand)' : status === 'pending' ? 'var(--warning)' : 'var(--danger)'
  return (
    <motion.span aria-label={status === 'success' ? 'Completed' : status === 'pending' ? 'Processing' : 'Failed'}
      initial={reduce ? false : { scale: 0.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ type: 'spring', stiffness: 380, damping: 18, delay: 0.15 }}
      style={{ position: 'absolute', top: 20, right: 18, width: 60, height: 60, borderRadius: '50%', display: 'grid', placeItems: 'center', background: bg,
        boxShadow: `0 0 0 9px color-mix(in srgb, ${bg} 13%, transparent)` }}>
      {status === 'success' ? <Check size={30} color="#fff" strokeWidth={3} /> : status === 'pending' ? <Clock size={28} color="#fff" strokeWidth={2.6} /> : <X size={28} color="#fff" strokeWidth={3} />}
    </motion.span>
  )
}

// Staggered reveal (as the success screen): each part fades and slides up in
// turn, 0.07 s apart, just after the page has slid in. Off with reduce motion.
function Rv({ i, children }: { i: number; children: ReactNode }) {
  const reduce = useReducedMotion()
  return (
    <motion.div initial={reduce ? false : { opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
      transition={{ ...SPRING_SOFT, delay: 0.18 + i * 0.07 }}>
      {children}
    </motion.div>
  )
}

export function TxDetailPage({ detail, onClose }: { detail: TxDetail; onClose: () => void }) {
  useBackLayer(true, onClose)
  const [open, setOpen] = useState(false)
  const d = detail
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

  return createPortal(
    <motion.div role="dialog" aria-modal="true" aria-label={d.title}
      initial={{ x: '100%' }} animate={{ x: 0 }} exit={{ x: '100%' }} transition={PAGE_TRANSITION}
      onMouseDown={e => e.stopPropagation()} onTouchStart={e => e.stopPropagation()}
      style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'var(--bg)', display: 'flex', flexDirection: 'column', willChange: 'transform', color: 'var(--text-primary)' }}>
      <div className="header-row mp-glass-header flex-shrink-0 gap-3 px-5 pt-header pb-header" style={{ position: 'relative', zIndex: 2 }}>
        <button type="button" onClick={onClose} className="back-btn" aria-label="Back"><ArrowLeft className="w-5 h-5 text-text-primary" /></button>
        <h1 className="text-xl font-bold text-text-primary" style={{ flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{d.title}</h1>
        <button type="button" onClick={() => { void share() }} className="back-btn" aria-label="Share"><Share2 className="w-5 h-5 text-text-primary" /></button>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden', padding: '6px 14px calc(var(--safe-bottom) + 20px)' }}>
        <div style={{ maxWidth: 480, margin: '0 auto' }}>
          <div style={{ position: 'relative', background: 'var(--surface)', border: '1px solid var(--soft-edge)', boxShadow: 'var(--soft-card)', borderRadius: 24, padding: '20px 18px 6px' }}>
            <StatusMark status={d.status} />
            <Rv i={0}>
            <div style={{ fontSize: 13, fontWeight: 700, color: muted, paddingRight: 80 }}>{d.amountLabel}</div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginTop: 6, paddingRight: 80, flexWrap: 'wrap' }}>
              <b style={{ fontSize: 40, fontWeight: 800, letterSpacing: '-1.5px', overflowWrap: 'anywhere' }}>{d.amount}</b>
              {d.unit && <span style={{ fontSize: 18, fontWeight: 700, color: muted }}>{d.unit}</span>}
            </div>
            </Rv>
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
            {d.pill && (
              <div style={{ marginTop: 12 }}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '7px 13px', borderRadius: 999, fontSize: 13.5, fontWeight: 700,
                  color: 'var(--success-text)', background: 'color-mix(in srgb, var(--success) 13%, transparent)' }}>{d.pill}</span>
              </div>
            )}
            {d.reason && <div style={{ marginTop: 12 }}>{d.reason}</div>}
            </Rv>

            {(d.parties ?? []).map((p, k) => (
              <Rv key={p.label} i={2 + k}>
                {line}
                <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: muted }}>{p.label}</div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 19, fontWeight: 800, letterSpacing: '-.3px', marginTop: 4, minWidth: 0 }}>
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.you ? 'You' : p.name}</span>
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
                  <span aria-hidden style={{ width: 50, height: 50, borderRadius: '50%', flex: 'none', display: 'grid', placeItems: 'center', fontWeight: 800, fontSize: 17,
                    color: p.you ? 'var(--warning-text)' : 'var(--brand-text)',
                    background: p.you ? 'color-mix(in srgb, var(--warning) 16%, transparent)' : 'color-mix(in srgb, var(--brand) 12%, transparent)' }}>
                    {initials(p.handle || p.name)}
                  </span>
                </div>
              </Rv>
            ))}

            {!!d.recipients?.length && (<Rv i={2}>
              {line}
              <div style={{ fontSize: 13, fontWeight: 700, color: muted, marginBottom: 2 }}>To</div>
              {d.recipients.map((r, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderTop: i ? '1px solid var(--border)' : 'none', fontSize: 14 }}>
                  <span style={{ width: 30, height: 30, borderRadius: '50%', flex: 'none', display: 'grid', placeItems: 'center', fontWeight: 800, fontSize: 12,
                    color: 'var(--brand-text)', background: 'color-mix(in srgb, var(--brand) 12%, transparent)' }}>{initials(r.name)}</span>
                  <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name}</span>
                  <b style={{ fontWeight: 700 }}>{r.amount}</b>
                </div>
              ))}
            </Rv>)}

            <Rv i={2 + Math.max(d.parties?.length ?? 0, d.recipients?.length ? 1 : 0)}>
            {line}
            <div style={{ fontSize: 14, lineHeight: 1.9 }}>
              <div><span style={{ color: muted }}>{d.whenLabel}</span> {d.when}</div>
              {d.hashes.map(h => (
                <div key={h.label} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ color: muted }}>{h.label}</span> {short(h.hash)} <CopyBtn value={h.hash} what={`${h.label} hash`} />
                </div>
              ))}
            </div>

            {(d.details.length > 0 || d.steps.length > 0) && (<>
              <button type="button" onClick={() => setOpen(o => !o)} aria-expanded={open}
                style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--brand-text)', fontWeight: 700, fontSize: 14.5, padding: '14px 0 12px', background: 'none', border: 0, cursor: 'pointer', fontFamily: 'inherit' }}>
                {d.detailsTitle} <ChevronDown size={16} style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform .2s' }} />
              </button>
              {open && (
                <div style={{ borderTop: '1px solid var(--border)', padding: '6px 0 10px' }}>
                  {/* The steps it went through (18 Nov 2026: inside the details). */}
                  {d.steps.length > 0 && (
                    <div style={{ position: 'relative', padding: '6px 0 8px', marginBottom: 6, borderBottom: '1px solid var(--border)' }}>
                      <span aria-hidden style={{ position: 'absolute', left: 11, top: 20, bottom: 22, width: 2, background: 'color-mix(in srgb, var(--success) 35%, transparent)' }} />
                      {d.steps.map((st, i) => (
                        <motion.div key={i} initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} transition={{ ...SPRING_SOFT, delay: i * 0.07 }}
                          style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 12, padding: '7px 0', fontSize: 14 }}>
                          {stepMark(i)}<span style={{ minWidth: 0 }}>{st}</span>
                        </motion.div>
                      ))}
                    </div>
                  )}
                  {d.details.map(r => (
                    <div key={r.label} style={{ display: 'flex', justifyContent: 'space-between', gap: 14, fontSize: 14, padding: '8px 0' }}>
                      <span style={{ color: muted, flexShrink: 0 }}>{r.label}</span>
                      {r.href
                        ? <a href={r.href} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--brand-text)', fontWeight: 700, textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 4 }}>{r.value}<ExternalLink size={13} /></a>
                        : <span style={{ fontWeight: 600, textAlign: 'right', overflowWrap: 'anywhere', color: r.tone === 'ok' ? 'var(--success-text)' : r.tone === 'bad' ? 'var(--danger-text)' : undefined }}>{r.value}</span>}
                    </div>
                  ))}
                </div>
              )}
            </>)}
            {d.details.length === 0 && d.steps.length === 0 && <div style={{ height: 14 }} />}
            </Rv>
          </div>

          <Rv i={4 + (d.parties?.length ?? 0)}>
          {d.action && (
            <button type="button" onClick={d.action.onClick}
              style={{ width: '100%', marginTop: 14, border: 'none', borderRadius: 14, padding: 14, fontSize: 15, fontWeight: 800, color: '#fff', background: 'var(--brand)', cursor: 'pointer' }}>
              {d.action.label}
            </button>
          )}
          {d.promo !== false && <div style={{ marginTop: 14 }}><SuccessPromo exclude={typeof d.promo === 'string' ? d.promo : undefined} /></div>}
          </Rv>
          <div style={{ textAlign: 'center', fontSize: 11.5, color: 'var(--text-muted)', marginTop: 14 }}>MeshPort · Settled on Arc · Circle USDC</div>
        </div>
      </div>
    </motion.div>,
    document.body,
  )
}
