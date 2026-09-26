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

// ── On-chain withdrawal state (Circle Gateway wallet on Arc) ──────────────
// The 7-day wait is enforced ON-CHAIN in blocks (withdrawalDelay), not in
// wall-clock days — the saved eligible_at is only an estimate, and Arc's
// block pace makes the real unlock land hours later. Starting a new
// withdrawal also moves the unlock block for everything being withdrawn.
// So readiness is read from the contract itself.
const GATEWAY_WALLET = '0x0077777d7EBA4688BDeF3E311b846F25870A19B9'
const ARC_USDC = '0x3600000000000000000000000000000000000000'
export type UbWithdrawalStatus = {
  /** USDC currently in the withdrawal (all pending withdrawals together). */
  withdrawing: number
  /** Blocks until it can be completed (0 = ready now). */
  blocksLeft: number
  /** Estimated time until ready, from Arc's recent block pace. */
  etaMs: number
}
export async function getUbWithdrawalStatus(walletAddress: string): Promise<UbWithdrawalStatus | null> {
  try {
    const provider = await getArcProvider()
    const pad = (a: string) => a.toLowerCase().replace(/^0x/, '').padStart(64, '0')
    const args = pad(ARC_USDC) + pad(walletAddress)
    const [unlockHex, withdrawingHex, head] = await Promise.all([
      provider.call({ to: GATEWAY_WALLET, data: '0xfefeec13' + args }),   // withdrawalBlock(token, depositor)
      provider.call({ to: GATEWAY_WALLET, data: '0xdf0c6690' + args }),   // withdrawingBalance(token, depositor)
      provider.getBlock('latest'),
    ])
    const unlock = Number(BigInt(unlockHex))
    const withdrawing = Number(BigInt(withdrawingHex)) / 1e6
    const current = Number(head?.number ?? 0)
    const blocksLeft = Math.max(0, unlock - current)
    let msPerBlock = 500
    if (blocksLeft > 0 && current > 20000) {
      const past = await provider.getBlock(current - 20000).catch(() => null)
      if (past?.timestamp && head?.timestamp) msPerBlock = Math.max(50, ((Number(head.timestamp) - Number(past.timestamp)) * 1000) / 20000)
    }
    return { withdrawing, blocksLeft, etaMs: Math.round(blocksLeft * msPerBlock) }
  } catch (e) {
    console.warn('[ubFundRecovery] could not read withdrawal status:', e instanceof Error ? e.message : e)
    return null
  }
}

