// multichain-reward (18 Nov 2026): a multichain transfer that left Arc earns
// a scratch card and moves the multichain offer - but only once the server
// has checked the transfer ON-CHAIN. The app's own multichain records can be
// written by the app, so they're never trusted for rewards.
//
// POST { txHash }  (the transfer's Arc-side transaction: the CCTP burn, or
// the Gateway deposit). Checked on Arc:
//   • it succeeded and was sent by the signed-in person's wallet,
//   • it is recent (the last 6 hours),
//   • it is a real cross-chain transfer: a CCTP MessageSent from Circle's
//     MessageTransmitterV2, or a deposit into Circle's Gateway wallet,
//   • the amount = the USDC / EURC that left the wallet in it.
// Then it is recorded once (verified_transfers, unique tx hash); a trigger
// there grants the card and the offer step within the daily limits.
import { createClient } from 'jsr:@supabase/supabase-js@2'
import { handleOptions, json } from '../_shared/cors.ts'
import { getServiceRoleKey } from '../_shared/serviceKey.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_KEY = getServiceRoleKey('multichain-reward')
const ARC_RPC = (Deno.env.get('ARC_RPC_URL') ?? 'https://rpc.testnet.arc.io').trim()

const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const MESSAGE_SENT = '0x8c5261668696ce22758910d05bab8f186d6eb247ceac2af2e82c7dc17669b036'
const MESSAGE_TRANSMITTER_V2 = '0xe737e5cebeeba77efe34d4aa090756590b1ce275'
const GATEWAY_WALLET = '0x0077777d7eba4688bdef3e311b846f25870a19b9'
// Tokens a transfer can move (6 decimals on their ERC-20 interface).
const TOKENS = new Set([
  '0x3600000000000000000000000000000000000000', // USDC
  '0x89b50855aa3be2f677cd6303cec089b5f319d72a', // EURC
])
const MAX_AGE_S = 6 * 3600

async function rpc(method: string, params: unknown[]) {
  const r = await fetch(ARC_RPC, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(8000),
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const j = await r.json()
  if (j?.error) throw new Error(j.error.message ?? 'rpc error')
  return j?.result
}
const topicAddr = (t: string | undefined) => (t ? ('0x' + t.slice(-40)).toLowerCase() : '')

Deno.serve(async (req) => {
  const pre = handleOptions(req)
  if (pre) return pre
  if (req.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405)
  let body: any
  try { body = await req.json() } catch { return json({ ok: false, error: 'Invalid JSON body' }, 400) }
  const txHash = String(body?.txHash ?? '').trim().toLowerCase()
  if (!/^0x[0-9a-f]{64}$/.test(txHash)) return json({ ok: false, error: 'txHash must be a transaction hash' }, 400)

  const supabase = createClient(SUPABASE_URL, SERVICE_KEY)
  const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '')
  const { data: authData } = jwt ? await supabase.auth.getUser(jwt) : { data: { user: null } }
  const uid = authData?.user?.id
  if (!uid) return json({ ok: false, error: 'Please sign in again' }, 401)
  const { data: me } = await supabase.from('users').select('id, wallet_address, account_type').eq('auth_uid', uid).maybeSingle()
  if (!me?.id || !me.wallet_address) return json({ ok: false, error: 'Account not linked to this session' }, 403)
  if ((me.account_type ?? 'personal') === 'business') return json({ ok: true, counted: false, reason: 'business' })
  const wallet = String(me.wallet_address).toLowerCase()

  // Already recorded: nothing more to do.
  const { data: seen } = await supabase.from('verified_transfers').select('id').eq('tx_hash', txHash).maybeSingle()
  if (seen) return json({ ok: true, counted: false, reason: 'already' })

  let receipt: any
  try { receipt = await rpc('eth_getTransactionReceipt', [txHash]) } catch { return json({ ok: false, error: 'Arc could not be reached - try again' }, 503) }
  if (!receipt) return json({ ok: false, error: 'Not confirmed yet' }, 409)
  if (receipt.status !== '0x1') return json({ ok: true, counted: false, reason: 'failed' })
  if (String(receipt.from ?? '').toLowerCase() !== wallet) return json({ ok: false, error: 'Not your transaction' }, 403)

  let block: any
  try { block = await rpc('eth_getBlockByNumber', [receipt.blockNumber, false]) } catch { return json({ ok: false, error: 'Arc could not be reached - try again' }, 503) }
  const age = Math.floor(Date.now() / 1000) - Number(BigInt(block?.timestamp ?? '0x0'))
  if (age > MAX_AGE_S) return json({ ok: true, counted: false, reason: 'too_old' })

  const logs: any[] = receipt.logs ?? []
  const cctp = logs.some(l => String(l.address).toLowerCase() === MESSAGE_TRANSMITTER_V2 && String(l.topics?.[0]).toLowerCase() === MESSAGE_SENT)
  let toGateway = false
  let micro = 0n
  for (const l of logs) {
    const addr = String(l.address).toLowerCase()
    if (!TOKENS.has(addr) || String(l.topics?.[0]).toLowerCase() !== TRANSFER) continue
    if (topicAddr(l.topics?.[1]) !== wallet) continue
    micro += BigInt(l.data && l.data !== '0x' ? l.data : '0x0')
    if (topicAddr(l.topics?.[2]) === GATEWAY_WALLET) toGateway = true
  }
  if (!cctp && !toGateway) return json({ ok: true, counted: false, reason: 'not_a_transfer' })
  const usd = Number(micro) / 1e6
  if (usd <= 0) return json({ ok: true, counted: false, reason: 'no_amount' })

  const { error } = await supabase.from('verified_transfers').insert({
    tx_hash: txHash, user_id: String(me.id), wallet, amount_usd: usd, kind: 'multichain',
  })
  if (error && !/duplicate|unique/i.test(error.message)) {
    console.error('[multichain-reward] insert failed:', error.message)
    return json({ ok: false, error: 'Could not record the transfer - try again' }, 500)
  }
  return json({ ok: true, counted: !error, usd })
})
