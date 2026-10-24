# Wallet frame

MeshPort's wallet keys live in one place: a small page on its own origin,
`wallet.meshport.xyz` (`wallet-frame/`), embedded in the app as a hidden
iframe. The app (`meshport.xyz`) never holds a private key or a recovery
phrase. It holds an address and a signer that asks the frame to sign.

This is the same split Privy's embedded wallets use (`auth.privy.io`).

```
 meshport.xyz (app)                                wallet.meshport.xyz (frame)
 ┌──────────────────────────────┐   postMessage    ┌────────────────────────────────┐
 │ src/wallet/                  │ ───────────────► │ wallet-frame/src/main.ts       │
 │  frameClient.ts  (transport) │                  │  - checks origin + parent      │
 │  account.ts      (signer)    │ ◄─────────────── │  - signs, returns signature    │
 │  index.ts        (API)       │  results only    │ wallet-frame/src/vault.ts      │
 │ store: signer = WalletAccount│                  │  - keys: memory + frame storage│
 └──────────────────────────────┘                  └────────────────────────────────┘
          ▲  visible iframe (reveal.html#t=<ticket>)        │ BroadcastChannel
          └───────────── phrase / key shown by the frame ◄──┘ (same origin only)
```

The browser keeps the two origins apart. Code running in the app, whether
its own, a dependency, or an injected script, can't read the frame's
memory, `localStorage`, `sessionStorage` or IndexedDB.

## What the app can ask

`src/wallet/protocol.ts` is the whole contract. No request returns key
material:

| Request | Returns |
|---|---|
| `create`, `import`, `adopt` | address |
| `unlock`, `status` | booleans, counts, lockout ms |
| `sign:message`, `sign:typed-data`, `sign:transaction` | signature / signed bytes |
| `passkey:wrap` | ciphertext to store (the frame encrypts) |
| `passkey:open`, `recovery:open` | ok (the key stays in the frame) |
| `recovery:create` | the Recovery QR payload (encrypted) |
| `mnemonic:check` | ok + wrong word positions (never the words) |
| `chat:seed` | the chat identity seed, a separate, domain-separated key |
| `reveal:grant` | a one-time ticket for `reveal.html` |

Secrets are shown only by `wallet-frame/reveal.html` inside a visible
iframe (`components/wallet/WalletSecretFrame.tsx`). It redeems a two-minute,
single-use ticket from the hidden frame over a same-origin
`BroadcastChannel`. Copy-to-clipboard happens inside the frame too.

## Boundary checks

- **Frame**: answers only messages whose `origin` is listed in
  `VITE_WALLET_PARENT_ORIGINS` and whose `source` is its own `window.parent`.
  It replies to that exact origin, never `'*'`. Unknown methods, including
  prototype names, are refused.
- **App**: accepts replies only from `VITE_WALLET_ORIGIN` and from that
  iframe's own `contentWindow`.
- **Frame hosting** (`wallet-frame/vercel.json`): `frame-ancestors` lists the
  app's origins, and `connect-src 'none'` means the frame can't make network
  requests at all, so a compromised dependency inside it has no fetch/XHR to
  exfiltrate with. Also `img-src 'none'`, `form-action 'none'`,
  `base-uri 'none'` and `Referrer-Policy: no-referrer`.
- **App CSP** (`vercel.json`): `frame-src 'self' https://wallet.meshport.xyz`.

## Storage inside the frame (`vault.ts`)

| Copy | Where | Protection |
|---|---|---|
| Open key | memory | dropped on lock / logout / reload |
| Session copy | frame `sessionStorage` | sealed with the frame origin's non-extractable AES key |
| Device copy (Google / email) | frame `localStorage` | sealed the same way; deleted on logout |
| Passcode copy (create / import) | frame `localStorage` | PBKDF2-SHA256 600k → AES-GCM, then device-sealed |
| Recovery phrase | frame `localStorage` | same as the passcode copy |

Passcode guessing is limited **in the frame** (5 free tries, then 30 s
doubling up to 1 h), because a script in the app could otherwise call
`unlock` in a loop.

The formats are the app's existing ones (`lib/security.ts`,
`lib/passkeyWrap.ts`, `lib/recoveryQr.ts`). Passkey rows already on the
server and Recovery QRs made before this change still open.

## Signers

- **viem**: `walletAccount(address)` is a `LocalAccount`. Use it anywhere
  viem takes an account. Only plain transaction fields are posted to the
  frame.
- **ethers**: `toEthersSigner(account)`, an `AbstractSigner`, produces
  byte-identical output to `ethers.Wallet` (`src/wallet/account.test.ts`).
- **Circle App Kit**: `createWalletAdapter({ account, getProvider })` is the
  drop-in for `createEthersAdapterFromPrivateKey`. It subclasses
  `EthersAdapter.switchToChain` so the signer re-attaches to *your*
  `getProvider` result (relayed providers, Arc forwarders) the way a
  `Wallet` does. It relies on `adapter-ethers-v6` 1.9.x internals
  (`_signer`); re-check on upgrade.

## Moving existing users (`migrateLegacyKey`)

Before the frame, the app kept a session copy, a social device copy and
passcode copies on its own origin. On first open, `restoreWallet.ts`
decrypts whatever is there (with the passcode when needed), hands it to the
frame once (`adopt`), and deletes the app-side copy. A legacy passcode copy
is deleted only after the frame holds a passcode copy too, so no session
can end with the wallet unopenable.

## Development

```
npm run dev          # app on http://localhost:5173
npm run dev:wallet   # frame on http://localhost:5174
```

Both have dev defaults, so no env vars are needed locally.

## Deployment

A **second Vercel project** on the same repo:

- Root Directory: `wallet-frame` (its `vercel.json` builds with
  `cd .. && npm run build:wallet`, output `dist`).
- Domain: `wallet.meshport.xyz`. It must be a subdomain of the app's site
  (same-site, so its storage is first-party, not partitioned or capped like
  third-party storage).
- Env: `VITE_WALLET_PARENT_ORIGINS=https://meshport.xyz,https://www.meshport.xyz`.
  The app project needs `VITE_WALLET_ORIGIN=https://wallet.meshport.xyz`.

Deploy the frame **before** the app. An app build without a reachable frame
can't open any wallet.

## Known limits (Phase 1)

- The passcode, a typed seed phrase / key (import) and the Recovery QR
  password are still typed into the app's UI and passed to the frame. A
  script running in the app at that moment could capture them. Phase 3 moves
  these inputs into frame-rendered UI.
- A script running in the app can still *ask* the frame to sign while the
  wallet is open (as with Privy). What it can't do is copy the key out and
  use it later or elsewhere. Phase 3 adds per-action confirmation shown by
  the frame.
- The WebAuthn ceremony runs in the app (the passkey's RP ID is the app
  domain); only the PRF output reaches the frame.
