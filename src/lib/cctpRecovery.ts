// src/lib/cctpRecovery.ts
//
// Client side of the recovery system.
//   CCTP: supabase/functions/cctp-recovery diagnoses every stuck/failed
//         claim or transfer against Circle's attestation API and the
//         destination chain's usedNonces. The missing mint (receiveMessage)
//         is then submitted by MeshPort's relayer (/api/bridge-relay), so
//         nobody needs gas — except a transfer whose message is locked to the
//         user's own wallet, which only that wallet can mint.
//   UB:   reuses lib/ubFundRecovery.ts (initiateRemoveFund / removeFund) —
//         that logic is unchanged; this file only lists its pending rows.

import { createPublicClient, createWalletClient, http, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { supabase } from './supabase'
import { describeFunctionsError } from './describeFunctionsError'
import { EXTERNAL_CHAINS } from '@/blockchain/chains'
import { ARC_CHAIN_KEY } from './chainExplorers'

/** A recovery step already running for a row — started by the user or by MeshPort. */
export type RecoveryAction = { kind: 'relay' | 'reattest'; at: string; by: 'user' | 'meshport' }

export type RecoveryItem = {
  kind: 'claim' | 'transfer'
  id: string
  chain: string
  amount: number
  status: string
  error: string | null
  createdAt: string
  action?: RecoveryAction | null
}

export type CctpDiagnosis = {
  state:
    | 'already_minted' | 'waiting_attestation' | 'ready_relay' | 'ready_self_mint'
    | 'forwarder_only' | 'needs_reattest' | 'no_message' | 'unsupported_chain'
    | 'relay_queued' | 'reattest_requested' | 'reattest_failed' | 'reattest_pending'
  detail?: string
  action?: RecoveryAction | null
  nonce?: string
  message?: Hex
  attestation?: Hex
  messageTransmitter?: Hex
  destinationChain?: string
  destinationCaller?: string
  destinationMintTxHash?: string | null
}

// Client chain keys that differ from EXTERNAL_CHAINS.
const CHAIN_ALIASES: Record<string, string> = { Polygon_Amoy_Testnet: 'Polygon_Sepolia' }

async function call<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke('cctp-recovery', { body })
  if (error) throw new Error(await describeFunctionsError(error, 'Recovery check failed'))
  if (data?.error && !data?.state) throw new Error(data.error)
  return data as T
}

export async function listRecoverable(): Promise<{ claims: RecoveryItem[]; transfers: RecoveryItem[] }> {
  return call({ action: 'list' })
}

export function inspectCctp(kind: 'claim' | 'transfer', id: string): Promise<CctpDiagnosis> {
  return call({ action: 'inspect', kind, id })
}

const OPEN_CALLER = '0x' + '0'.repeat(40)

/**
 * Finishes a stuck CCTP move through MeshPort's relayer: it submits
 * receiveMessage on the destination (Arc for a claim), paying the gas. The
 * message decides the recipient, so the relayer can't redirect anything.
 * Works for the row's owner and for admins.
 */
export async function relayMint(kind: 'claim' | 'transfer', id: string): Promise<CctpDiagnosis> {
  const d = await inspectCctp(kind, id)
  if (d.state === 'already_minted') return d
  const ready = kind === 'claim' ? d.state === 'ready_relay' : d.state === 'ready_self_mint'
  if (!ready || !d.message || !d.attestation || !d.messageTransmitter) throw new Error(d.detail || `Not ready to mint (${d.state})`)
  if ((d.destinationCaller ?? OPEN_CALLER).toLowerCase() !== OPEN_CALLER) {
    throw new Error('This mint is locked to the wallet itself — finish it with "Mint with my wallet".')
  }
  const { encodeFunctionData } = await import('viem')
  const { authApiHeaders } = await import('./supabase')
  const r = await fetch('/api/bridge-relay', {
    method: 'POST', headers: await authApiHeaders(),
    body: JSON.stringify({
      action: 'call', chain: kind === 'claim' ? ARC_CHAIN_KEY : d.destinationChain, to: d.messageTransmitter,
      data: encodeFunctionData({ abi: RECEIVE_MESSAGE_ABI, functionName: 'receiveMessage', args: [d.message, d.attestation] }),
    }),
  })
  const out = await r.json().catch(() => null) as { txHash?: string; error?: string } | null
  if (!r.ok || !out?.txHash) throw new Error(out?.error || 'Relayer could not finish this mint')
  // Re-inspect: the nonce is now used on-chain, so the row is marked completed
  // (and tagged as recovered) from chain truth.
  await call({ action: 'inspect', kind, id, selfMinted: true, mintTxHash: out.txHash }).catch(() => {})
  return { ...d, state: 'already_minted', destinationMintTxHash: out.txHash }
}

