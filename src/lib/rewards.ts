/**
 * MeshPort Rewards System
 *
 * Points: +20 per confirmed blockchain transaction
 * Conversion: 1000 points = 0.50 USDC (500_000 micro-USDC per 1000 points)
 * Daily limit: 200 points / 10 transactions
 *
 * Contract: MeshPortRewards.sol on Arc Testnet
 * Treasury: Admin funds with USDC; users claim on-chain
 */

import { createPublicClient, createWalletClient } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { supabase } from './supabase'
import { trimTrailingZeros } from './utils'
import { ARC_RPCS, arcTransport, arcRpcJson } from './arc'
import { useAuthStore } from '@/store'

export const POINTS_PER_TX       = 20
export const MAX_DAILY_POINTS    = 200
export const MAX_DAILY_TX        = 10
export const USDC_PER_1000_PTS   = 0.5      // 0.5 USDC per 1000 points
export const MIN_CLAIM_POINTS    = 100       // minimum to claim

// Rewards contract address (set after deployment)
const REWARDS_CONTRACT = (import.meta.env.VITE_REWARDS_CONTRACT || '') as `0x${string}`
const USDC_CONTRACT    = '0x3600000000000000000000000000000000000000' as const

const REWARDS_ABI = [{
  name: 'claimRewards', type: 'function' as const, stateMutability: 'nonpayable' as const,
  inputs: [{ name: 'points', type: 'uint256' as const }, { name: 'claimId', type: 'bytes32' as const }],
  outputs: [{ name: 'usdcAmount', type: 'uint256' as const }],
},
// Custom errors — without these, viem can't decode a revert into a
// readable name and everything falls back to "execution reverted
// for an unknown reason", which is what made this failure
// undiagnosable. With them, the catch block below can report e.g.
// "You've already claimed today's 200-point limit" instead.
{ type: 'error' as const, name: 'NotOwner', inputs: [] },
{ type: 'error' as const, name: 'ContractPaused', inputs: [] },
{ type: 'error' as const, name: 'AlreadyClaimed', inputs: [{ name: 'claimId', type: 'bytes32' as const }] },
{ type: 'error' as const, name: 'InsufficientPoints', inputs: [{ name: 'provided', type: 'uint256' as const }, { name: 'minimum', type: 'uint256' as const }] },
{ type: 'error' as const, name: 'InsufficientTreasury', inputs: [{ name: 'available', type: 'uint256' as const }, { name: 'required', type: 'uint256' as const }] },
{ type: 'error' as const, name: 'DailyLimitExceeded', inputs: [{ name: 'claimed', type: 'uint256' as const }, { name: 'limit', type: 'uint256' as const }] },
{ type: 'error' as const, name: 'ZeroPoints', inputs: [] },
{ type: 'error' as const, name: 'TransferFailed', inputs: [] },
]


// ─── Points calculation ────────────────────────────────────────────────────────
export function pointsToUSDC(points: number): number {
  return (points * USDC_PER_1000_PTS) / 1000
}

export function usdcToPoints(usdc: number): number {
  return (usdc / USDC_PER_1000_PTS) * 1000
}

