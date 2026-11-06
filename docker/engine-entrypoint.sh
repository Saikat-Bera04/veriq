#!/bin/sh
# If the demo attacker is running in the shared network namespace (compose profile "demo"),
# route through it first so the attack lab is live. Otherwise use VERIQ_PROVIDERS as given.
set -eu
if curl -sf --max-time 2 http://127.0.0.1:9545/mode >/dev/null 2>&1; then
  echo "SIMULATION: demo attacker detected on 127.0.0.1:9545; it is tried first"
  VERIQ_PROVIDERS="attacker=http://127.0.0.1:9545,${VERIQ_PROVIDERS:?VERIQ_PROVIDERS is required}"
  export VERIQ_PROVIDERS
fi
exec /usr/local/bin/veriq-server
