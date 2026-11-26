// Unified Balance deposits whose outcome is unknown (Circle App Kit 1.23).
//
// When a Gateway deposit was broadcast but waiting for its receipt failed, the
// kit no longer revokes the allowance (the deposit may still execute) and
// throws a FATAL KitError: "Deposit outcome unknown: … Check its status before
// retrying.", with the deposit's hash in cause.trace.txHash. Depositing again
// could move the money twice, so MeshPort's flows take that hash and wait for
// the deposit itself instead.

/** The broadcast deposit's hash from an "outcome unknown" kit error, else null. */
export function depositOutcomeUnknownTx(e: unknown): string | null {
  const err = e as { message?: unknown; cause?: { trace?: { txHash?: unknown } } } | null
  if (!err || typeof err.message !== 'string' || !err.message.startsWith('Deposit outcome unknown')) return null
  const h = err.cause?.trace?.txHash
  return typeof h === 'string' && /^0x[0-9a-fA-F]{64}$/.test(h) ? h : null
}

export type DepositOutcome = 'success' | 'reverted' | 'unknown'

/** Waits for a deposit's receipt on `appChain` (e.g. 'Arc_Testnet', 'Base_Sepolia'). */
export async function waitForDepositOutcome(appChain: string, txHash: string, timeoutMs = 120_000): Promise<DepositOutcome> {
  try {
    const { getClient } = await import('@/blockchain/ProviderManager')
    const receipt = await getClient(appChain as never).waitForTransactionReceipt({ hash: txHash as `0x${string}`, timeout: timeoutMs })
    return receipt?.status === 'reverted' ? 'reverted' : 'success'
  } catch {
    return 'unknown'
  }
}
