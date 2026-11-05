#!/usr/bin/env bash
# End-to-end check of the whole Veriq demo, against real Sepolia providers.
#
# Starts the demo attacker (127.0.0.1:9545) and the engine (127.0.0.1:8547) with the
# attacker as the FIRST provider and your VERIQ_PROVIDERS behind it, then checks:
#   verified balance read · DemoStorage slot 0 = 42, balances[deployer] = 7, code = compiled · every verified read type (balance, nonce,
#   code, storage, an unused slot, an absent account) at one pinned block · attacker modes
#   value/outage/proof/wrongblock/nonce/code all end in the honest proven value at one block ·
#   latest+required -> -32014 · the SDK CLI prints the receipt box.
# Uses Helios when HELIOS_CONSENSUS_RPC is set, otherwise dev mode (receipts "unverified").
# Reads .env from Veriq/ or the repo root. Never prints secret values.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
TARGET_DIR="${CARGO_TARGET_DIR:-$ROOT/backend/target}"
export CARGO_TARGET_DIR="$TARGET_DIR"
for f in "$ROOT/.env" "$ROOT/../.env"; do
  if [ -f "$f" ]; then set -a; . <(tr -d '\r' <"$f"); set +a; break; fi
done

ENGINE="http://127.0.0.1:8547"
ATTACKER="http://127.0.0.1:9545"
ADDRESS="${VERIQ_DEMO_ADDRESS:-0xc497315eddf22eb53b7a2bcaa5edc23ab22d6558}"
: "${VERIQ_PROVIDERS:?VERIQ_PROVIDERS is required (label=url,label=url) — see .env.example}"
FIRST_URL="${VERIQ_PROVIDERS#*=}"; FIRST_URL="${FIRST_URL%%,*}"
UPSTREAM="${UPSTREAM_RPC:-${EXEC_RPC:-$FIRST_URL}}"

PASS=0; FAIL=0; SKIP=0
ok()   { PASS=$((PASS + 1)); printf '  \033[32mPASS\033[0m %s\n' "$*"; }
bad()  { FAIL=$((FAIL + 1)); printf '  \033[31mFAIL\033[0m %s\n' "$*"; }
skip() { SKIP=$((SKIP + 1)); printf '  \033[33mSKIP\033[0m %s\n' "$*"; }
step() { printf '\n\033[1m%s\033[0m\n' "$*"; }

PIDS=()
cleanup() { for pid in "${PIDS[@]:-}"; do [ -n "$pid" ] && kill "$pid" 2>/dev/null || true; done; }
trap cleanup EXIT

for port in 8547 9545; do
  if lsof -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
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
[ -n "$CHECK_ROOT" ] || { [ -n "${HELIOS_CONSENSUS_RPC:-}" ] && CHECK_ROOT=helios || CHECK_ROOT=dev; }
case "$CHECK_ROOT" in
  helios)
    : "${HELIOS_CONSENSUS_RPC:?--helios needs HELIOS_CONSENSUS_RPC (see .env.example)}"
    ROOT_SOURCE=helios; FEATURES="--features helios,demo"; EXPECT_STATUS=verified ;;
  dev) ROOT_SOURCE=dev-untrusted; FEATURES="--features demo"; EXPECT_STATUS=unverified ;;
  *) echo "VERIQ_CHECK_ROOT must be helios or dev" >&2; exit 2 ;;
esac

step "build (root source: $ROOT_SOURCE)"
cargo build --manifest-path "$ROOT/backend/Cargo.toml" -q -p veriq-server $FEATURES --bin veriq-server
cargo build --manifest-path "$ROOT/backend/Cargo.toml" -q -p veriq-malicious-rpc --features demo
# Build the SDK CLI if missing. A failure here is reported by the "SDK CLI" step.
[ -f frontend/sdk/dist/bin/veriq.js ] || pnpm --filter veriq-client build >/dev/null 2>&1 || true

