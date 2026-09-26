// supabase/functions/cctp-recovery/index.ts
//
// Recovery for stuck cross-chain moves. Blockchain is the source of truth
// here — never a row's status.
//
// USER actions (own rows only):
//   POST { action: 'list' }
//   POST { action: 'inspect', kind: 'claim'|'transfer', id }
//   POST { action: 'retry-relay', id }                         claims → Arc, MeshPort relayer
//   POST { action: 'reattest', kind, id }                      expired fast-transfer attestation
//   POST { action: 'confirm-mint', kind: 'transfer', id, mintTxHash }
//
// ADMIN actions (caller must be in public.admin_users) — the fallback when
// the user can't finish it themselves. Admins act ONLY by row id: no action
// accepts an address, chain or amount, so recipients and destinations can
// never be changed from the admin panel.
//   POST { action: 'admin-list' }
//   POST { action: 'inspect' | 'retry-relay' | 'reattest', ... }   (any user's row)
//   POST { action: 'admin-relay-transfer', id }   MeshPort relayer mints a transfer on its destination
//   POST { action: 'admin-requeue-ub-intent', id } resubmit a signed UB claim (ub-claim-worker)
//   POST { action: 'admin-notify', kind, id }     tell the user to finish it in Recover
//
// No private key of any user is ever involved. Every admin action is written
// to admin_recovery_log.

import { createClient } from 'jsr:@supabase/supabase-js@2'
import { createPublicClient, createWalletClient, http } from 'npm:viem@2'
import { privateKeyToAccount } from 'npm:viem@2/accounts'
import { handleOptionsFor, jsonFor } from '../_shared/cors.ts'
import { CHAIN_RPCS, CCTP_DOMAINS } from '../_shared/chains.ts'

const IRIS = 'https://iris-api-sandbox.circle.com'
const ARC_DOMAIN = 26
const MESSAGE_TRANSMITTER_V2 = '0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275'
const USED_NONCES_SELECTOR = '0xfeb61724' // usedNonces(bytes32)
const RECOVERABLE_AFTER_MS = 60 * 60 * 1000 // in-flight rows show up after 1h

const CHAIN_ALIASES: Record<string, string> = { Polygon_Amoy_Testnet: 'Polygon_Sepolia' }
const canon = (c: string) => CHAIN_ALIASES[c] ?? c

const DRPC_KEY = Deno.env.get('DRPC_KEY') ?? ''
const ARC_RPCS = [
  ...((Deno.env.get('ARC_RPC_URL') ?? '').trim() ? [(Deno.env.get('ARC_RPC_URL') ?? '').trim()] : []),
  ...(DRPC_KEY ? [`https://lb.drpc.live/arc-testnet/${DRPC_KEY}`] : []),
  'https://rpc.testnet.arc.network',
]
const RELAYER_PRIVATE_KEY = (Deno.env.get('RELAYER_PRIVATE_KEY') ?? '').trim()

function serviceKey(): string {
  const legacy = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (legacy) return legacy
  const raw = Deno.env.get('SUPABASE_SECRET_KEYS')
  if (raw) {
    try {
      const p = JSON.parse(raw)
      const c = p?.service_role ?? p?.SUPABASE_SERVICE_ROLE_KEY ?? Object.values(p ?? {})[0]
      if (typeof c === 'string' && c) return c
    } catch { /* fall through */ }
  }
  throw new Error('No Supabase service role key found')
}
const db = createClient(Deno.env.get('SUPABASE_URL')!, serviceKey())

async function rpc(urls: string[], method: string, params: unknown[]): Promise<any> {
  let last: unknown = null
  for (const url of urls) {
    if (!url || url.endsWith('/')) continue
    try {
      const r = await fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(8000),
      })
      const j = await r.json()
      if (j.error) { last = j.error; continue }
      return j.result
    } catch (e) { last = e }
  }
  throw last ?? new Error(`${method} failed on all RPCs`)
}

function decodeMessage(messageHex: string) {
  const h = messageHex.replace(/^0x/, '')
  if (h.length < 148 * 2) return null
  const word = (from: number, len: number) => h.slice(from * 2, (from + len) * 2)
  return {
    sourceDomain: parseInt(word(4, 4), 16),
    destinationDomain: parseInt(word(8, 4), 16),
    nonce: '0x' + word(12, 32),
    destinationCaller: '0x' + word(108, 32).slice(24),
  }
}

