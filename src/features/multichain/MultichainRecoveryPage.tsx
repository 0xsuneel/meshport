// src/features/multichain/MultichainRecoveryPage.tsx
//
// One place to recover money stuck in a cross-chain move:
//   • CCTP claims into Arc   → re-queue MeshPort's relayer
//   • CCTP transfers out     → mint on the destination with your own wallet
//   • Expired attestations   → ask Circle to re-attest
//   • Unified Balance        → shows 7-day withdrawals (lib/ubFundRecovery.ts)
//                              and completes any that are ready; sends any
//                              Unified Balance left on other chains to Arc
// Every action checks the chain first, so a transfer that already arrived is
// simply marked completed — nothing can be minted twice.

import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuthStore } from '@/store'
import {
  listRecoverable, inspectCctp, retryClaimRelay, selfMintClaim, requestReattest, selfMintTransfer,
  listPendingUbRecoveries, type RecoveryItem, type CctpDiagnosis,
} from '@/lib/cctpRecovery'

const card: React.CSSProperties = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 16, padding: 16 }
const btn: React.CSSProperties = { padding: '10px 14px', borderRadius: 12, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-primary)', fontSize: 13, fontWeight: 600, cursor: 'pointer' }

const STATE_TEXT: Record<CctpDiagnosis['state'], string> = {
  already_minted: 'Funds already arrived — marked completed.',
  waiting_attestation: 'Circle has not attested this burn yet. It will finish on its own.',
  ready_relay: 'Ready — MeshPort can finish this on Arc.',
  ready_self_mint: 'Ready — finish the mint with your wallet (needs a little gas on the destination).',
  forwarder_only: "Only Circle's forwarder can finish this one. It usually completes on its own.",
  needs_reattest: 'The attestation expired. Request a new one, then check again.',
  no_message: 'Circle has no record of this burn.',
  unsupported_chain: 'This chain is not supported for recovery.',
  relay_queued: 'Queued — MeshPort will mint on Arc within a few minutes.',
  reattest_requested: 'New attestation requested. Check again in a few minutes.',
  reattest_failed: 'Could not request a new attestation. Try again later.',
  reattest_pending: 'Still processing — Circle is issuing a new attestation. Check again in a few minutes.',
}

function fmtEta(ms: number): string {
  const m = Math.max(1, Math.round(ms / 60000))
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60), r = m % 60
  if (h < 24) return r ? `${h} h ${r} min` : `${h} h`
  const d = Math.floor(h / 24), rh = h % 24
  return rh ? `${d} d ${rh} h` : `${d} d`
}