// ─── Award points after confirmed transaction ─────────────────────────────────
export async function awardTransactionPoints(params: {
  userId: string
  walletAddress: string
  txHash: string
}): Promise<{ pointsAwarded: number; error: string | null }> {
  const today = new Date().toISOString().split('T')[0]

  // 1. Check duplicate tx reward
  const { data: existing } = await supabase
    .from('point_transactions')
    .select('id')
    .eq('tx_hash', params.txHash)
    .maybeSingle()
  if (existing) {
    return { pointsAwarded: 0, error: null }
  }

  // 2. Check daily limits
  const { data: daily } = await supabase
    .from('daily_tx_rewards')
    .select('tx_count, points')
    .eq('user_id', params.userId)
    .eq('reward_date', today)
    .maybeSingle()

  const todayTxCount = daily?.tx_count || 0
  const todayPoints = daily?.points || 0

  if (todayTxCount >= MAX_DAILY_TX) {
    return { pointsAwarded: 0, error: null }
  }
  if (todayPoints >= MAX_DAILY_POINTS) {
    return { pointsAwarded: 0, error: null }
  }

  // 3. Record point transaction
  const { error: ptError } = await supabase.from('point_transactions').insert({
    user_id: params.userId,
    wallet_address: params.walletAddress,
    points: POINTS_PER_TX,
    reason: 'tx_reward',
    tx_hash: params.txHash,
  })
  if (ptError) {
    console.error('[Rewards] point_transactions insert failed:', ptError.code, ptError.message)
    return { pointsAwarded: 0, error: `Could not record points: ${ptError.message}` }
  }

  // 4. Update daily tracking
  const { error: dtrError } = await supabase.from('daily_tx_rewards').upsert({
    user_id: params.userId,
    reward_date: today,
    tx_count: todayTxCount + 1,
    points: todayPoints + POINTS_PER_TX,
  }, { onConflict: 'user_id,reward_date' })
  if (dtrError) {
    console.error('[Rewards] daily_tx_rewards upsert failed:', dtrError.code, dtrError.message)
    return { pointsAwarded: 0, error: `Could not update daily tracking: ${dtrError.message}` }
  }

  // 5. Update user total points — atomic increment via RPC (see
  // supabase-fix-points-race.sql). Previously this read the current
  // total_points, added 20 in JS, then wrote it back — two overlapping
  // calls to this function (e.g. two payments sent close together) could
  // both read the same starting value and one increment would silently
  // overwrite the other. No error occurred either time since the write
  // itself always succeeded; it just wrote a stale number. This function
  // must exist in the database (run supabase-fix-points-race.sql) — if it
  // doesn't yet, this call fails loudly below rather than silently
  // corrupting the balance the old way.
  const { error: upError } = await supabase.rpc('increment_user_points', {
    p_user_id: params.userId,
    p_wallet_address: params.walletAddress,
    p_amount: POINTS_PER_TX,
  })
  if (upError) {
    console.error('[Rewards] increment_user_points failed:', upError.code, upError.message)
    // point_transactions + daily_tx_rewards already succeeded above, so the
    // points aren't fully lost — but the balance shown to the user won't
    // reflect them until this is retried. Report it honestly rather than
    // claiming success.
    return { pointsAwarded: 0, error: `Points recorded but balance update failed: ${upError.message}` }
  }

  return { pointsAwarded: POINTS_PER_TX, error: null }
}

// ─── Fetch user points ────────────────────────────────────────────────────────
export async function fetchUserPoints(userId: string): Promise<{
  totalPoints: number
  lifetimePoints: number
  claimableUSDC: number
}> {
  const { data } = await supabase
    .from('user_points')
    .select('total_points, lifetime_points')
    .eq('user_id', userId)
    .maybeSingle()
  const totalPoints = data?.total_points || 0
  return {
    totalPoints,
    lifetimePoints: data?.lifetime_points || 0,
    claimableUSDC: pointsToUSDC(totalPoints),
  }
}

// ─── Get treasury balance (on-chain) ─────────────────────────────────────────
export async function getTreasuryBalance(): Promise<number> {
  if (!REWARDS_CONTRACT) return 0
  try {
    const { encodeFunctionData } = await import('viem')
    const TREASURY_ABI = [{
      name: 'treasuryBalance',
      type: 'function' as const,
      stateMutability: 'view' as const,
      inputs: [],
      outputs: [{ name: '', type: 'uint256' as const }],
    }]
    const data = encodeFunctionData({ abi: TREASURY_ABI, functionName: 'treasuryBalance' })
    const json = await arcRpcJson({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: REWARDS_CONTRACT, data }, 'latest'] })
    if (json.result && json.result !== '0x' && json.result !== '0x0') return Number(BigInt(json.result)) / 1e6
    return 0
  } catch { return 0 }
}

