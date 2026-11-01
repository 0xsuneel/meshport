// Unified Balance (Circle Gateway) fees: what each fee does to the money,
// shared by every Unified Balance spend (Transfer Funds, Bring Funds, Recover)
// so the Review estimate and the real send can't drift apart.
//
// How Gateway charges (docs.arc.io/app-kit/concepts/unified-balance-fees,
// developers.circle.com/gateway/references/fees): a spend signs a burn intent
// for `value` plus a `maxFee` cap. Gateway takes `value` + at most `maxFee`
// from the Unified Balance and mints `value` on the destination. `maxFee` is
// the source chain's gas fee + the 0.005% transfer fee + - when Circle's
// forwarder mints - the Forwarding Service fee.
//
// App Kit >= 1.19 (installed: 1.20, upgraded 31 Oct) reports that maxFee as
// THREE separate parts: 'provider', 'gasFee' WITHOUT the forwarding fee, and
// 'forwarder' (unified-balance-kit aggregateFeesByIntent:
// gasFee = inclusiveGasFee - forwardingFee; changelog 1.19: "no longer count
// the forwarding fee twice"). Before 1.19 'gasFee' already included it and
// this code took 'forwarder' as a part of 'gasFee' - after the upgrade that
// left the forwarding fee out: a forwarded spend (Base…) asked for the
// deposit + ~0.04 USDC and failed "Insufficient USDC balance", leaving the
// deposit in the Unified Balance (field 1 Nov 06:40, 1.00 USDC to Base).
// So all three are added.

export interface UbFees { providerFee: number; gasFee: number; kitFee: number; forwarderFee: number }

/** The USDC fees in an estimateSpend() result, split by type. */
export function ubQuoteFees(est: any): UbFees {
  let providerFee = 0, gasFee = 0, kitFee = 0, forwarderFee = 0
  for (const f of est?.fees ?? []) {
    // USDC fees only - a destination's own gas can be listed in its native
    // token when MeshPort's relayer mints (paid by the relayer, not the user).
    if (f?.token && f.token !== 'USDC') continue
    const amt = Number(f?.amount ?? 0) || 0
    if (f?.type === 'provider') providerFee += amt
    else if (f?.type === 'gasFee') gasFee += amt
    else if (f?.type === 'forwarder') forwarderFee += amt
    else kitFee += amt
  }
  // Some quotes only carry a total.
  if (!providerFee && !gasFee && !kitFee) gasFee = Number(est?.total ?? 0) || 0
  return { providerFee, gasFee, kitFee, forwarderFee }
}

/** What a spend takes from the Unified Balance besides its value: maxFee =
 *  Gateway fee + source gas + forwarding fee (App Kit >= 1.19 lists them
 *  apart). A custom fee, never set by MeshPort, would come out of the value. */
export function ubSpendCost(f: UbFees): number {
  return f.providerFee + f.gasFee + f.forwarderFee
}

/** The forwarding fee (its own part of maxFee). */
export function ubForwarderPart(f: UbFees): number {
  return f.forwarderFee
}

/** Headroom kept back from a spend so a small fee rise between estimate and
 *  send can't fail it - 3% of the fee, at least 0.0005 and at most 0.01 USDC.
 *  It is not a fee: it stays in the person's Unified Balance, and dust
 *  already there (`cushion`, earlier headroom or an unused part of a maxFee)
 *  stands in for it, so once there is enough of it no headroom is kept. */
export function ubSpendMargin(spendOverhead: number, cushion = 0): number {
  const m = Math.min(0.01, Math.max(0.0005, spendOverhead * 0.03))
  return Math.max(0, m - Math.max(0, cushion))
}

/** The amount to spend out of what was deposited. */
export function ubSpendAmount(deposit: number, spendOverhead: number, cushion = 0): number {
  return Math.max(0, deposit - spendOverhead - ubSpendMargin(spendOverhead, cushion))
}

/** The Review numbers for a deposit of `deposit` USDC. */
export function ubFeeBreakdown(deposit: number, f: UbFees, cushion = 0) {
  // maxFee (Gateway fee + gas + forwarding fee): taken from the balance.
  const spendOverhead = ubSpendCost(f)
  const margin = ubSpendMargin(spendOverhead, cushion)
  const forwarderFee = ubForwarderPart(f)
  // Source gas + the headroom, together the "Network Gas" row; the
  // forwarding fee has its own row ('gasFee' no longer contains it).
  const networkFee = f.gasFee + margin
  const totalFee = f.providerFee + forwarderFee + networkFee + f.kitFee
  // Gateway mints exactly the spend; a custom fee comes out of it.
  const receiverGets = Math.max(0, ubSpendAmount(deposit, spendOverhead, cushion) - f.kitFee)
  return { spendOverhead, networkFee, forwarderFee, totalFee, receiverGets }
}