export function RecoveryPanel({ showHeader = false }: { showHeader?: boolean }) {
  const navigate = useNavigate()
  const walletAddress = useAuthStore(s => s.walletAddress)
  const [items, setItems] = useState<RecoveryItem[]>([])
  const [ub, setUb] = useState<Array<{ id: string; amount: number; readyAt: string }>>([])
  // What the Gateway contract says about the withdrawal (the real unlock).
  const [ubChain, setUbChain] = useState<import('@/lib/ubFundRecovery').UbWithdrawalStatus | null>(null)
  // Confirmed Unified Balance sitting on non-Arc chains (e.g. a UB claim left mid-way).
  const [ubHeld, setUbHeld] = useState<Array<{ chain: string; confirmed: number; pending: number }>>([])
  // Leftover fee dust per chain (each below UB_MIN_SWEEP). Shown only once it totals UB_DUST_CLAIM_MIN.
  const [ubDust, setUbDust] = useState<Array<{ chain: string; amount: number }>>([])
  // Failed UB transfers (Arc → other chain) still sitting in the Arc Unified Balance.
  const [ubStuck, setUbStuck] = useState<Array<import('@/lib/ubFundRecovery').UbStuckTransfer & { available: number }>>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [result, setResult] = useState<Record<string, { diag?: CctpDiagnosis; error?: string }>>({})

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await listRecoverable()
      setItems([...r.claims, ...r.transfers].sort((a, b) => b.createdAt.localeCompare(a.createdAt)))
      if (walletAddress) {
        const list = await listPendingUbRecoveries(walletAddress)
        setUb(list)
        if (list.length) {
          const { getUbWithdrawalStatus } = await import('@/lib/ubFundRecovery')
          setUbChain(await getUbWithdrawalStatus(walletAddress))
        } else setUbChain(null)
      }
      if (walletAddress) {
        try {
          const [{ AppKit }, { getUnifiedBalances, UB_MIN_SWEEP }] = await Promise.all([import('@circle-fin/app-kit'), import('@/lib/ubClaim')])
          const kit = new AppKit({ clientKey: import.meta.env.VITE_KIT_KEY, disableErrorReporting: true } as any)
          const rows = await getUnifiedBalances(kit, walletAddress)
          // Dust (below UB_MIN_SWEEP per chain) is never listed — it stays in
          // the Unified Balance as the safety margin for the next spend.
          setUbHeld(rows.filter(r => r.chain !== 'Arc_Testnet' && (r.confirmed >= UB_MIN_SWEEP || r.pending >= UB_MIN_SWEEP)))
          setUbDust([])
          // Stuck transfers draw on the Arc Unified Balance, oldest first.
          try {
            const { listUbStuckTransfers } = await import('@/lib/ubFundRecovery')
            let arcLeft = rows.filter(r => r.chain === 'Arc_Testnet').reduce((s, r) => s + r.confirmed, 0)
            const stuck = (await listUbStuckTransfers(walletAddress)).map(t => {
              const available = Math.min(t.amount, arcLeft)
              arcLeft = Math.max(0, arcLeft - available)
              return { ...t, available }
            })
            // Keep every open stuck transfer visible. While Circle still holds
            // the amount for the failed delivery (its attestation, ~10 min),
            // the Arc balance reads low — show it, just without buttons.
            setUbStuck(stuck)
          } catch { setUbStuck([]) }
        } catch { setUbHeld([]); setUbDust([]); setUbStuck([]) }
      }
    } catch (e) {
      setResult(p => ({ ...p, _list: { error: e instanceof Error ? e.message : String(e) } }))
    }
    setLoading(false)
  }, [walletAddress])

  useEffect(() => { void load() }, [load])

  const run = async (key: string, fn: () => Promise<CctpDiagnosis | { mintTxHash: string }>) => {
    setBusy(key)
    try {
      const r = await fn()
      const diag = 'mintTxHash' in r ? { state: 'already_minted' as const, destinationMintTxHash: r.mintTxHash } : r
      setResult(p => ({ ...p, [key]: { diag } }))
      if (diag.state === 'already_minted' || diag.state === 'relay_queued') setTimeout(() => { void load() }, 1500)
    } catch (e) {
      setResult(p => ({ ...p, [key]: { error: e instanceof Error ? e.message : String(e) } }))
    }
    setBusy(null)
  }

  const getKey = async (): Promise<string> => {
    let key = useAuthStore.getState().privateKey
    if (!key) {
      const { restorePrivateKey } = await import('@/lib/restoreWallet')
      if (await restorePrivateKey()) key = useAuthStore.getState().privateKey
    }
    if (!key) throw new Error("Couldn't unlock your wallet on this device.")
    return key
  }

  const completeUb = async () => {
    setBusy('ub')
    try {
      const { checkAndCompleteUBRecoveries } = await import('@/lib/ubFundRecovery')
      const r = await checkAndCompleteUBRecoveries({ walletAddress: walletAddress!, privateKey: await getKey() })
      if (r.notReadyEtaMs != null) setResult(p => ({ ...p, ub: { error: `Not ready yet — Circle unlocks it on-chain in about ${fmtEta(r.notReadyEtaMs!)}.` } }))
      else if (r.error) setResult(p => ({ ...p, ub: { error: r.error } }))
      else if (r.completed > 0) setResult(p => ({ ...p, ub: {} }))
      await load()
    } catch (e) {
      setResult(p => ({ ...p, ub: { error: e instanceof Error ? e.message : String(e) } }))
    }
    setBusy(null)
  }

  const sendHeldToArc = async (chain: string, amount: number) => {
    const key = `ubheld:${chain}`
    setBusy(key)
    try {
      const [{ AppKit }, { createEthersAdapterFromPrivateKey }, { spendUnifiedToArc, recordUbClaim }] = await Promise.all([
        import('@circle-fin/app-kit'), import('@circle-fin/adapter-ethers-v6'), import('@/lib/ubClaim'),
      ])
      const kit = new AppKit({ clientKey: import.meta.env.VITE_KIT_KEY, disableErrorReporting: true } as any)
      const adapter = (createEthersAdapterFromPrivateKey as any)({ privateKey: await getKey() })
      const out = await spendUnifiedToArc({ kit, adapter, walletAddr: walletAddress!, fromChain: chain, amount })
      // History: "Recovered via UB · <chain>"
      await recordUbClaim({ walletAddr: walletAddress!, sdkChainId: chain, received: out.received, claimedAmount: amount, arcTxHash: out.txHash, recovered: true })
      setResult(p => ({ ...p, [key]: { diag: { state: 'already_minted', detail: `${out.received.toFixed(2)} USDC sent to Arc` } } }))
      setTimeout(() => { void load() }, 1500)
    } catch (e) {
      setResult(p => ({ ...p, [key]: { error: e instanceof Error ? e.message : String(e) } }))
    }
    setBusy(null)
  }

  const claimDust = async () => {
    const key = 'ubdust'
    setBusy(key)
    try {
      const [{ AppKit }, { createEthersAdapterFromPrivateKey }, { spendDustToArc, recordUbClaim }] = await Promise.all([
        import('@circle-fin/app-kit'), import('@circle-fin/adapter-ethers-v6'), import('@/lib/ubClaim'),
      ])
      const kit = new AppKit({ clientKey: import.meta.env.VITE_KIT_KEY, disableErrorReporting: true } as any)
      const adapter = (createEthersAdapterFromPrivateKey as any)({ privateKey: await getKey() })
      const total = ubDust.reduce((s, d) => s + d.amount, 0)
      const out = await spendDustToArc({ kit, adapter, walletAddr: walletAddress!, dust: ubDust })
      // History: "Recovered via UB · Unified Balance"
      await recordUbClaim({ walletAddr: walletAddress!, sdkChainId: 'Unified_Balance', received: out.received, claimedAmount: total, arcTxHash: out.txHash, recovered: true })
      setResult(p => ({ ...p, [key]: { diag: { state: 'already_minted', detail: `${out.received.toFixed(2)} USDC sent to Arc` } } }))
      setTimeout(() => { void load() }, 1500)
    } catch (e) {
      setResult(p => ({ ...p, [key]: { error: e instanceof Error ? e.message : String(e) } }))
    }
    setBusy(null)
  }
  const dustTotal = ubDust.reduce((s, d) => s + d.amount, 0)

  // Trustless last resort: Circle's 7-day on-chain withdrawal. Needs nobody —
  // not MeshPort, not Circle's API — only the user's own wallet. Started only
  // when the user taps it; completes by itself on the next app open after 7 days.
  const withdrawTrustless = async (key: string, p: { chain: string; amount: number; label: string; replaceRowId?: string }) => {
    const where = p.chain === 'Arc_Testnet' ? 'your Arc wallet' : `your wallet on ${p.chain.replace(/_/g, ' ')}`
    if (!window.confirm(`Withdraw ${p.amount.toFixed(2)} USDC to ${where} without Circle's service?\n\nThis is an on-chain withdrawal only you can do. The funds are locked for 7 days, then return automatically. Use it only if sending normally keeps failing.`)) return
    setBusy(key)
    try {
      const { initiateUBRecovery } = await import('@/lib/ubFundRecovery')
      await initiateUBRecovery({
        walletAddress: walletAddress!, privateKey: await getKey(), amount: p.amount.toFixed(6),
        destinationChainLabel: p.label, chain: p.chain, replaceRowId: p.replaceRowId, throwOnError: true,
      })
      setResult(r => ({ ...r, [key]: { diag: { state: 'already_minted', detail: `Withdrawal started — ${p.amount.toFixed(2)} USDC returns to ${where} in 7 days.` } } }))
      setTimeout(() => { void load() }, 1500)
    } catch (e) {
      setResult(r => ({ ...r, [key]: { error: e instanceof Error ? e.message : String(e) } }))
    }
    setBusy(null)
  }

  const resolveStuck = async (t: (typeof ubStuck)[number], mode: 'refund' | 'forward') => {
    const key = `ubstuck:${t.id}`
    setBusy(key)
    try {
      const { resolveUbStuckTransfer } = await import('@/lib/ubFundRecovery')
      const out = await resolveUbStuckTransfer({ walletAddress: walletAddress!, privateKey: await getKey(), item: t, mode, available: t.available })
      const where = mode === 'refund' ? 'your Arc wallet' : `${t.destinationLabel}`
      setResult(p => ({ ...p, [key]: { diag: { state: 'already_minted', detail: `${out.received.toFixed(2)} USDC sent to ${where}` } } }))
      setTimeout(() => { void load() }, 1500)
    } catch (e) {
      setResult(p => ({ ...p, [key]: { error: e instanceof Error ? e.message : String(e) } }))
    }
    setBusy(null)
  }

  const now = Date.now()
  // The contract decides; the saved date is only used if it couldn't be read.
  const ubReady = ubChain ? (ubChain.blocksLeft === 0 ? ub : []) : ub.filter(u => new Date(u.readyAt).getTime() <= now)
  const ubLabel = (u: { readyAt: string }) => ubChain
    ? (ubChain.blocksLeft === 0 ? 'ready to complete' : `ready in about ${fmtEta(ubChain.etaMs)}`)
    : (new Date(u.readyAt).getTime() <= now ? 'ready to complete' : `ready ${new Date(u.readyAt).toLocaleString()}`)

  return (
    <div style={showHeader
      ? { padding: 20, maxWidth: 640, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 12 }
      : { display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        {showHeader && <button onClick={() => navigate('/multichain')} style={{ ...btn, padding: '6px 10px' }} aria-label="Back">←</button>}
        {showHeader
          ? <h1 style={{ fontSize: 20, fontWeight: 700, color: 'var(--text-primary)' }}>Recover funds</h1>
          : <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}>{loading ? 'Checking your moves…' : `${items.length + ub.length + ubHeld.length + ubStuck.length + (ubDust.length ? 1 : 0)} to review`}</span>}
        <button onClick={() => void load()} style={{ ...btn, marginLeft: 'auto' }} disabled={loading}>{loading ? 'Checking…' : 'Refresh'}</button>
      </div>

      {result._list?.error && <div role="alert" style={{ ...card, color: 'var(--danger)' }}>{result._list.error}</div>}

      {!loading && items.length === 0 && ub.length === 0 && ubHeld.length === 0 && ubDust.length === 0 && ubStuck.length === 0 && (
        <div style={{ ...card, color: 'var(--text-secondary)' }}>Nothing stuck. All your cross-chain moves have finished.</div>
      )}

      {items.map(it => {
        const key = `${it.kind}:${it.id}`
        const r = result[key]
        const state = r?.diag?.state
        // A step already running for this row (from this list, or the last
        // check). While it runs the same step isn't offered again.
        // After a check, the checked state decides (a fresh attestation makes
        // it actionable again); before one, the step recorded on the row does.
        const inProgress = state
          ? state === 'relay_queued' || state === 'reattest_requested' || state === 'reattest_pending'
          : !!it.action
        const running = inProgress ? (r?.diag?.action ?? it.action ?? null) : null
        const lockedByMeshPort = running?.by === 'meshport'
        const shownState = state ?? (running?.kind === 'reattest' ? 'reattest_pending' : running?.kind === 'relay' ? 'relay_queued' : undefined)
        const actionBtn = (label: string, fn: () => Promise<CctpDiagnosis | { mintTxHash: string }>) => (
          <button style={{ ...btn, ...(lockedByMeshPort ? { opacity: 0.45, cursor: 'not-allowed' } : {}) }}
            disabled={busy === key || lockedByMeshPort} onClick={() => run(key, fn)}>{label}</button>
        )
        return (
          <div key={key} style={{ ...card, ...(lockedByMeshPort ? { opacity: 0.7 } : {}) }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--text-primary)', fontWeight: 600 }}>
              <span>{it.kind === 'claim' ? `${it.chain.replace(/_/g, ' ')} → Arc` : `Arc → ${it.chain.replace(/_/g, ' ')}`}</span>
              <span>{it.amount} USDC</span>
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4 }}>
              {it.status}{it.error ? ` · ${it.error}` : ''} · {new Date(it.createdAt).toLocaleString()}
            </div>

            {lockedByMeshPort && (
              <div style={{ fontSize: 13, marginTop: 10, color: 'var(--text-secondary)' }}>
                MeshPort is already {running!.kind === 'reattest' ? 'getting a new attestation for' : 'finishing'} this — no action needed.
              </div>
            )}
            {shownState && !lockedByMeshPort && (
              <div style={{ fontSize: 13, marginTop: 10, color: 'var(--text-primary)' }}>
                {STATE_TEXT[shownState]}{r?.diag?.detail && shownState !== 'reattest_pending' ? ` (${r.diag.detail})` : ''}
              </div>
            )}
            {r?.error && <div role="alert" style={{ fontSize: 13, marginTop: 10, color: 'var(--danger)' }}>{r.error}</div>}

            <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
              <button style={btn} disabled={busy === key} onClick={() => run(key, () => inspectCctp(it.kind, it.id))}>
                {busy === key ? 'Working…' : 'Check status'}
              </button>
              {/* Started by MeshPort: its steps stay visible but dimmed and disabled. */}
              {lockedByMeshPort && running?.kind === 'reattest' && actionBtn('Request new attestation', async () => requestReattest(it.kind, it.id))}
              {lockedByMeshPort && running?.kind === 'relay' && actionBtn('Let MeshPort finish it', async () => retryClaimRelay(it.id))}
              {/* Started by the user: hidden until it finishes or the new attestation expires. */}
              {!inProgress && state === 'ready_relay' && (
                <>
                  {actionBtn('Mint on Arc with my wallet', async () => selfMintClaim(it.id, await getKey()))}
                  {actionBtn('Let MeshPort finish it', () => retryClaimRelay(it.id))}
                </>
              )}
              {!inProgress && state === 'ready_self_mint' && actionBtn('Mint with my wallet', async () => selfMintTransfer(it.id, await getKey()))}
              {!inProgress && state === 'needs_reattest' && actionBtn('Request new attestation', () => requestReattest(it.kind, it.id))}
            </div>
          </div>
        )
      })}

      {ubStuck.map(t => {
        const key = `ubstuck:${t.id}`
        const r = result[key]
        const isBusy = busy === key
        const row = (label: string, value: string, mono = false) => (
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 13, padding: '6px 0', borderTop: '1px solid var(--border)' }}>
            <span style={{ color: 'var(--text-secondary)' }}>{label}</span>
            <span style={{ color: 'var(--text-primary)', fontWeight: 600, textAlign: 'right', wordBreak: 'break-all', fontFamily: mono ? 'ui-monospace, SFMono-Regular, Menlo, monospace' : undefined }}>{value}</span>
          </div>
        )
        return (
          <div key={key} style={card}>
            <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--text-primary)', fontWeight: 600 }}>
              <span>Transfer to {t.destinationLabel} didn’t finish</span>
              <span>{(t.available >= 0.1 ? t.available : t.amount).toFixed(2)} USDC</span>
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', margin: '4px 0 10px' }}>
              Held safely in your Unified Balance · {new Date(t.createdAt).toLocaleString()}
            </div>
            {row('Destination chain', t.destinationLabel)}
            {row('Destination address', t.destinationAddress, true)}
            {r?.diag?.detail && <div style={{ fontSize: 13, marginTop: 10, color: 'var(--text-primary)' }}>{r.diag.detail}</div>}
            {r?.error && <div role="alert" style={{ fontSize: 13, marginTop: 10, color: 'var(--danger)' }}>{r.error}</div>}
            {t.available < 0.1 ? (
              <div style={{ fontSize: 13, marginTop: 10, color: 'var(--text-secondary)', lineHeight: 1.45 }}>
                Circle is still holding this amount for the delivery that failed. It's released back to your
                Unified Balance within about 10 minutes — tap Refresh, then choose where to send it.
              </div>
            ) : (
            <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
              <button style={{ ...btn, flex: 1 }} disabled={isBusy} onClick={() => void resolveStuck(t, 'forward')}>
                {isBusy ? 'Sending…' : `Send to ${t.destinationLabel}`}
              </button>
              <button style={{ ...btn, flex: 1 }} disabled={isBusy} onClick={() => void resolveStuck(t, 'refund')}>
                {isBusy ? 'Sending…' : 'Send back to my wallet'}
              </button>
            </div>
            )}
            {t.available >= 0.1 && (
              <button style={{ ...btn, marginTop: 8, width: '100%', fontSize: 12.5, color: 'var(--text-secondary)' }} disabled={isBusy}
                onClick={() => void withdrawTrustless(key, { chain: 'Arc_Testnet', amount: t.available, label: t.destinationLabel, replaceRowId: t.id })}>
                Withdraw without Circle (7-day wait)
              </button>
            )}
            <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', marginTop: 8 }}>
              The destination can’t be changed. Circle’s Gateway fee is taken from the amount. If sending keeps failing,
              the 7-day withdrawal needs no one but your own wallet.
            </div>
          </div>
        )
      })}

      {ubDust.length > 0 && (
        <div style={card}>
          <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--text-primary)', fontWeight: 600 }}>
            <span>Leftover balance</span>
            <span>{dustTotal.toFixed(2)} USDC</span>
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4 }}>
            Small amounts left in your Unified Balance after earlier claims, on {ubDust.length} chain{ubDust.length === 1 ? '' : 's'}: {ubDust.map(d => d.chain.replace(/_(Sepolia|Testnet|Fuji|Amoy_Testnet)$/, '').replace(/_/g, ' ')).join(', ')}. Claim it back to your Arc wallet in one transfer.
          </div>
          {result.ubdust?.diag?.detail && <div style={{ fontSize: 13, marginTop: 10, color: 'var(--text-primary)' }}>{result.ubdust.diag.detail}</div>}
          {result.ubdust?.error && <div role="alert" style={{ fontSize: 13, marginTop: 10, color: 'var(--danger)' }}>{result.ubdust.error}</div>}
          <button style={{ ...btn, marginTop: 12 }} disabled={busy === 'ubdust'} onClick={() => void claimDust()}>
            {busy === 'ubdust' ? 'Sending…' : 'Claim back to Arc'}
          </button>
        </div>
      )}

      {ubHeld.map(h => {
        const key = `ubheld:${h.chain}`
        const r = result[key]
        return (
          <div key={key} style={card}>
            <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--text-primary)', fontWeight: 600 }}>
              <span>Unified Balance on {h.chain.replace(/_/g, ' ')}</span>
              <span>{h.confirmed.toFixed(2)} USDC</span>
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4 }}>
              {h.pending > 0.01 ? `${h.pending.toFixed(2)} USDC still confirming on that chain` : 'Ready to send to your Arc wallet'}
            </div>
            {r?.diag?.detail && <div style={{ fontSize: 13, marginTop: 10, color: 'var(--text-primary)' }}>{r.diag.detail}</div>}
            {r?.error && <div role="alert" style={{ fontSize: 13, marginTop: 10, color: 'var(--danger)' }}>{r.error}</div>}
            {h.confirmed >= 0.1 && (
              <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
                <button style={btn} disabled={busy === key} onClick={() => void sendHeldToArc(h.chain, h.confirmed)}>
                  {busy === key ? 'Sending…' : 'Send to Arc'}
                </button>
                <button style={{ ...btn, color: 'var(--text-secondary)' }} disabled={busy === key}
                  onClick={() => void withdrawTrustless(key, { chain: h.chain, amount: h.confirmed, label: 'Arc' })}>
                  Withdraw on {h.chain.replace(/_(Sepolia|Testnet|Fuji|Amoy_Testnet)$/, '').replace(/_/g, ' ')} (7-day wait)
                </button>
              </div>
            )}
          </div>
        )
      })}

      {ub.length > 0 && (
        <div style={card}>
          <div style={{ color: 'var(--text-primary)', fontWeight: 600 }}>Unified Balance withdrawals</div>
          {ub.map(u => (
            <div key={u.id} style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 6 }}>
              {u.amount} USDC · {ubLabel(u)}
            </div>
          ))}
          {ubChain && ubChain.withdrawing > ub.reduce((t, u) => t + u.amount, 0) + 0.01 && (
            <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', marginTop: 6 }}>
              {ubChain.withdrawing.toFixed(2)} USDC in total is being withdrawn — all of it comes back to your Arc wallet together.
            </div>
          )}
          {result.ub?.error && <div role="alert" style={{ fontSize: 13, marginTop: 8, color: 'var(--danger)' }}>{result.ub.error}</div>}
          {ubReady.length > 0 && (
            <button style={{ ...btn, marginTop: 12 }} disabled={busy === 'ub'} onClick={() => void completeUb()}>
              {busy === 'ub' ? 'Completing…' : 'Complete withdrawal to Arc'}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

/** Standalone route (/multichain-recovery) — same panel with a header. */
export function MultichainRecoveryPage() {
  return <RecoveryPanel showHeader />
}
