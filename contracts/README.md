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
- **Constructor args must match the type exactly.** `P2PMeshportEscrowV2`
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
   - RPC: https://rpc.testnet.arc.network
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

# P2PMeshportEscrowV2 Contract Deployment

## Step 1: Compile in Remix IDE

1. Go to https://remix.ethereum.org
2. New file → paste contents of `P2PMeshportEscrowV2.sol`
3. Compiler tab → Solidity 0.8.20 → **EVM: Paris** → Compile
   (this is the step that's easy to miss — see the note above)
4. Copy the compiled bytecode from: Compilation Details → Bytecode → object

## Step 2: Deploy via MetaMask + Remix

1. Deploy & Run tab → Environment: Injected Provider (MetaMask)
2. Connect MetaMask to Arc Testnet:
   - Network Name: Arc Testnet
   - RPC: https://rpc.testnet.arc.network
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
`deploy-p2p-meshport-escrow-v2.cjs` for the full role-bootstrap flow if
deploying via Hardhat instead.

## Step 3: Configure MeshPort

In meshport/.env, set:
```
VITE_P2P_ESCROW_CONTRACT=0xYOUR_DEPLOYED_ADDRESS
```

## Verification

Check on ArcScan:
https://testnet.arcscan.app/address/YOUR_CONTRACT_ADDRESS
