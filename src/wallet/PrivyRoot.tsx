// src/wallet/PrivyRoot.tsx
//
// Privy's React SDK, mounted only while a Google / email account is signed in
// (PrivyGate), so nobody else downloads it. It signs in to Privy with
// MeshPort's own Supabase session (custom auth: no second login) and hands
// src/wallet/privy.ts a bridge to create wallets and sign. Privy's own
// confirmation modals are off: the app's passcode / biometric is the approval.

import { useEffect } from 'react'
import {
  PrivyProvider, usePrivy, useWallets, useCreateWallet, useSignTransaction, useSignMessage, useSignTypedData,
  useSubscribeToJwtAuthWithFlag,
} from '@privy-io/react-auth'
import { defineChain, type Chain, type Hex } from 'viem'
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
const SUPPORTED_CHAINS: [Chain, ...Chain[]] = [
  arcTestnet,
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

  const { ready, authenticated } = usePrivy()
  const { wallets } = useWallets()
  const { createWallet } = useCreateWallet()
  const { signTransaction } = useSignTransaction()
  const { signMessage } = useSignMessage()
  const { signTypedData } = useSignTypedData()
  const embedded = wallets.filter(w => w.walletClientType === 'privy')
  const addresses = embedded.map(w => w.address).join(',')

  useEffect(() => {
    const quiet = { uiOptions: { showWalletUIs: false } }
    setPrivyBridge({
      ready, authenticated,
      wallets: addresses ? addresses.split(',') : [],
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
  }, [ready, authenticated, addresses])
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
  useEffect(() => () => setPrivyBridge(null), [])
  return null
}

export default function PrivyRoot() {
  return (
    <PrivyProvider
      appId={privyAppId()}
      config={{
        embeddedWallets: { ethereum: { createOnLogin: 'off' }, showWalletUIs: false },
        defaultChain: arcTestnet,
        supportedChains: SUPPORTED_CHAINS,
      }}
    >
      <PrivyBridgeSync />
    </PrivyProvider>
  )
}
