# Pending work - MeshPort

The running list of things decided but not finished. Update it whenever an
item is done or a new one is agreed. (Started 3 Nov 2026.)

## 1. Circle developer-controlled wallets for the relayer and fees - **do first**

Plan: replace the relayer's private key (`BRIDGE_RELAYER_PRIVATE_KEY` in
Vercel) with a Circle developer-controlled EOA wallet that signs relayer
transactions (Circle `signTransaction`) and receives every MeshPort fee.

- [x] **You:** wallets created (scripts/circle-create-wallets.mjs, 6 Nov):
      wallet set `6c7e36d8-92f6-581e-b350-caa73814ac4d`;
      relayer + fee wallet `3077130c-ef06-5204-aa4c-b46e1a9aeb3d` (EVM-TESTNET),
      address `0x7218ec7dd868444a7655599551520ac5bcca7c0d`;
      Solana fee payer `6b01cdd1-417c-5eea-9fe6-3c886997e446` (SOL-DEVNET),
      address `3FCjnsPHrjtJnM2Gei1RxKYbBFc2hHqDkWeKAjciXBN8`.
- [x] **You:** signing check (6 Nov): 16 of 19 relayer chains sign, Arc
      included. Refused: Sonic 14601, Sei 1328, HyperEVM 998 - they keep the
      private key (`CIRCLE_SIGN_UNSUPPORTED_CHAINS`, default "998,1328,14601").
- [x] **Me:** `api/_lib/relayerSigner.ts` - viem account that signs through
      Circle, behind `RELAYER_MODE=circle`; every signed transaction is checked
      (signer, nonce, chain, to, value, data, gas, fee) before broadcast. P2P
      offers made before the switch name the old relayer as operator, so
      registerTrade / cancelTrade fall back to the key wallet when needed.
