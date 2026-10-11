// Unified Balance transfer (Multichain Hub → Transfer Funds): what each fee
// does to the money, shared by the Review estimate and the real send
// (MultichainTransferPage) so the two can't drift apart.
//
// How the send moves the money: the typed amount (`deposit`) goes into the
// Unified Balance; the spend is the deposit minus the Gateway protocol fee +
// burn gas ('provider' + 'gasFee', which Gateway takes from the balance
// alongside the spend) and a small safety margin; Circle then carves the
// custom + forwarding fees ('kit' + 'forwarder') out of the spend before
// minting. So every fee comes out of the amount typed.

export interface UbFees { providerFee: number; gasFee: number; kitFee: number; forwarderFee: number }

/** Headroom kept back from the spend so a small fee rise between estimate
 *  and send can't fail it - 3% of the Gateway fee + gas, at least 0.0005 and
 *  at most 0.01 USDC. It stays in the person's Unified Balance. */
export function ubSpendMargin(spendOverhead: number): number {
  return Math.min(0.01, Math.max(0.0005, spendOverhead * 0.03))
}

/** The amount to spend out of what was deposited. */
export function ubSpendAmount(deposit: number, spendOverhead: number): number {
  return Math.max(0, deposit - spendOverhead - ubSpendMargin(spendOverhead))
}

/** The Review numbers for a deposit of `deposit` USDC. */
export function ubFeeBreakdown(deposit: number, f: UbFees) {
  const spendOverhead = f.providerFee + f.gasFee
  const margin = ubSpendMargin(spendOverhead)
  // Burn gas + the margin, together the "Network Gas" row.
  const networkFee = f.gasFee + margin
  const totalFee = f.providerFee + f.kitFee + f.forwarderFee + networkFee
  const receiverGets = Math.max(0, deposit - totalFee)
  return { spendOverhead, networkFee, totalFee, receiverGets }
}
