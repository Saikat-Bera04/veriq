#!/usr/bin/env bash
# Build the browser verifier (backend/crates/verifier-wasm) and put it where it is served from:
#   frontend/sdk/wasm/veriq_verifier.wasm   shipped as veriq-client/verifier.wasm (dashboard, apps)
#   spikes/anon-rpc/verifier_wasm.wasm      the M0 probe page
# Needs: rustup target add wasm32-unknown-unknown. Re-run after changing crates/verifier*.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cargo build --manifest-path "$ROOT/backend/Cargo.toml" -p veriq-verifier-wasm \
  --target wasm32-unknown-unknown --profile wasm-release
OUT="$ROOT/backend/target/wasm32-unknown-unknown/wasm-release/veriq_verifier_wasm.wasm"
mkdir -p "$ROOT/frontend/sdk/wasm"
cp "$OUT" "$ROOT/frontend/sdk/wasm/veriq_verifier.wasm"
cp "$OUT" "$ROOT/spikes/anon-rpc/verifier_wasm.wasm"
echo "veriq_verifier.wasm: $(wc -c <"$OUT" | tr -d ' ') bytes, $(gzip -9 -c "$OUT" | wc -c | tr -d ' ') gzip"
