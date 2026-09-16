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
