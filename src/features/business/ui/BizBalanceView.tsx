/**
 * BizBalanceView - a business account's Balance tab (27 Nov): everything the
 * business holds. The total, then "Ready to use" (every token on Arc, with
 * its amount and dollar value - spend, pay staff, cash out) and "Arriving
 * from other networks" (USDC customers paid on other chains, per network,
 * moved to Arc in one tap).
 */
import { RefreshCw, ArrowDownToLine, Banknote, Send, ArrowLeftRight, Loader2 } from 'lucide-react'
import type { ReactNode } from 'react'
import { ChainLogo, Skeleton } from './primitives'
import { HistoryRow } from './SettlementsView'
import type { SettlementHistoryItem } from './types'

export interface BizBalanceToken { symbol: string; name: string; icon: string; amount: string; value: string | null }
export interface BizBalanceChain { id: string; label: string; logo?: string; amount: string; onMove: () => void; moveDisabled?: boolean }

export interface BizBalanceViewProps {
  total: string
  ready: string
  arriving: string
  scanning: boolean
  tokens: BizBalanceToken[]
  chains: BizBalanceChain[]
  /** Networks checked, for the logo row when nothing is waiting. */
  networks: { id: string; label: string; logo?: string }[]
  moveAll: { enabled: boolean; label: string; running?: boolean }
  onMoveAll: () => void
  onRefresh: () => void
  onCashOut: () => void
  onPayStaff: () => void
  onSwap: () => void
  /** Past moves to Arc (newest first) and the move running / just run. */
  history?: SettlementHistoryItem[]
  onHistory?: (id: string) => void
  lastRun?: { running: boolean; onOpen: () => void }
  /** Move reminder card, under the networks. */
  footer?: ReactNode
}

const card = 'rounded-[20px] bg-card border border-border'

function Section({ title, hint, right, children }: { title: string; hint: string; right?: ReactNode; children: ReactNode }) {
  return (
    <div className="mx-5">
      <div className="flex items-end justify-between gap-3 mb-2 px-0.5">
        <div className="min-w-0">
          <p className="text-[16px] font-bold text-text-primary">{title}</p>
          <p className="text-[12px] text-text-muted">{hint}</p>
        </div>
        {right}
      </div>
      {children}
    </div>
  )
}

function Action({ icon: Icon, label, onClick, primary }: { icon: typeof Banknote; label: string; onClick: () => void; primary?: boolean }) {
  return (
    <button type="button" onClick={onClick}
      className={`flex-1 inline-flex items-center justify-center gap-1.5 min-h-[40px] rounded-[14px] text-[13.5px] font-semibold active:opacity-85 ${primary ? 'bg-brand text-white' : 'text-text-primary'}`}
      style={primary ? undefined : { background: 'color-mix(in srgb, var(--text-primary) 6%, transparent)', boxShadow: 'inset 0 0 0 1px var(--border)' }}>
      <Icon className="size-4" /> {label}
    </button>
  )
}

