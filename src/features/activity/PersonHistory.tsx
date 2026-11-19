// History with one person or wallet address (19 Nov 2026): opened from the
// History button on a payment's card. Every payment between you and them -
// Pay, Chat Pay, Shop payments, address payments, both ways - from your real
// Activity records matched by their wallet address, with what you received
// from them and what you paid them (completed payments only). A row opens
// that payment's card, as in Activity.
import { createContext, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'framer-motion'
import { ArrowLeft, X } from 'lucide-react'
import { useAuthStore } from '@/store'
import { useBackLayer } from '@/lib/backLayers'
import { DESKTOP_QUERY, PAGE_TRANSITION } from '@/lib/motion'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { fetchActivity, resolveCounterpartyNames, type ActivityRecord } from '@/lib/ActivityService'
import { DesktopDialogFrame } from '@/components/ui/DesktopDialogFrame'
import { SkeletonCards } from '@/components/ui/Skeleton'
import { UserPhoto } from '@/components/ui/PhotoFill'
import { ActivityRow, DetailSheet, dedupeAndSortActivityRecords, groupByDate } from './ActivityPage'

/** True inside a person's history: their payments' cards don't offer History again. */
export const InPersonHistory = createContext(false)

export interface HistoryWith { address: string; name: string; handle?: string }

const PAY_TYPES = new Set(['send', 'receive'])
const fmt = (n: number) => String(Number(n.toFixed(6)))

export function PersonHistory({ who, onClose }: { who: HistoryWith; onClose: () => void }) {
  useBackLayer(true, onClose)
  const desktop = useMediaQuery(DESKTOP_QUERY)
  const wallet = useAuthStore(s => s.walletAddress)
  const [records, setRecords] = useState<ActivityRecord[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [open, setOpen] = useState<ActivityRecord | null>(null)
  const addr = who.address.toLowerCase()

  useEffect(() => {
    if (!wallet || !/^0x[0-9a-f]{40}$/.test(addr)) { setRecords([]); return }
    let live = true
    fetchActivity(wallet, { search: addr, limit: 200 })
      .then(rows => resolveCounterpartyNames(rows.filter(r => (r.counterpartyAddress || '').toLowerCase() === addr)))
      .then(rows => { if (live) setRecords(dedupeAndSortActivityRecords(rows)) })
      .catch(() => { if (live) { setFailed(true); setRecords([]) } })
    return () => { live = false }
  }, [wallet, addr])

  const totals = useMemo(() => {
    let got = 0, paid = 0
    for (const r of records ?? []) {
      if (r.status !== 'completed' || !PAY_TYPES.has(r.activityType) || (r.tokenSymbol && r.tokenSymbol !== 'USDC')) continue
      if (r.activityType === 'receive') got += Number(r.amount) || 0
      else paid += Number(r.amount) || 0
    }
    return { got, paid }
  }, [records])

  const listRef = useRef<HTMLDivElement>(null)
  const short = `${addr.slice(0, 6)}…${addr.slice(-4)}`
  const initial = (who.handle || who.name).replace(/^0x/i, '').charAt(0).toUpperCase() || '?'

  const body = (
    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden', paddingBottom: 'calc(var(--safe-bottom) + 20px)' }}>
      <div style={{ maxWidth: 520, margin: '0 auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '6px 20px 16px' }}>
          <span aria-hidden style={{ position: 'relative', overflow: 'hidden', width: 52, height: 52, borderRadius: '50%', flex: 'none', display: 'grid', placeItems: 'center',
            fontWeight: 800, fontSize: 18, color: 'var(--brand-text)', background: 'color-mix(in srgb, var(--brand) 12%, transparent)' }}>
            {initial}<UserPhoto name={who.handle} />
          </span>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 19, fontWeight: 800, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{who.name}</div>
            <div style={{ fontSize: 14, color: 'var(--text-secondary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {[who.handle, short].filter(Boolean).join(' · ')}
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 10, padding: '0 16px 6px' }}>
          {[{ label: 'You received', value: `+$${fmt(totals.got)}`, good: true }, { label: 'You paid', value: `$${fmt(totals.paid)}`, good: false }].map(t => (
            <div key={t.label} style={{ flex: 1, background: 'var(--surface)', border: '1px solid var(--soft-edge)', borderRadius: 18, padding: '12px 14px' }}>
              <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-secondary)' }}>{t.label}</div>
              <div style={{ fontSize: 19, fontWeight: 800, marginTop: 4, color: t.good && totals.got > 0 ? 'var(--success-text)' : 'var(--text-primary)' }}>
                {records ? t.value : '…'}
              </div>
            </div>
          ))}
        </div>
        <div ref={listRef}>
          {records === null ? <div style={{ padding: '10px 16px' }}><SkeletonCards count={4} /></div>
            : records.length === 0 ? (
              <p style={{ textAlign: 'center', color: 'var(--text-secondary)', fontSize: 14, padding: '36px 24px' }}>
                {failed ? 'Could not load the history. Check your connection and try again.' : 'No payments with them yet.'}
              </p>
            ) : groupByDate(records).map(g => (
              <div key={g.label}>
                <div data-stagger style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-secondary)', margin: '16px 20px 4px' }}>{g.label}</div>
                {g.items.map((r, i) => (
                  <ActivityRow key={r.id} record={r} isFirst={i === 0} isLast={i === g.items.length - 1} onSelect={() => setOpen(r)} />
                ))}
              </div>
            ))}
        </div>
      </div>
    </div>
  )

  const detail = open && (
    <InPersonHistory.Provider value={true}>
      <DetailSheet record={open} onClose={() => setOpen(null)} />
    </InPersonHistory.Provider>
  )

  if (desktop) return (
    <DesktopDialogFrame onClose={onClose} maxWidth={480} zIndex={1000} backClose={false} bare>
      <div role="dialog" aria-label="History" onMouseDown={e => e.stopPropagation()} onTouchStart={e => e.stopPropagation()}
        style={{ display: 'flex', flexDirection: 'column', height: 'min(88vh, 900px)', borderRadius: 30, overflow: 'hidden', background: 'var(--bg)', color: 'var(--text-primary)' }}>
        <div className="flex items-center flex-shrink-0 gap-3 px-5 pt-4 pb-3">
          <h1 className="text-xl font-bold text-text-primary" style={{ flex: 1 }}>History</h1>
          <button type="button" onClick={onClose} className="back-btn" aria-label="Close"><X className="w-5 h-5 text-text-primary" /></button>
        </div>
        {body}
      </div>
      {detail}
    </DesktopDialogFrame>
  )
  return createPortal(
    <>
      <motion.div role="dialog" aria-modal="true" aria-label="History"
        initial={{ x: '100%' }} animate={{ x: 0 }} exit={{ x: '100%' }} transition={PAGE_TRANSITION}
        onMouseDown={e => e.stopPropagation()} onTouchStart={e => e.stopPropagation()}
        style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'var(--bg)', display: 'flex', flexDirection: 'column', color: 'var(--text-primary)' }}>
        <div className="header-row mp-glass-header flex-shrink-0 gap-3 px-5 pt-header pb-header" style={{ position: 'relative', zIndex: 2 }}>
          <button type="button" onClick={onClose} className="back-btn" aria-label="Back"><ArrowLeft className="w-5 h-5 text-text-primary" /></button>
          <h1 className="text-xl font-bold text-text-primary" style={{ flex: 1 }}>History</h1>
        </div>
        {body}
      </motion.div>
      {detail}
    </>,
    document.body,
  )
}