async function getKitAndAdapter(privateKey: string, chain: string = 'Arc_Testnet') {
  const { AppKit, createEthersAdapterFromPrivateKey } = await loadSdk()
  const kit = new AppKit({ clientKey: import.meta.env.VITE_KIT_KEY, disableErrorReporting: true } as any)
  // Arc: pinned to MeshPort's Arc RPC list. Any other chain (a withdrawal of
  // Unified Balance held on e.g. Base): the SDK's own RPCs for that chain.
  const adapter = chain === 'Arc_Testnet'
    ? createEthersAdapterFromPrivateKey({ privateKey, getProvider: async () => getArcProvider() })
    : createEthersAdapterFromPrivateKey({ privateKey })
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
  chain?: string                // chain the Unified Balance sits on (default Arc)
  replaceRowId?: string         // a stuck-transfer row this withdrawal takes over
  throwOnError?: boolean
}): Promise<boolean> {
  const { walletAddress, privateKey, amount, destinationChainLabel } = params
  const chain = params.chain ?? 'Arc_Testnet'
  try {
    // Starting the withdrawal is an on-chain tx from the user's wallet on
    // that chain; outside Arc it needs a little native gas there.
    if (chain !== 'Arc_Testnet') {
      const { fundDestinationGas } = await import('@/lib/ubClaim')
      await fundDestinationGas(chain, walletAddress)
    }
    const { kit, adapter } = await getKitAndAdapter(privateKey, chain)
    const result: any = await kit.unifiedBalance.initiateRemoveFund({
      from: { adapter, chain: chain as any },
      amount,
      token: 'USDC',
    })
    const eligibleAt = new Date(Date.now() + RECOVERY_WINDOW_MS).toISOString()
    const initHash: string = result?.txHash || result?.data?.txHash || ''

    const { supabase } = await import('@/lib/supabase')
    const withdrawMeta = {
      ub_recovery: true,
      ub_stuck_transfer: false,
      eligible_at: eligibleAt,
      withdrawal_block: result?.withdrawalBlock ?? null,
      init_tx_hash: initHash,
      withdraw_chain: chain,
      original_destination: destinationChainLabel,
      note: `Trustless withdrawal (7 days) back to your wallet on ${chain.replace(/_/g, ' ')}`,
    }
    if (params.replaceRowId) {
      // The stuck transfer becomes this withdrawal — one row, no duplicate.
      const { data: row } = await supabase.from('activity').select('metadata').eq('id', params.replaceRowId).maybeSingle()
      await supabase.from('activity').update({
        destination_chain: chain,
        explorer_url: initHash && chain === 'Arc_Testnet' ? `https://testnet.arcscan.app/tx/${initHash}` : null,
        metadata: { ...((row as any)?.metadata ?? {}), ...withdrawMeta },
      }).eq('id', params.replaceRowId)
      return true
    }
    await supabase.from('activity').upsert({
      wallet_address: walletAddress.toLowerCase(),
      tx_hash: `ubrecover_${initHash || crypto.randomUUID()}`,
      activity_type: 'withdraw',
      amount: parseFloat(amount),
      usd_value: parseFloat(amount),
      token_symbol: 'USDC',
      source_chain: chain,
      destination_chain: chain,
      status: 'pending',
      explorer_url: initHash && chain === 'Arc_Testnet' ? `https://testnet.arcscan.app/tx/${initHash}` : null,
      metadata: withdrawMeta,
    }, { onConflict: 'tx_hash,wallet_address', ignoreDuplicates: true })

    return true
  } catch (e) {
    console.error('[ubFundRecovery] initiateUBRecovery failed:', e instanceof Error ? e.message : e)
    if (params.throwOnError) throw e
    return false
  }
}

/**
 * Checks this wallet's pending UB recoveries and completes any whose 7-day
 * window has passed, crediting the funds back into the Arc wallet balance.
 * Call on every app open / tab refocus — see AppLayout.tsx. Safe to call
 * often: nothing happens if there's nothing pending or nothing eligible yet.
 */
