# Start/stop Laya (github.com/NandhaKishorM/laya, Apache-2.0) for the Jev-router shadow test.
# 127.0.0.1 only, on a port nothing else here uses (Jarvis/Vite: 8081, OpenClaw relay: 18789).
# See docs/LAYA.md for the one-time install (its own venv, GPU PyTorch, `pip install "laya[serve]"`)
# before this script's first run — it does not install anything itself.
#
# Everything lives under D:\laya (venv, Hugging Face cache, repo clone) — C: stays untouched. These
# env vars are set only for this process tree, never machine/user-wide.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows\laya.ps1          start
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows\laya.ps1 -Stop    stop
param([switch]$Stop)

$layaRoot = 'D:\laya'
$layaServe = Join-Path $layaRoot 'venv\Scripts\laya-serve.exe'
$root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$log = Join-Path $root '.operator-data\laya-server.log'
$port = 8899

function Listener { Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 }

if ($Stop) {
  $l = Listener
  if ($l) { taskkill /PID $l.OwningProcess /T /F | Out-Null; 'Laya stopped' } else { 'Laya was not running' }
  return
}
if (Listener) { "Laya is already listening on 127.0.0.1:$port"; return }
if (-not (Test-Path $layaServe)) { throw "Laya's venv is missing ($layaServe) — follow docs/LAYA.md's install steps first" }

New-Item -ItemType Directory -Force (Split-Path $log) | Out-Null
$env:LAYA_HOST = '127.0.0.1'   # loopback only, never LAN/WAN
$env:LAYA_PORT = "$port"
$env:LAYA_DEVICE = 'cuda'      # falls back to cpu itself if no GPU is visible
$env:LAYA_PRELOAD = '1'        # load the model at startup, not on the first request
$env:LAYA_MODELS = 'typed-decisions'   # only the checkpoint we shadow Jev with — skips loading the other two
$env:HF_HOME = Join-Path $layaRoot 'hf'   # keep the model cache on D:, never C:

Start-Process -FilePath $layaServe -WindowStyle Hidden -RedirectStandardOutput $log -RedirectStandardError "$log.err" | Out-Null
"Laya starting on 127.0.0.1:$port (log: $log)"
