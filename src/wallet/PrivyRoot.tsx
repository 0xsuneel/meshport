// src/wallet/PrivyRoot.tsx
//
// Privy's React SDK, mounted only while a Google / email account is signed in
// (PrivyGate), so nobody else downloads it. It signs in to Privy with
// MeshPort's own Supabase session (custom auth: no second login) and hands
// src/wallet/privy.ts a bridge to create wallets and sign. Privy's own
// confirmation modals are off: the app's passcode / biometric is the approval.

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  PrivyProvider, usePrivy, useWallets, useCreateWallet, useSignTransaction, useSignMessage, useSignTypedData,
  useSubscribeToJwtAuthWithFlag,
} from '@privy-io/react-auth'
import {
  useWallets as useSolanaWallets, useCreateWallet as useCreateSolanaWallet, useSignTransaction as useSignSolanaTransaction,
} from '@privy-io/react-auth/solana'
import { createSolanaRpc, createSolanaRpcSubscriptions } from '@solana/kit'
import { defineChain, type Chain, type Hex } from 'viem'
import { SOLANA_RPC } from '@/lib/solana'
import { supabase } from '@/lib/supabase'
import { arcTestnet } from '@/lib/chain'
import { EXTERNAL_CHAINS } from '@/blockchain/chains'
import { useAuthStore } from '@/store'
import { privyAccount, privyAppId, recheckPrivySigners, setPrivyBridge, privyNeedsRebuild, PRIVY_NEEDED_EVENT, PRIVY_DEAD_EVENT } from './privy'
import { useSupabaseSession } from './PrivyGate'
import { whenPrivyQuiet, rebuildGapMs } from './privyActivity'
import { createJwtProvider, browserWait, browserWake, needsResync, resyncDelayMs, RESYNC_BEFORE_REBUILD } from './privyJwt'

// Privy silent this long, with the app's own requests answered meanwhile:
// its load is stuck, not slow (see PrivyBridgeSync).
const PRIVY_QUIET_MS = 8_000

// Privy signs only on chains it is told about: Arc plus every other chain in
// MeshPort's registry with a verified chain id (Multichain transfers and
// bridges sign there). Privy's own screens are off, so the native-currency
// label is never shown; the RPCs are the registry's.
// Arc's RPC as a full URL: the app's own list is the relative '/api/arc-rpc',
// which points nowhere outside MeshPort's pages.
const ARC_FOR_PRIVY: Chain = typeof window === 'undefined' ? arcTestnet : {
  ...arcTestnet,
  rpcUrls: { default: { http: [`${window.location.origin}/api/arc-rpc`] }, public: { http: [`${window.location.origin}/api/arc-rpc`] } },
}
const SUPPORTED_CHAINS: [Chain, ...Chain[]] = [
  ARC_FOR_PRIVY,
  ...Object.entries(EXTERNAL_CHAINS)
    .filter(([, c]) => c.chainId && c.chainId !== arcTestnet.id)
    .map(([key, c]) => defineChain({
      id: c.chainId!, name: key.replace(/_/g, ' '), testnet: true,
      nativeCurrency: { name: 'Native', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: c.rpcs } },
    })),
]

