// A short receipt number people can read out or quote ("MP-AC19A786"), as a
// payments app shows a transaction ID. Taken from the payment's transaction,
// so the business's receipt and the customer's payment show the same number.
export function receiptNumber(txHash: string | null | undefined): string | null {
  const h = String(txHash ?? '').replace(/^(send_|recv_)/, '')
  const hex = /^0x([0-9a-f]{8})/i.exec(h)?.[1]
  if (hex) return `MP-${hex.toUpperCase()}`
  // A Solana signature (base58): its first 8 characters.
  return /^[1-9A-HJ-NP-Za-km-z]{32,}$/.test(h) ? `MP-${h.slice(0, 8).toUpperCase()}` : null
}
