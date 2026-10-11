// Fees on a gasless Bring Funds (CCTP), for the success screen.
//
// Two parts, known at different times:
//  - MeshPort's fee - fixed in the signed transfer, taken before the burn.
//  - Circle's CCTP fee - the transfer only signs a CAP for it (maxFee: the
//    quoted protocol + forwarding fee plus 20%, see bridge-relay
//    cctpMaxFee). What Circle really took is only known once the funds land
//    on Arc: burned amount − arrived amount.
// So until the claim completes, Circle's part is shown as "up to" the cap,
// never as if the cap had been charged.

export interface SignedClaimFee {
  /** MeshPort's fee (USDC). */
  meshport: number
  /** The most Circle's CCTP fee can be (USDC). */
  circleCap: number
}

export interface ClaimForFees {
  sourceChain: string
  /** Burned amount (after MeshPort's fee). */
  amount: number
  arrivedAmount: number | null
  status: string
}

export interface ClaimFeeSummary {
  meshport: number
  /** Circle fee actually taken, for the chains that have arrived. */
  circle: number
  /** Circle fee cap, for the chains still on the way. */
  circleCap: number
  /** Every chain has arrived - circle is final. */
  final: boolean
}

export function claimFeeSummary(signed: Record<string, SignedClaimFee>, claims: ClaimForFees[]): ClaimFeeSummary {
  let meshport = 0, circle = 0, circleCap = 0, pending = false
  for (const [chainId, f] of Object.entries(signed)) {
    meshport += f.meshport
    const done = claims.find(c => c.sourceChain === chainId && c.status === 'completed' && c.arrivedAmount != null)
    if (done) circle += Math.max(0, done.amount - (done.arrivedAmount as number))
    else { circleCap += f.circleCap; pending = true }
  }
  return { meshport, circle, circleCap, final: !pending }
}
