// A bill's lines beyond its items (discount, tax name, store address,
// footer) for the pay page and the chat card - read once per bill.
import { useEffect, useState } from 'react'
import { fetchBillDetails, type BillDetails } from '@/lib/merchantPay'

const cache = new Map<string, BillDetails | null>()

export function useBillDetails(code: string | null | undefined, isBill: boolean): BillDetails | null {
  const [d, setD] = useState<BillDetails | null>(() => (code && cache.get(code)) || null)
  useEffect(() => {
    if (!code || !isBill) { setD(null); return }
    if (cache.has(code)) { setD(cache.get(code) ?? null); return }
    let live = true
    void fetchBillDetails(code).then(v => { cache.set(code, v); if (live) setD(v) })
    return () => { live = false }
  }, [code, isBill])
  return d
}