ATTACKER_BIN="$TARGET_DIR/debug/veriq-malicious-rpc"
ENGINE_BIN="$TARGET_DIR/debug/veriq-server"
[[ -x "$ATTACKER_BIN.exe" ]] && ATTACKER_BIN="$ATTACKER_BIN.exe"
[[ -x "$ENGINE_BIN.exe" ]] && ENGINE_BIN="$ENGINE_BIN.exe"

LOGS="$(mktemp -d)"
step "start attacker + engine (logs: $LOGS)"
UPSTREAM_RPC="$UPSTREAM" "$ATTACKER_BIN" >"$LOGS/attacker.log" 2>&1 & PIDS+=($!)
# The engine probes every provider once at startup, so the attacker must be up first.
for _ in $(seq 1 50); do curl -s "$ATTACKER/mode" >/dev/null 2>&1 && break; sleep 0.2; done
curl -s "$ATTACKER/mode" >/dev/null || { echo "attacker did not start; see $LOGS/attacker.log" >&2; exit 1; }
ENGINE_PID=""
start_engine() {
  # Dev mode: the root comes from the honest upstream, never from the attacker listed first.
  VERIQ_CONFIG_DIR="$ROOT/backend/config" VERIQ_PROVIDERS="attacker=$ATTACKER,$VERIQ_PROVIDERS" VERIQ_ROOT_SOURCE="$ROOT_SOURCE" \
    VERIQ_DEV_ALLOW_UNTRUSTED_ROOT=$([ "$ROOT_SOURCE" = dev-untrusted ] && echo 1 || echo 0) \
    VERIQ_DEV_ROOT_RPC="$([ "$ROOT_SOURCE" = dev-untrusted ] && echo "$UPSTREAM")" \
    "$ENGINE_BIN" >>"$LOGS/engine.log" 2>&1 & ENGINE_PID=$!; PIDS+=("$ENGINE_PID")
  # Up to 5 minutes: Helios catches up from the pinned checkpoint before its first root,
  # and that takes longer as the checkpoint ages.
  for _ in $(seq 1 150); do
    [ "$(curl -s "$ENGINE/health" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("status"))' 2>/dev/null)" = ok ] && return 0
    sleep 2
  done
  return 1
}
stop_engine() { kill "$ENGINE_PID" 2>/dev/null || true; wait "$ENGINE_PID" 2>/dev/null || true
  for _ in $(seq 1 50); do lsof -iTCP:8547 -sTCP:LISTEN >/dev/null 2>&1 || return 0; sleep 0.2; done; }
start_engine || true

json() { python3 -c "import json,sys; d=json.load(sys.stdin); print(eval(sys.argv[1], {'d': d}))" "$1"; }
rpc() { curl -s "$ENGINE" -H 'content-type: application/json' -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$1\",\"params\":$2}"; }
set_mode() { curl -s -X POST "$ATTACKER/mode" -H 'content-type: application/json' -d "{\"mode\":\"$1\"}" >/dev/null; }

HEALTH="$(curl -s "$ENGINE/health")"
step "health"
if [ "$(echo "$HEALTH" | json 'd["status"]')" = ok ]; then
  ok "engine ok · root $(echo "$HEALTH" | json 'd["rootSource"]') · finalized #$(echo "$HEALTH" | json 'd.get("finalizedNumber") or (d.get("rootCache") or {}).get("finalizedNumber")')"
else
  bad "engine never became healthy: $(echo "$HEALTH" | json 'd.get("error")')"; exit 1
fi
echo "$HEALTH" | python3 -c '
import json,sys
for p in json.load(sys.stdin)["providers"]:
    print("       provider %-12s chain=%-5s getProof=%-5s eip1898=%s" % (p["name"], p["chainOk"], p["proofSupport"], p["eip1898"]))'
# Every attack check needs an honest provider to fail over to.
# The startup probe can still be running when /health first says ok (dev roots are ready at once).
honest_count() { curl -s "$ENGINE/health" | json 'sum(1 for p in d["providers"] if p["name"] != "attacker" and p["chainOk"] and p["proofSupport"])' 2>/dev/null || echo 0; }
HONEST_COUNT=0
for _ in $(seq 1 30); do HONEST_COUNT="$(honest_count)"; [ "$HONEST_COUNT" -ge 1 ] && break; sleep 1; done
if [ "$HONEST_COUNT" -ge 1 ]; then
  ok "$HONEST_COUNT honest proof-capable provider(s) behind the attacker"
