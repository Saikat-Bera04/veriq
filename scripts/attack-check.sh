#!/usr/bin/env bash
# Attack check: drive every demo-attacker mode and check what the engine does with it.
#
# 1. Proxy: each mode really forges what it claims (balance +1000 ETH, a broken proof node,
#    an older block, HTTP 503, nonce + 1, altered contract code).
# 2. Engine: with the attacker as the FIRST provider and an honest one behind it, every
#    forgery ends in INVALID_PROOF for the attacker (outage: transport failure) and the
#    honest proven value is returned; a forged value is never returned, and no receipt
#    claims "verified" without a trusted root.
#
# Uses Helios when HELIOS_CONSENSUS_RPC is set (receipts "verified"), otherwise dev mode
# (root from the first provider, receipts "unverified"). Reads .env from Veriq/ or the repo
# root. Never prints secret values.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
for f in "$ROOT_DIR/.env" "$ROOT_DIR/../.env"; do
  if [ -f "$f" ]; then set -a; . <(tr -d '\r' <"$f"); set +a; break; fi
done
TARGET_DIR="${CARGO_TARGET_DIR:-$ROOT_DIR/backend/target}"
export CARGO_TARGET_DIR="$TARGET_DIR"
ATTACKER="http://127.0.0.1:9545"
ENGINE="http://127.0.0.1:8547"
ADDRESS="${VERIQ_DEMO_ADDRESS:-0xc497315eddf22eb53b7a2bcaa5edc23ab22d6558}"
# Code reads use the demo contract when there is one (an account without code works too).
CODE_TARGET="${VERIQ_DEMO_CONTRACT:-$ADDRESS}"
: "${VERIQ_PROVIDERS:?VERIQ_PROVIDERS is required — copy .env.example to .env (see docs/SERVICES.md)}"
FIRST_URL="${VERIQ_PROVIDERS#*=}"; FIRST_URL="${FIRST_URL%%,*}"
UPSTREAM_RPC="${UPSTREAM_RPC:-${EXEC_RPC:-$FIRST_URL}}"
HONEST_RPC="${VERIQ_HONEST_RPC:-$UPSTREAM_RPC}"

if [[ -z "$UPSTREAM_RPC" ]]; then
  echo "Set UPSTREAM_RPC (or VERIQ_PROVIDERS) to an HTTP(S) Sepolia JSON-RPC endpoint." >&2
  exit 2
fi
# The honest provider is what every forgery must fail over to: it has to be a real, separate endpoint.
case "$HONEST_RPC" in
  http://*|https://*) ;;
  *) echo "VERIQ_HONEST_RPC (default: UPSTREAM_RPC) must be an http(s) Sepolia endpoint" >&2; exit 2 ;;
esac
case "$HONEST_RPC" in
  *127.0.0.1:9545*|*localhost:9545*) echo "the honest provider cannot be the demo attacker ($ATTACKER)" >&2; exit 2 ;;
esac
for command in cargo curl python3; do
  command -v "$command" >/dev/null 2>&1 || { echo "Required command not found: $command" >&2; exit 2; }
done
for port in 8547 9545; do
  if (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then
    echo "port $port is busy — stop the running engine/attacker first" >&2; exit 2
  fi
done

# Root source: --helios / --dev (or VERIQ_CHECK_ROOT=helios|dev); default helios when
# HELIOS_CONSENSUS_RPC is set. An explicit choice wins over .env.
CHECK_ROOT="${VERIQ_CHECK_ROOT:-}"
for arg in "$@"; do
  case "$arg" in
    --dev) CHECK_ROOT=dev ;; --helios) CHECK_ROOT=helios ;; --) ;;
    *) echo "unknown argument: $arg (use --helios or --dev)" >&2; exit 2 ;;
  esac
