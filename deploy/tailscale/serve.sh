#!/usr/bin/env bash
# Publish an instance to the tailnet ONLY, with Tailscale Serve (never Funnel, never a public port).
# This keeps the identity model the PC hub already uses: Serve adds the tailnet login headers and the hub
# verifies them with the local tailscaled (scripts/identity/**, docs/IDENTITY-ROUTES.md).
#
#   deploy/tailscale/serve.sh production   -> https://<vm>.<tailnet>.ts.net:8443  -> http://127.0.0.1:8081
#   deploy/tailscale/serve.sh staging      -> https://<vm>.<tailnet>.ts.net:8444  -> http://127.0.0.1:8082
#   deploy/tailscale/serve.sh status
#   deploy/tailscale/serve.sh off production|staging
#
# Needs Tailscale installed and signed in on the VM by the owner (an account action this repo never takes).
set -euo pipefail

case "${1:-}" in
  production) https=8443; port=8081 ;;
  staging)    https=8444; port=8082 ;;
  status)     exec tailscale serve status ;;
  off)        case "${2:-}" in
                production) exec tailscale serve --https=8443 off ;;
                staging)    exec tailscale serve --https=8444 off ;;
                *) echo "usage: $0 off production|staging" >&2; exit 2 ;;
              esac ;;
  *) echo "usage: $0 production|staging|status|off <instance>" >&2; exit 2 ;;
esac

command -v tailscale >/dev/null || { echo "tailscale is not installed on this VM" >&2; exit 1; }
tailscale status >/dev/null 2>&1 || { echo "tailscale is not signed in on this VM; the owner signs in first" >&2; exit 1; }

tailscale serve --bg --https="$https" "http://127.0.0.1:${port}"
tailscale serve status
echo "Check: tailscale funnel status must show nothing for this node."
