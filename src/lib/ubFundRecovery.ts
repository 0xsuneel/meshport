/**
 * lib/ubFundRecovery.ts
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * A Unified Balance (Circle Gateway) transfer has two legs: deposit (Arc
 * wallet → Unified Balance) then spend (Unified Balance → destination
 * chain). If spend fails and can't be resumed, the deposited USDC is stuck
 * in Unified Balance with no forward path — MeshPort previously only
 * offered "Retry anyway (may double-send)", with no way to actually get the
 * money back. Circle's SDK provides a trustless escape hatch for exactly
 * this: initiateRemoveFund() starts a 7-day (EVM) withdrawal timelock back
 * to the SAME account/chain used at deposit time, and removeFund() completes
 * it once that window passes. Since every deposit in this app uses
 * `from: { adapter, chain: 'Arc_Testnet' }` (see MultichainTransferPage.tsx),
 * a completed removal lands right back in the user's Arc wallet balance —
 * exactly where the money started.
 *
 * ── Design ───────────────────────────────────────────────────────────────
 * - initiateUBRecovery(): called once, immediately, the moment a UB spend
 *   is confirmed to have failed with no resumable path. Starts the 7-day
 *   clock right away rather than waiting for the user to notice or ask —
 *   the sooner it's initiated, the sooner it's recoverable. Safe to call
 *   even if spend secretly DID succeed despite the error (a real
 *   possibility on a bad connection — see MultichainTransferPage.tsx's
 *   mintMayHaveSucceeded): Circle's own ledger is the source of truth for
 *   what's actually sitting in Unified Balance, so if spend already drained
 *   it, there's nothing left to initiate a removal for; per Circle's docs
 *   this is a routine "nothing to withdraw" outcome, not a crash — it's not
 *   a silent no-op some other part of this app depends on.
 * - checkAndCompleteUBRecoveries(): called on every app open / tab
 *   refocus (see AppLayout.tsx), same trigger pattern as
 *   claim-recovery-scan. Looks for this wallet's pending recoveries whose
 *   7-day window has passed and completes them. This is what makes
 *   "automatic" true from the user's side: they never have to remember to
 *   come back and claim anything, it just happens quietly the next time
 *   they have the app open with their wallet unlocked (removeFund is a
 *   signed transaction from the original depositing address — no backend
 *   here ever holds that key, so it can only run client-side).
 *
 * Tracked via the shared `activity` table (activity_type: 'withdraw') rather
 * than a new table — keeps this visible in the user's own Activity history
 * for free, and reuses the existing dedupe/upsert conventions the rest of
 * ActivityService.ts already relies on.
 */

const RECOVERY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000 // Circle's documented EVM removeFund timelock

let _sdkModules: { AppKit: any; createEthersAdapterFromPrivateKey: any; JsonRpcProvider: any; FallbackProvider: any } | null = null
async function loadSdk() {
  if (_sdkModules) return _sdkModules
  const [{ AppKit }, { createEthersAdapterFromPrivateKey }, { JsonRpcProvider, FallbackProvider }] = await Promise.all([
    import('@circle-fin/app-kit'),
    import('@circle-fin/adapter-ethers-v6'),
    import('ethers'),
  ])
  _sdkModules = { AppKit, createEthersAdapterFromPrivateKey, JsonRpcProvider, FallbackProvider }
  return _sdkModules
}

// Only Arc_Testnet is ever needed here — both initiateRemoveFund and
// removeFund operate against the same chain the original deposit used, and
// every deposit in this app is from Arc. Simpler than MultichainTransferPage.tsx's
// getProvider (which also has to handle arbitrary destination chains).
let _arcProvider: any = null
async function getArcProvider() {
  if (_arcProvider) return _arcProvider
  const { JsonRpcProvider, FallbackProvider } = await loadSdk()
  const { ARC_RPCS, ARC_NETWORK } = await import('@/lib/arc')
  const toAbsolute = (url: string) =>
    /^[a-z]+:\/\//i.test(url) ? url
      : (typeof window !== 'undefined' && window.location?.origin ? window.location.origin + (url.startsWith('/') ? url : '/' + url) : url)
  const providers = ARC_RPCS.map((url: string) => new JsonRpcProvider(toAbsolute(url), ARC_NETWORK, { staticNetwork: true }))
  _arcProvider = providers.length === 1 ? providers[0] : new FallbackProvider(providers, undefined, { quorum: 1 })
  return _arcProvider
}

async function getKitAndAdapter(privateKey: string) {
  const { AppKit, createEthersAdapterFromPrivateKey } = await loadSdk()
  const kit = new AppKit({ clientKey: import.meta.env.VITE_KIT_KEY, disableErrorReporting: true } as any)
  const adapter = createEthersAdapterFromPrivateKey({
    privateKey,
    getProvider: async () => getArcProvider(),
  })
  return { kit, adapter }
}

