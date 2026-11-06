#!/usr/bin/env sh
# Build the raw wasm verifier used by the M0.4 probe and copy it next to the page.
set -eu
cd "$(dirname "$0")"
cargo build \
  --manifest-path ../../backend/Cargo.toml \
  -p veriq-verifier-wasm \
  --target wasm32-unknown-unknown \
  --profile wasm-release
cp ../../backend/target/wasm32-unknown-unknown/wasm-release/veriq_verifier_wasm.wasm ./verifier_wasm.wasm
