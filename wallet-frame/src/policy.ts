// wallet-frame/src/policy.ts
//
// What a signature request can move out of the wallet, read by the frame
// itself. Two uses:
//
//   spend limits ('confirm:begin' with a scope): the person approved "up to
//   N USDC / EURC / cirBTC may leave my wallet in the next 2 minutes" on
//   confirm.html. Each request in that window is decoded here - token
//   transfers, approvals and permits, transfer authorizations, Gateway burn
//   intents, Arc's native USDC - and counted against the limit. A request
//   this file can't read is allowed only when it can't move tokens by itself
//   (no token-moving call, no unlimited approval, not Permit2, not a Safe)
//   and goes to a contract the scope names. Anything else is refused, and
//   the app asks for that exact request on confirm.html.
//
//   exact requests ('confirm:begin' with a request): what confirm.html shows
//   for one signature request, read from its own fields.
//
// Tokens are known by address (USDC on every chain MeshPort uses, Arc's
// EURC and cirBTC); their decimals come from this bundle, never the app.

import { decodeFunctionData, formatUnits, getAddress, type Hex } from 'viem'
import { ARC_TOKENS, EXTERNAL_CHAINS } from '@/blockchain/chains'
import { ARC_CHAIN_ID, describeIntent, type IntentView } from './intent'

export type Asset = 'USDC' | 'EURC' | 'cirBTC'
export const ASSETS: Asset[] = ['USDC', 'EURC', 'cirBTC']
/** Spends are counted in 18-decimal units, whatever the token's own decimals. */
export const SCALE = 18

const TOKENS = new Map<string, { asset: Asset; decimals: number }>()
TOKENS.set(ARC_TOKENS.USDC.contract.toLowerCase(), { asset: 'USDC', decimals: 6 })
TOKENS.set(ARC_TOKENS.EURC.contract.toLowerCase(), { asset: 'EURC', decimals: ARC_TOKENS.EURC.decimals })
TOKENS.set(ARC_TOKENS.cirBTC.contract.toLowerCase(), { asset: 'cirBTC', decimals: ARC_TOKENS.cirBTC.decimals })
for (const c of Object.values(EXTERNAL_CHAINS)) TOKENS.set(c.usdc.toLowerCase(), { asset: 'USDC', decimals: c.decimals })
TOKENS.set('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', { asset: 'USDC', decimals: 6 }) // Ethereum mainnet

/** Circle's contracts MeshPort's flows call (App Kit's swap adapter, CCTP v2, Gateway). Named by this bundle. */
export const CIRCLE_CONTRACTS = new Map<string, string>([
  ['0xbbd70b01a1cabc96d5b7b129ae1aaabdf50dd40b', 'Circle swap'],
  ['0x7fb8c7260b63934d8da38af902f87ae6e284a845', 'Circle swap'],
  ['0x8fe6b999dc680ccfdd5bf7eb0974218be2542daa', 'Circle CCTP'],
  ['0x28b5a0e9c621a5badaa536219b3a228c8168cf5d', 'Circle CCTP'],
  ['0xe737e5cebeeba77efe34d4aa090756590b1ce275', 'Circle CCTP'],
  ['0x81d40f21f12a8f0e3252bccb954d722d4c464b64', 'Circle CCTP'],
  ['0x0077777d7eba4688bdef3e311b846f25870a19b9', 'Circle Gateway'],
  ['0x77777777dcc4d5a8b6e418fd04d8997ef11000ee', 'Circle Gateway'],
  ['0x0022222abe238cc2c7bb1f21003f0a260052475b', 'Circle Gateway'],
  ['0x2222222d7164433c4c09b0b0d809a9b52c04c205', 'Circle Gateway'],
])
const PERMIT2 = '0x000000000022d473030f116ddee9f6b43ac78ba3'
/**
 * Circle Gateway's wallet contract (testnet, mainnet). Money deposited there
 * is still the person's - their Unified Balance - and only leaves when a
 * burn intent spends it, which is counted. So a deposit to their own
 * balance, and the approval it needs, don't count against a spend limit
 * (a Unified Balance transfer used to count the same money twice and ask
 * for the passcode again). A deposit credited to someone else does count,
 * and any other Gateway wallet call (adding a delegate who could spend the
 * balance, withdrawing) is confirmed on its own.
 */
