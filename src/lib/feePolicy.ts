// src/lib/feePolicy.ts - MeshPort's fees, one place for the app and the relayer.
//
// Pure functions, no imports: api/bridge-relay.ts and the app (lib/fastCctp,
// the Transfer / Bring / Swap screens) compute the SAME number, so what Review
// shows is what the relayer accepts.
//
// The rule (fee list agreed 3 Nov):
//   fee = percentage of the amount, at least the minimum, at most the cap -
//         but NEVER less than the live gas cost × 1.15 (GAS_MARGIN_PCT).
// So MeshPort never pays more gas than it collects, small amounts stay cheap,
// and big amounts stop at the cap (unless gas alone costs more than the cap).
//
// Every MeshPort fee goes to the relayer wallet on the chain it is collected
// on, so it pays the relayer's gas back.

/** A fee rule in the token's own units. */
export interface FeeRule { bps: number; min: bigint; cap: bigint }
/** A fee rule in US dollars (converted to a token with usdRule). */
export interface UsdFeeRule { bps: number; minUsd: number; capUsd: number }

/** Live gas cost × 1.15: the floor under every fee where MeshPort pays the gas. */
export const GAS_MARGIN_PCT = 115n

// ── The fee list ─────────────────────────────────────────────────────────────
/** Transfer / Bring / UB / Solana Bring: 0.2%, min $0.05, cap $5. */
export const CROSS_CHAIN_FEE: UsdFeeRule = { bps: 20, minUsd: 0.05, capUsd: 5 }
/** Swap (USDC ↔ EURC ↔ cirBTC): 0.35% in the rate, cap $10. */
export const SWAP_FEE: UsdFeeRule = { bps: 35, minUsd: 0, capUsd: 10 }
/** Merchant payments: 0.6%, cap $3, paid by the merchant. */
export const MERCHANT_FEE: UsdFeeRule = { bps: 60, minUsd: 0, capUsd: 3 }
/** P2P trades: 0.2% on the taker, cap $5. */
export const P2P_FEE: UsdFeeRule = { bps: 20, minUsd: 0, capUsd: 5 }
/** Bulk payouts: 0.25% per payout, cap $1 per recipient. */
export const BULK_PAYOUT_FEE: UsdFeeRule = { bps: 25, minUsd: 0, capUsd: 1 }

/** A dollar rule in a token's units at `tokenUsd` dollars per token. */
export function usdRule(r: UsdFeeRule, decimals: number, tokenUsd = 1): FeeRule {
  const units = (usd: number) => BigInt(Math.round((usd / (tokenUsd > 0 ? tokenUsd : 1)) * 10 ** decimals))
  return { bps: r.bps, min: units(r.minUsd), cap: units(r.capUsd) }
}

/** The live gas cost × 1.15, rounded up. */
export function gasFloor(gasCost: bigint): bigint {
  return (gasCost * GAS_MARGIN_PCT + 99n) / 100n
}

/**
 * MeshPort's fee for `amount` (token units) when the gas costs `gasCost`
 * (same units; 0 where the user pays their own gas).
 */
export function meshportFee(amount: bigint, gasCost: bigint, r: FeeRule): bigint {
  let fee = (amount * BigInt(r.bps)) / 10_000n
  if (fee < r.min) fee = r.min
  if (fee > r.cap) fee = r.cap
  const floor = gasCost > 0n ? gasFloor(gasCost) : 0n
  return fee > floor ? fee : floor
}

/** Arc gas (wei of native USDC, 18 dp) → USDC units (6 dp), rounded up. */
export function arcWeiToUsdcUnits(wei: bigint): bigint {
  return (wei + 999_999_999_999n) / 1_000_000_000_000n
}

/** The relayer accepts a fee down to this share of its own quote (price moves since the quote); never below the gas floor. */
export const FEE_ACCEPT_PCT = 90n
export function feeAcceptable(fee: bigint, required: bigint, gasCost: bigint): boolean {
  return fee * 100n >= required * FEE_ACCEPT_PCT && fee >= gasCost
}
