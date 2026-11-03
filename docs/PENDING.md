# Pending work - MeshPort

The running list of things decided but not finished. Update it whenever an
item is done or a new one is agreed. (Started 3 Nov 2026.)

## 1. Circle developer-controlled wallets for the relayer and fees - **do first**

Plan: replace the relayer's private key (`BRIDGE_RELAYER_PRIVATE_KEY` in
Vercel) with a Circle developer-controlled EOA wallet that signs relayer
transactions (Circle `signTransaction`) and receives every MeshPort fee.

- [ ] **You:** in Circle's console, create the wallet set and EOA wallets.
      Confirm the **same address on every EVM chain** (derive wallet), and
      whether the generic "EVM" wallet type is enabled for chains Circle
      doesn't list (Sei, Sonic, HyperEVM, XDC, Plume, …).
- [ ] **You:** give me the EVM wallet ID(s) + address and the Solana wallet ID.
- [ ] **Me:** `api/_lib/relayerSigner.ts` - a viem account whose
      `signTransaction` calls Circle, behind `RELAYER_MODE=circle`
      (`CIRCLE_API_KEY`, `CIRCLE_ENTITY_SECRET`, wallet IDs). Every relayer
      path in `api/bridge-relay.ts` keeps working; we still broadcast ourselves.
- [ ] **Me:** the Solana fee payer (`api/solana-fee-payer.ts`) on a Circle Solana wallet.
- [ ] **Me (optional):** the rewards signer (`rewards-claim-sign`, typed data) on Circle.
- [ ] **You:** fund the Circle wallet with native gas on each chain; test on testnet;
      then remove `BRIDGE_RELAYER_PRIVATE_KEY` / `SOLANA_FEE_PAYER_SECRET`.

**Hold until the Circle wallet address exists** (these contracts lock their
fee address at deploy - deploying now means redeploying later):

- [ ] Deploy **MeshPortRouter on Arc** (`node contracts/deploy-router-all.cjs --chains=Arc_Testnet`)
      with `FEE_RECIPIENT` = the Circle wallet → set `VITE_ARC_ROUTER` / `ARC_ROUTER`.
- [ ] Deploy **MeshPortCheckout** (`node contracts/deploy-checkout.cjs`) with
      `FEE_RECIPIENT` = the Circle wallet → set `VITE_MESHPORT_CHECKOUT` (Vercel)
      and `MESHPORT_CHECKOUT` (Supabase secrets); then I redeploy `merchant-pay`.
- [ ] **Redeploy the Bring routers** on the other chains with the new
      `FEE_RECIPIENT` → update `VITE_BRIDGE_ROUTERS` / `BRIDGE_ROUTERS`.
- [ ] Set `VITE_FEE_WALLET` = the Circle wallet (swap fee).
- [ ] Mainnet only: `BRIDGE_NETWORK=mainnet` (live gas-coin prices for fees).

## 2. Fees (agreed list - `src/lib/feePolicy.ts`)

Done: never-a-loss rule, cross-chain 0.2% (Bring + Arc router Transfer),
swap 0.35%, merchant 0.6% on **order** payments (MeshPortCheckout, ready to
deploy). Pay and plain receives are free - never add a fee there.

- [ ] Merchant fee line on order / payment details ("MeshPort fee $0.60").
- [ ] Merchant fee on order payments made on **other chains** and collected
      with Claim All - only the order payments, never plain receives (needs a
      record of which payments were already charged).
- [ ] UB Bring fee (0.2%) - as a second recipient in the signed Gateway spend.
- [ ] Solana Bring fee (0.2% + new-account rent) - a fee transfer in the
      Solana transaction, and the fee-payer check allowing it.
- [ ] P2P trades 0.2% (taker) - escrow contract release change.
- [ ] Bulk payouts 0.25% (cap $1 per recipient).
- [ ] First cross-chain move free each month (per-wallet counter).

## 3. Unified Balance

- [x] UB removed from **Transfer** (`TRANSFER_UB_ENABLED = false` in
      `src/lib/featureFilters.ts`; all code kept). UB chains send over CCTP.
- [ ] Rebuild UB "on the other side" (your plan), then decide the UB deposit
      gas: MeshPort pays it, or keep charging the user.
- [ ] UB in 2 signatures instead of 3 (deposit authorization submitted by
      the relayer; prepare the signature during the PIN).
- Notes from Arc / Circle docs (3 Nov) for the rebuild:
  - UB fee: use the kit's built-in **custom spend fee** (`customFee` on
    `unifiedBalance.spend`) - it adds burn intents to our fee recipient in the
    same user signature; Arc keeps 10%. Only on spends, not deposits.
  - **Fast deposits** (`transferSpeed: 'FAST'`, USDC, EVM sources): a CCTP
    fast burn via TokenMessengerWithFees (testnet 0x8745D906…0C0A) lands in
    the Arc Gateway in ~60 s instead of 13-19 min from Ethereum/Base/Arbitrum/OP.
  - UB now covers **USDC, EURC and cirBTC** (EURC/cirBTC: standard deposits only;
    the forwarder supports USDC and cirBTC).
  - Deposit wait before spendable: Arc ~0.5 s; Avalanche/Polygon/Sonic ~8 s;
    HyperEVM/Sei ~5 s; Ethereum/Base/Arbitrum/OP/Unichain/World ~13-19 min.
  - Delegates can sign spends for a user, but per chain and for the whole
    balance (no cap) - not for user funds.

## 4. Other open items

- [ ] Wallets that already approved TokenMessengerV2 for unlimited USDC
      (Transfer before the Arc router): a one-time "remove approval" once
      the router is live.
- [ ] Frame-hosted passcode keypad - skipped on web (a compromised page can
      draw a fake keypad); do it natively in the mobile app (Keystore / Keychain).
- [ ] Circle signing page reload (~0.7 s per signature) - needs Circle.
- [ ] Sui - not possible on Arc today (Sui is CCTP V1 only, no Gateway).

## 5. Circle / Arc products to consider for business (checked 3 Nov)

- **Onramp** (App Kit): embeddable widget - buy USDC on Arc with fiat, KYC and
  payments handled by Arc. Needs a Circle API key; some methods need KYB.
- **Earn** (App Kit): USDC / EURC vaults on Arc (DeFi lending) - idle business
  balances. **Borrow** (App Kit): USDC against cirBTC on Arc, with a
  configurable **integrator fee** (revenue).
- **Gateway Nanopayments (x402)**: buyer deposits to Gateway once, then every
  payment is an off-chain EIP-3009 signature (zero gas, down to $0.000001);
  Gateway settles in batches to the seller's Gateway balance. Fits pay-per-use,
  tips, metered services.
- **Circle Mint** (qualified businesses, KYB): USD ↔ USDC at no cost, Crypto
  Deposits (payment intents) and Crypto Payouts APIs - merchant cash-out.
- **StableFX** (permissioned, via Circle sales): RFQ USDC ↔ EURC FX settled on
  Arc (FxEscrow) - better rates for larger swaps / business FX.
- **Paymaster**: gas in USDC for ERC-4337 smart accounts on other chains.
- Not available: a hosted e-commerce checkout - Circle removed Checkout
  Sessions / Pull Crypto Payments from Circle Mint (Apr 2025). MeshPortCheckout
  is our own.