- [x] **Bring: relayer mints on Arc** (6 Nov) instead of Circle's forwarder - saves the
      ~$0.0236 forwarding fee per Bring (Arc mint gas ~$0.0045, in MeshPort's fee).
      Server mints after the burn (waitUntil); the app re-checks after 60 s; quotes fall
      back to Circle's forwarder if the relayer's Arc gas is < 0.5 USDC or
      `BRING_ARC_MINT=circle`. EURC / cirBTC still use CCTPx's own flow.
- [x] **Live (6 Nov):** Circle relayer on. First Bring (Ethereum Sepolia → Arc, 1 USDC,
      38.4 s) sent from 0x7218…7c0d through router 0x4B53…b377; fee $0.05 to 0x7218…7c0d.
- [x] **Me (Vercel, 6 Nov):** `CIRCLE_RELAYER_WALLET_ID`, `CIRCLE_RELAYER_ADDRESS`,
      `RELAYER_MODE=circle` (Production + Preview).
- [ ] **You (Vercel):** `CIRCLE_ENTITY_SECRET` (Sensitive, Production + Preview) -
      this is what actually switches the relayer to Circle, so fund
      `0x7218…7c0d` first. `CIRCLE_API_KEY` exists but is Production-only: it
      must be the key of the Circle account the wallets were made with; add it
      to Preview too. Keep `BRIDGE_RELAYER_PRIVATE_KEY` (3 chains + old P2P offers).
- [ ] **Me:** the Solana fee payer (`api/solana-fee-payer.ts`) on a Circle Solana wallet.
- [ ] **Me (optional):** the rewards signer (`rewards-claim-sign`, typed data) on Circle.
- [ ] **You:** fund the Circle wallet with native gas on each chain; test on testnet;
      then remove `BRIDGE_RELAYER_PRIVATE_KEY` / `SOLANA_FEE_PAYER_SECRET`.

**Hold until the Circle wallet address exists** (these contracts lock their
fee address at deploy - deploying now means redeploying later):

- [x] **MeshPortRouter** `0x4B53c10390A7A3C0AA16899a94c547974210b377` (fee to the Circle
      wallet) deployed 6 Nov on Arc + 19 Bring chains; Vercel `VITE_BRIDGE_ROUTERS` /
      `BRIDGE_ROUTERS` / `VITE_ARC_ROUTER` / `ARC_ROUTER` / `VITE_FEE_WALLET` set.
- [x] HyperEVM router deployed too (with `BRIDGE_RPC_HYPEREVM_TESTNET`) - all 19 Bring
      chains on `0x4B53…b377`. Codex / Edge: no router (deploy wallet had no gas).
- [x] **MeshPortCheckout** `0xda51a32edfc723e3de9aaf0a452fd2f71e6019f1` deployed 6 Nov
      (checked on Arc: fee recipient 0x7218…7c0d, 60 bps, cap $3); Vercel
      `VITE_MESHPORT_CHECKOUT` set.
- [x] Supabase secret `MESHPORT_CHECKOUT` set and `merchant-pay` deployed (v71, 6 Nov).
- [ ] **You:** redeploy Vercel, then test: Transfer from Arc (one signature), a Bring,
      a swap, a merchant order (paid in full; 0.6% to 0x7218…7c0d).
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
- [x] UB removed from **Bring** (`BRING_UB_ENABLED = false`, same file; code and
      Recover kept). Merchants' Claim All was CCTP already. Bring is CCTP only:
      1 signature, ~1 min, ~$0.02 (UB from Ethereum paid ~$1-3 of Gateway's
      Ethereum burn gas).
- Decision (3 Nov): MeshPort doesn't need UB today. Bring it back only as a
  hidden engine for Nanopayments / x402, merchant "receive on any chain" (+
  Collect All in one signature) and "pay from anywhere" - never as a user-facing
  "UB vs CCTP" choice.
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

- [x] One-time max approval to TokenMessengerV2 removed: Transfer now
      approves exactly the amount (the burn spends it all). A wallet with the
      old unlimited approval has it replaced by the exact amount on its next
      Transfer, so it ends at 0.
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

## 6. Build plan for the business products (agreed approach)

Order: Onramp → Global Balance (UB) + Nanopayments together → merchant
cash-out (CPN, after onboarding) → Earn → Borrow. Every feature behind an admin switch (Admin →
Features), reusing the frame passcode check, `relayerSigner` (Circle
developer wallet) for gas, `feePolicy.ts` for fees, and Activity /
wallet_events logging.

- [ ] **Onramp** (~1-2 days) - "Add money" on Home / Receive: App Kit Onramp
      widget in an iframe with the user's Arc address; on completion refresh
      the balance + Activity. Server: `/api/onramp-session` (Circle API key in
      Vercel, never in the browser). Allow `frame-src https://onramp.arc.io`.
      **You:** Onramp API key.
- [ ] **Global Balance (UB)** - its own screen: "Add money" (one signed
      authorization, relayer submits the Gateway deposit; fast deposits from
      slow chains) and "Send anywhere" (one burn-intent signature, Circle's
      forwarder mints); fee via the kit's `customFee`. Shown apart from the Arc
      wallet balance, with the 7-day emergency withdrawal explained. Plus
      **merchant Collect All** - every chain in one signature.
- [ ] **Nanopayments / x402** (~1 week, with Global Balance) - pay-per-use,
      tips, metered items: buyer deposits to Gateway once (gasless via the
      relayer), each payment is an off-chain EIP-3009 signature; a `nanopay`
      endpoint (MeshPort as facilitator) verifies and forwards to Gateway,
      which settles in batches to the merchant's Gateway balance.
- [ ] **Merchant cash-out to bank** - corrected 3 Nov: **Circle Mint can't pay
      a merchant's bank** (Mint = MeshPort's own account: USDC ↔ USD to
      MeshPort's own linked bank; its Payouts API sends USDC to addresses).
      Paying merchants from MeshPort's bank would make MeshPort a money
      transmitter (licences). The product for this is **Circle Payments Network
      (CPN)**: MeshPort as an **OFI** → quote (`POST /v1/cpn/quotes`) → payment
      with encrypted beneficiary / travel-rule data (`POST /v1/cpn/payments`) →
      USDC sent on-chain to the beneficiary institution → it pays the merchant's
      bank in local currency → webhooks for status; answer RFIs via the API.
      - [ ] Now (no licence): "Send to your own Mint / exchange deposit address".
      - [ ] **You:** apply to Circle as a CPN OFI; then ~1-2 weeks to build.
      - [ ] Circle Mint (KYB): MeshPort's own fee revenue / treasury to bank.
- [ ] **Earn** (~2-3 days) - "Savings" for businesses: App Kit Earn vaults
      (USDC / EURC on Arc), deposit / withdraw in one signature, live value.
- [ ] **Borrow** (~4-5 days) - USDC against cirBTC with MeshPort's
      **integrator fee**; clear liquidation-risk warnings.
- [ ] Earn / Borrow: compliance check before mainnet.

## 7. Merchant app like PhonePe / Paytm Business (plan agreed 3 Nov)

Principle (from UPI apps): receiving is **free and dead simple** (scan → pay →
hear "received"); revenue comes from everything around it.

Build order:
- [ ] **Voice "payment received"** (~1-2 days) - on each confirmed payment
      (merchant-pay live feed) the app speaks "25 dollars received from Ravi"
      (Web Speech API); settings: on/off, language, volume, only above X.
      Push with a sound when the app is closed (native app can speak it).
- [ ] **Staff notifications** (~2 days) - per-payment push to the owner AND
      staff who opted in (businessTeam.ts roles); roles: cashier (see / receive),
      manager (+ refunds, reports), owner (all).
- [ ] **Pay from any chain** (option 2, ~4-5 days) - pay page: an external
      wallet on Base / Polygon / Ethereum… signs ONE authorization to
      MeshPortRouter with the **merchant's Arc address** as recipient; relayer
      action `order_pay` (only an open order's merchant wallet, amount checked);
      Circle's forwarder mints on Arc (~15-45 s); status "Paid, arriving →
      Received".
- [ ] **Khata reminders by link** (~2-3 days) - "Send reminder" on a credit
      entry (businessKhata.ts): a pay link for the exact amount, shared by
      WhatsApp / SMS / MeshPort chat; paying it settles the entry; optional
      auto-reminders.
- [ ] **Onramp** (see section 6).
- [ ] **Checkout fee line** - after MeshPortCheckout is deployed (section 1).
- [ ] **Cash-out** - now: "send to your exchange / Mint account" (saved
      address, ~1 day); later CPN (section 6).
- [ ] **Premium merchant plan** (~4-5 days) - e.g. $5/month USDC via a capped
      Permit2 allowance (auto-renew, cancel anytime): multiple stores, more
      staff, advanced reports / exports, custom QR, priority instant routes.
- [ ] **Earn / Borrow** (section 6).
- [ ] **Mainnet: intent fillers** (~3-4 days) - Across / Relay quote first
      (~2-12 s to the merchant's Arc balance), CCTP Fast fallback (~40 s);
      later the Commerce Payments Protocol (authorize / capture / refund) for
      refundable e-commerce orders.
- [ ] **Later: soundbox device** - a cheap Wi-Fi speaker listening to one
      merchant's payment feed, or a soundbox partner.
