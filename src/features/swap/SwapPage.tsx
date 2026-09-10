import { useState, useEffect, useLayoutEffect, useCallback, useRef, type ReactNode, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { PinKeypad } from '@/components/ui/PinKeypad'
import { AmountKeypad } from '@/components/ui/AmountKeypad'
import { TransactionComplete } from '@/components/ui/TransactionComplete'
import { TravelingCheckmark } from '@/components/ui/TravelingCheckmark'
import { FlashAuthIcon } from '@/components/ui/FlashAuthIcon'
import { useNavigate } from 'react-router-dom'
import {
  ArrowLeft, ArrowUpDown, Settings, CheckCircle, XCircle, RefreshCw, ChevronDown, X, Clock, ExternalLink, ChevronRight,
  Copy, Check, Zap, FileText, Home, RotateCcw, Activity as ActivityIcon, Receipt,
} from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import { useAuthStore, useWalletStore, useUIStore } from '@/store'
import { useSettingsStore } from '@/store/settingsStore'
import { isCoinEnabled } from '@/lib/featureFilters'
import { estimateTransferFee } from '@/lib/arcService'
import { arcRpcJson } from '@/lib/arc'
import { formatAmount, cn, copyToClipboard, trimTrailingZeros } from '@/lib/utils'
import { saveResumableOperation, getResumableOperation, clearResumableOperation } from '@/lib/resumableOperation'
import { hasAnyActivityForTx } from '@/lib/ActivityService'
import { amountFontSize } from '@/lib/amountFontSize'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { DesktopDialogFrame } from '@/components/ui/DesktopDialogFrame'
import { DesktopTransactionAuthDialog } from '@/components/ui/DesktopTransactionAuthDialog'
import { DesktopHistoryPanel, DesktopHistoryEmpty } from '@/components/ui/DesktopHistoryPanel'
import { classifyProxyConnectionFailure } from '@/lib/swapProxyErrors'

// ── Token definitions ─────────────────────────────────────────────────────────
// Arc Testnet: only USDC, EURC, cirBTC supported for swap (per Arc docs)
const EURC_CONTRACT   = '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a'
const CIRBTC_CONTRACT = '0xf0C4a4CE82A5746AbAAd9425360Ab04fbBA432BF'

const SWAP_TOKENS = [
  { id: 'USDC',   label: 'USDC',   sub: 'USD Coin',      logo: 'https://assets.coingecko.com/coins/images/6319/small/usdc.png',       color: 'var(--usdc-icon)', decimals: 6,  contract: '' },
  { id: 'EURC',   label: 'EURC',   sub: 'Euro Coin',     logo: 'https://assets.coingecko.com/coins/images/26045/small/euro-coin.png', color: 'var(--brand)', decimals: 6,  contract: EURC_CONTRACT },
  { id: 'cirBTC', label: 'cirBTC', sub: 'Circle Bitcoin', logo: 'https://assets.coingecko.com/coins/images/1/small/bitcoin.png',       color: '#F7931A', decimals: 8,  contract: CIRBTC_CONTRACT },
]

type Token = typeof SWAP_TOKENS[0]
type Step  = 'idle'|'estimating'|'estimated'|'confirming'|'swapping'|'done'|'failed'

interface Estimate {
  estimatedOutput: { amount: string; token: string }
  stopLimit:       { amount: string; token: string }
  fees: Array<{ token: string; amount: string; type: string }>
  /** Real network/gas cost for this swap, from Circle's SDK (same field
   * MultichainTransferPage's bridge estimate reads) — not always present, so
   * consumers should still have a fallback. */
  gasFee: number
}

// ── Swap history in Supabase activity table ──────────────────────────────────
interface SwapRecord {
  id:         string
  tokenIn:    string
  tokenOut:   string
  amountIn:   string
  amountOut:  string
  txHash:     string
  timestamp:  number
  status:     'success' | 'failed'
  explorerUrl?: string
}

// History is now stored in Supabase activity table (no localStorage)
// SwapPage shows recent history loaded from ActivityService
function addToHistory(_r: SwapRecord, _w: string | null) { /* noop — Supabase handles this */ }
function loadHistory(_w: string | null): SwapRecord[] { return [] }
function saveHistory(_h: SwapRecord[], _w: string | null) { /* noop */ }

function timeAgo(ts: number): string {
  const date = new Date(ts)
  const diff = Date.now() - ts
  const secs = Math.floor(diff / 1000)
  const mins = Math.floor(diff / 60000)
  const hrs  = Math.floor(diff / 3600000)
  const days = Math.floor(diff / 86400000)
  if (secs < 60)  return 'Just now'
  if (mins < 60)  return `${mins}m ago`
  if (hrs  < 24)  return `${hrs}h ago`
  if (days === 1) return `Yesterday ${date.toLocaleTimeString([], {hour:'numeric',minute:'2-digit'})}`
  if (days < 7)   return date.toLocaleDateString([], {weekday:'short'}) + ' ' + date.toLocaleTimeString([], {hour:'numeric',minute:'2-digit'})
  if (days < 365) return date.toLocaleDateString([], {month:'short',day:'numeric'}) + ', ' + date.toLocaleTimeString([], {hour:'numeric',minute:'2-digit'})
  return date.toLocaleDateString([], {month:'short',day:'numeric',year:'numeric'}) + ', ' + date.toLocaleTimeString([], {hour:'numeric',minute:'2-digit'})
}

// USDC/EURC are both ~$1-pegged, so 3 decimals reads fine everywhere.
// cirBTC is BTC-pegged (ARC_TOKENS.cirBTC.decimals = 8) -- a realistic
// cirBTC amount like 0.00025 displayed as "0.00" (or even "0.000000" at
// the old 6-decimal cap several spots below used) silently showed the
// wrong amount. Matches PaySendPage.tsx's / ChatPage.tsx's own identical
// helper -- kept as its own local copy here rather than a new shared
// cross-file import, consistent with how those two files already do it.
function swapTokenDecimals(id: string): number {
  return id === 'cirBTC' ? 8 : 3
}

// Digit/decimal sanitizing for the desktop "You pay" native input (mirrors
// AmountKeypad's own internal sanitizer, which isn't exported).
// BUG FIX: this used to hardcode a 2-decimal cap regardless of token --
// fine for USDC/EURC, but it made it impossible to even TYPE a cirBTC
// amount finer than 0.01, e.g. a real 0.00042320 balance. Takes the target
// token so the cap matches swapTokenDecimals (8 for cirBTC, 3 otherwise).
function sanitizeSwapAmount(raw: string, decimals: number = 3): string {
  let cleaned = raw.replace(/[^\d.]/g, '')
  const firstDot = cleaned.indexOf('.')
  if (firstDot !== -1) cleaned = cleaned.slice(0, firstDot + 1) + cleaned.slice(firstDot + 1).replace(/\./g, '')
  const [intPart, decPart] = cleaned.split('.')
  if (decPart !== undefined) cleaned = intPart + '.' + decPart.slice(0, decimals)
  return cleaned
}

// ── Sub-components ────────────────────────────────────────────────────────────
function TLogo({ t, size=32 }: { t: Token; size?: number }) {
  const [ok, setOk] = useState(true)
  const s = { width:size, height:size, borderRadius:'50%', objectFit:'cover' as const, flexShrink:0 as const }
  if (ok) return <img src={t.logo} alt={t.id} style={s} onError={() => setOk(false)}/>
  return (
    <div style={{ ...s, background:`${t.color}22`, border:`1.5px solid ${t.color}55`,
      display:'flex', alignItems:'center', justifyContent:'center' }}>
      <span style={{ fontSize:size*.32, fontWeight:700, color:t.color }}>{t.id.slice(0,2)}</span>
    </div>
  )
}

function TokenPicker({ selected, exclude, onSelect, onClose, balances }: {
  selected: Token; exclude: Token; onSelect: (t: Token) => void; onClose: () => void
  balances: Record<string, number>
}) {
  const isDesktop = useMediaQuery('(min-width: 980px)')
  const settings = useSettingsStore((s) => s.settings)
  const availableTokens = SWAP_TOKENS.filter(t => isCoinEnabled(settings, t.id))
  const content = (
    <>
      <div className="flex items-center justify-between">
        <p className="text-base font-bold text-text-primary">Select token</p>
        <button onClick={onClose} className="w-8 h-8 rounded-full flex items-center justify-center"
          style={{ background:'color-mix(in srgb, var(--text-primary) 6%, transparent)' }}>
          <X className="w-4 h-4 text-text-secondary"/>
        </button>
      </div>
      <div className="space-y-2">
        {availableTokens.map(t => {
          const isExcluded = t.id === exclude.id
          const isSelected = t.id === selected.id
          const bal        = balances[t.id] ?? 0
          const balStr     = t.id === 'cirBTC' ? trimTrailingZeros(bal.toFixed(8)) : formatAmount(bal, 3)
          return (
            <button key={t.id} disabled={isExcluded} onClick={() => { onSelect(t); onClose() }}
              className="w-full flex items-center gap-3 p-3 rounded-2xl transition-all disabled:opacity-30"
              style={{ background: isSelected ? 'color-mix(in srgb, var(--brand) 15%, transparent)' : 'color-mix(in srgb, var(--text-primary) 4%, transparent)',
                border: isSelected ? '1px solid color-mix(in srgb, var(--brand) 40%, transparent)' : '1px solid transparent' }}>
              <TLogo t={t} size={40}/>
              <div className="flex-1 text-left">
                <p className="text-sm font-bold text-text-primary">{t.label}</p>
                <p className="text-xs text-text-secondary">{t.sub}</p>
              </div>
              <div className="text-right">
                <p className="text-sm font-semibold text-text-primary">{balStr}</p>
                <p className="text-xs text-text-muted">{t.id}</p>
              </div>
              {isSelected && <div className="w-2 h-2 rounded-full bg-brand flex-shrink-0"/>}
            </button>
          )
        })}
      </div>
      <p className="text-xs text-center text-text-muted pb-2">Arc Testnet only · USDC ↔ EURC ↔ cirBTC</p>
    </>
  )

  if (isDesktop) {
    return (
      <DesktopDialogFrame onClose={onClose} maxWidth={420}>
        <div className="p-6 space-y-4">{content}</div>
      </DesktopDialogFrame>
    )
  }
  return (
    <motion.div key="picker" initial={{ opacity:0 }} animate={{ opacity:1 }} exit={{ opacity:0 }}
      className="absolute inset-0 z-50 flex items-end justify-center"
      style={{ background:'rgba(0,0,0,0.6)' }} onClick={onClose}>
      <motion.div initial={{ y:60, opacity:0 }} animate={{ y:0, opacity:1 }} exit={{ y:60, opacity:0 }}
        className="w-full max-w-md rounded-t-3xl p-6 space-y-4"
        style={{ background:'var(--surface)', border:'1px solid var(--border)' }}
        onClick={e => e.stopPropagation()}>
        {content}
      </motion.div>
    </motion.div>
  )
}

function SwapHistoryItem({ r, onOpen, isFirst }: { r: SwapRecord; onOpen: () => void; isFirst?: boolean }) {
  const amtOut = parseFloat(r.amountOut || '0')
  const fmtOut = trimTrailingZeros(r.tokenOut === 'cirBTC' ? amtOut.toFixed(6) : amtOut.toFixed(2))
  const isFailed = r.status !== 'success'
  const statusColor = isFailed ? 'var(--danger)' : 'var(--success)'
  return (
    <div onClick={onOpen} style={{
      display: 'flex', alignItems: 'center', gap: 12, padding: '13px 16px',
      borderTop: isFirst ? 'none' : '1px solid color-mix(in srgb, var(--text-primary) 5%, transparent)',
      cursor: 'pointer',
    }}>
      <div style={{ width: 38, height: 38, borderRadius: '50%', flexShrink: 0,
        background: isFailed ? 'color-mix(in srgb, var(--danger) 10%, transparent)' : 'color-mix(in srgb, var(--success) 10%, transparent)',
        display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          {isFailed ? (
            <>
              <circle cx="8" cy="8" r="6.2" stroke="var(--danger)" strokeWidth="1.4"/>
              <path d="M6.2 6.2l3.6 3.6M9.8 6.2l-3.6 3.6" stroke="var(--danger)" strokeWidth="1.4" strokeLinecap="round"/>
            </>
          ) : (
            <path d="M2 8h5l1.5-3 2 6L12 8h2" stroke="var(--success)" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
          )}
        </svg>
      </div>

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>
          Swap {r.tokenIn} → {r.tokenOut}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 2 }}>
          <span style={{ fontSize: 11, color: statusColor, fontWeight: 600 }}>{isFailed ? 'Failed' : 'Completed'}</span>
          <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>· {timeAgo(r.timestamp)}</span>
        </div>
      </div>

      <div style={{ textAlign: 'right', flexShrink: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: isFailed ? 'var(--danger)' : 'var(--success)' }}>
          {isFailed ? '—' : `+${fmtOut} ${r.tokenOut}`}
        </div>
      </div>
    </div>
  )
}

function HistoryDetail({ r, onClose }: { r: SwapRecord; onClose: () => void }) {
  const isDesktop = useMediaQuery('(min-width: 980px)')
  const tIn  = SWAP_TOKENS.find(t => t.id === r.tokenIn)  ?? SWAP_TOKENS[0]
  const tOut = SWAP_TOKENS.find(t => t.id === r.tokenOut) ?? SWAP_TOKENS[1]
  const amtIn  = parseFloat(r.amountIn  || '0')
  const amtOut = parseFloat(r.amountOut || '0')
  const rate   = amtOut > 0 && amtIn > 0 ? trimTrailingZeros((amtOut / amtIn).toFixed(4)) : '—'
  const content = (
    <>
      <div className="flex items-center justify-between">
        <p className="text-base font-bold text-text-primary">Swap Details</p>
        <button onClick={onClose} className="w-8 h-8 rounded-full flex items-center justify-center"
          style={{ background:'color-mix(in srgb, var(--text-primary) 6%, transparent)' }}>
          <X className="w-4 h-4 text-text-secondary"/>
        </button>
      </div>
      {/* Token pair summary */}
      <div className="flex items-center justify-center gap-4 py-3 rounded-2xl"
        style={{ background: r.status === 'success' ? 'color-mix(in srgb, var(--success) 6%, transparent)' : 'color-mix(in srgb, var(--danger) 6%, transparent)',
          border: r.status === 'success' ? '1px solid color-mix(in srgb, var(--success) 15%, transparent)' : '1px solid color-mix(in srgb, var(--danger) 15%, transparent)' }}>
        <div className="flex flex-col items-center gap-1.5">
          <TLogo t={tIn} size={40}/>
          <p className="text-sm font-bold text-text-primary">{trimTrailingZeros(amtIn.toFixed(swapTokenDecimals(tIn.id)))}</p>
          <p className="text-xs text-text-secondary">{tIn.id}</p>
        </div>
        <ArrowUpDown className={cn('w-5 h-5', r.status === 'success' ? 'text-success' : 'text-danger')}/>
        <div className="flex flex-col items-center gap-1.5">
          <TLogo t={tOut} size={40}/>
          <p className={cn('text-sm font-bold', r.status === 'success' ? 'text-success' : 'text-text-secondary')}>
            {amtOut > 0 ? trimTrailingZeros(amtOut.toFixed(swapTokenDecimals(tOut.id))) : '—'}
          </p>
          <p className="text-xs text-text-secondary">{tOut.id}</p>
        </div>
      </div>
      {/* Details table */}
      <div className="rounded-2xl" style={{ background:'var(--surface)', borderColor:'var(--border)',
        border:'1px solid color-mix(in srgb, var(--text-primary) 5%, transparent)' }}>
        {[
          ['Swap pair',  `${r.tokenIn} → ${r.tokenOut}`],
          ['Rate',       `1 ${r.tokenIn} ≈ ${rate} ${r.tokenOut}`],
          ['Time',       new Date(r.timestamp).toLocaleDateString([], {month:'short',day:'numeric',year:'numeric'}) + ' ' + new Date(r.timestamp).toLocaleTimeString([], {hour:'numeric',minute:'2-digit'})],
          ['Status',     r.status === 'success' ? '✓ Completed' : '✗ Failed'],
        ].map(([l, v]) => (
          <div key={l} className="flex justify-between items-center px-4 py-2.5">
            <span className="text-xs text-text-secondary">{l}</span>
            <span className={cn('text-xs font-medium', l === 'Status' && r.status === 'success' ? 'text-success' : l === 'Status' ? 'text-danger' : 'text-text-primary')}>{v}</span>
          </div>
        ))}
        {r.txHash && (
          <div className="flex justify-between items-center px-4 py-2.5">
            <span className="text-xs text-text-secondary">Tx hash</span>
            <span className="text-xs font-medium text-[var(--brand)]">{r.txHash.slice(0,8)}…{r.txHash.slice(-6)}</span>
          </div>
        )}
      </div>
      {r.txHash && (
        <a href={`https://testnet.arcscan.app/tx/${r.txHash}`} target="_blank" rel="noreferrer"
          className="flex items-center justify-center gap-2 w-full py-3 rounded-2xl text-sm font-semibold text-[var(--brand)] active:scale-95"
          style={{ background:'color-mix(in srgb, var(--brand) 8%, transparent)', border:'1px solid color-mix(in srgb, var(--brand) 20%, transparent)' }}>
          <ExternalLink className="w-4 h-4"/> View on Explorer
        </a>
      )}
    </>
  )

  if (isDesktop) {
    return (
      <DesktopDialogFrame onClose={onClose} maxWidth={420}>
        <div className="p-6 space-y-4">{content}</div>
      </DesktopDialogFrame>
    )
  }
  return (
    <motion.div key="hdetail" initial={{ opacity:0 }} animate={{ opacity:1 }} exit={{ opacity:0 }}
      className="absolute inset-0 z-50 flex items-end justify-center"
      style={{ background:'rgba(0,0,0,0.6)' }} onClick={onClose}>
      <motion.div initial={{ y:80, opacity:0 }} animate={{ y:0, opacity:1 }} exit={{ y:80, opacity:0 }}
        className="w-full max-w-md rounded-t-3xl p-6 space-y-4"
        style={{ background:'var(--surface)', border:'1px solid var(--border)' }}
        onClick={e => e.stopPropagation()}>
        {content}
      </motion.div>
    </motion.div>
  )
}

// ── Swap progress checklist ───────────────────────────────────────────────────
// Timer-based: approve ~5s, swap tx ~15s, confirm ~30s
function SwapChecklist({ step, error, txHash, tokenIn }: { step: string; error: string; txHash?: string; tokenIn: string }) {
  const [elapsed, setElapsed] = useState(0)
  const [startedAt] = useState(Date.now())
  useEffect(() => {
    if (step !== 'swapping') { setElapsed(0); return }
    const t = setInterval(() => setElapsed(e => e + 1), 1000)
    return () => clearInterval(t)
  }, [step])

  const isDone   = step === 'done'
  const isFailed = step === 'failed'
  const approveOk = isDone || elapsed >= 5
  const swapOk    = isDone
  const confirmOk = isDone

  const fmt = (s: number) => `${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}`

  const stepDefs = [
    { label: `Approving ${tokenIn} Spend`, msg: approveOk ? 'Approval confirmed' : 'Waiting for approval…', done: approveOk, active: !approveOk },
    { label: 'Executing Swap',       msg: swapOk ? 'Swap confirmed on Arc' : approveOk ? 'Submitting swap transaction…' : 'Waiting…', done: swapOk, active: approveOk && !swapOk },
    { label: 'Confirmed',            msg: confirmOk ? 'Tokens received in wallet' : 'Waiting for confirmation…', done: confirmOk, active: swapOk && !confirmOk },
  ]

  const stepBg = (done: boolean, active: boolean, err: boolean) => {
    if (done) return 'color-mix(in srgb, var(--success) 15%, transparent)'
    if (active) return 'color-mix(in srgb, var(--brand) 15%, transparent)'
    if (err) return 'color-mix(in srgb, var(--danger) 15%, transparent)'
    return 'color-mix(in srgb, var(--text-primary) 6%, transparent)'
  }
  const stepText = (done: boolean, active: boolean) =>
    done ? 'text-success' : active ? 'text-text-primary' : 'text-text-secondary'

  return (
    <div style={{ background: 'color-mix(in srgb, var(--text-primary) 3%, transparent)', border: '1px solid var(--border)', borderRadius: 16, padding: '18px 18px 18px 16px' }}>
      {stepDefs.map((s, i) => {
        const isLast = i === stepDefs.length - 1
        const errored = isFailed && s.active
        return (
          <div key={s.label} style={{ display: 'flex', gap: 12 }}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flexShrink: 0 }}>
              <div style={{ position: 'relative', width: 24, height: 24, flexShrink: 0 }}>
                {s.active && !isFailed && (
                  <motion.div
                    animate={{ rotate: 360 }}
                    transition={{ duration: 1.3, repeat: Infinity, ease: 'linear' }}
                    style={{
                      position: 'absolute', inset: -4, borderRadius: '50%',
                      border: '2px solid transparent', borderTopColor: 'var(--brand)', borderRightColor: 'color-mix(in srgb, var(--brand) 40%, transparent)',
                    }}
                  />
                )}
                <div style={{
                  width: 24, height: 24, borderRadius: '50%',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  background: s.done ? 'color-mix(in srgb, var(--success) 15%, transparent)' : errored ? 'color-mix(in srgb, var(--danger) 15%, transparent)' : s.active ? 'color-mix(in srgb, var(--brand) 15%, transparent)' : 'color-mix(in srgb, var(--text-primary) 4%, transparent)',
                  border: s.done ? '1.5px solid var(--success)' : errored ? '1.5px solid var(--danger)' : s.active ? '1.5px solid var(--brand)' : '1.5px solid color-mix(in srgb, var(--text-primary) 15%, transparent)',
                }}>
                  {s.done ? (
                    <motion.svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--success)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                      <motion.polyline points="20 6 9 17 4 12" initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 0.3 }} />
                    </motion.svg>
                  ) : errored ? (
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--danger)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                    </svg>
                  ) : s.active ? (
                    <div style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--brand)', animation: 'swap-pulse 1.1s ease-in-out infinite' }}/>
                  ) : null}
                </div>
              </div>
              {!isLast && (
                <div style={{ position: 'relative', width: 1.5, flex: 1, minHeight: 22, margin: '2px 0', background: 'var(--border)', overflow: 'hidden' }}>
                  <motion.div
                    initial={false}
                    animate={{ scaleY: s.done ? 1 : 0 }}
                    transition={{ duration: 0.35, ease: 'easeOut' }}
                    style={{ position: 'absolute', inset: 0, background: 'var(--success)', transformOrigin: 'top' }}
                  />
                </div>
              )}
            </div>
            <div style={{ paddingBottom: isLast ? 0 : 18, flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                <p style={{ fontSize: 14, fontWeight: 500, margin: '0 0 2px', color: s.done ? 'var(--success)' : errored ? 'var(--danger)' : s.active ? 'var(--text-primary)' : 'var(--text-secondary)' }}>
                  {s.label}
                </p>
                {s.active && !isFailed && (
                  <span style={{ fontSize: 11, color: 'var(--brand)', flexShrink: 0 }}>{fmt(elapsed)}</span>
                )}
              </div>
              <p style={{ fontSize: 12, margin: 0, color: 'var(--text-secondary)' }}>{isFailed && s.active ? (error || 'Transaction failed') : s.msg}</p>
              {s.done && txHash && i === 1 && (
                <a href={`https://testnet.arcscan.app/tx/${txHash}`} target="_blank" rel="noopener noreferrer"
                  style={{ fontSize: 10, color: 'var(--brand)', fontFamily: 'monospace', marginTop: 2, display: 'block', textDecoration: 'none' }}>
                  {txHash.slice(0, 16)}…
                </a>
              )}
            </div>
          </div>
        )
      })}
      <style>{`@keyframes swap-pulse { 0%,100% { transform: scale(1); opacity: 1; } 50% { transform: scale(1.5); opacity: 0.5; } }`}</style>
    </div>
  )
}