else
  bad "no honest provider passed the probe (Sepolia + eth_getProof): attack results would mean nothing"; exit 1
fi

read_balance() { rpc veriq_readBalance "[\"$ADDRESS\"]"; }
# One line per read; veriq_* answers carry the receipt in result, eth_* answers next to it ("veriq").
summary() { json '(lambda r, v: "%s value=%s block=%s attempts=%s" % (r["verification"]["status"], v if len(str(v)) < 40 else "%d bytes" % (len(v) // 2 - 1), r["block"]["number"], [(a["provider"], a["outcome"]) for a in r["routing"]["attempts"]]))(d.get("veriq") or d["result"]["receipt"], d["result"]["value"] if isinstance(d["result"], dict) else d["result"]) if "result" in d else "ERROR %s %s" % (d["error"]["code"], d["error"]["message"])'; }

step "verified read (attacker off)"
set_mode off
R="$(read_balance)"; echo "       $(echo "$R" | summary)"
if [ "$(echo "$R" | json 'd["result"]["receipt"]["verification"]["status"]' 2>/dev/null)" = "$EXPECT_STATUS" ]; then
  ok "balance is $EXPECT_STATUS"
  HONEST="$(echo "$R" | json 'd["result"]["value"]')"; BLOCK="$(echo "$R" | json 'd["result"]["receipt"]["block"]["number"]')"
else
  bad "expected a $EXPECT_STATUS balance"; exit 1
fi

step "DemoStorage slot 0"
if [ -n "${VERIQ_DEMO_CONTRACT:-}" ]; then
  S="$(rpc veriq_readStorage "[\"$VERIQ_DEMO_CONTRACT\",\"0x0\"]")"
  [ "$(echo "$S" | json 'int(d["result"]["value"], 16)' 2>/dev/null)" = 42 ] && ok "slot 0 proves to 42" || bad "slot 0: $(echo "$S" | summary)"
else
  skip "VERIQ_DEMO_CONTRACT not set (deploy smart-contract/ first, see smart-contract/DEPLOYED.md)"
fi

step "every verified read at one pinned block (attacker off)"
# Balance, nonce, code, storage slot 0, the balances mapping entry, an unused slot and an
# account that does not exist. All receipts must share one block and state root; nonce and
# code are also compared with a plain provider at that exact block, and the proven code with
# the account's codeHash and with the contract compiled from smart-contract/. Retried if a new
# block is finalized mid-way.
HONEST_FILE="$LOGS/honest.json"
# Compile DemoStorage for the bytecode check when Foundry is available (optional).
FORGE="$(command -v forge || echo "$HOME/.foundry/bin/forge")"
if [ -n "${VERIQ_DEMO_CONTRACT:-}" ] && [ -x "$FORGE" ]; then
  (cd smart-contract && "$FORGE" build -q >/dev/null 2>&1) || true
fi
# DemoStorage's deployment set balances[deployer] = 7 (smart-contract/DEPLOYED.md).
DEMO_BALANCE_ACCOUNT="${VERIQ_DEMO_BALANCE_ACCOUNT:-0x47c6BE3F86E091a31cb3AdF176c934467E27DC56}"
DEMO_BALANCE="${VERIQ_DEMO_BALANCE:-7}"
while IFS= read -r line; do
  case "$line" in
    PASS\ *) ok "${line#PASS }" ;; FAIL\ *) bad "${line#FAIL }" ;; SKIP\ *) skip "${line#SKIP }" ;; *) echo "       $line" ;;
  esac
