// lib/tokenSnapshot.ts
//
// EURC / cirBTC balances - on Arc and on every chain Circle's CCTPx registry
// lists them on, with each chain's token address - from the same
// /api/portfolio call that reads USDC (blockchain/externalBalanceReader). So
// when the Hub scans USDC, the EURC and cirBTC chips already have their chains
// and balances: picking one shows them at once, like USDC, instead of looking
// up Circle's registry and reading every chain again.
//
// Screens read the latest snapshot (useTokenSnapshot) and fall back to their
// own reads when there isn't one yet (an older server, or no scan so far).

import { useEffect, useState } from 'react'
import type { CctpxToken } from './tokenBridge'

export type TokenChain = { balance: number | null; address: string }
export interface TokenSnapshot {
  /** On Arc: EURC / cirBTC (null: couldn't read). */
  arc: Partial<Record<CctpxToken, number | null>>
  /** Per token: chain id → its balance and the token's address there. Null when the server couldn't read Circle's registry. */
  tokens: Record<CctpxToken, Record<string, TokenChain>> | null
  at: number
}

const EVENT = 'meshport:token-snapshot'
const snaps = new Map<string, TokenSnapshot>()

/** Keep the EURC / cirBTC part of a /api/portfolio answer for `wallet`. */
export function notePortfolio(wallet: string, json: any): void {
  if (!json || typeof json !== 'object') return
  const tokens = json.tokens && typeof json.tokens === 'object' && json.tokens.EURC && json.tokens.cirBTC ? json.tokens : null
  const arc = json.arc && typeof json.arc === 'object' ? { EURC: json.arc.EURC ?? null, cirBTC: json.arc.cirBTC ?? null } : {}
  const key = wallet.toLowerCase()
  const prev = snaps.get(key)
  // A server answer without tokens (older server, registry down) keeps the last known chains.
  snaps.set(key, { arc, tokens: tokens ?? prev?.tokens ?? null, at: Date.now() })
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(EVENT, { detail: { wallet: key } }))
}

export function peekTokenSnapshot(wallet: string | null | undefined): TokenSnapshot | null {
  return wallet ? snaps.get(wallet.toLowerCase()) ?? null : null
}

/** The latest snapshot for `wallet`, re-rendering when a scan brings a new one. */
export function useTokenSnapshot(wallet: string | null | undefined): TokenSnapshot | null {
  const [snap, setSnap] = useState(() => peekTokenSnapshot(wallet))
  useEffect(() => {
    setSnap(peekTokenSnapshot(wallet))
    if (!wallet) return
    const key = wallet.toLowerCase()
    const on = (e: Event) => { if ((e as CustomEvent).detail?.wallet === key) setSnap(peekTokenSnapshot(wallet)) }
    window.addEventListener(EVENT, on)
    return () => window.removeEventListener(EVENT, on)
  }, [wallet])
  return snap
}
