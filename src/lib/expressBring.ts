// src/lib/expressBring.ts
//
// Express Bring: USDC from another chain to the user's own Arc wallet with
// just the passcode - no Circle signature per Bring.
//
// Once per chain (two Circle signatures, then good for 30 days):
//   1. USDC's EIP-2612 permit: MeshPortRouter may pull up to the Express
//      limit on that chain;
//   2. setBringKey: the wallet frame's Bring key (lib/wallet, sealed to this
//      device) may ask the router for Brings until it expires.
// Each Bring after that: the passcode (checked in the frame), the Bring key
// signs ONE ExpressBring, MeshPort's relayer submits it. The router sends it
// only to the owner's own Arc address and caps MeshPort's fee - so even a
// leaked Bring key can only move the owner's USDC to the owner's Arc wallet.
//
// Counted against the shared Express limit. Anything Express can't do (off,
// over what's left, the router there predates Express, the setup refused)
// returns null: the caller Brings the normal way.

import type { Hex } from 'viem'
import { toHex, keccak256 } from 'viem'
import type { WalletAccount } from '@/wallet'

const SETUP_DAYS = 30
const DEADLINE_S = 10 * 60

type State = { router: Hex; key?: string; expiry?: number; keyNonce?: string; allowance?: string; permitNonce?: string; chainId?: number; unsupported?: boolean }

async function api(path: string, init?: RequestInit): Promise<any> {
  const { authApiHeaders } = await import('./supabase')
  const r = await fetch(path, { ...init, headers: await authApiHeaders() })
  const out = await r.json().catch(() => null)
  if (!r.ok) throw Object.assign(new Error(out?.error || `Request failed (${r.status})`), { status: r.status, body: out })
  return out
}

async function state(chainId: string, owner: string): Promise<State> {
  return api(`/api/bridge-relay?action=express_state&chain=${encodeURIComponent(chainId)}&owner=${owner}`)
}

