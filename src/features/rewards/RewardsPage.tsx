import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import {Gift, Star, CheckCircle, Loader2, Lock, ExternalLink, Info, X} from 'lucide-react'
import { Card } from '@/components/ui/Card'
import {useAuthStore} from '@/store'
import {
  fetchUserPoints, claimPointsAsUSDC, fetchClaimsHistory, fetchPointHistory,
  fetchDailyClaimedPoints, getDailyClaimedOnChain, pointsToUSDC, MIN_CLAIM_POINTS, POINTS_PER_TX, MAX_DAILY_POINTS,
} from '@/lib/rewards'
import { timeAgo, formatAmount } from '@/lib/utils'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { DesktopHistoryPanel, DesktopHistoryEmpty, DesktopHistorySkeleton } from '@/components/ui/DesktopHistoryPanel'

interface ClaimRecord {
  id: string; points_claimed: number; usdc_received: number
  tx_hash: string | null; status: string; created_at: string; claimed_at: string | null
}
interface PointRecord {
  id: string; points: number; reason: string; tx_hash: string | null; created_at: string
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
  const [pointHistory, setPointHistory]     = useState<PointRecord[]>([])
  const [dailyClaimedPoints, setDailyClaimedPoints] = useState(0)
  const [showEarnInfo, setShowEarnInfo] = useState(false)
  const [loading, setLoading]               = useState(true)
  const [claiming, setClaiming]             = useState(false)
  const [claimError, setClaimError]         = useState<string | null>(null)
  const [claimSuccess, setClaimSuccess]     = useState<{ usdcReceived: number; txHash: string | null } | null>(null)
  // claimPoints: how many points user wants to claim — defaults to all
  const [claimPoints, setClaimPoints]       = useState<number>(0)