// ── Success-screen building blocks (mirrors PaySendPage's own success screen
// exactly — same sparkle glyph, same row/step components, same flash→hero
// travel mechanic) so a completed swap looks and behaves just like a
// completed payment ─────────────────────────────────────────────────────────
const SWAP_SPARKLE_PATH = 'M12 0 L14.2 9.8 L24 12 L14.2 14.2 L12 24 L9.8 14.2 L0 12 L9.8 9.8 Z'
function SwapSparkle({ size, style }: { size: number; style?: CSSProperties }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" style={{ position: 'absolute', ...style }}>
      <path d={SWAP_SPARKLE_PATH} fill="rgba(255,255,255,0.55)" />
    </svg>
  )
}

// One row of the Transaction details card (icon-in-circle + label on the
// left, value on the right), with an optional copy button and an optional
// bottom divider for every row but the last.
function SwapDetailRow({ icon, label, value, mono, onCopy, copied, showDivider, last }: {
  icon: ReactNode; label: string; value: string; mono?: boolean
  onCopy?: () => void; copied?: boolean; showDivider?: boolean; last?: boolean
}) {
  return (
    <div>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 9,
        paddingTop: 'clamp(8.1px, 1.71vh, 10.8px)',
        paddingBottom: last ? 'clamp(7.3px, 1.54vh, 9.7px)' : 'clamp(8.1px, 1.71vh, 10.8px)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'clamp(9px, 2.34vw, 11.7px)', minWidth: 0 }}>
          <div style={{
            width: 'clamp(28.8px, 7.65vw, 34.2px)', height: 'clamp(28.8px, 7.65vw, 34.2px)', borderRadius: '50%', flexShrink: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'color-mix(in srgb, var(--text-primary) 6%, transparent)', color: 'var(--brand)',
          }}>
            {icon}
          </div>
          <span style={{ fontSize: 'clamp(12.6px, 3.24vw, 14.4px)', color: 'var(--text-secondary)' }}>{label}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 5.4, minWidth: 0 }}>
          <span style={{
            fontSize: 'clamp(12px, 3.08vw, 13.7px)', fontWeight: mono ? 500 : 700, color: 'color-mix(in srgb, var(--text-primary) 100%, white 12%)',
            fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }}>{value}</span>
          {onCopy && (
            <button onClick={onCopy} title="Copy" style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 2, flexShrink: 0, color: 'var(--text-secondary)', display: 'flex' }}>
              {copied ? <Check className="w-3.5 h-3.5" style={{ color: 'var(--success)' }} /> : <Copy className="w-3.5 h-3.5" />}
            </button>
          )}
        </div>
      </div>
      {showDivider && <div style={{ height: 1, background: 'var(--border)' }} />}
    </div>
  )
}

// One row of the "Process" checklist shown inside the success screen's
// "More details" expansion — same three stages the swapping screen's own
// progress checklist tracks (approve → execute → confirm), always shown
// done since this only ever renders after the swap already succeeded.
function SwapProcessStep({ text, last }: { text: ReactNode; last?: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 9, paddingBottom: last ? 0 : 'clamp(9px, 1.98vh, 12.6px)' }}>
      <div style={{
        width: 18, height: 18, borderRadius: '50%', flexShrink: 0, marginTop: 1,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'var(--brand)', color: '#fff',
      }}>
        <Check className="w-3 h-3" strokeWidth={3} />
      </div>
      <span style={{ fontSize: 'clamp(11.7px, 3.06vw, 13.05px)', color: 'var(--text-primary)', lineHeight: 1.4 }}>{text}</span>
    </div>
  )
}

