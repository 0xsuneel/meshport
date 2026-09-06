# MeshPort — USDC Payments on Arc Blockchain

Send USDC as easy as sending a message.

## Quick Start

```bash
npm install
npm run dev
```

Open http://localhost:5173

## Build & Deploy to Vercel

```bash
# 1. Build
npm run build

# 2. Deploy
npm install -g vercel
vercel

# Or connect GitHub repo to Vercel dashboard for auto-deploy
```

## Get Testnet USDC

Visit **https://faucet.circle.com** → select Arc Testnet → paste your wallet address.

## Real Blockchain

MeshPort connects to Arc Testnet (Chain ID: 5042002) using:
- **Circle App Kit SDK** (`@circle-fin/app-kit`) for USDC transfers
- **viem** for wallet operations, balance reads, transaction signing
- **RPC**: `https://rpc.testnet.arc.network`
- **Explorer**: `https://testnet.arcscan.app`
- **USDC Contract**: `0x3600000000000000000000000000000000000000`

## Environment Variables

Copy `.env.example` to `.env` (optional — defaults work out of the box):

```env
VITE_ARC_RPC_URL=https://rpc.testnet.arc.network
VITE_ARC_CHAIN_ID=5042002
VITE_USDC_CONTRACT=0x3600000000000000000000000000000000000000
```

## Architecture

```
src/
├── lib/
│   ├── arc.ts          # BIP39 wallet generation, viem HD derivation
│   ├── arcService.ts   # Real blockchain: getUSDCBalance, sendUSDC
│   └── bip39wordlist.ts
├── hooks/
│   └── useArcWallet.ts # React hook: live balance, send flow
├── features/           # All app screens
├── store/              # Zustand state (auth, wallet, UI)
└── components/         # Shared UI components
```

## Security

- 6-digit passcode mandatory for all accounts
- Passcode required to: Send USDC, Reveal Seed Phrase, Export Private Key
- BIP39 standard wallets — compatible with MetaMask, Trust, OKX, Coinbase
- Keys stored in localStorage (encrypted in production with passcode-derived key)
