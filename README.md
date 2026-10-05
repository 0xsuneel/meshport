<p align="center">
  <img src="public/favicon.svg" width="96" height="96" alt="MeshPort">
</p>

<h1 align="center">MeshPort</h1>

<p align="center"><b>Pay people, not addresses.</b><br>
Self-custodial USDC payments and private chat, on Arc and 20+ chains.</p>

<p align="center">
  <a href="https://meshport.xyz">Website</a> ·
  <a href="docs/SELF_CUSTODY.md">Self-custody</a> ·
  <a href="docs/CHAT_ENCRYPTION.md">Encrypted chat</a> ·
  <a href="docs/ARCHITECTURE.md">Architecture</a> ·
  <a href="https://x.com/meshport_xyz">X</a>
</p>

> **Arc Testnet only.** Every chain, contract and RPC endpoint here points at a testnet.

---

## What's inside

### 🔐 MeshPort Wallet
A self-custodial wallet you can open with Google or an email code. The key is
generated on your device, unlocked elsewhere with a **passkey** or a
password-sealed **Recovery QR**, and never stored by MeshPort. Create or import
a classic wallet with a recovery phrase if you prefer.
→ [How self-custody works](docs/SELF_CUSTODY.md)

### 💬 Chat & Pay
Message anyone by their `.arc` username and send money in the same thread.
Chats are **end-to-end encrypted**, with every chat key signed by its wallet.
→ [How chat encryption works](docs/CHAT_ENCRYPTION.md)

### 🌐 Multichain Hub
One balance on Arc, reachable from 20+ chains: bring USDC in, send it out,
track every step. Built on Circle Gateway and CCTP V2.

### 🧾 Payment links & merchants
Shareable links (`meshport.xyz/paylink/you?amount=10`) with rich previews,
QR payments, merchant bills, bulk payouts, swaps (USDC · EURC · cirBTC) and P2P
trading with on-chain escrow.

## Self-custody at a glance

```
sign in ─► key made on your device ─► passkey      (Face ID / fingerprint)
                                   └► Recovery QR  (a password only you know)
```

| MeshPort stores | MeshPort never stores |
|---|---|
| Wallet address, username, profile | Private keys or seed phrases |
| Passkey id + passkey-encrypted key | Recovery passwords or QR contents |

## Build

```bash
git clone https://github.com/0xsuneel/meshport.git
cd meshport
npm install
npm run dev          # http://localhost:5173
```

```bash
npm run typecheck    # TypeScript
npm run lint         # ESLint
npm run test         # Vitest
npm run build        # production build
```

You'll need a Supabase project and a `.env` — see
[Local development](docs/ARCHITECTURE.md#local-development).

## Repository map

| Path | What it is |
|---|---|
| [`src/`](src) | React + Vite PWA — wallet, chat, pay, multichain, merchant, P2P |
| [`src/lib/`](src/lib) | Wallet, passkey, Recovery QR and chat crypto; payment logic |
| [`src/blockchain/`](src/blockchain) | Balance readers, RPC providers, chain config |
| [`api/`](api) | Vercel functions — link previews, relayer, profile, push |
| [`supabase/functions/`](supabase/functions) | Edge Functions — claims, ledger, merchant pay, indexer |
| [`supabase/migrations/`](supabase/migrations) | Database schema and row-level security |
| [`contracts/`](contracts) | Solidity — rewards, P2P escrow, bridge router |
| [`docs/`](docs) | Architecture, self-custody, chat encryption, audits |

## Tech

React · TypeScript · Vite · Tailwind · viem · Supabase · Vercel · Circle
Gateway & CCTP V2 · WebAuthn passkeys · Argon2id · X25519 / AES-256-GCM

## Contributing & security

Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).
Please report security issues privately rather than in a public issue.

## License

[MIT](LICENSE)