type Row = {
  kind: 'claim' | 'transfer'
  id: string
  wallet: string
  status: string
  burnTx: string
  amount: number
  sourceChain: string
  destinationChain: string
  sourceDomain: number | undefined
  destRpcs: string[]
  relayError?: string | null
  metadata?: Record<string, unknown> | null
  createdAt: string
  action?: RecoveryAction | null
}

// A recovery step already started for this row (by the user, or by MeshPort
// from the admin panel). While it's running the Recover screen doesn't offer
// the same step again — it shows "still processing" instead.
type RecoveryAction = { kind: 'relay' | 'reattest'; at: string; by: 'user' | 'meshport' }
const ACTION_LOCK_MS = 30 * 60 * 1000

function readAction(kind: unknown, at: unknown, by: unknown): RecoveryAction | null {
  if ((kind !== 'relay' && kind !== 'reattest') || typeof at !== 'string') return null
  return { kind, at, by: by === 'meshport' ? 'meshport' : 'user' }
}

/** The recovery step still in progress for this row, if any. */
function activeAction(status: string, action: RecoveryAction | null | undefined): RecoveryAction | null {
  if (!action || status === 'completed') return null
  if (Date.now() - new Date(action.at).getTime() > ACTION_LOCK_MS) return null
  // A relay that failed (claim-worker gave up) can be retried straight away.
  if (action.kind === 'relay' && status === 'failed') return null
  return action
}

async function saveAction(r: Row, kind: RecoveryAction['kind'], by: RecoveryAction['by']) {
  const at = new Date().toISOString()
  if (r.kind === 'claim') {
    await db.from('claims').update({ recovery_action: kind, recovery_action_at: at, recovery_action_by: by }).eq('id', r.id)
  } else {
    await db.from('activity').update({ metadata: { ...(r.metadata ?? {}), recovery_action: kind, recovery_action_at: at, recovery_action_by: by } }).eq('id', r.id)
  }
}

async function loadRow(kind: string, id: string): Promise<Row | null> {
  if (kind === 'claim') {
    const { data: c } = await db.from('claims').select('id, wallet_address, status, tx_hash, amount, source_chain, relay_error, created_at, recovery_action, recovery_action_at, recovery_action_by').eq('id', id).maybeSingle()
    if (!c) return null
    const src = canon(c.source_chain as string)
    return {
      kind: 'claim', id: c.id, wallet: c.wallet_address, status: c.status, burnTx: c.tx_hash, amount: Number(c.amount),
      sourceChain: src, destinationChain: 'Arc_Testnet', sourceDomain: CCTP_DOMAINS[src],
      destRpcs: ARC_RPCS, relayError: c.relay_error, createdAt: c.created_at,
      action: readAction(c.recovery_action, c.recovery_action_at, c.recovery_action_by),
    }
  }
  if (kind === 'transfer') {
    const { data: t } = await db.from('activity').select('id, wallet_address, status, tx_hash, amount, destination_chain, created_at, activity_type, metadata').eq('id', id).maybeSingle()
    if (!t || t.activity_type !== 'bridge') return null
    const dst = canon(t.destination_chain as string)
    return {
      kind: 'transfer', id: t.id, wallet: t.wallet_address, status: t.status, burnTx: t.tx_hash, amount: Number(t.amount),
      sourceChain: 'Arc_Testnet', destinationChain: dst, sourceDomain: ARC_DOMAIN,
      destRpcs: CHAIN_RPCS[dst] ?? [], metadata: (t.metadata ?? {}) as Record<string, unknown>, createdAt: t.created_at,
      action: readAction((t.metadata as any)?.recovery_action, (t.metadata as any)?.recovery_action_at, (t.metadata as any)?.recovery_action_by),
    }
  }
  return null
}

type Diagnosis = {
  state:
    | 'already_minted' | 'waiting_attestation' | 'ready_relay' | 'ready_self_mint'
    | 'forwarder_only' | 'needs_reattest' | 'no_message' | 'unsupported_chain'
  detail?: string
  nonce?: string
  message?: string
  attestation?: string
  messageTransmitter?: string
  destinationChain?: string
  destinationMintTxHash?: string | null
  destinationCaller?: string
}

