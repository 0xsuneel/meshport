import { defineChain } from 'viem'
import { ARC, ARC_RPCS } from '@/blockchain/chains'

// Arc docs: nativeCurrency.decimals must be 18 for transaction signing
// (gas is denominated in 18-decimal USDC wei).
// The ERC-20 interface uses 6 decimals for transfers — but chain config
// must reflect the native 18-decimal representation for viem gas handling.
//
// Chain id / explorer / RPC list now come from the shared registry
// (src/blockchain/chains.ts). Same values as before — testnet only.
export const arcTestnet = defineChain({
  id: ARC.chainId,
  name: ARC.name,
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: {
    default: { http: ARC_RPCS },
    public:  { http: ARC_RPCS },
  },
  blockExplorers: {
    default: { name: 'ArcScan', url: ARC.explorerUrl },
  },
  testnet: true,
})

export type { Chain } from 'viem'
