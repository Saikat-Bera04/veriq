#!/usr/bin/env bash
# Probe every third-party service configured in .env with one real call each and print
# OK / FAIL / MISSING. Never prints URLs or keys (provider labels and hostnames only).
# See docs/SERVICES.md for what each service is for.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
for f in "$ROOT/.env" "$ROOT/../.env"; do
  if [ -f "$f" ]; then set -a; . <(tr -d '\r' <"$f"); set +a; break; fi
done

VERIQ_ROOT="$ROOT" python3 - <<'PY'
import json, os, subprocess, urllib.parse

def host(url):
    return urllib.parse.urlparse(url).hostname or "?"

def fetch(url, body=None, timeout=12):
    # curl uses the system CA store (python.org builds on macOS often have none).
    cmd = ["curl", "-sS", "--fail-with-body", "--max-time", str(timeout), "-H", "accept: application/json"]
    if body is not None:
        cmd += ["-H", "content-type: application/json", "--data-binary", "@-"]
    out = subprocess.run(cmd + [url], input=body, capture_output=True, text=True)
    if out.returncode != 0:
        raise RuntimeError(f"HTTP/transport error (curl exit {out.returncode})")
    return json.loads(out.stdout)

def rpc(url, method, params, timeout=12):
    d = fetch(url, json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}), timeout)
    if "error" in d:
        raise RuntimeError(f"rpc error {d['error'].get('code')}")
    return d["result"]

def line(status, name, detail=""):
    color = {"OK": "32", "FAIL": "31", "MISSING": "33", "WARN": "33"}[status]
    print(f"  \033[{color}m{status:<7}\033[0m {name:<34} {detail}")

PROBE = "0x0000000000000000000000000000000000000000"
print("Execution RPC providers (VERIQ_PROVIDERS)")
spec = os.environ.get("VERIQ_PROVIDERS", "")
eligible = 0
if not spec:
    line("MISSING", "VERIQ_PROVIDERS", "required: at least 2 Sepolia providers with eth_getProof")
for entry in filter(None, (s.strip() for s in spec.split(","))):
    label, _, url = entry.partition("=")
    name = f"{label} ({host(url)})"
    try:
        chain = int(rpc(url, "eth_chainId", []), 16)
        if chain != 11155111:
            line("FAIL", name, f"wrong chain {chain}"); continue
        block = rpc(url, "eth_getBlockByNumber", ["finalized", False])
        try:
            rpc(url, "eth_getProof", [PROBE, [], "finalized"]); proof = True
        except Exception:
            proof = False
        try:
            rpc(url, "eth_getProof", [PROBE, [], {"blockHash": block["hash"]}]); eip1898 = True
        except Exception:
            eip1898 = False
        if proof:
            eligible += 1
        line("OK" if proof and eip1898 else ("WARN" if proof else "FAIL"), name,
             f"chainId ok · eth_getProof {'ok' if proof else 'NO'} · EIP-1898 blockHash {'ok' if eip1898 else 'no'}")
    except Exception as e:
        line("FAIL", name, str(e))
if spec:
    line("OK" if eligible >= 2 else "WARN", "independent proof-capable providers", f"{eligible} (need >= 2 for failover)")

print("\nHelios light client")
cons = os.environ.get("HELIOS_CONSENSUS_RPC", "")
cp = os.environ.get("HELIOS_CHECKPOINT", "")
if not cp:
    try:
        for l in open(os.path.join(os.environ.get("VERIQ_CONFIG_DIR") or os.path.join(os.environ["VERIQ_ROOT"], "backend", "config"), "checkpoint.toml")):
            if l.startswith("checkpoint ="):
                cp = l.split("=", 1)[1].strip().strip('"')
    except OSError:
        pass
if not cons:
    line("MISSING", "HELIOS_CONSENSUS_RPC", "required for verified receipts (else dev mode)")
else:
    try:
        d = fetch(cons.rstrip("/") + f"/eth/v1/beacon/light_client/bootstrap/{cp}", timeout=15)
        slot = d["data"]["header"]["beacon"]["slot"]
        line("OK", f"beacon API ({host(cons)})", f"light-client bootstrap for the pinned checkpoint (slot {slot})")
    except Exception as e:
        line("FAIL", f"beacon API ({host(cons)})", f"bootstrap failed: {type(e).__name__} (checkpoint too old or API lacks light-client routes)")
line("OK" if cp else "MISSING", "checkpoint", "from HELIOS_CHECKPOINT" if os.environ.get("HELIOS_CHECKPOINT") else "from config/checkpoint.toml")

print("\nOptional")
exec_rpc = os.environ.get("EXEC_RPC", "")
if exec_rpc:
    try:
        ok = int(rpc(exec_rpc, "eth_chainId", []), 16) == 11155111
        line("OK" if ok else "FAIL", f"EXEC_RPC ({host(exec_rpc)})", "Helios execution RPC / capture tool")
    except Exception as e:
        line("FAIL", f"EXEC_RPC ({host(exec_rpc)})", type(e).__name__)
else:
    line("MISSING", "EXEC_RPC", "optional; defaults to the first provider")
for var, what in [("SEPOLIA_RPC_URL", "contract deployment"), ("DEPLOYER_PRIVATE_KEY", "contract deployment (throwaway key)"),
                  ("VERIQ_DEMO_CONTRACT", "DemoStorage slot-0 demo"), ("ETHERSCAN_API_KEY", "contract verification")]:
    line("OK" if os.environ.get(var) else "MISSING", var, what + (" (set, not printed)" if os.environ.get(var) else ""))
PY
