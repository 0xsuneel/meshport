// supabase/functions/name-register/index.ts
//
// Registers MeshPort usernames ("name.arc") in the MeshPortNames contract on
// Arc testnet (foundry/src/MeshPortNames.sol). Users pay no gas: this
// function sends every transaction from the registrar wallet, but a new
// registration only goes through with the user's own EIP-712 signature, which
// the contract checks again - the registrar can't register a name for anyone.
//
// Supabase `users` stays the app's working copy. A name is only sent on-chain
// when the users row already holds that exact username for that wallet, and
// the result is written back to users.name_onchain_*.
//
// Actions (POST JSON { action, ... }):
//   info                     → { contract, chainId, registrar }           public
//   nonce     { wallet }     → { nonce, contract, chainId }               public
//   register  { wallet, name, kind, displayName, deadline, signature }
//                            → { status, txHash? }      signature-gated
//   status    { wallet }     → { status, txHash?, error? }                public
//   sync                     → retries pending/failed, reconciles business
//                              flags                         cron secret only
//   business-sync { wallet } → push one merchant's review result on-chain
//                                                            cron secret only
//   migrate-existing         → one-time import of names registered before the
//                              contract existed, then closes migration
//                                                            cron secret only
//
// Optional env overrides: NAMES_CONTRACT_ADDRESS, NAMES_ADMIN_ADDRESS (the
// admin wallet gets ownership after the one-time import). Defaults below.
// The registrar key lives in Vault (name_registrar_key) and is read through
// public.name_registrar_key(), executable by the service role only. It is
// never logged or returned.

import { createClient } from 'jsr:@supabase/supabase-js@2'
import {
  createPublicClient, createWalletClient, http, defineChain, verifyTypedData, getAddress, isAddress,
  type Hex, type Address,
} from 'npm:viem@2'
import { privateKeyToAccount } from 'npm:viem@2/accounts'
import { handleOptions, json } from '../_shared/cors.ts'
import { isCronOrLegacyServiceCaller } from '../_shared/cronAuth.ts'
import { MESHPORT_NAMES_ABI as ABI } from '../_shared/meshportNamesAbi.ts'

const NAME_RE = /^[a-z0-9_]{3,20}$/
const CHAIN_ID = 5042002
const RECEIPT_WAIT_MS = 25_000
const MAX_DEADLINE_SEC = 7 * 24 * 60 * 60

function serviceKey(): string {
  const legacy = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (legacy) return legacy
  const raw = Deno.env.get('SUPABASE_SECRET_KEYS')
  if (raw) {
    try {
      const p = JSON.parse(raw)
      const k = p?.service_role ?? p?.SUPABASE_SERVICE_ROLE_KEY ?? Object.values(p ?? {})[0]
      if (typeof k === 'string' && k) return k
    } catch { /* fall through */ }
  }
  throw new Error('No Supabase service role key configured')
}
const db = createClient(Deno.env.get('SUPABASE_URL')!, serviceKey())

// Same RPC choice as _shared/chains.ts (authenticated endpoint first), with
// Arc's public RPC as the last resort.
const DRPC_KEY = (Deno.env.get('DRPC_KEY') ?? '').trim()
const RPC = (Deno.env.get('ARC_RPC_URL') ?? '').trim()
  || (DRPC_KEY ? `https://lb.drpc.live/arc-testnet/${DRPC_KEY}` : 'https://rpc.testnet.arc.io')
const arc = defineChain({
  id: CHAIN_ID,
  name: 'Arc Testnet',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
})
const pub = createPublicClient({ chain: arc, transport: http(RPC) })

// Public addresses (Arc testnet). The env vars override them for a redeploy.
const DEFAULT_CONTRACT = '0xba87d216d550e71cef4b0066db8cf66622c9af4b' // MeshPortNames, deployed with Arc Studio
const DEFAULT_ADMIN = '0x05d00ab75bcbe15450143f810cd5e5164ee126e0'    // sunil.arc - MeshPort admin

function contractAddress(): Address | null {
  const a = (Deno.env.get('NAMES_CONTRACT_ADDRESS') ?? '').trim() || DEFAULT_CONTRACT
  return isAddress(a) ? getAddress(a) : null
}

