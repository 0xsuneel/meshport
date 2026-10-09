// ── Balance after a transaction (pay, swap, transfer, bring, bulk) ─────────
// What payment apps do: the new balance shows at once, then the real one
// from the chain replaces it.
//
//   1. `spent` given (a USDC payment): the balance drops by it immediately.
//   2. The cached reads are dropped and USDC is read from the chain - again
//      a few times over ~15s while it still shows the pre-transaction value
//      (an RPC node can answer from a block before the transaction landed),
//      so a stale first answer no longer sticks until the next 90s poll.
//   3. Home is told to re-read EURC / cirBTC too (BALANCES_STALE_EVENT).
//
// A failed read never writes $0: the shown balance stays.
import { useWalletStore } from '@/store'
import { refreshScope } from '@/blockchain/BlockchainManager'

export const BALANCES_STALE_EVENT = 'meshport:balances-stale'
// Gaps between the follow-up reads while the chain still shows the old value.
const RETRY_GAPS_MS = [1500, 2000, 3500, 5000]

const sameWallet = (address: string) => {
  const cur = useWalletStore.getState()._currentAddr
  return !cur || cur.toLowerCase() === address.toLowerCase()
}

export function refreshBalancesAfterTx(address: string | null | undefined, opts: { spent?: number } = {}): void {
  if (!address) return
  const store = useWalletStore.getState()
  const before = store.balance
  if (opts.spent && opts.spent > 0 && sameWallet(address)) {
    store.setBalance(Math.max(0, before - opts.spent))
  }
  try { refreshScope({ kind: 'arc', wallet: address }) } catch { /* cache only */ }
  try { window.dispatchEvent(new CustomEvent(BALANCES_STALE_EVENT, { detail: { address } })) } catch { /* no window */ }

  let attempt = 0
  const read = async () => {
    try {
      const { readUSDCBalanceOrThrow } = await import('@/lib/arcService')
      const bal = await readUSDCBalanceOrThrow(address)
      if (!sameWallet(address)) return // wallet switched meanwhile
      const changed = Math.abs(bal - before) > 1e-9
      // Still the old figure: keep the instant (spent) one while retrying;
      // after the last try the chain's answer wins whatever it is.
      if (changed || !opts.spent || attempt >= RETRY_GAPS_MS.length) useWalletStore.getState().setBalance(bal)
      if (changed) return // the chain has it - done
    } catch { /* keep what's shown; try again */ }
    if (attempt < RETRY_GAPS_MS.length) setTimeout(read, RETRY_GAPS_MS[attempt++])
  }
  void read()
}
