// src/wallet/mpc/wasm.ts
//
// Loads the MPC WebAssembly module (mpc/, DKLs23 2-of-3 threshold ECDSA) and
// calls it. Runs unchanged in the wallet frame (browser) and the signing
// service (Deno): the module needs only five WASI imports, provided here -
// randomness from crypto.getRandomValues, an empty environment, and stdout /
// stderr for Rust panic messages. No network, no filesystem.
//
// Every operation is JSON in / JSON out; see mpc/src/lib.rs for each one.

export type MpcOp = 'dkg1' | 'dkg2' | 'dkg3' | 'dkg4' | 'sign1' | 'sign2' | 'sign3' | 'sign4' | 'share_info'

export class MpcError extends Error {}

export interface Mpc {
  call<T = unknown>(op: MpcOp, input: unknown): T
}

interface Exports {
  memory: WebAssembly.Memory
  mpc_alloc(len: number): number
  mpc_free(ptr: number, len: number): void
  mpc_call(opPtr: number, opLen: number, inPtr: number, inLen: number): bigint
}

const ERRNO_SUCCESS = 0
const enc = new TextEncoder()
const dec = new TextDecoder()

/** Instantiate the module from its bytes (the caller decides how to get them). */
export async function loadMpc(bytes: BufferSource): Promise<Mpc> {
  let exp: Exports | null = null
  const mem = () => new DataView(exp!.memory.buffer)
  const wasi = {
    random_get(ptr: number, len: number) {
      const out = new Uint8Array(exp!.memory.buffer, ptr, len)
      // getRandomValues fills at most 65536 bytes per call.
      for (let o = 0; o < len; o += 65536) crypto.getRandomValues(out.subarray(o, Math.min(len, o + 65536)))
      return ERRNO_SUCCESS
    },
    environ_sizes_get(countPtr: number, sizePtr: number) {
      mem().setUint32(countPtr, 0, true)
      mem().setUint32(sizePtr, 0, true)
      return ERRNO_SUCCESS
    },
    environ_get() { return ERRNO_SUCCESS },
    fd_write(fd: number, iovs: number, iovsLen: number, nwrittenPtr: number) {
      let text = '', total = 0
      for (let k = 0; k < iovsLen; k++) {
        const p = mem().getUint32(iovs + k * 8, true)
        const l = mem().getUint32(iovs + k * 8 + 4, true)
        text += dec.decode(new Uint8Array(exp!.memory.buffer, p, l))
        total += l
      }
      if (fd === 2 && text.trim()) console.error('[mpc]', text.trim())
      mem().setUint32(nwrittenPtr, total, true)
      return ERRNO_SUCCESS
    },
    proc_exit(code: number) { throw new MpcError(`MPC module exited (${code})`) },
  }
  const { instance } = await WebAssembly.instantiate(bytes, { wasi_snapshot_preview1: wasi }) as unknown as WebAssembly.WebAssemblyInstantiatedSource
  exp = instance.exports as unknown as Exports

  const put = (s: string): [number, number] => {
    const b = enc.encode(s)
    const p = exp!.mpc_alloc(b.length)
    new Uint8Array(exp!.memory.buffer, p, b.length).set(b)
    return [p, b.length]
  }

  return {
    call<T>(op: MpcOp, input: unknown): T {
      const [opP, opL] = put(op)
      const [inP, inL] = put(JSON.stringify(input))
      let packed: bigint
      try {
        packed = exp!.mpc_call(opP, opL, inP, inL)
      } finally {
        exp!.mpc_free(opP, opL)
        exp!.mpc_free(inP, inL)  // zeroed before release (it may hold a key share)
      }
      const outP = Number(packed >> 32n), outL = Number(packed & 0xffffffffn)
      const text = dec.decode(new Uint8Array(exp!.memory.buffer, outP, outL))
      exp!.mpc_free(outP, outL)
      const reply = JSON.parse(text) as { ok?: T; error?: string }
      if (reply.error !== undefined) throw new MpcError(reply.error)
      return reply.ok as T
    },
  }
}
