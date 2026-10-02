#!/usr/bin/env bash
# Put an instance's DATA back from a backup folder (the data half of a rollback). The live data is never deleted:
# it is renamed to <data>.pre-restore-<stamp> so you can go back, and removed by hand only when you are sure.
#
#   deploy/bin/restore-data.sh <production|staging> /var/backups/mu-hub/<instance>/backup-<stamp>
#
# Steps: verify checksums -> restore into a fresh sibling folder (re-verified, every store opened, row counts compared)
#        -> stop -> swap folders -> start -> smoke. If smoke fails the swap is undone and the old data is back in place.
set -euo pipefail
inst="${1:-}"; from="${2:-}"
case "$inst" in production|staging) ;; *) echo "usage: $0 <production|staging> <backup-folder>" >&2; exit 2 ;; esac
[ -n "$from" ] && [ -f "$from/manifest.json" ] || { echo "not a backup folder (no manifest.json): $from" >&2; exit 2; }
[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }

bun=/opt/mu-hub/bun/bin/bun
cli="/opt/mu-hub/$inst/current/scripts/cloud/backup-cli.ts"
live="${MU_DATA_BASE:-/var/lib/mu-hub}/$inst"   # MU_DATA_BASE is a test seam; unset on a real VM
stamp="$(date +%Y%m%d-%H%M%S)"
fresh="$live.restoring-$stamp"
old="$live.pre-restore-$stamp"
as_hub() { runuser -u muhub -- "$@"; }

# Refuse rather than nest: mv into an existing folder would put the data INSIDE it.
for d in "$fresh" "$old"; do [ ! -e "$d" ] || { echo "refusing: $d already exists" >&2; exit 2; }; done

as_hub "$bun" "$cli" verify --from "$from"
as_hub "$bun" "$cli" restore --from "$from" --to "$fresh"

# State is tracked precisely so the rollback never touches data it has not itself moved:
#   parked=1  only after the live folder was successfully renamed to $old
#   swapped=1 only after the restored folder was successfully moved to $live
parked=0; swapped=0
rollback() {
  trap - ERR INT TERM HUP
  echo "restore step failed or interrupted: putting the previous data back and restarting" >&2
  systemctl stop "mu-hub@$inst" || true
  # Only the restored data is ever moved aside, and only if it really got into place.
  if [ "$swapped" = 1 ]; then mv -T "$live" "$live.failed-restore-$stamp" || true; fi
  if [ "$parked" = 1 ]; then mv -T "$old" "$live" || true; fi
  systemctl start "mu-hub@$inst" || true
  "$(dirname "$0")/smoke.sh" "$inst" 90 || true
  exit 1
}
trap rollback ERR INT TERM HUP
systemctl stop "mu-hub@$inst"
# First restore: there may be no live folder yet (nothing to park).
if [ -e "$live" ]; then mv -T "$live" "$old"; parked=1; fi
mv -T "$fresh" "$live"; swapped=1
chown -R muhub:muhub "$live"
chmod 0700 "$live"
systemctl start "mu-hub@$inst"

if "$(dirname "$0")/smoke.sh" "$inst" 90; then
  trap - ERR INT TERM HUP
  if [ "$parked" = 1 ]; then echo "restored $from into $live; the data it replaced is kept at $old (delete it by hand when you are sure)"
  else echo "restored $from into $live (there was no previous data)"; fi
else
  echo "restored data did not come up healthy" >&2
  rollback
fi