/**
 * Initiates a fund recovery for `amount` USDC sitting in this wallet's
 * Unified Balance — called immediately after a UB spend() is confirmed to
 * have failed with no resumable path. Fire-and-forget from the caller's
 * perspective: failures here are logged, not thrown, since this runs
 * inside an already-failed transfer's error handling and shouldn't produce
 * a second, more confusing error on top of the first.
 */
export async function initiateUBRecovery(params: {
  walletAddress: string
  privateKey: string
  amount: string // human-readable decimal string, matching the deposited amount
  destinationChainLabel: string // for context in Activity — what the transfer was originally headed to
}): Promise<boolean> {
  const { walletAddress, privateKey, amount, destinationChainLabel } = params
  try {
    const { kit, adapter } = await getKitAndAdapter(privateKey)
    const result: any = await kit.unifiedBalance.initiateRemoveFund({
      from: { adapter, chain: 'Arc_Testnet' as any },
      amount,
      token: 'USDC',
    })
    const eligibleAt = new Date(Date.now() + RECOVERY_WINDOW_MS).toISOString()
    const initHash: string = result?.txHash || result?.data?.txHash || ''

    const { supabase } = await import('@/lib/supabase')
    await supabase.from('activity').upsert({
      wallet_address: walletAddress.toLowerCase(),
      tx_hash: `ubrecover_${initHash || crypto.randomUUID()}`,
      activity_type: 'withdraw',
      amount: parseFloat(amount),
      usd_value: parseFloat(amount),
      token_symbol: 'USDC',
      source_chain: 'Arc_Testnet',
      destination_chain: 'Arc_Testnet',
      status: 'pending',
      explorer_url: initHash ? `https://testnet.arcscan.app/tx/${initHash}` : null,
      metadata: {
        ub_recovery: true,
        eligible_at: eligibleAt,
        withdrawal_block: result?.withdrawalBlock ?? null,
        init_tx_hash: initHash,
        original_destination: destinationChainLabel,
        note: 'Auto-recovering to Arc wallet after an incomplete Unified Balance transfer',
      },
    }, { onConflict: 'tx_hash,wallet_address', ignoreDuplicates: true })

    return true
  } catch (e) {
    console.error('[ubFundRecovery] initiateUBRecovery failed:', e instanceof Error ? e.message : e)
    return false
  }
}

/**
 * Checks this wallet's pending UB recoveries and completes any whose 7-day
 * window has passed, crediting the funds back into the Arc wallet balance.
 * Call on every app open / tab refocus — see AppLayout.tsx. Safe to call
 * often: nothing happens if there's nothing pending or nothing eligible yet.
 */
export async function checkAndCompleteUBRecoveries(params: { walletAddress: string; privateKey: string }): Promise<void> {
  const { walletAddress, privateKey } = params
  try {
    const { supabase } = await import('@/lib/supabase')
    const nowIso = new Date().toISOString()
    const { data: pending, error } = await supabase
      .from('activity')
      .select('id, tx_hash, amount, metadata')
      .eq('wallet_address', walletAddress.toLowerCase())
      .eq('activity_type', 'withdraw')
      .eq('status', 'pending')
      .contains('metadata', { ub_recovery: true })
    if (error) { console.error('[ubFundRecovery] pending lookup failed:', error.message); return }

    const due = (pending ?? []).filter((row: any) => {
      const eligibleAt = row.metadata?.eligible_at
      return eligibleAt && eligibleAt <= nowIso
    })
    if (due.length === 0) return

    const { kit, adapter } = await getKitAndAdapter(privateKey)

    for (const row of due) {
      try {
        const result: any = await kit.unifiedBalance.removeFund({
          from: { adapter, chain: 'Arc_Testnet' as any },
          token: 'USDC',
        })
        const completedHash: string = result?.txHash || result?.data?.txHash || ''
        const recoveredAmount = parseFloat(result?.amount ?? row.amount) || row.amount

        await supabase.from('activity').update({
          status: 'completed',
          amount: recoveredAmount,
          usd_value: recoveredAmount,
          explorer_url: completedHash ? `https://testnet.arcscan.app/tx/${completedHash}` : null,
          metadata: { ...row.metadata, completed_tx_hash: completedHash, completed_at: new Date().toISOString() },
        }).eq('id', row.id)

        const { notifyUBFundsRecovered } = await import('@/lib/notifications')
        notifyUBFundsRecovered({ amount: recoveredAmount, id: `ub_recovery_${row.id}` })
        // No explicit balance-cache invalidation needed — balanceCache.ts's
        // TTL is only 4s, so Home's next scheduled poll picks up the credit
        // on its own well within that window.
      } catch (e) {
        // Genuinely not yet eligible on-chain (block-time vs wall-clock drift)
        // or a transient RPC issue — leave it pending, it'll be retried on
        // the next app open/refocus rather than surfacing an error the user
        // can't act on.
        console.warn('[ubFundRecovery] removeFund not yet completable for', row.id, ':', e instanceof Error ? e.message : e)
      }
    }
  } catch (e) {
    console.error('[ubFundRecovery] checkAndCompleteUBRecoveries failed:', e instanceof Error ? e.message : e)
  }
}