// ─── Get today's on-chain claimed points for a wallet ──────────────────────────
// The contract's own dailyClaimed[wallet][day] mapping is the real source of
// truth for the 200-point/day cap — it's independent of (and can drift from)
// Supabase's own daily_tx_rewards/reward_claims bookkeeping, which only
// tracks what the app itself has seen succeed. Reading this directly lets
// the UI correctly hide/disable claiming once the on-chain cap is actually
// exhausted, instead of only finding out via a failed transaction.
export async function getDailyClaimedOnChain(walletAddress: string): Promise<number> {
  if (!REWARDS_CONTRACT || !walletAddress) return 0
  try {
    const { encodeFunctionData } = await import('viem')
    const ABI = [{
      name: 'dailyPointsClaimed',
      type: 'function' as const,
      stateMutability: 'view' as const,
      inputs: [{ name: 'user', type: 'address' as const }],
      outputs: [{ name: '', type: 'uint256' as const }],
    }]
    const data = encodeFunctionData({ abi: ABI, functionName: 'dailyPointsClaimed', args: [walletAddress as `0x${string}`] })
    const json = await arcRpcJson({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: REWARDS_CONTRACT, data }, 'latest'] })
    if (json.result && json.result !== '0x') return Number(BigInt(json.result))
    return 0
  } catch { return 0 }
}


