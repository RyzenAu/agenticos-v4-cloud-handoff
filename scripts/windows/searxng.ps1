# Start SearXNG (https://github.com/searxng/searxng) inside the existing kali-linux WSL distro,
# as the M&U lead engine's "finding sites" search step (scripts/leads/discovery.ts) — loopback
# only, ahead of Hermes in the discovery order (OSM tag -> domain guess -> SearXNG -> Hermes last
# resort). Never installs or resets the WSL distro itself; it must already exist
# (`wsl --list --verbose`) and this only runs a Python venv inside it.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows\searxng.ps1          start
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows\searxng.ps1 -Stop    stop
#
# Setup performed once (25 Sep 2026), not by this script: cloned searxng into
# ~/searxng-src/searxng inside kali-linux, a `virtualenv` (not the stdlib venv module — Kali's
# python3.13-venv package needs sudo, which this session didn't have) at ~/searxng-venv, `pip
# install -r requirements.txt` then `pip install -e . --no-build-isolation`, and a settings
# override at ~/searxng-config/settings.yml (bind_address 127.0.0.1, port 18888 — 8888 collided
# with something else already on this machine, limiter off, json format on for our own
# programmatic use, image_proxy off). WSL2's own localhost forwarding makes 127.0.0.1:18888
# reachable from Windows automatically once nothing else on Windows holds that port.
param([switch]$Stop)

$distro = 'kali-linux'
$port = 18888

# An actual HTTP probe, not Get-NetTCPConnection — WSL2's localhost-forwarded socket can lag a
# beat behind Windows' own TCP table right after the process starts, and this is exactly what
# scripts/leads/discovery.ts will do anyway, so "ready" means the same thing here as there.
function Responding {
  try { (Invoke-WebRequest -Uri "http://127.0.0.1:$port/search?q=ping&format=json" -TimeoutSec 3 -UseBasicParsing).StatusCode -eq 200 }
  catch { $false }
}

if ($Stop) {
  wsl -d $distro -- bash -c "pkill -f searx.webapp; true" | Out-Null
  'SearXNG stop signal sent.'
  return
}

if (Responding) {
  "SearXNG already running on 127.0.0.1:$port"
  return
}

# wsl.exe writes UTF-16LE to stdout even when piped; PowerShell's default capture can leave null
# bytes between characters, which would make a plain -match silently fail. Strip them first.
$distros = (wsl --list --quiet 2>$null | Out-String) -replace "`0", ''
if ($distros -notmatch [regex]::Escape($distro)) { throw "WSL distro '$distro' not found - this script never creates or resets a distro, only runs inside an existing one." }

# Explicit disown-by-PID + a brief sleep before the shell (and wsl.exe) exits — plain `cmd & disown`
# on one line was observed (25 Sep 2026) to sometimes let the process die with its parent anyway.
wsl -d $distro -- bash -c "source ~/searxng-venv/bin/activate; export SEARXNG_SETTINGS_PATH=~/searxng-config/settings.yml; cd ~/searxng-src/searxng; nohup python3 -m searx.webapp > ~/searxng.log 2>&1 < /dev/null & disown `$!; sleep 2" | Out-Null

foreach ($i in 1..30) {
  Start-Sleep 1
  if (Responding) { "SearXNG running on 127.0.0.1:$port (WSL: $distro)"; return }
}
throw "SearXNG did not start within 30s; check ~/searxng.log inside $distro (wsl -d $distro -- tail -40 ~/searxng.log)"
