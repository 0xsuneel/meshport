#!/usr/bin/env bash
# Builds the MPC WebAssembly module and copies it next to its TypeScript
# loader (src/wallet/mpc/). The .wasm is committed so the app and wallet
# frame build without a Rust toolchain; rerun this after changing mpc/ and
# commit both the .wasm and its .sha256.
#
# Needs: rustup target add wasm32-wasip1
set -euo pipefail
cd "$(dirname "$0")"
cargo build --release --locked --target wasm32-wasip1
out=../src/wallet/mpc/meshport_mpc.wasm
cp target/wasm32-wasip1/release/meshport_mpc.wasm "$out"
sha256sum "$out" | cut -d' ' -f1 > "$out.sha256"
echo "built $out ($(wc -c < "$out") bytes, sha256 $(cat "$out.sha256"))"
