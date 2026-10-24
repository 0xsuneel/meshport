// wallet-frame/src/mpcWorker.ts
//
// Runs the frame's MPC engine (mpcEngine.ts) off the main thread: key
// generation is seconds of CPU on a phone. Same origin as the frame, created
// only by main.ts; it holds open sessions in memory and nothing else (shares
// are stored by main.ts, which passes the phone's share in for each signature).
//
// The module is bundled inline as base64 (vite.wallet.config.ts): the
// frame's CSP blocks fetching it.

import wasmBase64 from 'virtual:meshport-mpc-wasm'
import { loadMpc, type Mpc } from '@/wallet/mpc/wasm'
import { createMpcEngine, type MpcEngine } from './mpcEngine'

let mpc: Promise<Mpc> | null = null
function getMpc(): Promise<Mpc> {
  if (!mpc) {
    mpc = loadMpc(Uint8Array.from(atob(wasmBase64), c => c.charCodeAt(0)))
    mpc.catch(() => { mpc = null })
  }
  return mpc
}

const engine = createMpcEngine({ mpc: getMpc, identityPub: import.meta.env.VITE_WALLET_MPC_SERVER_KEY as `0x${string}` | undefined })
const METHODS = new Set<keyof MpcEngine>(['keygenBegin', 'keygenNext', 'keygenFinish', 'signBegin', 'signNext'])

self.onmessage = async (e: MessageEvent<{ id: number; method: keyof MpcEngine; args: unknown[] }>) => {
  const { id, method, args } = e.data ?? ({} as never)
  try {
    if (!METHODS.has(method)) throw new Error(`Unknown MPC request ${String(method)}`)
    const result = await (engine[method] as (...a: unknown[]) => Promise<unknown>)(...(args ?? []))
    self.postMessage({ id, result })
  } catch (err) {
    self.postMessage({ id, error: err instanceof Error ? err.message : 'MPC request failed' })
  }
}
