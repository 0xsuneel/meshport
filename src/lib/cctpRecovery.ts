// src/lib/cctpRecovery.ts
//
// Client side of the recovery system.
//   CCTP: supabase/functions/cctp-recovery diagnoses every stuck/failed
//         claim or transfer against Circle's attestation API and the
//         destination chain's usedNonces. Claims into Arc are re-queued for
//         the MeshPort relayer; transfers out of Arc are minted by the user's
//         own key on the destination (receiveMessage), signed on this device.
//   UB:   reuses lib/ubFundRecovery.ts (initiateRemoveFund / removeFund) —
//         that logic is unchanged; this file only lists its pending rows.

import { createPublicClient, createWalletClient, fallback, http, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { supabase } from './supabase'
import { describeFunctionsError } from './describeFunctionsError'
import { EXTERNAL_CHAINS } from '@/blockchain/chains'

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

/** Claim → Arc: re-queue for MeshPort's relayer (claim-worker mints on Arc). */
export function retryClaimRelay(id: string): Promise<CctpDiagnosis> {
  return call({ action: 'retry-relay', id })
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
 * Transfer out of Arc whose mint never happened: the user's own wallet
 * submits receiveMessage on the destination chain. Needs a little native
 * gas there. The key stays on this device.
 */
export async function selfMintTransfer(id: string, privateKey: string): Promise<{ mintTxHash: string }> {
  const d = await inspectCctp('transfer', id)
  if (d.state === 'already_minted') return { mintTxHash: d.destinationMintTxHash ?? '' }
  if (d.state !== 'ready_self_mint' || !d.message || !d.attestation || !d.messageTransmitter || !d.destinationChain) {
    throw new Error(d.detail || `Not ready to mint (${d.state})`)
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

/**
 * Claim into Arc that never minted — finished by the user's OWN wallet on
 * Arc (receiveMessage), no MeshPort relayer involved. Gas on Arc is paid in
 * USDC, so a little Arc USDC is all it needs. Only possible when the
 * message isn't locked to Circle's forwarder (state 'ready_relay').
 */
export async function selfMintClaim(id: string, privateKey: string): Promise<{ mintTxHash: string }> {
  const d = await inspectCctp('claim', id)
  if (d.state === 'already_minted') return { mintTxHash: d.destinationMintTxHash ?? '' }
  if (d.state !== 'ready_relay' || !d.message || !d.attestation || !d.messageTransmitter) {
    throw new Error(d.detail || `Not ready to mint (${d.state})`)
  }
  const { ARC, ARC_RPCS } = await import('@/blockchain/chains')
  const toAbsolute = (url: string) =>
    /^[a-z]+:\/\//i.test(url) ? url : window.location.origin + (url.startsWith('/') ? url : '/' + url)
  // MeshPort's same-origin Arc proxy first, Arc's public RPC as fallback —
  // so the mint still goes through if MeshPort's proxy is down.
  const rpcs = [...ARC_RPCS.map(toAbsolute), ARC.rpcUrl]
  const transport = fallback(rpcs.map(u => http(u)))
  const chain = {
    id: ARC.chainId, name: 'Arc Testnet',
    nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
    rpcUrls: { default: { http: rpcs } },
  } as const
  const account = privateKeyToAccount(privateKey as Hex)
  const publicClient = createPublicClient({ chain, transport })
  const gas = await publicClient.getBalance({ address: account.address })
  if (gas === 0n) throw new Error('You need a little USDC on Arc to pay the gas for this mint.')

  const { request } = await publicClient.simulateContract({
    account, address: d.messageTransmitter, abi: RECEIVE_MESSAGE_ABI,
    functionName: 'receiveMessage', args: [d.message, d.attestation],
  })
  const walletClient = createWalletClient({ account, chain, transport })
  const hash = await walletClient.writeContract(request)
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 })
  if (receipt.status !== 'success') throw new Error('Mint transaction reverted')
  // Re-inspect: the nonce is now used on Arc, so the claim is marked
  // completed (and tagged "Recovered via CCTP") from chain truth.
  await call({ action: 'inspect', kind: 'claim', id, selfMinted: true, mintTxHash: hash }).catch(() => {})
  return { mintTxHash: hash }
}

/** UB: pending 7-day withdrawals started by lib/ubFundRecovery.ts. */
export async function listPendingUbRecoveries(walletAddress: string): Promise<Array<{ id: string; amount: number; createdAt: string; readyAt: string }>> {
  const { data } = await supabase.from('activity')
    .select('id, amount, created_at, metadata')
    .eq('activity_type', 'withdraw').eq('status', 'pending')
    // Only real 7-day withdrawals (initiateRemoveFund). Stuck UB transfers
    // are also pending 'withdraw' rows, but they are NOT withdrawals — they
    // wait for the user to choose in Recover (metadata.ub_stuck_transfer).
    .contains('metadata', { ub_recovery: true })
    .ilike('wallet_address', walletAddress)
    .order('created_at', { ascending: false })
  return (data ?? []).map((r: any) => ({
    id: r.id as string,
    amount: Number(r.amount),
    createdAt: r.created_at as string,
    readyAt: (r.metadata?.eligible_at as string | undefined)
      ?? new Date(new Date(r.created_at as string).getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(),
  }))
}
