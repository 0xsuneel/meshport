// Failed-transaction history for every money feature: Pay, Chat Pay, Bulk
// Pay, Swap, Transfer Funds, Bring Funds, P2P and MeshPort Rewards claims.
//
// classifyFailure() turns whatever a feature caught into one exact, readable
// reason, and says whether the failure is DEFINITE:
//   definite  - nothing moved (or it reverted): refused by the network,
//               reverted on-chain, not enough USDC, slippage, quote expired,
//               wallet unavailable, escrow paused, ...
//   uncertain - it may still land: a receipt wait that timed out, a dropped
//               connection after sending, "may still complete" (Architecture
//               rule 5: SUBMITTED_UNKNOWN is never FAILED). Never recorded.
//   cancelled - you backed out (wallet popup rejected). Never recorded.
//
// recordFailure() writes the definite ones to the activity ledger as a
// status 'failed' row, reason in the `error` column. Failed rows are history
// only: they never count as money moved (see InsightsPage / recentContacts).
//
// Transfer / Bring Funds only record a failure here when nothing left the
// wallet (metadata.nothing_moved). Once a burn or Unified Balance deposit has
// happened the move is finished through Recover instead - those rows show
// "Needs recovery", not "Failed" (see needsRecovery()).

export type FailureFeature = 'pay' | 'chat_pay' | 'bulk_pay' | 'swap' | 'transfer' | 'bring' | 'p2p' | 'rewards'

export type FailureCode =
  | 'insufficient_funds' | 'insufficient_gas' | 'reverted' | 'rejected' | 'nonce'
  | 'wallet_unavailable' | 'slippage' | 'quote_expired' | 'paused' | 'not_allowed'
  | 'invalid_recipient' | 'service_unavailable' | 'cancelled' | 'uncertain' | 'unknown'

export type Failure = { code: FailureCode; message: string; definite: boolean }

/** One exact, readable sentence per reason. Shown in Activity and the Hub. */
export const FAILURE_MESSAGES: Record<FailureCode, string> = {
  insufficient_funds: 'Not enough balance for this amount - nothing was sent.',
  insufficient_gas: 'Not enough USDC left for the network fee - nothing was sent.',
  reverted: 'Rejected on-chain - nothing was sent. A small network fee may have been used.',
  rejected: 'The network refused the transaction - nothing was sent.',
  nonce: 'Another transaction from your wallet was still in progress - nothing was sent.',
  wallet_unavailable: "Couldn't access your wallet on this device - nothing was sent.",
  slippage: 'The price moved more than your slippage limit - nothing was swapped.',
  quote_expired: 'The price quote expired before it was confirmed - nothing was swapped.',
  paused: 'P2P escrow is paused by an admin - nothing was moved.',
  not_allowed: 'This payment is not allowed for this person - nothing was sent.',
  invalid_recipient: 'The recipient address is not valid - nothing was sent.',
  service_unavailable: 'The service was unavailable - nothing was sent. Please try again.',
  cancelled: 'You cancelled it.',
  uncertain: 'Not confirmed yet - it may still complete. Check Activity before retrying.',
  unknown: 'It failed - nothing was sent.',
}

const has = (s: string, ...needles: (string | RegExp)[]) =>
  needles.some(n => (typeof n === 'string' ? s.includes(n) : n.test(s)))

/** An error's own words, without viem's request / calldata dump, on one line. */
export function cleanErrorText(raw: string): string {
  let s = String(raw || '').split(/\n\s*(?:Request Arguments|Details|Version|Contract Call|URL|Request body|Raw Call Arguments|Docs):/i)[0]
  s = s.split('\n').map(l => l.trim()).filter(Boolean).join(' ')
  s = s.replace(/0x[0-9a-fA-F]{40,}/g, m => `${m.slice(0, 6)}…${m.slice(-4)}`).replace(/\s+/g, ' ').trim()
  return s.length > 160 ? s.slice(0, 157) + '…' : s
}

