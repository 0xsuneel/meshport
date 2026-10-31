// lib/moveTimings.ts
//
// How long each step of one Transfer, Bring or Swap took on this device -
// passcode, wallet open, quote, signature, send, attestation, mint / arrival -
// saved once per move to Supabase (move_timings), so a slow move shows which
// step was slow instead of only its total. Never blocks or fails a move: every
// write is fire-and-forget, and a missing table / offline device just drops it.
//
//   const t = startMoveTimer('transfer', { route: 'cctp', chain: 'Ethereum_Sepolia', token: 'USDC' })
//   t.mark('passcode') ... t.mark('burn') ...
//   t.finish({ ok: true, txHash })
//
// steps: { name: ms since start }, in the order reached; a step reached twice
// keeps its first time.

export type MoveKind = 'transfer' | 'bring' | 'swap'

export interface MoveTimer {
  /** Time `step` (ms since start) the first time it's reached. */
  mark(step: string): void
  /** Save it (once). Later calls do nothing. */
  finish(p: { ok: boolean; error?: string; txHash?: string }): void
  readonly finished: boolean
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())

/** Pure: the row a finished timer saves (tested on its own). */
export function timingRow(p: {
  kind: MoveKind; wallet: string; route?: string; chain?: string; token?: string
  steps: Record<string, number>; totalMs: number; ok: boolean; error?: string; txHash?: string; version?: string
}) {
  return {
    wallet_address: p.wallet.toLowerCase(),
    kind: p.kind,
    route: p.route ?? null,
    chain: p.chain ?? null,
    token: p.token ?? 'USDC',
    tx_hash: p.txHash ?? null,
    ok: p.ok,
    error: p.error ? p.error.slice(0, 200) : null,
    total_ms: Math.round(p.totalMs),
    steps: Object.fromEntries(Object.entries(p.steps).map(([k, v]) => [k, Math.round(v)])),
    app_version: p.version ?? null,
  }
}

export function startMoveTimer(kind: MoveKind, info: { route?: string; chain?: string; token?: string } = {}): MoveTimer {
  const t0 = now()
  const steps: Record<string, number> = {}
  let done = false
  return {
    get finished() { return done },
    mark(step) {
      if (done || step in steps) return
      steps[step] = now() - t0
    },
    finish({ ok, error, txHash }) {
      if (done) return
      done = true
      const totalMs = now() - t0
      void (async () => {
        try {
          const [{ useAuthStore }, { supabase }] = await Promise.all([import('@/store'), import('./supabase')])
          const wallet = useAuthStore.getState().walletAddress
          if (!wallet) return
          const version = (import.meta.env.VITE_APP_VERSION as string | undefined) || undefined
          await supabase.from('move_timings').insert(timingRow({ kind, wallet, ...info, steps, totalMs, ok, error, txHash, version }))
        } catch { /* timings are best-effort */ }
      })()
    },
  }
}
