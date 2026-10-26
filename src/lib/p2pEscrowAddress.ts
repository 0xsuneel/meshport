// src/lib/p2pEscrowAddress.ts
//
// The P2P escrow contract's address (lower case, '' when not configured),
// from the same env var p2pEscrowContract.ts uses - without that module's
// viem import, for the "is this transfer from our own contract" checks that
// run at app start (onchainReceivedActivity).
const CONTRACT_ADDRESS = (import.meta.env.VITE_P2P_ESCROW_CONTRACT as string || '').trim()
export const P2P_ESCROW_CONTRACT_ADDRESS = CONTRACT_ADDRESS ? CONTRACT_ADDRESS.toLowerCase() : ''