const MESSAGE_TRANSMITTER_V2 = '0xe737e5cebeeba77efe34d4aa090756590b1ce275' as const // same on every testnet

/**
 * Finishes a CCTP transfer straight from its burn hash when Circle's
 * forwarder didn't deliver the mint: waits for Circle's attestation, then
 * MeshPort's relayer submits receiveMessage on the destination (gas is
 * estimated, so a mint that needs more gas than the forwarder gave it still
 * goes through). The attested message fixes the recipient and amount, and a
 * message can only be received once, so this can never double-send.
 * Returns the mint tx hash, or null if it couldn't be finished right now.
 */
export async function finishCctpMintViaRelayer(p: {
  sourceChain: string; destinationChain: string; burnTxHash: string; timeoutMs?: number
}): Promise<{ mintTxHash: string } | null> {
  const { fetchIrisMessage } = await import('./cctpTracker')
  const deadline = Date.now() + (p.timeoutMs ?? 120_000)
  let msg = await fetchIrisMessage(p.sourceChain, p.burnTxHash)
  while (Date.now() < deadline && !(msg?.status === 'complete' && msg.message && msg.attestation && msg.attestation !== 'PENDING')) {
    if ((msg?.forwardState ?? '').toUpperCase() === 'COMPLETE' && msg?.forwardTxHash) return { mintTxHash: msg.forwardTxHash }
    await new Promise(r => setTimeout(r, 3000))
    msg = await fetchIrisMessage(p.sourceChain, p.burnTxHash)
  }
  if ((msg?.forwardState ?? '').toUpperCase() === 'COMPLETE' && msg?.forwardTxHash) return { mintTxHash: msg.forwardTxHash }
  if (!msg?.message || !msg.attestation || msg.attestation === 'PENDING') return null
  // Circle's forwarder gave up on this mint: remember the chain so the next
  // transfers there go straight to the relayer (see noteForwarderMintFailed).
  if ((msg.forwardState ?? '').toUpperCase() === 'FAILED') {
    const { noteForwarderMintFailed } = await import('@/blockchain/chains')
    noteForwarderMintFailed(p.destinationChain)
  }

  const { encodeFunctionData } = await import('viem')
  const { authApiHeaders } = await import('./supabase')
  const r = await fetch('/api/bridge-relay', {
    method: 'POST', headers: await authApiHeaders(),
    body: JSON.stringify({
      action: 'call', chain: p.destinationChain, to: MESSAGE_TRANSMITTER_V2,
      data: encodeFunctionData({ abi: RECEIVE_MESSAGE_ABI, functionName: 'receiveMessage', args: [msg.message as Hex, msg.attestation as Hex] }),
    }),
  })
  const out = await r.json().catch(() => null) as { txHash?: string; error?: string; pending?: boolean } | null
  if (r.ok && out?.txHash) return { mintTxHash: out.txHash }
  // The relayer simulates first, so a refusal usually means it was already
  // minted (e.g. Circle's forwarder got there after all) — check Iris again.
  const again = await fetchIrisMessage(p.sourceChain, p.burnTxHash)
  if ((again?.forwardState ?? '').toUpperCase() === 'COMPLETE' && again?.forwardTxHash) return { mintTxHash: again.forwardTxHash }
  throw new Error(out?.error || 'Relayer could not finish this mint')
}

/** Claim → Arc: MeshPort's relayer mints it on Arc (no gas needed). */
export function retryClaimRelay(id: string): Promise<CctpDiagnosis> {
  return relayMint('claim', id)
}

/** Expired fast-transfer attestation: ask Circle to re-attest, then inspect again. */
export function requestReattest(kind: 'claim' | 'transfer', id: string): Promise<CctpDiagnosis> {
  return call({ action: 'reattest', kind, id })
}

