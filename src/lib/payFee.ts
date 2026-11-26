// The most a Pay send may spend on network fees, and the fee cap that keeps
// a send inside it. Shared by the confirm screen (lib/walletConfirm - the
// wallet approves "at most PAY_MAX_FEE in fees") and the send (arcService),
// so what's signed always fits what was approved.
//
// Why the clamp: Arc nodes report very different gas prices for the same
// chain - on 26 Nov Circle's nodes said 25 gwei, drpc / Blockdaemon 130 gwei,
// the app read ~218 gwei, while the base fee was 20 gwei. The send's cap is
// twice the price it read, so a high reading made gas × cap pass the approved
// 0.05 USDC and the wallet refused the payment ("This is not the payment you
// confirmed"). A cap is only a ceiling - the network charges base fee + tip -
// so lowering it to fit changes nothing while the base fee is far below it.

/** 0.05 USDC (Arc gas is paid in USDC, 18 decimals). A Pay send costs ≈0.005. */
export const PAY_MAX_FEE = 50_000_000_000_000_000n

/** `feeCap`, lowered if needed so `gas × cap` stays within PAY_MAX_FEE. */
export function payFeeCapWithin(feeCap: bigint, gas: bigint): bigint {
  if (gas <= 0n) return feeCap
  const most = PAY_MAX_FEE / gas
  return feeCap < most ? feeCap : most
}