let registrarCache: ReturnType<typeof privateKeyToAccount> | null = null
async function registrar() {
  if (registrarCache) return registrarCache
  const { data, error } = await db.rpc('name_registrar_key')
  if (error || typeof data !== 'string' || !/^0x[0-9a-f]{64}$/i.test(data)) throw new Error('Registrar key unavailable')
  registrarCache = privateKeyToAccount(data as Hex)
  return registrarCache
}

const KIND = { personal: 0, business: 1 } as const
type KindName = keyof typeof KIND

const types = {
  Register: [
    { name: 'name', type: 'string' },
    { name: 'account', type: 'address' },
    { name: 'kind', type: 'uint8' },
    { name: 'displayName', type: 'string' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const

const domain = (contract: Address) => ({ name: 'MeshPortNames', version: '1', chainId: CHAIN_ID, verifyingContract: contract })

type UserRow = {
  id: string; username: string | null; wallet_address: string | null; account_type: string; store_name: string | null
  name_onchain_status: string; name_onchain_tx: string | null; name_onchain_request: Record<string, unknown> | null
}

async function userByWallet(wallet: string): Promise<UserRow | null> {
  const { data } = await db.from('users')
    .select('id, username, wallet_address, account_type, store_name, name_onchain_status, name_onchain_tx, name_onchain_request')
    .ilike('wallet_address', wallet).limit(1).maybeSingle()
  return (data as UserRow) ?? null
}

async function setStatus(id: string, patch: Record<string, unknown>) {
  await db.from('users').update(patch).eq('id', id)
}

/** Expected on-chain kind/verified for a user, from users + merchant_applications. */
async function expectedBusiness(u: UserRow): Promise<{ kind: number; verified: boolean }> {
  const { data } = await db.from('merchant_applications').select('status')
    .ilike('wallet_address', u.wallet_address ?? '').order('created_at', { ascending: false }).limit(1).maybeSingle()
  const approved = data?.status === 'approved'
  return { kind: approved || u.account_type === 'business' ? KIND.business : KIND.personal, verified: approved }
}

/** Sends `register` for a stored, signed request. Returns the new status. */
async function sendRegister(contract: Address, u: UserRow): Promise<{ status: string; txHash?: string; error?: string }> {
  const r = u.name_onchain_request as { name: string; kind: number; displayName: string; deadline: string; signature: Hex } | null
  const wallet = getAddress(u.wallet_address!)
  if (!r) return { status: 'none' }

  const owner = await pub.readContract({ address: contract, abi: ABI, functionName: 'resolve', args: [r.name] }) as Address
  if (owner.toLowerCase() === wallet.toLowerCase()) {
    await setStatus(u.id, { name_onchain_status: 'registered', name_onchain_at: new Date().toISOString(), name_onchain_error: null })
    return { status: 'registered' }
  }
  if (owner !== '0x0000000000000000000000000000000000000000') {
    await setStatus(u.id, { name_onchain_status: 'failed', name_onchain_error: 'Name is held by another wallet on-chain' })
    return { status: 'failed', error: 'taken' }
  }
  if (BigInt(r.deadline) < BigInt(Math.floor(Date.now() / 1000))) {
    await setStatus(u.id, { name_onchain_status: 'failed', name_onchain_error: 'Signature expired - the app asks the user to sign again' })
    return { status: 'failed', error: 'expired' }
  }

  try {
    const account = await registrar()
    const wc = createWalletClient({ account, chain: arc, transport: http(RPC) })
    const { request } = await pub.simulateContract({
      account, address: contract, abi: ABI, functionName: 'register',
      args: [r.name, wallet, r.kind, r.displayName, BigInt(r.deadline), r.signature],
    })
    const hash = await wc.writeContract(request)
    await setStatus(u.id, { name_onchain_status: 'pending', name_onchain_tx: hash, name_onchain_error: null })
    try {
      const rec = await pub.waitForTransactionReceipt({ hash, timeout: RECEIPT_WAIT_MS })
      if (rec.status === 'success') {
        await setStatus(u.id, { name_onchain_status: 'registered', name_onchain_at: new Date().toISOString() })
        return { status: 'registered', txHash: hash }
      }
      await setStatus(u.id, { name_onchain_status: 'failed', name_onchain_error: 'Transaction reverted' })
      return { status: 'failed', txHash: hash, error: 'reverted' }
    } catch {
      return { status: 'pending', txHash: hash } // the sync job finishes it
    }
  } catch (e) {
    const msg = (e as { shortMessage?: string })?.shortMessage ?? (e instanceof Error ? e.message : String(e))
    await setStatus(u.id, { name_onchain_status: 'failed', name_onchain_error: msg.slice(0, 300) })
    return { status: 'failed', error: msg.slice(0, 120) }
  }
}

/** Brings a registered name's Business kind / verified flag in line with the DB. */
async function reconcileBusiness(contract: Address, u: UserRow): Promise<string> {
  if (!u.username) return 'no-name'
  const rec = await pub.readContract({ address: contract, abi: ABI, functionName: 'recordOf', args: [u.username] }) as
    { owner: Address; kind: number; verified: boolean }
  if (!rec || rec.owner.toLowerCase() !== (u.wallet_address ?? '').toLowerCase()) return 'not-registered'
  const want = await expectedBusiness(u)
  if (Number(rec.kind) === want.kind && rec.verified === want.verified) return 'in-sync'
  const account = await registrar()
  const wc = createWalletClient({ account, chain: arc, transport: http(RPC) })
  const { request } = await pub.simulateContract({
    account, address: contract, abi: ABI, functionName: 'setBusiness', args: [u.username, want.kind, want.verified],
  })
  const hash = await wc.writeContract(request)
  await pub.waitForTransactionReceipt({ hash, timeout: RECEIPT_WAIT_MS }).catch(() => null)
  return 'updated'
}

Deno.serve(async (req) => {
  const pre = handleOptions(req); if (pre) return pre
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405)
  let body: Record<string, unknown>
  try { body = await req.json() } catch { return json({ error: 'Bad JSON' }, 400) }
  const action = String(body.action ?? '')
  const contract = contractAddress()

  try {
    if (action === 'info') {
      const r = await registrar()
      return json({ contract, chainId: CHAIN_ID, registrar: r.address })
    }

    if (!contract) return json({ error: 'Name registry not deployed yet' }, 503)

    if (action === 'nonce') {
      const wallet = String(body.wallet ?? '')
      if (!isAddress(wallet)) return json({ error: 'Bad wallet' }, 400)
      const nonce = await pub.readContract({ address: contract, abi: ABI, functionName: 'nonces', args: [getAddress(wallet)] }) as bigint
      return json({ nonce: nonce.toString(), contract, chainId: CHAIN_ID })
    }

    if (action === 'status') {
      const wallet = String(body.wallet ?? '')
      if (!isAddress(wallet)) return json({ error: 'Bad wallet' }, 400)
      const u = await userByWallet(wallet)
      if (!u) return json({ status: 'none' })
      if (u.name_onchain_status === 'pending' && u.name_onchain_tx) {
        const rec = await pub.getTransactionReceipt({ hash: u.name_onchain_tx as Hex }).catch(() => null)
        if (rec?.status === 'success') {
          await setStatus(u.id, { name_onchain_status: 'registered', name_onchain_at: new Date().toISOString() })
          return json({ status: 'registered', txHash: u.name_onchain_tx })
        }
      }
      return json({ status: u.name_onchain_status, txHash: u.name_onchain_tx ?? undefined })
    }

    if (action === 'register') {
      const wallet = String(body.wallet ?? '')
      const name = String(body.name ?? '')
      const kindName = String(body.kind ?? 'personal') as KindName
      const displayName = String(body.displayName ?? '').trim()
      const deadline = String(body.deadline ?? '')
      const signature = String(body.signature ?? '') as Hex
      if (!isAddress(wallet)) return json({ error: 'Bad wallet' }, 400)
      if (!NAME_RE.test(name)) return json({ error: 'Use 3–20 letters a–z, numbers or _' }, 400)
      if (!(kindName in KIND)) return json({ error: 'Bad kind' }, 400)
      // A business account IS its username (stores are created after
      // approval), so no store name is needed: like a personal name it may be
      // registered with an empty display name - the contract accepts that, and
      // the signature covers exactly what the user signed, so the server can't
      // substitute one. A name that IS given must still be 2–64 characters.
      if (kindName === 'business' && displayName && displayName.length < 2) return json({ error: 'Enter your store name (2–64 characters)' }, 400)
      if (new TextEncoder().encode(displayName).length > 64) return json({ error: 'Store name is too long' }, 400)
      const now = Math.floor(Date.now() / 1000)
      if (!/^\d+$/.test(deadline) || Number(deadline) < now || Number(deadline) > now + MAX_DEADLINE_SEC) return json({ error: 'Bad deadline' }, 400)

      // Proof the wallet owner asked for exactly this.
      const addr = getAddress(wallet)
      const nonce = await pub.readContract({ address: contract, abi: ABI, functionName: 'nonces', args: [addr] }) as bigint
      const ok = await verifyTypedData({
        address: addr, domain: domain(contract), types, primaryType: 'Register',
        message: { name, account: addr, kind: KIND[kindName], displayName, nonce, deadline: BigInt(deadline) },
        signature,
      }).catch(() => false)
      if (!ok) return json({ error: 'Signature does not match this wallet' }, 401)

      // The name must already be this wallet's username in MeshPort.
      const u = await userByWallet(addr)
      if (!u || (u.username ?? '').toLowerCase() !== name) return json({ error: 'Claim the username in MeshPort first' }, 409)
      if (u.name_onchain_status === 'registered') return json({ status: 'registered', txHash: u.name_onchain_tx ?? undefined })
      // Business is chosen at sign-up (users.account_type, set by
      // start_business_account) - a signature alone can't make one.
      if (kindName === 'business' && u.account_type !== 'business') return json({ error: 'Business accounts are chosen at sign-up' }, 403)
      // ...and the type is fixed: a business account is never registered as Personal.
      if (kindName === 'personal' && u.account_type === 'business') return json({ error: 'This is a business account' }, 403)

      await setStatus(u.id, {
        store_name: kindName === 'business' && displayName ? displayName : u.store_name,
        name_onchain_status: 'pending',
        name_onchain_error: null,
        name_onchain_request: { name, kind: KIND[kindName], displayName, deadline, signature },
      })
      const fresh = await userByWallet(addr)
      return json(await sendRegister(contract, fresh!))
    }

    // ── Service-only actions ──────────────────────────────────────────────
    if (!isCronOrLegacyServiceCaller(req)) return json({ error: 'Forbidden' }, 403)

    if (action === 'business-sync') {
      const wallet = String(body.wallet ?? '')
      if (!isAddress(wallet)) return json({ error: 'Bad wallet' }, 400)
      const u = await userByWallet(wallet)
      if (!u) return json({ result: 'no-user' })
      return json({ result: await reconcileBusiness(contract, u) })
    }

    if (action === 'sync') {
      const { data } = await db.from('users')
        .select('id, username, wallet_address, account_type, store_name, name_onchain_status, name_onchain_tx, name_onchain_request')
        .in('name_onchain_status', ['pending', 'failed']).not('name_onchain_request', 'is', null).limit(25)
      const out: Record<string, string> = {}
      for (const u of (data ?? []) as UserRow[]) {
        if (u.name_onchain_status === 'pending' && u.name_onchain_tx) {
          const rec = await pub.getTransactionReceipt({ hash: u.name_onchain_tx as Hex }).catch(() => null)
          if (rec?.status === 'success') { await setStatus(u.id, { name_onchain_status: 'registered', name_onchain_at: new Date().toISOString() }); out[u.username ?? u.id] = 'registered'; continue }
          if (!rec) { out[u.username ?? u.id] = 'waiting'; continue }
        }
        out[u.username ?? u.id] = (await sendRegister(contract, u)).status
      }
      // Business flags for registered merchants.
      const { data: biz } = await db.from('users')
        .select('id, username, wallet_address, account_type, store_name, name_onchain_status, name_onchain_tx, name_onchain_request')
        .eq('name_onchain_status', 'registered').eq('account_type', 'business').limit(50)
      for (const u of (biz ?? []) as UserRow[]) out['biz:' + u.username] = await reconcileBusiness(contract, u).catch(() => 'error')
      return json({ result: out })
    }

    if (action === 'migrate-existing') {
      const open = await pub.readContract({ address: contract, abi: ABI, functionName: 'migrationOpen' }) as boolean
      if (!open) return json({ error: 'Migration already closed' }, 409)
      const { data } = await db.from('users')
        .select('id, username, wallet_address, account_type, store_name, name_onchain_status, name_onchain_tx, name_onchain_request')
        .not('username', 'is', null).not('wallet_address', 'is', null).neq('name_onchain_status', 'registered')
      const rows: UserRow[] = []
      for (const u of (data ?? []) as UserRow[]) {
        const n = (u.username ?? '').toLowerCase()
        if (!NAME_RE.test(n) || !isAddress(u.wallet_address ?? '')) continue
        const owner = await pub.readContract({ address: contract, abi: ABI, functionName: 'resolve', args: [n] }) as Address
        const mine = await pub.readContract({ address: contract, abi: ABI, functionName: 'nameOf', args: [getAddress(u.wallet_address!)] }) as string
        if (owner !== '0x0000000000000000000000000000000000000000' || mine) continue
        rows.push({ ...u, username: n })
      }
      const account = await registrar()
      const wc = createWalletClient({ account, chain: arc, transport: http(RPC) })
      let hash: Hex | null = null
      if (rows.length) {
        const kinds: number[] = [], verified: boolean[] = [], names: string[] = [], accounts: Address[] = [], displays: string[] = []
        for (const u of rows) {
          const b = await expectedBusiness(u)
          names.push(u.username!); accounts.push(getAddress(u.wallet_address!)); kinds.push(b.kind); verified.push(b.verified)
          const { data: app } = await db.from('merchant_applications').select('business_name').ilike('wallet_address', u.wallet_address!).order('created_at', { ascending: false }).limit(1).maybeSingle()
          displays.push(String(u.store_name ?? app?.business_name ?? '').slice(0, 64))
        }
        const { request } = await pub.simulateContract({ account, address: contract, abi: ABI, functionName: 'migrate', args: [names, accounts, kinds, displays, verified] })
        hash = await wc.writeContract(request)
        const rec = await pub.waitForTransactionReceipt({ hash, timeout: 60_000 })
        if (rec.status !== 'success') return json({ error: 'Migration reverted', txHash: hash }, 500)
        const at = new Date().toISOString()
        for (const u of rows) {
          const b = await expectedBusiness(u)
          await setStatus(u.id, { name_onchain_status: 'registered', name_onchain_tx: hash, name_onchain_at: at, name_onchain_error: null, ...(b.verified ? { account_type: 'business' } : {}) })
        }
      }
      // Existing users are in - from now on every name needs its owner's signature.
      const { request: close } = await pub.simulateContract({ account, address: contract, abi: ABI, functionName: 'closeMigration' })
      const closeHash = await wc.writeContract(close)
      await pub.waitForTransactionReceipt({ hash: closeHash, timeout: 60_000 })
      // Hand the contract to MeshPort's admin wallet (Ownable2Step: it only
      // becomes owner once that wallet calls acceptOwnership()). The
      // registrar keeps only its registrar role.
      let handoverTx: Hex | null = null
      const admin = (Deno.env.get('NAMES_ADMIN_ADDRESS') ?? '').trim() || DEFAULT_ADMIN
      if (isAddress(admin)) {
        const { request: handover } = await pub.simulateContract({ account, address: contract, abi: ABI, functionName: 'transferOwnership', args: [getAddress(admin)] })
        handoverTx = await wc.writeContract(handover)
        await pub.waitForTransactionReceipt({ hash: handoverTx, timeout: 60_000 }).catch(() => null)
      }
      return json({ migrated: rows.map(r => r.username), txHash: hash, closeTx: closeHash, handoverTx, pendingOwner: isAddress(admin) ? getAddress(admin) : null })
    }

    return json({ error: 'Unknown action' }, 400)
  } catch (e) {
    console.error('[name-register]', action, e instanceof Error ? e.message : e)
    return json({ error: 'Name registry is unavailable right now' }, 502)
  }
})

