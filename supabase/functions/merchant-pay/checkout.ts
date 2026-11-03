// supabase/functions/merchant-pay/checkout.ts
// Reading a MeshPortCheckout payment (contracts/MeshPortCheckout.sol) from a
// receipt - pure (no Deno APIs), so it is tested with the app's vitest.

/** keccak256('Paid(address,address,bytes32,uint256,uint256)') */
export const CHECKOUT_PAID_TOPIC = '0xd56bd66d88b32d3be3ce941b0583d226db715ff80336148925cb9acf8800c34a'

// deno-lint-ignore no-explicit-any
/** This receipt's checkout payment to `merchant`: the payer, the order reference and the full price (6-decimal amount), or null. */
export function checkoutPaid(receipt: any, merchant: string, checkout: string): { payer: string; orderRef: string; price: number; fee: number } | null {
  checkout = (checkout || '').toLowerCase()
  if (!checkout) return null
  const want = '0x' + merchant.replace(/^0x/, '').toLowerCase().padStart(64, '0')
  for (const l of receipt?.logs ?? []) {
    if (String(l.address).toLowerCase() !== checkout) continue
    if (String(l.topics?.[0]).toLowerCase() !== CHECKOUT_PAID_TOPIC) continue
    if (String(l.topics?.[2]).toLowerCase() !== want) continue
    const data = String(l.data ?? '').replace(/^0x/, '')
    if (data.length < 128) continue
    try {
      const price = BigInt('0x' + data.slice(0, 64)), fee = BigInt('0x' + data.slice(64, 128))
      return {
        payer: ('0x' + String(l.topics?.[1]).slice(-40)).toLowerCase(),
        orderRef: String(l.topics?.[3] ?? '').toLowerCase(),
        price: Number(price / 1_000_000_000_000n) / 1e6,
        fee: Number(fee / 1_000_000_000_000n) / 1e6,
      }
    } catch { continue }
  }
  return null
}