// ─── Claim rewards (on-chain via MeshPortRewards contract) ───────────────────────
export async function claimPointsAsUSDC(params: {
  userId: string
  username: string
  walletAddress: string
  privateKey: string
  points: number
}): Promise<{ txHash: string | null; usdcReceived: number; error: string | null }> {
  const { userId, username, walletAddress, privateKey, points } = params

  if (points < MIN_CLAIM_POINTS) {
    return { txHash: null, usdcReceived: 0, error: `Minimum ${MIN_CLAIM_POINTS} points required to claim` }
  }

  // 1. Check user actually has enough points — try userId first, then wallet address fallback
  let { data: userPts } = await supabase
    .from('user_points')
    .select('total_points, user_id')
    .eq('user_id', userId)
    .maybeSingle()

  // Fallback: look up by wallet address if userId lookup returned nothing
  if (!userPts || !userPts.total_points) {
    const { data: walletPts } = await supabase
      .from('user_points')
      .select('total_points, user_id')
      .ilike('wallet_address', walletAddress)
      .maybeSingle()
    if (walletPts?.total_points) {
      userPts = walletPts
    }
  }

  const available = userPts?.total_points || 0
  if (available < points) {
    return { txHash: null, usdcReceived: 0, error: `Only ${available} points available, need ${points}` }
  }

  const usdcAmount = pointsToUSDC(points)

  // 2. Generate unique claimId
  const claimId = crypto.randomUUID().replace(/-/g, '')
  const claimIdBytes32 = ('0x' + claimId.padEnd(64, '0')) as `0x${string}`

  // 3. Create pending claim record
  const { data: claimRecord } = await supabase.from('reward_claims').insert({
    user_id: userId,
    username,
    wallet_address: walletAddress,
    points_claimed: points,
    usdc_received: usdcAmount,
    claim_id_bytes32: claimIdBytes32,
    contract_address: REWARDS_CONTRACT || null,
    status: 'pending',
  }).select().single()

  // 4. Execute on-chain claim using exact Arc docs pattern
  // Arc docs: walletClient WITHOUT chain — chain passed inline to sendTransaction
  const account = privateKeyToAccount(privateKey as `0x${string}`)
  const walletClient = createWalletClient({
    account,
    transport: arcTransport(),
  })
  const publicClient = createPublicClient({
    transport: arcTransport({ retryCount: 3, timeout: 30000 }),
  })

  const ARC_CHAIN_INLINE = {
    id: 5042002,
    name: 'Arc Testnet',
    nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
    rpcUrls: { default: { http: ARC_RPCS } },
  } as const

  if (REWARDS_CONTRACT) {
    // Check treasury balance
    const treasuryUsdc = await getTreasuryBalance()

    if (treasuryUsdc >= usdcAmount) {
      try {
        const { encodeFunctionData, parseGwei } = await import('viem')
        const callData = encodeFunctionData({ abi: REWARDS_ABI, functionName: 'claimRewards', args: [BigInt(points), claimIdBytes32] })

        // Validate with simulateContract FIRST — this uses eth_call under the
        // hood, which (unlike eth_estimateGas on Arc's testnet RPC, based on
        // what actually came back) reliably returns revert data, and viem
        // automatically decodes it into a named ContractFunctionRevertedError
        // when the ABI includes error definitions. This is what makes
        // "unknown reason" become an actual answer, and it also avoids
        // spending gas on a transaction that's guaranteed to fail.
        try {
          await publicClient.simulateContract({
            account: account.address,
            address: REWARDS_CONTRACT,
            abi: REWARDS_ABI,
            functionName: 'claimRewards',
            args: [BigInt(points), claimIdBytes32],
          })
        } catch (simErr: any) {
          const simErrorName: string | undefined =
            simErr?.cause?.data?.errorName ?? simErr?.data?.errorName ?? simErr?.cause?.errorName
          console.error('[Rewards] simulateContract revert:', simErrorName || simErr?.shortMessage || simErr?.message, simErr)
          throw Object.assign(new Error('Simulation reverted'), { simulatedErrorName: simErrorName })
        }

        // Arc docs pattern: gas estimate + 20% buffer, maxFeePerGas >= 20 Gwei, chain inline
        const nonce = await publicClient.getTransactionCount({ address: account.address, blockTag: 'pending' })
        const gasEst = await publicClient.estimateGas({ account: account.address, to: REWARDS_CONTRACT, data: callData })
        // Cast: viem's sendTransaction overload resolution (in the installed
        // viem/typescript combination) spuriously demands an EIP-4844 `kzg`
        // field for this plain EIP-1559 transaction. Runtime behavior is
        // unaffected — this is purely a type-level viem overload issue.
        const hash = await walletClient.sendTransaction({
          to: REWARDS_CONTRACT,
          data: callData,
          gas: (gasEst * 120n) / 100n,
          maxFeePerGas: parseGwei('25'),
          maxPriorityFeePerGas: parseGwei('1'),
          chain: ARC_CHAIN_INLINE,
          nonce,
        } as unknown as Parameters<typeof walletClient.sendTransaction>[0])
        const receipt = await publicClient.waitForTransactionReceipt({ hash })
        if (receipt.status === 'reverted') throw new Error('Contract call reverted')

        await supabase.from('reward_claims').update({
          tx_hash: hash, status: 'completed', claimed_at: new Date().toISOString(),
        }).eq('id', claimRecord?.id)
        await deductPoints(userId, walletAddress, points, hash)

        // Record in the shared activity table — previously this claim was
        // only ever written to reward_claims (a separate table), never to
        // activity, so a genuinely successful on-chain claim (real USDC
        // landing in the wallet) never showed up in Received/All at all.
        import('./ActivityService').then(({ Activity }) => {
          Activity.receive({
            walletAddress,
            userId,
            txHash: hash,
            amount: usdcAmount,
            fromAddress: REWARDS_CONTRACT || '',
            fromUsername: 'MeshPort Reward',
            note: `${points} points claimed`,
            receiveKind: 'reward_claim',
          })
        }).catch(() => {})

        // In-app notification — guaranteed to show regardless of push state
        import('./notifications').then(({ notifyRewardClaimed }) => {
          notifyRewardClaimed({ usdcAmount, points })
        }).catch(() => {})

        // Push notification — uses the real users.id (same id
        // enablePushNotifications() saved the subscription under), NOT the
        // `userId` param above: for wallet-only accounts that's a
        // `wallet_<addr>` pseudo-id used only by the rewards tables, which
        // never matches a push_subscriptions row. sendPushToSelf also
        // attaches this account's own session token, which action=send now
        // requires.
        const pushUserId = useAuthStore.getState().user?.id
        if (pushUserId) {
          import('./pushNotifications').then(({ sendPushToSelf }) => {
            sendPushToSelf(pushUserId, {
              title: 'Reward Claimed',
              body:  `+${trimTrailingZeros(usdcAmount.toFixed(2))} USDC for ${points} points`,
              url:   '/rewards',
              tag:   `claim-${hash}`,
            })
          }).catch(() => {})
        }

        return { txHash: hash, usdcReceived: usdcAmount, error: null }
      } catch (err: any) {
        // sendTransaction (unlike writeContract) never auto-decodes custom
        // errors even with the ABI present — the raw revert data has to be
        // pulled out and decoded by hand. Prefer the name already captured
        // by the simulateContract pre-check above (most reliable — it uses
        // eth_call, which returns revert data even when eth_estimateGas on
        // this RPC does not), falling back to manual decoding for anything
        // that reverts only at the actual send/estimate stage.
        let errorName: string | undefined = err?.simulatedErrorName
        if (!errorName) {
          try {
            const rawData: `0x${string}` | undefined =
              err?.cause?.cause?.data ?? err?.cause?.data ?? err?.data
            if (rawData && rawData.startsWith('0x') && rawData.length > 2) {
              const { decodeErrorResult } = await import('viem')
              errorName = decodeErrorResult({ abi: REWARDS_ABI, data: rawData }).errorName
            }
          } catch { /* raw data missing or not one of our known errors — fall through */ }
        }

        const FRIENDLY_ERRORS: Record<string, string> = {
          DailyLimitExceeded:   `You've hit today's 200-point claim limit per wallet — try again after midnight UTC.`,
          InsufficientTreasury: 'The rewards treasury ran out of USDC between checking and claiming — try again shortly.',
          AlreadyClaimed:       'This claim was already processed — refresh the page, your points should already be updated.',
          InsufficientPoints:   'You need at least 100 points to claim.',
          ZeroPoints:           'Select at least 100 points to claim.',
          ContractPaused:       'Reward claims are temporarily paused — try again later.',
          TransferFailed:       'The USDC transfer failed on-chain — your points were not deducted, try again.',
          NotOwner:             'Unexpected permissions error — please contact support.',
        }
        const msg = (errorName && FRIENDLY_ERRORS[errorName]) || err?.shortMessage || err?.message || 'Contract error'
        console.error('[Rewards] On-chain claim failed:', errorName || msg, err)
        // Mark as failed — do NOT fake success
        await supabase.from('reward_claims').update({ status: 'failed' }).eq('id', claimRecord?.id)
        return { txHash: null, usdcReceived: 0, error: `Claim failed: ${msg}. Your points are safe.` }
      }
    } else {
      // Treasury genuinely empty — honest error, do NOT deduct points
      await supabase.from('reward_claims').update({ status: 'treasury_empty' }).eq('id', claimRecord?.id)
      return {
        txHash: null,
        usdcReceived: 0,
        error: `Rewards treasury is empty (has ${trimTrailingZeros(treasuryUsdc.toFixed(4))} USDC, need ${trimTrailingZeros(usdcAmount.toFixed(4))} USDC). Your points are safe — try again later.`,
      }
    }
  }

  // No contract deployed — honest message, do NOT deduct points or fake success
  await supabase.from('reward_claims').update({ status: 'pending_contract' }).eq('id', claimRecord?.id)
  return {
    txHash: null,
    usdcReceived: 0,
    error: 'Rewards contract not yet deployed. Your points are saved and will be claimable once the contract is live.',
  }
}