/** The contract's own revert reason, when the error carries one. */
export function revertReason(raw: string): string | null {
  const s = String(raw || '')
  const m = /reverted with (?:the following )?reason(?: string)?:?\s*['"]?([^'"\n]{2,120})/i.exec(s)
    ?? /execution reverted:\s*['"]?([^'"\n]{2,120})/i.exec(s)
  const r = m?.[1]?.trim().replace(/[.\s]+$/, '')
  return r && !/^0x[0-9a-f]*$/i.test(r) ? r.charAt(0).toUpperCase() + r.slice(1) : null
}

export function classifyFailure(err: unknown, opts: { reverted?: boolean } = {}): Failure {
  const e: any = err
  const fail = (code: FailureCode, definite = true, message = FAILURE_MESSAGES[code]): Failure => ({ code, definite, message })
  if (opts.reverted) return fail('reverted')
  if (e?.isUncertain) return fail('uncertain', false)
  const raw = String(e?.shortMessage ?? e?.reason ?? e?.message ?? e ?? '')
  const s = raw.toLowerCase()

  if (e?.name === 'UserRejectedRequestError' || e?.code === 4001 || has(s, 'user rejected', 'user denied', 'rejected the request')) return fail('cancelled', false)
  // It may still land - never a failure (Architecture rule 5).
  if (e?.name === 'WaitForTransactionReceiptTimeoutError' || has(s, 'may still complete', 'not confirmed yet', 'timed out while waiting', 'status unclear', 'still be processing'))
    return fail('uncertain', false)
  if (has(s, 'reverted', 'always failing transaction', 'rejected on-chain', 'execution reverted')) {
    const why = revertReason(raw)
    return fail('reverted', true, why ? `Rejected on-chain: ${why} - nothing was sent.` : FAILURE_MESSAGES.reverted)
  }
  if (has(s, 'insufficient funds for gas', 'gas required exceeds', 'intrinsic gas', 'for the network fee', 'not enough usdc left for gas', 'not enough gas')) return fail('insufficient_gas')
  if (has(s, 'insufficient', 'exceeds balance', 'exceeds available', 'transfer amount exceeds', 'not enough')) return fail('insufficient_funds')
  if (has(s, 'nonce too low', 'replacement transaction underpriced', 'nonce has already been used', 'already known')) return fail('nonce')
  if (has(s, 'slippage', 'too little received', 'insufficient_output', 'price impact')) return fail('slippage')
  if (has(s, 'quote expired', 'quote has expired', 'expired quote', 'stale quote')) return fail('quote_expired')
  if (has(s, 'paused')) return fail('paused')
  if (has(s, "couldn't access your wallet", 'could not access your wallet', 'wallet unavailable', 'wallet not available', 'no private key', "couldn't access a wallet")) return fail('wallet_unavailable')
  if (has(s, 'has blocked you', 'only accepts payments from their contacts', 'not allowed')) return fail('not_allowed', true, cleanErrorText(raw) || FAILURE_MESSAGES.not_allowed)
  if (has(s, 'invalid address', 'invalid recipient')) return fail('invalid_recipient')
  // Lost connection / gateway trouble: the transaction may already be out.
  if (has(s, 'fetch failed', 'failed to fetch', 'network', 'timeout', 'timed out', '502', '503', '504', 'bad gateway', 'gateway timeout', 'no runners', 'connection'))
    return fail('uncertain', false)
  if (has(s, 'transaction rejected', 'rejected')) return fail('rejected')
  if (has(s, 'unavailable', 'quota', 'rate limit', '429')) return fail('service_unavailable')
  const text = cleanErrorText(raw)
  return fail('unknown', true, text ? `${text.replace(/[.\s]+$/, '')} - nothing was sent.` : FAILURE_MESSAGES.unknown)
}

/**
 * Like classifyFailure, for an error thrown BEFORE anything was broadcast
 * (pre-checks, quote, preparing the transaction): a network error there is
 * a definite "nothing was sent", not an uncertain outcome.
 */
export function classifyPreBroadcastFailure(err: unknown): Failure {
  const f = classifyFailure(err)
  if (f.code !== 'uncertain') return f
  return { code: 'service_unavailable', definite: true, message: 'Lost connection before sending - nothing was sent. Please try again.' }
}

/** A failed Transfer / Bring Funds row whose money already moved: finish it in Recover. */
export function needsRecovery(r: { activityType?: string; status?: string; metadata?: any }): boolean {
  return r.status === 'failed' && (r.activityType === 'bridge' || r.activityType === 'claim') && !r.metadata?.nothing_moved
}

/** The reason to show for a failed row (null when it has none). */
export function failureReason(r: { error?: string | null; metadata?: any }): string | null {
  const v = r.error || r.metadata?.failure_reason
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

type RecordParams = {
  feature: FailureFeature
  walletAddress: string | null | undefined
  amount: number
  token?: string
  /** Who it was for (Pay / Chat Pay recipient, Transfer destination address). */
  counterparty?: string | null
  sourceChain?: string
  destinationChain?: string
  /** A real transaction hash, when one reverted on-chain (shown with an explorer link). */
  txHash?: string | null
  failure: Failure
  metadata?: Record<string, unknown>
}

const ACTIVITY_TYPE: Record<Exclude<FailureFeature, 'p2p'>, 'send' | 'receive' | 'bulk' | 'swap' | 'bridge' | 'claim'> = {
  pay: 'send', chat_pay: 'send', bulk_pay: 'bulk', swap: 'swap', transfer: 'bridge', bring: 'claim',
  // A rewards claim is money coming in (receiveKind 'reward_claim').
  rewards: 'receive',
}

/**
 * Writes one failed row to the activity ledger. Only definite failures;
 * returns false (and writes nothing) for uncertain / cancelled ones.
 * Never throws - a failure record must never break the failure screen.
 */
export async function recordFailure(p: RecordParams & { p2pType?: 'p2p_sell_order' | 'p2p_refund' | 'p2p_purchase' }): Promise<boolean> {
  if (!p.walletAddress || !p.failure.definite) return false
  try {
    const { saveActivity } = await import('./ActivityService')
    const id = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}_${Math.random().toString(36).slice(2)}`
    const activityType = p.feature === 'p2p' ? (p.p2pType ?? 'p2p_sell_order') : ACTIVITY_TYPE[p.feature]
    const nothingMoved = p.feature === 'transfer' || p.feature === 'bring'
    return await saveActivity({
      walletAddress: p.walletAddress,
      // 'fail_' keys are never shown as a hash (see ActivityService.fromRow);
      // a reverted transaction's real hash rides in metadata.failed_tx_hash.
      txHash: `fail_${id}`,
      activityType,
      amount: Math.max(0, Number(p.amount) || 0),
      tokenSymbol: p.token ?? 'USDC',
      sourceChain: p.sourceChain,
      destinationChain: p.destinationChain,
      counterpartyAddress: p.counterparty ?? undefined,
      status: 'failed',
      explorerUrl: '',
      error: p.failure.message,
      metadata: {
        ...(p.metadata ?? {}),
        failure_feature: p.feature,
        failure_code: p.failure.code,
        failure_reason: p.failure.message,
        ...(p.txHash ? { failed_tx_hash: p.txHash.toLowerCase() } : {}),
        ...(nothingMoved ? { nothing_moved: true } : {}),
      },
    })
  } catch (e) {
    console.warn('[failure] could not record failed activity:', e instanceof Error ? e.message : e)
    return false
  }
}
