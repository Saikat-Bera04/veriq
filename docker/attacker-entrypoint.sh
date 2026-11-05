#!/bin/sh
# Upstream: UPSTREAM_RPC, else EXEC_RPC, else the first VERIQ_PROVIDERS URL.
set -eu
if [ -z "${UPSTREAM_RPC:-}" ]; then
  if [ -n "${EXEC_RPC:-}" ]; then UPSTREAM_RPC="$EXEC_RPC"; else
    first="${VERIQ_PROVIDERS:?set UPSTREAM_RPC or VERIQ_PROVIDERS}"; first="${first#*=}"; UPSTREAM_RPC="${first%%,*}"
  fi
  export UPSTREAM_RPC
fi
exec /usr/local/bin/veriq-malicious-rpc