// ── Main SwapPage ─────────────────────────────────────────────────────────────
export function SwapPage() {
  const isDesktop = useMediaQuery('(min-width: 980px)')
  const navigate  = useNavigate()
  const privateKey = useAuthStore(s => s.privateKey)
  const walletAddress = useAuthStore(s => s.walletAddress)
  const storedPasscode = useAuthStore(s => s.passcode)
  const { balance } = useWalletStore()

  const [tokenIn,      setTokenIn]      = useState(SWAP_TOKENS[0])
  const [tokenOut,     setTokenOut]     = useState(SWAP_TOKENS[1])
  const settingsMap = useSettingsStore((s) => s.settings)
  const settingsLoaded = useSettingsStore((s) => s.loaded)
  useEffect(() => {
    if (!settingsLoaded) return
    const enabled = SWAP_TOKENS.filter(t => isCoinEnabled(settingsMap, t.id))
    if (enabled.length < 2) return // not enough coins to swap — page itself stays gated by FeatureGate
    if (!enabled.find(t => t.id === tokenIn.id))  setTokenIn(enabled[0])
    if (!enabled.find(t => t.id === tokenOut.id)) setTokenOut(enabled.find(t => t.id !== tokenIn.id) ?? enabled[1])
  }, [settingsLoaded, settingsMap])
  const [amountIn,     setAmountIn]     = useState('')
  const [showAmountPad, setShowAmountPad] = useState(false)
  const [estimate,     setEstimate]     = useState<Estimate|null>(null)
  // True only while a debounced live quote (fetched as the person types the
  // amount, before they've tapped Swap) is in flight. Kept separate from
  // step === 'estimating' since that's reserved for the explicit "just
  // tapped Swap, blocking" fetch in handleReview.
  const [liveQuoteLoading, setLiveQuoteLoading] = useState(false)
  // Set when the quote is re-checked immediately before executing the swap
  // (see handleConfirm) and the fee/output turns out to have moved since
  // this screen was first shown — surfaced as a banner instead of silently
  // executing against the stale numbers.
  const [quoteChangedNotice, setQuoteChangedNotice] = useState('')
  const [step,         setStep]         = useState<Step>('idle')
  const [error,        setError]        = useState('')
  const [isUncertainFailure, setIsUncertainFailure] = useState(false)
  const [passEntry,    setPassEntry]    = useState('')
  const [passError,    setPassError]    = useState('')
  const [showPasscodeSheet, setShowPasscodeSheet] = useState(false)
  const [txHash,       setTxHash]       = useState('')
  const [amountOut,    setAmountOut]    = useState('')
  const [slippage,     setSlippage]     = useState(500)
  const [showSettings, setShowSettings] = useState(false)
  const [pickerFor,    setPickerFor]    = useState<'in'|'out'|null>(null)
  // Token balances (fetched from RPC)
  const [tokenBals,    setTokenBals]    = useState<Record<string, number>>({ USDC: balance, EURC: 0, cirBTC: 0 })
  // Swap history
  const [history,      setHistory]      = useState<SwapRecord[]>(() => loadHistory(walletAddress))
  const [histDetail,   setHistDetail]   = useState<SwapRecord|null>(null)
  const [showAllHistory, setShowAllHistory] = useState(false)
  // Mirrors the last quote's total fee so the silent Review-poll can detect
  // a change without depending on a stale closure.
  const totalFeesRef = useRef(0)
  const amtRef       = useRef<HTMLInputElement>(null)

  // ─── Resume an in-flight swap after a refresh ────────────────────────────
  // If the page reloads while a swap was still "swapping"/finishing up, don't
  // drop back to the empty form with zero record it might already be
  // on-chain — that's exactly the situation most likely to make someone
  // submit it again by accident. Restore enough state to render the
  // swapping/success screen and check the real activity table (the actual
  // source of truth, not this marker) for what happened.
  useEffect(() => {
    const marker = getResumableOperation('swap')
    if (!marker) return
    const ctx = marker.context as Record<string, any>
    const foundIn  = SWAP_TOKENS.find(t => t.id === ctx.tokenInId)
    const foundOut = SWAP_TOKENS.find(t => t.id === ctx.tokenOutId)
    if (foundIn)  setTokenIn(foundIn)
    if (foundOut) setTokenOut(foundOut)
    setAmountIn(String(ctx.amountIn ?? ''))
    setAmountOut(String(ctx.amountOut ?? ''))
    setTxHash(marker.txHash)
    setStep('swapping')

    let cancelled = false
    let attempts = 0
    const wallet = (ctx.walletAddress as string | undefined) || walletAddress
    const poll = async () => {
      if (cancelled || !wallet) return
      attempts++
      const found = await hasAnyActivityForTx(wallet, marker.txHash)
      if (cancelled) return
      if (found) {
        setStep('done')
        clearResumableOperation('swap')
        return
      }
      if (attempts >= 8) {
        // Couldn't confirm either way within a reasonable window — don't
        // spin forever, and don't silently drop the marker either. Point
        // at Activity, the real source of truth, instead of guessing.
        setError('Still confirming — check Activity for the latest status.')
        return
      }
      setTimeout(poll, 1500)
    }
    poll()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  // Estimated native-gas cost (in USDC, Arc's native gas token) — used only
  // to hold back gas when the Max button is tapped and tokenIn is USDC, so
  // the swap tx doesn't fail for lack of gas. Same estimate Send uses.
  const [estimatedFee, setEstimatedFee] = useState(0.001)
  useEffect(() => { estimateTransferFee(0).then(setEstimatedFee) }, [])

  // ─── Success screen — same full-screen flash → hero-card takeover
  // PaySendPage uses for a completed payment, reused here for a completed
  // swap so the two feel identical. Two phases: 'flash' (whole screen
  // flashes brand color with a big checkmark + "Swapped Successfully"),
  // then 'collapsed' (that panel shrinks away while the detailed hero +
  // transaction card fades in underneath).
  const [successPhase, setSuccessPhase] = useState<'flash' | 'collapsed'>('flash')
  const [showProcessDetails, setShowProcessDetails] = useState(false)
  const [hashCopied, setHashCopied] = useState(false)
  const { showToastMessage } = useUIStore()
  // Whether THIS swap's passcode came from a biometric check vs typed
  // manually — drives which icon (checkmark vs fingerprint/Face ID) shows
  // on the flash->hero success animation. Set from PinKeypad's onComplete
  // second argument, same as PaySendPage.
  const [paidViaBiometric, setPaidViaBiometric] = useState(false)
  useEffect(() => {
    if (step !== 'done') { setSuccessPhase('flash'); return }
    const t = setTimeout(() => setSuccessPhase('collapsed'), 1500)
    return () => clearTimeout(t)
  }, [step])

  // Gates FlashAuthIcon's own bio->check swap — flips true only once the
  // white circle below has actually finished its spring entrance
  // (onAnimationComplete), not on a guessed timer. Reset alongside
  // successPhase so a second swap in the same session gets a fresh flash
  // instead of starting pre-armed. Same pattern as PaySendPage.
  const [flashCircleReady, setFlashCircleReady] = useState(false)
  useEffect(() => { if (successPhase === 'flash') setFlashCircleReady(false) }, [successPhase])

  // Wall-clock duration of the swap, measured start-to-finish, purely for
  // the success screen's "Completed in X Seconds" pill.
  const swapStartRef = useRef(0)
  const [swapElapsedSeconds, setSwapElapsedSeconds] = useState('0.00')

  // Traveling checkmark: flash position -> hero card's own checkmark spot
  // (same manual getBoundingClientRect + transform technique PaySendPage
  // uses, via the shared TravelingCheckmark component).
  const flashCheckRef = useRef<HTMLDivElement>(null)
  const heroCheckRef = useRef<HTMLDivElement>(null)
  const lastFlashRectRef = useRef<DOMRect | null>(null)
  const [travelRect, setTravelRect] = useState<{ from: DOMRect; to: DOMRect } | null>(null)
  const [travelDone, setTravelDone] = useState(false)
  // Desktop's flash overlay used to portal straight to `document.body` with
  // `position:fixed; inset:0` — meaning it flashed the ENTIRE screen,
  // covering the Recent History column too, not just the flow column the
  // rest of this page's desktop layout confines itself to. It was ported
  // to `document.body` in the first place because PageTransition's
  // motion.div (wraps every route) leaves a stray transform on itself,
  // which makes it the containing block for any `position:fixed`
  // descendant — so a naive non-portalled fixed overlay rendered sized/
  // positioned to that transformed ancestor instead of the viewport. The
  // portal still needs to happen for that reason, but on desktop the
  // overlay's rect is now pinned to this ref (the same flow-column
  // wrapper `flow` already renders inside further down) instead of the
  // full viewport, so it visually respects the two-column layout.
  const desktopColumnRef = useRef<HTMLDivElement>(null)
  const [flashColumnRect, setFlashColumnRect] = useState<DOMRect | null>(null)

  useLayoutEffect(() => {
    if (successPhase === 'flash' && flashCheckRef.current) {
      lastFlashRectRef.current = flashCheckRef.current.getBoundingClientRect()
    }
  })

  // Separate, dependency-gated effect — NOT folded into the unconditional
  // one above. That one has no dep array on purpose (it needs to keep
  // re-measuring flashCheckRef every render while flash is up), but
  // getBoundingClientRect() always returns a brand-new DOMRect object, so
  // calling setFlashColumnRect from an effect with no deps meant: render →
  // effect runs → setState with a "new" (referentially different, even if
  // numerically identical) rect → React sees a state change → re-render →
  // effect runs again → setState again → infinite loop (React error #185,
  // "Maximum update depth exceeded"). Gating on [successPhase, isDesktop]
  // makes it fire once per entry into the flash phase instead.
  useLayoutEffect(() => {
    if (isDesktop && successPhase === 'flash' && desktopColumnRef.current) {
      setFlashColumnRect(desktopColumnRef.current.getBoundingClientRect())
    }
  }, [successPhase, isDesktop])

  useEffect(() => {
    if (successPhase !== 'collapsed') { setTravelDone(false); setTravelRect(null); return }
    const from = lastFlashRectRef.current
    requestAnimationFrame(() => {
      const to = heroCheckRef.current?.getBoundingClientRect()
      if (from && to) {
        setTravelRect({ from, to })
        const t = setTimeout(() => setTravelDone(true), 520)
        return () => clearTimeout(t)
      } else {
        setTravelDone(true)
      }
    })
  }, [successPhase])

  const copySwapHash = async () => {
    if (!txHash) return
    const ok = await copyToClipboard(txHash)
    setHashCopied(true)
    showToastMessage(ok ? 'Transaction hash copied' : 'Could not copy hash', ok ? 'success' : 'error')
    setTimeout(() => setHashCopied(false), 1500)
  }

  // Sync USDC balance from store
  useEffect(() => { setTokenBals(b => ({ ...b, USDC: balance })) }, [balance])

  // Load swap history from Supabase activity table on mount
  useEffect(() => {
    if (!walletAddress) return
    import('@/lib/ActivityService').then(({ fetchActivity }) => {
      fetchActivity(walletAddress, { activityType: 'swap', limit: 100 }).then(records => {
        if (!records.length) return
        const mapped: SwapRecord[] = records.map(r => ({
          id:         r.id,
          tokenIn:    r.metadata?.tokenIn  ?? r.tokenSymbol ?? 'USDC',
          tokenOut:   r.metadata?.tokenOut ?? 'EURC',
          amountIn:   String(r.metadata?.amountIn  ?? r.amount ?? 0),
          amountOut:  String(r.metadata?.amountOut ?? 0),
          txHash:     r.txHash ?? '',
          timestamp:  new Date(r.createdAt).getTime(),
          status:     r.status === 'completed' ? 'success' : r.status as any,
          explorerUrl: r.explorerUrl,
        }))
        setHistory(mapped)
      }).catch(() => {})
    }).catch(() => {})
  }, [walletAddress])

  // Fetch EURC (and cirBTC when contract known) balances via eth_call
  useEffect(() => {
    if (!walletAddress) return
    const fetchErc20 = async (contract: string, decimals: number): Promise<number> => {
      if (!contract) return 0
      try {
        const padded = walletAddress.toLowerCase().replace('0x','').padStart(64,'0')
        const json = await arcRpcJson({ jsonrpc:'2.0', id:1, method:'eth_call',
          params:[{ to: contract, data: '0x70a08231' + padded }, 'latest'] }, 6000)
        const hex = json?.result
        if (!hex || hex === '0x' || hex === '0x0') return 0
        return Number(BigInt(hex)) / Math.pow(10, decimals)
      } catch { return 0 }
    }
    Promise.all([
      fetchErc20(EURC_CONTRACT,   6),
      fetchErc20(CIRBTC_CONTRACT, 8),
    ]).then(([eurc, cirbtc]) => {
      setTokenBals(b => ({ ...b, EURC: eurc, cirBTC: cirbtc }))
    })
  }, [walletAddress])

  // Helper: get balance for tokenIn
  const inBalance = tokenBals[tokenIn.id] ?? 0
  const outBalance = tokenBals[tokenOut.id] ?? 0

  const callProxy = useCallback(async (action: 'estimate' | 'swap', extraParams?: Record<string, any>) => {
    // The backend call had no timeout — if it hangs (e.g. the SDK stalls
    // waiting on a tx that never confirms), the UI just sat on "Swapping…"
    // forever with no error and no way out. A swap gets more time than an
    // estimate since it's doing real on-chain work.
    const controller = new AbortController()
    const timeoutMs = action === 'swap' ? 60000 : 20000
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs)
    let res: Response
    try {
      res = await fetch('/api/swap-proxy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action,
          // Read fresh from the store rather than the closed-over
          // `privateKey` value — this callback's identity (and therefore
          // its closure) only updates on the NEXT render after the store
          // changes, but handleReview's on-demand restore-then-continue
          // (see its own comment) can populate the store and then call
          // this SAME already-captured callProxy within the same tick,
          // before that re-render happens. Reading live state here is what
          // makes that actually work instead of silently sending the stale
          // null it closed over.
          privateKey: useAuthStore.getState().privateKey,
          tokenIn:     extraParams?.tokenIn  ?? tokenIn.id,
          tokenOut:    extraParams?.tokenOut ?? tokenOut.id,
          amountIn:    extraParams?.amountIn ?? parseFloat(amountIn).toFixed(6),
          slippageBps: slippage,
          // Passed through only for action='swap' (see executeSwap) so the
          // server -- which already learns the real txHash the instant
          // kit.swap() resolves -- can persist it onto transaction_attempts
          // itself, synchronously, in the same request. This is the primary
          // fix for the tx_hash-loss root cause: markSwapAttemptSubmitted's
          // own client-side call still fires afterward as a second,
          // redundant attempt (harmless -- both go through the same
          // idempotent status='CREATED' AND tx_hash IS NULL guard), but the
          // system's durability no longer depends on that fire-and-forget
          // call succeeding at all.
          attemptId:   extraParams?.attemptId,
          intentId:    extraParams?.intentId,
        }),
        signal: controller.signal,
      })
    } catch (e: any) {
      // See classifyProxyConnectionFailure's own doc comment: both the
      // client timeout and a raw fetch failure need `.isUncertain` set for
      // a 'swap' action, since either can happen after the swap already
      // broadcast on-chain.
      const { message, isUncertain } = classifyProxyConnectionFailure(action, e)
      throw Object.assign(new Error(message), { isUncertain })
    } finally {
      clearTimeout(timeoutId)
    }
    const json = await res.json().catch(() => ({}))
    if (!res.ok) {
      // Log the full response so we can debug Circle SDK errors
      console.error(`[Swap] ${action} failed ${res.status}:`, json)
      const msg = json?.error ?? `Server error ${res.status}`
      throw Object.assign(new Error(msg), { isLiquidity: json?.isLiquidity, rawError: json?.rawError, isUncertain: json?.isUncertain })
    }
    return json
  }, [privateKey, tokenIn, tokenOut, amountIn, slippage])

  // ── Live quote — fetches once the amount keypad closes ─────────────────
  // Triggered by the keypad closing (Done button or tapping the backdrop —
  // both just flip showAmountPad to false), not by every keystroke, so
  // typing "1", "0", "0" doesn't fire three requests. Only runs while the
  // form is still 'idle' (i.e. before Swap is tapped); Review's own polling
  // effect below takes over once step === 'confirming'. A requestId guards
  // against a stale response landing after the amount/tokens changed again.
  const liveQuoteReqId = useRef(0)
  const wasAmountPadOpen = useRef(false)
  const prevTokenPairRef = useRef({ in: tokenIn.id, out: tokenOut.id })

  // Clear out a stale quote the moment the amount/token/slippage actually
  // changes, so a leftover number from a previous input never lingers.
  // Also clears any error from a previous amount/token combo so it doesn't
  // linger on screen after the person changes what they're swapping.
  useEffect(() => {
    const amt = parseFloat(amountIn)
    liveQuoteReqId.current++ // invalidate any in-flight fetch from before this change
    setLiveQuoteLoading(false)
    setError('')
    if (!amountIn || isNaN(amt) || amt <= 0 || tokenIn.id === tokenOut.id) {
      setEstimate(null)
      if (!['confirming','swapping','done','failed'].includes(step)) setStep('idle')
      return
    }
    setEstimate(null)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amountIn, tokenIn, tokenOut, slippage])

  // Shared fetch body — extracted so both the mobile "keypad just closed"
  // trigger below AND the desktop debounced-typing trigger (there's no
  // keypad-close event on desktop anymore, see the effect after this one)
  // can call the exact same quote logic instead of duplicating it.
  const runLiveQuote = useCallback(async () => {
    const amt = parseFloat(amountIn)
    if (!amt || amt <= 0 || tokenIn.id === tokenOut.id) return
    // Wallet not loaded into the store yet (e.g. this effect firing on
    // initial mount, before useAuthStore hydrates privateKey/walletAddress).
    // callProxy would otherwise send a request with an empty privateKey and
    // the server would correctly 400 with "Missing required fields" — wait
    // silently instead of surfacing that as a user-facing error; the caller
    // (the debounced-typing effect / keypad-close effect) re-fires this once
    // amountIn/tokenIn/tokenOut change again, and separately whenever
    // privateKey itself becomes available (see the effect below).
    if (!privateKey || !walletAddress) return
    const myReqId = ++liveQuoteReqId.current
    setLiveQuoteLoading(true)
    try {
      const est = await callProxy('estimate', {
        tokenIn: tokenIn.id, tokenOut: tokenOut.id, amountIn: amt.toFixed(6),
      })
      if (liveQuoteReqId.current !== myReqId) return // amount/token changed since this fired — drop it
      const gasFee = (est.gasFees ?? []).reduce((s: number, f: any) => s + (parseFloat(f.amount) || 0), 0)
      const freshTotalFees = (est.fees ?? []).reduce((s: number, f: any) => s + (parseFloat(f.amount) || 0), 0)
      totalFeesRef.current = freshTotalFees
      setEstimate({ estimatedOutput: est.estimatedOutput, stopLimit: est.stopLimit, fees: est.fees ?? [], gasFee })
    } catch (e: any) {
      if (liveQuoteReqId.current !== myReqId) return // amount/token changed since this fired — drop it
      // Used to be silent here on the theory that "Swap" hasn't been
      // tapped yet, so nothing needed to show. But callProxy already
      // console.errors this failure (see below) regardless of whether
      // anyone's watching devtools, so the person was left staring at a
      // "0.00" receive amount with the real reason ("no route
      // available", a testnet liquidity gap, etc.) visible only in the
      // console. Surfacing it here matches what handleReview would show
      // if they tapped Swap anyway, just a beat earlier and without
      // making them take that extra step to find out why.
      setError(e?.message ?? 'Failed to get quote')
    } finally {
      if (liveQuoteReqId.current === myReqId) setLiveQuoteLoading(false)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amountIn, tokenIn, tokenOut])

  useEffect(() => {
    const justClosed = wasAmountPadOpen.current && !showAmountPad
    wasAmountPadOpen.current = showAmountPad

    // Switching the token pair (e.g. EURC -> cirBTC) with an amount already
    // typed and the keypad already closed used to sit silently on the
    // cleared 0.00 from the effect above until Swap was tapped — nothing
    // re-triggered a fetch, because the only trigger was a keypad
    // open->close transition, and the keypad never moved. Tracking the
    // previous pair and firing when it changes WHILE the keypad is closed
    // covers that case too. Deliberately gated on `!showAmountPad`, not
    // just "pair changed" — amountIn changes on every keystroke while the
    // keypad is open, and this must not fire mid-typing.
    const pairChanged = prevTokenPairRef.current.in !== tokenIn.id || prevTokenPairRef.current.out !== tokenOut.id
    prevTokenPairRef.current = { in: tokenIn.id, out: tokenOut.id }
    const pairChangedWhileClosed = pairChanged && !showAmountPad

    if ((!justClosed && !pairChangedWhileClosed) || step !== 'idle') return
    runLiveQuote()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showAmountPad, tokenIn, tokenOut])

  // Retry the quote once the wallet finishes loading. Covers the case where
  // the person typed an amount (or the keypad-close/debounce effects fired)
  // while privateKey/walletAddress were still empty — those calls were
  // skipped by runLiveQuote's own guard above, so nothing would otherwise
  // ever re-fetch once the wallet becomes ready.
  const hadWalletRef = useRef(false)
  useEffect(() => {
    const hasWallet = Boolean(privateKey && walletAddress)
    if (hasWallet && !hadWalletRef.current && step === 'idle') runLiveQuote()
    hadWalletRef.current = hasWallet
  }, [privateKey, walletAddress, step, runLiveQuote])

  // BUG FIX (live report -- "entered amount, no quote/rate shown"): mobile
  // previously relied ENTIRELY on catching the keypad's open->closed
  // transition (justClosed above) or a token-pair change while closed to
  // ever fire a quote -- there was no fallback. Any path that left a valid
  // amount sitting in `amountIn` without going through one of those two
  // exact edges (e.g. the component remounting with an amount already
  // present from a previous render/navigation, so the keypad is "closed"
  // from the very first render and never actually transitions) meant
  // `estimate` stayed null forever and "You receive" was stuck showing a
  // static, muted "0.00" with no spinner and no error -- nothing wrong
  // visible, just silently never fetched. This was NOT related to the
  // home-balance refresh; it only ever affected this page's own quote
  // trigger. Desktop already had a robust debounce-on-amountIn safety net
  // below; extending the exact same one to mobile (previously skipped
  // entirely there) closes the gap for both platforms with one change,
  // and is harmless overlap with the keypad-close trigger above (repeat
  // calls for an already-fetched amount are deduped by requestId in
  // runLiveQuote, not literally re-rendered twice).
  useEffect(() => {
    if (step !== 'idle') return
    const amt = parseFloat(amountIn)
    if (!amt || amt <= 0 || tokenIn.id === tokenOut.id) return
    const t = setTimeout(() => { runLiveQuote() }, 500)
    return () => clearTimeout(t)
  }, [amountIn, tokenIn, tokenOut, step, runLiveQuote])

  // ── Fetch (and keep fresh) the quote while Review ('confirming') is open ──
  // This is the ONLY place the swap quote/fee is calculated. It fires once
  // on arrival at Review, then polls quietly in the background for as long
  // as Review stays open — before the passcode sheet — so a moved rate shows
  // up automatically. Never re-fetched once the passcode has been entered
  // (see handleConfirm).
  useEffect(() => {
    if (step !== 'confirming') return
    let cancelled = false
    const fetchQuote = async (silent: boolean) => {
      const amt = parseFloat(amountIn)
      if (!amt || amt <= 0) return
      try {
        const est = await callProxy('estimate', {
          tokenIn: tokenIn.id, tokenOut: tokenOut.id, amountIn: amt.toFixed(6),
        })
        if (cancelled) return
        const gasFee = (est.gasFees ?? []).reduce((s: number, f: any) => s + (parseFloat(f.amount) || 0), 0)
        const freshTotalFees = (est.fees ?? []).reduce((s: number, f: any) => s + (parseFloat(f.amount) || 0), 0)
        if (silent) {
          const prevTotal = totalFeesRef.current
          if (prevTotal > 0) {
            const delta = Math.abs(freshTotalFees - prevTotal)
            if (delta > Math.max(0.0002, prevTotal * 0.02)) {
              setQuoteChangedNotice(`Fees updated (${trimTrailingZeros(prevTotal.toFixed(4))} → ${trimTrailingZeros(freshTotalFees.toFixed(4))} USDC)`)
              setTimeout(() => setQuoteChangedNotice(''), 6000)
            }
          }
        }
        totalFeesRef.current = freshTotalFees
        setEstimate({ estimatedOutput: est.estimatedOutput, stopLimit: est.stopLimit, fees: est.fees ?? [], gasFee })
      } catch {
        // Silent refresh failures don't disturb what's already on screen —
        // the person can still confirm against the last good quote.
      }
    }
    const interval = setInterval(() => fetchQuote(true), 20000)
    return () => { cancelled = true; clearInterval(interval) }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, amountIn, tokenIn, tokenOut, slippage, callProxy])

  // ── Fetch the quote once, transitioning the form into Review on success ──
  // The only trigger for the very first quote fetch — tapping Swap. Nothing
  // fetches before this.
  const handleReview = async () => {
    const amt = parseFloat(amountIn)
    if (!amt || amt <= 0 || tokenIn.id === tokenOut.id) return
    // BUG FIX (2026-09-03): this used to give up the INSTANT privateKey
    // happened to be null, with zero attempt to actually restore it first —
    // so "wallet is still loading" showed even in the completely ordinary
    // case where restoration just hadn't finished yet (e.g. this is the
    // first thing tapped right after a fresh page load) or was one call
    // away from succeeding (a mnemonic-based wallet, or a passcode already
    // stashed this session — see restoreWallet.ts). One on-demand attempt
    // here covers both: it's fast and local for create/import-seed wallets
    // (no network at all — instant), and for social-auto/import-privkey it
    // reuses whatever the app has already been trying in the background.
    // Only genuinely falls through to the error message below if this
    // attempt ALSO fails — at which point "still loading" is honest rather
    // than a message that would never resolve on its own if the real issue
    // is that the wallet needs the passcode re-entered (see
    // WalletRecoveryBanner, which now offers exactly that inline).
    if (!privateKey || !walletAddress) {
      const { restorePrivateKey } = await import('@/lib/restoreWallet')
      await restorePrivateKey().catch(() => {})
      const fresh = useAuthStore.getState()
      if (!fresh.privateKey || !fresh.walletAddress) {
        setError('Your wallet needs to be unlocked — check the banner at the top of the app, or try again in a moment.')
        setStep('idle')
        return
      }
    }
    // A live quote (fetched while typing, see the debounced effect above)
    // may already be sitting there for these exact inputs — if so, skip
    // straight to Review instead of firing a redundant duplicate fetch.
    // Review's own polling effect refreshes it again shortly after anyway.
    if (estimate && !liveQuoteLoading) { setError(''); setStep('confirming'); return }
    setStep('estimating'); setError('')
    try {
      const est = await callProxy('estimate', {
        tokenIn: tokenIn.id, tokenOut: tokenOut.id, amountIn: amt.toFixed(6),
      })
      const gasFee = (est.gasFees ?? []).reduce((s: number, f: any) => s + (parseFloat(f.amount) || 0), 0)
      const freshTotalFees = (est.fees ?? []).reduce((s: number, f: any) => s + (parseFloat(f.amount) || 0), 0)
      totalFeesRef.current = freshTotalFees
      setEstimate({ estimatedOutput: est.estimatedOutput, stopLimit: est.stopLimit, fees: est.fees ?? [], gasFee })
      setStep('confirming')
    } catch (e: any) {
      setError(e?.message ?? 'Failed to get quote')
      setEstimate(null)
      setStep('idle')
    }
  }

  const executeSwap = useCallback(async () => {
    swapStartRef.current = Date.now()
    setStep('swapping'); setError(''); setIsUncertainFailure(false)
    // ── transaction_intent/attempt architecture, mirroring Pay/BulkPay ──────
    // One Swap intent + attempt, created server-side BEFORE any broadcast —
    // see swapIntentService.ts's own header for the disclosed nonce
    // constraint (Circle's Kit SDK owns nonce allocation internally; the
    // `nonce` this returns is informational, not enforced at broadcast
    // time, unlike Pay's). If intent creation itself fails, this swap never
    // broadcasts at all — the same "don't broadcast without a server-
    // recorded intent" rule Pay/BulkPay already enforce.
    const amt = parseFloat(amountIn)
    let attemptId: string | null = null
    let intentId: string | null = null
    try {
      const { createSwapIntent } = await import('@/lib/swapIntentService')
      const decimalsInVal = tokenIn.decimals
      const amountInAtomic = BigInt(Math.round(amt * Math.pow(10, decimalsInVal))).toString()
      const minOut = estimate?.stopLimit?.amount ?? null
      const expectedOut = estimate?.estimatedOutput?.amount ?? null
      const toAtomicOrNull = (v: string | null, decimals: number) => {
        if (v == null) return null
        const n = parseFloat(v)
        if (!Number.isFinite(n)) return null
        return BigInt(Math.round(n * Math.pow(10, decimals))).toString()
      }
      const intentResult = await createSwapIntent({
        walletAddress: walletAddress ?? '',
        idempotencyKey: crypto.randomUUID(),
        chainId: 'arc',
        amountInAtomic,
        decimalsIn: decimalsInVal,
        tokenInAddress: tokenIn.contract || null,
        tokenInSymbol: tokenIn.id,
        isNativeIn: !tokenIn.contract,
        tokenOutAddress: tokenOut.contract || null,
        tokenOutSymbol: tokenOut.id,
        decimalsOut: tokenOut.decimals,
        minAmountOutAtomic: toAtomicOrNull(minOut, tokenOut.decimals),
        expectedAmountOutAtomic: toAtomicOrNull(expectedOut, tokenOut.decimals),
        slippageBps: slippage ?? null,
        routerAddress: null, // Kit Adapter Contract -- not known client-side; swap-confirm/swapConfirmationLive.ts use the authoritative constant server-side, this is metadata-only
      })
      if (!intentResult.success || !intentResult.attemptId) {
        throw new Error(intentResult.error ?? 'Failed to prepare swap')
      }
      attemptId = intentResult.attemptId
      intentId = intentResult.intentId ?? null
    } catch (e: any) {
      setError(e?.message ?? 'Failed to prepare swap')
      setStep('failed')
      return
    }

    try {
      const result = await callProxy('swap', {
        tokenIn: tokenIn.id, tokenOut: tokenOut.id, amountIn: parseFloat(amountIn).toFixed(6),
        attemptId: attemptId ?? undefined, intentId: intentId ?? undefined,
      })
      const hash   = result?.txHash ?? ''
      const aOut   = result?.amountOut ?? estimate?.estimatedOutput?.amount ?? '0'
      setTxHash(hash); setAmountOut(aOut)

      // Persist enough to resume this exact screen if the page gets
      // refreshed while still "swapping"/finishing up below — without
      // this, a refresh mid-swap drops back to the empty form with no
      // record a swap might already be on-chain, which is exactly the
      // situation most likely to make someone submit it again by
      // accident. Cleared once this reaches a terminal state ('done' or
      // 'failed') below.
      if (hash) {
        saveResumableOperation('swap', hash, {
          amountIn, amountOut: aOut, tokenInId: tokenIn.id, tokenOutId: tokenOut.id, walletAddress,
        })
      }

      // Persist the real tx_hash server-side IMMEDIATELY, before doing
      // anything else below -- fire-and-forget: markSwapAttemptSubmitted
      // never throws, and its own failure must never block or fail an
      // already-broadcast, already-real swap. Once this lands, swap-confirm
      // independently verifies the real transaction and drives
      // SWAP_DEBIT/SWAP_CREDIT through the Ledger Interpreter -- this app
      // response is no longer what makes the swap "count" financially.
      if (hash && attemptId) {
        import('@/lib/swapIntentService').then(({ markSwapAttemptSubmitted }) => {
          markSwapAttemptSubmitted(attemptId!, hash).catch(() => { /* best-effort */ })
        }).catch(() => {})
      }

      // Save to history
      const rec: SwapRecord = {
        id:          hash || String(Date.now()),
        tokenIn:     tokenIn.id, tokenOut: tokenOut.id,
        amountIn,    amountOut:  aOut,
        txHash:      hash,
        timestamp:   Date.now(),
        status:      'success',
        explorerUrl: hash ? `https://testnet.arcscan.app/tx/${hash}` : '',
      }
      // BUG FIX (2026-09-03): this used to be unguarded, unlike every other
      // post-swap step below it (notifications, the Activity write, balance
      // refresh, points — all already wrapped in their own try/catch as
      // best-effort). If it threw for any reason (a full/blocked
      // localStorage, e.g. Safari private browsing or a mobile WebView
      // storage quota, or a serialization edge case), the exception
      // propagated straight to this function's OUTER catch below — AFTER
      // the swap had already broadcast successfully and `hash` was already
      // a real, confirmed transaction hash. That outer catch doesn't know
      // the difference between "never broadcast" and "broadcast fine, a
      // local bookkeeping write failed afterward" — it set step='failed'
      // and (since this isn't an `isUncertain` SDK/RPC error) wrote a false
      // 'failed' Activity row on top of a swap that had already succeeded
      // and moved the user's funds. This is the exact mechanism behind
      // reports of a successful swap being shown as failed. Local-history
      // bookkeeping failing is never a reason to call the swap itself a
      // failure — it's best-effort, same as everything else here.
      //
      // SECOND BUG FIX, same block (2026-09-03): `setHistory(loadHistory(...))`
      // used to run right after this. addToHistory/loadHistory are both
      // deliberate no-op stubs now (see their own comment a few hundred
      // lines up — history moved to the Supabase-backed fetch further up
      // this file) — loadHistory() unconditionally returns []. Calling
      // setHistory([]) immediately after every single swap wiped the
      // in-memory history list to empty the instant a swap completed, on
      // both mobile and desktop (same component, same state) — this is the
      // literal cause of "recent history disappears" right after swapping.
      // The Supabase-backed mount effect would eventually repopulate it on
      // a future remount, but not on this same render, and not for the
      // ongoing/just-added swap either. Prepending the new record to the
      // existing in-memory list is what actually keeps history visible AND
      // shows the swap that just happened, immediately.
      try {
        addToHistory(rec, walletAddress)
        setHistory(prev => [rec, ...prev])
      } catch (e) {
        console.warn('[Swap] addToHistory failed (non-fatal, swap already succeeded):', e)
      }

      // In-app notification — guaranteed to show in the Notifications page
      // regardless of OS push permission/subscription state.
      import('@/lib/notifications').then(({ notifySwapComplete }) => {
        notifySwapComplete({ amountOut: parseFloat(aOut) || 0, tokenOut: tokenOut.id })
      }).catch(() => {})

      // Push notification — "Received EURC" style, using whatever the swap's
      // destination token is.
      const uidForPush = useAuthStore.getState().user?.id
      if (uidForPush) {
        import('@/lib/pushNotifications').then(({ sendPushToSelf }) => {
          sendPushToSelf(uidForPush, {
            title:  'Swap Complete',
            body:   `Received ${formatAmount(parseFloat(aOut) || 0, swapTokenDecimals(tokenOut.id))} ${tokenOut.id}`,
            url:    '/swap',
            tag:    `swap-${hash || rec.id}`,
          })
        }).catch(() => {})
      }

      // Save to centralized activity table
      if (walletAddress) {
        import('@/lib/ActivityService').then(({ Activity }) => {
          Activity.swap({
            walletAddress,
            txHash:    hash || rec.id,
            amountIn:  parseFloat(amountIn) || 0,
            amountOut: parseFloat(aOut) || 0,
            tokenIn:   tokenIn.id,
            tokenOut:  tokenOut.id,
            status:    'completed',
          }).catch(() => {})
        }).catch(() => {})
      }

      // Proactive safety net — normally the write above lands within a
      // second or two and this is a harmless no-op (the scan finds the row
      // already there and skips it). But if that direct write silently
      // fails after its own retries (e.g. a network blip right as the app
      // is backgrounded), the swap previously had no way to show up in
      // Activity/Notifications until the next time this tab happened to
      // remount or regain focus — which, on mobile, can be minutes or never
      // for that session. Nudging the same reconciliation scan AppLayout
      // already runs on mount/focus lets it self-heal within seconds
      // instead. Safe to call this often — it's idempotent and this exact
      // race is what the scan's own poll-with-delay guard exists to handle
      // (see claim-recovery-scan/index.ts).
      if (walletAddress) {
        import('@/lib/supabase').then(({ supabase }) => {
          supabase.functions.invoke('claim-recovery-scan', { body: { walletAddress } }).catch(() => {})
        }).catch(() => {})
      }

      // Award points for swap
      if (walletAddress && hash) {
        const uid = useAuthStore.getState().user?.id
        if (uid) {
          try {
            const { awardTransactionPoints } = await import('@/lib/rewards')
            const { notifyRewardSwap } = await import('@/lib/notifications')
            const r = await awardTransactionPoints({ userId: uid, walletAddress, txHash: hash })
            if (r.pointsAwarded > 0) notifyRewardSwap(r.pointsAwarded)
          } catch {}
        }
      }
      try {
        const { getUSDCBalance } = await import('@/lib/arcService')
        const newUSDC = await getUSDCBalance(walletAddress ?? '')
        useWalletStore.getState().setBalance(newUSDC)
        setTokenBals(b => ({ ...b, USDC: newUSDC }))
        // Also refresh EURC + cirBTC after swap
        if (walletAddress) {
          const pad = walletAddress.toLowerCase().replace('0x','').padStart(64,'0')
          const fetchErc20 = async (contract: string, decimals: number) => {
            if (!contract) return 0
            try {
              const j = await arcRpcJson({ jsonrpc:'2.0', id:1, method:'eth_call',
                params:[{ to: contract, data: '0x70a08231' + pad }, 'latest'] }, 6000)
              const hex = j?.result
              if (!hex || hex === '0x' || hex === '0x0') return 0
              return Number(BigInt(hex)) / Math.pow(10, decimals)
            } catch { return 0 }
          }
          Promise.all([
            fetchErc20(EURC_CONTRACT,   6),
            fetchErc20(CIRBTC_CONTRACT, 8),
          ]).then(([eurc, cirbtc]) => {
            setTokenBals(b => ({ ...b, EURC: eurc, cirBTC: cirbtc }))
          })
        }
      } catch {}
      const elapsedMs = swapStartRef.current ? Date.now() - swapStartRef.current : 0
      setSwapElapsedSeconds((elapsedMs / 1000).toFixed(2))
      setStep('done')
      clearResumableOperation('swap')
    } catch (e: any) {
      const msg = e?.shortMessage ?? e?.message ?? 'Swap failed'
      const uncertain = !!e?.isUncertain
      // Uncertain outcomes (a confirmation-check/RPC failure after the
      // transaction may have already broadcast — see swap-proxy.js's
      // extractError) skip writing a 'failed' record entirely. Asserting
      // failure here would be actively wrong if the swap actually landed —
      // the server already made a best-effort defensive recording of the
      // real 'swap' row if it could find a txHash in the error, and
      // deposit-scan-all will pick up the real outcome regardless. Writing
      // a conflicting client-side 'failed' row on top of that only adds
      // confusion, not information.
      if (!uncertain) {
        const failedRec: SwapRecord = {
          id: String(Date.now()), tokenIn: tokenIn.id, tokenOut: tokenOut.id,
          amountIn, amountOut: '0', txHash: '', timestamp: Date.now(), status: 'failed',
        }
        addToHistory(failedRec, walletAddress)
        // Same fix as the success path above — loadHistory() is a no-op
        // stub that always returns [], so this used to wipe history to
        // empty on every genuine failure too, not just on success.
        setHistory(prev => [failedRec, ...prev])
        if (walletAddress) {
          import('@/lib/ActivityService').then(({ Activity }) => {
            Activity.swap({
              walletAddress,
              txHash:    'fail_' + Date.now(),
              amountIn:  parseFloat(amountIn) || 0,
              amountOut: 0,
              tokenIn:   tokenIn.id,
              tokenOut:  tokenOut.id,
              status:    'failed',
            }).catch(() => {})
          }).catch(() => {})
        }
      }
      setIsUncertainFailure(uncertain)
      setError(msg); setStep('failed')
      clearResumableOperation('swap')
    }
  }, [callProxy, tokenIn, tokenOut, amountIn, slippage, estimate, walletAddress])

  const handleConfirm = async () => {
    if (storedPasscode) {
      if (passEntry.length < 6) { setPassError('Enter your 6-digit passcode'); return }
      const { verifyPasscode } = await import('@/lib/security')
      if (!await verifyPasscode(passEntry, storedPasscode)) { setPassError('Incorrect passcode'); setPassEntry(''); return }
    }
    // Gas on Arc is always paid in native USDC, no matter which token is
    // being swapped — a EURC/cirBTC→USDC swap still needs leftover native
    // USDC to pay for it. `gasShortfall` (component scope, shared with the
    // Max button and the warning banner on the review screen) already
    // covers this using the real SDK gas figure when available, or the
    // transfer-based guess before that. This is the last line of defense
    // in case someone reaches the passcode sheet before the warning banner
    // caught it (e.g. balance changed after the review screen loaded).
    if (gasShortfall > 0) {
      setPassError(`Not enough USDC left for network gas. Need ~${trimTrailingZeros(gasNeeded.toFixed(4))} USDC for gas, would have ${trimTrailingZeros(usdcAfterSwap.toFixed(4))} USDC left.`)
      setPassEntry('')
      return
    }

    // Fees/quote are never (re-)calculated at this point. The quote was
    // already fetched — and kept fresh via polling — while the user was on
    // Review (see the Review-step effect above); whatever is in `estimate`
    // right now is what they saw and confirmed against. We execute against
    // that quote rather than firing another SDK call from the passcode
    // sheet.
    setPassEntry(''); setPassError(''); setShowPasscodeSheet(false); await executeSwap()
  }

  const flip = () => {
    const prev = tokenIn; setTokenIn(tokenOut); setTokenOut(prev)
    setAmountIn(''); setEstimate(null); setStep('idle')
  }

  const reset = () => { setStep('idle'); setAmountIn(''); setEstimate(null); setTxHash(''); setError(''); setQuoteChangedNotice('') }
  const totalFees = (estimate?.fees ?? []).reduce((s, f) => s + parseFloat(f.amount || '0'), 0)
  const isActive  = ['idle','estimating'].includes(step)

  // Gas on Arc is always paid in native USDC, no matter which token is
  // being swapped — a EURC/cirBTC → USDC swap still needs leftover native
  // USDC to pay for it. Prefer the real SDK gas figure (estimate.gasFee)
  // once an estimate has loaded; fall back to a scaled transfer-fee guess
  // before that. Shared by the Max button, the pre-flight confirm check,
  // and the inline warning below so they never disagree with each other.
  const SWAP_GAS_MULTIPLIER = 12 // swap ≈ 150k-250k gas vs. 21k for a transfer
  const MIN_GAS_RESERVE = 0.02
  const gasNeeded = estimate && estimate.gasFee > 0
    ? Math.max(estimate.gasFee * 1.15, MIN_GAS_RESERVE)
    : Math.max(estimatedFee * SWAP_GAS_MULTIPLIER, MIN_GAS_RESERVE)
  const usdcAfterSwap = balance - (tokenIn.id === 'USDC' ? (parseFloat(amountIn) || 0) : 0)
  const gasShortfall  = Math.max(0, gasNeeded - usdcAfterSwap)

  // The Swap CTA used to be the ONLY trigger for the first quote fetch, so
  // gating it on `estimate` existing would have deadlocked (nothing would
  // ever populate it). That's no longer true: the live-quote effects above
  // now reliably fetch a background quote as soon as a valid amount/pair is
  // set, on both mobile and desktop (see the debounce fix). So this can now
  // also require that live quote to have actually landed before enabling —
  // matching Multichain Claim's Confirm Amount gating -- instead of letting
  // someone tap Swap against a rate that hasn't shown up yet.
  const canReview = step === 'idle'
    && parseFloat(amountIn || '0') > 0
    && tokenIn.id !== tokenOut.id
    && parseFloat(amountIn) <= inBalance
    && gasShortfall <= 0
    && !!estimate
    && !liveQuoteLoading

  // Format balance for display depending on token
  const fmtBal = (id: string, val: number) => trimTrailingZeros(id === 'cirBTC' ? val.toFixed(8) : formatAmount(val, 3))


  // Held in a variable (not returned directly) so the exact same JSX renders
  // either as the whole page (mobile) or as the left column of the desktop
  // 2-column layout below — never duplicated.
  const flow = (
    // Desktop: no `overflow-hidden`/inner `overflow-y-auto` split here — this
    // whole flow already sits inside a single scrolling column (the desktop
    // 2-column wrapper below), so the mobile sticky-header-over-clipped-body
    // trick would just clip tall content (Review/Progress/Done screens) with
    // no way to reach what's below the fold. Mobile keeps that trick
    // unchanged (its ancestor chain provides the bounded height it needs).
    <div className={isDesktop ? "flex flex-col" : "flex-1 flex flex-col overflow-hidden"} style={{ background:'var(--bg)' }}>

      {/* Header — on desktop, the Done step swaps this for a compact
          centered "Success" header (same padding/size as
          MultichainClaimPage's own done-step header) instead of the full
          Swap/settings header, so its height matches DesktopHistoryPanel's
          own header row and the two columns' content starts at the same
          Y instead of Swap's taller header pushing it down further. */}
      {/* Success screen supplies its own back+title header inside the hero
          card (matching PaySendPage's completed-payment screen), so the
          normal Swap header is skipped entirely once a swap has landed. */}
      {step !== 'done' && (
        <div className={cn("header-row flex-shrink-0 justify-between px-5 pt-header pb-header", !isDesktop && "sticky top-0 z-20")}
          style={{ background:'color-mix(in srgb, var(--bg) 95%, transparent)', backdropFilter:'blur(12px)', borderBottom:'1px solid color-mix(in srgb, var(--text-primary) 5%, transparent)' }}>
          <div className="flex items-center gap-3">
            {!isDesktop && (
              <button onClick={() => navigate('/')}
                className="back-btn">
                <ArrowLeft className="w-5 h-5 text-text-primary"/>
              </button>
            )}
            <h1 className="text-xl font-bold text-text-primary">Swap</h1>
          </div>
          <button onClick={() => setShowSettings(s => !s)}
            className="w-9 h-9 rounded-2xl flex items-center justify-center active:scale-95"
            style={showSettings ? { background:'var(--brand)' } : { background:'var(--surface)', border:'1px solid color-mix(in srgb, var(--text-primary) 6%, transparent)' }}>
            <Settings className="w-4 h-4 text-text-secondary"/>
          </button>
        </div>
      )}

      {/* Scrollable content (desktop: plain — the ancestor column scrolls) */}
      <div className={isDesktop ? undefined : "flex-1 overflow-y-auto"}>
      <div className="px-4 pt-4 pb-8 space-y-3">

        {/* Settings panel */}
        <AnimatePresence>
        {showSettings && (
          <motion.div key="set" initial={{ height:0, opacity:0 }} animate={{ height:'auto', opacity:1 }}
            exit={{ height:0, opacity:0 }} className="overflow-hidden">
            <div className="p-4 rounded-2xl space-y-3" style={{ background:'var(--surface)', border:'1px solid color-mix(in srgb, var(--brand) 20%, transparent)' }}>
              <p className="text-xs font-semibold text-text-secondary uppercase tracking-wider">Slippage Tolerance</p>
              <div className="flex gap-2">
                {[100,300,500].map(b => (
                  <button key={b} onClick={() => setSlippage(b)}
                    className="flex-1 py-2.5 rounded-xl text-sm font-bold transition-all"
                    style={{ background: slippage===b ? 'var(--brand)' : 'color-mix(in srgb, var(--text-primary) 5%, transparent)', color: slippage===b ? '#fff' : 'var(--text-secondary)' }}>
                    {b/100}%
                  </button>
                ))}
              </div>
            </div>
          </motion.div>
        )}
        </AnimatePresence>

        {/* Swap card */}
        {/* Testnet liquidity notice */}
        {isActive && (
        <div className="flex items-start gap-2 rounded-xl px-3 py-2"
          style={{ background: 'color-mix(in srgb, var(--warning) 8%, transparent)', border: '1px solid color-mix(in srgb, var(--warning) 20%, transparent)' }}>
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0, marginTop: 1 }}>
            <circle cx="8" cy="8" r="7" stroke="var(--warning)" strokeWidth="1.4"/>
            <path d="M8 5v4M8 11v.5" stroke="var(--warning)" strokeWidth="1.4" strokeLinecap="round"/>
          </svg>
          <p className="text-[11px] leading-snug" style={{ color: 'var(--warning)' }}>
            Arc Testnet swap liquidity can be unstable. If you get "No route available", try a smaller amount or wait a few minutes.
          </p>
        </div>
        )}
        {isActive && (
        <div className="rounded-2xl overflow-hidden"
          style={{ background:'var(--surface)', border:'1px solid color-mix(in srgb, var(--text-primary) 7%, transparent)' }}>

          {/* Pay section */}
          <div className="p-4 space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-sm text-text-secondary">You pay</p>
              <div className="px-3 py-1.5 rounded-full" style={{ background:'color-mix(in srgb, var(--text-primary) 6%, transparent)' }}>
                <span className="text-xs font-medium text-text-secondary">Balance: {fmtBal(tokenIn.id, inBalance)}</span>
              </div>
            </div>
            <div className="flex items-center justify-between gap-3">
              <button onClick={() => setPickerFor('in')}
                className="flex items-center gap-2.5 active:opacity-70 transition-opacity flex-shrink-0">
                <TLogo t={tokenIn} size={36}/>
                <div className="text-left">
                  <div className="flex items-center gap-1">
                    <span className="text-lg font-bold text-text-primary">{tokenIn.id}</span>
                    <ChevronDown className="w-4 h-4 text-text-secondary"/>
                  </div>
                  <p className="text-xs text-text-secondary">{tokenIn.sub}</p>
                </div>
              </button>
              {/* Mobile only — desktop's live amount input is the always-
                  open AmountKeypad card right below instead of a tap-to-
                  reveal display. */}
              {!isDesktop && (
                <div className="min-w-0 text-right" onClick={() => setShowAmountPad(v => !v)} style={{ cursor: 'pointer' }}>
                  <span className="font-bold text-text-primary" style={{ fontSize: `${amountFontSize(amountIn, 34)}px`, lineHeight: 1 }}>
                    {amountIn || '0.00'}
                  </span>
                  <p style={{ fontSize: 14, color: 'var(--text-secondary)', marginTop: 4 }}>
                    ${formatAmount(parseFloat(amountIn || '0'))}
                  </p>
                </div>
              )}
            </div>
            {isDesktop ? (
              // Reference design: the amount lives directly inside "You pay"
              // as a plain bordered box with an overlaid Max pill — not
              // AmountKeypad's own elevated/shadowed card (that chrome is
              // right for pages with no box of their own, but Swap already
              // has one here, so stacking AmountKeypad's card inside it
              // doubled up the framing and threw off the spacing/sizing
              // seen in the reference).
              <div style={{ position: 'relative' }}>
                <div style={{
                  position: 'relative',
                  background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 14,
                  padding: '18px 20px', minHeight: 84, display: 'flex', alignItems: 'center', justifyContent: 'center', boxSizing: 'border-box',
                }}>
                  {/* $ pinned to a fixed left inset, not inline before the
                      input — keeps the digits truly centered in the box no
                      matter how many are typed (matches Pay's amount box). */}
                  <span style={{ position: 'absolute', left: 20, fontSize: 34, fontWeight: 700, color: amountIn ? 'var(--text-primary)' : 'var(--text-muted)', pointerEvents: 'none' }}>$</span>
                  <input
                    type="text"
                    inputMode="decimal"
                    autoFocus
                    value={amountIn}
                    onChange={e => { setAmountIn(sanitizeSwapAmount(e.target.value, swapTokenDecimals(tokenIn.id))); setEstimate(null) }}
                    placeholder="0.00"
                    style={{
                      width: '100%', background: 'transparent', border: 'none', outline: 'none', padding: 0,
                      // BUG FIX: this was a fixed 34px no matter how long
                      // the typed amount got -- an 8-decimal cirBTC value
                      // would overflow the box instead of shrinking.
                      fontSize: amountFontSize(amountIn, 34), fontWeight: 700, color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums',
                      textAlign: 'center',
                    }}
                    aria-label={`Amount in ${tokenIn.id}`}
                  />
                </div>
                {inBalance > 0 && (
                  <button
                    onClick={() => {
                      // Same fee-safe Max ceiling AmountKeypad's Max button
                      // uses (see feeReserve comment on the mobile branch
                      // below) — USDC pays Arc's native gas out of this same
                      // balance, so Max holds back gasNeeded for it.
                      const decimals = swapTokenDecimals(tokenIn.id)
                      const maxSendable = Math.max(0, inBalance - (tokenIn.id === 'USDC' ? gasNeeded : 0))
                      setAmountIn(parseFloat(maxSendable.toFixed(decimals)).toString())
                      setEstimate(null)
                    }}
                    style={{
                      position: 'absolute', top: 14, right: 16, padding: '5px 14px', borderRadius: 100,
                      border: '1px solid color-mix(in srgb, var(--brand) 40%, transparent)',
                      background: 'color-mix(in srgb, var(--brand) 12%, transparent)', color: 'var(--brand)',
                      fontSize: 12, fontWeight: 700, cursor: 'pointer',
                    }}
                  >
                    Max
                  </button>
                )}
              </div>
            ) : (
              <AmountKeypad
                open={showAmountPad}
                value={amountIn}
                onChange={v => { setAmountIn(v); setEstimate(null) }}
                balance={inBalance}
                token={tokenIn.id}
                quickAmounts={[10, 20, 50, 100]}
                onClose={() => setShowAmountPad(false)}
                onDone={() => setShowAmountPad(false)}
                // Arc's native gas token is USDC, so a USDC→X swap pays gas
                // out of the same balance being swapped — hold back enough
                // to cover it so the swap tx doesn't fail for lack of gas.
                // Other tokenIn options aren't the native gas token, so Max
                // fills in the full balance. Same `gasNeeded` figure the
                // pre-flight check and warning banner below already use.
                feeReserve={tokenIn.id === 'USDC' ? gasNeeded : 0}
              />
            )}
          </div>

          {/* Simple divider + centered flip button */}
          <div className="relative flex items-center" style={{ margin: '0 16px' }}>
            <div className="flex-1" style={{ height: 1, background: 'var(--border)' }}/>
            <button onClick={flip}
              className="active:scale-90 transition-transform flex-shrink-0"
              style={{
                width: 40, height: 40, borderRadius: '50%', margin: '0 -1px',
                background: 'var(--surface)', border: '1px solid var(--border)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
              <ArrowUpDown className="w-4 h-4" style={{ color: 'var(--brand)' }}/>
            </button>
            <div className="flex-1" style={{ height: 1, background: 'var(--border)' }}/>
          </div>

          {/* Receive section */}
          <div className="p-4 space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-sm text-text-secondary">You receive</p>
              <div className="px-3 py-1.5 rounded-full" style={{ background:'color-mix(in srgb, var(--text-primary) 6%, transparent)' }}>
                <span className="text-xs font-medium text-text-secondary">Balance: {fmtBal(tokenOut.id, outBalance)}</span>
              </div>
            </div>
            <div className="flex items-center justify-between gap-3">
              <button onClick={() => setPickerFor('out')}
                className="flex items-center gap-2.5 active:opacity-70 transition-opacity flex-shrink-0">
                <TLogo t={tokenOut} size={36}/>
                <div className="text-left">
                  <div className="flex items-center gap-1">
                    <span className="text-lg font-bold text-text-primary">{tokenOut.id}</span>
                    <ChevronDown className="w-4 h-4 text-text-secondary"/>
                  </div>
                  <p className="text-xs text-text-secondary">{tokenOut.sub}</p>
                </div>
              </button>
              <div className="min-w-0 text-right">
                {(step === 'estimating' || liveQuoteLoading)
                  ? <div className="flex justify-end"><RefreshCw className="w-5 h-5 text-[var(--brand)] animate-spin"/></div>
                  : estimate
                  ? <>
                      <p className="font-bold text-text-primary" style={{ fontSize: estimate.estimatedOutput.amount.length > 8 ? '26px' : '34px', lineHeight: 1 }}>
                        {trimTrailingZeros(parseFloat(estimate.estimatedOutput.amount).toFixed(swapTokenDecimals(tokenOut.id)))}
                      </p>
                      <p style={{ fontSize: 14, color: 'var(--text-secondary)', marginTop: 4 }}>
                        ${formatAmount(parseFloat(estimate.estimatedOutput.amount))}
                      </p>
                    </>
                  : <p className="text-text-muted font-bold" style={{ fontSize:'34px' }}>0</p>
                }
              </div>
            </div>
          </div>
        </div>
        )}

        {/* Rate card — separate from the pay/receive card, matching reference */}
        {isActive && estimate && (
          <div className="rounded-2xl px-4 py-3.5 flex items-center justify-between"
            style={{ background:'var(--surface)', border:'1px solid color-mix(in srgb, var(--text-primary) 7%, transparent)' }}>
            <span className="text-sm font-bold text-text-primary">Rate</span>
            <div className="flex items-center gap-1.5">
              <span className="text-sm text-text-secondary">
                1 {tokenIn.id} ≈ {trimTrailingZeros((parseFloat(estimate.estimatedOutput.amount)/parseFloat(amountIn)).toFixed(
                  tokenOut.id === 'cirBTC' ? 8 : 4
                ))} {tokenOut.id}
              </span>
              <RefreshCw className="w-3.5 h-3.5 text-text-secondary"/>
            </div>
          </div>
        )}

        {/* Error */}
        {error && !['confirming','swapping'].includes(step) && (
          <div className="rounded-2xl p-3.5 space-y-1.5"
            style={{ background: 'color-mix(in srgb, var(--danger) 6%, transparent)', border: '1px solid color-mix(in srgb, var(--danger) 20%, transparent)' }}>
            {/* BUG FIX: a raw error message can be one long, space-free
                string (e.g. a hex revert payload) with no natural word
                boundaries -- without wordBreak this overflowed straight
                past the box edge on both mobile and desktop instead of
                wrapping. */}
            <p className="text-sm font-semibold text-danger" style={{ wordBreak: 'break-word', overflowWrap: 'break-word' }}>{error}</p>
            {(error.toLowerCase().includes('route') || error.toLowerCase().includes('liquidity') || error.toLowerCase().includes('testnet')) && (
              <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                Arc Testnet pool liquidity is shared and can run low. Try a smaller amount, wait a minute, or check back later.
              </p>
            )}
          </div>
        )}

        {/* Pre-flight balance/gas warning — same figures canReview checks,
            surfaced here so a disabled Swap button isn't a mystery. Uses
            only the static gas-reserve fallback (gasNeeded), since no live
            quote is fetched until Swap is actually tapped. */}
        {step === 'idle' && !error && parseFloat(amountIn || '0') > 0 && (
          parseFloat(amountIn) > inBalance ? (
            <div className="rounded-2xl p-3.5" style={{ background: 'color-mix(in srgb, var(--danger) 6%, transparent)', border: '1px solid color-mix(in srgb, var(--danger) 20%, transparent)' }}>
              <p className="text-sm font-semibold text-danger">Insufficient {tokenIn.id} balance</p>
            </div>
          ) : gasShortfall > 0 ? (
            <div className="rounded-2xl p-3.5" style={{ background: 'color-mix(in srgb, var(--warning) 8%, transparent)', border: '1px solid color-mix(in srgb, var(--warning) 30%, transparent)' }}>
              <p className="text-xs" style={{ color: 'var(--warning)' }}>
                Insufficient USDC to cover network gas. This swap needs ~{trimTrailingZeros(gasNeeded.toFixed(4))} USDC for gas, but only {trimTrailingZeros(usdcAfterSwap.toFixed(4))} USDC would be left.
              </p>
            </div>
          ) : null
        )}

        {/* Confirm sheet — also hosts the progress checklist once the passcode is
            entered, so "Review Swap" stays the one screen from confirm through
            completion instead of jumping to a separate swapping screen. */}
        <AnimatePresence>
        {(step === 'confirming' || step === 'swapping') && (
          <motion.div key="conf" initial={{ opacity:0, y:8 }} animate={{ opacity:1, y:0 }}
            className="space-y-3" style={{ position: 'relative', overflow: 'hidden', borderRadius: 24, padding: 2 }}>

            <p className="text-center text-sm font-bold text-text-primary" style={{ position: 'relative' }}>
              {step === 'swapping' ? 'Swapping…' : 'Review Swap'}
            </p>

            {/* Quote-changed notice — shown briefly when the background poll
                that keeps this screen's quote fresh (while Review is open,
                before the passcode sheet) detects the fee/rate moved. The
                numbers above already reflect the new quote; this is just a
                heads-up why. Auto-clears on its own. */}
            {quoteChangedNotice && step === 'confirming' && (
              <div className="rounded-xl px-3.5 py-2.5 text-xs font-medium text-center" style={{ position: 'relative', background:'color-mix(in srgb, var(--warning) 12%, transparent)', border:'1px solid color-mix(in srgb, var(--warning) 30%, transparent)', color:'var(--warning)' }}>
                {quoteChangedNotice}
              </div>
            )}

            {/* Glass exchange card */}
            <div className="rounded-2xl p-5" style={{
              position: 'relative',
              background: 'color-mix(in srgb, var(--text-primary) 5%, transparent)', backdropFilter: 'blur(20px)',
              border: '1px solid color-mix(in srgb, var(--brand) 35%, transparent)',
            }}>
              <div className="flex items-center justify-between">
                <div className="text-center">
                  <div className="w-11 h-11 rounded-2xl mx-auto mb-2 flex items-center justify-center"
                    style={{ background: 'color-mix(in srgb, var(--brand) 18%, transparent)', border: '1px solid color-mix(in srgb, var(--brand) 40%, transparent)' }}>
                    <TLogo t={tokenIn} size={26}/>
                  </div>
                  <p className="text-lg font-extrabold text-text-primary leading-none">
                    {trimTrailingZeros(parseFloat(amountIn).toFixed(swapTokenDecimals(tokenIn.id)))}
                  </p>
                  <p className="text-xs mt-1" style={{ color: 'var(--text-secondary)' }}>{tokenIn.id}</p>
                </div>

                <div className="w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0"
                  style={{ background: 'color-mix(in srgb, var(--brand) 15%, transparent)', border: '1px solid color-mix(in srgb, var(--brand) 35%, transparent)' }}>
                  {step === 'swapping'
                    ? <ArrowUpDown className="w-4 h-4 text-[var(--brand)] animate-pulse"/>
                    : <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--brand)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>
                  }
                </div>

                <div className="text-center">
                  <div className="w-11 h-11 rounded-2xl mx-auto mb-2 flex items-center justify-center"
                    style={{ background: 'color-mix(in srgb, var(--brand) 18%, transparent)', border: '1px solid color-mix(in srgb, var(--brand) 40%, transparent)' }}>
                    <TLogo t={tokenOut} size={26}/>
                  </div>
                  <p className="text-lg font-extrabold leading-none" style={{ color: 'var(--text-primary)' }}>
                    ~{trimTrailingZeros(parseFloat(estimate?.estimatedOutput?.amount ?? '0').toFixed(swapTokenDecimals(tokenOut.id)))}
                  </p>
                  <p className="text-xs mt-1" style={{ color: 'var(--text-secondary)' }}>{tokenOut.id}</p>
                </div>
              </div>

              {step === 'confirming' ? (
                /* Glass summary */
                <div className="rounded-2xl mt-4 px-4 py-3" style={{ background: 'color-mix(in srgb, var(--text-primary) 3%, transparent)', border: '1px solid color-mix(in srgb, var(--text-primary) 6%, transparent)' }}>
                  {[
                    ['Rate', `1 ${tokenIn.id} ≈ ${estimate ? trimTrailingZeros((parseFloat(estimate.estimatedOutput.amount)/parseFloat(amountIn)).toFixed(tokenOut.id === 'cirBTC' ? 8 : 4)) : '—'} ${tokenOut.id}`],
                    ['Slippage', `${slippage/100}%`],
                    ['Fee', `~$${formatAmount(totalFees)}`],
                  ].map(([l, v]) => (
                    <div key={l as string} className="flex justify-between items-center" style={{ padding: '5px 0' }}>
                      <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>{l}</span>
                      <span className="text-xs font-semibold text-text-primary">{v}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-center mt-4" style={{ color: 'var(--text-secondary)' }}>Keep this page open · 15–30 sec</p>
              )}
            </div>

            {step === 'confirming' && gasShortfall > 0 && (
              // Same shortfall the Max button and the passcode-time check
              // use — surfaced here too, before the passcode sheet even
              // opens, since a EURC/cirBTC→USDC swap still needs native
              // USDC left for gas and that's easy to miss if you're only
              // watching the EURC/cirBTC balance.
              <div className="rounded-2xl px-4 py-3 flex items-start gap-2.5" style={{ position: 'relative', background: 'color-mix(in srgb, var(--warning) 8%, transparent)', border: '1px solid color-mix(in srgb, var(--warning) 30%, transparent)' }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--warning)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, marginTop: 1 }}>
                  <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
                </svg>
                <p className="text-xs" style={{ color: 'var(--warning)' }}>
                  Insufficient USDC to cover network gas. This swap needs ~{trimTrailingZeros(gasNeeded.toFixed(4))} USDC for gas, but only {trimTrailingZeros(usdcAfterSwap.toFixed(4))} USDC would be left.
                </p>
              </div>
            )}

            {step === 'confirming' ? (
              /* Back / Swap */
              <div className="flex gap-2.5 pt-1" style={{ position: 'relative' }}>
                <button onClick={() => { setStep('idle'); setError(''); setQuoteChangedNotice('') }}
                  className="flex-1 py-3.5 rounded-2xl text-sm font-bold active:scale-[0.98] transition-transform"
                  style={{ background:'color-mix(in srgb, var(--text-primary) 5%, transparent)', border:'1px solid var(--border)', color:'var(--text-secondary)' }}>
                  Back
                </button>
                <button onClick={() => { setQuoteChangedNotice(''); setPassEntry(''); setPassError(''); setShowPasscodeSheet(true) }}
                  disabled={gasShortfall > 0 || !estimate}
                  className="flex-1 py-3.5 rounded-2xl text-sm font-bold text-white active:scale-[0.98] transition-transform disabled:opacity-40 disabled:active:scale-100"
                  style={{ background:'var(--brand)', border: '1px solid color-mix(in srgb, black 12%, transparent)', boxShadow: (gasShortfall > 0 || !estimate) ? 'none' : 'var(--shadow-2)' }}>
                  Confirm Swap
                </button>
              </div>
            ) : (
              /* Progress checklist — shown in place of the buttons once the
                 passcode has been confirmed and the swap is executing */
              <>
                <p className="text-xs font-semibold px-1" style={{ color:'var(--text-secondary)', letterSpacing:'0.06em', textTransform:'uppercase', position: 'relative' }}>Progress</p>
                <SwapChecklist step={step} error={error} txHash={txHash} tokenIn={tokenIn.id}/>
              </>
            )}
          </motion.div>
        )}
        </AnimatePresence>

        {/* ─── Full-screen success takeover — identical mechanic to
            PaySendPage's completed-payment screen: the whole screen flashes
            brand color with a big checkmark + "Swapped Successfully",
            holds briefly, then that panel shrinks away while the
            traveling checkmark bridges into the detailed hero card that
            fades in underneath. ─────────────────────────────────────── */}
        {step === 'done' && successPhase === 'flash' && createPortal(
          // Portalled straight to <body> — same reason as TravelingCheckmark
          // and Toast.tsx's earlier off-center fix: PageTransition's
          // motion.div (wraps every route, desktop included) leaves a
          // non-`none` `transform` on itself from animating `y`, which makes
          // IT the containing block for any `position: fixed` descendant
          // instead of the real viewport. On mobile that ancestor happens to
          // exactly fill the screen so the bug is invisible; on desktop this
          // page also sits inside its own extra scrollable 65%-width column
          // (see the 2-column split below), so this overlay was rendering
          // sized/positioned to that scrolled, non-viewport box — often
          // pushed off-screen entirely, which is what read as the swap
          // "getting stuck" on the processing screen and never reaching
          // success (the state had already moved to 'done'; the takeover
          // confirming it just wasn't visible).
          <div style={{
            position: 'fixed',
            ...(isDesktop && flashColumnRect
              ? { top: flashColumnRect.top, left: flashColumnRect.left, width: flashColumnRect.width, height: flashColumnRect.height, borderRadius: 20 }
              : { inset: 0 }),
            zIndex: 999, background: 'var(--brand)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
          }}>
            <motion.div ref={flashCheckRef} initial={{ scale: 0.5, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ delay: 0.1, type: 'spring', stiffness: 220, damping: 16 }}
              onAnimationComplete={() => setFlashCircleReady(true)}
              className="rounded-full flex items-center justify-center" style={{ width: 82.08, height: 82.08, background: '#fff', marginBottom: 20 }}>
              {paidViaBiometric ? (
                <FlashAuthIcon viaBiometric start={flashCircleReady} size={37.62} color="var(--brand)" />
              ) : (
                <motion.svg width={37.62} height={37.62} viewBox="0 0 24 24" fill="none" stroke="var(--brand)" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round">
                  <motion.polyline points="20 6 9 17 4 12" initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 0.5, delay: 0.25 }} />
                </motion.svg>
              )}
            </motion.div>
            <p style={{ fontSize: 22, fontWeight: 700, color: '#fff', margin: 0 }}>Swapped Successfully</p>
          </div>,
          document.body
        )}

        {travelRect && !travelDone && (
          <TravelingCheckmark from={travelRect.from} to={travelRect.to} />
        )}

        <AnimatePresence>
        {step === 'done' && successPhase === 'collapsed' && (() => {
          const shortHash = txHash ? `${txHash.slice(0, 6)}...${txHash.slice(-4)}` : '—'
          const timeLabel = new Date().toLocaleString('en-US', {
            month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
          })
          const fmtIn  = `${trimTrailingZeros(parseFloat(amountIn).toFixed(swapTokenDecimals(tokenIn.id)))} ${tokenIn.id}`
          const fmtOut = `${trimTrailingZeros(parseFloat(amountOut||'0').toFixed(swapTokenDecimals(tokenOut.id)))} ${tokenOut.id}`
          return (
          <motion.div key="done" initial={{ opacity: 0 }} animate={{ opacity: 1 }} style={{ margin: '-16px -16px 0' }}>
            {/* Hidden SVG def: smooth elliptical-arc clip path for the hero's
                scalloped bottom border — same curve PaySendPage's own hero
                card uses. */}
            <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true">
              <defs>
                <clipPath id="swapHeroBottomClip" clipPathUnits="objectBoundingBox">
                  <path d="M0,0 L1,0 L1,0.75 L0.826,0.75 C0.805,0.75 0.805,0.859 0.755,0.859 L0.245,0.859 C0.195,0.859 0.195,0.75 0.174,0.75 L0,0.75 Z" />
                </clipPath>
              </defs>
            </svg>

            {/* ─── Hero: back + title, success badge, Completed, amounts, network, completion pill ─── */}
            <div style={{
              display: 'flex', flexDirection: 'column', alignItems: 'center',
              background: 'var(--brand)',
              paddingTop: 'calc(env(safe-area-inset-top, 0px) + clamp(10.8px, 2.25vh, 18px))', paddingBottom: 'clamp(33.3px, 6.03vh, 46.8px)',
              paddingLeft: 'clamp(11.7px, 3.33vw, 14.4px)', paddingRight: 'clamp(11.7px, 3.33vw, 14.4px)',
              clipPath: 'url(#swapHeroBottomClip)',
            }}>
              <div style={{ display: 'grid', gridTemplateColumns: '40px 1fr 40px', alignItems: 'center', width: '100%', marginBottom: 'clamp(4px, 1.3vh, 13px)' }}>
                <button onClick={() => navigate('/')} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4, color: '#FFFFFF', display: 'flex', justifySelf: 'start' }}>
                  <ArrowLeft style={{ width: 24, height: 24 }} />
                </button>
                <h1 style={{ fontSize: 'clamp(15px, 4.6vw, 21px)', fontWeight: 700, color: '#FFFFFF', textAlign: 'center', margin: 0 }}>Swap Successful!</h1>
                <span />
              </div>

              <div ref={heroCheckRef} style={{ position: 'relative', width: 'clamp(55px, 14.5vw, 67px)', height: 'clamp(55px, 14.5vw, 67px)', borderRadius: '50%', background: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, margin: 'clamp(4px, 0.9vh, 8px) 0', opacity: travelDone ? 1 : 0 }}>
                <SwapSparkle size={11} style={{ top: '4%', left: '-40%' }} />
                <SwapSparkle size={6.6} style={{ top: '70%', left: '-32%' }} />
                <SwapSparkle size={11} style={{ top: '2%', right: '-42%' }} />
                <SwapSparkle size={6.6} style={{ top: '68%', right: '-30%' }} />
                {paidViaBiometric && travelDone ? (
                  // Mounted fresh here (not earlier, just hidden) so its
                  // internal toggle timer starts exactly when this becomes
                  // visible — same reasoning as PaySendPage's landing icon.
                  <FlashAuthIcon key="landing-toggle" viaBiometric loop size={28} color="var(--brand)" />
                ) : (
                  <svg viewBox="0 0 24 24" width="46%" height="46%" fill="none" stroke="var(--brand)" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                )}
              </div>

              <motion.div initial={false} animate={travelDone ? { opacity: 1, y: 0 } : { opacity: 0, y: -14 }} transition={{ duration: 0.4, delay: travelDone ? 0.1 : 0, ease: [0.2, 0.8, 0.2, 1] }}
                style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 'clamp(5.4px, 1.08vh, 10.8px)', paddingBottom: 'clamp(5.4px, 1.08vh, 10.8px)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6.3, color: 'rgba(255,255,255,0.92)' }}>
                  <ArrowUpDown style={{ width: 16.2, height: 16.2 }} />
                  <span style={{ fontSize: 'clamp(11.7px, 3.33vw, 13.5px)', fontWeight: 600 }}>Completed</span>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: 'clamp(9px, 2.7vw, 14.4px)', marginTop: 'clamp(7.2px, 1.44vh, 12.6px)' }}>
                  <p style={{ fontSize: 'clamp(19.8px, 5.85vw, 27px)', fontWeight: 800, color: '#FFFFFF', margin: 0, lineHeight: 1 }}>{fmtIn}</p>
                </div>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.75)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" style={{ margin: 'clamp(3.6px,0.72vh,7.2px) 0' }}>
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <polyline points="19 12 12 19 5 12" />
                </svg>
                <p style={{ fontSize: 'clamp(19.8px, 5.85vw, 27px)', fontWeight: 800, color: '#FFFFFF', margin: 0, lineHeight: 1 }}>{fmtOut}</p>

                <p style={{ fontSize: 'clamp(10.8px, 3.06vw, 13.05px)', color: 'rgba(255,255,255,0.75)', margin: 'clamp(5.4px,1.08vh,10.8px) 0 0' }}>on Arc Testnet</p>

                <div style={{ display: 'flex', alignItems: 'center', gap: 5.4, background: 'rgba(255,255,255,0.14)', padding: 'clamp(4.28px,0.94vh,5.13px) clamp(7.83px,2.12vw,10.17px)', borderRadius: 999, marginTop: 'clamp(9px,1.8vh,14.4px)' }}>
                  <Zap style={{ width: 12.6, height: 12.6, color: '#FFD54A' }} fill="#FFD54A" />
                  <span style={{ fontSize: 'clamp(8.1px, 2.25vw, 9.9px)', fontWeight: 600, color: '#FFFFFF' }}>Completed in {swapElapsedSeconds} Seconds</span>
                </div>
              </motion.div>
            </div>

            {/* ─── Transaction details card ─── */}
            <motion.div initial={false} animate={travelDone ? { opacity: 1, y: 0 } : { opacity: 0, y: -14 }} transition={{ duration: 0.4, delay: travelDone ? 0.2 : 0, ease: [0.2, 0.8, 0.2, 1] }}
              style={{ paddingLeft: 'clamp(14.4px, 4.05vw, 18px)', paddingRight: 'clamp(14.4px, 4.05vw, 18px)', marginTop: 'calc(-1 * clamp(33.3px, 6.03vh, 46.8px) + 18px)' }}>
              {/* ─── Transaction details card followed by success actions.
                  "More details" expands the card naturally; actions
                  remain in normal document flow below it. ─── */}
              <div className="shadow-elevation-1" style={{
                background: 'var(--surface)', border: '1px solid var(--border)',
                borderTopLeftRadius: 'clamp(16.2px, 4.05vw, 19.8px)', borderTopRightRadius: 'clamp(16.2px, 4.05vw, 19.8px)',
                borderBottomLeftRadius: 'clamp(14.4px, 3.6vw, 18px)', borderBottomRightRadius: 'clamp(14.4px, 3.6vw, 18px)',
                padding: '0 clamp(14.4px, 3.6vw, 18px)', marginBottom: 'clamp(16.2px, 3.06vh, 23.4px)',
              }}>
                <SwapDetailRow icon={<FileText className="w-4 h-4" />} label="You Paid" value={fmtIn} showDivider />
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 9, paddingTop: 'clamp(8.1px, 1.71vh, 10.8px)', paddingBottom: 'clamp(8.1px, 1.71vh, 10.8px)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 'clamp(9px, 2.34vw, 11.7px)', minWidth: 0 }}>
                    <div style={{ width: 'clamp(28.8px, 7.65vw, 34.2px)', height: 'clamp(28.8px, 7.65vw, 34.2px)', borderRadius: '50%', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'color-mix(in srgb, var(--text-primary) 6%, transparent)', color: 'var(--brand)' }}>
                      <ArrowUpDown className="w-4 h-4" />
                    </div>
                    <span style={{ fontSize: 'clamp(12.6px, 3.24vw, 14.4px)', color: 'var(--text-secondary)' }}>You Received</span>
                  </div>
                  <span style={{ fontSize: 'clamp(12px, 3.08vw, 13.7px)', fontWeight: 700, color: 'var(--success)' }}>{fmtOut}</span>
                </div>
                <div style={{ height: 1, background: 'var(--border)' }} />
                <SwapDetailRow icon={<FileText className="w-4 h-4" />} label="Transaction Hash" value={shortHash} mono onCopy={txHash ? copySwapHash : undefined} copied={hashCopied} showDivider />
                <SwapDetailRow icon={<Clock className="w-4 h-4" />} label="Time" value={timeLabel} showDivider last />

                {/* Expandable "Process" checklist — total fee charged
                    (shown here rather than as an always-visible row) plus
                    the swap progress checklist (approve → execute →
                    confirm), shown as three already-completed steps. */}
                <AnimatePresence initial={false}>
                  {showProcessDetails && (
                    <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.3, ease: [0.4, 0, 0.2, 1] }} style={{ overflow: 'hidden' }}>
                      <div style={{ borderTop: '1px solid var(--border)' }}>
                        <SwapDetailRow icon={<Receipt className="w-4 h-4" />} label="Total Fees" value={`~$${formatAmount(totalFees)}`} />
                      </div>
                      <div style={{ paddingTop: 'clamp(11.7px, 2.565vh, 16.2px)', paddingBottom: 'clamp(10.5px, 2.31vh, 14.6px)', borderTop: '1px solid var(--border)' }}>
                        <p style={{ fontSize: 'clamp(10.8px, 2.88vw, 11.7px)', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: 0.4, margin: '0 0 clamp(9px, 1.98vh, 12.6px)' }}>Process</p>
                        <SwapProcessStep text={<>Approving <strong>{tokenIn.id}</strong> spend</>} />
                        <SwapProcessStep text="Swap executed on Arc" />
                        <SwapProcessStep text={<>Confirmed — <strong>{tokenOut.id}</strong> received in wallet</>} last />
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>

                <button onClick={() => setShowProcessDetails(v => !v)}
                  style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5.4, background: 'none', border: 'none', cursor: 'pointer', padding: 'clamp(9px, 1.98vh, 11.7px) 0', borderTop: showProcessDetails ? '1px solid var(--border)' : 'none' }}>
                  <span style={{ fontSize: 'clamp(11.7px, 3.06vw, 12.6px)', fontWeight: 600, color: 'var(--text-primary)' }}>{showProcessDetails ? 'Hide details' : 'More details'}</span>
                  <ChevronDown className="w-3.5 h-3.5" style={{ color: 'var(--text-secondary)', transform: showProcessDetails ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s ease' }} />
                </button>
              </div>

              {/* ─── Success actions + explorer links ─── */}
              <div style={{ position: 'relative', background: 'var(--bg)', paddingBottom: 'calc(env(safe-area-inset-bottom, 12px) + clamp(12px, 2.5vh, 20px))' }}>
                <div style={{ display: 'flex', justifyContent: 'center', gap: 'clamp(43.2px, 15.3vw, 72px)', paddingTop: 'clamp(16.2px, 3.06vh, 23.4px)', marginBottom: 'clamp(16.2px, 3.06vh, 23.4px)' }}>
                  {txHash && (
                    <a href={`https://testnet.arcscan.app/tx/${txHash}`} target="_blank" rel="noopener noreferrer"
                      style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 7.2, textDecoration: 'none' }}>
                      <span style={{ width: 'clamp(43.2px, 11.7vw, 50.4px)', height: 'clamp(43.2px, 11.7vw, 50.4px)', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--brand)' }}>
                        <ExternalLink className="w-4 h-4" />
                      </span>
                      <span style={{ fontSize: 'clamp(10.8px, 2.88vw, 11.7px)', color: 'var(--text-primary)', textAlign: 'center', lineHeight: 1.35 }}>View on<br />Arc Explorer</span>
                    </a>
                  )}
                  <button onClick={() => navigate('/activity')} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 7.2, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
                    <span style={{ width: 'clamp(43.2px, 11.7vw, 50.4px)', height: 'clamp(43.2px, 11.7vw, 50.4px)', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--brand)' }}>
                      <ActivityIcon className="w-4 h-4" />
                    </span>
                    <span style={{ fontSize: 'clamp(10.8px, 2.88vw, 11.7px)', color: 'var(--text-primary)', textAlign: 'center', lineHeight: 1.35 }}>View<br />Activity</span>
                  </button>
                </div>

                <div style={{ display: 'flex', gap: 'clamp(9px, 2.7vw, 12.6px)', width: '100%', maxWidth: isDesktop ? 560 : 'none', margin: '0 auto', boxSizing: 'border-box' }}>
                  <button onClick={() => { reset(); setShowProcessDetails(false) }}
                    style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7.2, height: 'clamp(43.2px, 11.7vw, 50.4px)', borderRadius: 14.4, border: '1.5px solid var(--brand)', background: 'transparent', color: 'var(--brand)', fontSize: 'clamp(12.6px, 3.24vw, 13.5px)', fontWeight: 700, cursor: 'pointer' }}>
                    <RotateCcw className="w-3.5 h-3.5" /> Swap Again
                  </button>
                  <button onClick={() => navigate('/')}
                    style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7.2, height: 'clamp(43.2px, 11.7vw, 50.4px)', borderRadius: 14.4, border: '1px solid color-mix(in srgb, black 12%, transparent)', background: 'var(--brand)', color: '#FFFFFF', fontSize: 'clamp(12.6px, 3.24vw, 13.5px)', fontWeight: 700, cursor: 'pointer' }}>
                    <Home className="w-3.5 h-3.5" /> Back to Home
                  </button>
                </div>
              </div>
            </motion.div>
          </motion.div>
          )
        })()}
        </AnimatePresence>

        {/* Failed */}
        <AnimatePresence>
        {step === 'failed' && (
          <div style={{ margin: '0 -20px' }}>
            <TransactionComplete
              status="failed"
              title={isUncertainFailure ? "Couldn't Confirm Swap" : 'Swap Failed'}
              subtitle={isUncertainFailure
                ? "We couldn't confirm this finished, but it may have already gone through."
                : (error || 'Something went wrong')}
              rows={[
                { label: 'From',    value: `${trimTrailingZeros(parseFloat(amountIn).toFixed(swapTokenDecimals(tokenIn.id)))} ${tokenIn.id}` },
                { label: 'To',      value: tokenOut.id },
                { label: 'Reason',  value: isUncertainFailure ? 'Could not confirm result'
                    : error?.includes('route') || error?.includes('liquidity') ? 'No liquidity on Arc Testnet' : 'Transaction failed', color: 'var(--danger)' },
                ...(isUncertainFailure
                  ? [{ label: 'Before retrying', value: 'Check your balance or Activity first', color: 'var(--warning)' }]
                  : error?.toLowerCase().includes('route') || error?.toLowerCase().includes('liquidity')
                  ? [{ label: 'Fix', value: 'Try smaller amount or wait a few minutes', color: 'var(--warning)' }]
                  : []),
              ]}
              primaryLabel={isUncertainFailure ? 'Check Activity' : 'Try Again'}
              primaryAction={isUncertainFailure ? () => navigate('/activity') : () => { setStep('idle'); setError('') }}
              secondaryLabel={isUncertainFailure ? 'Try Again Anyway' : 'Back to Home'}
              secondaryAction={isUncertainFailure ? () => { setStep('idle'); setError(''); setIsUncertainFailure(false) } : () => navigate('/')}
            />
          </div>
        )}
        </AnimatePresence>

        {/* CTA */}
        {isActive && (
          <motion.button whileTap={{ scale:.98 }}
            onClick={() => { setPassEntry(''); setPassError(''); handleReview() }}
            disabled={!canReview}
            className="w-full py-4 rounded-2xl text-base font-bold text-white disabled:opacity-35 transition-opacity"
            style={{ background:'var(--brand)', border: '1px solid color-mix(in srgb, black 12%, transparent)', boxShadow: canReview ? 'var(--shadow-2)' : 'none' }}>
            {(step === 'estimating' || liveQuoteLoading) ? 'Getting quote...' : `Swap ${tokenIn.id} → ${tokenOut.id}`}
          </motion.button>
        )}

        {/* ── Swap History ──────────────────────────────────────────────── */}
        {/* Desktop shows this in the always-visible right column instead
            (see the 2-column split below) — !isDesktop here just prevents
            it from ALSO rendering inline in the left column there. Mobile
            behavior (isActive-gated) is completely unchanged. */}
        {isActive && !isDesktop && (
          <div className="space-y-3 pt-2">
            <div className="flex items-center justify-between px-1">
              <div className="flex items-center gap-2">
                <Clock className="w-4 h-4 text-text-secondary"/>
                <p className="text-sm font-semibold text-text-secondary">Recent Swaps</p>
              </div>

            </div>

            {history.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-10 gap-3 rounded-2xl"
                style={{ background:'color-mix(in srgb, var(--text-primary) 2%, transparent)', border:'1px solid color-mix(in srgb, var(--text-primary) 5%, transparent)' }}>
                <div className="w-12 h-12 rounded-2xl flex items-center justify-center"
                  style={{ background:'color-mix(in srgb, var(--text-primary) 4%, transparent)' }}>
                  <ArrowUpDown className="w-6 h-6 text-text-muted"/>
                </div>
                <p className="text-sm font-semibold text-text-secondary">No swaps yet</p>
                <p className="text-xs text-text-muted text-center px-8">Your completed swaps will appear here</p>
              </div>
            ) : (
              <div className="rounded-2xl overflow-hidden" style={{ background:'var(--surface)', border:'1px solid var(--border)' }}>
                {(showAllHistory ? history : history.slice(0, 5)).map((r, i) => (
                  <SwapHistoryItem key={(r as any).id} r={r as any} onOpen={() => setHistDetail(r)} isFirst={i === 0}/>
                ))}
                {history.length > 5 && (
                  <button
                    onClick={() => setShowAllHistory(v => !v)}
                    className="w-full text-xs text-center text-text-secondary py-2.5 active:opacity-70 transition-opacity"
                    style={{borderTop: '1px solid color-mix(in srgb, var(--text-primary) 5%, transparent)'}}>
                    {showAllHistory ? 'Show less' : `+${history.length - 5} more · show all`}
                  </button>
                )}
              </div>
            )}
          </div>
        )}

      </div>
      </div>

      {/* Passcode sheet/dialog — opens on Swap tap, same page, no navigation */}
      <AnimatePresence>
      {showPasscodeSheet && (() => {
        const closeSheet = () => { setShowPasscodeSheet(false); setPassEntry(''); setPassError('') }
        // Keypad/confirm content only — title + amount summary (and the
        // error message, which replaces the subtitle on mobile but needs
        // its own line on desktop since desktop's subLabel is fixed to the
        // swap summary) are handled by each branch's own chrome below.
        const keypadContent = (
          <>
            {storedPasscode ? (
              <PinKeypad
                value={passEntry}
                onChange={v => { setPassEntry(v); setPassError('') }}
                length={6}
                error={!!passError}
                shake={!!passError}
                accentFrom="var(--brand)"
                accentTo="var(--brand)"
                onComplete={(_, viaBiometric) => { setPaidViaBiometric(!!viaBiometric); handleConfirm() }}
              />
            ) : (
              <button onClick={() => handleConfirm()}
                className="w-full py-4 rounded-2xl text-base font-bold text-white active:scale-[0.98] transition-transform"
                style={{ background:'var(--brand)', border: '1px solid color-mix(in srgb, black 12%, transparent)' }}>
                Confirm Swap
              </button>
            )}
          </>
        )

        return isDesktop ? (
          <DesktopTransactionAuthDialog
            onClose={closeSheet}
            title={storedPasscode ? 'Authorize Swap' : 'Confirm Swap'}
            amountLabel={`${trimTrailingZeros(parseFloat(amountIn || '0').toFixed(swapTokenDecimals(tokenIn.id)))} ${tokenIn.id}`}
            subLabel={`For ~${trimTrailingZeros(parseFloat(estimate?.estimatedOutput?.amount ?? '0').toFixed(swapTokenDecimals(tokenOut.id)))} ${tokenOut.id}`}
          >
            {passError && <p className="text-xs text-center mb-4" style={{ color: 'var(--danger)' }}>{passError}</p>}
            {keypadContent}
          </DesktopTransactionAuthDialog>
        ) : (
          <>
            <motion.div key="pass-backdrop"
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="absolute inset-0 z-40"
              style={{ background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(2px)' }}
              onClick={closeSheet}/>
            <motion.div key="pass-sheet"
              initial={{ y: '100%' }} animate={{ y: 0 }} exit={{ y: '100%' }}
              transition={{ type: 'spring', damping: 32, stiffness: 320 }}
              className="absolute bottom-0 left-0 right-0 z-50 rounded-t-3xl pt-3 pb-10 px-6"
              style={{ background: 'var(--surface)', borderTop: '1px solid color-mix(in srgb, var(--brand) 18%, transparent)' }}>
              <div className="w-10 h-1 rounded-full mx-auto mb-6" style={{ background: 'color-mix(in srgb, var(--text-primary) 18%, transparent)' }}/>
              <div className="text-center mb-7">
                <h2 className="text-lg font-bold text-text-primary">
                  {storedPasscode ? 'Enter Passcode' : 'Confirm Swap'}
                </h2>
                <p className="text-xs mt-1.5" style={{ color: 'var(--text-secondary)' }}>
                  {passError
                    ? <span className="text-danger">{passError}</span>
                    : <>Swap {trimTrailingZeros(parseFloat(amountIn || '0').toFixed(swapTokenDecimals(tokenIn.id)))} {tokenIn.id} for ~{trimTrailingZeros(parseFloat(estimate?.estimatedOutput?.amount ?? '0').toFixed(swapTokenDecimals(tokenOut.id)))} {tokenOut.id}</>}
                </p>
              </div>
              {keypadContent}
            </motion.div>
          </>
        )
      })()}
      </AnimatePresence>

      {/* Token picker modal */}
      <AnimatePresence>
      {pickerFor && (
        <TokenPicker
          selected={pickerFor === 'in' ? tokenIn : tokenOut}
          exclude={pickerFor === 'in' ? tokenOut : tokenIn}
          balances={tokenBals}
          onSelect={t => {
            if (pickerFor === 'in') { setTokenIn(t); setAmountIn(''); setEstimate(null) }
            else { setTokenOut(t); setEstimate(null) }
          }}
          onClose={() => setPickerFor(null)}
        />
      )}
      </AnimatePresence>

      {/* History detail modal */}
      <AnimatePresence>
      {histDetail && (
        <HistoryDetail r={histDetail} onClose={() => setHistDetail(null)}/>
      )}
      </AnimatePresence>
    </div>
  )

  if (!isDesktop) return flow

  // ── Desktop: flow (left) + Swap History (right), independently scrollable ──
  // Reuses the exact same `history` state/fetch and `SwapHistoryItem` row
  // component the mobile inline list already uses — just always visible
  // here (not gated to the idle/estimating step) and opens the same
  // `HistoryDetail` modal (rendered above, inside `flow`) on tap.
  return (
    // Fills the full available content width (no maxWidth cap — the row
    // stretches edge to edge minus the outer padding) at a fixed 65/35
    // grow split, per explicit sizing direction. Bottom padding trimmed
    // so the row — and DesktopHistoryPanel's own height:100% column
    // inside it — reaches down close to the viewport's bottom edge
    // instead of leaving a gap under it.
    <div style={{ display: 'flex', height: '100%', minHeight: 0, gap: 28, padding: '20px 24px 14px', boxSizing: 'border-box' }}>
      <div style={{ flex: '65 1 0%', minWidth: 0, minHeight: 0, overflowY: 'auto' }} ref={desktopColumnRef}>{flow}</div>
      <div style={{ flex: '35 1 0%', minWidth: 0, minHeight: 0 }}>
        <DesktopHistoryPanel title="Recent History" onViewAll={() => navigate('/activity?filter=swap')}>
          {history.length === 0 ? (
            <DesktopHistoryEmpty label="Your completed swaps will appear here" />
          ) : (
            history.map((r, i) => (
              <SwapHistoryItem key={r.id} r={r} onOpen={() => setHistDetail(r)} isFirst={i === 0} />
            ))
          )}
        </DesktopHistoryPanel>
      </div>
    </div>
  )
}
