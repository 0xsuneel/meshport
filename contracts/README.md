# MeshPort Contracts — Deployment

## Why "not deployable" usually happens on Remix

Both contracts compile cleanly with no errors — if Remix's Deploy button
isn't working, the near-certain cause is the **EVM version dropdown**, not
the Solidity code. **Arc Testnet's execution client does not support the
`PUSH0` opcode**, and solc `0.8.20` emits `PUSH0` by default (its default
`evmVersion` is `shanghai`). A contract compiled with the default setting
compiles fine in Remix but reverts/fails at the deploy transaction on Arc.
Hardhat's `solidity.settings.evmVersion` in `hardhat.config.cjs` is now
pinned to `paris` for this reason — Remix has no config file, so you must
set the dropdown by hand every time, for **both** contracts below:

> Compiler tab → **EVM VERSION: paris** (not "default", not shanghai/cancun/prague)

If you ever see a deploy that fails instantly with no revert reason, or
MetaMask shows the transaction failing during gas estimation, check this
dropdown first before assuming the contract itself is broken.

Two other things worth checking if a deploy still fails after fixing EVM version:
- **Constructor args must match the type exactly.** `P2PMeshportEscrowV3`
  takes `address[3]` — in Remix's deploy widget this is one field taking a
  JSON array, e.g. `["0xAAA...","0xBBB...","0xCCC..."]`, not three separate
  fields.
- **Unpinned OpenZeppelin imports.** `import "@openzeppelin/contracts/..."`
  with no version tag lets Remix resolve whatever the latest published
  version is. This repo is pinned to `@openzeppelin/contracts@5.6.1` in
  `package.json`; if Remix's import ever resolves to a different major
  version, file paths like `utils/ReentrancyGuard.sol` can 404. If compilation
  itself fails (not just deployment), pin the import explicitly:
  `import "@openzeppelin/contracts@5.6.1/utils/ReentrancyGuard.sol";`

---

# MeshPortRewards Contract Deployment

## Step 1: Compile in Remix IDE

1. Go to https://remix.ethereum.org
2. New file → paste contents of `MeshPortRewards.sol`
3. Compiler tab → Solidity 0.8.20 → EVM: Paris → Compile
4. Copy the compiled bytecode from: Compilation Details → Bytecode → object

## Step 2: Deploy via MetaMask + Remix

1. Deploy & Run tab → Environment: Injected Provider (MetaMask)
2. Connect MetaMask to Arc Testnet:
   - Network Name: Arc Testnet
   - RPC: https://rpc.testnet.arc.io
   - Chain ID: 5042002
   - Currency: USDC
3. Set constructor arg: `_usdcToken` = `0x3600000000000000000000000000000000000000`
4. Click Deploy
5. Confirm in MetaMask
6. Copy deployed contract address from Remix console

## Step 3: Configure MeshPort

In meshport/.env, set:
```
VITE_REWARDS_CONTRACT=0xYOUR_DEPLOYED_ADDRESS
```

## Step 4: Fund Treasury

Send USDC to the deployed contract address from your admin wallet.

1000 points = 0.50 USDC
100 users claiming 1000 pts each = 50 USDC needed

## Verification

Check on ArcScan:
https://testnet.arcscan.app/address/YOUR_CONTRACT_ADDRESS

Call `treasuryBalance()` to see funded USDC.

---

# P2PMeshportEscrowV3 Contract Deployment

## Step 1: Compile in Remix IDE

