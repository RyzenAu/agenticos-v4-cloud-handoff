#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
bun_bin=${BUN_BIN:-$(command -v bun)}
[[ -x "$bun_bin" ]] || { echo "Set BUN_BIN to an installed Bun executable." >&2; exit 1; }
files=(
  "$root/scripts/jarvis-command/compound-questions.test.ts"
  "$root/scripts/jarvis-command/business.test.ts"
  "$root/scripts/jarvis-command/business-service.test.ts"
  "$root/scripts/jarvis-command/crm.test.ts"
  "$root/scripts/jarvis-command/leads-voice.test.ts"
  "$root/scripts/jarvis-command/unit.test.ts"
  "$root/scripts/jarvis-command/routing-r10.test.ts"
  "$root/scripts/jarvis-command/remote-steps.test.ts"
  "$root/scripts/jarvis-command/owner-route-r9.test.ts"
  "$root/scripts/jarvis-command/stop-pending-r11.test.ts"
  "$root/scripts/jarvis-command/typed-turn-persistence.test.ts"
  "$root/scripts/jarvis-command/plain-answer-contract.test.ts"
  "$root/scripts/conversations.test.ts"
  "$root/scripts/jarvis-command/draft-origin-r11.test.ts"
)
for file in "${files[@]}"; do [[ -f "$file" ]] || { echo "Missing test source: $file" >&2; exit 1; }; done
fixture=$(mktemp -d)
trap 'rm -rf -- "$fixture"' EXIT
mkdir -p "$fixture/home" "$fixture/tmp" "$fixture/vault"
cd "$fixture"
env -i HOME="$fixture/home" TMPDIR="$fixture/tmp" PATH="$(dirname "$bun_bin"):/usr/bin:/bin" \
  OBSIDIAN_VAULT_PATH="$fixture/vault" AGENTIC_OS_NO_BACKGROUND=1 AGENTIC_OS_NO_CODEX=1 ARGENTIC_PREVIEW=1 \
  "$bun_bin" --no-env-file test "${files[@]}"