done
[[ -n "$CHECK_ROOT" ]] || { [[ -n "${HELIOS_CONSENSUS_RPC:-}" ]] && CHECK_ROOT=helios || CHECK_ROOT=dev; }
case "$CHECK_ROOT" in
  helios)
    : "${HELIOS_CONSENSUS_RPC:?--helios needs HELIOS_CONSENSUS_RPC (see .env.example)}"
    ROOT_SOURCE=helios; FEATURES="helios,demo"; EXPECT_STATUS=verified ;;
  dev) ROOT_SOURCE=dev-untrusted; FEATURES="demo"; EXPECT_STATUS=unverified ;;
  *) echo "VERIQ_CHECK_ROOT must be helios or dev" >&2; exit 2 ;;
esac

PASS=0; FAIL=0
ok()  { PASS=$((PASS + 1)); printf '  PASS %s\n' "$*"; }
bad() { FAIL=$((FAIL + 1)); printf '  FAIL %s\n' "$*"; }

temp_dir="$(mktemp -d)"
pids=()
cleanup() { for pid in "${pids[@]:-}"; do [[ -n "$pid" ]] && kill "$pid" 2>/dev/null || true; done; rm -rf "$temp_dir"; }
trap cleanup EXIT

echo "build (root source: $ROOT_SOURCE)"
cargo build --manifest-path "$ROOT_DIR/backend/Cargo.toml" -q -p veriq-malicious-rpc --features demo
cargo build --manifest-path "$ROOT_DIR/backend/Cargo.toml" -q -p veriq-server --features "$FEATURES" --bin veriq-server
attacker_bin="$TARGET_DIR/debug/veriq-malicious-rpc"; [[ -x "$attacker_bin.exe" ]] && attacker_bin="$attacker_bin.exe"
engine_bin="$TARGET_DIR/debug/veriq-server"; [[ -x "$engine_bin.exe" ]] && engine_bin="$engine_bin.exe"

UPSTREAM_RPC="$UPSTREAM_RPC" MALICIOUS_RPC_BIND=127.0.0.1:9545 "$attacker_bin" >"$temp_dir/attacker.log" 2>&1 &
pids+=($!)
for _ in $(seq 1 50); do curl -s "$ATTACKER/mode" >/dev/null 2>&1 && break; sleep 0.2; done
curl -sf "$ATTACKER/mode" >/dev/null || { echo "attacker did not start" >&2; exit 1; }

# The startup probe needs the attacker honest ('off'), or it is excluded before any attack.
curl -s -X POST "$ATTACKER/mode" -H 'content-type: application/json' -d '{"mode":"off"}' >/dev/null
# Dev mode: the root comes from the honest provider, never from the attacker listed first.
VERIQ_CONFIG_DIR="$ROOT_DIR/backend/config" VERIQ_ROOT_SOURCE="$ROOT_SOURCE" \
  VERIQ_PROVIDERS="attacker=$ATTACKER,honest=$HONEST_RPC" \
  VERIQ_DEV_ALLOW_UNTRUSTED_ROOT=$([[ "$ROOT_SOURCE" == dev-untrusted ]] && echo 1 || echo 0) \
  VERIQ_DEV_ROOT_RPC="$([[ "$ROOT_SOURCE" == dev-untrusted ]] && echo "$HONEST_RPC")" \
  "$engine_bin" >"$temp_dir/engine.log" 2>&1 &
pids+=($!)
for _ in $(seq 1 90); do
  [[ "$(curl -s "$ENGINE/health" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("status"))' 2>/dev/null)" == ok ]] && break
  sleep 2
done
[[ "$(curl -s "$ENGINE/health" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("status"))' 2>/dev/null)" == ok ]] ||
  { echo "engine did not become healthy (see the root source above)" >&2; exit 1; }
# Refuse to run without a usable honest provider: then no read could succeed and the check would prove nothing.
# The startup probe can still be running when /health first says ok (dev roots are ready at once).
honest_ok=False
for _ in $(seq 1 30); do
  honest_ok="$(curl -s "$ENGINE/health" | python3 -c '
import json,sys
print(any(p["name"] == "honest" and p["chainOk"] and p["proofSupport"] for p in json.load(sys.stdin)["providers"]))' 2>/dev/null)"
  [[ "$honest_ok" == True ]] && break
  sleep 1
