// ── Balance after a transaction (pay, swap, transfer, bring, bulk) ─────────
// What payment apps do: the new balance shows at once, then the real one
// from the chain replaces it.
//
//   1. `spent` given (a USDC payment): the balance drops by it immediately.
//      `balances` given (a swap: what each token was and now is): every
//      token shows its new amount immediately - USDC in the store, EURC /
//      cirBTC in the saved slot Home and Swap paint from (pendingTxBalance).
//   2. The cached reads are dropped and USDC is read from the chain - again
//      a few times over ~15s while it still shows the pre-transaction value
//      (an RPC node can answer from a block before the transaction landed),
//      so a stale first answer no longer sticks until the next 90s poll.
//   3. Home is told to re-read EURC / cirBTC too (BALANCES_STALE_EVENT).
//
// A failed read never writes $0: the shown balance stays.
import { useWalletStore } from '@/store'
import { refreshScope } from '@/blockchain/BlockchainManager'
import { saveAssetSlot } from './assetSlot'

export type TxToken = 'USDC' | 'EURC' | 'CIRBTC'
/** A token's amount before the transaction and the amount it leaves. */
export type TxBalances = Partial<Record<TxToken, { before: number; after: number }>>

export const BALANCES_STALE_EVENT = 'meshport:balances-stale'

// When this wallet last moved funds (any token). Home wasn't necessarily on
// screen to hear BALANCES_STALE_EVENT (the swap ran on the Swap page), so it
// checks this when it opens and re-reads EURC / cirBTC until they settle.
let lastTxAt = 0
export function msSinceLastTx(): number { return lastTxAt ? Date.now() - lastTxAt : Infinity }
let lastTxBalances: { address: string; balances: TxBalances } | null = null

/**
 * The amount a transaction just left for this token (shown at once), and the
 * amount before it: a chain read still equal to `before` is a node a block
 * behind - keep showing `after` until the chain moves (or the reads run out).
 */
/** A read that still shows the pre-transaction amount: a node a block behind - don't show it over the new one. */
export function isLaggingRead(address: string | null | undefined, token: TxToken, value: number): boolean {
  const p = pendingTxBalance(address, token)
  return !!p && Math.abs(value - p.before) < 1e-9 && Math.abs(value - p.after) > 1e-9
}

export function pendingTxBalance(address: string | null | undefined, token: TxToken): { before: number; after: number } | null {
  if (!address || !lastTxBalances || msSinceLastTx() > 30_000) return null
  if (lastTxBalances.address.toLowerCase() !== address.toLowerCase()) return null
  return lastTxBalances.balances[token] ?? null
}
// Gaps between the follow-up reads while the chain still shows the old value.
const RETRY_GAPS_MS = [1500, 2000, 3500, 5000]

const sameWallet = (address: string) => {
  const cur = useWalletStore.getState()._currentAddr
  return !cur || cur.toLowerCase() === address.toLowerCase()
}

export function refreshBalancesAfterTx(address: string | null | undefined, opts: { spent?: number; balances?: TxBalances } = {}): void {
  if (!address) return
  lastTxAt = Date.now()
  lastTxBalances = opts.balances ? { address, balances: opts.balances } : null
  const store = useWalletStore.getState()
  const usdc = opts.balances?.USDC
  const before = usdc?.before ?? store.balance
  const optimistic = usdc ? usdc.after : opts.spent && opts.spent > 0 ? Math.max(0, before - opts.spent) : null
  if (optimistic !== null && sameWallet(address)) store.setBalance(optimistic)
  // EURC / cirBTC: the saved amounts Home (and Swap) paint from.
  const eurc = opts.balances?.EURC, cirbtc = opts.balances?.CIRBTC
  if (eurc || cirbtc) saveAssetSlot(address, { ...(eurc ? { eurc: eurc.after } : {}), ...(cirbtc ? { cirbtc: cirbtc.after } : {}) })
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
      if (changed || optimistic === null || attempt >= RETRY_GAPS_MS.length) useWalletStore.getState().setBalance(bal)
      if (changed) return // the chain has it - done
    } catch { /* keep what's shown; try again */ }
    if (attempt < RETRY_GAPS_MS.length) setTimeout(read, RETRY_GAPS_MS[attempt++])
  }
  void read()
}
