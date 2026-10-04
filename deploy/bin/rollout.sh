#!/usr/bin/env bash
# Controlled rollout of ONE git SHA to ONE instance, with an automatic rollback if it is not healthy.
#
#   deploy/bin/rollout.sh <production|staging> <full-or-short-git-sha> [--repo <path-or-url>]
#   deploy/bin/rollout.sh <production|staging> <full-or-short-git-sha> --package /path/mu-hub-<sha12>.tar.gz
#
# --package: the reviewed release package built by `bun scripts/cloud/release-package.ts build` (tarball + manifest.json +
# SHA256SUMS copied together). Its sha256 is checked against SHA256SUMS and the manifest before anything is unpacked, and the
# SHA inside must equal the one you asked for. No Git mirror is needed on the VM for this route.
#
# Steps: take a backup -> unpack exactly that SHA (git archive: tracked files only, so no .env, no
# .operator-data, nothing untracked can ride along) -> bun install --frozen-lockfile -> seed the sample data
# the app imports -> repoint `current` -> restart -> wait for /__health -> on failure, repoint `previous` and restart.
# Run as root (it restarts a systemd unit). The repo it reads from is a bare mirror or checkout you control.
set -euo pipefail

inst="${1:-}"; sha="${2:-}"; shift 2 || true
repo="${MU_REPO:-/opt/mu-hub/repo.git}"
pkg=""
while [ $# -gt 0 ]; do case "$1" in --repo) repo="$2"; shift 2 ;; --package) pkg="$2"; shift 2 ;; *) echo "unknown arg $1" >&2; exit 2 ;; esac; done

case "$inst" in production) port=8081 ;; staging) port=8082 ;; *) echo "usage: $0 <production|staging> <git-sha> [--repo X]" >&2; exit 2 ;; esac
[[ "$sha" =~ ^[0-9a-f]{7,40}$ ]] || { echo "give a git SHA (7-40 hex), not a branch name: a SHA is what makes a rollout repeatable" >&2; exit 2; }
[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }

BUN=/opt/mu-hub/bun/bin/bun
base="/opt/mu-hub/$inst"
if [ -n "$pkg" ]; then
  [ -f "$pkg" ] || { echo "package not found: $pkg" >&2; exit 2; }
  pdir="$(dirname "$pkg")"; pname="$(basename "$pkg")"; mname="${pname%.tar.gz}.manifest.json"
  [ -f "$pdir/SHA256SUMS" ] && [ -f "$pdir/$mname" ] || { echo "SHA256SUMS and $mname must sit next to the package" >&2; exit 2; }
  # Integrity first: nothing is unpacked until the tarball and the manifest both match SHA256SUMS.
  (cd "$pdir" && grep -E "  ($pname|$mname)\$" SHA256SUMS | sha256sum -c -) || { echo "package checksum mismatch: refusing" >&2; exit 1; }
  full="$(sed -n 's/^  "sha": "\([0-9a-f]\{40\}\)".*//p' "$pdir/$mname" | head -1)"
  [[ "$full" =~ ^[0-9a-f]{40}$ ]] || { echo "manifest has no commit sha" >&2; exit 1; }
  case "$full" in "$sha"*) ;; *) echo "package is commit $full, not $sha: refusing" >&2; exit 1 ;; esac
else
  full="$(git -C "$repo" rev-parse --verify "${sha}^{commit}")"
fi
rel="/opt/mu-hub/releases/$full"
prev="$(readlink -f "$base/current" 2>/dev/null || true)"

log() { printf '[rollout %s] %s\n' "$inst" "$*"; }

# 1. Backup first, so a rollback after a schema change can restore data as well as code.
if [ -n "$prev" ] && systemctl is-enabled "mu-hub@$inst" >/dev/null 2>&1; then
  log "backup before switching"
  systemctl start "mu-hub-backup@$inst.service" || { log "backup failed: stopping, nothing changed"; exit 1; }
fi

# 2. Unpack exactly this SHA.
if [ ! -d "$rel" ]; then
  log "unpacking $full"
  install -d -o muhub -g muhub "$rel"
  if [ -n "$pkg" ]; then
    tar -xzf "$pkg" -C "$rel"
    [ "$(tr -d '[:space:]' < "$rel/RELEASE_SHA")" = "$full" ] || { log "RELEASE_SHA inside the package disagrees with its manifest"; rm -rf "$rel"; exit 1; }
  else
    git -C "$repo" archive "$full" | tar -x -C "$rel"
  fi
  echo "$full" > "$rel/RELEASE_SHA"
  chown -R muhub:muhub "$rel"
fi

# 3. Locked dependencies, as the service user (never as root).
log "bun install --frozen-lockfile"
runuser -u muhub -- env HOME="/var/lib/mu-hub/${inst}-home" bash -c "cd '$rel' && '$BUN' install --frozen-lockfile"
[ -d "$rel/node_modules" ] || { log "install produced no node_modules; aborting"; exit 1; }
runuser -u muhub -- env HOME="/var/lib/mu-hub/${inst}-home" bash -c "cd '$rel' && '$BUN' run seed:data"

# 4. Switch.
[ -n "$prev" ] && ln -sfn "$prev" "$base/previous"
ln -sfn "$rel" "$base/current"
echo "$full" > "$base/current.sha"
log "restart"
systemctl enable "mu-hub@$inst" >/dev/null 2>&1 || true
systemctl restart "mu-hub@$inst"

# 5. Health gate: up to 90 s for a first /__health answer that is not "failed".
if "$(dirname "$0")/smoke.sh" "$inst" 90; then
  log "healthy on $full"
  exit 0
fi

log "NOT healthy: rolling back"
if [ -n "$prev" ]; then
  ln -sfn "$prev" "$base/current"
  basename "$prev" > "$base/current.sha"
  systemctl restart "mu-hub@$inst"
  "$(dirname "$0")/smoke.sh" "$inst" 90 && log "rolled back to $(basename "$prev")" || log "rollback ALSO unhealthy: see journalctl -u mu-hub@$inst and deploy/README.md (Restore)"
else
  systemctl stop "mu-hub@$inst"
  log "no previous release to return to; service stopped"
fi
exit 1