  const userId = user?.id && !user.id.startsWith('usr_')
    ? user.id
    : walletAddress ? `wallet_${walletAddress.toLowerCase().slice(2, 18)}` : null

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
    // 200/day cap — it's independent of Supabase's reward_claims bookkeeping,
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
    // Cap to what's both available AND within daily limit
    const dailyRemaining = Math.max(0, MAX_DAILY_POINTS - dailyClaimed)
    const maxClaimable = Math.min(pts.totalPoints, dailyRemaining)
    setClaimPoints(maxClaimable >= MIN_CLAIM_POINTS ? maxClaimable : MIN_CLAIM_POINTS)
    setLoading(false)
  }, [userId, walletAddress])

  useEffect(() => { load() }, [load])

  const handleClaim = async () => {
    setClaimError(null)
    if (!walletAddress)        { setClaimError('Wallet not connected'); return }
    if (!userId)               { setClaimError('User not found — please log out and back in'); return }
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
    if (!activePrivateKey) {
      { useAuthStore.getState().lock(); window.location.href = '/auth/lock'; return }
      return
    }

    const pointsToUse = Math.min(claimPoints, totalPoints, dailyRemaining)
    if (pointsToUse < MIN_CLAIM_POINTS) {
      setClaimError(`Select at least ${MIN_CLAIM_POINTS} points${dailyRemaining < MIN_CLAIM_POINTS ? ` (daily limit: ${dailyRemaining} pts remaining today)` : ''}`)
      return
    }

    setClaiming(true)
    setClaimSuccess(null)

    const result = await claimPointsAsUSDC({
      userId,
      username: username.replace(/\.arc$/, ''),
      walletAddress,
      privateKey: activePrivateKey,
      points: pointsToUse,
    })

    if (result.error) {
      setClaimError(result.error)
      setClaiming(false)
      return
    }

    setClaimSuccess({ usdcReceived: result.usdcReceived, txHash: result.txHash })
    setTotalPoints(prev => Math.max(0, prev - pointsToUse))

    // Reward claim tracked in Supabase reward_claims — shown in Rewards page only

    await load()
    setClaiming(false)
  }

  const dailyRemaining = Math.max(0, MAX_DAILY_POINTS - dailyClaimedPoints)
  const maxClaimable = Math.min(totalPoints, dailyRemaining)
  const canClaim = maxClaimable >= MIN_CLAIM_POINTS && !!userId && !!walletAddress && !claiming && !loading
  const effectiveClaimPoints = Math.min(claimPoints, maxClaimable)
  const claimableUSDC = pointsToUSDC(effectiveClaimPoints)
  // Slider only useful when maxClaimable > MIN_CLAIM_POINTS
  const showSlider = maxClaimable > MIN_CLAIM_POINTS
  const dailyCapHit = totalPoints >= MIN_CLAIM_POINTS && dailyRemaining < MIN_CLAIM_POINTS && dailyClaimedPoints > 0

  // Points balance card content — held in a variable so it renders
  // identically whether it's the top of the single mobile column or the
  // top of the desktop left column, never duplicated.
  const pointsCardBody = (
    <>
      <div className="w-16 h-16 bg-brand/20 rounded-full flex items-center justify-center mx-auto mb-3">
        <Star className="w-8 h-8 text-brand" />
      </div>
      {loading ? (
        <Loader2 className="w-8 h-8 text-brand animate-spin mx-auto" />
      ) : (
        <>
          <p className="text-4xl font-bold text-text-primary">{totalPoints.toLocaleString()}</p>
          <p className="text-sm text-text-secondary mt-1">MeshPort Points</p>
          <p className="text-xs text-text-secondary mt-1">
            {lifetimePoints > 0 ? `${lifetimePoints} lifetime points earned` : 'Send payments to earn points'}
          </p>
          {totalPoints >= MIN_CLAIM_POINTS && (
            <p className="text-xs text-success mt-2 font-medium">
              ≈ ${formatAmount(pointsToUSDC(totalPoints))} USDC claimable
            </p>
          )}
        </>
      )}
    </>
  )

  // Claim card content — same variable-not-duplicated reasoning, top of
  // the single mobile column or top of the desktop right column.
  const claimCardBody = (
    <>
      {!userId ? (
        <div className="flex items-center gap-3 py-2">
          <Lock className="w-5 h-5 text-text-secondary" />
          <p className="text-sm text-text-secondary">Login to claim rewards</p>
        </div>

      ) : totalPoints < MIN_CLAIM_POINTS ? (
        <div className="text-center py-3 space-y-2">
          <p className="text-sm text-text-secondary">
            You need <span className="text-text-primary font-semibold">{MIN_CLAIM_POINTS} points</span> to claim
          </p>
          <p className="text-xs text-text-muted">
            You have {totalPoints} pts — {MIN_CLAIM_POINTS - totalPoints} more needed
          </p>
          <div className="w-full bg-surface rounded-full h-2">
            <div className="bg-brand h-2 rounded-full transition-all"
              style={{ width: `${Math.min(100, (totalPoints / MIN_CLAIM_POINTS) * 100)}%` }} />
          </div>
        </div>

      ) : dailyCapHit ? (
        <div className="text-center py-3 space-y-2">
          <p className="text-sm text-warning font-medium">Daily claim limit reached</p>
          <p className="text-xs text-text-secondary">
            You've claimed {dailyClaimedPoints}/{MAX_DAILY_POINTS} points today.
            Your {totalPoints} pts will be claimable again tomorrow.
          </p>
        </div>

      ) : (
        <>
          {/* Amount row */}
          <div className="flex items-center justify-between">
            <span className="text-sm text-text-secondary">You will receive</span>
            <span className="text-lg font-bold text-success">${formatAmount(claimableUSDC)} USDC</span>
          </div>

          {/* Points selector */}
          <div className="space-y-2">
            <div className="flex items-center justify-between text-xs text-text-secondary">
              <span>{effectiveClaimPoints} pts selected</span>
              <button
                onClick={() => setClaimPoints(maxClaimable)}
                className="font-bold text-brand bg-brand/15 border border-brand/40 px-3 py-1.5 rounded-lg text-xs active:scale-95 transition-transform">
                MAX — {maxClaimable} pts
              </button>
            </div>

            {/* Only show slider when there's a range to select */}
            {showSlider && (
              <input
                type="range"
                min={MIN_CLAIM_POINTS}
                max={maxClaimable}
                value={effectiveClaimPoints}
                onChange={e => setClaimPoints(Number(e.target.value))}
                className="w-full h-2 accent-brand cursor-pointer"
              />
            )}

            {/* Number input — always visible */}
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={MIN_CLAIM_POINTS}
                max={maxClaimable}
                value={effectiveClaimPoints}
                onChange={e => {
                  const v = parseInt(e.target.value) || MIN_CLAIM_POINTS
                  setClaimPoints(Math.max(MIN_CLAIM_POINTS, Math.min(maxClaimable, v)))
                }}
                className="flex-1 bg-surface border border-border rounded-xl px-3 py-2 text-text-primary text-sm text-center focus:outline-none focus:border-brand"
              />
              <span className="text-xs text-text-secondary">pts</span>
            </div>
          </div>

          {dailyRemaining < totalPoints && (
            <p className="text-xs text-warning/70 text-center">
              Daily limit: {dailyClaimedPoints}/{MAX_DAILY_POINTS} pts claimed today
            </p>
          )}

          {/* Claim button */}
          <button
            onClick={handleClaim}
            disabled={!canClaim}
            className={`w-full py-3.5 rounded-2xl text-sm font-bold flex items-center justify-center gap-2 transition-all ${
              canClaim
                ? 'bg-brand text-white border border-black/10 active:scale-95'
                : 'bg-[rgb(var(--text-primary-rgb)/0.05)] text-text-muted cursor-not-allowed'
            }`}>
            {claiming
              ? <><Loader2 className="w-4 h-4 animate-spin" /> Processing...</>
              : `Claim ${effectiveClaimPoints} pts → $${formatAmount(claimableUSDC)} USDC`}
          </button>
        </>
      )}

      {/* Success */}
      {claimSuccess && (
        <div className="p-3 bg-success/10 border border-success/30 rounded-2xl space-y-1">
          <div className="flex items-center gap-2">
            <CheckCircle className="w-4 h-4 text-success" />
            <p className="text-sm font-semibold text-success">
              Claimed! +${formatAmount(claimSuccess.usdcReceived)} USDC sent to your wallet
            </p>
          </div>
          {claimSuccess.txHash && (
            <a href={`https://testnet.arcscan.app/tx/${claimSuccess.txHash}`}
              target="_blank" rel="noopener noreferrer"
              className="text-xs text-brand flex items-center gap-1 ml-6">
              <ExternalLink className="w-3 h-3" /> View on ArcScan
            </a>
          )}
        </div>
      )}

      {/* Error */}
      {claimError && (
        <div className="p-3 bg-danger/10 border border-danger/30 rounded-2xl">
          <p className="text-sm text-danger font-medium">Could not claim</p>
          <p className="text-xs text-danger/80 mt-0.5">{claimError}</p>
        </div>
      )}
    </>
  )

  const earnedRows = pointHistory.filter(p => p.points > 0)

  return (
    // Desktop: h-full (not h-screen) so this root's height matches the
    // space AppLayout's desktop shell actually gives it (below
    // DesktopHeader), not the full 100vh — otherwise the two-column split
    // below would be taller than the visible area. Mobile keeps h-screen,
    // matching its own single-pane shell exactly. overflow-hidden stays
    // for both: desktop's own two columns each manage their own scroll
    // internally (DesktopHistoryPanel + the height:100% row), same as
    // Swap/Multichain Transfer.
    <div className={`flex flex-col bg-bg overflow-hidden ${isDesktop ? 'h-full' : 'h-screen'}`}>
      <div className="header-row sticky top-0 z-20 backdrop-blur-md bg-bg/95 flex-shrink-0 gap-3 px-5 pt-header pb-header" style={{ position: 'relative' }}>
        <h1 className="text-xl font-bold text-text-primary">Rewards</h1>
        {/* How to Earn button */}
        <button
          onClick={() => setShowEarnInfo(v => !v)}
          className="ml-auto flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold"
          style={{ background: 'color-mix(in srgb, var(--brand) 15%, transparent)', border: '1px solid color-mix(in srgb, var(--brand) 30%, transparent)', color: 'var(--accent-text)' }}
        >
          <Info className="w-3.5 h-3.5" />
          How to Earn
        </button>

        {/* Dropdown panel */}
        {showEarnInfo && (
          <>
            {/* Backdrop to close */}
            <div onClick={() => setShowEarnInfo(false)} style={{ position: 'fixed', top: 0, bottom: 0, left: 0, right: 0, maxWidth: 430, margin: '0 auto', zIndex: 40 }} />
            <div style={{
              position: 'absolute', top: 'calc(100% + 6px)', right: 20, zIndex: 50,
              width: 260, background: 'var(--surface)',
              border: '1px solid var(--border)',
              borderRadius: 16, padding: '14px 0',
              boxShadow: 'var(--shadow-3)',
            }}>
              {/* Header */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 14px 10px', borderBottom: '1px solid var(--border)' }}>
                <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>How to Earn</span>
                <button onClick={() => setShowEarnInfo(false)} style={{ color: 'var(--text-muted)', background: 'none', border: 'none', cursor: 'pointer', padding: 2 }}>
                  <X className="w-4 h-4" />
                </button>
              </div>

              {/* Earn items */}
              {[
                { icon: '💸', label: 'Pay',                  desc: `+${POINTS_PER_TX} pts per transaction` },
                { icon: '🌐', label: 'Multichain Transfer',  desc: `+${POINTS_PER_TX} pts per transfer` },
                { icon: '🔄', label: 'Swap',                 desc: `+${POINTS_PER_TX} pts per swap` },
                { icon: '📦', label: 'Bulk Payment',         desc: `+${POINTS_PER_TX} pts per batch` },
              ].map(item => (
                <div key={item.label} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 14px' }}>
                  <span style={{ fontSize: 18, width: 28, textAlign: 'center', flexShrink: 0 }}>{item.icon}</span>
                  <div>
                    <p style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', margin: 0 }}>{item.label}</p>
                    <p style={{ fontSize: 11, color: 'var(--text-secondary)', margin: 0 }}>{item.desc}</p>
                  </div>
                </div>
              ))}

              {/* Daily limit */}
              <div style={{ margin: '10px 14px 0', padding: '10px 12px', background: 'color-mix(in srgb, var(--warning) 10%, transparent)', border: '1px solid color-mix(in srgb, var(--warning) 20%, transparent)', borderRadius: 10 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                  <Star className="w-3.5 h-3.5" style={{ color: 'var(--warning)', flexShrink: 0 }} />
                  <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--warning)' }}>Daily Limit</span>
                </div>
                <p style={{ fontSize: 11, color: 'var(--text-secondary)', margin: 0 }}>Max {MAX_DAILY_POINTS} pts / 10 txs per day</p>
              </div>
            </div>
          </>
        )}
      </div>

      {isDesktop ? (
        // Desktop: left column = available points (top) + earned points
        // history (bottom); right column = claiming (top) + claimed
        // history (bottom) — same full-bleed/no-maxWidth-cap, height:100%,
        // trimmed-bottom-padding spacing treatment as Swap's 2-column
        // desktop layout, so both columns reach down close to the
        // viewport's bottom edge instead of stopping short of it.
        <div style={{ display: 'flex', height: '100%', minHeight: 0, gap: 28, padding: '20px 24px 14px', boxSizing: 'border-box' }}>
          <div style={{ flex: '1 1 0%', minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div style={{ flexShrink: 0 }}>
              <Card className="p-6 text-center bg-brand/10 border-brand/20">
                {pointsCardBody}
              </Card>
            </div>
            <div style={{ flex: 1, minHeight: 0 }}>
              <DesktopHistoryPanel title="Earned Points History">
                {loading ? (
                  <DesktopHistorySkeleton />
                ) : earnedRows.length === 0 ? (
                  <DesktopHistoryEmpty label="Points you earn from payments, transfers, and swaps will appear here" />
                ) : (
                  earnedRows.map((p, i) => (
                    <div key={p.id} style={{
                      display: 'flex', alignItems: 'center', gap: 12, padding: '13px 16px',
                      borderTop: i === 0 ? 'none' : '1px solid color-mix(in srgb, var(--text-primary) 5%, transparent)',
                    }}>
                      <div style={{ width: 38, height: 38, borderRadius: '50%', flexShrink: 0, background: 'color-mix(in srgb, var(--brand) 15%, transparent)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        <Star className="w-4 h-4 text-brand" />
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>Points Earned</div>
                        <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>{timeAgo(p.created_at)}</div>
                      </div>
                      <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--brand)', flexShrink: 0 }}>+{p.points} pts</div>
                    </div>
                  ))
                )}
              </DesktopHistoryPanel>
            </div>
          </div>

          <div style={{ flex: '1 1 0%', minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div style={{ flexShrink: 0 }}>
              <p className="text-xs font-bold text-text-secondary uppercase tracking-wider mb-3">Claim Rewards</p>
              <Card className="p-4 space-y-4">
                {claimCardBody}
              </Card>
            </div>
            <div style={{ flex: 1, minHeight: 0 }}>
              <DesktopHistoryPanel title="Claimed History">
                {loading ? (
                  <DesktopHistorySkeleton />
                ) : claimsHistory.length === 0 ? (
                  <DesktopHistoryEmpty label="Your claimed rewards will appear here" />
                ) : (
                  claimsHistory.map((claim, i) => (
                    <div key={claim.id} style={{
                      display: 'flex', alignItems: 'center', gap: 12, padding: '13px 16px',
                      borderTop: i === 0 ? 'none' : '1px solid color-mix(in srgb, var(--text-primary) 5%, transparent)',
                    }}>
                      <div style={{ width: 38, height: 38, borderRadius: '50%', flexShrink: 0, background: 'color-mix(in srgb, var(--success) 15%, transparent)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        <Gift className="w-4 h-4 text-success" />
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>Reward Claimed</div>
                        <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>{timeAgo(claim.created_at)}</div>
                      </div>
                      <div style={{ textAlign: 'right', flexShrink: 0 }}>
                        <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--success)' }}>+${formatAmount(claim.usdc_received)} USDC</div>
                        <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>-{claim.points_claimed} pts</div>
                      </div>
                    </div>
                  ))
                )}
              </DesktopHistoryPanel>
            </div>
          </div>
        </div>
      ) : (
      <div className="flex-1 overflow-y-auto">
      <div className="px-4 space-y-4 pb-8">

        {/* Points balance card */}
        <Card className="p-6 text-center bg-brand/10 border-brand/20">
          {pointsCardBody}
        </Card>

        {/* Claim section */}
        <div>
          <p className="text-xs font-bold text-text-secondary uppercase tracking-wider mb-3">Claim Rewards</p>
          <Card className="p-4 space-y-4">
            {claimCardBody}
          </Card>
        </div>

        {/* Recent activity */}
        <div>
          <p className="text-xs font-bold text-text-secondary uppercase tracking-wider mb-3">Recent Activity</p>
          {loading ? (
            <div className="text-center py-8">
              <Loader2 className="w-6 h-6 text-text-muted animate-spin mx-auto" />
            </div>
          ) : pointHistory.length === 0 && claimsHistory.length === 0 ? (
            <div className="text-center py-10 bg-surface rounded-2xl border border-border">
              <Gift className="w-10 h-10 text-text-muted mx-auto mb-2" />
              <p className="text-text-secondary text-sm">No rewards activity yet</p>
              <p className="text-text-muted text-xs mt-1">Send a payment to earn your first points</p>
            </div>
          ) : (
            <div className="bg-surface rounded-2xl border border-border divide-y divide-border">
              {claimsHistory.slice(0, 5).map(claim => (
                <div key={claim.id} className="flex items-center gap-3 px-4 py-3">
                  <div className="w-9 h-9 bg-success/20 rounded-xl flex items-center justify-center flex-shrink-0">
                    <Gift className="w-4 h-4 text-success" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-text-primary">Reward Claimed</p>
                    <p className="text-xs text-text-secondary">{timeAgo(claim.created_at)}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-sm font-bold text-success">+${formatAmount(claim.usdc_received)} USDC</p>
                    <p className="text-xs text-text-muted">-{claim.points_claimed} pts</p>
                  </div>
                </div>
              ))}
              {earnedRows.slice(0, 5).map(p => (
                <div key={p.id} className="flex items-center gap-3 px-4 py-3">
                  <div className="w-9 h-9 bg-brand/20 rounded-xl flex items-center justify-center flex-shrink-0">
                    <Star className="w-4 h-4 text-brand" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-text-primary">Points Earned</p>
                    <p className="text-xs text-text-secondary">{timeAgo(p.created_at)}</p>
                  </div>
                  <p className="text-sm font-bold text-brand">+{p.points} pts</p>
                </div>
              ))}
            </div>
          )}
        </div>

      </div>
      </div>
      )}
    </div>
  )
}