async function diagnose(r: Row): Promise<Diagnosis> {
  if (r.sourceDomain === undefined || r.destRpcs.length === 0) {
    return { state: 'unsupported_chain', detail: `No CCTP config for ${r.kind === 'claim' ? r.sourceChain : r.destinationChain}` }
  }
  const res = await fetch(`${IRIS}/v2/messages/${r.sourceDomain}?transactionHash=${r.burnTx}`, { signal: AbortSignal.timeout(10000) })
  const body = await res.json().catch(() => ({}))
  const msg = body?.messages?.[0]
  if (!msg) return { state: 'no_message', detail: `Circle has no CCTP message for burn ${r.burnTx} (http ${res.status})` }
  if (msg.status !== 'complete' || !msg.attestation || msg.attestation === 'PENDING' || !msg.message || msg.message === '0x') {
    return { state: 'waiting_attestation', detail: `Circle status: ${msg.status ?? 'unknown'}${msg.delayReason ? ` (${msg.delayReason})` : ''}` }
  }

  const decoded = decodeMessage(msg.message)
  if (!decoded) return { state: 'no_message', detail: 'Could not decode CCTP message' }

  const used = await rpc(r.destRpcs, 'eth_call', [{ to: MESSAGE_TRANSMITTER_V2, data: USED_NONCES_SELECTOR + decoded.nonce.slice(2) }, 'latest'])
  const mintTx = typeof msg.forwardTxHash === 'string' ? msg.forwardTxHash
    : typeof msg.destinationMintTxHash === 'string' ? msg.destinationMintTxHash : null
  if (used && BigInt(used) !== 0n) {
    return { state: 'already_minted', nonce: decoded.nonce, destinationMintTxHash: mintTx }
  }

  // Iris puts expirationBlock under decodedMessage.decodedMessageBody for
  // CCTP V2 — reading only decodedMessage.expirationBlock always gave 0, so
  // an expired attestation was reported as "ready" and the relay then
  // reverted with "Message expired and must be re-signed".
  const expirationBlock = Number(
    msg.decodedMessage?.decodedMessageBody?.expirationBlock ?? msg.decodedMessage?.expirationBlock ?? 0,
  )
  if (expirationBlock > 0) {
    const head = Number(BigInt(await rpc(r.destRpcs, 'eth_blockNumber', [])))
    if (head >= expirationBlock) return { state: 'needs_reattest', nonce: decoded.nonce, detail: `Attestation expired at block ${expirationBlock}` }
  }
  // Belt and braces: simulate receiveMessage on the destination. The chain
  // is the judge of whether this attestation is still usable.
  const sim = await simulateReceive(r.destRpcs, msg.message, msg.attestation)
  if (sim && /expired/i.test(sim)) {
    return { state: 'needs_reattest', nonce: decoded.nonce, detail: 'Attestation expired — request a new one' }
  }

  const caller = decoded.destinationCaller.toLowerCase()
  const base = {
    nonce: decoded.nonce, message: msg.message, attestation: msg.attestation,
    messageTransmitter: MESSAGE_TRANSMITTER_V2, destinationChain: r.destinationChain, destinationCaller: caller,
  }
  const openCaller = caller === '0x' + '0'.repeat(40)

  if (r.kind === 'claim') {
    if (!openCaller) return { ...base, state: 'forwarder_only', detail: `Only ${caller} may mint this message; waiting on Circle's forwarder` }
    return { ...base, state: 'ready_relay' }
  }
  if (!openCaller && caller !== r.wallet.toLowerCase()) {
    return { ...base, state: 'forwarder_only', detail: `Only ${caller} may mint this message; waiting on Circle's forwarder` }
  }
  return { ...base, state: 'ready_self_mint' }
}

// eth_call receiveMessage(message, attestation); returns the revert reason, or null if it would succeed.
async function simulateReceive(urls: string[], message: string, attestation: string): Promise<string | null> {
  const strip = (h: string) => h.replace(/^0x/, '')
  const pad = (n: number) => n.toString(16).padStart(64, '0')
  const m = strip(message), a = strip(attestation)
  const mPad = m.padEnd(Math.ceil(m.length / 64) * 64, '0')
  const aPad = a.padEnd(Math.ceil(a.length / 64) * 64, '0')
  // receiveMessage(bytes,bytes) selector 0x57ecfd28
  const data = '0x57ecfd28' + pad(64) + pad(64 + 32 + mPad.length / 2) + pad(m.length / 2) + mPad + pad(a.length / 2) + aPad
  for (const url of urls) {
    if (!url || url.endsWith('/')) continue
    try {
      const res = await fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: MESSAGE_TRANSMITTER_V2, data }, 'latest'] }),
        signal: AbortSignal.timeout(8000),
      })
      const j = await res.json()
      if (j.error) return String(j.error.message ?? JSON.stringify(j.error))
      return null
    } catch { /* try next RPC */ }
  }
  return null
}