export type UbCompleteResult = { completed: number; notReadyEtaMs?: number; error?: string }
export async function checkAndCompleteUBRecoveries(params: { walletAddress: string; privateKey: string }): Promise<UbCompleteResult> {
  const { walletAddress, privateKey } = params
  const out: UbCompleteResult = { completed: 0 }
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
    if (error) { console.error('[ubFundRecovery] pending lookup failed:', error.message); return { completed: 0, error: 'Could not load your withdrawals — try again.' } }

    // Ready only when the Gateway contract says so (see getUbWithdrawalStatus);
    // the saved eligible_at is just the fallback if the chain can't be read.
    const onchain = (pending ?? []).some((r: any) => (r.metadata?.withdraw_chain ?? 'Arc_Testnet') === 'Arc_Testnet')
      ? await getUbWithdrawalStatus(walletAddress) : null
    if (onchain && onchain.blocksLeft > 0) return { completed: 0, notReadyEtaMs: onchain.etaMs }
    const due = (pending ?? []).filter((row: any) => {
      if (onchain && (row.metadata?.withdraw_chain ?? 'Arc_Testnet') === 'Arc_Testnet') return true
      const eligibleAt = row.metadata?.eligible_at
      return eligibleAt && eligibleAt <= nowIso
    })
    if (due.length === 0) return out

    for (const row of due) {
      try {
        const chain: string = row.metadata?.withdraw_chain ?? 'Arc_Testnet'
        if (chain !== 'Arc_Testnet') {
          const { fundDestinationGas } = await import('@/lib/ubClaim')
          await fundDestinationGas(chain, walletAddress)
        }
        const { kit, adapter } = await getKitAndAdapter(privateKey, chain)
        const result: any = await kit.unifiedBalance.removeFund({
          from: { adapter, chain: chain as any },
          token: 'USDC',
        })
        const completedHash: string = result?.txHash || result?.data?.txHash || ''
        const recoveredAmount = parseFloat(result?.amount ?? row.amount) || row.amount

        await supabase.from('activity').update({
          status: 'completed',
          amount: recoveredAmount,
          usd_value: recoveredAmount,
          explorer_url: completedHash && chain === 'Arc_Testnet' ? `https://testnet.arcscan.app/tx/${completedHash}` : null,
          metadata: { ...row.metadata, completed_tx_hash: completedHash, completed_at: new Date().toISOString() },
        }).eq('id', row.id)

        const { notifyUBFundsRecovered } = await import('@/lib/notifications')
        notifyUBFundsRecovered({ amount: recoveredAmount, id: `ub_recovery_${row.id}` })
        out.completed += 1
        // No explicit balance-cache invalidation needed — balanceCache.ts's
        // TTL is only 4s, so Home's next scheduled poll picks up the credit
        // on its own well within that window.
      } catch (e) {
        // Genuinely not yet eligible on-chain (block-time vs wall-clock drift)
        // or a transient RPC issue — leave it pending, it'll be retried on
        // the next app open/refocus rather than surfacing an error the user
        // can't act on.
        console.warn('[ubFundRecovery] removeFund not yet completable for', row.id, ':', e instanceof Error ? e.message : e)
        const msg = e instanceof Error ? (e as any).shortMessage || e.message : String(e)
        out.error = /insufficient funds|gas/i.test(msg) ? 'Not enough USDC on Arc to pay the network fee for this withdrawal.' : `Couldn't complete the withdrawal: ${msg.slice(0, 160)}`
      }
    }
  } catch (e) {
    console.error('[ubFundRecovery] checkAndCompleteUBRecoveries failed:', e instanceof Error ? e.message : e)
    out.error = 'Something went wrong — try again.'
  }
  return out
}

// ── Stuck UB transfers: user chooses where the money goes ─────────────────
// When a UB transfer's spend leg fails, the deposited USDC sits in the
// user's Unified Balance on Arc. Instead of auto-starting the 7-day
// withdrawal (which also locks the funds), we record the ORIGINAL
// destination and let the user pick in Multichain Hub → Recover:
//   • Send back to my wallet  → spend to their own Arc wallet
//   • Send to <destination>   → spend to the original chain + address
// Destination chain and address are fixed to what the user confirmed; the
// Recover screen shows them but never lets them be edited.

export type UbStuckTransfer = {
  id: string
  amount: number
  createdAt: string
  destinationChain: string        // App Kit chain id, e.g. Base_Sepolia
  destinationLabel: string        // e.g. "Base Sepolia"
  destinationAddress: string
  depositTx?: string
  metadata: Record<string, any>
}

export async function recordUbStuckTransfer(p: {
  walletAddress: string; amount: string; destinationChain: string; destinationLabel: string
  destinationAddress: string; depositTx?: string
}): Promise<boolean> {
  try {
    const { supabase } = await import('@/lib/supabase')
    const { error } = await supabase.from('activity').upsert({
      wallet_address: p.walletAddress.toLowerCase(),
      tx_hash: `ubstuck_${(p.depositTx || crypto.randomUUID()).toLowerCase()}`,
      activity_type: 'withdraw',
      amount: parseFloat(p.amount),
      usd_value: parseFloat(p.amount),
      token_symbol: 'USDC',
      source_chain: 'Arc_Testnet',
      destination_chain: p.destinationChain,
      counterparty_address: p.destinationAddress.toLowerCase(),
      status: 'pending',
      metadata: {
        ub_stuck_transfer: true,
        destination_chain: p.destinationChain,
        destination_label: p.destinationLabel,
        destination_address: p.destinationAddress,
        deposit_tx: p.depositTx ?? null,
        note: 'Unified Balance transfer did not reach its destination — waiting for the user to choose',
      },
    }, { onConflict: 'tx_hash,wallet_address', ignoreDuplicates: true })
    if (error) throw error
    return true
  } catch (e) {
    console.error('[ubFundRecovery] recordUbStuckTransfer failed:', e instanceof Error ? e.message : e)
    return false
  }
}

