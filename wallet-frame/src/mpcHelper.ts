// wallet-frame/src/mpcHelper.ts
//
// A second core for signup: the MPC worker (mpcWorker.ts) starts this helper
// and sends it the backup party's key-generation steps, so they run while the
// phone party's run in the MPC worker itself (src/wallet/mpc/phone.ts,
// KeygenOffload). Stateless: state and messages in, one step's result out.
// Same origin and same module as the MPC worker; it holds nothing between calls.

import wasmBase64 from 'virtual:meshport-mpc-wasm'
import { loadMpc, type Mpc } from '@/wallet/mpc/wasm'
import { keygenStep, type KeygenState, type MpcMsg } from '@/wallet/mpc/protocol'

let mpc: Promise<Mpc> | null = null

self.onmessage = async (e: MessageEvent<{ id: number; state: KeygenState; inbox: MpcMsg[] }>) => {
  const { id, state, inbox } = e.data
  try {
    mpc ??= loadMpc(Uint8Array.from(atob(wasmBase64), c => c.charCodeAt(0)))
    self.postMessage({ id, result: keygenStep(await mpc, state, inbox) })
  } catch (err) {
    mpc = null
    self.postMessage({ id, error: err instanceof Error ? err.message : 'MPC helper step failed' })
  }
}
