import { useState, useEffect, useCallback, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { arcExplorerTxUrl } from '@/lib/chainExplorers'
import { Info } from 'lucide-react'
import { useAuthStore } from '@/store'
import {
  fetchUserPoints, claimPointsAsUSDC, fetchClaimsHistory, fetchPointHistory,
  fetchDailyClaimedPoints, getDailyClaimedOnChain, rewardsUserId, REWARD_TASKS, rewardTaskOf, pointsToUSDC, MIN_CLAIM_POINTS, MAX_CLAIM_POINTS, POINTS_PER_TX, MAX_DAILY_POINTS, MAX_DAILY_EARN_POINTS,
} from '@/lib/rewards'
import { timeAgo, formatAmount } from '@/lib/utils'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { ReceiptPopup } from '@/components/ui/ReceiptPopup'
import { AmountField } from '@/components/ui/AmountField'
import { HistoryRow, HistoryIcon } from '@/components/ui/HistoryRow'
import { ActionIcon } from '@/components/ui/ActionIcon'
import { useReturnFlash } from '@/hooks/useReturnFlash'
import { MeshLoader } from '@/components/ui/MeshLoader'
import { P2PSheet } from '@/features/p2p/p2pUi'
import { PopupOpen } from '@/hooks/usePopupOpen'
import { useLeaveGuard } from '@/lib/leaveGuard'

interface ClaimRecord {
  id: string; points_claimed: number; usdc_received: number
  tx_hash: string | null; status: string; created_at: string; claimed_at: string | null
}
interface PointRecord {
  id: string; points: number; reason: string; tx_hash: string | null; created_at: string
}

// Single source of truth for how a reward_claims.status is shown. Only
// 'completed' (USDC really landed) counts as success. 'failed',
// 'treasury_empty', 'pending_contract' etc. never moved money, so they show
// red; 'pending'/'processing' show as in-progress. Unknown values are treated
// as failed, never as success.
type ClaimView = 'success' | 'failed' | 'pending'
// A claim normally settles in seconds. One still 'pending'/'processing' after
// this long was abandoned mid-flow (tab closed, connection lost) and will
// never complete on its own, so it is shown as not completed instead of
// spinning as "Processing…" forever.
const STALE_PENDING_CLAIM_MS = 15 * 60 * 1000
function claimView(status: string | null | undefined, createdAt?: string | null): ClaimView {
  const st = (status || '').toLowerCase()
  if (st === 'completed' || st === 'confirmed' || st === 'success') return 'success'
  if (st === 'pending' || st === 'processing') {
    const t = createdAt ? Date.parse(createdAt) : NaN
    return Number.isFinite(t) && Date.now() - t > STALE_PENDING_CLAIM_MS ? 'failed' : 'pending'
  }
  return 'failed'
}
function claimLabel(v: ClaimView): string {
  return v === 'success' ? 'Reward claimed' : v === 'failed' ? 'Claim failed' : 'Claim processing…'
}
function claimColor(v: ClaimView): string {
  return v === 'success' ? 'var(--success)' : v === 'failed' ? 'var(--danger)' : 'var(--text-secondary)'
}

// The five actions that earn points once a day each (rewards.ts
// REWARD_ACTION_TYPES; the point row's reason is `tx_reward:<type>`).
// The latest 20 of each history here; See all opens Activity → Rewards.
const HISTORY_LIMIT = 20
const TASKS = REWARD_TASKS
const taskOf = rewardTaskOf

// A claimed reward reopened as the receiver's receipt: points in, USDC out
// to this wallet on Arc.
function RewardClaimReceipt({ claim, onClose }: { claim: ClaimRecord; onClose: () => void }) {
  const status = claimView(claim.status, claim.created_at)
  const hash = claim.tx_hash
  const when = new Date(claim.claimed_at || claim.created_at).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })
  return (
    <ReceiptPopup
      onClose={onClose}
      status={status}
      title={status === 'success' ? 'Reward Claimed' : status === 'failed' ? 'Reward Claim Failed' : 'Processing…'}
      subtitle={<>
        <span style={{ display: 'block', fontSize: 20, fontWeight: 800, color: claimColor(status), marginBottom: 4 }}>{status === 'success' ? '+' : ''}${formatAmount(claim.usdc_received)} USDC</span>
        {status === 'success' ? `${claim.points_claimed} points converted to USDC` : status === 'failed' ? 'Claim did not go through - your points were not deducted' : `${claim.points_claimed} points being converted…`}
      </>}
      rows={[
        { label: status === 'success' ? 'Received' : 'Amount', value: `$${formatAmount(claim.usdc_received)} USDC`, positive: status === 'success' },
        { label: 'Points used', value: status === 'success' ? `${claim.points_claimed} pts` : status === 'failed' ? '0 pts (not deducted)' : `${claim.points_claimed} pts` },
        { label: 'From', value: 'MeshPort Rewards', positive: true },
        ...(hash ? [{ label: 'Transaction Hash', value: `${hash.slice(0, 6)}…${hash.slice(-4)}` }] : []),
        { label: 'Time', value: when },
      ]}
      detailRows={[
        { label: 'Status', value: status === 'success' ? 'Confirmed' : status === 'failed' ? 'Failed' : 'Processing', positive: status === 'success' },
        { label: 'Network', value: 'Arc Testnet' },
      ]}
      fullHash={hash || undefined}
      links={hash ? [{ title: 'View on ArcScan', explorer: 'ArcScan', hash, href: arcExplorerTxUrl(hash) }] : undefined}
    />
  )
}

