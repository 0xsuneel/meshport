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
import { privyAccount, privyAppId, setPrivyBridge } from './privy'
import { useSupabaseSession } from './PrivyGate'
import { useWalletReadiness } from '@/lib/walletReadiness'

// How long Privy gets to load before a stalled start is begun again (see PrivyBridgeSync).
const PRIVY_LOAD_MS = 8_000

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
  // isn't connected 5 s later (seen: "ready=true authenticated=true
  // wallets=0" for 23 s, and signing aborted after 21 s). Privy never
  // rebuilds a dead iframe by itself; PrivyRoot rebuilds Privy (a new iframe).
  const stuckRef = useRef(onWalletStuck)
  stuckRef.current = onWalletStuck
  useEffect(() => {
    if (!ready || !authenticated || !hasLinkedWallet || addresses) return
    // 5 s: field timings (328 starts) - the iframe connects within 4.1 s of
    // sign-in at p95; past 5 s it was nearly always stuck (9 of 13 cases),
    // and each stuck one used to wait 8 s before the rebuild even began.
    const t = setTimeout(() => stuckRef.current('wallet not connected 5 s after sign-in'), 5_000)
    return () => clearTimeout(t)
  }, [ready, authenticated, hasLinkedWallet, addresses])
  // Privy itself never loaded: started while the phone had no connection,
  // its first request hangs and Privy never retries it - field: "ready=false"
  // for the whole 30 s while the app's own requests got through again from
  // 10 s on, then "Your wallet didn't open". Once the network is shown
  // working (Arc answered) and Privy has had its normal time (ready by 6 s
  // at worst in the field), start it again on a fresh connection.
  useEffect(() => {
    if (ready) return
    let due = false
    let fired = false
    const check = () => {
      if (fired || !due || !useWalletReadiness.getState().networkReady) return
      fired = true
      stuckRef.current('Privy not loaded with the network working')
    }
    const t = setTimeout(() => { due = true; check() }, PRIVY_LOAD_MS)
    const unsub = useWalletReadiness.subscribe(check)
    return () => { clearTimeout(t); unsub() }
  }, [ready])
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

// Away this long and Privy's iframe connection is likely stale (see PrivyRoot).
const LONG_BACKGROUND_MS = 3 * 60_000

// Rebuilds of Privy this page load (a stuck wallet iframe) - at most 2.
const MAX_PRIVY_REBUILDS = 2
let privyRebuilds = 0

export default function PrivyRoot() {
  const [generation, setGeneration] = useState(0)
  const onWalletStuck = (why: string) => {
    const sinceHidden = lastHiddenAt ? `${((performance.now() - lastHiddenAt) / 1000).toFixed(0)} s after the app was last in the background` : 'no background since page load'
    const willRebuild = privyRebuilds < MAX_PRIVY_REBUILDS
    void import('@/lib/errorReport').then(r => r.reportClientError('rejection', new Error(
      `[privy iframe] ${why} (${sinceHidden}, page up ${(performance.now() / 1000).toFixed(0)} s) - ${willRebuild ? `rebuilding Privy (#${privyRebuilds + 1})` : 'not rebuilding again'}`,
    ))).catch(() => {})
    if (!willRebuild) return
    privyRebuilds++
    setGeneration(g => g + 1)
  }
  // A fresh Privy for the next signature, ready before it's needed. After the
  // app sat in the background (Android freezes the page), Privy still lists
  // the wallet but its iframe's connection is stale: the first signature
  // then re-authenticates the wallet with Privy (/api/v1/wallets/authenticate)
  // and hung - 20-44 s ("signal is aborted", "<no response> TimeoutError"),
  // the "36 s" payment right after unlocking. A new iframe connects and
  // authenticates while the lock screen is up, so the payment signs at once.
  // Once per return from the background: when the app locks (it was away
  // 15+ min) or comes back after a long background.
  useEffect(() => {
    let refreshedFor = -1
    const refresh = () => {
      if (refreshedFor === lastHiddenAt) return
      refreshedFor = lastHiddenAt
      setGeneration(g => g + 1)
    }
    const onLocked = () => { if (lastHiddenAt) refresh() }
    const onVisible = () => {
      if (document.visibilityState === 'visible' && lastHiddenAt && performance.now() - lastHiddenAt >= LONG_BACKGROUND_MS) refresh()
    }
    window.addEventListener('meshport:wallet-locked', onLocked)
    document.addEventListener('visibilitychange', onVisible)
    return () => { window.removeEventListener('meshport:wallet-locked', onLocked); document.removeEventListener('visibilitychange', onVisible) }
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