// `recovered` = this completion came from a recovery action (relay / self
// mint). A plain status correction ("it already arrived") is not labelled
// as a recovery. A claim already re-queued via retry-relay keeps the
// recovered_via it got then.
async function markCompleted(r: Row, mintTx: string | null, recovered = false) {
  const now = new Date().toISOString()
  if (r.kind === 'claim') {
    const base = {
      status: 'completed', completed_at: now, error: null, needs_review: false,
      ...(recovered ? { recovered_via: 'cctp' } : {}),
    }
    const { error } = await db.from('claims').update({ ...base, ...(mintTx ? { destination_tx_hash: mintTx } : {}) })
      .eq('id', r.id).neq('status', 'completed')
    // destination_tx_hash is unique — if another row already holds this mint
    // hash (older amount-matching reconciliation), still mark it completed.
    if (error) await db.from('claims').update(base).eq('id', r.id).neq('status', 'completed')
  } else {
    const metadata = recovered ? { ...(r.metadata ?? {}), recovered_via: 'cctp' } : (r.metadata ?? {})
    const { error } = await db.from('activity').update({
      status: 'completed', error: null, needs_review: false, metadata,
      ...(mintTx ? { destination_tx_hash: mintTx } : {}),
    }).eq('id', r.id).neq('status', 'completed')
    if (error) await db.from('activity').update({ status: 'completed', error: null, needs_review: false, metadata }).eq('id', r.id).neq('status', 'completed')
  }
}

type Caller = { wallet: string | null; adminEmail: string | null; uid: string }

async function identify(req: Request): Promise<Caller | null> {
  const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '')
  if (!jwt) return null
  const { data } = await db.auth.getUser(jwt)
  const uid = data?.user?.id
  if (!uid) return null
  const [{ data: u }, { data: a }] = await Promise.all([
    db.from('users').select('wallet_address').eq('auth_uid', uid).maybeSingle(),
    db.from('admin_users').select('email').eq('id', uid).maybeSingle(),
  ])
  return {
    uid,
    wallet: (u?.wallet_address as string | undefined)?.toLowerCase() ?? null,
    adminEmail: a ? String(a.email ?? 'admin') : null,
  }
}

async function audit(caller: Caller, action: string, targetKind: string, targetId: string, result: unknown) {
  await db.from('admin_recovery_log').insert({
    admin_id: caller.uid, admin_email: caller.adminEmail, action, target_kind: targetKind, target_id: targetId,
    result: typeof result === 'string' ? { message: result } : (result ?? {}),
  }).then(() => {}, () => {})
}

