// src/wallet/PrivyRoot.tsx
//
// Privy's React SDK, mounted only while a Google / email account is signed in
// (PrivyGate), so nobody else downloads it. It signs in to Privy with
// MeshPort's own Supabase session (custom auth: no second login) and hands
// src/wallet/privy.ts a bridge to create wallets and sign. Privy's own
// confirmation modals are off: the app's passcode / biometric is the approval.

import { useEffect, useRef, useState } from 'react'
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
import { privyAccount, privyAppId, recheckPrivySigners, setPrivyBridge } from './privy'
import { useSupabaseSession } from './PrivyGate'
import { whenPrivyQuiet } from './privyActivity'

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
  useSubscribeToJwtAuthWithFlag({
    isAuthenticated: signedIn,
    isLoading: loading,
    getExternalJwt: async () => (await supabase.auth.getSession()).data.session?.access_token,
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

  useEffect(() => {
    const quiet = { uiOptions: { showWalletUIs: false } }
    setPrivyBridge({
      ready, authenticated,
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
  }, [ready, authenticated, addresses, linked, solanaAddresses, solanaListReady])
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
    const { walletAddress, walletSource, signer, setWallet, isLocked } = useAuthStore.getState()
    // Locked: unlocking opens it (restoreWallet). 'social-auto': a sign-in
    // that gave up on a slow Privy took a Privy wallet for an old device-only
    // one - Privy's own record listing the address settles it.
    if (signer || !walletAddress || isLocked) return
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

// Rebuilds of Privy this page load (a stuck wallet iframe) - at most 2.
const MAX_PRIVY_REBUILDS = 2
let privyRebuilds = 0

export default function PrivyRoot() {
  const [generation, setGeneration] = useState(0)
  const onWalletStuck = (why: string) => {
    const sinceHidden = lastHiddenAt ? `${((performance.now() - lastHiddenAt) / 1000).toFixed(0)} s after the app was last in the background` : 'no background since page load'
    const willRebuild = privyRebuilds < MAX_PRIVY_REBUILDS
    const n = privyRebuilds + 1
    void import('@/lib/errorReport').then(r => r.reportClientError('rejection', new Error(
      `[privy iframe] ${why} (${sinceHidden}, page up ${(performance.now() / 1000).toFixed(0)} s) - ${willRebuild ? `rebuilding Privy (#${n})` : 'not rebuilding again'}`,
    ))).catch(() => {})
    if (!willRebuild) return
    privyRebuilds++
    setGeneration(g => g + 1)
  }
  // Back from the background (Android freezes the page) or unlocked: the
  // same Privy is checked, not replaced. One silent warm-up signature proves
  // the wallet still signs - the lock screen waits for it (walletReadiness),
  // so the payment after unlock signs at once. Rebuilding Privy here (what
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
    const onLocked = () => { if (lastHiddenAt) recheck() }
    const onVisible = () => {
      if (document.visibilityState === 'visible' && lastHiddenAt && performance.now() - lastHiddenAt >= LONG_BACKGROUND_MS) recheck()
    }
    window.addEventListener('meshport:wallet-locked', onLocked)
    document.addEventListener('visibilitychange', onVisible)
    return () => { stopWatch?.(); window.removeEventListener('meshport:wallet-locked', onLocked); document.removeEventListener('visibilitychange', onVisible) }
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
