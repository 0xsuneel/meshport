// src/lib/cctpTracker.ts
//
// Progress of a CCTP move (Transfer: Arc → chain, Bring Funds: chain → Arc),
// read straight from Circle's attestation service (Iris) - not from a
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

// MeshPort runs on Arc Testnet and Circle's testnets only (NETWORK_MODE in
// blockchain/chains.ts), and testnet burns exist only in Circle's SANDBOX
// Iris. So sandbox is the default; VITE_IRIS_ENV='production' opts in to the
// production Iris for a future mainnet build. (It used to default to
// production: a build without VITE_IRIS_ENV then asked the wrong service, got
// "not found" for every testnet burn and showed "Burning…" forever.)
export const IRIS_SANDBOX = 'https://iris-api-sandbox.circle.com'
export const IRIS_PRODUCTION = 'https://iris-api.circle.com'
const IRIS_ENV = (import.meta.env.VITE_IRIS_ENV as string | undefined) || 'sandbox'
export const IRIS = IRIS_ENV === 'production' ? IRIS_PRODUCTION : IRIS_SANDBOX
const IRIS_OTHER = IRIS === IRIS_SANDBOX ? IRIS_PRODUCTION : IRIS_SANDBOX

/** CCTP domain per chain id used in activity rows (Circle's domain table). */
export const CCTP_DOMAINS: Record<string, number> = {
  Ethereum_Sepolia: 0, Avalanche_Fuji: 1, Optimism_Sepolia: 2, Arbitrum_Sepolia: 3,
  Base_Sepolia: 6, Polygon_Sepolia: 7, Polygon_Amoy_Testnet: 7, Unichain_Sepolia: 10,
  Linea_Sepolia: 11, Codex_Testnet: 12, Sonic_Testnet: 13, World_Chain_Sepolia: 14,
  Monad_Testnet: 15, Sei_Testnet: 16, XDC_Apothem: 18, HyperEVM_Testnet: 19,
  Ink_Testnet: 21, Plume_Testnet: 22, Arc_Testnet: 26, Edge_Testnet: 28,
  Injective_Testnet: 29, Morph_Testnet: 30, Pharos_Testnet: 31, Solana_Devnet: 5,
}

/** A burn's id on its chain: an EVM tx hash, or a Solana signature (base58). */
export function isBurnTxId(srcChain: string, id: string): boolean {
  return srcChain === 'Solana_Devnet' || srcChain === 'Solana'
    ? /^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(id)
    : /^0x[0-9a-fA-F]{64}$/.test(id)
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
  message?: string | null
  attestation?: string | null
  delayReason?: string | null
  forwardState?: string | null
  forwardTxHash?: string | null
}

/** Maps an Iris record (or none yet) to a progress stage. Pure - unit tested. */
export function progressFromIris(msg: IrisMessage | null | undefined, knownMintTx?: string): CctpProgress {
  if (knownMintTx) return { stage: 'done', mintTxHash: knownMintTx }
  if (!msg) return { stage: 'burning' }
  const forward = (msg.forwardState ?? '').toUpperCase()
  if (forward === 'COMPLETE' && msg.forwardTxHash) return { stage: 'done', mintTxHash: msg.forwardTxHash }
  if (forward === 'FAILED') {
    return { stage: 'error', msg: 'Circle couldn’t deliver this transfer automatically. Your USDC is safe - finish it from Multichain Hub → Recover.' }
  }
  const attested = msg.status === 'complete' && !!msg.attestation && msg.attestation !== 'PENDING'
  if (attested) return { stage: 'minting' }
  return { stage: 'attesting', delayReason: msg.delayReason ?? undefined }
}