const GATEWAY_WALLETS = new Set(['0x0077777d7eba4688bdef3e311b846f25870a19b9', '0x77777777dcc4d5a8b6e418fd04d8997ef11000ee'])
const GATEWAY_ABI = [
  { type: 'function', name: 'deposit', stateMutability: 'nonpayable', outputs: [], inputs: [{ name: 'token', type: 'address' }, { name: 'value', type: 'uint256' }] },
  { type: 'function', name: 'depositFor', stateMutability: 'nonpayable', outputs: [], inputs: [{ name: 'token', type: 'address' }, { name: 'depositor', type: 'address' }, { name: 'value', type: 'uint256' }] },
] as const
/** Most a single transaction may spend on fees inside a spend limit (native units). */
const MAX_FEE_ARC = 100_000_000_000_000_000n // 0.1 USDC
const MAX_FEE_OTHER = 10_000_000_000_000_000n // 0.01 of that chain's coin

const TOKEN_ABI = [
  { type: 'function', name: 'transfer', stateMutability: 'nonpayable', outputs: [], inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }] },
  { type: 'function', name: 'approve', stateMutability: 'nonpayable', outputs: [], inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }] },
  { type: 'function', name: 'increaseAllowance', stateMutability: 'nonpayable', outputs: [], inputs: [{ name: 'spender', type: 'address' }, { name: 'added', type: 'uint256' }] },
  { type: 'function', name: 'transferFrom', stateMutability: 'nonpayable', outputs: [], inputs: [{ name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }] },
  { type: 'function', name: 'permit', stateMutability: 'nonpayable', outputs: [], inputs: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'deadline', type: 'uint256' }, { name: 'v', type: 'uint8' }, { name: 'r', type: 'bytes32' }, { name: 's', type: 'bytes32' }] },
  { type: 'function', name: 'transferWithAuthorization', stateMutability: 'nonpayable', outputs: [], inputs: [{ name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' }, { name: 'v', type: 'uint8' }, { name: 'r', type: 'bytes32' }, { name: 's', type: 'bytes32' }] },
  { type: 'function', name: 'receiveWithAuthorization', stateMutability: 'nonpayable', outputs: [], inputs: [{ name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' }, { name: 'v', type: 'uint8' }, { name: 'r', type: 'bytes32' }, { name: 's', type: 'bytes32' }] },
] as const
// Calls that move tokens or hand out control, whatever contract they go to.
const MOVING = new Set(['0xa9059cbb', '0x095ea7b3', '0x39509351', '0x23b872dd', '0xd505accf', '0xe3ee160e', '0xef55bec6',
  '0xa22cb465', // setApprovalForAll
  '0x6a761202', // Safe execTransaction
  '0x42842e0e', '0xb88d4fde', '0xf242432a', '0x2eb2c2d6', // NFT safe transfers
])

const big = (v: unknown): bigint => (v == null ? 0n : BigInt(v as bigint | string | number))
const to18 = (raw: bigint, decimals: number) => raw * 10n ** BigInt(SCALE - decimals)
const lower = (v: unknown) => (typeof v === 'string' ? v.toLowerCase() : '')

export type Spends = Partial<Record<Asset, bigint>>
export type Classified = { ok: true; spends: Spends; calls: string[] } | { ok: false; reason: string }
const add = (s: Spends, asset: Asset, amount: bigint) => { s[asset] = (s[asset] ?? 0n) + amount }
const refuse = (reason: string): Classified => ({ ok: false, reason })

function classifyTransaction(self: string, tx: Record<string, unknown>): Classified {
  if (tx.authorizationList != null || tx.type === 'eip7702' || tx.blobs != null || tx.blobVersionedHashes != null) return refuse('a delegation or blob transaction')
  const chainId = Number(tx.chainId)
  const onArc = chainId === ARC_CHAIN_ID
  const fee = big(tx.gas ?? 0) * big(tx.maxFeePerGas ?? tx.gasPrice)
  if (fee > (onArc ? MAX_FEE_ARC : MAX_FEE_OTHER)) return refuse('an unusually high network fee')
  const spends: Spends = {}
  const value = big(tx.value)
  if (value > 0n) {
    if (!onArc) return refuse("this chain's own coin")
    add(spends, 'USDC', value) // Arc's native coin is USDC (18 decimals)
  }
  const to = lower(tx.to)
  if (!to) return refuse('a contract deployment')
  const data = tx.data == null ? '0x' : lower(tx.data)
  if (data === '0x') return { ok: true, spends, calls: [] }
  const selector = data.slice(0, 10)
  const token = TOKENS.get(to)
  if (token) {
    try {
      const d = decodeFunctionData({ abi: TOKEN_ABI, data: data as Hex })
      const a = d.args as readonly unknown[]
      let amount = 0n
      if (d.functionName === 'approve' || d.functionName === 'increaseAllowance') {
        // Letting Gateway take a set amount for a deposit to this wallet's own
        // Unified Balance (the deposit and its spend are read below / counted
        // as burn intents). An unlimited one still counts in full.
        amount = GATEWAY_WALLETS.has(lower(a[0])) && big(a[1]) < 2n ** 255n ? 0n : big(a[1])
      } else if (d.functionName === 'transfer') amount = big(a[1])
      else if (d.functionName === 'transferFrom') amount = lower(a[0]) === self ? big(a[2]) : 0n
      else amount = lower(a[0]) === self ? big(a[2]) : 0n // permit / *WithAuthorization: the owner's value
      add(spends, token.asset, to18(amount, token.decimals))
      return { ok: true, spends, calls: [] }
    } catch { return refuse(`an unrecognised call to the ${token.asset} contract`) }
  }
  if (GATEWAY_WALLETS.has(to)) {
    try {
      const d = decodeFunctionData({ abi: GATEWAY_ABI, data: data as Hex })
      const a = d.args as readonly unknown[]
      const t = TOKENS.get(lower(a[0]))
      if (!t) return refuse('a Gateway deposit of a token this wallet doesn\'t know')
      // Into this wallet's own Unified Balance: still its money.
      if (d.functionName === 'deposit' || lower(a[1]) === self) return { ok: true, spends, calls: [] }
      add(spends, t.asset, to18(big(a[2]), t.decimals)) // credited to someone else
      return { ok: true, spends, calls: [] }
    } catch { return refuse('a Gateway call other than a deposit') }
  }
  if (MOVING.has(selector)) return refuse('a token transfer or approval this wallet can\'t read')
  if (to === PERMIT2) return refuse('a Permit2 call')
  return { ok: true, spends, calls: [to] }
}

function bytes32Address(v: unknown): string {
  const s = lower(v)
  return /^0x[0-9a-f]{64}$/.test(s) ? '0x' + s.slice(26) : ''
}

function classifyTypedData(self: string, td: Record<string, unknown>): Classified {
  const domain = (td.domain ?? {}) as Record<string, unknown>
  const message = (td.message ?? {}) as Record<string, unknown>
  const type = String(td.primaryType ?? '')
  const contract = lower(domain.verifyingContract)
  const spends: Spends = {}
  if (type === 'Permit' || type === 'TransferWithAuthorization' || type === 'ReceiveWithAuthorization') {
    const token = TOKENS.get(contract)
    if (!token) return refuse(`a ${type} for a token this wallet doesn't know`)
    const owner = lower(type === 'Permit' ? message.owner : message.from)
    if (owner !== self) return refuse(`a ${type} for another account`)
    add(spends, token.asset, to18(big(message.value), token.decimals))
    return { ok: true, spends, calls: [] }
  }
  if (type === 'BurnIntent' || type === 'BurnIntentSet') {
    const intents = type === 'BurnIntentSet' ? (message.intents as unknown[] | undefined) ?? [] : [message]
    if (!Array.isArray(intents) || intents.length === 0 || intents.length > 32) return refuse('a malformed Gateway transfer')
    for (const i of intents as Array<Record<string, unknown>>) {
      const spec = (i.spec ?? {}) as Record<string, unknown>
      const token = TOKENS.get(bytes32Address(spec.sourceToken))
      if (!token) return refuse('a Gateway transfer of a token this wallet doesn\'t know')
      add(spends, token.asset, to18(big(spec.value) + big(i.maxFee), token.decimals))
    }
    return { ok: true, spends, calls: [] }
  }
  // MeshPort's router: pairs with a Permit (counted) for the same funds.
  if (type === 'BridgePermit' && domain.name === 'MeshPortRouter' && contract) {
    if (lower(message.from) !== self) return refuse('a bridge permit for another account')
    return { ok: true, spends, calls: [contract] }
  }
  return refuse(`a ${type || 'typed-data'} signature this wallet can't read`)
}

/** What `method(params)` spends from the wallet at `self`, or why a spend limit can't cover it. */
export function classify(self: string, method: string, params: Record<string, unknown>): Classified {
  const me = self.toLowerCase()
  try {
    if (method === 'sign:transaction') return classifyTransaction(me, (params.transaction ?? {}) as Record<string, unknown>)
    if (method === 'sign:typed-data') return classifyTypedData(me, (params.typedData ?? {}) as Record<string, unknown>)
  } catch { return refuse('a request this wallet can\'t read') }
  if (method === 'solana:sign') return refuse('a Solana transaction')
  if (method === 'passkey:begin') return refuse('a passkey signature')
  return refuse('a message signature')
}

// ── Showing one exact request (confirm.html) ────────────────────────────────
const units = (v: bigint, decimals: number) => {
  const s = formatUnits(v, decimals)
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s
}
const clean = (v: unknown, max = 80) => String(v ?? '').replace(/[^\x20-\x7E]/g, '').slice(0, max)
const named = (address: string) => CIRCLE_CONTRACTS.get(address.toLowerCase()) ?? null
function addrText(a: unknown): string {
  try { const g = getAddress(String(a)); const n = named(g); return n ? `${n} (${g})` : g } catch { return clean(a) }
}

function describeTransaction(tx: Record<string, unknown>): IntentView {
  const chainId = Number(tx.chainId)
  const onArc = chainId === ARC_CHAIN_ID
  const fee = big(tx.gas ?? 0) * big(tx.maxFeePerGas ?? tx.gasPrice)
  if (onArc && typeof tx.to === 'string') {
    try {
      const v = describeIntent({ chainId, to: getAddress(tx.to), value: String(big(tx.value)), data: (tx.data ?? '0x') as Hex, maxFee: String(fee > 0n ? fee : 1n) })
      if (v.action !== 'Contract call') return v
    } catch { /* below */ }
  }
  const to = lower(tx.to)
  const data = tx.data == null ? '0x' : lower(tx.data)
  const token = TOKENS.get(to)
  const rows: IntentView['rows'] = [{ label: 'Network', value: onArc ? 'Arc' : `chain ${chainId}` }]
  const warnings: string[] = []
  let action = data === '0x' ? 'Send' : 'Contract call'
  let amount = units(big(tx.value), 18)
  let symbol = onArc ? 'USDC' : 'native coin'
  let recipient = addrText(tx.to)
  if (token && data !== '0x') {
    try {
      const d = decodeFunctionData({ abi: TOKEN_ABI, data: data as Hex })
      const a = d.args as readonly unknown[]
      symbol = token.asset
      if (d.functionName === 'approve' || d.functionName === 'increaseAllowance') {
        action = 'Allow spending'
        const max = big(a[1]) >= 2n ** 255n
        amount = max ? 'Unlimited' : units(big(a[1]), token.decimals)
        recipient = addrText(a[0])
        if (max) warnings.push(`Lets ${recipient} take any amount of your ${token.asset}`)
      } else if (d.functionName === 'transfer') { action = 'Send'; amount = units(big(a[1]), token.decimals); recipient = addrText(a[0]) }
      else { action = d.functionName; amount = units(big(a[2]), token.decimals); recipient = addrText(a[1]) }
    } catch { warnings.push(`An unrecognised call to the ${token.asset} contract`) }
  } else if (data !== '0x') {
    rows.push({ label: 'Data', value: `${(data.length - 2) / 2} bytes` })
    if (!named(to)) warnings.push('A contract this wallet does not recognise - only continue if you started this')
    if (MOVING.has(data.slice(0, 10))) warnings.push('This moves tokens or hands out control of them')
  }
  rows.push({ label: 'Network fee', value: `at most ${units(fee, 18)} ${onArc ? 'USDC' : 'of the chain\'s coin'}` })
  return { action, amount, token: symbol, to: recipient, rows, warnings }
}

function describeTypedData(td: Record<string, unknown>): IntentView {
  const domain = (td.domain ?? {}) as Record<string, unknown>
  const message = (td.message ?? {}) as Record<string, unknown>
  const type = clean(td.primaryType, 40)
  const token = TOKENS.get(lower(domain.verifyingContract))
  const rows: IntentView['rows'] = [{ label: 'Signing for', value: `${clean(domain.name, 40) || 'unnamed'}${domain.chainId != null ? ` · chain ${clean(domain.chainId, 12)}` : ''}` }]
  if ((type === 'Permit' || type.endsWith('WithAuthorization')) && token) {
    const isPermit = type === 'Permit'
    return {
      action: isPermit ? 'Allow spending' : 'Authorise transfer', amount: units(big(message.value), token.decimals), token: token.asset,
      to: addrText(isPermit ? message.spender : message.to), rows, warnings: [],
    }
  }
  if (type === 'BurnIntent' || type === 'BurnIntentSet') {
    const intents = (type === 'BurnIntentSet' ? (message.intents as unknown[]) : [message]) as Array<Record<string, unknown>>
    let total = 0n; let symbol = 'USDC'; let decimals = 6; let recipient = ''
    for (const i of intents ?? []) {
      const spec = (i.spec ?? {}) as Record<string, unknown>
      const t = TOKENS.get(bytes32Address(spec.sourceToken))
      if (t) { symbol = t.asset; decimals = t.decimals }
      total += big(spec.value) + big(i.maxFee)
      recipient = addrText(bytes32Address(spec.destinationRecipient))
    }
    return { action: 'Gateway transfer', amount: units(total, decimals), token: symbol, to: recipient, rows: [...rows, { label: 'Transfers', value: String(intents?.length ?? 0) }], warnings: [] }
  }
  for (const [k, v] of Object.entries(message).slice(0, 8)) rows.push({ label: clean(k, 24), value: typeof v === 'object' ? '…' : clean(v, 66) })
  return { action: `Sign ${type || 'data'}`, amount: '', token: '', to: addrText(domain.verifyingContract), rows, warnings: ['A signature this wallet can\'t read - it may authorise moving your money. Only continue if you started this.'] }
}

/** What confirm.html shows for one exact request. */
export function describeRequest(method: string, params: Record<string, unknown>): IntentView {
  const source = 'Read from the request by your wallet; approving signs only this, once.'
  return { ...describeRequestView(method, params), source }
}
function describeRequestView(method: string, params: Record<string, unknown>): IntentView {
  try {
    if (method === 'sign:transaction') return describeTransaction((params.transaction ?? {}) as Record<string, unknown>)
    if (method === 'sign:typed-data') return describeTypedData((params.typedData ?? {}) as Record<string, unknown>)
  } catch { /* below */ }
  if (method === 'sign:message') {
    const m = params.message
    if (typeof m === 'string') return { action: 'Sign message', amount: '', token: '', to: '', rows: [{ label: 'Message', value: clean(m.replace(/\n/g, ' '), 300) }], warnings: [] }
    return { action: 'Sign raw data', amount: '', token: '', to: '', rows: [{ label: 'Data', value: clean((m as { raw?: unknown })?.raw, 70) }], warnings: ['Raw data can authorise anything - only continue if you started this.'] }
  }
  if (method === 'solana:sign') {
    return { action: 'Solana transaction', amount: '', token: '', to: '', rows: [{ label: 'Size', value: `${(String(params.message ?? '').length - 2) / 2} bytes` }], warnings: ["Solana transactions can't be read here - only continue if you started this."] }
  }
  if (method === 'passkey:begin') {
    return { action: 'Passkey signature', amount: '', token: '', to: '', rows: [{ label: 'For', value: clean(params.label, 120) || 'your Safe wallet' }], warnings: [] }
  }
  return { action: 'Signature', amount: '', token: '', to: '', rows: [], warnings: ['Only continue if you started this.'] }
}

/** Requests that may be confirmed one by one. */
export const CONFIRMABLE = new Set(['sign:transaction', 'sign:typed-data', 'sign:message', 'solana:sign', 'passkey:begin'])

/** A stable text form of a request's params, to bind a confirmation to exactly it. */
export function canonical(method: string, params: Record<string, unknown>): string {
  const norm = (v: unknown): unknown => {
    if (typeof v === 'bigint') return `${v}n`
    if (typeof v === 'string') return /^0x[0-9a-fA-F]*$/.test(v) ? v.toLowerCase() : v
    if (Array.isArray(v)) return v.map(norm)
    if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map(k => [k, norm((v as Record<string, unknown>)[k])]))
    return v
  }
  const { confirmation: _confirmation, ...rest } = params
  return JSON.stringify([method, norm(rest)])
}

/** A scope from the app, checked: limits per asset (18-decimal units), extra contracts it may call. */
export interface Scope { limits: Spends; contracts: Map<string, string> }
const DECIMAL = /^(0|[1-9][0-9]{0,15})(\.[0-9]{1,18})?$/
export function parseScope(raw: unknown): Scope {
  const r = (raw ?? {}) as { limits?: unknown; contracts?: unknown }
  const limits: Spends = {}
  if (!Array.isArray(r.limits) || r.limits.length === 0 || r.limits.length > ASSETS.length) throw new Error('No spend limit')
  for (const l of r.limits as Array<{ asset?: unknown; amount?: unknown }>) {
    if (!ASSETS.includes(l.asset as Asset) || typeof l.amount !== 'string' || !DECIMAL.test(l.amount)) throw new Error('Bad spend limit')
    const [w, f = ''] = l.amount.split('.')
    limits[l.asset as Asset] = BigInt(w) * 10n ** 18n + BigInt((f + '0'.repeat(18)).slice(0, 18))
  }
  const contracts = new Map<string, string>()
  if (r.contracts != null) {
    if (!Array.isArray(r.contracts) || r.contracts.length > 16) throw new Error('Too many contracts')
    for (const c of r.contracts as Array<{ address?: unknown; label?: unknown }>) {
      if (typeof c.address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(c.address)) throw new Error('Bad contract')
      if (TOKENS.has(c.address.toLowerCase()) || c.address.toLowerCase() === PERMIT2) throw new Error('Not a contract a limit may name')
      contracts.set(c.address.toLowerCase(), clean(c.label, 40) || 'Contract')
    }
  }
  return { limits, contracts }
}

/** confirm.html's lines for a spend limit. */
export function describeScope(scope: Scope): IntentView {
  const parts = ASSETS.filter(a => scope.limits[a]).map(a => `${units(scope.limits[a]!, SCALE)} ${a}`)
  const rows: IntentView['rows'] = [{ label: 'For', value: 'the next 2 minutes' }]
  const contracts = [...scope.contracts.entries()].map(([a, l]) => `${l} (${getAddress(a)}, named by MeshPort)`)
  if (contracts.length) rows.push({ label: 'May also call', value: contracts.join(', ') })
  const source = 'Your wallet counts what every signature in that time moves; anything more, or anything it can\'t read, asks you again.'
  if (!parts.length) return { action: 'Spend limit', amount: 'Nothing', token: '', to: 'leaves your wallet without asking you again', rows, warnings: [], source }
  return { action: 'Up to', amount: parts.join(' + '), token: '', to: 'may leave your wallet', rows, warnings: [], source }
}

/** Whether `c` fits what's left of `scope` (a copy of the remaining limits), and the remainder. */
export function fits(scope: Scope, remaining: Spends, c: Extract<Classified, { ok: true }>): Spends | null {
  for (const call of c.calls) if (!CIRCLE_CONTRACTS.has(call) && !scope.contracts.has(call)) return null
  const next: Spends = { ...remaining }
  for (const a of ASSETS) {
    const s = c.spends[a]
    if (!s) continue
    if (next[a] == null || next[a]! < s) return null
    next[a] = next[a]! - s
  }
  return next
}