done
[[ "$honest_ok" == True ]] ||
  { echo "the honest provider failed the startup probe (needs Sepolia + eth_getProof at finalized)" >&2; exit 1; }
echo "honest provider: Sepolia + eth_getProof OK"

# One JSON-RPC call; prints the response body with its HTTP status added as "httpStatus".
call() { # url method params
  local body
  body="$(curl -s -w '\n%{http_code}' "$1" -H 'content-type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$2\",\"params\":$3}")" || true
  local code="${body##*$'\n'}"; body="${body%$'\n'*}"
  python3 -c '
import json,sys
try:
    d=json.loads(sys.argv[1])
except ValueError:
    d={}
if not isinstance(d, dict):
    d={"body": d}
d["httpStatus"]=int(sys.argv[2])
print(json.dumps(d))' "$body" "$code"
}
py() { python3 -c "import json,sys; d=json.loads(sys.argv[2]); print(eval(sys.argv[1]))" "$@"; }

# What the attacker claims for each read, per mode (the proxy side of the check).
claims() { # -> JSON {balance, proofNonce, proofNode, txCount, code, httpStatus}
  local proof count code
  proof="$(call "$ATTACKER" eth_getProof "[\"$ADDRESS\",[],\"finalized\"]")"
  count="$(call "$ATTACKER" eth_getTransactionCount "[\"$ADDRESS\",\"finalized\"]")"
  code="$(call "$ATTACKER" eth_getCode "[\"$CODE_TARGET\",\"finalized\"]")"
  python3 -c '
import json,sys
p,c,k=(json.loads(a) for a in sys.argv[1:4])
r=p.get("result") or {}
print(json.dumps({"balance": r.get("balance"), "proofNonce": r.get("nonce"), "proofNode": (r.get("accountProof") or [None])[0],
  "txCount": c.get("result"), "code": k.get("result"), "httpStatus": p["httpStatus"]}))' "$proof" "$count" "$code"
}

# The engine's answer for a read: value, attacker outcome, status, root source, block.
engine_read() { # kind -> JSON
  local r
  case "$1" in
    balance) r="$(call "$ENGINE" veriq_readBalance "[\"$ADDRESS\"]")" ;;
    nonce) r="$(call "$ENGINE" eth_getTransactionCount "[\"$ADDRESS\",\"finalized\"]")" ;;
    code) r="$(call "$ENGINE" eth_getCode "[\"$CODE_TARGET\",\"finalized\"]")" ;;
  esac
  python3 -c '
import json,sys
d=json.loads(sys.argv[1])
if "error" in d:
    print(json.dumps({"error": d["error"]["code"]})); sys.exit()
res=d["result"]
rec=d.get("veriq") or res.get("receipt")
value=res["value"] if isinstance(res, dict) else res
att=[a["outcome"] for a in rec["routing"]["attempts"] if a["provider"]=="attacker"]
print(json.dumps({"value": value, "attacker": att[0] if att else "skipped", "status": rec["verification"]["status"],
  "rootSource": rec["verification"]["rootSource"], "block": rec["block"]["number"]}))' "$r"
}

reset_breakers() { curl -s -X POST "$ENGINE/admin/reset-breakers" >/dev/null; }

echo
echo "attacker: $ATTACKER (first provider) · honest provider behind it · engine root: $ROOT_SOURCE"
curl -s -X POST "$ATTACKER/mode" -H 'content-type: application/json' -d '{"mode":"off"}' >/dev/null
reset_breakers
BASE="$(claims)"
declare -A HONEST
for kind in balance nonce code; do HONEST[$kind]="$(engine_read "$kind")"; done
echo "honest claims: $(py '"balance=%s nonce=%s code=%d bytes" % (d["balance"], d["proofNonce"], max(len(d["code"] or "0x") // 2 - 1, 0))' "$BASE")"

