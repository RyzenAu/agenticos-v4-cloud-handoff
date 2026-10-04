# The writer capability: closing the bun.exe bypass (Track 6)

## The problem

The pilot proxy (`127.0.0.1:8878`) decided who may write into the shared pool by executable name
(`write_images: ["bun.exe"]`). AgenticOS runs as `bun.exe`, but so does any `bun -e "fetch(...)"`
an agent starts. That write lands straight in Hindsight: unscreened, invisible to the OS, and with no
model record or forget path. Stage D documented this as a known limit.

## The fix: a per-boot capability bound to the OS's listening process

The live pilot log (28 Sep, read-only) shows every OS write coming from the same PID that owns the
`127.0.0.1:8081` LISTEN socket (PID 140620). Bun's `fetch` runs inside the server process. So the proxy
can ask two questions: is this the process that serves the OS, and does it hold the capability the OS
registered this boot?

1. **At start** (lazily, before the first write), the memory writer makes one random 32-byte capability
   for its process. It is held in memory only. The writer is the main tree on 8081 holding the writer
   lock, or a fully synthetic copy.
2. **It registers** at `POST /_mu/writer/register` with four fields:
   - `capability_sha256`;
   - `ts`;
   - `nonce` (fresh, so two registrations in the same second aren't a replay);
   - `proof` = HMAC-SHA256(document-delete secret, `"mu-writer-register-v1|ts|sha256|nonce"`).

   The OS already reads that secret to sign deletes. The domain prefix means a registration MAC can
   never pass as a delete token (tested).
3. **The proxy accepts** only when all of these hold:
   - the caller is the proxy's own Windows user (as before);
   - the proof verifies and is fresh (±60 s) and unused;
   - **the TCP peer's PID is the ONLY process listening on `writer_port` (8081), at any address, IPv4
     or IPv6, and it holds `127.0.0.1`**. This is checked with `GetExtendedTcpTable`
     (`TCP_TABLE_OWNER_PID_LISTENER`, `AF_INET` and `AF_INET6`). A second process co-binding `0.0.0.0` or
     `[::]` beside the OS makes the owner ambiguous, and then nobody is the writer (REVIEW-T6 finding 2);
     the peer itself is matched on the full ESTABLISHED 4-tuple;
   - the image is in `write_images`.

   It keeps `{pid, sha256}` **in memory only**, and a newer valid registration replaces it.
4. **Every write** must satisfy all three of these: retain, correct (PATCH), document delete, and the
   MCP write tools.
   - It carries `X-MU-Writer: <capability>`, whose sha256 matches in constant time.
   - It comes from the registered PID.
   - That PID **still** owns the port, alone. While the port is ambiguous (a co-bind), every write is
     refused, but the OS's registration is kept, so a co-bind can't force re-registrations. The OS's
     saves wait in the queue (visibly) and go through once the co-binder is gone.

   If the OS restarted, a new process owns 8081 and the old registration is dropped. That also defeats
   PID reuse.
5. **Recovery and compatibility**:
   - A proxy restart forgets the capability. The OS's next write gets `writer-unregistered`, registers
     again, and retries once.
   - An old proxy has no route. The OS carries on without the header, so the OS can be deployed first.
   - A refusal is visible: memory state `writer-refused`, the save queued with its reason, a usage
     receipt, and a red line on the Memory page. It is never silent.

The switch is profile key `proxy.writer_capability` (`on` or `off`; missing means off, today's
behaviour), plus `proxy.writer_port`. The repo's pilot profile ships `on` / `8081`. The synthetic
profiles stay off. Registration is accepted while the switch is off, so the OS can register before
enforcement starts.

**Why the proof may use the document-delete secret, which every agent can read.** The reviewer is right that
the secret file's ACL is Usman FullControl, so any process running as Usman can read it. No file, registry
key, DPAPI blob or pipe can hold a secret the OS can read but another process of the same Windows user
can't; they all resolve to the same SID. So the proof is **not** the guard, and it is not described as one.
The guard is the process binding: registering and every write require the peer to be the ONE process
listening on 127.0.0.1:8081, so a same-user process with the secret still can't register or write while
the OS runs (probed: (c) and the co-bind steps (g) below both use a valid proof and are refused). The
proof does three narrower jobs:
- It keeps other Windows accounts out. The Codex sandbox accounts have an explicit DENY on
  `D:\hindsight`, and the proxy's same-SID check stops them earlier anyway.
- It makes a registration a deliberate act of a process that holds the proxy's own secret, rather than
  anything that can reach the port.
- It is domain-separated, so it can never be spent as a delete token.

A proof that same-user processes can't forge would need a separate Windows account for the OS; see the
residual risk below.

**Why not a named-pipe ACL?** On a single-user PC an ACL can name only a user SID, and the owner, the
OS and every agent share that SID. A pipe ACL would stop other accounts (the proxy's SID check already
does), not another process of the same user. Binding to the process that owns the OS's port is the
strongest identity available without a second Windows account.

## Residual risk, stated plainly

This stops what happened in Stage D: an agent's own `bun`/`node`/`python`/`curl` process writing to the
proxy, with or without copied headers, an invented capability, or even a valid proof. What it cannot stop
is a process running as the owner that attacks the OS process itself. Such a process can:
- inject code into it or debug it (same-user processes have full access to each other);
- read its memory to take the capability, although it would still have to send from that PID;
- kill the OS and bind 127.0.0.1:8081 itself before the supervisor restarts it, since it can also read
  the secret file. The OS then fails loudly with `EADDRINUSE` (`strictPort`), and the supervisor log shows
  it isn't listening. A co-bind WHILE the OS runs no longer works: it makes the port ambiguous and
  nobody writes;
- use the OS's own `/__memory` API, which is the intended, screened, visible path.

The only complete fix is running the OS and the proxy under a separate Windows account, whose secrets
the owner's account can't read. That isn't practical here, because the OS drives the owner's desktop,
browser and microphone.

## Evidence

- **Python** (`scripts/hindsight/tests/test_writer_capability.py`, 15 tests, 47 in the folder), including the co-bind ambiguity and the same-second nonce:
  - a forged registration from a non-listener;
  - bad, stale, future and replayed proofs;
  - a registration proof that is never a delete token;
  - another PID even holding the right capability;
  - an OS restart (new PID; the old capability dies);
  - PID reuse after the OS died;
  - replacement by a newer registration;
  - `write_images` still applies;
  - off keeps today's behaviour;
  - nothing secret in the log;
  - the pilot profile is on and synthetic profiles are off.
- **TypeScript** (`scripts/memory/writer-capability.test.ts`, 5 tests):
  - registers before the first write;
  - re-registers once after a proxy restart;
  - writes as before to an old proxy;
  - a refusal is queued and visible;
  - a read-only copy never registers.
- **Synthetic end to end** (`scripts/hindsight/tests/writer_capability_integration.ts` →
  `evidence/writer-capability-run.json`). This branch's `proxy.py` runs standalone on 8884 against the
  stage-d API. A quiet OS copy runs on 8097, and a separate `bun` process plays the attacker. The run
  covers:
  - (a) the OS registers and saves, with its model receipt;
  - (b) the attacker's writes are refused, with no capability and with an invented one;
  - (c) the attacker's forged registration is refused even with a valid proof;
  - (d) a proxy restart leads to a transparent re-registration;
  - (e) an OS restart leads to a new PID and a new registration, and the attacker is still refused;
  - (g) REVIEW-T6's co-bind: another bun.exe binds 0.0.0.0:<port> and then [::]:<port> beside the OS.
    Each time it is refused registration (even with a valid proof) and writes; the OS's own save waits
    (queued, visibly) and lands once the co-binder is gone;
  - (f) with the switch off, the bypass is back, which shows the switch is what closes it.

## Owner-approval deploy (live change; NOT applied)

Run these in **Windows PowerShell as Usman**, in order. Each step has its rollback. The order matters:
the OS must support registration **before** the proxy enforces it, otherwise saves wait in the queue
(visibly) until the OS is updated.

```powershell
$os  = "$env:USERPROFILE\source\repos\AgenticOS-v4"
$ctl = "$os\scripts\hindsight\hindsightctl.ps1"       # the repo copy (deploy refuses to run from D:\hindsight\service)
$svc = 'D:\hindsight\service'
$log = 'D:\hindsight\service\run\pilot\proxy.jsonl'
function Restart-OS {
  $owners = @((Get-NetTCPConnection -LocalPort 8081 -State Listen -ErrorAction SilentlyContinue).OwningProcess | Sort-Object -Unique)
  if ($owners.Count -gt 1) { "More than one process listens on 8081 ($($owners -join ', ')): stop and look before restarting anything."; return }
  if ($owners.Count -eq 1) { taskkill /PID $owners[0] /T /F | Out-Null }
  $t = (Get-Date).AddMinutes(3)
  do { Start-Sleep 5 } until ((Get-NetTCPConnection -LocalPort 8081 -State Listen -ErrorAction SilentlyContinue) -or (Get-Date) -gt $t)
}
```

**Step 1: the OS change first.** Merge `f/t6-memory-20260928` into the main tree the usual way
(fast-forward if possible), then run `Restart-OS`. Against the current proxy, the OS's registration is
refused as an unknown route and it writes exactly as before. To check, after any save (for example
Jarvis "remember that …"):
```powershell
Get-Content $log -Tail 300 | ConvertFrom-Json | Where-Object route -eq '/_mu/writer/register' | Select-Object ts, decision, client_pid -Last 3   # old proxy: none, or "deny" (route not allowed); saves still land
```
Rollback 1: `git -C $os revert -m 1 <the merge commit>` (or `git revert --no-edit <commits>` if it was a
fast-forward), then `Restart-OS`. Revert keeps history and moves no ref.

**Step 1b (optional): the Hermes relay plugin, for Telegram approval codes.**

- **What's installed today:** the pre-S2 plugin, byte-identical to f334ab7. It relays only 4-character
  away codes as commands.
- **What happens without this step:** an 8-character reply (`approve K7PQ-M4XZ`, docs/APPROVAL-CODES.md)
  never reaches the OS. It goes to the Hermes agent as ordinary chat, so the code text sits in the agent's
  context and nothing is approved. **A program's forget must then be approved by either founder's spoken
  yes** ("approve the pending forget"). That works either way.
- **What the installer puts in:** the T6-only variant, `scripts/away-mode/hermes-plugin-installed/`. It
  is exactly the plugin installed today plus the 3-line relay pattern for 8-character codes. It does
  **not** install S2's money pre-check (the free-text OS check and the offline money word list), which
  the owner declined ("money requests are fine").
- **Backup:** before copying, the installer copies the installed folder aside to
  `.operator-data\away-mode\plugin-backups\<timestamp>` and prints that path.

```powershell
Set-Location $os
bun scripts\away-mode\install-hermes-plugin.ts --port 8081       # prints "Installed ... (T6 variant ...)" and the backup folder
& "$env:LOCALAPPDATA\hermes\bin\hermes.exe" gateway restart   # the plugin is already enabled (plugins: away-mode)
```
Rollback 1b restores the copy the installer made, not a repo version. The S2 version was never
installed:
```powershell
bun scripts\away-mode\install-hermes-plugin.ts --restore "<the backup folder it printed>"
& "$env:LOCALAPPDATA\hermes\bin\hermes.exe" gateway restart
```

**Step 2: deploy the proxy with enforcement, then restart the pilot.** The repo profile now carries
`writer_capability: "on"` and `writer_port: 8081` for the pilot.
```powershell
$out = & $ctl deploy; $out
$bk = [regex]::Match(($out -join ' '), 'backup: ([^)]+)\)').Groups[1].Value; $bk
Select-String -Path "$svc\hindsight.profiles.json" -Pattern '"writer_capability": "on"', '"writer_port": 8081'   # both present
& $ctl stop  -Profile pilot          # stops the proxy, the API AND Postgres: saves queue for about a minute (nothing is lost)
& $ctl start -Profile pilot
Start-Sleep 60
& $ctl status -Profile pilot | Select-String '"state"|health_http'                            # running / 200
```
Rollback 2 restores the previous proxy and profile:
```powershell
Copy-Item "$bk\service\*" $svc -Force
& $ctl stop -Profile pilot; & $ctl start -Profile pilot
```

**Step 3: verify.** First, one real save through the OS registers it. The Track 6 live check does this
with tagged synthetic facts and notes and removes them again. Its own browser session is minted by a page
load, which since S1 stays unconfirmed (a program to the OS), so it SKIPS the memory save and the forget
checks rather than ask for a program's approval (that would text Usman a Telegram code); the vault-note
saves still go through the capability. It stops first if an earlier run left "T6 live check" items, and
lists anything it couldn't remove in the JSON's `leftovers`:
```powershell
Set-Location $os
bun --no-env-file scripts\memory\t6-verify-live.ts --live --out "$env:TEMP\t6-verify.json"   # --live is required; unconfirmed session: 20 pass, 7 skipped
$pid81 = (Get-NetTCPConnection -LocalPort 8081 -State Listen).OwningProcess
Get-Content $log -Tail 500 | ConvertFrom-Json | Where-Object route -eq '/_mu/writer/register' | Select-Object ts, decision, client_pid -Last 3   # "allow", client_pid = $pid81
```
Second, check that **another bun process can't write**. The probe is harmless: it PATCHes a memory id
that doesn't exist. Enforced, the proxy refuses it before Hindsight sees it. If enforcement were off,
Hindsight would answer 404 and nothing would change.
```powershell
$probe = @'
const r = await fetch("http://127.0.0.1:8878/v1/default/banks/mu-shared/memories/00000000-0000-4000-8000-000000000000", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ state: "invalidated", reason: "T6 writer probe" }) });
console.log(r.status, JSON.stringify(await r.json().catch(() => null)));
'@
Set-Content -Path "$env:TEMP\t6-writer-probe.ts" -Value $probe -Encoding utf8
bun --no-env-file "$env:TEMP\t6-writer-probe.ts"          # expect: 403 {"error":"refused: writes go through AgenticOS ...","code":"writer-refused"}
Remove-Item "$env:TEMP\t6-writer-probe.ts"
```

**Quick off (any time)** turns enforcement off, back to exact Stage D behaviour. This is the rollback
for step 2's enforcement alone:
```powershell
Copy-Item "$svc\hindsight.profiles.json" "$svc\hindsight.profiles.json.bak-writer-$(Get-Date -Format yyyyMMdd-HHmmss)"
& D:\hindsight\venv\Scripts\python.exe -c "import json;p=r'D:\hindsight\service\hindsight.profiles.json';d=json.load(open(p,encoding='utf-8'));d['profiles']['pilot']['proxy']['writer_capability']='off';open(p,'w',encoding='utf-8',newline='\n').write(json.dumps(d,indent=2)+'\n')"
& $ctl stop -Profile pilot; & $ctl start -Profile pilot
```
A later `hindsightctl deploy` restores the repo's `on`. To keep it off, change the repo profile too.

What restarting the proxy does: the capability is memory-only, so after any pilot restart the OS's next
write is told to register again, and it does so automatically. Saves made while the pilot is restarting
wait in the queue, as they do today.
