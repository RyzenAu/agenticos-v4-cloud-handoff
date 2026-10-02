#!/usr/bin/env bash
# One-time, idempotent host setup for the AgenticOS hub on Debian/Ubuntu. Run as root on the VM.
# It creates the service user and folders, installs the pinned Bun, and installs the systemd units.
# It does NOT install or sign in Tailscale, create env files with secrets, or start anything.
set -euo pipefail

BUN_VERSION="${BUN_VERSION:-1.4.2}"   # pinned: the version this repo's lockfile and tests were verified on
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }

id muhub >/dev/null 2>&1 || useradd --system --home-dir /var/lib/mu-hub --shell /usr/sbin/nologin muhub

install -d -o muhub -g muhub -m 0750 /var/lib/mu-hub
install -d -o muhub -g muhub -m 0750 /opt/mu-hub/releases
install -d -o root  -g muhub -m 0750 /etc/mu-hub
install -d -o muhub -g muhub -m 0700 /var/backups/mu-hub
for inst in production staging; do
  install -d -o muhub -g muhub -m 0700 "/var/lib/mu-hub/$inst" "/var/lib/mu-hub/${inst}-home" "/var/lib/mu-hub/${inst}-vault"
  install -d -o muhub -g muhub -m 0700 "/var/backups/mu-hub/$inst"
  install -d -o root  -g root  -m 0755 "/opt/mu-hub/$inst"
done

# Packages the hub needs: git + tar to unpack releases, curl and unzip for Bun, sqlite3 only for operator debugging.
need=()
for b in git tar curl unzip; do command -v "$b" >/dev/null || need+=("$b"); done
if [ "${#need[@]}" -gt 0 ]; then apt-get update -y && apt-get install -y "${need[@]}"; fi

# Pinned Bun, installed under /opt/mu-hub/bun so the unit's path never depends on a user's profile.
if [ ! -x /opt/mu-hub/bun/bin/bun ] || [ "$(/opt/mu-hub/bun/bin/bun --version)" != "$BUN_VERSION" ]; then
  BUN_INSTALL=/opt/mu-hub/bun bash -c "curl -fsSL https://bun.sh/install | bash -s 'bun-v${BUN_VERSION}'"
fi
echo "bun $(/opt/mu-hub/bun/bin/bun --version)"

install -m 0644 "$REPO_DIR"/deploy/systemd/mu-hub@.service "$REPO_DIR"/deploy/systemd/mu-hub-backup@.service "$REPO_DIR"/deploy/systemd/mu-hub-backup@.timer "$REPO_DIR"/deploy/systemd/mu-hub-watch@.service "$REPO_DIR"/deploy/systemd/mu-hub-watch@.timer /etc/systemd/system/
for inst in production staging; do
  [ -e "/etc/mu-hub/$inst.env" ] || { install -m 0640 -o root -g muhub "$REPO_DIR/deploy/env/$inst.env.example" "/etc/mu-hub/$inst.env"; echo "created /etc/mu-hub/$inst.env from the example: review it, add secrets by hand"; }
done
systemctl daemon-reload

cat <<'NEXT'
Host ready. Next (see deploy/README.md):
  1. Owner installs and signs in Tailscale on this VM.
  2. Edit /etc/mu-hub/<instance>.env (secrets by hand).
  3. deploy/bin/rollout.sh staging <git-sha>, then production once staging is healthy.
  4. deploy/tailscale/serve.sh staging   (and production)
NEXT