function PrivyBridgeSync({ onWalletStuck }: { onWalletStuck: (why: string) => void }) {
  const { session, loading } = useSupabaseSession()
  const signedIn = !!session && !session.anonymous
  // The token Privy signs in with. It never answers "no token" while the
  // MeshPort session exists but can't be refreshed right now (that answer
  // signs Privy out) - it waits for the connection instead - see privyJwt.ts.
  const [jwt] = useState(() => createJwtProvider({
    getSession: () => supabase.auth.getSession() as never,
    wait: browserWait, now: Date.now, onWake: browserWake,
  }))
  useEffect(() => { jwt.resume(); return () => jwt.abort() }, [jwt])
  // Privy re-reads the token when `isLoading` goes from true to false: a short
  // true is how a failed / signed-out sync is started again.
  const [kick, setKick] = useState(false)
  useEffect(() => {
    if (!kick) return
    const t = setTimeout(() => setKick(false), 50)
    return () => clearTimeout(t)
  }, [kick])
  const { state: syncState } = useSubscribeToJwtAuthWithFlag({
    isAuthenticated: signedIn,
    isLoading: loading || kick,
    getExternalJwt: () => jwt.get(),
  })

  const { ready, authenticated, user, getAccessToken } = usePrivy()
  const { wallets } = useWallets()
  const { createWallet } = useCreateWallet()
  const { signTransaction } = useSignTransaction()
  const { signMessage } = useSignMessage()
  const { signTypedData } = useSignTypedData()
  const embedded = wallets.filter(w => w.walletClientType === 'privy')
  const addresses = embedded.map(w => w.address).join(',')
  // The account HAS a Privy wallet (Privy's record) - whether or not Privy's
  // wallet iframe has connected it yet (until then `wallets` is empty and
  // signing waits until Privy aborts it).
  const linked = ((user?.linkedAccounts as Array<{ type?: string; chainType?: string; walletClientType?: string; address?: string }> | undefined) ?? [])
    .filter(a => a.type === 'wallet' && a.chainType === 'ethereum' && a.walletClientType === 'privy' && !!a.address)
    .map(a => a.address as string).join(',')
  const hasLinkedWallet = !!linked
  // Solana (docs/SOLANA.md): Privy's own embedded wallets only, not external ones.
  // Privy loads the Solana wallets after the Ethereum ones: until `solanaReady`
  // an empty list doesn't mean "none" (creating one then fails with "User
  // already has an embedded wallet"). The account's linked wallets say too.
  const { ready: solanaListReady, wallets: solanaWallets } = useSolanaWallets()
  const hasSolanaAccount = !!(user?.linkedAccounts as Array<{ type?: string; chainType?: string; walletClientType?: string }> | undefined)
    ?.some(a => a.type === 'wallet' && a.chainType === 'solana' && a.walletClientType === 'privy')
  const { createWallet: createSolanaWallet } = useCreateSolanaWallet()
  const { signTransaction: signSolanaTransaction } = useSignSolanaTransaction()
  const solanaEmbedded = solanaWallets.filter(w => (w.standardWallet as { isPrivyWallet?: boolean }).isPrivyWallet === true)
  const solanaAddresses = solanaEmbedded.map(w => w.address).join(',')

  // Privy signed out while MeshPort is signed in. Privy's sync gives up for
  // good after one failed attempt (a dropped request while signing in), and
  // skips the sync when it sees the same token again after Privy logged itself
  // out - so nothing brought it back until a reload ("Your wallet didn't
  // open", Try Again waiting on the same dead Privy). A failed sync is
  // started again (2, 5, 10 s); a Privy that is signed out with no error, or
  // still failing after RESYNC_BEFORE_REBUILD tries, is rebuilt (PrivyRoot).
  const status = syncState.status
  const statusRef = useRef(status)
  statusRef.current = status
  const resyncs = useRef(0)
  const [syncFailed, setSyncFailed] = useState(false)
  const needs = needsResync({ signedIn, ready, authenticated, status })
  const needsRef = useRef(needs)
  needsRef.current = needs
  const attemptResync = useCallback(() => {
    const n = resyncs.current
    if ((statusRef.current === 'error' || statusRef.current === 'initial') && n < RESYNC_BEFORE_REBUILD) { resyncs.current = n + 1; setKick(true) }
    else setSyncFailed(true)
  }, [])
  useEffect(() => {
    if (authenticated) { resyncs.current = 0; setSyncFailed(false); return }
    if (!needs) return
    const delay = status === 'error' ? resyncDelayMs(resyncs.current) : 3_000
    const t = setTimeout(attemptResync, delay)
    return () => clearTimeout(t)
  }, [authenticated, needs, status, attemptResync])
  useEffect(() => {
    if (syncState.status !== 'error') return
    const why = syncState.error instanceof Error ? syncState.error.message : String(syncState.error ?? 'unknown')
    void import('@/lib/errorReport').then(r => r.reportClientError('rejection', new Error(
      `[privy sync] sign-in with MeshPort failed (re-sync #${resyncs.current + 1}, online=${typeof navigator === 'undefined' || navigator.onLine}): ${why.slice(0, 200)}`,
    ))).catch(() => {})
  }, [syncState])
  // A payment / sign-in needs the wallet now, or the connection came back: no waiting out the delay.
  useEffect(() => {
    const now = () => { if (needsRef.current) attemptResync() }
    window.addEventListener(PRIVY_NEEDED_EVENT, now)
    window.addEventListener('online', now)
    return () => { window.removeEventListener(PRIVY_NEEDED_EVENT, now); window.removeEventListener('online', now) }
  }, [attemptResync])
  useEffect(() => {
    const quiet = { uiOptions: { showWalletUIs: false } }
    setPrivyBridge({
      ready, authenticated, syncFailed,
      wallets: addresses ? addresses.split(',') : [],
      linked: linked ? linked.split(',') : [],
      solanaWallets: solanaAddresses ? solanaAddresses.split(',') : [],
      solanaReady: solanaListReady,
      createSolanaWallet: async () => (await createSolanaWallet()).wallet.address,
      signSolanaTransaction: async (transaction, address) => {
        const w = solanaEmbedded.find(x => x.address === address)
        if (!w) throw new Error('Solana wallet not open')
        return (await signSolanaTransaction({ transaction, wallet: w, chain: 'solana:devnet', options: { uiOptions: { showWalletUIs: false } } })).signedTransaction
      },
      createWallet: async () => (await createWallet()).address,
      signTransaction: async (tx, address) => (await signTransaction(tx as never, { ...quiet, address })).signature as Hex,
      signMessage: async (message, address) => {
        if (typeof message === 'string') return (await signMessage({ message }, { ...quiet, address })).signature as Hex
        // Raw bytes: personal_sign over the hex, through the wallet's own provider.
        const w = embedded.find(x => x.address.toLowerCase() === address.toLowerCase())
        if (!w) throw new Error('Wallet not open')
        return (await (await w.getEthereumProvider()).request({ method: 'personal_sign', params: [message.raw, w.address] })) as Hex
      },
      signTypedData: async (typedData, address) => (await signTypedData(typedData as never, { ...quiet, address })).signature as Hex,
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, authenticated, syncFailed, addresses, linked, solanaAddresses, solanaListReady])
  // A Privy account gets its Solana wallet once its Arc wallet exists - new
  // and existing accounts alike, once per session at most - and only once
  // Privy has loaded its Solana wallets and the account has none.
  const solanaAsked = useRef(false)
  useEffect(() => {
    if (!ready || !authenticated || !addresses || !solanaListReady || solanaAddresses || hasSolanaAccount || solanaAsked.current) return
    if (useAuthStore.getState().walletSource !== 'privy') return
    solanaAsked.current = true
    createSolanaWallet().catch(e => {
      void import('@/lib/errorReport').then(r => r.reportClientError('rejection', new Error(`[privy solana wallet] ${e instanceof Error ? e.message : String(e)}`))).catch(() => {})
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, authenticated, addresses, solanaAddresses, solanaListReady, hasSolanaAccount])
  // Privy can finish signing in after the app has stopped waiting for it
  // (a slow phone, a cold start): attach the wallet whenever it does, so a
  // Privy account is never left without its wallet for the session. The
  // account's record is enough - signing waits for the wallet iframe itself.
  useEffect(() => {
    const known = [addresses, linked].filter(Boolean).join(',')
    if (!ready || !authenticated || !known) return
    const { walletAddress, walletSource, signer, setWallet } = useAuthStore.getState()
    // Also behind the lock screen: the app lock only covers the app (store
    // lock()), so the wallet is ready the moment it's unlocked. 'social-auto':
    // a sign-in that gave up on a slow Privy took a Privy wallet for an old
    // device-only one - Privy's own record listing the address settles it.
    if (signer || !walletAddress) return
    if (walletSource !== 'privy' && walletSource !== 'social-auto') return
    if (!known.toLowerCase().split(',').includes(walletAddress.toLowerCase())) return
    setWallet(walletAddress, privyAccount(walletAddress), 'privy')
  }, [ready, authenticated, addresses, linked])
  // Keep Privy warm: when the app comes back to the foreground (or the
  // wallet is unlocked) refresh Privy's session right away, so the first
  // payment after a resume isn't the one that waits for it.
  useEffect(() => {
    if (!ready || !authenticated) return
    const warm = () => { if (document.visibilityState === 'visible') void getAccessToken().catch(() => {}) }
    document.addEventListener('visibilitychange', warm)
    window.addEventListener('meshport:wallet-unlocked', warm)
    return () => { document.removeEventListener('visibilitychange', warm); window.removeEventListener('meshport:wallet-unlocked', warm) }
  }, [ready, authenticated, getAccessToken])
  useEffect(() => {
    if (!syncFailed) return
    void import('@/lib/errorReport').then(r => r.reportClientError('rejection', new Error(
      `[privy sync] Privy still signed out after ${resyncs.current} re-sync(s), status=${statusRef.current} - rebuilding Privy`,
    ))).catch(() => {})
    onWalletStuck('Privy signed out, sync failed')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncFailed])
  // Start-up timeline (client_errors), once per page load when it was slow:
  // where a cold start spends its time - Privy loaded, signed in, wallet listed.
  useEffect(() => {
    if (ready) markPrivy('ready')
    if (ready && authenticated) markPrivy('signedIn')
    if (addresses) markPrivy('walletListed')
  }, [ready, authenticated, addresses])
  // Privy's wallet iframe stuck: signed in, the account has a wallet, but it
  // isn't connected (seen: "ready=true authenticated=true wallets=0" for
  // 23 s, and signing aborted after 21 s). Privy never rebuilds a dead iframe
  // by itself; PrivyRoot rebuilds Privy (a new iframe).
  // Slow is not stuck: a rebuild throws away everything Privy has done so far
  // (field, 28 Oct: on a slow connection two rebuilds 20 s and 39 s in, the
  // wallet listed only at 53 s and the payment waited on it). So it waits for
  // Privy to go quiet - nothing from Privy (its requests, its iframe) while
  // the app's own requests still get answers - and for at least as long as
  // Privy took to load on this connection.
  const stuckRef = useRef(onWalletStuck)
  stuckRef.current = onWalletStuck
  const mountedAt = useRef(performance.now()).current
  const readyAt = useRef(0)
  if (ready && !readyAt.current) readyAt.current = performance.now()
  useEffect(() => {
    if (!ready || !authenticated || !hasLinkedWallet || addresses) return
    // 5 s: field timings (328 starts) - the iframe connects within 4.1 s of
    // sign-in at p95; past 5 s it was nearly always stuck (9 of 13 cases).
    const quietMs = Math.max(5_000, readyAt.current - mountedAt)
    return whenPrivyQuiet(performance.now(), quietMs, () => stuckRef.current('wallet not connected, Privy quiet'))
  }, [ready, authenticated, hasLinkedWallet, addresses, mountedAt])
  // Privy itself never loaded: started while the phone had no connection,
  // its first request hangs and Privy never retries it - field: "ready=false"
  // for the whole 30 s while the app's own requests got through again from
  // 10 s on, then "Your wallet didn't open". Start it again on a fresh
  // connection - only once Privy has gone quiet with the network working.
  useEffect(() => {
    if (ready) return
    return whenPrivyQuiet(mountedAt, PRIVY_QUIET_MS, () => stuckRef.current('Privy not loaded, Privy quiet'))
  }, [ready, mountedAt])
  useEffect(() => () => setPrivyBridge(null), [])
  return null
}

// When the app was last in the background (a resume often finds Privy's iframe dead).
let lastHiddenAt = 0
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') lastHiddenAt = performance.now() })
  // Privy reports a failed iframe only to the console - send it to client_errors too.
  const warn = console.warn.bind(console)
  console.warn = (...args: unknown[]) => {
    if (typeof args[0] === 'string' && args[0].startsWith('Privy iframe failed to load')) {
      void import('@/lib/errorReport').then(r => r.reportClientError('rejection', new Error(`[privy iframe] failed to load: ${String(args[1] ?? '').slice(0, 160)}`))).catch(() => {})
    }
    warn(...args)
  }
}

const privyMarks: Record<string, number> = { mounted: performance.now() }
let timelineSent = false
function markPrivy(name: 'ready' | 'signedIn' | 'walletListed') {
  if (privyMarks[name] == null) privyMarks[name] = performance.now()
  if (timelineSent || privyMarks.walletListed == null) return
  timelineSent = true
  const s = (v?: number) => (v == null ? '-' : (v / 1000).toFixed(1))
  const total = privyMarks.walletListed
  if (total < 3_000) return
  void import('@/lib/errorReport').then(r => r.reportClientError('rejection', new Error(
    `[privy timeline] since page load: privy code ran ${s(privyMarks.mounted)} s, ready ${s(privyMarks.ready)} s, signed in ${s(privyMarks.signedIn)} s, wallet listed ${s(privyMarks.walletListed)} s`,
  ))).catch(() => {})
}

// Away this long and Privy's iframe connection may be stale (see PrivyRoot).
const LONG_BACKGROUND_MS = 3 * 60_000
// The re-check after the background: Privy silent this long (the app's own
// requests answered meanwhile) means its iframe is dead. A live one signs the
// warm-up in ~2 s (field: "[privy warm-up] slow: 2.0-2.6 s").
const STALE_QUIET_MS = 6_000

// Rebuilds of Privy (a stuck wallet iframe, or Privy that never loaded).
// The first two right away; after that it never gives up for the session -
// on a weak connection Privy can need several tries (field 31 Oct: two
// rebuilds at 12 s and 21 s, then "not rebuilding again", and the wallet was
// gone until the app was restarted). Later rebuilds wait longer each time,
// so a slow Privy still gets time to finish: 20 s, 40 s, then every 60 s.
const EVENT_REBUILD_MIN_UP_MS = 10_000
let privyRebuilds = 0
let lastRebuildAt = 0

export default function PrivyRoot() {
  const [generation, setGeneration] = useState(0)
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const onWalletStuckRef = useRef<(why: string, urgent?: boolean) => void>(() => {})
  // `urgent`: a signature is waiting on a dead iframe - at most 10 s after the previous rebuild.
  const onWalletStuck = (why: string, urgent = false) => {
    if (!privyNeedsRebuild()) return
    const gap = urgent ? Math.min(rebuildGapMs(privyRebuilds), 10_000) : rebuildGapMs(privyRebuilds)
    const wait = lastRebuildAt + gap - performance.now()
    if (wait > 0) {
      // Too soon after the last one: try again once the gap has passed (if still needed).
      // An urgent one replaces a slower retry already scheduled.
      if (retryTimer.current && urgent) { clearTimeout(retryTimer.current); retryTimer.current = null }
      if (!retryTimer.current) retryTimer.current = setTimeout(() => { retryTimer.current = null; onWalletStuckRef.current(why, urgent) }, wait)
      return
    }
    const sinceHidden = lastHiddenAt ? `${((performance.now() - lastHiddenAt) / 1000).toFixed(0)} s after the app was last in the background` : 'no background since page load'
    const n = privyRebuilds + 1
    void import('@/lib/errorReport').then(r => r.reportClientError('rejection', new Error(
      `[privy iframe] ${why} (${sinceHidden}, page up ${(performance.now() / 1000).toFixed(0)} s) - rebuilding Privy (#${n})`,
    ))).catch(() => {})
    privyRebuilds++
    lastRebuildAt = performance.now()
    setGeneration(g => g + 1)
  }
  onWalletStuckRef.current = onWalletStuck
  // The connection came back, the app came to the screen, or a payment needs
  // the wallet now (privy.ts restorePrivyAccount): if Privy still isn't up,
  // start it again on the working connection.
  useEffect(() => {
    // Only once this Privy has had 10 s to load (a cold start isn't thrown away mid-load).
    const again = (why: string) => () => {
      if (privyNeedsRebuild() && performance.now() - lastRebuildAt >= EVENT_REBUILD_MIN_UP_MS) onWalletStuckRef.current(why)
    }
    const online = again('connection back, Privy not up')
    const needed = again('wallet needed, Privy not up')
    const visible = () => { if (document.visibilityState === 'visible') again('back on screen, Privy not up')() }
    // Privy's iframe aborted a signature (privy.ts replaceDeadPrivy): replace it
    // now - a signature is waiting on it - within the usual pacing.
    const dead = () => onWalletStuckRef.current('signing aborted, wallet iframe dead', true)
    window.addEventListener(PRIVY_DEAD_EVENT, dead)
    window.addEventListener('online', online)
    window.addEventListener(PRIVY_NEEDED_EVENT, needed)
    document.addEventListener('visibilitychange', visible)
    return () => {
      window.removeEventListener(PRIVY_DEAD_EVENT, dead)
      window.removeEventListener('online', online)
      window.removeEventListener(PRIVY_NEEDED_EVENT, needed)
      document.removeEventListener('visibilitychange', visible)
      if (retryTimer.current) clearTimeout(retryTimer.current)
    }
  }, [])
  // Back from a long background (Android freezes the page): the same Privy
  // is checked, not replaced. One silent warm-up signature proves the wallet
  // still signs - the lock screen waits for it (walletReadiness), so the
  // payment after unlock signs at once. (Locking itself no longer touches
  // Privy - it's an app lock only, store lock().) Rebuilding Privy here (what
  // this did until 28 Oct) threw its session away on every return: the next
  // signature was always a cold start. Rebuilt only when the check shows the
  // iframe is dead after all - Privy quiet while the app's own requests are
  // answered (field: a stale iframe "hung" 20-44 s, "signal is aborted").
  // Once per return from the background.
  useEffect(() => {
    let checkedFor = -1
    let stopWatch: (() => void) | null = null
    const recheck = () => {
      if (checkedFor === lastHiddenAt) return
      checkedFor = lastHiddenAt
      stopWatch?.()
      const started = performance.now()
      const checks = recheckPrivySigners()
      if (!checks.length) return
      let answered = false
      const watch = whenPrivyQuiet(started, STALE_QUIET_MS, () => {
        if (answered) return
        void import('@/lib/errorReport').then(r => r.reportClientError('rejection', new Error(
          `[privy iframe] no answer after the background (${((started - lastHiddenAt) / 1000).toFixed(0)} s away) - rebuilding Privy`,
        ))).catch(() => {})
        setGeneration(g => g + 1)
      })
      stopWatch = watch
      void Promise.all(checks).then(() => { answered = true; watch() })
    }
    const onVisible = () => {
      if (document.visibilityState === 'visible' && lastHiddenAt && performance.now() - lastHiddenAt >= LONG_BACKGROUND_MS) recheck()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => { stopWatch?.(); document.removeEventListener('visibilitychange', onVisible) }
  }, [])
  return (
    <PrivyProvider
      key={generation}
      appId={privyAppId()}
      config={{
        embeddedWallets: { ethereum: { createOnLogin: 'off' }, solana: { createOnLogin: 'off' }, showWalletUIs: false },
        defaultChain: ARC_FOR_PRIVY,
        supportedChains: SUPPORTED_CHAINS,
        solana: {
          rpcs: {
            'solana:devnet': {
              rpc: createSolanaRpc(SOLANA_RPC),
              rpcSubscriptions: createSolanaRpcSubscriptions(SOLANA_RPC.replace('https://', 'wss://')),
            },
          },
        },
      }}
    >
      <PrivyBridgeSync onWalletStuck={onWalletStuck} />
    </PrivyProvider>
  )
}
