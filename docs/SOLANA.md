# Solana (devnet)

Privy accounts (Google / email) get a Solana wallet next to their Arc wallet:
same MeshPort sign-in, same passcode / biometric. Plan:
"MeshPort Solana Plan" (Claude doc). Fees: MeshPort pays (option A).

| Phase | Status |
|---|---|
| 1. Solana wallet, address and USDC balance (Receive) | Done |
| 2. Fee payer (`/api/solana-fee-payer`, co-signs only USDC transfers and CCTP v2 burns) | Next |
| 3. Send USDC on Solana | |
| 4. Bridge Arc ↔ Solana over CCTP v2 (Arc → Solana via the Forwarding Service) | |

## Code

- `src/lib/solana.ts` - devnet RPC, USDC mint `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`,
  address check, USDC balance over JSON-RPC.
- `src/wallet/PrivyRoot.tsx` - Privy's Solana hooks; a Privy account gets its
  Solana wallet once its Arc wallet exists; `solana:devnet` RPCs.
- `src/wallet/privy.ts` - bridge: `solanaWallets`, `createSolanaWallet`,
  `signSolanaTransaction`; `privySolanaAddress`, `onPrivyChange`.
- `src/wallet/useSolanaWallet.ts` - address + balance for screens.
- `src/features/receive/SolanaReceiveCard.tsx` - Receive → Solana card.

## Facts

- CCTP v2: Solana = domain 5; MessageTransmitterV2
  `CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC`, TokenMessengerMinterV2
  `CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe` (same ids on devnet and mainnet).
- Packages pinned and listed directly (Vercel installs with
  `--legacy-peer-deps`): `@solana/kit` 5.5.1, `@solana-program/memo` 0.10.0
  (Privy's Solana module imports it; 0.10.x matches kit 5).