// ── Claim progress: MeshPort's logo while it runs, a check that travels down
// the steps as each REALLY finishes (rewards.ts onStep), then a drawn check.
type StepKey = 'check' | 'approve' | 'send'
const STEPS: { key: StepKey; label: string }[] = [
  { key: 'check', label: 'Checking your points' },
  { key: 'approve', label: 'Approving your reward' },
  { key: 'send', label: 'Sending USDC on Arc' },
]
const STEP_H = 40
const CLAIM_PROGRESS_CSS = `
@keyframes rwOkIn{0%{transform:scale(0)}70%{transform:scale(1.08)}100%{transform:scale(1)}}
@keyframes rwDraw{from{stroke-dashoffset:60}to{stroke-dashoffset:0}}
@keyframes rwFade{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
@keyframes rwTickIn{from{transform:scale(.4);opacity:0}to{transform:scale(1);opacity:1}}
.rw-ok{animation:rwOkIn .45s cubic-bezier(.32,.72,0,1) both}
.rw-ok path{stroke-dasharray:60;stroke-dashoffset:60;animation:rwDraw .45s .25s ease-out forwards}
.rw-fade{animation:rwFade .35s .2s ease-out both}
.rw-tick{animation:rwTickIn .25s ease-out both}
.rw-trav{transition:transform .55s cubic-bezier(.32,.72,0,1)}
@media (prefers-reduced-motion: reduce){.rw-ok,.rw-ok path,.rw-fade,.rw-tick{animation:none;stroke-dashoffset:0}.rw-trav{transition:none}}
`
export interface ClaimProgress {
  points: number; usdc: number
  done: StepKey[]; times: Partial<Record<StepKey, number>>
  phase: 'running' | 'success' | 'failed'
  error?: string; txHash?: string | null; usdcReceived?: number
}