done < <(python3 - "$ENGINE" "$UPSTREAM" "$ADDRESS" "${VERIQ_DEMO_CONTRACT:-}" "$EXPECT_STATUS" "$HONEST_FILE" \
  "$ROOT" "$DEMO_BALANCE_ACCOUNT" "$DEMO_BALANCE" <<'PY'
import json, os, sys, urllib.request
engine, upstream, address, demo, expect, out, root, balance_account, balance_expected = sys.argv[1:10]
sys.path.insert(0, os.path.join(root, "scripts", "lib"))
from evm import hex_bytes, keccak256, mapping_slot

def call(url, method, params):
    req = urllib.request.Request(url, json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode(),
                                 {"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)

absent = "0x" + os.urandom(20).hex()  # a fresh random address: no account there
reads = [
    ("balance", "veriq_readBalance", [address], {"account-proof"}),
    ("nonce", "eth_getTransactionCount", [address, "finalized"], {"account-proof"}),
    ("code of an EOA", "eth_getCode", [address, "finalized"], {"account-proof", "code-hash"}),
    ("absent account balance", "veriq_readBalance", [absent], {"account-proof"}),
]
if demo:
    reads += [
        ("contract code", "eth_getCode", [demo, "finalized"], {"account-proof", "code-hash"}),
        ("storage slot 0", "veriq_readStorage", [demo, "0x0"], {"account-proof", "storage-proof"}),
        ("unused storage slot", "veriq_readStorage", [demo, "0x7"], {"account-proof", "storage-proof"}),
        # balances is mapping slot 1: entry at keccak256(abi.encode(account, 1)).
        ("mapping entry balances[deployer]", "veriq_readStorage", [demo, mapping_slot(balance_account, 1)], {"account-proof", "storage-proof"}),
        ("mapping entry via eth_getStorageAt", "eth_getStorageAt", [demo, mapping_slot(balance_account, 1), "finalized"], {"account-proof", "storage-proof"}),
    ]

for attempt in range(3):
    got = {}
    for name, method, params, _ in reads:
        d = call(engine, method, params)
        if "error" in d:
            print(f"FAIL {name}: engine error {d['error']['code']} {d['error']['message']}")
            sys.exit()
        res = d["result"]
        rec = d.get("veriq") or res["receipt"]
        got[name] = (res["value"] if isinstance(res, dict) else res, rec)
    blocks = {(r["block"]["number"], r["block"]["stateRoot"]) for _, r in got.values()}
    if len(blocks) == 1:
        break
    print(f"finalized block moved during the reads ({sorted(b for b, _ in blocks)}); retrying")
else:
    print("FAIL reads never landed on one block in 3 tries")
    sys.exit()

(number, state_root), = blocks
print(f"pinned block #{number} stateRoot {state_root[:10]}…")
for name, method, params, mechanisms in reads:
    value, rec = got[name]
    v = rec["verification"]
    problems = []
    if v["status"] != expect:
        problems.append(f"status {v['status']}")
    if v["status"] == "verified" and v["rootSource"] not in ("local-light-client", "fixture"):
        problems.append(f"verified with root source {v['rootSource']}")
    if not rec["block"]["finalized"]:
        problems.append("block not finalized")
    if set(v["mechanisms"]) != mechanisms:
        problems.append(f"mechanisms {v['mechanisms']}")
    shown = value if len(str(value)) < 24 else f"{len(value) // 2 - 1} bytes"
    if problems:
        print(f"FAIL {name}: {', '.join(problems)}")
    else:
        print(f"PASS {name} = {shown}: {v['status']}, block #{number}, {'+'.join(sorted(mechanisms))}")

def expect_value(name, check, what):
    if name in got:
        print(("PASS " if check(got[name][0]) else "FAIL ") + f"{name} {what}")

expect_value("absent account balance", lambda v: int(v, 16) == 0, "is 0 (exclusion proof)")
expect_value("code of an EOA", lambda v: v in ("0x", "0x0"), "is empty")
expect_value("storage slot 0", lambda v: int(v, 16) == 42, "is 42")
expect_value("unused storage slot", lambda v: int(v, 16) == 0, "is 0 (exclusion proof)")
expect_value("contract code", lambda v: len(v) > 2, "is non-empty")
expect_value("mapping entry balances[deployer]", lambda v: int(v, 16) == int(balance_expected), f"is {balance_expected}")
expect_value("mapping entry via eth_getStorageAt", lambda v: int(v, 16) == int(balance_expected), f"is {balance_expected}")
# The same block, asked of a plain provider: the proven values must match what is on chain.
tag = hex(number)
plain_nonce = call(upstream, "eth_getTransactionCount", [address, tag])["result"]
expect_value("nonce", lambda v: int(v, 16) == int(plain_nonce, 16), f"matches the chain at #{number} ({int(plain_nonce, 16)})")
if demo:
    plain_code = call(upstream, "eth_getCode", [demo, tag])["result"]
    expect_value("contract code", lambda v: v.lower() == plain_code.lower(), f"matches the chain at #{number}")
    # The engine checked keccak256(code) against the proven account's codeHash; check it here too,
    # against the codeHash a plain provider reports for that block.
    code_hash = call(upstream, "eth_getProof", [demo, [], tag])["result"]["codeHash"].lower()
    proven_code = got["contract code"][0]
    expect_value("contract code", lambda v: "0x" + keccak256(hex_bytes(v)).hex() == code_hash, f"hashes to the account's codeHash {code_hash[:10]}…")
    # And it is exactly the runtime bytecode compiled from smart-contract/src/DemoStorage.sol.
    artifact = os.path.join(root, "smart-contract", "out", "DemoStorage.sol", "DemoStorage.json")
    if os.path.exists(artifact):
        compiled = json.load(open(artifact))["deployedBytecode"]["object"].lower()
        compiled = compiled if compiled.startswith("0x") else "0x" + compiled
        print(("PASS " if proven_code.lower() == compiled else "FAIL ")
              + f"deployed code is the compiled DemoStorage runtime ({len(compiled) // 2 - 1} bytes)")
    else:
        print("SKIP compiled-bytecode check: no smart-contract/out (install Foundry, run forge build)")
json.dump({"block": number, "nonce": got["nonce"][0], "code": got["contract code"][0] if demo else got["code of an EOA"][0]}, open(out, "w"))
PY
)
[ -f "$HONEST_FILE" ] || bad "honest nonce/code not recorded"

step "attacker modes, one after another (breakers reset between modes: an INVALID_PROOF benches the attacker for 5 minutes)"
# Expected attacker outcome (DECISIONS.md: a claimed value that differs from the proven one
# is INVALID_PROOF, so 'value' is rejected too). Honest value is returned every time.
CODE_TARGET="${VERIQ_DEMO_CONTRACT:-$ADDRESS}"
for mode in value outage proof wrongblock nonce code; do
  set_mode "$mode"
  # Demo builds clear the breakers in place (loopback only), so the same engine reaches the
  # attacker in every mode. Without that route, restart the engine (probe in 'off' first).
  if ! curl -sf -X POST "$ENGINE/admin/reset-breakers" >/dev/null; then
    set_mode off; stop_engine; start_engine || { bad "$mode: engine did not restart"; continue; }
    set_mode "$mode"
  fi
  # What a plain client would read from the attacker, and the same read through Veriq.
  case "$mode" in
    nonce) plain=(eth_getTransactionCount "[\"$ADDRESS\",\"finalized\"]"); R="$(rpc eth_getTransactionCount "[\"$ADDRESS\",\"finalized\"]")" ;;
    code) plain=(eth_getCode "[\"$CODE_TARGET\",\"finalized\"]"); R="$(rpc eth_getCode "[\"$CODE_TARGET\",\"finalized\"]")" ;;
    *) plain=(eth_getBalance "[\"$ADDRESS\",\"finalized\"]"); R="$(read_balance)" ;;
  esac
  claimed="$(curl -s "$ATTACKER" -H 'content-type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"${plain[0]}\",\"params\":${plain[1]}}" \
    | json '(lambda r: r if len(str(r)) < 40 else "%d bytes of code (altered)" % (len(r) // 2 - 1))(d.get("result", "HTTP error / no result"))' 2>/dev/null || echo "no answer (outage)")"
  echo "       $mode: plain RPC claims $claimed"
  echo "       $mode: Veriq says       $(echo "$R" | summary)"
  value="$(echo "$R" | json '(d["result"]["value"] if isinstance(d["result"], dict) else d["result"]).lower()' 2>/dev/null || echo none)"
  block="$(echo "$R" | json '(d.get("veriq") or d["result"]["receipt"])["block"]["number"]' 2>/dev/null || echo none)"
  outcome="$(echo "$R" | json '[a["outcome"] for a in (d.get("veriq") or d["result"]["receipt"])["routing"]["attempts"] if a["provider"]=="attacker"]' 2>/dev/null || echo '?')"
  # The honest value at exactly the block this receipt is pinned to, from a plain provider,
  # so a newly finalized block between modes needs no special case.
  case "$mode" in
    nonce) check=(eth_getTransactionCount "$ADDRESS") ;; code) check=(eth_getCode "$CODE_TARGET") ;; *) check=(eth_getBalance "$ADDRESS") ;;
  esac
  if [ "$block" = none ]; then bad "$mode: no receipt block"; continue; fi
  expected="$(curl -s "$UPSTREAM" -H 'content-type: application/json'     -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"${check[0]}\",\"params\":[\"${check[1]}\",\"$(printf '0x%x' "$block")\"]}"     | json 'd["result"].lower()' 2>/dev/null || echo unknown)"
  same="$(python3 -c 'import sys; a, b = sys.argv[1], sys.argv[2]; print(a == b or (len(a) < 67 and len(b) < 67 and a.startswith("0x") and b.startswith("0x") and int(a, 16) == int(b, 16)))' "$value" "$expected" 2>/dev/null || echo False)"
  case "$mode:$outcome" in
    value:*invalid-proof*|outage:*transport-failure*|proof:*invalid-proof*|wrongblock:*invalid-proof*|nonce:*invalid-proof*|code:*invalid-proof*)
      [ "$same" = True ] && ok "$mode: honest proven value at block #$block (matches the chain there), attacker $outcome"                          || bad "$mode: value differs from the chain at block #$block";;
    *) bad "$mode: unexpected attacker outcome $outcome";;
  esac
