// lib/walletEvents.ts
//
// What the wallet itself did on this device, saved to Supabase (wallet_events)
// the same way move_timings saves a Transfer / Bring / Swap: one row per
// event, queryable by wallet, kind and time.
//
//   wallet_kind  frame   created / imported private key (signs on the device)
//
//   event        startup        page load → wallet can sign (steps: shell, auth, provider, discovered, signer, rpc, actionReady)
//                open           opening the wallet (unlock / restore): ms, ok, error
//                resume         back from the background → signing again
//                sign           one signature: detail = signTypedData / signTransaction / signMessage
//                confirm_open   the passcode sheet's wallet page: ms to load / ready / size / live / usable, moves
//                nonce          a transaction number from Circle's SDK that the chain could not run, corrected before signing (wallet/account usableNonce)
//                frame          the wallet frame was recovered: detail = reopened / reloaded and why
//
// Never blocks or fails anything: fire-and-forget, dropped when offline or
// signed out. Only timings and outcomes - never keys, signatures, messages,
// amounts or passcodes.

export type WalletEvent =
  | 'startup' | 'open' | 'resume' | 'sign' | 'confirm_open' | 'nonce' | 'frame'

export interface WalletEventInput {
  event: WalletEvent
  ok: boolean
  ms?: number
  steps?: Record<string, number>
  error?: string
  detail?: string
  /** Defaults to the signed-in wallet's source (walletSource). */
  kind?: string
}

/** Pure: the row one event saves (tested on its own). */
export function walletEventRow(p: WalletEventInput & {
  wallet: string; kind: string; path?: string; version?: string; online?: boolean; network?: string; visible?: boolean
}) {
  return {
    wallet_address: p.wallet.toLowerCase(),
    wallet_kind: p.kind || 'unknown',
    event: p.event,
    ok: p.ok,
    ms: p.ms == null ? null : Math.round(p.ms),
    steps: p.steps ? Object.fromEntries(Object.entries(p.steps).filter(([, v]) => Number.isFinite(v)).map(([k, v]) => [k, Math.round(v)])) : null,
    error: p.error ? p.error.slice(0, 300) : null,
    detail: p.detail ? p.detail.slice(0, 200) : null,
    path: p.path ?? null,
    online: p.online ?? null,
    network: p.network ?? null,
    visible: p.visible ?? null,
    app_version: p.version ?? null,
  }
}

const kindOf = (source: string | null | undefined) =>
  source ? 'frame' : 'unknown'

export function logWalletEvent(e: WalletEventInput): void {
  void (async () => {
    try {
      const [{ useAuthStore }, { supabase }] = await Promise.all([import('@/store'), import('./supabase')])
      const { walletAddress, walletSource } = useAuthStore.getState()
      if (!walletAddress) return
      const version = (typeof __MP_BUILD__ === 'string' && __MP_BUILD__) || (import.meta.env.VITE_APP_VERSION as string | undefined) || undefined
      const nav = typeof navigator !== 'undefined' ? navigator as Navigator & { connection?: { effectiveType?: string } } : undefined
      await supabase.from('wallet_events').insert(walletEventRow({
        ...e,
        wallet: walletAddress,
        kind: e.kind ?? kindOf(walletSource),
        path: typeof location !== 'undefined' ? location.pathname : undefined,
        version,
        online: nav ? nav.onLine !== false : undefined,
        network: nav?.connection?.effectiveType,
        visible: typeof document !== 'undefined' ? document.visibilityState === 'visible' : undefined,
      }))
    } catch { /* wallet events are best-effort */ }
  })()
}