// ── Admin: everything stuck, all users ──────────────────────────────────────
async function adminList() {
  const cutoff = new Date(Date.now() - RECOVERABLE_AFTER_MS).toISOString()
  const [claims, transfers, ubStuck, ubIntents, ubWithdrawals] = await Promise.all([
    db.from('claims').select('id, wallet_address, source_chain, amount, status, error, tx_hash, created_at, recovery_action, recovery_action_at, recovery_action_by')
      .or(`status.eq.failed,and(status.in.(submitted,bridging,verifying,settling),created_at.lt.${cutoff})`)
      .order('created_at', { ascending: false }).limit(200),
    db.from('activity').select('id, wallet_address, destination_chain, counterparty_address, amount, status, error, tx_hash, created_at')
      .eq('activity_type', 'bridge')
      .or(`status.eq.failed,and(status.eq.pending,created_at.lt.${cutoff})`)
      .order('created_at', { ascending: false }).limit(200),
    db.from('activity').select('id, wallet_address, amount, created_at, metadata')
      .eq('activity_type', 'withdraw').eq('status', 'pending').contains('metadata', { ub_stuck_transfer: true })
      .order('created_at', { ascending: false }).limit(200),
    db.from('ub_claim_intents').select('id, wallet_address, source_chain, amount, send_amount, status, last_error, deposit_tx, attempts, created_at')
      .or(`status.in.(failed,expired),and(status.in.(waiting,submitted),created_at.lt.${cutoff})`)
      .order('created_at', { ascending: false }).limit(200),
    db.from('activity').select('id, wallet_address, amount, created_at, metadata')
      .eq('activity_type', 'withdraw').eq('status', 'pending').contains('metadata', { ub_recovery: true })
      .order('created_at', { ascending: false }).limit(200),
  ])

  const wallets = new Set<string>()
  for (const set of [claims.data, transfers.data, ubStuck.data, ubIntents.data, ubWithdrawals.data]) {
    for (const r of set ?? []) wallets.add(String((r as any).wallet_address).toLowerCase())
  }
  const names: Record<string, string> = {}
  if (wallets.size) {
    const { data: users } = await db.from('users').select('wallet_address, username').in('wallet_address', [...wallets])
    for (const u of users ?? []) names[String(u.wallet_address).toLowerCase()] = u.username
    // wallet_address casing can differ — second pass case-insensitively for misses
    const misses = [...wallets].filter(w => !names[w])
    for (const w of misses.slice(0, 50)) {
      const { data: u } = await db.from('users').select('username').ilike('wallet_address', w).maybeSingle()
      if (u?.username) names[w] = u.username
    }
  }
  const who = (w: string) => ({ wallet: String(w).toLowerCase(), username: names[String(w).toLowerCase()] ?? null })

  return {
    items: [
      ...(claims.data ?? []).map((c: any) => ({
        kind: 'claim', id: c.id, ...who(c.wallet_address), route: 'CCTP', from: c.source_chain, to: 'Arc_Testnet',
        destinationAddress: c.wallet_address, amount: Number(c.amount), status: c.status, error: c.error, txHash: c.tx_hash, createdAt: c.created_at,
        action: activeAction(c.status, readAction(c.recovery_action, c.recovery_action_at, c.recovery_action_by)),
      })),
      ...(transfers.data ?? []).map((t: any) => ({
        kind: 'transfer', id: t.id, ...who(t.wallet_address), route: 'CCTP', from: 'Arc_Testnet', to: t.destination_chain,
        destinationAddress: t.counterparty_address ?? null, amount: Number(t.amount), status: t.status, error: t.error, txHash: t.tx_hash, createdAt: t.created_at,
      })),
      ...(ubStuck.data ?? []).map((s: any) => ({
        kind: 'ub_transfer', id: s.id, ...who(s.wallet_address), route: 'UB', from: 'Arc_Testnet', to: s.metadata?.destination_chain,
        destinationAddress: s.metadata?.destination_address ?? null, amount: Number(s.amount), status: 'waiting_for_user',
        error: null, txHash: s.metadata?.deposit_tx ?? null, createdAt: s.created_at,
      })),
      ...(ubIntents.data ?? []).map((i: any) => ({
        kind: 'ub_claim', id: i.id, ...who(i.wallet_address), route: 'UB', from: i.source_chain, to: 'Arc_Testnet',
        destinationAddress: i.wallet_address, amount: Number(i.amount), status: i.status, error: i.last_error,
        txHash: i.deposit_tx, attempts: i.attempts, createdAt: i.created_at,
      })),
      ...(ubWithdrawals.data ?? []).map((w: any) => ({
        kind: 'ub_withdrawal', id: w.id, ...who(w.wallet_address), route: 'UB', from: w.metadata?.withdraw_chain ?? 'Arc_Testnet',
        to: w.metadata?.withdraw_chain ?? 'Arc_Testnet', destinationAddress: w.wallet_address, amount: Number(w.amount),
        status: 'withdrawing', error: null, txHash: w.metadata?.init_tx_hash ?? null, readyAt: w.metadata?.eligible_at ?? null, createdAt: w.created_at,
      })),
    ].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))),
    relayerConfigured: !!RELAYER_PRIVATE_KEY,
  }
}