/** Fetches the current progress of a burn. null = couldn't tell right now (network). */
/** The raw Iris record for a burn, or null (not seen yet / network trouble). */
export async function fetchIrisMessage(srcChain: string, burnTxHash: string): Promise<IrisMessage | null> {
  const domain = CCTP_DOMAINS[srcChain]
  if (domain === undefined || !isBurnTxId(srcChain, burnTxHash)) return null
  // Testnet burns are only known to Circle's sandbox Iris and mainnet burns
  // only to production - try the configured one, then the other, so a
  // mis-set VITE_IRIS_ENV can't hide a burn that's ready to finish.
  for (const base of [IRIS, IRIS_OTHER]) {
    try {
      const res = await fetch(`${base}/v2/messages/${domain}?transactionHash=${burnTxHash}`)
      if (!res.ok) continue
      const data = await res.json() as { messages?: IrisMessage[] }
      if (data.messages?.[0]) return data.messages[0]
    } catch { /* try the other one */ }
  }
  return null
}

export async function fetchCctpProgress(srcChain: string, burnTxHash: string, knownMintTx?: string): Promise<CctpProgress | null> {
  if (knownMintTx) return progressFromIris(null, knownMintTx)
  const domain = CCTP_DOMAINS[srcChain]
  if (domain === undefined || !isBurnTxId(srcChain, burnTxHash)) return null
  // The configured Iris first; the other one only when the first has no record
  // of this burn (a mis-set VITE_IRIS_ENV must not leave a burn on "Burning…").
  let notFound = false
  for (const base of [IRIS, IRIS_OTHER]) {
    try {
      const res = await fetch(`${base}/v2/messages/${domain}?transactionHash=${burnTxHash}`)
      if (res.status === 404) { notFound = true; continue }
      if (!res.ok) continue
      const data = await res.json() as { messages?: IrisMessage[] }
      if (data.messages?.[0]) return progressFromIris(data.messages[0])
      notFound = true
    } catch { /* try the other one */ }
  }
  return notFound ? progressFromIris(null) : null
}

const isFinal = (p: CctpProgress | null) => p?.stage === 'done' || p?.stage === 'error'

/**
 * Live progress for one burn: checks every few seconds while the page is
 * visible, again as soon as it becomes visible, and stops once finished.
 */
export function useCctpProgress(srcChain: string | undefined, burnTxHash: string | undefined, knownMintTx?: string, intervalMs = 2000): CctpProgress | null {
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

// ── Arrival on Arc, read from Arc itself ─────────────────────────────────────
// Iris flips forwardState to COMPLETE some seconds after the forwarder's mint
// lands. Once Circle has attested, the message's nonce is known, and Arc's
// MessageTransmitterV2 marks it used the moment the mint executes - so Bring
// can show "arrived" from chain truth without waiting for Iris to catch up.
const ARC_MESSAGE_TRANSMITTER_V2 = '0xe737e5cebeeba77efe34d4aa090756590b1ce275'
const USED_NONCES_SELECTOR = '0xfeb61724' // usedNonces(bytes32)

/** A CCTP v2 message's nonce (bytes32 after version, source and destination domains). Pure. */
export function messageNonce(message: string | null | undefined): string | null {
  if (!message || !/^0x[0-9a-fA-F]*$/.test(message) || message.length < 2 + 88) return null
  const nonce = message.slice(2 + 24, 2 + 88)
  return /^0+$/.test(nonce) ? null : '0x' + nonce
}

/** Has this burn (to Arc) been minted on Arc? Chain truth once attested; false while unsure. */
export async function mintedOnArc(srcChain: string, burnTxHash: string): Promise<boolean> {
  const msg = await fetchIrisMessage(srcChain, burnTxHash)
  if (!msg) return false
  if (progressFromIris(msg).stage === 'done') return true
  const nonce = messageNonce(msg.status === 'complete' ? msg.message : null)
  if (!nonce) return false
  try {
    const { arcRpcJson } = await import('./arc')
    const j = await arcRpcJson({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: ARC_MESSAGE_TRANSMITTER_V2, data: USED_NONCES_SELECTOR + nonce.slice(2) }, 'latest'] })
    return typeof j?.result === 'string' && /[1-9a-fA-F]/.test(j.result.slice(2))
  } catch { return false }
}