/** How rewards work, in the token picker's floating panel style (TokenMenu). */
function HowItWorksMenu({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (<>
    <div aria-hidden onClick={e => { e.stopPropagation(); onClose() }} style={{ position: 'fixed', inset: 0, zIndex: 40 }} />
    <motion.div role="dialog" aria-label="How rewards work"
      initial={{ opacity: 0, y: -6, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -6 }}
      transition={{ duration: 0.16, ease: [0.32, 0.72, 0, 1] }}
      style={{ position: 'absolute', top: 'calc(100% + 6px)', right: 0, width: 'min(300px, calc(100vw - 32px))', zIndex: 41, transformOrigin: 'top right',
        display: 'flex', flexDirection: 'column', gap: 2, padding: 4, borderRadius: 22,
        background: 'var(--surface)', border: '1px solid var(--border)', boxShadow: '0 12px 28px rgba(0,0,0,0.3)' }}>
      <div style={{ padding: '8px 10px 4px', fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}>
        Once a day each (resets 00:00 UTC)
      </div>
      {TASKS.map(t => (
        <div key={t.type} className="flex items-center gap-2" style={{ height: 38, padding: '0 12px 0 4px', borderRadius: 999 }}>
          <span className="flex items-center justify-center rounded-full flex-shrink-0"
            style={{ width: 30, height: 30, background: 'color-mix(in srgb, var(--brand) 16%, transparent)' }}>
            <ActionIcon name={t.action} size={17} color="var(--brand-text)" />
          </span>
          <span className="text-[15px] font-bold" style={{ flex: 1, minWidth: 0, color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.label}</span>
          <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--brand-text)' }}>+{POINTS_PER_TX}</span>
        </div>
      ))}
      <div style={{ margin: '4px 4px 4px', padding: '10px 12px', borderRadius: 18, background: 'color-mix(in srgb, var(--brand) 10%, transparent)', fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
        <b style={{ color: 'var(--text-primary)' }}>1,000 pts = ${formatAmount(pointsToUSDC(1000))} USDC</b>, sent to your Arc wallet.
        {' '}{MIN_CLAIM_POINTS}–{MAX_CLAIM_POINTS.toLocaleString()} pts per claim, up to {MAX_DAILY_POINTS.toLocaleString()} a day. Earn up to {MAX_DAILY_EARN_POINTS} pts a day.
      </div>
    </motion.div>
  </>)
}

function ClaimProgressCard({ p, balanceLeft, onClose, onRetry }: { p: ClaimProgress; balanceLeft: number; onClose: () => void; onRetry: () => void }) {
  const doneIdx = p.done.length // steps finished
  const failedIdx = p.phase === 'failed' ? Math.min(doneIdx, STEPS.length - 1) : -1
  const travIdx = Math.min(doneIdx, STEPS.length - 1)
  const ok = p.phase === 'success'
  const dim = 'color-mix(in srgb, var(--text-primary) 45%, transparent)'
  return (
    <>
      <PopupOpen />
      <style>{CLAIM_PROGRESS_CSS}</style>
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
        style={{ position: 'fixed', inset: 0, zIndex: 300, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 22 }}>
        <motion.div initial={{ scale: 0.96, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.96, opacity: 0 }} transition={{ duration: 0.22 }}
          role="dialog" aria-live="polite" aria-label="Claiming reward" data-leave-guard={p.phase === 'running' ? '' : undefined}
          style={{ width: '100%', maxWidth: 380, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 26, padding: '26px 22px 22px', textAlign: 'center', boxShadow: 'var(--shadow-3)' }}>
          {/* Logo → result */}
          <div style={{ position: 'relative', width: 96, height: 96, margin: '0 auto' }}>
            {p.phase === 'running' && <div style={{ position: 'absolute', inset: 8 }}><MeshLoader size={80} label="Claiming" /></div>}
            {ok && (
              <div className="rw-ok" style={{ position: 'absolute', inset: 6, borderRadius: '50%', background: 'var(--success)', boxShadow: '0 0 0 12px color-mix(in srgb, var(--success) 14%, transparent)' }}>
                <svg viewBox="0 0 84 84" style={{ position: 'absolute', inset: 0 }}><path d="M25 43 L37 55 L60 31" stroke="#fff" strokeWidth={7} fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>
              </div>
            )}
            {p.phase === 'failed' && (
              <div className="rw-ok" style={{ position: 'absolute', inset: 6, borderRadius: '50%', background: 'var(--danger)', color: '#fff', fontSize: 38, fontWeight: 900, display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 0 0 12px color-mix(in srgb, var(--danger) 14%, transparent)' }}>!</div>
            )}
          </div>
          <div style={{ marginTop: 14 }}>
            {p.phase === 'running' && <>
              <div style={{ fontSize: 26, fontWeight: 800, color: 'var(--text-primary)' }}>${formatAmount(p.usdc)} USDC</div>
              <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', marginTop: 4 }}>Claiming {p.points.toLocaleString()} pts to your wallet</div>
            </>}
            {ok && <div className="rw-fade">
              <div style={{ fontSize: 26, fontWeight: 800, color: 'var(--success)' }}>+${formatAmount(p.usdcReceived ?? p.usdc)} USDC</div>
              <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', marginTop: 4 }}>Sent to your MeshPort wallet</div>
            </div>}
            {p.phase === 'failed' && <div className="rw-fade">
              <div style={{ fontSize: 21, fontWeight: 800, color: 'var(--text-primary)' }}>Claim didn't go through</div>
              <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', marginTop: 4 }}>Your {p.points.toLocaleString()} pts were not deducted.</div>
            </div>}
          </div>

          {/* Steps with the travelling check */}
          <div style={{ position: 'relative', textAlign: 'left', margin: '18px 0 0' }}>
            <div style={{ position: 'absolute', left: 13, top: 12, width: 2, height: STEP_H * (STEPS.length - 1), background: 'var(--border)' }} />
            <div style={{ position: 'absolute', left: 13, top: 12, width: 2, height: STEP_H * Math.min(doneIdx, STEPS.length - 1), background: 'var(--success)', transition: 'height .55s cubic-bezier(.32,.72,0,1)' }} />
            {p.phase === 'running' && (
              <div className="rw-trav" aria-hidden style={{ position: 'absolute', left: 0, top: 6, width: 28, height: 28, borderRadius: '50%', zIndex: 3, transform: `translateY(${travIdx * STEP_H}px)`,
                background: 'var(--success)', color: '#fff', fontWeight: 900, fontSize: 14, display: 'flex', alignItems: 'center', justifyContent: 'center',
                boxShadow: '0 0 0 5px color-mix(in srgb, var(--success) 22%, transparent), 0 4px 14px color-mix(in srgb, var(--success) 45%, transparent)' }}>✓</div>
            )}
            {STEPS.map((s, i) => {
              const isDone = i < doneIdx
              const isFailed = i === failedIdx
              const t = p.times[s.key]
              return (
                <div key={s.key} style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 12, height: STEP_H, fontSize: 13.5 }}>
                  <span style={{ width: 28, display: 'flex', justifyContent: 'center', flexShrink: 0, position: 'relative', zIndex: 2 }}>
                    {isDone ? (
                      <span className="rw-tick" style={{ width: 24, height: 24, borderRadius: '50%', background: 'var(--success)', color: '#fff', fontSize: 13, fontWeight: 900, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>✓</span>
                    ) : isFailed ? (
                      <span style={{ width: 24, height: 24, borderRadius: '50%', background: 'var(--danger)', color: '#fff', fontSize: 13, fontWeight: 900, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>✕</span>
                    ) : (
                      <span style={{ width: 24, height: 24, borderRadius: '50%', background: 'var(--surface)', border: '2px solid var(--border)' }} />
                    )}
                  </span>
                  <span style={{ color: isFailed ? 'var(--danger)' : isDone || i === doneIdx ? 'var(--text-primary)' : dim, fontWeight: i === doneIdx && p.phase === 'running' ? 600 : 500 }}>{s.label}</span>
                  {isDone && t != null && <span style={{ marginLeft: 'auto', fontSize: 11.5, color: 'var(--text-secondary)' }}>{t < 1000 ? `${(t / 1000).toFixed(1)}s` : `${(t / 1000).toFixed(1)}s`}</span>}
                </div>
              )
            })}
          </div>

          {p.phase === 'running' && <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 14 }}>Keep the app open - this takes a few seconds</div>}
          {ok && (
            <div className="rw-fade">
              <div style={{ textAlign: 'left', marginTop: 14, padding: '8px 12px', borderRadius: 14, background: 'color-mix(in srgb, var(--text-primary) 5%, transparent)' }}>
                <Line k="Points used" v={`${p.points.toLocaleString()} pts`} />
                <Line k="Balance left" v={`${balanceLeft.toLocaleString()} pts`} />
                {p.txHash && <Line k="Transaction" v={<a href={arcExplorerTxUrl(p.txHash)} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--brand-text)', textDecoration: 'none' }}>{p.txHash.slice(0, 6)}…{p.txHash.slice(-4)} ↗</a>} />}
              </div>
              <button onClick={onClose} style={{ width: '100%', border: 'none', borderRadius: 14, padding: 14, fontSize: 15, fontWeight: 800, color: '#fff', background: 'var(--brand)', marginTop: 16, cursor: 'pointer' }}>Done</button>
            </div>
          )}
          {p.phase === 'failed' && (
            <div className="rw-fade">
              {p.error && <div role="alert" style={{ textAlign: 'left', marginTop: 14, padding: '10px 12px', borderRadius: 14, fontSize: 12.5, lineHeight: 1.45, color: 'var(--text-secondary)', background: 'color-mix(in srgb, var(--text-primary) 5%, transparent)' }}>{p.error}</div>}
              <button onClick={onRetry} style={{ width: '100%', border: 'none', borderRadius: 14, padding: 14, fontSize: 15, fontWeight: 800, color: '#fff', background: 'var(--brand)', marginTop: 16, cursor: 'pointer' }}>Try again</button>
              <button onClick={onClose} style={{ width: '100%', border: '1px solid var(--border)', borderRadius: 14, padding: 13, fontSize: 14, fontWeight: 700, color: 'var(--text-primary)', background: 'transparent', marginTop: 8, cursor: 'pointer' }}>Close</button>
            </div>
          )}
        </motion.div>
      </motion.div>
    </>
  )
}

function Line({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 12.5, padding: '5px 0' }}>
      <span style={{ color: 'var(--text-secondary)' }}>{k}</span><b style={{ color: 'var(--text-primary)', fontWeight: 600, textAlign: 'right' }}>{v}</b>
    </div>
  )
}

export function RewardsPage() {
  const isDesktop = useMediaQuery('(min-width: 980px)')
  const user = useAuthStore(s => s.user)
  const username = useAuthStore(s => s.username)
  const walletAddress = useAuthStore(s => s.walletAddress)
  const privateKey = useAuthStore(s => s.privateKey)
  const navigate = useNavigate()

  const [totalPoints, setTotalPoints]       = useState(0)
  const [lifetimePoints, setLifetimePoints] = useState(0)
  const [claimsHistory, setClaimsHistory]   = useState<ClaimRecord[]>([])
  // Tapping a claimed reward opens its receipt.
  const [claimReceipt, setClaimReceipt] = useState<ClaimRecord | null>(null)
  const claimFlash = useReturnFlash()
  const [pointHistory, setPointHistory]     = useState<PointRecord[]>([])
  const [dailyClaimedPoints, setDailyClaimedPoints] = useState(0)
  const [showEarnInfo, setShowEarnInfo] = useState(false)
  const howBtnRef = useRef<HTMLButtonElement>(null)
  const [loading, setLoading]               = useState(true)
  const [claiming, setClaiming]             = useState(false)
  const [claimError, setClaimError]         = useState<string | null>(null)
  // claimPoints: how many points user wants to claim - defaults to all
  const [claimPoints, setClaimPoints]       = useState<number>(0)
  const [claimInput, setClaimInput]         = useState('')
  const [showClaimSheet, setShowClaimSheet] = useState(false)
  const [progress, setProgress]             = useState<ClaimProgress | null>(null)
  // The claim is signing and sending on-chain: hold Back / sidebar until it lands.
  useLeaveGuard(progress?.phase === 'running', 'Reward claim')
  const [historyTab, setHistoryTab]         = useState<'earned' | 'claimed'>('earned')

  const userId = rewardsUserId(user?.id, walletAddress)

  const load = useCallback(async () => {
    if (!userId) { setLoading(false); return }
    setLoading(true)
    const [pts, claims, history, dailyClaimedOffChain, dailyClaimedChain] = await Promise.all([
      fetchUserPoints(userId),
      fetchClaimsHistory(userId),
      fetchPointHistory(userId),
      fetchDailyClaimedPoints(userId),
      walletAddress ? getDailyClaimedOnChain(walletAddress) : Promise.resolve(0),
    ])
    // The contract's own daily counter is the real source of truth for the
    // 1000/day cap - it's independent of Supabase's reward_claims bookkeeping,
    // which only counts claims THIS app saw succeed end-to-end. A claim that
    // landed on-chain but whose DB update step failed would undercount here,
    // showing a claim option that's guaranteed to fail again. Taking the max
    // of both means the UI never promises something the contract will reject.
    const dailyClaimed = Math.max(dailyClaimedOffChain, dailyClaimedChain)
    setTotalPoints(pts.totalPoints)
    setLifetimePoints(pts.lifetimePoints)
    setClaimsHistory(claims as ClaimRecord[])
    setPointHistory(history as PointRecord[])
    setDailyClaimedPoints(dailyClaimed)
    // Cap to what's both available AND within daily limit AND the per-claim
    // ceiling (MAX_CLAIM_POINTS - a single claim transaction can never redeem
    // more than this, independent of balance or daily limit).
    const dailyRemaining = Math.max(0, MAX_DAILY_POINTS - dailyClaimed)
    const maxClaimable = Math.min(pts.totalPoints, dailyRemaining, MAX_CLAIM_POINTS)
    setClaimPoints(maxClaimable >= MIN_CLAIM_POINTS ? maxClaimable : MIN_CLAIM_POINTS)
    setLoading(false)
  }, [userId, walletAddress])

  useEffect(() => { load() }, [load])

  const dailyRemaining = Math.max(0, MAX_DAILY_POINTS - dailyClaimedPoints)
  const maxClaimable = Math.min(totalPoints, dailyRemaining, MAX_CLAIM_POINTS)
  const effectiveClaimPoints = Math.max(0, Math.min(claimPoints, maxClaimable))
  const claimableUSDC = pointsToUSDC(effectiveClaimPoints)
  const dailyCapHit = totalPoints >= MIN_CLAIM_POINTS && dailyRemaining < MIN_CLAIM_POINTS && dailyClaimedPoints > 0
  const canOpenClaim = !!userId && !!walletAddress && maxClaimable >= MIN_CLAIM_POINTS && !loading
  const typedPoints = parseInt(claimInput || '0', 10) || 0
  const claimOk = typedPoints >= MIN_CLAIM_POINTS && typedPoints <= maxClaimable

  const openClaim = () => {
    setClaimError(null)
    setClaimInput(String(maxClaimable))
    setShowClaimSheet(true)
  }

  const handleClaim = async () => {
    setClaimError(null)
    if (!walletAddress)        { setClaimError('Wallet not connected'); return }
    if (!userId)               { setClaimError('User not found - please log out and back in'); return }
    if (!username)             { setClaimError('Username not set'); return }
    if (totalPoints < MIN_CLAIM_POINTS) { setClaimError(`Need at least ${MIN_CLAIM_POINTS} points to claim`); return }

    let activePrivateKey = privateKey
    if (!activePrivateKey) {
      try {
        const { restorePrivateKey } = await import('@/lib/restoreWallet')
        await restorePrivateKey()
        activePrivateKey = useAuthStore.getState().privateKey
      } catch (e) { console.error('[Rewards] restore key failed:', e) }
    }
    if (!activePrivateKey) { useAuthStore.getState().lock(); window.location.href = '/auth/lock'; return }

    const pointsToUse = Math.min(typedPoints, totalPoints, dailyRemaining, MAX_CLAIM_POINTS)
    if (pointsToUse < MIN_CLAIM_POINTS) {
      setClaimError(`Select at least ${MIN_CLAIM_POINTS} points${dailyRemaining < MIN_CLAIM_POINTS ? ` (daily limit: ${dailyRemaining} pts remaining today)` : ''}`)
      return
    }

    setShowClaimSheet(false)
    setClaiming(true)
    const started = Date.now()
    let last = started
    setClaimPoints(pointsToUse)
    setProgress({ points: pointsToUse, usdc: pointsToUSDC(pointsToUse), done: [], times: {}, phase: 'running' })

    const result = await claimPointsAsUSDC({
      userId,
      username: username.replace(/\.arc$/, ''),
      walletAddress,
      privateKey: activePrivateKey,
      points: pointsToUse,
      onStep: s => {
        const now = Date.now(), took = now - last
        last = now
        setProgress(p => p && p.phase === 'running' && !p.done.includes(s) ? { ...p, done: [...p.done, s], times: { ...p.times, [s]: took } } : p)
      },
    })

    if (result.error) {
      setProgress(p => p ? { ...p, phase: 'failed', error: result.error ?? undefined } : p)
      setClaiming(false)
      return
    }
    // Let the travelling check land on the last step before the result.
    await new Promise(r => setTimeout(r, Math.max(0, 650 - (Date.now() - last))))
    setProgress(p => p ? { ...p, done: ['check', 'approve', 'send'], phase: 'success', txHash: result.txHash, usdcReceived: result.usdcReceived } : p)
    setTotalPoints(prev => Math.max(0, prev - pointsToUse))
    await load()
    setHistoryTab('claimed')
    setClaiming(false)
  }

  // Today's tasks (UTC day - the same boundary rewards.ts uses for earning).
  const todayUtc = new Date().toISOString().slice(0, 10)
  const doneToday = new Set(pointHistory.filter(p => p.points > 0 && p.created_at.slice(0, 10) === todayUtc).map(p => p.reason))
  const earnedToday = TASKS.filter(t => doneToday.has(`tx_reward:${t.type}`)).length * POINTS_PER_TX
  const earnedRows = pointHistory.filter(p => p.points > 0)
  const newUser = !loading && totalPoints < MIN_CLAIM_POINTS && claimsHistory.length === 0

  // ── Pieces ─────────────────────────────────────────────────────────────
  const hero = newUser ? (
    // First claim not reached yet: progress ring to 100 pts.
    <div style={{ textAlign: 'center', padding: '6px 16px 0' }}>
      <div style={{ width: 150, height: 150, borderRadius: '50%', margin: '0 auto',
        background: `conic-gradient(var(--success) 0 ${Math.min(100, (totalPoints / MIN_CLAIM_POINTS) * 100)}%, color-mix(in srgb, var(--text-primary) 7%, transparent) 0 100%)`,
        display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ width: 124, height: 124, borderRadius: '50%', background: 'var(--bg)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
          <b style={{ fontSize: 28, color: 'var(--text-primary)' }}>{totalPoints}</b>
          <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>of {MIN_CLAIM_POINTS} pts</span>
        </div>
      </div>
      <p style={{ fontSize: 14, margin: '12px 0 0', color: 'var(--text-primary)' }}><b>{MIN_CLAIM_POINTS - totalPoints} more points</b> to your first USDC claim</p>
      <p style={{ fontSize: 12, color: 'var(--text-secondary)', margin: '4px 0 0' }}>
        Each task below earns +{POINTS_PER_TX} pts once a day · {MIN_CLAIM_POINTS} pts = ${formatAmount(pointsToUSDC(MIN_CLAIM_POINTS))} USDC
      </p>
    </div>
  ) : (
    <div style={{ margin: isDesktop ? 0 : '0 16px', borderRadius: 22, padding: 18, color: '#fff', position: 'relative', overflow: 'hidden',
      background: 'radial-gradient(120% 140% at 100% 0%, #2FB5A7 0%, #12665F 45%, #0B3F3B 100%)', boxShadow: isDesktop ? 'var(--shadow-1)' : undefined }}>
      <div aria-hidden style={{ position: 'absolute', right: -12, top: -18, width: 86, height: 86, borderRadius: '50%',
        background: 'radial-gradient(circle at 35% 35%, #FFE7A3, #F5A524 60%, #B8730B)', opacity: 0.9, display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 34, fontWeight: 900, color: '#7a4b06', boxShadow: 'inset -6px -8px 0 rgba(0,0,0,.12)' }}>P</div>
      <div style={{ fontSize: 12.5, opacity: 0.85 }}>Points balance</div>
      <div style={{ fontSize: 34, fontWeight: 800, letterSpacing: '-0.5px', marginTop: 2 }}>
        {loading ? '…' : totalPoints.toLocaleString()} <span style={{ fontSize: 15, fontWeight: 600, opacity: 0.85 }}>pts</span>
      </div>
      <div style={{ fontSize: 13, opacity: 0.9, marginTop: 2 }}>
        ≈ ${formatAmount(pointsToUSDC(totalPoints))} USDC{lifetimePoints > 0 ? ` · ${lifetimePoints.toLocaleString()} earned all-time` : ''}
      </div>
      <button onClick={openClaim} disabled={!canOpenClaim || claiming}
        style={{ width: '100%', marginTop: 14, padding: '11px 0', borderRadius: 12, border: 'none', background: '#fff', color: '#0B3F3B', fontSize: 14.5, fontWeight: 800,
          cursor: canOpenClaim ? 'pointer' : 'default', opacity: canOpenClaim && !claiming ? 1 : 0.6 }}>
        {claiming ? 'Claiming…' : dailyCapHit ? 'Daily claim limit reached' : 'Claim USDC'}
      </button>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5, opacity: 0.85, marginTop: 10, gap: 8 }}>
        <span>Claimed today {dailyClaimedPoints.toLocaleString()} / {MAX_DAILY_POINTS.toLocaleString()} pts</span>
        <span>1,000 pts = ${formatAmount(pointsToUSDC(1000))}</span>
      </div>
    </div>
  )

  const tasks = (
    <div>
      <div style={{ padding: isDesktop ? '0 2px 6px' : '18px 18px 6px', display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <b style={{ fontSize: 15, color: 'var(--text-primary)' }}>Today's tasks</b>
        <span style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>{earnedToday} / {MAX_DAILY_EARN_POINTS} pts</span>
      </div>
      <div style={{ margin: isDesktop ? '4px 2px 8px' : '4px 18px 8px', height: 6, borderRadius: 999, background: 'color-mix(in srgb, var(--text-primary) 6%, transparent)', overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${(earnedToday / MAX_DAILY_EARN_POINTS) * 100}%`, background: 'linear-gradient(90deg, var(--success), #2FB5A7)', borderRadius: 999, transition: 'width .4s' }} />
      </div>
      {TASKS.map(t => {
        const done = doneToday.has(`tx_reward:${t.type}`)
        return (
          <div key={t.type} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: isDesktop ? '9px 2px' : '9px 18px' }}>
            <HistoryIcon tone={done ? 'in' : 'out'} icon={t.action} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <b style={{ display: 'block', fontSize: 13.5, color: 'var(--text-primary)', fontWeight: 600 }}>{t.label}</b>
              <span style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>+{POINTS_PER_TX} pts</span>
            </div>
            {done ? (
              <span style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--success)' }}>✓ Done</span>
            ) : (
              <button onClick={() => navigate(t.path)} style={{ fontSize: 12.5, fontWeight: 700, padding: '6px 14px', borderRadius: 999, border: 'none', cursor: 'pointer',
                background: 'color-mix(in srgb, var(--brand) 16%, transparent)', color: 'var(--brand-text)' }}>Go</button>
            )}
          </div>
        )
      })}
    </div>
  )

  const historyRows = historyTab === 'earned' ? (
    earnedRows.length === 0 ? (
      <p style={{ textAlign: 'center', color: 'var(--text-secondary)', fontSize: 13, padding: '24px 16px' }}>Points you earn will show here.</p>
    ) : earnedRows.slice(0, HISTORY_LIMIT).map(p => {
      const t = taskOf(p.reason)
      return (
        <HistoryRow key={p.id} inPanel={isDesktop}
          icon={<HistoryIcon tone="out" icon={t ? t.action : 'rewards'} />}
          title={t ? t.done : 'Points earned'}
          meta={<><span style={{ color: 'var(--success)', fontWeight: 600 }}>Earned</span> · {timeAgo(p.created_at)}</>}
          right={<div style={{ fontSize: 14, fontWeight: 700, color: 'var(--brand-text)' }}>+{p.points} pts</div>} />
      )
    })
  ) : (
    claimsHistory.length === 0 ? (
      <p style={{ textAlign: 'center', color: 'var(--text-secondary)', fontSize: 13, padding: '24px 16px' }}>Your USDC claims will show here.</p>
    ) : claimsHistory.slice(0, HISTORY_LIMIT).map(claim => {
      const v = claimView(claim.status, claim.created_at); const c = claimColor(v)
      return (
        <HistoryRow key={claim.id} inPanel={isDesktop} flash={claim.id === claimFlash.flashId}
          onClick={() => { claimFlash.opened(); setClaimReceipt(claim) }}
          icon={<HistoryIcon tone={v === 'failed' ? 'failed' : v === 'pending' ? 'pending' : 'in'} icon="rewards" />}
          title={claimLabel(v)}
          meta={<><span style={{ color: c, fontWeight: 600 }}>{v === 'success' ? 'Completed' : v === 'failed' ? 'Failed · points kept' : 'Processing'}</span> · {timeAgo(claim.created_at)}</>}
          right={<>
            <div style={{ fontSize: 14, fontWeight: 700, color: c, textDecoration: v === 'failed' ? 'line-through' : 'none' }}>{v === 'success' ? '+' : ''}${formatAmount(claim.usdc_received)}</div>
            {v === 'success' && <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>−{claim.points_claimed.toLocaleString()} pts</div>}
          </>} />
      )
    })
  )

  const history = (
    <div style={isDesktop ? { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 18, boxShadow: 'var(--shadow-1)', overflow: 'hidden', display: 'flex', flexDirection: 'column', minHeight: 0, height: '100%' } : undefined}>
      <div style={{ display: 'flex', gap: 20, padding: isDesktop ? '12px 16px 0' : '14px 18px 0', borderBottom: '1px solid var(--border)', fontSize: 14 }}>
        {(['earned', 'claimed'] as const).map(t => (
          <button key={t} onClick={() => setHistoryTab(t)} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '0 0 9px', fontSize: 14,
            fontWeight: historyTab === t ? 700 : 500, color: historyTab === t ? 'var(--text-primary)' : 'var(--text-secondary)',
            borderBottom: `2px solid ${historyTab === t ? 'var(--text-primary)' : 'transparent'}`, marginBottom: -1 }}>
            {t === 'earned' ? 'Earned' : 'Claimed'}
          </button>
        ))}
      </div>
      <div style={isDesktop ? { overflowY: 'auto', flex: 1, minHeight: 0, padding: '4px 0' } : { padding: '4px 0 24px' }}>
        {loading ? <p style={{ textAlign: 'center', color: 'var(--text-secondary)', fontSize: 13, padding: '24px 16px' }}>Loading…</p> : historyRows}
        {!loading && (historyTab === 'earned' ? earnedRows.length : claimsHistory.length) > 0 && (
          <button onClick={() => navigate(`/activity?filter=rewards&rewards=${historyTab}`)}
            style={{ display: 'block', margin: '6px auto 4px', background: 'none', border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 700, color: 'var(--brand-text)', padding: '8px 12px' }}>
            See all
          </button>
        )}
      </div>
    </div>
  )

  // How it works - the earning and redeeming rules, floating down from the
  // pill like the token picker (TokenMenu's panel), portalled over the page
  // at the pill's spot (the sticky blurred header would clip it otherwise).
  const howRect = showEarnInfo ? howBtnRef.current?.getBoundingClientRect() : undefined
  const howItWorks = howRect ? createPortal(
    <div style={{ position: 'fixed', top: howRect.top, left: howRect.left, width: howRect.width, height: howRect.height, zIndex: 60 }}>
      <HowItWorksMenu onClose={() => setShowEarnInfo(false)} />
    </div>,
    document.body,
  ) : null

  // Claim sheet - pick the points, see the USDC.
  const sheet = (
    <P2PSheet open={showClaimSheet} onClose={() => setShowClaimSheet(false)} title="Claim USDC" id="rw-claim">
      <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', margin: '-6px 0 12px' }}>Balance {totalPoints.toLocaleString()} pts</div>
      <AmountField
        value={claimInput}
        onChange={raw => setClaimInput(raw.replace(/\D/g, '').slice(0, 5))}
        symbol=""
        token={{ label: 'pts' }}
        invalid={claimInput !== '' && !claimOk}
        ariaLabel="Points to claim"
        autoFocus={isDesktop}
        quick={[100, 250, 500].filter(v => v < maxClaimable).map(v => ({ label: String(v), onClick: () => setClaimInput(String(v)) }))}
        onMax={() => setClaimInput(String(maxClaimable))}
        onEnter={() => { if (claimOk) handleClaim() }}
      />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 14, padding: '12px 14px', borderRadius: 14, background: 'color-mix(in srgb, var(--success) 10%, transparent)' }}>
        <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>You receive</span>
        <b style={{ fontSize: 20, color: 'var(--success)' }}>${formatAmount(pointsToUSDC(claimOk ? typedPoints : 0))} USDC</b>
      </div>
      <div style={{ marginTop: 8 }}>
        <Line k="Rate" v={`1,000 pts = $${formatAmount(pointsToUSDC(1000))}`} />
        <Line k="Left to claim today" v={`${dailyRemaining.toLocaleString()} pts`} />
        <Line k="Per claim" v={`${MIN_CLAIM_POINTS} – ${MAX_CLAIM_POINTS.toLocaleString()} pts`} />
        <Line k="Sent to" v="Your Arc wallet" />
      </div>
      {claimInput !== '' && !claimOk && (
        <p role="alert" style={{ fontSize: 12.5, color: 'var(--danger)', margin: '8px 0 0' }}>
          {typedPoints < MIN_CLAIM_POINTS ? `Claim at least ${MIN_CLAIM_POINTS} pts` : `You can claim up to ${maxClaimable.toLocaleString()} pts now`}
        </p>
      )}
      {claimError && <p role="alert" style={{ fontSize: 12.5, color: 'var(--danger)', margin: '8px 0 0' }}>{claimError}</p>}
      <button onClick={handleClaim} disabled={!claimOk || claiming}
        style={{ width: '100%', border: 'none', borderRadius: 14, padding: 15, fontSize: 15, fontWeight: 800, color: '#fff', background: 'var(--brand)', marginTop: 14, cursor: 'pointer', opacity: !claimOk || claiming ? 0.45 : 1 }}>
        Claim ${formatAmount(pointsToUSDC(claimOk ? typedPoints : 0))} USDC
      </button>
    </P2PSheet>
  )

  const overlays = (
    <>
      {claimReceipt && <RewardClaimReceipt claim={claimReceipt} onClose={() => { claimFlash.closed(claimReceipt.id); setClaimReceipt(null) }} />}
      {howItWorks}
      {sheet}
      <AnimatePresence>
        {progress && (
          <ClaimProgressCard key="rw-progress" p={progress} balanceLeft={totalPoints}
            onClose={() => setProgress(null)}
            onRetry={() => { setProgress(null); openClaim() }} />
        )}
      </AnimatePresence>
    </>
  )

  const header = (
    <div className="header-row sticky top-0 z-20 backdrop-blur-md bg-bg/95 flex-shrink-0 gap-3 px-5 pt-header pb-header">
      <h1 className="text-xl font-bold text-text-primary">Rewards</h1>
      <button ref={howBtnRef} onClick={() => setShowEarnInfo(o => !o)} aria-expanded={showEarnInfo}
        className="ml-auto flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-bold"
        style={{ background: 'color-mix(in srgb, var(--brand) 14%, transparent)', color: 'var(--brand-text)', border: 'none', cursor: 'pointer' }}>
        <Info className="w-3.5 h-3.5" /> How it works
      </button>
    </div>
  )

  if (isDesktop) {
    // Desktop: balance + today's tasks (left), history (right).
    return (
      <div className="flex flex-col bg-bg overflow-hidden h-full">
        {overlays}
        {header}
        <div style={{ display: 'flex', flex: 1, minHeight: 0, gap: 28, padding: '8px 24px 14px', boxSizing: 'border-box' }}>
          <div style={{ flex: '1 1 0%', minWidth: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 18 }}>
            {hero}
            <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 18, padding: '14px 14px 6px', boxShadow: 'var(--shadow-1)' }}>{tasks}</div>
          </div>
          <div style={{ flex: '1 1 0%', minWidth: 0, minHeight: 0 }}>{history}</div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col bg-bg overflow-hidden h-screen">
      {overlays}
      {header}
      <div className="flex-1 overflow-y-auto">
        {hero}
        {tasks}
        {history}
      </div>
    </div>
  )
}