done
set_mode off
starts="$(grep -c 'server listening' "$LOGS/engine.log" || true)"
[ "$starts" = 1 ] && ok "all attack modes ran on one engine process (breakers reset in place)"                  || skip "engine was started $starts times (no reset route: not a demo build)"

step "policy"
P="$(rpc veriq_readBalance "[\"$ADDRESS\",{\"verification\":\"required\",\"privacy\":\"off\",\"consistency\":\"single\",\"blockPolicy\":\"latest\",\"timeoutMs\":8000}]")"
[ "$(echo "$P" | json 'd["error"]["code"]' 2>/dev/null)" = -32014 ] && ok "latest+required -> -32014 POLICY_UNSATISFIABLE" || bad "latest+required: $P"

step "SDK CLI"
# Node: $NODE, else node, else node.exe (WSL without a Linux Node.js calls the Windows one).
NODE_BIN=""
for candidate in "${NODE:-}" node node.exe; do
  if [ -n "$candidate" ] && "$candidate" --version >/dev/null 2>&1; then NODE_BIN="$candidate"; break; fi
done
if [ -z "$NODE_BIN" ]; then
  bad "no Node.js found: set NODE=/path/to/node (or install node / node.exe)"
elif [ ! -f frontend/sdk/dist/bin/veriq.js ]; then
  bad "SDK not built: run pnpm --filter veriq-client build"
elif NO_COLOR=1 "$NODE_BIN" frontend/sdk/dist/bin/veriq.js read "$ADDRESS"; then
  ok "veriq read printed the receipt ($NODE_BIN $("$NODE_BIN" --version))"
else
  bad "CLI failed"
fi

step "logs"
if grep -qiE "https?://|${ADDRESS#0x}" "$LOGS/engine.log"; then bad "engine log contains a URL or the full address"; else ok "engine log has no URL and no full address"; fi

printf '\n\033[1mresult: %d passed, %d failed, %d skipped\033[0m\n' "$PASS" "$FAIL" "$SKIP"
[ "$FAIL" -eq 0 ]