export async function listUbStuckTransfers(walletAddress: string): Promise<UbStuckTransfer[]> {
  const { supabase } = await import('@/lib/supabase')
  const { data, error } = await supabase.from('activity')
    .select('id, amount, created_at, metadata')
    .eq('wallet_address', walletAddress.toLowerCase())
    .eq('activity_type', 'withdraw').eq('status', 'pending')
    .contains('metadata', { ub_stuck_transfer: true })
    .order('created_at', { ascending: true })
  if (error) throw error
  return (data ?? []).map((r: any) => ({
    id: r.id,
    amount: Number(r.amount),
    createdAt: r.created_at,
    destinationChain: r.metadata?.destination_chain,
    destinationLabel: r.metadata?.destination_label ?? String(r.metadata?.destination_chain ?? '').replace(/_/g, ' '),
    destinationAddress: r.metadata?.destination_address,
    depositTx: r.metadata?.deposit_tx ?? undefined,
    metadata: r.metadata ?? {},
  }))
}

/** Arc_Testnet chain id → MeshPort activity chain key. */
const APP_CHAIN: Record<string, string> = { Polygon_Amoy_Testnet: 'Polygon_Sepolia' }

/**
 * Finishes a stuck UB transfer the way the user chose. The destination is
 * always the one stored on the row — never a value from the UI.
 * `available` = the Arc Unified Balance currently confirmed (caps the spend).
 */
export async function resolveUbStuckTransfer(p: {
  walletAddress: string; privateKey: string; item: UbStuckTransfer; mode: 'refund' | 'forward'; available: number
}): Promise<{ received: number; txHash?: string }> {
  const { item, mode } = p
  const amount = Math.min(item.amount, p.available)
  if (amount <= 0) throw new Error('Nothing left in your Unified Balance for this transfer')
  const { kit, adapter } = await getKitAndAdapter(p.privateKey)
  const { spendUnifiedTo } = await import('@/lib/ubClaim')
  const toChain = mode === 'refund' ? 'Arc_Testnet' : item.destinationChain
  const recipient = mode === 'refund' ? p.walletAddress : item.destinationAddress
  if (!toChain || !recipient) throw new Error('This transfer has no saved destination')
  // `adapter` above is pinned to Arc RPCs (it signs the Arc allocation). A
  // mint we submit ourselves on the destination needs that chain's own RPCs.
  const { createEthersAdapterFromPrivateKey } = await loadSdk()
  const destAdapter = createEthersAdapterFromPrivateKey({ privateKey: p.privateKey })
  const out = await spendUnifiedTo({
    kit, adapter, destAdapter, signerAddress: p.walletAddress,
    fromChain: 'Arc_Testnet', amount, toChain, recipient,
  })

  const { supabase } = await import('@/lib/supabase')
  const metadata = {
    ...item.metadata, ub_stuck_transfer: false, recovered_via: 'ub', resolution: mode,
    completed_tx_hash: out.txHash ?? null, completed_at: new Date().toISOString(),
  }
  if (mode === 'refund') {
    // Shows as "Recovered via UB" (withdraw + ub_recovery) in Activity and the Hub.
    await supabase.from('activity').update({
      status: 'completed', amount: out.received, usd_value: out.received, destination_chain: 'Arc_Testnet',
      metadata: { ...metadata, ub_recovery: true },
      explorer_url: out.txHash ? `https://testnet.arcscan.app/tx/${out.txHash}` : null,
    }).eq('id', item.id)
  } else {
    // Becomes the transfer it was meant to be: "Transfer to <chain> · Recovered via UB".
    await supabase.from('activity').update({
      activity_type: 'bridge', status: 'completed', amount: out.received, usd_value: out.received,
      destination_chain: APP_CHAIN[item.destinationChain] ?? item.destinationChain,
      counterparty_address: item.destinationAddress.toLowerCase(),
      metadata,
    }).eq('id', item.id)
  }
  return out
}