// ── Admin: MeshPort relayer mints a stuck transfer on its destination ──────
// receiveMessage mints to the recipient INSIDE the attested message — the
// relayer only pays gas; it cannot redirect funds.
async function relayerMintTransfer(row: Row, d: Diagnosis): Promise<{ mintTxHash: string }> {
  if (!RELAYER_PRIVATE_KEY) throw new Error('RELAYER_PRIVATE_KEY is not configured')
  if (d.state !== 'ready_self_mint' || !d.message || !d.attestation) throw new Error(`Not mintable (${d.state})`)
  const caller = (d.destinationCaller ?? '').toLowerCase()
  if (caller !== '0x' + '0'.repeat(40)) throw new Error('This message is locked to the user’s own wallet — only the user can mint it')
  const url = row.destRpcs.find(u => u && !u.endsWith('/'))
  if (!url) throw new Error(`No RPC for ${row.destinationChain}`)
  const chainId = Number(BigInt(await rpc(row.destRpcs, 'eth_chainId', [])))
  const chain = { id: chainId, name: row.destinationChain, nativeCurrency: { name: 'Native', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [url] } } } as const
  const account = privateKeyToAccount((RELAYER_PRIVATE_KEY.startsWith('0x') ? RELAYER_PRIVATE_KEY : `0x${RELAYER_PRIVATE_KEY}`) as `0x${string}`)
  const pub = createPublicClient({ chain, transport: http(url) })
  const abi = [{ type: 'function', name: 'receiveMessage', stateMutability: 'nonpayable',
    inputs: [{ name: 'message', type: 'bytes' }, { name: 'attestation', type: 'bytes' }], outputs: [{ name: 'success', type: 'bool' }] }] as const
  const { request } = await pub.simulateContract({
    account, address: MESSAGE_TRANSMITTER_V2 as `0x${string}`, abi, functionName: 'receiveMessage',
    args: [d.message as `0x${string}`, d.attestation as `0x${string}`],
  })
  const wallet = createWalletClient({ account, chain, transport: http(url) })
  const hash = await wallet.writeContract(request)
  const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 90_000 })
  if (receipt.status !== 'success') throw new Error('Mint transaction reverted')
  await markCompleted(row, hash, true)
  return { mintTxHash: hash }
}

async function notifyUser(kind: string, id: string): Promise<string> {
  let wallet = ''
  let what = 'a cross-chain move'
  if (kind === 'claim') {
    const { data } = await db.from('claims').select('wallet_address, source_chain, amount').eq('id', id).maybeSingle()
    wallet = data?.wallet_address ?? ''; what = `your ${Number(data?.amount ?? 0).toFixed(2)} USDC claim from ${String(data?.source_chain ?? '').replace(/_/g, ' ')}`
  } else if (kind === 'ub_claim') {
    const { data } = await db.from('ub_claim_intents').select('wallet_address, source_chain, amount').eq('id', id).maybeSingle()
    wallet = data?.wallet_address ?? ''; what = `your ${Number(data?.amount ?? 0).toFixed(2)} USDC claim from ${String(data?.source_chain ?? '').replace(/_/g, ' ')}`
  } else {
    const { data } = await db.from('activity').select('wallet_address, amount, destination_chain, metadata').eq('id', id).maybeSingle()
    wallet = data?.wallet_address ?? ''
    const dest = (data?.metadata as any)?.destination_label ?? String(data?.destination_chain ?? '').replace(/_/g, ' ')
    what = `your ${Number(data?.amount ?? 0).toFixed(2)} USDC transfer to ${dest}`
  }
  if (!wallet) throw new Error('Row not found')
  const { data: u } = await db.from('users').select('id').ilike('wallet_address', wallet).maybeSingle()
  if (!u?.id) throw new Error('User not found')
  const { error } = await db.from('notifications').insert({
    user_id: u.id, type: 'recovery_action_needed', title: 'Action needed: finish your transfer',
    message: `We noticed ${what} didn't finish. Open Multichain Hub → Recover to complete it — your funds are safe.`,
    read: false,
  })
  if (error) throw new Error(error.message)
  return 'User notified'
}

