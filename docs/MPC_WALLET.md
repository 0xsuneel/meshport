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
- `src/wallet/mpc/wasm.ts` - loads the module in the browser or Deno with a
  five-function WASI shim (randomness from `crypto.getRandomValues`).
- `src/wallet/mpc/protocol.ts` - one party's side of key generation and
  signing as steps; messages are `{ from, to, kind, body }`.
- `src/wallet/mpc/meshport_mpc.wasm` (+ `.sha256`) - the built module,
  committed so the app builds without Rust. The test checks the hash.

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
