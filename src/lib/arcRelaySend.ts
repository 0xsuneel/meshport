// lib/arcRelaySend.ts
//
// Circle's SDK flows (Transfer, Swap, Bring) send their Arc transactions the
// way Pay does. The SDK still builds, simulates and signs everything itself;
// only the broadcast changes: instead of eth_sendRawTransaction followed by
// the phone polling for the receipt, the signed bytes go once to
// meshport_sendRawTransactionAndWait (api/arc-rpc): the server broadcasts to
// every Arc node and waits for the receipt on its fast connection, so the
// SDK's own receipt check then finds it on the first call.
//
// Same rules as Pay (arcService.relaySend): a transaction every node that
// answered rejected comes back as that rejection (nothing was sent);
// anything unclear - an older server, a lost answer, "no node answered" -
// falls back to the plain send, and re-sending the identical signed bytes is
// harmless ("already known").

import { keccak256, type Hex } from 'viem'
import { arcRpcJson } from './arc'

const RELAY_METHOD = 'meshport_sendRawTransactionAndWait'
const RELAY_REJECTED = -32003
const RELAY_WAIT_MS = 8000

type RpcRequest = { id?: unknown; method?: string; params?: unknown[] }
type RpcResponse = { jsonrpc: '2.0'; id: unknown; result?: unknown; error?: { code: number; message: string } }

/**
 * One eth_sendRawTransaction through the relay. Returns its JSON-RPC answer
 * (the hash, or a rejection), or null when the caller should send it directly.
 */
export async function relayRawSend(req: RpcRequest): Promise<RpcResponse | null> {
  const raw = req.params?.[0]
  if (typeof raw !== 'string' || !/^0x[0-9a-fA-F]+$/.test(raw)) return null
  const hash = keccak256(raw as Hex)
  try {
    const json = await arcRpcJson({ jsonrpc: '2.0', id: 1, method: RELAY_METHOD, params: [raw, hash, RELAY_WAIT_MS] }, 20_000)
    const r = json?.result as { hash?: string; broadcast?: string } | undefined
    if (r?.hash && r.broadcast !== 'unknown') return { jsonrpc: '2.0', id: req.id, result: hash }
  } catch (e: any) {
    // Every node that answered refused it: nothing was sent - same answer a node gives.
    if (e && typeof e === 'object' && e.code === RELAY_REJECTED) {
      return { jsonrpc: '2.0', id: req.id, error: { code: -32000, message: String(e.message || 'Transaction rejected') } }
    }
  }
  return null
}

/**
 * An ethers JsonRpcProvider whose eth_sendRawTransaction goes through the
 * relay; every other call is unchanged. Returns the same provider.
 */
export function sendThroughRelay<P extends { _send: (payload: any) => Promise<any[]> }>(provider: P): P {
  const direct = provider._send.bind(provider)
  provider._send = async (payload: any) => {
    const list: RpcRequest[] = Array.isArray(payload) ? payload : [payload]
    if (!list.some(p => p?.method === 'eth_sendRawTransaction')) return direct(payload)
    const out: unknown[] = []
    for (const p of list) {
      const relayed = p?.method === 'eth_sendRawTransaction' ? await relayRawSend(p) : null
      out.push(relayed ?? (await direct(p))[0])
    }
    return out as any[]
  }
  return provider
}
