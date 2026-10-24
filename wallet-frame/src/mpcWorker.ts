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
import { keygenStep } from '@/wallet/mpc/protocol'
import type { KeygenOffload } from '@/wallet/mpc/phone'
import { createMpcEngine, type MpcEngine } from './mpcEngine'

let mpc: Promise<Mpc> | null = null
function getMpc(): Promise<Mpc> {
  if (!mpc) {
    mpc = loadMpc(Uint8Array.from(atob(wasmBase64), c => c.charCodeAt(0)))
    mpc.catch(() => { mpc = null })
  }
  return mpc
}

// The backup party's signup steps run in a helper worker - another CPU core
// (mpcHelper.ts). Where a worker can't start one, they run here instead.
let helper: Worker | null = null
let helperBroken = false
let helperSeq = 0
const helperPending = new Map<number, { resolve: (r: any) => void; reject: (e: Error) => void }>()

function keygenOffload(): KeygenOffload | undefined {
  if (helperBroken || typeof Worker === 'undefined') return undefined
  return (state, inbox) => {
    if (!helper) {
      try {
        helper = new Worker(new URL('./mpcHelper.ts', import.meta.url), { type: 'module' })
      } catch {
        helperBroken = true
        return getMpc().then(m => keygenStep(m, state, inbox))
      }
      helper.onmessage = (e: MessageEvent<{ id: number; result?: unknown; error?: string }>) => {
        const p = helperPending.get(e.data.id)
        if (!p) return
        helperPending.delete(e.data.id)
        if (e.data.error !== undefined) p.reject(new Error(e.data.error)); else p.resolve(e.data.result)
      }
      helper.onerror = () => {
        helperBroken = true
        for (const p of helperPending.values()) p.reject(new Error('The wallet helper stopped - try again'))
        helperPending.clear()
        helper?.terminate()
        helper = null
      }
    }
    const id = ++helperSeq
    return new Promise((resolve, reject) => {
      helperPending.set(id, { resolve, reject })
      helper!.postMessage({ id, state, inbox })
    })
  }
}

const engine = createMpcEngine({
  mpc: getMpc,
  identityPub: import.meta.env.VITE_WALLET_MPC_SERVER_KEY as `0x${string}` | undefined,
  keygenOffload,
})
const METHODS = new Set<keyof MpcEngine>(['keygenBegin', 'keygenNext', 'keygenFinish', 'signBegin', 'signNext', 'benchmark', 'warm'])

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
