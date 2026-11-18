import { useState, useEffect, useCallback, useRef, type ReactNode } from 'react'
import { getReadySigner } from '@/lib/paymentReadiness'
import { POINTS_EARNED_EVENT } from '@/lib/pointsEarned'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { AnimatePresence } from 'framer-motion'
import { arcExplorerTxUrl } from '@/lib/chainExplorers'
import { Info, Check, X } from 'lucide-react'
import { useAuthStore } from '@/store'
import {
  fetchUserPoints, claimPointsAsUSDC, fetchPendingClaim, fetchClaimsHistory, fetchPointHistory,
  fetchDailyClaimedPoints, getDailyClaimedOnChain, rewardsUserId, REWARD_TASKS, rewardTaskOf, pointsToUSDC, MIN_CLAIM_POINTS, MAX_CLAIM_POINTS, MAX_DAILY_POINTS,
} from '@/lib/rewards'
import { timeAgo, formatAmount } from '@/lib/utils'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { useSingleFlight } from '@/hooks/useSingleFlight'
import { readRewardsCache, writeRewardsCache } from '@/lib/rewardsCache'
import { ReceiptPopup } from '@/components/ui/ReceiptPopup'
import { AmountField } from '@/components/ui/AmountField'
import { AmountKeypad } from '@/components/ui/AmountKeypad'
import { HistoryRow, HistoryIcon } from '@/components/ui/HistoryRow'
import { ActionIcon } from '@/components/ui/ActionIcon'
import { useReturnFlash } from '@/hooks/useReturnFlash'
import { MeshLoader } from '@/components/ui/MeshLoader'
import { P2PSheet } from '@/features/p2p/p2pUi'
import { DesktopDialogFrame } from '@/components/ui/DesktopDialogFrame'
import { TokenMenu } from '@/components/ui/TokenMenu'
import { useLeaveGuard } from '@/lib/leaveGuard'
import { SkeletonRows } from '@/components/ui/Skeleton'
import { ScratchRewards } from './ScratchRewards'
import { fetchScratchHistory, fmtUsdcMicro, onCardCount, type ScratchWin } from '@/lib/scratchCards'
import { ArrowLeft } from 'lucide-react'

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
        {status === 'success' ? 'Paid out by MeshPort Rewards' : status === 'failed' ? 'Claim did not go through - your points were not deducted' : 'Being sent to your wallet…'}
      </>}
      rows={[
        // The header shows the USDC and where it came from; the title the outcome.
        ...(status !== 'failed' ? [{ label: 'Points used', value: `${claim.points_claimed} pts` }] : []),
        ...(hash ? [{ label: 'Transaction Hash', value: `${hash.slice(0, 6)}…${hash.slice(-4)}` }] : []),
        { label: 'Time', value: when },
      ]}
      detailRows={[
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
@keyframes rwFade{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
.rw-ok{animation:mpOkIn .45s var(--ease-out) both}
.rw-ok path{stroke-dasharray:60;stroke-dashoffset:60;animation:mpOkDraw .45s .25s ease-out forwards}
.rw-fade{animation:rwFade .35s .2s ease-out both}
.rw-tick{animation:mpStepTick .25s ease-out both}
.rw-trav{transition:transform .55s var(--ease-out)}
@media (prefers-reduced-motion: reduce){.rw-ok,.rw-ok path,.rw-fade,.rw-tick{animation:none;stroke-dashoffset:0}.rw-trav{transition:none}}
`
export interface ClaimProgress {
  points: number; usdc: number
  done: StepKey[]; times: Partial<Record<StepKey, number>>
  phase: 'running' | 'success' | 'failed'
  error?: string; txHash?: string | null; usdcReceived?: number
  /** Claiming the USDC won on scratch cards (not points). */
  usdcRewards?: boolean
}

/** How rewards work, in the dropdown panel (TokenMenu), portalled over the
 *  page at the pill's spot `rect` (the sticky blurred header would clip it
 *  otherwise). Render inside AnimatePresence so it animates out. */
function HowItWorksMenu({ rect, onClose }: { rect: DOMRect; onClose: () => void }) {
  return createPortal(
    <div style={{ position: 'fixed', top: rect.top, left: rect.left, width: rect.width, height: rect.height, zIndex: 60 }}>
      <TokenMenu onClose={onClose} width={300} ariaLabel="How rewards work">
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
            <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--brand-text)' }}>Random pts</span>
          </div>
        ))}
        <div style={{ margin: '4px 4px 4px', padding: '10px 12px', borderRadius: 18, background: 'color-mix(in srgb, var(--brand) 10%, transparent)', fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
          <b style={{ color: 'var(--text-primary)' }}>1,000 pts = ${formatAmount(pointsToUSDC(1000))} USDC</b>, sent to your Arc wallet.
          {' '}{MIN_CLAIM_POINTS}–{MAX_CLAIM_POINTS.toLocaleString()} pts per claim, up to {MAX_DAILY_POINTS.toLocaleString()} a day. Each action wins random points once a day.
        </div>
        <div style={{ margin: '0 4px 4px', padding: '10px 12px', borderRadius: 18, background: 'color-mix(in srgb, #2775CA 10%, transparent)', fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
          <b style={{ color: 'var(--text-primary)' }}>Scratch cards:</b> every payment wins one (up to 10 a day) - random points, or real USDC cashback on payments of $1 or more. Claim the USDC to your wallet anytime.
        </div>
      </TokenMenu>
    </div>,
    document.body,
  )
}

function ClaimProgressCard({ p, balanceLeft, onClose, onRetry }: { p: ClaimProgress; balanceLeft: number; onClose: () => void; onRetry: () => void }) {
  const doneIdx = p.done.length // steps finished
  const failedIdx = p.phase === 'failed' ? Math.min(doneIdx, STEPS.length - 1) : -1
  const travIdx = Math.min(doneIdx, STEPS.length - 1)
  const ok = p.phase === 'success'
  const dim = 'color-mix(in srgb, var(--text-primary) 45%, transparent)'
  const running = p.phase === 'running'
  // The app's centred popup (bare: this card draws itself). While the claim
  // runs it can't be closed (tap outside / Esc do nothing, and the page's
  // leave guard holds Back); once it settles, they close it like Done.
  return (
    <DesktopDialogFrame onClose={running ? () => {} : onClose} bare maxWidth={380} zIndex={300} backClose={!running}>
      <style>{CLAIM_PROGRESS_CSS}</style>
      <div aria-live="polite" aria-label="Claiming reward" data-leave-guard={running ? '' : undefined}
        style={{ width: '100%', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 26, padding: '26px 22px 22px', textAlign: 'center', boxShadow: 'var(--shadow-3)', boxSizing: 'border-box' }}>
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
            <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 4 }}>{p.usdcRewards ? 'Claiming your USDC rewards to your wallet' : `Claiming ${p.points.toLocaleString()} pts to your wallet`}</div>
          </>}
          {ok && <div className="rw-fade">
            <div style={{ fontSize: 26, fontWeight: 800, color: 'var(--success-text)' }}>+${formatAmount(p.usdcReceived ?? p.usdc)} USDC</div>
            <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 4 }}>Sent to your MeshPort wallet</div>
          </div>}
          {p.phase === 'failed' && <div className="rw-fade">
            <div style={{ fontSize: 21, fontWeight: 800, color: 'var(--text-primary)' }}>Claim didn't go through</div>
            <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 4 }}>{p.usdcRewards ? 'Your USDC rewards are kept.' : `Your ${p.points.toLocaleString()} pts were not deducted.`}</div>
          </div>}
        </div>

        {/* Steps with the travelling check */}
        <div style={{ position: 'relative', textAlign: 'left', margin: '18px 0 0' }}>
          <div style={{ position: 'absolute', left: 13, top: 12, width: 2, height: STEP_H * (STEPS.length - 1), background: 'var(--border)' }} />
          <div style={{ position: 'absolute', left: 13, top: 12, width: 2, height: STEP_H * (STEPS.length - 1), background: 'var(--success)',
            transformOrigin: 'top', transform: `scaleY(${Math.min(doneIdx, STEPS.length - 1) / Math.max(1, STEPS.length - 1)})`, transition: 'transform .55s var(--ease-out)' }} />
          {p.phase === 'running' && (
            <div className="rw-trav" aria-hidden style={{ position: 'absolute', left: 0, top: 6, width: 28, height: 28, borderRadius: '50%', zIndex: 3, transform: `translateY(${travIdx * STEP_H}px)`,
              background: 'var(--success)', color: '#fff', fontWeight: 900, fontSize: 14, display: 'flex', alignItems: 'center', justifyContent: 'center',
              boxShadow: '0 0 0 5px color-mix(in srgb, var(--success) 22%, transparent), 0 4px 14px color-mix(in srgb, var(--success) 45%, transparent)' }}><Check size={15} strokeWidth={3} /></div>
          )}
          {STEPS.map((s, i) => {
            const isDone = i < doneIdx
            const isFailed = i === failedIdx
            const t = p.times[s.key]
            return (
              <div key={s.key} style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 12, height: STEP_H, fontSize: 14 }}>
                <span style={{ width: 28, display: 'flex', justifyContent: 'center', flexShrink: 0, position: 'relative', zIndex: 2 }}>
                  {isDone ? (
                    <span className="rw-tick" style={{ width: 24, height: 24, borderRadius: '50%', background: 'var(--success)', color: '#fff', fontSize: 13, fontWeight: 900, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Check size={14} strokeWidth={3} /></span>
                  ) : isFailed ? (
                    <span style={{ width: 24, height: 24, borderRadius: '50%', background: 'var(--danger)', color: '#fff', fontSize: 13, fontWeight: 900, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><X size={14} strokeWidth={3} /></span>
                  ) : (
                    <span style={{ width: 24, height: 24, borderRadius: '50%', background: 'var(--surface)', border: '2px solid var(--border)' }} />
                  )}
                </span>
                <span style={{ color: isFailed ? 'var(--danger-text)' : isDone || i === doneIdx ? 'var(--text-primary)' : dim, fontWeight: i === doneIdx && p.phase === 'running' ? 600 : 500 }}>{p.usdcRewards && s.key === 'check' ? 'Checking your rewards' : s.label}</span>
                {isDone && t != null && <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--text-secondary)' }}>{t < 1000 ? `${(t / 1000).toFixed(1)}s` : `${(t / 1000).toFixed(1)}s`}</span>}
              </div>
            )
          })}
        </div>

        {p.phase === 'running' && <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 14 }}>Keep the app open - this takes a few seconds</div>}
        {ok && (
          <div className="rw-fade">
            <div style={{ textAlign: 'left', marginTop: 14, padding: '8px 12px', borderRadius: 14, background: 'color-mix(in srgb, var(--text-primary) 5%, transparent)' }}>
              {p.usdcRewards ? <Line k="From" v="USDC won on scratch cards" /> : <>
                <Line k="Points used" v={`${p.points.toLocaleString()} pts`} />
                <Line k="Balance left" v={`${balanceLeft.toLocaleString()} pts`} />
              </>}
              {p.txHash && <Line k="Transaction" v={<a href={arcExplorerTxUrl(p.txHash)} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--brand-text)', textDecoration: 'none' }}>{p.txHash.slice(0, 6)}…{p.txHash.slice(-4)} ↗</a>} />}
            </div>
            <button onClick={onClose} style={{ width: '100%', border: 'none', borderRadius: 14, padding: 14, fontSize: 15, fontWeight: 800, color: '#fff', background: 'var(--brand)', marginTop: 16, cursor: 'pointer' }}>Done</button>
          </div>
        )}
        {p.phase === 'failed' && (
          <div className="rw-fade">
            {p.error && <div role="alert" style={{ textAlign: 'left', marginTop: 14, padding: '10px 12px', borderRadius: 14, fontSize: 13, lineHeight: 1.45, color: 'var(--text-secondary)', background: 'color-mix(in srgb, var(--text-primary) 5%, transparent)' }}>{p.error}</div>}
            <button onClick={onRetry} style={{ width: '100%', border: 'none', borderRadius: 14, padding: 14, fontSize: 15, fontWeight: 800, color: '#fff', background: 'var(--brand)', marginTop: 16, cursor: 'pointer' }}>Try again</button>
            <button onClick={onClose} style={{ width: '100%', border: '1px solid var(--border)', borderRadius: 14, padding: 13, fontSize: 14, fontWeight: 700, color: 'var(--text-primary)', background: 'transparent', marginTop: 8, cursor: 'pointer' }}>Close</button>
          </div>
        )}
      </div>
    </DesktopDialogFrame>
  )
}

function Line({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 13, padding: '5px 0' }}>
      <span style={{ color: 'var(--text-secondary)' }}>{k}</span><b style={{ color: 'var(--text-primary)', fontWeight: 600, textAlign: 'right' }}>{v}</b>
    </div>
  )
}

export function RewardsPage() {
  const isDesktop = useMediaQuery('(min-width: 980px)')
  const user = useAuthStore(s => s.user)
  const username = useAuthStore(s => s.username)
  const walletAddress = useAuthStore(s => s.walletAddress)
  const navigate = useNavigate()

  const userId = rewardsUserId(user?.id, walletAddress)
  // The last Rewards data that loaded (lib/rewardsCache): the page opens on
  // it at once and refreshes in the background, instead of sitting on
  // loading placeholders until every read answers.
  const [cached] = useState(() => (userId ? readRewardsCache(userId) : null))
  const [totalPoints, setTotalPoints]       = useState(cached?.totalPoints ?? 0)
  const [claimsHistory, setClaimsHistory]   = useState<ClaimRecord[]>((cached?.claims as ClaimRecord[]) ?? [])
  // Tapping a claimed reward opens its receipt.
  const [claimReceipt, setClaimReceipt] = useState<ClaimRecord | null>(null)
  const claimFlash = useReturnFlash()
  const [pointHistory, setPointHistory]     = useState<PointRecord[]>((cached?.history as PointRecord[]) ?? [])
  const [dailyClaimedPoints, setDailyClaimedPoints] = useState(cached?.dailyClaimed ?? 0)
  const [showEarnInfo, setShowEarnInfo] = useState(false)
  const howBtnRef = useRef<HTMLButtonElement>(null)
  // loading: nothing to show yet (placeholders). fresh: this visit's numbers
  // have loaded - a claim never starts from cached ones.
  const [loading, setLoading]               = useState(!cached)
  const [fresh, setFresh]                   = useState(false)
  const [claiming, setClaiming]             = useState(false)
  const [claimError, setClaimError]         = useState<string | null>(null)
  // How many points the user wants to claim - defaults to all
  const [, setClaimPoints]       = useState<number>(0)
  const [claimInput, setClaimInput]         = useState('')
  const [showClaimSheet, setShowClaimSheet] = useState(false)
  const [progress, setProgress]             = useState<ClaimProgress | null>(null)
  // The claim is signing and sending on-chain: hold Back / sidebar until it lands.
  useLeaveGuard(progress?.phase === 'running', 'Reward claim')
  const [historyTab, setHistoryTab]         = useState<'earned' | 'claimed'>('earned')

  const load = useCallback(async () => {
    if (!userId) { setLoading(false); return }
    // A refresh (back in the app, a task just earned points) keeps showing
    // what's on screen - placeholders only when there's nothing yet.
    let results
    try {
      results = await Promise.all([
        fetchUserPoints(userId),
        fetchClaimsHistory(userId),
        fetchPointHistory(userId),
        fetchDailyClaimedPoints(userId),
        walletAddress ? getDailyClaimedOnChain(walletAddress) : Promise.resolve(0),
      ])
    } catch {
      // Couldn't load (weak network): keep the last numbers shown, and leave
      // Claim off until a load succeeds (the next return to the app, a task
      // earned, or a reopen retries).
      setLoading(false)
      return
    }
    const [pts, claims, history, dailyClaimedOffChain, dailyClaimedChain] = results
    // The contract's own daily counter is the real source of truth for the
    // 1000/day cap - it's independent of Supabase's reward_claims bookkeeping,
    // which only counts claims THIS app saw succeed end-to-end. A claim that
    // landed on-chain but whose DB update step failed would undercount here,
    // showing a claim option that's guaranteed to fail again. Taking the max
    // of both means the UI never promises something the contract will reject.
    const dailyClaimed = Math.max(dailyClaimedOffChain, dailyClaimedChain)
    setTotalPoints(pts.totalPoints)
    setClaimsHistory(claims as ClaimRecord[])
    setPointHistory(history as PointRecord[])
    setDailyClaimedPoints(dailyClaimed)
    // Cap to what's both available AND within daily limit AND the per-claim
    // ceiling (MAX_CLAIM_POINTS - a single claim transaction can never redeem
    // more than this, independent of balance or daily limit).
    const dailyRemaining = Math.max(0, MAX_DAILY_POINTS - dailyClaimed)
    const maxClaimable = Math.min(pts.totalPoints, dailyRemaining, MAX_CLAIM_POINTS)
    setClaimPoints(maxClaimable >= MIN_CLAIM_POINTS ? maxClaimable : MIN_CLAIM_POINTS)
    writeRewardsCache(userId, { totalPoints: pts.totalPoints, lifetimePoints: pts.lifetimePoints, claims, history, dailyClaimed })
    setFresh(true)
    setLoading(false)
  }, [userId, walletAddress])

  useEffect(() => { load() }, [load])
  // Live: a task done while this page is open (desktop: Pay / Swap beside
  // it) ticks off at once; back in the app, re-read for tasks done meanwhile.
  useEffect(() => {
    const onEarned = () => { void load() }
    const onVisible = () => { if (document.visibilityState === 'visible') void load() }
    window.addEventListener(POINTS_EARNED_EVENT, onEarned)
    document.addEventListener('visibilitychange', onVisible)
    return () => { window.removeEventListener(POINTS_EARNED_EVENT, onEarned); document.removeEventListener('visibilitychange', onVisible) }
  }, [load])

  const dailyRemaining = Math.max(0, MAX_DAILY_POINTS - dailyClaimedPoints)
  const maxClaimable = Math.min(totalPoints, dailyRemaining, MAX_CLAIM_POINTS)
  const canOpenClaim = !!userId && !!walletAddress && maxClaimable >= MIN_CLAIM_POINTS && !loading && fresh
  const typedPoints = parseInt(claimInput || '0', 10) || 0
  const claimOk = typedPoints >= MIN_CLAIM_POINTS && typedPoints <= maxClaimable

  const openClaim = () => {
    setClaimError(null)
    setClaimInput(String(maxClaimable))
    setShowClaimSheet(true)
  }

  // One claim at a time: it waits for the wallet (getReadySigner) before
  // `claiming` is set, and both the Claim button and the keypad's Enter call
  // it - a second tap / Enter in that gap used to start a second claim.
  const claimOnce = useSingleFlight()
  // An unfinished claim goes first (the server would finish it anyway).
  const handleClaim = () => { void claimOnce(() => runClaim(pendingClaim?.points)) }
  // A claim whose voucher was signed but never paid holds its points (they
  // already left the balance): Finish claim pays it out - same voucher, same
  // points, nothing deducted again (lib/rewards fetchPendingClaim).
  const [pendingClaim, setPendingClaim] = useState<{ points: number } | null>(null)
  useEffect(() => {
    if (!userId || !walletAddress) return
    let live = true
    void fetchPendingClaim().then(p => { if (live) setPendingClaim(p) })
    return () => { live = false }
  }, [userId, walletAddress, claiming])
  const finishPending = () => { if (pendingClaim) void claimOnce(() => runClaim(pendingClaim.points)) }
  // usdcPoints: claim the USDC won on scratch cards instead (its value in
  // contract points, lib/scratchCards usdcClaimPoints).
  const [scratchRefresh, setScratchRefresh] = useState(0)
  const claimUsdc = (usdcPoints: number) => { void claimOnce(() => runClaim(pendingClaim?.points, usdcPoints)) }
  const runClaim = async (finishing?: number, usdcPoints?: number) => {
    const usdcRewards = !finishing && !!usdcPoints
    setClaimError(null)
    if (!walletAddress)        { setClaimError('Wallet not connected'); return }
    if (!userId)               { setClaimError('User not found - please log out and back in'); return }
    if (!username)             { setClaimError('Username not set'); return }
    if (!finishing && !usdcRewards && totalPoints < MIN_CLAIM_POINTS) { setClaimError(`Need at least ${MIN_CLAIM_POINTS} points to claim`); return }

    const activeSigner = await getReadySigner()
    if (!activeSigner) { useAuthStore.getState().lock(); window.location.href = '/auth/lock'; return }

    const pointsToUse = finishing ?? (usdcRewards ? Math.min(usdcPoints!, dailyRemaining, MAX_CLAIM_POINTS) : Math.min(typedPoints, totalPoints, dailyRemaining, MAX_CLAIM_POINTS))
    if (usdcRewards && pointsToUse < MIN_CLAIM_POINTS) {
      setProgress({ points: usdcPoints!, usdc: pointsToUSDC(usdcPoints!), done: [], times: {}, phase: 'failed', usdcRewards,
        error: "You've reached today's claim limit - claim your USDC again after 00:00 UTC." })
      return
    }
    if (!finishing && pointsToUse < MIN_CLAIM_POINTS) {
      setClaimError(`Select at least ${MIN_CLAIM_POINTS} points${dailyRemaining < MIN_CLAIM_POINTS ? ` (daily limit: ${dailyRemaining} pts remaining today)` : ''}`)
      return
    }

    setShowClaimSheet(false)
    setClaiming(true)
    const started = Date.now()
    let last = started
    setClaimPoints(pointsToUse)
    setProgress({ points: pointsToUse, usdc: pointsToUSDC(pointsToUse), done: [], times: {}, phase: 'running', usdcRewards })

    const result = await claimPointsAsUSDC({
      userId,
      username: username.replace(/\.arc$/, ''),
      walletAddress,
      signer: activeSigner,
      points: pointsToUse,
      source: usdcRewards ? 'usdc' : 'points',
      onStep: s => {
        const now = Date.now(), took = now - last
        last = now
        setProgress(p => p && p.phase === 'running' && !p.done.includes(s) ? { ...p, done: [...p.done, s], times: { ...p.times, [s]: took } } : p)
      },
    })

    if (result.error) {
      setProgress(p => p ? { ...p, phase: 'failed', error: result.error ?? undefined } : p)
      setScratchRefresh(k => k + 1)
      setClaiming(false)
      return
    }
    // Let the travelling check land on the last step before the result.
    await new Promise(r => setTimeout(r, Math.max(0, 650 - (Date.now() - last))))
    setProgress(p => p ? { ...p, done: ['check', 'approve', 'send'], phase: 'success', txHash: result.txHash, usdcReceived: result.usdcReceived } : p)
    // A finished earlier claim's points already left the balance.
    if (!finishing && !usdcRewards) setTotalPoints(prev => Math.max(0, prev - pointsToUse))
    setPendingClaim(null)
    setScratchRefresh(k => k + 1)
    await load()
    setHistoryTab('claimed')
    setClaiming(false)
  }

  // Earned: task points plus scratch cards won (their points row shows as the card).
  const [scratchWins, setScratchWins] = useState<ScratchWin[]>([])
  const [cardsLeft, setCardsLeft] = useState(-1)
  useEffect(() => onCardCount(setCardsLeft), [])
  useEffect(() => { void fetchScratchHistory(HISTORY_LIMIT).then(setScratchWins).catch(() => {}) }, [scratchRefresh, totalPoints, cardsLeft])
  const earnedRows: (PointRecord & { usdcMicro?: number })[] = [
    ...pointHistory.filter(p => p.points > 0 && p.reason !== 'scratch_card'),
    ...scratchWins.map(w => ({ id: `sc_${w.id}`, points: w.points, usdcMicro: w.kind === 'usdc' ? w.usdcMicro : undefined, reason: 'scratch_card', tx_hash: null, created_at: w.scratchedAt })),
  ].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
  // The old points card and daily-task list are gone (18 Nov 2026: the
  // scratch-card page above). What's left of them: a claim that didn't
  // finish holds its points - a note to finish it.
  const hero = pendingClaim && !claiming ? (
    <div role="status" style={{ margin: isDesktop ? 0 : '18px 14px 0', padding: '12px 14px', borderRadius: 18, background: 'var(--surface)', border: '1px solid var(--soft-edge)', boxShadow: 'var(--soft-card)', display: 'flex', alignItems: 'center', gap: 10 }}>
      <div style={{ flex: 1, minWidth: 0, fontSize: 13, lineHeight: 1.4, color: 'var(--text-secondary)' }}>
        A claim of <b style={{ color: 'var(--text-primary)' }}>${formatAmount(pointsToUSDC(pendingClaim.points))} USDC</b> didn't finish - it's safe. Finish it to get it in your wallet.
      </div>
      <button onClick={finishPending} className="mp-press" style={{ flexShrink: 0, padding: '8px 14px', borderRadius: 999, border: 'none', background: 'var(--brand)', color: '#fff', fontSize: 13, fontWeight: 800, cursor: 'pointer' }}>Finish</button>
    </div>
  ) : null

  const historyRows = historyTab === 'earned' ? (
    earnedRows.length === 0 ? (
      <p style={{ textAlign: 'center', color: 'var(--text-secondary)', fontSize: 13, padding: '24px 16px' }}>Points and scratch-card rewards you win will show here.</p>
    ) : earnedRows.slice(0, HISTORY_LIMIT).map(p => {
      const t = taskOf(p.reason)
      return (
        <HistoryRow key={p.id} inPanel={isDesktop}
          icon={<HistoryIcon tone="out" icon={t ? t.action : 'rewards'} />}
          title={t ? t.done : p.reason === 'scratch_card' ? 'Scratch card won' : 'Points earned'}
          meta={<><span style={{ color: 'var(--success-text)', fontWeight: 600 }}>{p.usdcMicro != null ? 'In your USDC rewards' : 'Earned'}</span> · {timeAgo(p.created_at)}</>}
          right={p.usdcMicro != null
            ? <div style={{ fontSize: 14, fontWeight: 700, color: '#2775CA' }}>+{fmtUsdcMicro(p.usdcMicro)} USDC</div>
            : <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--brand-text)' }}>+{p.points} pts</div>} />
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
    <div style={isDesktop ? { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 18, overflow: 'hidden', display: 'flex', flexDirection: 'column', minHeight: 0, height: '100%' } : undefined}>
      <div style={{ display: 'flex', gap: 20, padding: isDesktop ? '12px 16px 0' : '14px 18px 0', borderBottom: '1px solid var(--border)', fontSize: 14 }}>
        {(['earned', 'claimed'] as const).map(t => (
          <button key={t} onClick={() => setHistoryTab(t)} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '0 0 9px', fontSize: 14,
            fontWeight: historyTab === t ? 700 : 500, color: historyTab === t ? 'var(--text-primary)' : 'var(--text-secondary)',
            borderBottom: `2px solid ${historyTab === t ? 'var(--text-primary)' : 'transparent'}`, marginBottom: -1 }}>
            {t === 'earned' ? 'Earned' : 'Claimed'}
          </button>
        ))}
      </div>
      <div style={isDesktop ? { overflowY: 'auto', overflowX: 'hidden', flex: 1, minHeight: 0, padding: '4px 0' } : { padding: '4px 0 24px' }}>
        {loading ? <SkeletonRows count={4} className="px-4" /> : historyRows}
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
  // pill (TokenMenu), at the pill's spot.
  const howRect = showEarnInfo ? howBtnRef.current?.getBoundingClientRect() : undefined
  const howItWorks = (
    <AnimatePresence>
      {howRect && <HowItWorksMenu key="rw-how" rect={howRect} onClose={() => setShowEarnInfo(false)} />}
    </AnimatePresence>
  )

  // Claim sheet - pick the points, see the USDC.
  const sheet = (
    <P2PSheet open={showClaimSheet} onClose={() => setShowClaimSheet(false)} title="Claim USDC" id="rw-claim">
      <div style={{ fontSize: 13, color: 'var(--text-secondary)', margin: '-6px 0 12px' }}>Balance {totalPoints.toLocaleString()} pts</div>
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
        // Phone: the app's keypad below (whole points), never the system keyboard.
        onTap={isDesktop ? undefined : () => {}}
        editing={!isDesktop}
      />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 14, padding: '12px 14px', borderRadius: 14, background: 'color-mix(in srgb, var(--success) 10%, transparent)' }}>
        <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>You receive</span>
        <b style={{ fontSize: 20, color: 'var(--success-text)' }}>${formatAmount(pointsToUSDC(claimOk ? typedPoints : 0))} USDC</b>
      </div>
      <div style={{ marginTop: 8 }}>
        <Line k="Rate" v={`1,000 pts = $${formatAmount(pointsToUSDC(1000))}`} />
        <Line k="Left to claim today" v={`${dailyRemaining.toLocaleString()} pts`} />
        <Line k="Per claim" v={`${MIN_CLAIM_POINTS} – ${MAX_CLAIM_POINTS.toLocaleString()} pts`} />
        <Line k="Sent to" v="Your Arc wallet" />
      </div>
      {claimInput !== '' && !claimOk && (
        <p role="alert" style={{ fontSize: 13, color: 'var(--danger-text)', margin: '8px 0 0' }}>
          {typedPoints < MIN_CLAIM_POINTS ? `Claim at least ${MIN_CLAIM_POINTS} pts` : `You can claim up to ${maxClaimable.toLocaleString()} pts now`}
        </p>
      )}
      {claimError && <p role="alert" style={{ fontSize: 13, color: 'var(--danger-text)', margin: '8px 0 0' }}>{claimError}</p>}
      {/* Phone: the keys right in the sheet (whole points, same 5-digit cap
          as typing on desktop); the field above shows what's entered. */}
      {!isDesktop && (
        <div style={{ marginTop: 14 }}>
          <AmountKeypad variant="inline" open value={claimInput} onChange={setClaimInput}
            token="pts" allowDecimal={false} maxDigits={5} showMax={false} />
        </div>
      )}
      <button onClick={handleClaim} disabled={!claimOk || claiming}
        style={{ width: '100%', border: 'none', borderRadius: 14, padding: 15, fontSize: 15, fontWeight: 800, color: '#fff', background: 'var(--brand)', marginTop: 14, cursor: 'pointer', opacity: !claimOk || claiming ? 0.45 : 1 }}>
        Claim ${formatAmount(pointsToUSDC(claimOk ? typedPoints : 0))} USDC
      </button>
    </P2PSheet>
  )

  const scratch = (
    <ScratchRewards isDesktop={isDesktop} totalPoints={totalPoints} claiming={claiming} refreshKey={scratchRefresh}
      onPointsWon={() => { void load() }} onClaimUsdc={claimUsdc} onClaimPoints={canOpenClaim ? openClaim : undefined} />
  )

  const overlays = (
    <>
      <AnimatePresence>
        {claimReceipt && <RewardClaimReceipt key={claimReceipt.id} claim={claimReceipt} onClose={() => { claimFlash.closed(claimReceipt.id); setClaimReceipt(null) }} />}
      </AnimatePresence>
      {howItWorks}
      {sheet}
      <AnimatePresence>
        {progress && (
          <ClaimProgressCard key="rw-progress" p={progress} balanceLeft={totalPoints}
            onClose={() => setProgress(null)}
            onRetry={() => { const u = progress.usdcRewards; setProgress(null); if (!u) openClaim() }} />
        )}
      </AnimatePresence>
    </>
  )

  const header = (
    <div className="header-row mp-glass-header sticky top-0 z-20 flex-shrink-0 gap-3 px-5 pt-header pb-header" style={{ position: 'sticky' }}>
      {isDesktop ? <h1 className="text-xl font-bold text-text-primary">Rewards</h1> : <>
        <button type="button" onClick={() => navigate(-1)} className="back-btn" aria-label="Back">
          <ArrowLeft className="w-5 h-5 text-text-primary" />
        </button>
        {/* The page's mark, centred (approved preview). */}
        <h1 aria-label="MeshPort Rewards" style={{ position: 'absolute', left: '50%', transform: 'translateX(-50%)', display: 'flex', flexDirection: 'column', alignItems: 'center', lineHeight: 1, pointerEvents: 'none' }}>
          <small style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.14em', color: 'var(--brand-text)' }}>MESHPORT</small>
          <b style={{ fontSize: 24, fontWeight: 900, letterSpacing: '-.5px', fontStyle: 'italic', textTransform: 'uppercase', background: 'linear-gradient(180deg, #1C8A7F, #0E524C)', WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent', paddingRight: 2 }}>Rewards</b>
        </h1>
      </>}
      <button ref={howBtnRef} onClick={() => setShowEarnInfo(o => !o)} aria-expanded={showEarnInfo}
        className="mp-hit mp-hit-sm ml-auto flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-bold"
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
          {/* Scrolls when the window is short; the cards keep their full
              height (flex items would otherwise shrink and cut off Claim USDC). */}
          <div style={{ flex: '1 1 0%', minWidth: 0, overflowY: 'auto', overflowX: 'hidden', display: 'flex', flexDirection: 'column', gap: 18, padding: 2, margin: -2 }}>
            <div style={{ flexShrink: 0 }}>{scratch}</div>
            {hero && <div style={{ flexShrink: 0 }}>{hero}</div>}
          </div>
          <div style={{ flex: '1 1 0%', minWidth: 0, minHeight: 0 }}>{history}</div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col bg-bg overflow-hidden h-full flex-1 min-h-0">
      {overlays}
      {/* The header sits inside the scroll box (sticky), so the page scrolls
          under its glass like Home. */}
      <div className="flex-1 overflow-y-auto" style={{ paddingBottom: 'var(--nav-space)' }}>
        {header}
        {scratch}
        {hero}
        <div style={{ height: 22 }} />
        {history}
      </div>
    </div>
  )
}
