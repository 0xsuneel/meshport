// src/wallet/PrivyRoot.tsx
//
// Privy's React SDK, mounted only while a Google / email account is signed in
// (PrivyGate), so nobody else downloads it. It signs in to Privy with
// MeshPort's own Supabase session (custom auth: no second login) and hands
// src/wallet/privy.ts a bridge to create wallets and sign. Privy's own
// confirmation modals are off: the app's passcode / biometric is the approval.

import { useEffect, useRef } from 'react'
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

function PrivyBridgeSync() {
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
  }, [ready, authenticated, addresses, solanaAddresses, solanaListReady])
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
  // Privy account is never left without its wallet for the session.
  useEffect(() => {
    if (!ready || !authenticated || !addresses) return
    const { walletAddress, walletSource, signer, setWallet } = useAuthStore.getState()
    if (walletSource !== 'privy' || signer || !walletAddress) return
    if (!addresses.toLowerCase().split(',').includes(walletAddress.toLowerCase())) return
    setWallet(walletAddress, privyAccount(walletAddress), 'privy')
  }, [ready, authenticated, addresses])
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
  useEffect(() => () => setPrivyBridge(null), [])
  return null
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

export default function PrivyRoot() {
  return (
    <PrivyProvider
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
      <PrivyBridgeSync />
    </PrivyProvider>
  )
}
