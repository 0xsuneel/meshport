# MPC wallet (testnet)

MeshPort's keyless wallet: a 2-of-3 threshold ECDSA key, the same design
class as Binance Wallet's keyless mode. The private key is never assembled:
not at key generation and not when signing.

| Party | Holds | Signs with |
|---|---|---|
| 1 · phone | share in the wallet frame | server (every day), backup (server down) |
| 2 · MeshPort server | share, encrypted at rest | phone, or backup on a new phone |
| 3 · backup | share in the user's Google Drive or passkey-locked | server (new phone) |

Any two parties produce a normal Ethereum signature (low-s, `v` 27/28): chains
and contracts can't tell it from an ordinary wallet. MeshPort alone holds one
share and can't sign.

## Status

**Testnet only.** The protocol library, [0xCarbon DKLs23](https://github.com/0xCarbon/DKLs23)
(Apache-2.0 / MIT), has no published security audit. Before mainnet: audit it
together with this integration, or swap in an audited DKLs-family library
(Coinbase cb-mpc, or Silence Labs DKLs23 under a commercial license). The
message flow in `src/wallet/mpc/protocol.ts` stays the same.

## Pieces

- `mpc/` - Rust crate wrapping DKLs23 as stateless JSON operations
  (`dkg1`..`dkg4`, `sign1`..`sign4`, `share_info`), built to WebAssembly
  (`wasm32-wasip1`). A party's secret working state between rounds goes back
  to the caller, so the server needs no memory between requests.
- `src/wallet/mpc/wasm.ts` - loads the module in the browser or Node with a
  five-function WASI shim (randomness from `crypto.getRandomValues`).
- `src/wallet/mpc/protocol.ts` - one party's side of key generation and
  signing as steps; messages are `{ from, to, kind, body }`.
- `src/wallet/mpc/meshport_mpc.wasm` (+ `.sha256`) - the built module,
  committed so the app builds without Rust. The test checks the hash.
- `src/wallet/mpc/channel.ts` - end-to-end encryption between the wallet
  frame and the signing service. The app page carries the messages (the frame
  has no network) but sees only sealed boxes: per-session ECDH, AES-256-GCM,
  numbered boxes (no replay or reordering). The server signs its session key
  with an identity key the frame has built in (`VITE_WALLET_MPC_SERVER_KEY`),
  so the app page can't pose as the server.
- `src/wallet/mpc/phone.ts` - the phone's side as the frame runs it
  (`PhoneKeygen`, `PhoneSign`): checks the server's identity, refuses to sign
  a hash other than the one it computed, runs every round it can.
- `server/mpc/service.ts` - MeshPort's side (party 2): key generation and
  co-signing. Stateless between requests: round state goes back to the client
  sealed (AES-256-GCM, bound to user + session, 5 minutes); the server share
  is sealed with a separate key bound to user + address.
- `server/mpc/requests.ts` - what MeshPort co-signs: the client sends the
  transaction, message or typed data (never a bare hash), the server hashes
  it itself, testnet chains only, and logs it.
- `api/wallet-mpc.ts` - the HTTP endpoint (Vercel). Not a Supabase Edge
  Function: one key-generation round needs ~1.8 s of CPU, against Edge
  Functions' 2 s cap.
- `supabase/migrations/20261024140000_wallet_mpc.sql` - `wallet_mpc_shares`,
  `wallet_mpc_sign_log` and `wallet_mpc_steps`, service role only. Each
  (session, step) is accepted once: the server is stateless, and re-running
  an MPC round from the same sealed state ("rewinding") could leak its share.

## Configuration (before deploying)

| Where | What |
|---|---|
| Vercel (wallet frame project) | `VITE_WALLET_MPC_SERVER_KEY` - the service's identity public key (POST `{"action":"identity"}` to `/api/wallet-mpc` once `MPC_SECRET` is set). |
| Vercel (app project) | `MPC_SECRET` - 32 random bytes as 64 hex characters. Losing it makes every stored server share unreadable; leaking it alone opens nothing without the database. |
| Supabase | Apply the migration above. |

## HTTP flow

| Step | Requests | Server CPU |
|---|---|---|
| Signup (key generation) | 3: `keygen-begin`, `keygen-step` ×2 | ~1.5 s and ~1.8 s on the two heavy rounds |
| Each signature | 2: `sign-begin`, `sign-step` | ~40-50 ms each |

## Rebuilding the module

```sh
rustup target add wasm32-wasip1
bash mpc/build.sh      # rebuilds, copies the .wasm, rewrites its .sha256
npx vitest run src/wallet/mpc
```

## Measured (WebAssembly in Node, i5-13450HX)

| | Time |
|---|---|
| Key generation, all three parties' work | ~8 s (~2.7 s per party) |
| Signing, two parties | ~20 ms |
| Share size (JSON) | ~300 KB |

Phones are slower; key generation runs once, in the background at signup.
