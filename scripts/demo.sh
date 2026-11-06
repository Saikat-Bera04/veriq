#!/usr/bin/env bash
# Start the full Veriq demo locally: demo attacker (:9545), engine (:8547) with the attacker
# as its first provider, and the dashboard (:3000). Ctrl-C stops everything.
# Uses Helios when HELIOS_CONSENSUS_RPC is set, otherwise dev mode (receipts "unverified").
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
TARGET_DIR="${CARGO_TARGET_DIR:-$ROOT/backend/target}"
export CARGO_TARGET_DIR="$TARGET_DIR"
for f in "$ROOT/.env" "$ROOT/../.env"; do
  if [ -f "$f" ]; then set -a; . <(tr -d '\r' <"$f"); set +a; break; fi
done
: "${VERIQ_PROVIDERS:?VERIQ_PROVIDERS is required — copy .env.example to .env (see docs/SERVICES.md)}"
FIRST_URL="${VERIQ_PROVIDERS#*=}"; FIRST_URL="${FIRST_URL%%,*}"

if [ -n "${HELIOS_CONSENSUS_RPC:-}" ]; then
  ROOT_SOURCE=helios; FEATURES="--features helios,demo"; DEV=0
else
  echo "HELIOS_CONSENSUS_RPC not set: starting in DEV MODE (unverified receipts)"
  ROOT_SOURCE=dev-untrusted; FEATURES="--features demo"; DEV=1
fi

cargo build --manifest-path "$ROOT/backend/Cargo.toml" -q -p veriq-server $FEATURES --bin veriq-server
cargo build --manifest-path "$ROOT/backend/Cargo.toml" -q -p veriq-malicious-rpc --features demo

ATTACKER_BIN="$TARGET_DIR/debug/veriq-malicious-rpc"
ENGINE_BIN="$TARGET_DIR/debug/veriq-server"
[[ -x "$ATTACKER_BIN.exe" ]] && ATTACKER_BIN="$ATTACKER_BIN.exe"
[[ -x "$ENGINE_BIN.exe" ]] && ENGINE_BIN="$ENGINE_BIN.exe"

PIDS=()
trap 'kill "${PIDS[@]}" 2>/dev/null || true' EXIT INT TERM

UPSTREAM_RPC="${UPSTREAM_RPC:-${EXEC_RPC:-$FIRST_URL}}" "$ATTACKER_BIN" & PIDS+=($!)
for _ in $(seq 1 50); do curl -s http://127.0.0.1:9545/mode >/dev/null 2>&1 && break; sleep 0.2; done

VERIQ_CONFIG_DIR="$ROOT/backend/config" VERIQ_PROVIDERS="attacker=http://127.0.0.1:9545,$VERIQ_PROVIDERS" VERIQ_ROOT_SOURCE="$ROOT_SOURCE" \
  VERIQ_DEV_ALLOW_UNTRUSTED_ROOT="$DEV" "$ENGINE_BIN" & PIDS+=($!)

pnpm --filter veriq-dashboard dev & PIDS+=($!)
echo
echo "  dashboard  http://localhost:3000/app   (attack lab: /app/attack-lab)"
echo "  engine     http://127.0.0.1:8547/health"
echo "  attacker   http://127.0.0.1:9545/mode"
echo
wait