Deno.serve(async (req: Request) => {
  const preflight = handleOptionsFor(req)
  if (preflight) return preflight
  if (req.method !== 'POST') return jsonFor(req, { error: 'Method not allowed' }, 405)

  let b: Record<string, unknown> = {}
  try { b = await req.json() } catch { /* validated below */ }
  const caller = await identify(req)
  if (!caller || (!caller.wallet && !caller.adminEmail)) return jsonFor(req, { error: 'Invalid or expired session' }, 401)
  const isAdmin = !!caller.adminEmail
  const action = String(b.action ?? '')

  try {
    // ── admin-only ──────────────────────────────────────────────────────
    if (action.startsWith('admin-')) {
      if (!isAdmin) return jsonFor(req, { error: 'Admins only' }, 403)
      const id = String(b.id ?? '')
      if (action === 'admin-list') return jsonFor(req, await adminList())

      if (action === 'admin-relay-transfer') {
        const row = await loadRow('transfer', id)
        if (!row) return jsonFor(req, { error: 'Not found' }, 404)
        const d = await diagnose(row)
        if (d.state === 'already_minted') {
          if (row.status !== 'completed') await markCompleted(row, d.destinationMintTxHash ?? null)
          await audit(caller, action, 'transfer', id, d)
          return jsonFor(req, d)
        }
        try {
          const out = await relayerMintTransfer(row, d)
          await audit(caller, action, 'transfer', id, out)
          return jsonFor(req, { state: 'already_minted', destinationMintTxHash: out.mintTxHash })
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          await audit(caller, action, 'transfer', id, { error: msg })
          return jsonFor(req, { ...d, error: msg }, 409)
        }
      }

      if (action === 'admin-requeue-ub-intent') {
        const { data: i } = await db.from('ub_claim_intents').select('status').eq('id', id).maybeSingle()
        if (!i) return jsonFor(req, { error: 'Not found' }, 404)
        if (i.status === 'completed') return jsonFor(req, { error: 'Already completed' }, 409)
        // Same signed intent, same recipient — only the retry state resets.
        await db.from('ub_claim_intents').update({
          status: 'waiting', attempts: 0, last_error: null, transfer_id: null, created_at: new Date().toISOString(),
        }).eq('id', id).neq('status', 'completed')
        await audit(caller, action, 'ub_claim', id, { requeued: true })
        return jsonFor(req, { state: 'requeued' })
      }

      if (action === 'admin-notify') {
        const kind = String(b.kind ?? '')
        const msg = await notifyUser(kind, id)
        await audit(caller, action, kind, id, msg)
        return jsonFor(req, { state: 'notified', detail: msg })
      }
      return jsonFor(req, { error: 'Unknown action' }, 400)
    }

    // ── user (or admin acting on any row) ───────────────────────────────
    if (action === 'list') {
      if (!caller.wallet) return jsonFor(req, { claims: [], transfers: [] })
      const cutoff = new Date(Date.now() - RECOVERABLE_AFTER_MS).toISOString()
      const [claims, transfers] = await Promise.all([
        db.from('claims').select('id, source_chain, amount, status, error, created_at, recovery_action, recovery_action_at, recovery_action_by')
          .ilike('wallet_address', caller.wallet)
          .or(`status.eq.failed,and(status.in.(submitted,bridging,verifying,settling),created_at.lt.${cutoff})`)
          .order('created_at', { ascending: false }).limit(50),
        db.from('activity').select('id, destination_chain, amount, status, error, created_at, metadata')
          .ilike('wallet_address', caller.wallet).eq('activity_type', 'bridge')
          .or(`status.eq.failed,and(status.eq.pending,created_at.lt.${cutoff})`)
          .order('created_at', { ascending: false }).limit(50),
      ])
      return jsonFor(req, {
        claims: (claims.data ?? []).map((c: any) => ({
          kind: 'claim', id: c.id, chain: c.source_chain, amount: Number(c.amount), status: c.status, error: c.error, createdAt: c.created_at,
          action: activeAction(c.status, readAction(c.recovery_action, c.recovery_action_at, c.recovery_action_by)),
        })),
        transfers: (transfers.data ?? []).map((t: any) => ({
          kind: 'transfer', id: t.id, chain: t.destination_chain, amount: Number(t.amount), status: t.status, error: t.error, createdAt: t.created_at,
          action: activeAction(t.status, readAction(t.metadata?.recovery_action, t.metadata?.recovery_action_at, t.metadata?.recovery_action_by)),
        })),
      })
    }

    const kind = String(b.kind ?? (action === 'retry-relay' ? 'claim' : ''))
    const id = String(b.id ?? '')
    const row = await loadRow(kind, id)
    if (!row) return jsonFor(req, { error: 'Not found' }, 404)
    const ownsRow = !!caller.wallet && row.wallet.toLowerCase() === caller.wallet
    if (!ownsRow && !isAdmin) return jsonFor(req, { error: 'Not found' }, 404)
    if (!row.burnTx) return jsonFor(req, { error: 'This record has no burn transaction' }, 400)

    const d = await diagnose(row)
    // `selfMinted`: the user just minted it with their own wallet from Recover
    // (lib/cctpRecovery.selfMintClaim) — label it as a recovery.
    if (d.state === 'already_minted' && row.status !== 'completed') {
      // Iris only knows the mint hash for forwarded mints. For a self-mint the
      // app sends its own tx hash — verified on-chain here — so the claim keeps
      // its Arc mint hash (without it the recovery scan later sees an
      // "untracked" mint and records the same funds a second time).
      let mintTx = d.destinationMintTxHash ?? null
      const sent = typeof b.mintTxHash === 'string' ? b.mintTxHash : ''
      if (!mintTx && b.selfMinted === true && /^0x[0-9a-fA-F]{64}$/.test(sent)) {
        const receipt = await rpc(row.destRpcs, 'eth_getTransactionReceipt', [sent]).catch(() => null)
        if (receipt?.status === '0x1') mintTx = sent.toLowerCase()
      }
      await markCompleted(row, mintTx, ownsRow && b.selfMinted === true)
    }
    // An in-flight claim whose attestation expired can never finish on its
    // own — show it as failed (with the way out) instead of "Processing…".
    if (d.state === 'needs_reattest' && row.kind === 'claim' && row.status !== 'failed' && row.status !== 'completed') {
      await db.from('claims').update({
        status: 'failed', error: 'Attestation expired — open Recover, request a new attestation, then finish the claim.',
      }).eq('id', row.id).neq('status', 'completed')
    }

    // A step already running (user or MeshPort) → report it as still
    // processing instead of offering the same step again.
    const running = activeAction(row.status, row.action)
    const reply: Record<string, unknown> = { ...d, action: running }
    if (running?.kind === 'reattest' && (d.state === 'needs_reattest' || d.state === 'waiting_attestation')) {
      reply.state = 'reattest_pending'
      reply.detail = 'Circle is issuing a new attestation — check again in a few minutes.'
    } else if (running?.kind === 'relay' && (d.state === 'ready_relay' || d.state === 'waiting_attestation')) {
      reply.state = 'relay_queued'
    }

    if (action === 'inspect') return jsonFor(req, reply)

    if (action === 'retry-relay') {
      if (running?.kind === 'relay') return jsonFor(req, reply)
      if (d.state !== 'ready_relay') return jsonFor(req, reply)
      await db.from('claims').update({
        status: 'verifying', message_hash: d.message, verifying_at: new Date().toISOString(),
        settling_at: null, relay_tx_hash: null, relay_error: null, relay_submitted_at: null,
        attempts: 0, error: null, needs_review: false, completed_at: null, recovered_via: 'cctp',
      }).eq('id', row.id).neq('status', 'completed')
      await saveAction(row, 'relay', ownsRow ? 'user' : 'meshport')
      if (!ownsRow) await audit(caller, 'retry-relay', 'claim', id, { queued: true })
      return jsonFor(req, { ...d, state: 'relay_queued', action: { kind: 'relay', at: new Date().toISOString(), by: ownsRow ? 'user' : 'meshport' } })
    }

    if (action === 'reattest') {
      if (running?.kind === 'reattest') return jsonFor(req, reply)
      if (d.state !== 'needs_reattest' || !d.nonce) return jsonFor(req, reply)
      const r = await fetch(`${IRIS}/v2/reattest/${d.nonce}`, { method: 'POST', signal: AbortSignal.timeout(10000) })
      if (r.ok) {
        await saveAction(row, 'reattest', ownsRow ? 'user' : 'meshport')
        if (row.kind === 'claim') await db.from('claims').update({ recovered_via: 'cctp' }).eq('id', row.id).neq('status', 'completed')
      }
      if (!ownsRow) await audit(caller, 'reattest', row.kind, id, { ok: r.ok, status: r.status })
      return jsonFor(req, {
        state: r.ok ? 'reattest_requested' : 'reattest_failed', detail: `http ${r.status}`,
        action: r.ok ? { kind: 'reattest', at: new Date().toISOString(), by: ownsRow ? 'user' : 'meshport' } : null,
      })
    }

    if (action === 'confirm-mint') {
      if (!ownsRow) return jsonFor(req, { error: 'Not found' }, 404)
      const mintTx = typeof b.mintTxHash === 'string' ? b.mintTxHash : ''
      if (row.kind !== 'transfer' || !/^0x[0-9a-fA-F]{64}$/.test(mintTx)) return jsonFor(req, { error: 'Invalid request' }, 400)
      if (d.state !== 'already_minted') return jsonFor(req, { ...d, error: 'Mint not visible on-chain yet' }, 409)
      const receipt = await rpc(row.destRpcs, 'eth_getTransactionReceipt', [mintTx]).catch(() => null)
      const ok = receipt?.status === '0x1' && (receipt.to ?? '').toLowerCase() === MESSAGE_TRANSMITTER_V2.toLowerCase()
      await markCompleted(row, ok ? mintTx : null, true)
      return jsonFor(req, { state: 'already_minted', destinationMintTxHash: ok ? mintTx : null })
    }

    return jsonFor(req, { error: 'Unknown action' }, 400)
  } catch (e) {
    console.error('[cctp-recovery]', e instanceof Error ? e.message : e)
    return jsonFor(req, { error: 'Recovery check failed — try again' }, 500)
  }
})
