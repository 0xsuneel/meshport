// src/lib/cctpTracker.ts
//
// Progress of a CCTP move (Transfer: Arc → chain, Bring Funds: chain → Arc),
// read straight from Circle's attestation service (Iris) — not from a
// database row a server worker has to keep up to date. Given the chain the
// USDC was burned on and the burn transaction hash, Iris reports:
//   • no record yet            → the burn is still being picked up
//   • status pending_*         → waiting for source-chain finality/attestation
//   • status complete          → attested; the mint can happen
//   • forwardState COMPLETE    → Circle's Forwarding Service minted it
//                                (forwardTxHash = the mint on the destination)
//   • forwardState FAILED      → forwarding gave up; finish it from Recover
//
// Every move this app makes today uses the Forwarding Service where the
// destination supports it (Arc included), so "complete + forwardState
// COMPLETE" is the end of the journey.

import { useEffect, useRef, useState } from 'react'

// Use the production Iris API for mainnet flows; fall back to sandbox when the
// app is explicitly configured for testnet. VITE_IRIS_ENV='sandbox' opts in to
// the sandbox URL — the default is the production endpoint so production CCTP
// mints are never invisible.
const IRIS_ENV = (import.meta.env.VITE_IRIS_ENV as string | undefined) || 'production'
const IRIS = IRIS_ENV === 'sandbox'
  ? 'https://iris-api-sandbox.circle.com'
  : 'https://iris-api.circle.com'

/** CCTP domain per chain id used in activity rows (Circle's domain table). */
export const CCTP_DOMAINS: Record<string, number> = {
  Ethereum_Sepolia: 0, Avalanche_Fuji: 1, Optimism_Sepolia: 2, Arbitrum_Sepolia: 3,
  Base_Sepolia: 6, Polygon_Sepolia: 7, Polygon_Amoy_Testnet: 7, Unichain_Sepolia: 10,
  Linea_Sepolia: 11, Codex_Testnet: 12, Sonic_Testnet: 13, World_Chain_Sepolia: 14,
  Monad_Testnet: 15, Sei_Testnet: 16, XDC_Apothem: 18, HyperEVM_Testnet: 19,
  Ink_Testnet: 21, Plume_Testnet: 22, Arc_Testnet: 26, Edge_Testnet: 28,
  Injective_Testnet: 29, Morph_Testnet: 30, Pharos_Testnet: 31,
}

export type CctpStage = 'burning' | 'attesting' | 'minting' | 'done' | 'error'
export interface CctpProgress {
  stage: CctpStage
  /** Mint on the destination chain, once known. */
  mintTxHash?: string
  /** Why Circle is holding it (e.g. insufficient_fee), when it says. */
  delayReason?: string
  msg?: string
}

/** One Iris message record (only the fields used here). */
export interface IrisMessage {
  status?: string
  attestation?: string | null
  delayReason?: string | null
  forwardState?: string | null
  forwardTxHash?: string | null
}

/** Maps an Iris record (or none yet) to a progress stage. Pure — unit tested. */
export function progressFromIris(msg: IrisMessage | null | undefined, knownMintTx?: string): CctpProgress {
  if (knownMintTx) return { stage: 'done', mintTxHash: knownMintTx }
  if (!msg) return { stage: 'burning' }
  const forward = (msg.forwardState ?? '').toUpperCase()
  if (forward === 'COMPLETE' && msg.forwardTxHash) return { stage: 'done', mintTxHash: msg.forwardTxHash }
  if (forward === 'FAILED') {
    return { stage: 'error', msg: 'Circle couldn’t deliver this transfer automatically. Your USDC is safe — finish it from Multichain Hub → Recover.' }
  }
  const attested = msg.status === 'complete' && !!msg.attestation && msg.attestation !== 'PENDING'
  if (attested) return { stage: 'minting' }
  return { stage: 'attesting', delayReason: msg.delayReason ?? undefined }
}

/** Fetches the current progress of a burn. null = couldn't tell right now (network). */
export async function fetchCctpProgress(srcChain: string, burnTxHash: string, knownMintTx?: string): Promise<CctpProgress | null> {
  if (knownMintTx) return progressFromIris(null, knownMintTx)
  const domain = CCTP_DOMAINS[srcChain]
  if (domain === undefined || !/^0x[0-9a-fA-F]{64}$/.test(burnTxHash)) return null
  try {
    const res = await fetch(`${IRIS}/v2/messages/${domain}?transactionHash=${burnTxHash}`)
    if (res.status === 404) return progressFromIris(null)
    if (!res.ok) return null
    const data = await res.json() as { messages?: IrisMessage[] }
    return progressFromIris(data.messages?.[0])
  } catch {
    return null
  }
}

const isFinal = (p: CctpProgress | null) => p?.stage === 'done' || p?.stage === 'error'

/**
 * Live progress for one burn: checks every few seconds while the page is
 * visible, again as soon as it becomes visible, and stops once finished.
 */
export function useCctpProgress(srcChain: string | undefined, burnTxHash: string | undefined, knownMintTx?: string, intervalMs = 4000): CctpProgress | null {
  const [progress, setProgress] = useState<CctpProgress | null>(() => (knownMintTx ? progressFromIris(null, knownMintTx) : null))
  const last = useRef<CctpProgress | null>(progress)
  useEffect(() => {
    if (!srcChain || !burnTxHash) return
    let stop = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = async () => {
      if (stop || isFinal(last.current)) return
      if (typeof document === 'undefined' || document.visibilityState === 'visible') {
        const p = await fetchCctpProgress(srcChain, burnTxHash, knownMintTx)
        if (stop) return
        if (p) { last.current = p; setProgress(p) }
      }
      if (!isFinal(last.current)) timer = setTimeout(tick, intervalMs)
    }
    const onVisible = () => { if (document.visibilityState === 'visible') { clearTimeout(timer); void tick() } }
    void tick()
    document.addEventListener('visibilitychange', onVisible)
    return () => { stop = true; clearTimeout(timer); document.removeEventListener('visibilitychange', onVisible) }
  }, [srcChain, burnTxHash, knownMintTx, intervalMs])
  return progress
}