# mode -> reads to check, and what the attacker's attempt must be.
declare -A READS=([value]="balance" [proof]="balance nonce code" [wrongblock]="balance" [outage]="balance" [nonce]="nonce balance" [code]="code")
for mode in value proof wrongblock outage nonce code; do
  echo
  echo "mode=$mode"
  curl -s -X POST "$ATTACKER/mode" -H 'content-type: application/json' -d "{\"mode\":\"$mode\"}" >/dev/null
  C="$(claims)"

  # 1. the proxy forges what the mode says
  case "$mode" in
    value) py 'int(d["balance"],16) == int(json.loads(sys.argv[3])["balance"],16) + 1000*10**18' "$C" "$BASE" | grep -q True \
             && ok "proxy: balance claim is +1000 ETH" || bad "proxy: value mode did not add 1000 ETH" ;;
    proof) [[ "$(py 'd["proofNode"]' "$C")" == 0x01 ]] && ok "proxy: proof node replaced with an invalid one" || bad "proxy: proof not corrupted" ;;
    wrongblock) ok "proxy: forwards eth_getProof for an older block (checked by the engine below)" ;;
    outage) [[ "$(py 'd["httpStatus"]' "$C")" == 503 ]] && ok "proxy: HTTP 503" || bad "proxy: outage did not answer 503" ;;
    nonce) py 'int(d["proofNonce"],16) == int(json.loads(sys.argv[3])["proofNonce"],16) + 1 and int(d["txCount"],16) == int(json.loads(sys.argv[3])["txCount"],16) + 1' "$C" "$BASE" | grep -q True \
             && ok "proxy: nonce claim is +1 in eth_getProof and eth_getTransactionCount" || bad "proxy: nonce not forged" ;;
    code) py 'd["code"] != json.loads(sys.argv[3])["code"] and json.loads(sys.argv[3])["proofNonce"] == d["proofNonce"]' "$C" "$BASE" | grep -q True \
             && ok "proxy: eth_getCode returns altered code (proof left honest)" || bad "proxy: code not forged" ;;
  esac

  # 2. the engine rejects the forgery and returns the honest proven value
  expect=invalid-proof; [[ "$mode" == outage ]] && expect=transport-failure
  for kind in ${READS[$mode]}; do
    reset_breakers
    R="$(engine_read "$kind")"
    H="${HONEST[$kind]}"
    summary="$(py '"value=%s attacker=%s status=%s root=%s block=%s" % (str(d.get("value"))[:20], d.get("attacker"), d.get("status"), d.get("rootSource"), d.get("block")) if "error" not in d else "error %s" % d["error"]' "$R")"
    echo "    $kind: $summary"
    if [[ "$(py '"error" in d' "$R")" == True ]]; then bad "$mode/$kind: engine error $(py 'd["error"]' "$R")"; continue; fi
    [[ "$(py 'd["attacker"]' "$R")" == "$expect" ]] && ok "$mode/$kind: attacker attempt is $expect" \
      || bad "$mode/$kind: attacker attempt was $(py 'd["attacker"]' "$R"), expected $expect"
    # Never "verified" without a trusted root, and always the status this root source gives.
    if [[ "$(py 'd["status"] == "verified" and d["rootSource"] not in ("local-light-client", "fixture")' "$R")" == True ]]; then
      bad "$mode/$kind: receipt says verified with root source $(py 'd["rootSource"]' "$R")"
    elif [[ "$(py 'd["status"]' "$R")" != "$EXPECT_STATUS" ]]; then
      bad "$mode/$kind: status $(py 'd["status"]' "$R"), expected $EXPECT_STATUS"
    fi
    if [[ "$(py 'd["block"]' "$R")" == "$(py 'd["block"]' "$H")" ]]; then
      [[ "$(py 'str(d["value"]).lower()' "$R")" == "$(py 'str(d["value"]).lower()' "$H")" ]] \
        && ok "$mode/$kind: honest proven value returned" || bad "$mode/$kind: value differs from the honest one"
    else
      ok "$mode/$kind: (finalized block moved; value not compared)"
      HONEST[$kind]="$R"
    fi
  done
done
curl -s -X POST "$ATTACKER/mode" -H 'content-type: application/json' -d '{"mode":"off"}' >/dev/null

echo
echo "result: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