const RECEIVE_MESSAGE_ABI = [{
  type: 'function', name: 'receiveMessage', stateMutability: 'nonpayable',
  inputs: [{ name: 'message', type: 'bytes' }, { name: 'attestation', type: 'bytes' }],
  outputs: [{ name: 'success', type: 'bool' }],
}] as const

/**
 * Transfer out of Arc whose mint never happened. Normally MeshPort's relayer
 * submits the mint (no gas needed). Only a message locked to the user's own
 * wallet is minted by that wallet, which then needs a little native gas on
 * the destination. The key stays on this device.
 */
export async function selfMintTransfer(id: string, privateKey: string): Promise<{ mintTxHash: string }> {
  const d = await inspectCctp('transfer', id)
  if (d.state === 'already_minted') return { mintTxHash: d.destinationMintTxHash ?? '' }
  if (d.state !== 'ready_self_mint' || !d.message || !d.attestation || !d.messageTransmitter || !d.destinationChain) {
    throw new Error(d.detail || `Not ready to mint (${d.state})`)
  }
  if ((d.destinationCaller ?? OPEN_CALLER).toLowerCase() === OPEN_CALLER) {
    const out = await relayMint('transfer', id)
    return { mintTxHash: out.destinationMintTxHash ?? '' }
  }

  const cfg = EXTERNAL_CHAINS[CHAIN_ALIASES[d.destinationChain] ?? d.destinationChain]
  if (!cfg) throw new Error(`No RPC configured for ${d.destinationChain}`)
  const chain = {
    id: cfg.chainId, name: d.destinationChain,
    nativeCurrency: { name: 'Native', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [cfg.rpcs[0]] } },
  } as const
  const account = privateKeyToAccount(privateKey as Hex)
  const publicClient = createPublicClient({ chain, transport: http(cfg.rpcs[0]) })

  const gas = await publicClient.getBalance({ address: account.address })
  if (gas === 0n) throw new Error(`You need a little gas on ${d.destinationChain.replace(/_/g, ' ')} to finish this mint.`)

  // Simulate first: reverts here (already minted, bad attestation) cost nothing.
  const { request } = await publicClient.simulateContract({
    account, address: d.messageTransmitter, abi: RECEIVE_MESSAGE_ABI,
    functionName: 'receiveMessage', args: [d.message, d.attestation],
  })
  const walletClient = createWalletClient({ account, chain, transport: http(cfg.rpcs[0]) })
  const hash = await walletClient.writeContract(request)
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 })
  if (receipt.status !== 'success') throw new Error('Mint transaction reverted')

  await call({ action: 'confirm-mint', kind: 'transfer', id, mintTxHash: hash }).catch(() => { /* the chain is the truth; row catches up on next inspect */ })
  return { mintTxHash: hash }
}

/** Claim into Arc that never minted — MeshPort's relayer mints it on Arc (no Arc USDC needed). */
export async function selfMintClaim(id: string, _privateKey?: string): Promise<{ mintTxHash: string }> {
  const out = await relayMint('claim', id)
  return { mintTxHash: out.destinationMintTxHash ?? '' }
}

/** UB: pending 7-day withdrawals started by lib/ubFundRecovery.ts. */
export async function listPendingUbRecoveries(walletAddress: string): Promise<Array<{ id: string; amount: number; createdAt: string; readyAt: string }>> {
  // SUPABASE REDUCTION: replaced supabase.from('activity') with the
  // /api/bridge-relay?ub_pending_recoveries= proxy. The server applies the
  // ub_recovery:true filter and returns only safe-to-expose fields.
  try {
    const r = await fetch(`/api/bridge-relay?ub_pending_recoveries=${encodeURIComponent(walletAddress.toLowerCase())}`)
    if (!r.ok) return []
    const rows = await r.json().catch(() => []) as Array<{ id: string; amount: number; createdAt: string; readyAt: string }>
    return rows.map(row => ({
      id: row.id,
      amount: Number(row.amount),
      createdAt: row.createdAt,
      readyAt: row.readyAt || new Date(new Date(row.createdAt).getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    }))
  } catch { return [] }
}