/** The once-per-chain setup: two Circle signatures, submitted by the relayer. */
async function setUp(p: { chainId: string; owner: Hex; signer: WalletAccount; st: State; key: Hex; needPermit: boolean; usdc: Hex; chainNum: number; usdcName: string; usdcVersion: string; limitUnits: bigint }): Promise<void> {
  const now = Math.floor(Date.now() / 1000)
  let permit: Record<string, string> | undefined
  if (p.needPermit) {
    const deadline = BigInt(now + 3600)
    const signature = await p.signer.signTypedData({
      domain: { name: p.usdcName, version: p.usdcVersion, chainId: p.chainNum, verifyingContract: p.usdc },
      types: { Permit: [
        { name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }, { name: 'value', type: 'uint256' },
        { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' },
      ] },
      primaryType: 'Permit',
      message: { owner: p.owner, spender: p.st.router, value: p.limitUnits, nonce: BigInt(p.st.permitNonce ?? '0'), deadline },
    })
    permit = { value: p.limitUnits.toString(), deadline: deadline.toString(), signature }
  }
  const expiry = BigInt(now + SETUP_DAYS * 86400)
  const sig = await p.signer.signTypedData({
    domain: { name: 'MeshPortRouter', version: '1', chainId: p.chainNum, verifyingContract: p.st.router },
    types: { SetBringKey: [
      { name: 'owner', type: 'address' }, { name: 'key', type: 'address' }, { name: 'expiry', type: 'uint64' }, { name: 'nonce', type: 'uint256' },
    ] },
    primaryType: 'SetBringKey',
    message: { owner: p.owner, key: p.key, expiry, nonce: BigInt(p.st.keyNonce ?? '0') },
  })
  await api('/api/bridge-relay', { method: 'POST', body: JSON.stringify({ action: 'express_setup', chain: p.chainId, ...(permit ? { permit } : {}), bringKey: { key: p.key, expiry: expiry.toString(), sig } }) })
}

/**
 * Bring through Express. `amountUsdc` leaves the wallet (MeshPort's fee comes
 * out of it, as with a normal Bring). Null: not covered - Bring the normal way.
 */
export async function bringExpress(p: {
  chainId: string; amountUsdc: number; signer: WalletAccount; walletAddress: string
  usdc: Hex; chainNum: number
  quote: { fee: bigint; maxFee: bigint; hookData: Hex; usdcName: string; usdcVersion: string }
  onStatus?: (msg: string) => void
}): Promise<{ txHash: Hex; fee: number; maxFee: number; mint: 'relayer' | 'circle' } | null> {
  const fp = await import('./fastPay')
  if (!fp.fastPayEnabled()) return null
  const owner = p.walletAddress as Hex
  const total = BigInt(Math.round(p.amountUsdc * 1e6))
  if (!fp.expressCoversUsd(owner, p.amountUsdc)) return null
  const { callWallet } = await import('@/wallet/frameClient')
  let st: State
  try { st = await state(p.chainId, owner) } catch { return null }
  if (st.unsupported || !st.router) return null
  // Only the router this app build is configured with - never an address the
  // server hands back (audit 7 Nov H3: a wrong one would get the USDC permit).
  const { gaslessRouter } = await import('./gaslessBridge')
  const pinned = gaslessRouter(p.chainId)
  if (!pinned || pinned.toLowerCase() !== st.router.toLowerCase()) {
    void import('./errorReport').then(m => m.reportPerf(`[perf express bring] router mismatch on ${p.chainId} (normal way)`)).catch(() => {})
    return null
  }
  let key: Hex | null = null
  try { key = (await callWallet('bring:key', { owner, create: true })).address } catch { return null }
  if (!key) return null
  const limitUnits = BigInt(fp.expressLimitUsd()) * 1_000_000n
  const keyOk = (st.key ?? '').toLowerCase() === key.toLowerCase() && (st.expiry ?? 0) > Date.now() / 1000 + 3600
  const allowanceOk = BigInt(st.allowance ?? '0') >= total
  // Once per chain (or when the allowance ran low): the two Circle signatures.
  if (!keyOk || !allowanceOk) {
    p.onStatus?.('Setting up Express…')
    try {
      await setUp({ chainId: p.chainId, owner, signer: p.signer, st, key, needPermit: !allowanceOk, usdc: p.usdc, chainNum: p.chainNum,
        usdcName: p.quote.usdcName, usdcVersion: p.quote.usdcVersion, limitUnits: limitUnits > total ? limitUnits : total })
    } catch (e) {
      void import('./errorReport').then(m => m.reportPerf(`[perf express bring] setup failed (normal way): ${String((e as Error)?.message ?? e).slice(0, 140)}`)).catch(() => {})
      return null
    }
  }
  // The passcode for THIS Bring, checked in the frame.
  if (!(await fp.expressApprove(owner))) return null
  const fee = p.quote.fee, maxFee = p.quote.maxFee
  const bring = {
    owner, token: p.usdc, amount: (total - fee).toString(), fee: fee.toString(), maxFee: maxFee.toString(),
    minFinalityThreshold: 1000, hookData: p.quote.hookData, salt: toHex(crypto.getRandomValues(new Uint8Array(32))),
    deadline: String(Math.floor(Date.now() / 1000) + DEADLINE_S),
  }
  let keySig: Hex
  try {
    keySig = (await callWallet('bring:sign', { owner, chainId: p.chainNum, router: st.router, bring: { ...bring, hookDataHash: keccak256(bring.hookData) } })).signature
  } catch { return null }
  p.onStatus?.('Submitting…')
  fp.expressCountUsd(owner, p.amountUsdc)
  let out: { txHash?: Hex; pending?: boolean; mint?: 'relayer' | 'circle' }
  try {
    out = await api('/api/bridge-relay', { method: 'POST', body: JSON.stringify({ action: 'express_bring', chain: p.chainId, bring, keySig }) })
  } catch (e: any) {
    fp.expressCountUsd(owner, -p.amountUsdc)
    // Refused before anything was sent (simulation, fee, session): the normal way.
    if (e?.status && e.status < 500 && !e?.body?.txHash) return null
    throw e
  }
  if (!out?.txHash) { fp.expressCountUsd(owner, -p.amountUsdc); return null }
  if (out.pending) p.onStatus?.('Confirming…')
  void import('./errorReport').then(m => m.reportPerf(`[perf express bring] sent ${p.chainId} (${out.mint ?? 'relayer'} mints)`)).catch(() => {})
  // The relayer mints on Arc (server side); the app re-checks a minute later, as for a normal Bring.
  const mint = out.mint ?? (p.quote.hookData === '0x' ? 'relayer' : 'circle')
  if (mint === 'relayer') {
    const burnTxHash = out.txHash
    setTimeout(() => {
      void import('./cctpRecovery').then(m => m.finishCctpMintViaRelayer({ sourceChain: p.chainId, destinationChain: 'Arc_Testnet', burnTxHash, timeoutMs: 120_000 })).catch(() => {})
    }, 60_000)
  }
  return { txHash: out.txHash, fee: Number(fee) / 1e6, maxFee: Number(maxFee) / 1e6, mint }
}