export function BizBalanceView(p: BizBalanceViewProps) {
  return (
    <div className="flex flex-col gap-5 pt-1 pb-6">
      {/* Total */}
      <div className="mx-5">
        <div className={`${card} p-4`} style={{ boxShadow: 'var(--glass-card)' }}>
          <p className="text-[13px] font-semibold text-text-muted">Total balance</p>
          <p className="text-[34px] font-bold tabular-nums leading-none tracking-tight text-text-primary mt-1.5">{p.total}</p>
          <div className="grid grid-cols-2 mt-3.5 pt-3 border-t border-border">
            <div>
              <p className="text-[15px] font-bold tabular-nums text-text-primary">{p.ready}</p>
              <p className="text-[11px] text-text-muted">Ready to use</p>
            </div>
            <div className="text-right">
              <p className="text-[15px] font-bold tabular-nums text-text-primary">{p.scanning ? '–' : p.arriving}</p>
              <p className="text-[11px] text-text-muted">{p.scanning ? 'Checking other networks…' : 'Arriving from other networks'}</p>
            </div>
          </div>
        </div>
      </div>

      {/* On Arc */}
      <Section title="Ready to use" hint="On Arc · spend, pay staff or cash out">
        <div className={`${card} overflow-hidden`}>
          <div className="divide-y divide-border">
            {p.tokens.map(t => (
              <div key={t.symbol} className="flex items-center gap-3 px-3.5 py-3">
                <img src={t.icon} alt="" className="size-9 rounded-full shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-[14.5px] font-semibold text-text-primary">{t.symbol}</p>
                  <p className="text-[12px] text-text-muted truncate">{t.name}</p>
                </div>
                <div className="text-right">
                  <p className="text-[14.5px] font-bold tabular-nums text-text-primary">{t.value ?? '…'}</p>
                  <p className="text-[12px] tabular-nums text-text-muted">{t.amount}</p>
                </div>
              </div>
            ))}
          </div>
          <div className="flex gap-2 px-3.5 pb-3.5 pt-1">
            <Action icon={Banknote} label="Cash out" onClick={p.onCashOut} primary />
            <Action icon={Send} label="Pay staff" onClick={p.onPayStaff} />
            <Action icon={ArrowLeftRight} label="Swap" onClick={p.onSwap} />
          </div>
        </div>
      </Section>

      {/* Other networks */}
      <Section title="Arriving from other networks" hint="USDC customers paid on other chains · move it to Arc to use it"
        right={
          <button type="button" aria-label="Check networks again" onClick={p.onRefresh}
            className={`size-9 shrink-0 inline-flex items-center justify-center rounded-xl text-text-muted active:bg-border/40 ${p.scanning ? 'opacity-50 pointer-events-none' : ''}`}>
            <RefreshCw className={`size-4 ${p.scanning ? 'animate-spin' : ''}`} />
          </button>
        }>
        <div className={`${card} overflow-hidden`}>
          {p.scanning ? (
            <div className="flex flex-col gap-3 px-3.5 py-3.5">
              {[0, 1].map(i => (
                <div key={i} className="flex items-center gap-3">
                  <Skeleton className="size-9 rounded-full" />
                  <div className="flex-1"><Skeleton className="h-3.5 w-28 mb-1.5" /><Skeleton className="h-3 w-16" /></div>
                  <Skeleton className="h-8 w-16 rounded-full" />
                </div>
              ))}
            </div>
          ) : p.chains.length === 0 ? (
            <div className="flex flex-col items-center text-center px-6 py-5">
              {p.networks.length > 0 && (
                <div className="flex items-center -space-x-1.5 mb-2.5">
                  {p.networks.slice(0, 6).map(n => <span key={n.id} className="ring-2 ring-card rounded-full"><ChainLogo src={n.logo} label={n.label} size={22} /></span>)}
                  {p.networks.length > 6 && <span className="text-[11px] text-text-muted ml-2.5">+{p.networks.length - 6}</span>}
                </div>
              )}
              <p className="text-sm font-medium text-text-secondary">Nothing waiting</p>
              <p className="text-xs text-text-muted mt-1">All your money is on Arc and ready to use</p>
            </div>
          ) : (
            <>
              <div className="divide-y divide-border">
                {p.chains.map(c => (
                  <div key={c.id} className="flex items-center gap-3 px-3.5 py-3">
                    <ChainLogo src={c.logo} label={c.label} size={36} />
                    <div className="flex-1 min-w-0">
                      <p className="text-[14.5px] font-semibold text-text-primary truncate">{c.label}</p>
                      <p className="text-[12px] tabular-nums text-text-muted">{c.amount} USDC</p>
                    </div>
                    <button type="button" onClick={c.onMove} disabled={c.moveDisabled}
                      className="shrink-0 min-h-[34px] px-3.5 rounded-full text-[13px] font-semibold text-brand-text active:opacity-75 disabled:opacity-40"
                      style={{ background: 'color-mix(in srgb, var(--brand) 12%, transparent)' }}>
                      Move
                    </button>
                  </div>
                ))}
              </div>
              <div className="px-3.5 pb-3.5 pt-1">
                <button type="button" onClick={p.onMoveAll} disabled={!p.moveAll.enabled}
                  className="w-full inline-flex items-center justify-center gap-2 min-h-[44px] rounded-[14px] bg-brand text-white text-[14px] font-semibold active:opacity-90 disabled:opacity-50">
                  {p.moveAll.running ? <Loader2 className="size-4 animate-spin" /> : <ArrowDownToLine className="size-4" />}
                  {p.moveAll.label}
                </button>
                <p className="mt-2 text-center text-[11px] text-text-muted">Free · MeshPort pays the network fee</p>
              </div>
            </>
          )}
        </div>
      </Section>

      {p.lastRun && (
        <div className="mx-5 -mt-2">
          <button type="button" onClick={p.lastRun.onOpen}
            className={`${card} w-full flex items-center justify-between gap-3 px-4 py-3 text-left active:opacity-80`}>
            <span className="flex items-center gap-2 text-[13.5px] font-semibold text-text-primary">
              {p.lastRun.running && <Loader2 className="size-4 text-brand-text animate-spin" />}
              {p.lastRun.running ? 'Moving to Arc…' : 'Last move'}
            </span>
            <span className="text-[13px] font-semibold text-brand-text">See progress ›</span>
          </button>
        </div>
      )}

      {p.footer && <div className="mx-5">{p.footer}</div>}

      {p.history && p.history.length > 0 && p.onHistory && (
        <Section title="Past moves" hint="Money moved from other networks to Arc">
          <div className={`${card} px-3.5 divide-y divide-border`}>
            {p.history.slice(0, 5).map(h => <HistoryRow key={h.id} item={h} onClick={p.onHistory!} />)}
          </div>
        </Section>
      )}
    </div>
  )
}
