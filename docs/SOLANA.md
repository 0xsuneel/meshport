# Solana (devnet)

Every MeshPort account has a Solana wallet next to its Arc wallet, and Solana
works like the other cross-chain networks: Transfer (Arc → Solana), Bring
Funds and Business "Collect from chains" (Solana → Arc). MeshPort pays the SOL
fees (option A), so nobody needs SOL.

| Account | Solana wallet |
|---|---|
| Google / email (Privy) | Privy's embedded Solana wallet, created once the Arc wallet exists |
| Created / imported | derived in the wallet frame: ed25519 seed = sha256(walletKey ‖ "meshport-solana-key-v1") (`lib/solanaKey.ts`). Same address on every device; restored by the existing recovery phrase / private key |

## Moves

- **Arc → Solana (Transfer):** Circle App Kit `bridge` with `to: { chain: 'Solana_Devnet', recipientAddress, useForwarder: true }`.
  Circle mints into the recipient's USDC token account, which must exist, so
  MeshPort opens it first (`POST /api/solana-fee-payer { openAccount }`, MeshPort pays the ~0.002 SOL rent).
- **Solana → Arc (Bring / Collect):** `lib/solanaCctp.ts` builds CCTP v2
  `deposit_for_burn_with_hook` (Circle's IDL) with the `cctp-forward` hook, so
  Circle's Forwarding Service mints on Arc to the account's Arc address. The
  account signs (`wallet/solana.ts`), a fresh keypair signs as the event
  account, and MeshPort's fee payer signs last as fee payer and event-rent
  payer (~0.0039 SOL, reclaimable later). Progress is followed through Iris by
  the burn signature (`lib/cctpTracker.ts`, domain 5).

## Fee payer (`/api/solana-fee-payer`)

Fee payer `63yAuT3Do4GbQDCVxRX79G1zCXg7FDGn9JEhkU5LhrdA`, key in Vercel
`SOLANA_FEE_PAYER_SECRET` (sensitive). Co-signs only (`server/solana/feePayer.ts`):
Compute Budget (capped), USDC account create, USDC TransferChecked, and CCTP v2
burns of USDC **to Arc with Circle's forwarding hook**; MeshPort's key may
appear only as fee / rent payer. Any signed-in session; 10/min, 100/h per
account, 30/min per IP; opening accounts 30/day per account and per IP.

## Not yet

- Store QR payments on Solana: MeshPort's payment watcher (Supabase edge
  functions) reads EVM chains only.
- Solana brings don't create `claims` rows (claim-submit lowercases hashes;
  claim-worker is EVM): they are followed on the device, and Circle's
  forwarder finishes them either way.
- Reclaiming CCTP event-account rent.

## Facts

- CCTP v2: Solana = domain 5; MessageTransmitterV2
  `CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC`, TokenMessengerMinterV2
  `CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe`. USDC devnet mint
  `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`.
- Verified 2026-10-25: the burn simulates on devnet against Circle's programs
  (42k CU); App Kit 1.11 estimates Arc → Solana with the forwarder (0.128 USDC).
- Packages (Vercel installs with `--legacy-peer-deps`): `@solana/kit` 5.5.1,
  `@solana-program/memo` 0.10.0.
