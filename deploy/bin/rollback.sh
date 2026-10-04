#!/usr/bin/env bash
# Return an instance to its previous release (code only). Data is untouched.
#
#   deploy/bin/rollback.sh <production|staging>
#
# If the newer release changed a store's schema, the older code may refuse it: then restore the pre-rollout
# backup into a fresh data directory instead (deploy/README.md, Restore). The rollout takes that backup first.
set -euo pipefail
inst="${1:-}"
case "$inst" in production|staging) ;; *) echo "usage: $0 <production|staging>" >&2; exit 2 ;; esac
[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }

base="/opt/mu-hub/$inst"
[ -L "$base/previous" ] || { echo "no previous release recorded for $inst" >&2; exit 1; }
prev="$(readlink -f "$base/previous")"
cur="$(readlink -f "$base/current")"
[ -d "$prev" ] || { echo "previous release folder is gone: $prev" >&2; exit 1; }

ln -sfn "$prev" "$base/current"
ln -sfn "$cur" "$base/previous"     # so a second rollback undoes the first
basename "$prev" > "$base/current.sha"
systemctl restart "mu-hub@$inst"
"$(dirname "$0")/smoke.sh" "$inst" 90 && echo "rolled back to $(basename "$prev")"
