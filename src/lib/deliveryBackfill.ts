// A Bring of EURC / cirBTC has no claims row: its Activity row is saved when
// the send leaves, and Circle's Arc delivery hash only exists later. New
// brings record it (MultichainClaimPage); this fills it in for completed
// rows saved without one, so every history card can link to ArcScan.
import { CCTP_DOMAINS, waitForForwardTx } from './cctpTracker'
import { setActivityDestinationTx } from './ActivityService'

export interface BringDeliveryRow {
  txHash?: string
  /** The chain the send left from (MeshPort chain id). */
  sourceChain?: string
  tokenSymbol?: string
  walletAddress: string
  destinationTxHash?: string
  /** The row says the bring finished. */
  completed: boolean
}

/** A finished EURC / cirBTC bring with no Arc delivery hash on record. Pure. */
export function needsDeliveryHash(r: BringDeliveryRow): boolean {
  return r.completed && !r.destinationTxHash && !!r.txHash && /^0x[0-9a-fA-F]{64}$/.test(r.txHash)
    && (r.tokenSymbol === 'EURC' || r.tokenSymbol === 'cirBTC')
    && !!r.sourceChain && r.sourceChain in CCTP_DOMAINS
}

// One lookup per send for the session, shared by whoever asks first.
const lookups = new Map<string, Promise<string | null>>()
/** Has this send already been looked up (so a list can move on to the next one)? */
export const deliveryLookedUp = (txHash?: string) => !!txHash && lookups.has(txHash.toLowerCase())

/**
 * Asks Circle once for the row's Arc delivery hash and saves it on the row.
 * Returns the hash, or null when the row doesn't need one or Circle has no answer.
 */
export function backfillDeliveryHash(r: BringDeliveryRow): Promise<string | null> {
  if (!needsDeliveryHash(r)) return Promise.resolve(null)
  const key = r.txHash!.toLowerCase()
  let p = lookups.get(key)
  if (!p) {
    // A single look (one Iris round trip), not a wait: Circle has long since delivered a completed bring.
    p = waitForForwardTx(r.sourceChain!, r.txHash!, () => true, 50, 0).then(async hash => {
      if (hash) await setActivityDestinationTx(r.txHash!, r.walletAddress, hash)
      return hash
    }).catch(() => null)
    lookups.set(key, p)
  }
  return p
}
