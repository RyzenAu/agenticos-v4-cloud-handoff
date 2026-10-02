#!/usr/bin/env bash
# Is this instance healthy? Reads /__health on loopback (no secrets in the answer). Exit 0 when the
# status is ok or degraded, 1 when failed or unreachable. Prints the failed components and their hints.
#
#   deploy/bin/smoke.sh <production|staging> [wait-seconds]
set -uo pipefail
inst="${1:-}"; wait="${2:-30}"
case "$inst" in production) port=8081 ;; staging) port=8082 ;; *) echo "usage: $0 <production|staging> [seconds]" >&2; exit 2 ;; esac

end=$((SECONDS + wait))
while [ "$SECONDS" -lt "$end" ]; do
  body="$(curl -fsS --max-time 5 "http://127.0.0.1:${port}/__health" 2>/dev/null)" && code=200 || code=$?
  if [ "$code" = 200 ]; then
    status="$(printf '%s' "$body" | sed -n 's/.*"status":"\([a-z]*\)","checkedAt".*/\1/p')"
    sha="$(printf '%s' "$body" | sed -n 's/.*"gitSha":"\([^"]*\)".*/\1/p')"
    echo "health: ${status:-unknown} (gitSha ${sha:-?})"
    [ "$status" = "ok" ] || [ "$status" = "degraded" ] && { printf '%s' "$body" | sed -n 's/.*"failed":\(\[[^]]*\]\).*/failed: \1/p'; exit 0; }
  fi
  sleep 3
done
echo "health: unreachable or failed after ${wait}s; journalctl -u mu-hub@${inst} -n 80" >&2
exit 1