// ─── Deduct points after successful claim ─────────────────────────────────────
async function deductPoints(userId: string, walletAddress: string, points: number, txHash: string | null) {
  // Record deduction
  await supabase.from('point_transactions').insert({
    user_id: userId,
    wallet_address: walletAddress,
    points: -points,
    reason: 'claim_deduction',
    tx_hash: txHash,
  })
  // Update balance
  const { data: current } = await supabase
    .from('user_points').select('total_points').eq('user_id', userId).maybeSingle()
  await supabase.from('user_points').update({
    total_points: Math.max(0, (current?.total_points || 0) - points),
    updated_at: new Date().toISOString(),
  }).eq('user_id', userId)
}

// ─── Fetch points already claimed today (for daily cap enforcement) ───────────
export async function fetchDailyClaimedPoints(userId: string): Promise<number> {
  const today = new Date().toISOString().split('T')[0]
  const { data } = await supabase
    .from('reward_claims')
    .select('points_claimed')
    .eq('user_id', userId)
    .eq('status', 'completed')
    .gte('claimed_at', `${today}T00:00:00Z`)
    .lt('claimed_at', `${today}T23:59:59Z`)
  return (data || []).reduce((sum: number, r: any) => sum + (r.points_claimed || 0), 0)
}

// ─── Fetch claims history ─────────────────────────────────────────────────────
export async function fetchClaimsHistory(userId: string) {
  const { data } = await supabase
    .from('reward_claims')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(20)
  return data || []
}

// ─── Fetch point transactions history ─────────────────────────────────────────
export async function fetchPointHistory(userId: string) {
  const { data } = await supabase
    .from('point_transactions')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(50)
  return data || []
}
