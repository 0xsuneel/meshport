#!/usr/bin/env bash
# Builds the MPC WebAssembly module and copies it next to its TypeScript
# loader (src/wallet/mpc/). Its users: the wallet frame (browser) and the
# signing service, api/wallet-mpc.ts (Vercel, Node). The .wasm is committed so
# neither needs a Rust toolchain to build; rerun this after changing mpc/ and
# commit the .wasm and its .sha256 (src/wallet/mpc/mpc.test.ts checks them).
#
# Needs: rustup target add wasm32-wasip1
set -euo pipefail
cd "$(dirname "$0")"
cargo build --release --locked --target wasm32-wasip1
out=../src/wallet/mpc/meshport_mpc.wasm
cp target/wasm32-wasip1/release/meshport_mpc.wasm "$out"
sha256sum "$out" | cut -d' ' -f1 > "$out.sha256"
echo "built $out ($(wc -c < "$out") bytes, sha256 $(cat "$out.sha256"))"