1. Go to https://remix.ethereum.org
2. New file → paste contents of `P2PMeshportEscrowV3.sol`
3. Compiler tab → Solidity 0.8.20 → **EVM: Paris** → Compile
   (this is the step that's easy to miss — see the note above)
4. Copy the compiled bytecode from: Compilation Details → Bytecode → object

## Step 2: Deploy via MetaMask + Remix

1. Deploy & Run tab → Environment: Injected Provider (MetaMask)
2. Connect MetaMask to Arc Testnet:
   - Network Name: Arc Testnet
   - RPC: https://rpc.testnet.arc.io
   - Chain ID: 5042002
   - Currency: USDC
3. Set constructor arg `_roleManagerSigners` (type `address[3]`) as a single
   JSON array of three **distinct**, non-zero addresses, none of which is
   the deploying wallet:
   `["0xROLE_MANAGER_1","0xROLE_MANAGER_2","0xROLE_MANAGER_3"]`
4. Click Deploy
5. Confirm in MetaMask
6. Copy deployed contract address from Remix console

The contract starts with **zero Pausers/Investigators** — nothing is
auto-granted to the deployer. The three role manager signers must submit
and confirm (2-of-3) the first `AddPauser`/`AddInvestigator` proposals
themselves after deployment. See the contract's own header comment and
`deploy-p2p-meshport-escrow-v3.cjs` for the full role-bootstrap flow if
deploying via Hardhat instead.

## Step 3: Configure MeshPort

In meshport/.env, set:
```
VITE_P2P_ESCROW_CONTRACT=0xYOUR_DEPLOYED_ADDRESS
```

## Verification

Check on ArcScan:
https://testnet.arcscan.app/address/YOUR_CONTRACT_ADDRESS

---

# MeshPortRouter (gasless Bring: USDC, EURC, cirBTC)

One contract, one address on every chain (CREATE2), no owner. The user signs
once; MeshPort's relayer submits it and pays the source-chain gas; MeshPort's
fee is taken in the coin being moved, in the same transaction.

- **USDC** — EIP-3009 → Circle CCTP V2 `depositForBurnWithHook` (Circle's
  forwarder mints on Arc; Circle's fee comes out of the burn).
- **EURC / cirBTC** — EIP-3009, or EIP-2612 permit + a bridge signature →
  Circle CCTPx `crossChainTransfer`. Circle's fee is native coin, paid by the
  relayer as `msg.value`. On a chain without CCTPx only USDC works.

1. Deploy (uses `ADMIN_PRIVATE_KEY`, `FEE_RECIPIENT` from `.env`):

       node contracts/deploy-router-all.cjs --dry-run
       node contracts/deploy-router-all.cjs

   Each line says whether that chain gets USDC only or USDC + EURC/cirBTC.
2. Set the printed JSON in Vercel (Production + Preview) as **both**
   `VITE_BRIDGE_ROUTERS` and `BRIDGE_ROUTERS`, then redeploy. This replaces the
   old USDC-only router address.
3. Keep the relayer wallet (`BRIDGE_RELAYER_PRIVATE_KEY`) funded with native
   gas on those chains — it also pays Circle's CCTPx fee for EURC / cirBTC.
4. Optional server env: `CCTPX_IRIS` (default Circle's sandbox),
   `BRIDGE_EURC_USD`, `BRIDGE_CIRBTC_USD` (rough prices used to turn the
   native cost into the token fee), `BRIDGE_TOKEN_MAX_FEE_USD` (cap, default 0.50).

Tests: `npx hardhat test test/MeshPortRouter.test.js test/MeshPortRouter.tokens.test.js`.

## On Arc: Transfer USDC out of Arc in one signature

The same router, at the same address, deployed on Arc lets **Transfer USDC**
(Arc → another chain) use one signature instead of an approve + a burn, and
leaves **no approval** with Circle's TokenMessengerV2. The user signs one
EIP-3009 authorization for exactly amount + fee; MeshPort's relayer submits
`bridgeWithAuthorization` (`api/bridge-relay.ts`, action `arc_transfer`); the
router pulls exactly that, approves exactly the amount, burns it and resets
the approval to 0 - all in one transaction. The fee is the relayer's Arc gas
(paid in USDC).

1. Fund the deploy wallet with a little USDC on Arc testnet (Arc's gas), then:

       node contracts/deploy-router-all.cjs --dry-run --chains=Arc_Testnet
       node contracts/deploy-router-all.cjs --chains=Arc_Testnet

   Use the **same** `FEE_RECIPIENT` as for the other chains - it is part of
   the address. The dry run checks Arc's chain id, TokenMessengerV2, USDC's
   EIP-3009 support and the CREATE2 deployer (all present on Arc, 3 Nov).
2. Set the two printed values in Vercel (Production + Preview), then redeploy:
   `VITE_ARC_ROUTER` (app) and `ARC_ROUTER` (relayer).
3. Keep the relayer wallet funded with USDC on Arc (its gas; the user's fee
   pays it back).
4. Test with a small Transfer (≥ 1 USDC). If anything in the router call
   fails, the whole transaction reverts and nothing moves.

Until `VITE_ARC_ROUTER` is set, Transfer USDC uses the approve + burn path.

# MeshPortCheckout (merchant order payments, MeshPort's merchant fee)

`contracts/MeshPortCheckout.sol` - an **order payment** (a pay link / QR
request with an order) on Arc: the customer pays the full price to the
contract, which in the same transaction sends the merchant the price minus
MeshPort's fee (0.6%, cap $3 - computed by the contract, can't be skipped)
and the fee to MeshPort's relayer wallet. No owner, no upgrade, keeps no
money. **Plain Pay and plain receives are never charged** - only order
payments go through it.

1. Fund the deploy wallet with a little USDC on Arc testnet, then:

       FEE_RECIPIENT=<relayer wallet address> node contracts/deploy-checkout.cjs --dry-run
       FEE_RECIPIENT=<relayer wallet address> node contracts/deploy-checkout.cjs

   Optional: `CHECKOUT_FEE_BPS` (default 60), `CHECKOUT_FEE_CAP` (USD, default 3).
2. Set the printed address as `VITE_MESHPORT_CHECKOUT` (Vercel, Production +
   Preview) and `MESHPORT_CHECKOUT` (Supabase Edge Function secrets), then
   redeploy the app and the `merchant-pay` function.
3. Test with a small order. Until `VITE_MESHPORT_CHECKOUT` is set, orders are
   paid through Arc's Memo contract as before (no fee).

Tests: `node contracts/compile-solcjs.cjs MeshPortCheckout.sol test-helpers/RevertingReceiver.sol && npx hardhat test --no-compile test/MeshPortCheckout.test.js`
