# Jarvis desktop app: decision and status (23 Sep 2026)

Research: NotebookLM "Jarvis desktop app" (`6d3fc7c7-30c9-42f9-983c-b0a708945131`, 39 sources: Tauri 2
sidecar/tray/autostart/global-shortcut/updater/Windows-installer docs, Electron tray and session-permission
docs, builds that wrap local web apps and voice assistants).

## Shipped now: customisation (works in today's Chrome window and in any future app)

**Settings → Jarvis** (`src/components/operator/jarvis-settings.tsx`, `scripts/jarvis-settings.ts`,
`GET/POST /__operator/jarvis/settings`):
- **Spoken greeting**, used by the voice companion.
- **Your shorthand**: add or remove your own terms, on top of the built-in list.
- **Who can reach Jarvis**: name, role, Tailscale logins and Telegram IDs (`people.json`).

Safety:
- Writes are accepted **only at this PC**; a Tailscale session gets 403.
- Everything is validated before anything is written.
- One "owner" must remain, so nobody is locked out.
- `people.json.bak` keeps the previous version.
- The capability registry, and with it the Hermes skill, rebuilds straight after a save.
- Tests: `scripts/jarvis-settings.test.ts` (3/3).

Already in the voice panel, so not duplicated: voice, engine, "Hey Jarvis", "Act while I speak".
Theme: the OS is dark-only today, so a theme switch would need a light palette first (not started).

## The app itself: blocked on one owner decision

| | Tauri 2 (recommended) | Electron |
|---|---|---|
| Installer | ~3–10 MB (WebView2 ships with Windows 11) | ~80–150 MB (bundles Chromium + Node) |
| Idle RAM | ~30–50 MB (one Windows benchmark: 34 MB) | ~150–360 MB (same benchmark: 362 MB) |
| Mic without prompts | WebView2 permission handler (`PermissionKind::Microphone` → Allow) or `ICoreWebView2Profile4::SetPermissionState` | `session.setPermissionRequestHandler` / `setPermissionCheckHandler` return true for `media` |
| Tray, autostart, hotkey | `tray-icon` feature; `tauri-plugin-autostart`; `tauri-plugin-global-shortcut` | built in: `Tray`, `app.setLoginItemSettings`, `globalShortcut` |
| Supervising the Bun server | Rust keeps the `CommandChild`, restarts on `Terminated`, health-polls `/__token` with backoff | `child_process.spawn` from the main process, the same health polling |
| "Act while I speak" (browser speech API) | WebView2: **to confirm** (likely unsupported) | reported to fail ("Google blocks non-browser endpoints") |
| Build prerequisites **on this PC** | **Rust + MSVC Build Tools**: neither is installed; Build Tools need admin rights and several GB | Node/npm only (present); `electron` + `electron-builder` from npm (~100 MB) |
| Updates | `tauri-plugin-updater`, mandatory signature (`tauri signer generate`) | `electron-updater`; Authenticode signing for SmartScreen |

**Recommendation: Tauri 2.** It's what an always-on tray app should be (10× less RAM), and
the microphone permission is handled natively. The blocker is the build toolchain, not Tauri.
Electron is the fallback if you'd rather not install Visual Studio Build Tools.

The design is the same either way. The app replaces the Startup `.vbs` + PowerShell supervisor, not
wraps it:
1. At login, the tray app starts.
2. It spawns `bun --bun run start` in `AgenticOS-v4` itself (dev server, because `src/` hot-reload
   is how this OS is edited; a production build is a later step).
3. It waits for `/__token`, opens `http://localhost:8081` in its own window with the microphone
   pre-granted, registers **Ctrl+Shift+Space** as push-to-talk, and shows a green/amber/red tray
   dot from `/__operator/capabilities` and the Hermes gateway state.
4. It restarts the server if it dies (and the Hermes gateway, as the supervisor does today).

The network stays the same: loopback only, and Tailscale Serve on :8443 is untouched.
Code signing is a later step; unsigned is fine on this PC.

## What I need from you

Pick one, and I'll build it in the next session:
1. **Tauri** (recommended): install Rust (`rustup-init.exe` from rustup.rs, no admin) and the Visual
   Studio 2022 **Build Tools** with "Desktop development with C++" (admin, several GB). Both are
   official installers you run yourself.
2. **Electron**: say "go Electron". I'll add `electron` and `electron-builder` from npm (~100 MB),
   with no admin needed.

Gotchas to design for either way (from the research):
- a denied mic permission sticks in `AppData\Local\<app>\EBWebView` until that folder is reset;
- initialising a second logger crashes packaged Tauri builds silently;
- the updater exits the app before installing on Windows;
- an MSI build needs the Windows VBScript feature;
- kill the Bun tree at `bun --bun run start` (never higher), as the supervisor does now.

## Built (23 Sep 2026)

Tauri 2 tray shell, in `desktop/` at the repo root, on branch `jarvis-voice`. No frontend
build — the main window just loads `http://localhost:8081` (`desktop/shell/index.html` is an
unused static placeholder `frontendDist` needs to exist, and lives outside a folder literally
named `dist` so the repo's root `.gitignore` — which ignores any `dist/` — doesn't eat it).

### How to run it

```
cd desktop
npm install                       # installs @tauri-apps/cli v2 (devDependency)
npx tauri build                   # release exe + NSIS installer
# or, while iterating:
npx tauri build -- --no-bundle    # just the exe, skips makensis
```

Outputs (this machine, this build):
- `desktop/src-tauri/target/release/app.exe` — 10.1 MB
- `desktop/src-tauri/target/release/bundle/nsis/Jarvis_0.1.0_x64-setup.exe` — 2.6 MB

Run either one directly; no installer step is required to try it.

### What works

- **Attach, don't duplicate.** On start it checks `127.0.0.1:8081` first. If the supervisor's
  server (or a previous run's) already answers, it attaches and spawns nothing. Otherwise it
  spawns `bun --bun run start` in the repo root itself with `CREATE_NO_WINDOW`, keeps the child
  handle, and polls `/__token` (backoff, ~90s budget) before showing the window. Confirmed live:
  `bun.exe` process count and PIDs were unchanged across a whole session of launching, killing
  and relaunching the app while the supervisor's server kept running underneath.
- **Window.** Created hidden (`about:blank`) so nothing flashes a connection error; once
  `/__token` answers it's navigated to the real origin and shown. One race worth recording: the
  "already running" path can finish in under a millisecond, which can beat Tauri's own event
  loop out of the gate if you call window methods straight from the background thread that did
  the attach/poll — a few early runs showed `show()`/`is_visible()` either silently no-op or lie
  about a window that didn't visually exist. Routing the actual `navigate`/`show`/`set_focus`
  through `AppHandle::run_on_main_thread` fixed it. Confirmed live via the taskbar's own
  automation tree (`Jarvis - 1 running window`), not just Tauri's own reported state.
- **Health check host.** `/__token` is polled against `127.0.0.1`, not `localhost` — on this PC,
  resolving the literal hostname `localhost` from a plain Rust/`ureq` client (as opposed to
  WebView2, which fast-paths it) took long enough to blow every attempt's timeout. The window
  itself still loads the friendlier `http://localhost:8081`.
- **Tray.** Icon + menu (Show Jarvis / Restart OS server / Quit) via the `tray-icon` feature.
  Left-click shows and focuses the window — confirmed live by invoking the real tray icon through
  Windows' UI Automation tree and watching the OS bring `app.exe`'s window to the foreground.
  "Restart OS server" is a no-op with a native message box when this instance didn't spawn the
  server (nothing to restart, and it must never touch the supervisor's). Quit kills only the tree
  this app itself spawned, never the supervisor's; confirmed live in the (much more common)
  attach case, where Quit is correctly a no-op for the server. The spawn-and-restart path is
  reviewed but not exercised live in this session — doing so meant stopping the supervisor's
  real, currently-running server, which the brief says not to touch.
- **Single instance.** `tauri-plugin-single-instance`; a second launch focuses the existing
  window instead of opening another.
- **Global shortcut.** Ctrl+Shift+Space via `tauri-plugin-global-shortcut`. Registration failure
  is non-fatal and logged (on this PC something else already owns that combo, likely an IME
  switcher) — the app still starts, tray and window still work.
- **Microphone.** Implemented, not just left to the fallback: a `PermissionRequested` handler on
  the WebView2 core (`desktop/src-tauri/src/webview_permissions.rs`, via `WebviewWindow::with_webview`
  + `webview2-com` 0.38, pinned to the exact version tauri 2.11 itself depends on so the
  `ICoreWebView2*` types match) auto-allows only `Microphone` requests whose `Uri` starts with
  `http://localhost:8081`. Everything else — wrong kind, wrong origin, or a failure reaching the
  WebView2 core at all — falls through to WebView2's normal one-time prompt instead of being
  denied outright.
- **Icons.** Generated by the Tauri CLI (`npx tauri icon`) from `src/assets/hermes-portrait-v2.png`
  (512×512, square — `hermes-face.png` isn't square and the CLI refuses non-square sources).

### What doesn't (yet)

- No code signing (unsigned is fine on this PC, per the brief).
- No updater.
- The tray icon can leave a stale entry in Windows' notification overflow if the process is
  killed forcefully (`taskkill /F`) instead of quitting via its own Quit item — normal Windows
  behaviour for any tray app, not specific to this one; it clears on hover or on the next Explorer
  restart.

### Next step

Owner decides whether to wire up code signing before distributing the installer beyond this PC,
and whether/when to give Mehroz her own install (see below — she needs one for local desktop
*control*, not just to view the OS).

## Real install + Startup repoint, version display, starting/recovering state (27 Sep 2026, native track)

Worktree: `AgenticOS-v4-wt/w2-native`, branch `w2/native-20260927`, on top of `735256d`.

### 1. Version identity

`scripts/version.ts` (new) reads the OS's own `package.json` version + a git short SHA + a
process-start timestamp, cached per process, and exports `versionEndpoint(isLoopback)` — a
`GET /__version` handler in the exact shape of the existing `GET /__token` (loopback-only,
no-store, same-origin). It isn't wired into `vite.config.ts` itself (native doesn't own that file
per WAVE2-CONTRACT); the one-line patch for the lead is:

```ts
import { versionEndpoint } from "./scripts/version";
// next to the existing GET /__token registration:
server.middlewares.use("/__version", versionEndpoint(isLoopback));
```

`desktop/src-tauri/build.rs` reads the same two values (package.json version, git short SHA) at
*compile* time — independently, since Rust can't import the TypeScript module — and bakes them in
via `cargo:rustc-env`. `lib.rs` uses them (plus the shell's own `Cargo.toml` version) to build a
label shown in **both the window title and the tray tooltip**: confirmed live on the installed,
packaged build —
`Get-Process app | select MainWindowTitle` → `Jarvis v3.6.1 (735256d) · shell 0.1.0`.

### 2. Starting/recovering state instead of a blank window

Previously the window stayed hidden (`about:blank`) until the server answered or 90s elapsed,
then navigated and showed regardless — a slow or down server meant a window that either never
appeared or appeared showing a connection error. Now: a self-contained `data:` URL page
(`desktop/src-tauri/assets/starting.html`, built by `starting_page.rs`) shows immediately with a
spinner, the version label, and status text that escalates ("Starting…" → "Still starting (Ns)…"
past 15s → "Recovering Jarvis…" past 90s). A background thread still does the real
`attach_or_spawn()` + `wait_for_ready()` work (reusing the existing `Supervisor`, not a second
one) and, once ready, drives the actual `navigate()` to `http://localhost:8081` **from Rust**.

**Bug found and fixed during this session's live verification**: the first implementation had the
starting *page's own JavaScript* poll `/__token` and redirect itself once ready
(`window.location.href = ORIGIN`). That redirect genuinely succeeded — confirmed via the
WebView2 remote debugging port (`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=…`),
which showed the correct URL loaded — but the WebView2 *control* only ever rendered a ~15px-wide
sliver of the real page, the rest staying black. Screenshots of both the broken and fixed states
are in `docs/native-20260927/` (`01`–`04` show the bug across several relaunches; `08`/`09` show
the fix). The fix: the page never redirects itself now — it only narrates elapsed time — and the
Rust background thread does the one and only `navigate()` call once `wait_for_ready()` succeeds,
exactly like the original (pre-starting-page) design did. Regression-guarded by
`starting_page::tests::never_assigns_a_navigation_target`.

Also fixed in passing: the file logger (`tauri-plugin-log`) was gated to debug builds only, so a
packaged run left zero log evidence — the exact thing needed to diagnose the bug above. It's now
on in every build (`Info` level; this is a low-traffic tray app, not a hot loop).

### 3. Real per-user install + Startup repoint

`scripts/windows/install-jarvis-desktop.ps1` (new): builds (`npm install` + `npx tauri build` in
`desktop/`, skippable with `-SkipBuild`), runs the resulting NSIS installer silently (`/S`, per
`installMode: "currentUser"` — no admin), discovers the real install path from the per-user
uninstall registry key (not assumed), and repoints the Startup `Jarvis.lnk` at the installed
`app.exe`, printing the before/after target and rollback instructions. `-DryRun` prints the plan
without changing anything.

> **Correction (28 Sep 2026): this install never reached the real filesystem.** It ran inside
> Claude desktop's MSIX sandbox, so the new `%LOCALAPPDATA%\Jarvis\` folder was redirected into
> `%LOCALAPPDATA%\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Local\Jarvis\`. Seen from outside the
> sandbox (a WMI-launched check): no real `app.exe`, no HKCU uninstall key, the Start Menu and
> Desktop `Jarvis.lnk` pointed at the missing real path, and the Startup `Jarvis.lnk` pointed into
> the package cache, which only works while Claude's cache survives. The claims below were checked
> from inside the same sandbox, which is why they looked true. Fixed and reinstalled for real on
> 28 Sep: see "Installed for real, supervisor v2" at the end of this file.

Run for real this session (inside the sandbox; see the correction above):
- Installed to `C:\Users\Nebula PC\AppData\Local\Jarvis\app.exe` (registry `DisplayName: Jarvis`,
  `DisplayVersion: 0.1.0`, `UninstallString` recorded there for a clean uninstall).
- Startup shortcut **before**: `C:\Users\Nebula PC\source\repos\AgenticOS-v4\desktop\src-tauri\target\release\app.exe`
  (the gitignored build artifact in the MAIN tree — exactly the fragile setup `research/native-shell.md`
  flagged: nothing rebuilds it, and a `cargo clean`/repo move/disk cleanup silently breaks login autostart).
- Startup shortcut **after**: `C:\Users\Nebula PC\AppData\Local\Jarvis\app.exe` (the real installed copy).
- Rollback: point `Jarvis.lnk` back at the old target above, or run
  `install-autostart.ps1 -Remove` to drop the Startup item entirely (only affects this shortcut —
  the separate PowerShell OS supervisor's own Startup item is untouched).

### 4. Packaged-build checks (not dev) — results

All done against the real installed `%LOCALAPPDATA%\Jarvis\app.exe`, attaching to the live,
already-running `:8081` server (never spawned or restarted it; supervisor untouched).

| Check | Result | How verified |
|---|---|---|
| Launches, loads the OS from 127.0.0.1:8081 | ✅ | Screenshots `07`→`09`; WebView2 CDP target URL confirmed `http://localhost:8081/workspace` |
| Window shows version | ✅ | `MainWindowTitle` = `Jarvis v3.6.1 (735256d) · shell 0.1.0`, live |
| Starting/recovering state (not blank) | ✅ | Screenshot `01` shows the real "Still starting (35s)…" message live |
| Microphone permission handler installs | ✅ | Packaged-run log line: `microphone auto-grant installed for http://localhost:8081` |
| External links open in the default browser | ✅ | Triggered `window.open('https://example.com/…')` inside the loaded page via CDP `Runtime.evaluate`; a new Chrome window titled "Example Domain" opened; log line `external links now open in the default browser` confirmed the handler installed |
| Closing keeps the process alive (hides to tray) | ✅ | Sent `WM_CLOSE`; process stayed running |
| Reopening restores the same window/state | ✅ | Relaunching `app.exe` re-showed the *same* PID's window (single-instance plugin), same session, nothing reloaded |
| Clipboard write mechanism | Partially — see below | `navigator.clipboard.writeText()` from an *untrusted* script context (CDP `Runtime.evaluate`, no user gesture) did not change the clipboard — correct default Chromium behaviour, and confirms no broad/unusual permission was granted for it |
| File dialog mechanism | Partially — see below | An untrusted `<input type="file">.click()` (same CDP context) threw no error but opened no picker — same reasoning: Chromium requires a trusted user gesture, which a real click provides and a script call does not |

**Clipboard and file dialog need the owner at the desk**: both are implemented with zero Tauri
plugins and zero extra permissions (`capabilities/default.json` is still exactly `core:default` —
confirmed unchanged; no `clipboard-manager`, `dialog`, `fs`, or `shell` plugin was added to
`Cargo.toml`), relying entirely on WebView2/Chromium's own `navigator.clipboard` and
`<input type="file">` behaviour. That's deliberate — it's the same "no broad shell/fs
permissions" brief this app has followed from the start. A real click from a real user is exactly
what those browser APIs require and what an automated agent session correctly cannot fake. The
owner clicking an actual copy button and an actual file picker inside the running installed app
would close this out; nothing in the code should need to change for it to work.

### 5. Does Mehroz need her own install?

**Yes, for control — not just to look at the OS.** This shell (`app.exe`) is a *viewer/launcher*:
it hosts a window pointed at a Bun server and does two small pieces of native work scoped to that
window (microphone pre-grant, external-link handoff). It has no code that reaches out and
controls a *different* machine. The devices track's own contract
(`resolveTarget(ctx) => { deviceId, owner, online } | { ok: false }`) confirms the intended shape:
Jarvis resolves *which* machine a command targets and must route to an agent already running
*there* — there's no remote-execution path implied that would let Usman's installed copy reach
into Mehroz's keyboard/mouse/screen. Native automation is inherently local: whatever executes
"click this" or "type that" on Mehroz's desktop has to be a process running on Mehroz's desktop.

**Can the same Tauri package host that companion, as a sidecar?** Recommend yes, with a specific
shape: add a **second, headless binary target** to the existing `desktop/src-tauri` Cargo project
(or a Rust crate shared between it and a new one) rather than a separate framework/app. Reasons:
- Nothing in `tauri.conf.json` is hardcoded to this PC (`identifier`, `productName`,
  `installMode: "currentUser"` are all generic) — confirmed in `research/native-shell.md` §8 and
  unchanged this session — so the *viewer* half already builds an equivalent installer for Mehroz
  as-is via `install-jarvis-desktop.ps1` on her machine.
- The *control* half (devices track's `companion/**`) would otherwise have to re-solve problems
  already solved here this session: a per-user NSIS installer with no admin, a Windows process
  that's safe to autostart and supervise, and (per the WebView2 lessons above) how to drive a
  WebView2/native window correctly if the companion ever needs its own UI (a pairing screen, a
  status tray icon). Reusing this crate's `supervisor.rs`-style process-ownership pattern (never
  touch a process you didn't spawn) is directly applicable to a companion that also needs to know
  whether it's the one that started something.
- It should **not** be the same binary/window: this shell's job (show the OS) and the companion's
  job (sit headless, listen for routed commands, execute local automation) are different enough
  that bundling them into one always-visible window would violate the "scoped to what's needed"
  spirit of this track's own capabilities work.

This is a recommendation for the devices track to build, not something implemented here —
`companion/**` stays theirs per WAVE2-CONTRACT.

### 6. Evidence

Screenshots: `docs/native-20260927/01` through `09` (chronological — `01`/`02`/`04`/`06` show the
starting-page-redirect bug across several relaunches; `05` shows CDP confirming the URL was
actually correct even while the window looked broken; `07`–`09` show the fixed packaged app fully
rendering the live workspace, including a real "Owner approvals" panel and the operator profile
picking up "Usman"). All against synthetic/already-authenticated local session state — no private
data was read or exported to capture these.

## Installed for real, supervisor v2 (28 Sep 2026, branch `f/native-perf-20260928`)

Stage A review fixes. Shell version 0.2.0.

### What was wrong

| # | Finding | Fix |
|---|---|---|
| C1 | Installed only inside Claude desktop's MSIX sandbox (see the correction in §3) | `install-jarvis-desktop.ps1` refuses when `%LOCALAPPDATA%` writes are redirected and prints the WMI command to run it outside. Reinstalled for real via WMI. |
| C2 | `Command::new("bun")` was NotFound (only npm's `bun.cmd`/`bun.ps1` shims are on PATH), so the app spun on "Recovering…" forever | `config.rs::resolve_bun`: `JARVIS_BUN`/config, `%APPDATA%\npm\node_modules\bun\bin\bun.exe`, `~\.bun\bin\bun.exe`, then `bun.exe` on PATH. Never a shim. |
| H3 | Repo root baked in at compile time (`CARGO_MANIFEST_DIR`: the installed binary pointed at `AgenticOS-v4-wt\w2-native`) | Runtime config: `JARVIS_REPO_ROOT`, then `~\.jarvis-desktop\config.json` (written by the installer), then `~\source\repos\AgenticOS-v4`. Sanity check: main checkout (not a linked worktree), `package.json` + `vite.config.ts` + a `start` script, on `jarvis-voice` (another branch is a logged warning). |
| H4 | Respawn sat behind the readiness gate, so a server that died during boot was never respawned | One loop (`Supervisor::run`) owns attach, spawn, respawn and every navigation. Bounded: 5 restarts per 10 minutes, backoff 2/4/8/16/30 s, then a "stopped" screen with the reason, the next automatic try and the `server.log` path. The tray's "Restart OS server" resets the budget. A hung boot (port still closed after 180 s) is killed and counted. An attached server that dies is adopted after 20 s (time for the PowerShell supervisor to bring it back); `--strictPort` makes any race fail loudly. |
| M4 | Title baked in the build machine's HEAD, with no dirty marker | Title and tray tooltip come from the running server's `/__version` (`dirty` added there): `Jarvis v3.6.1 (264dd50) · shell 0.2.0`. The shell's own build SHA (`-dirty` aware) is logged. |
| M5 | A WebView2 error page never retried | `nav_watch.rs` records `NavigationCompleted` failures for app URLs (cancelled external-link navigations are ignored); the loop shows the recovery screen and retries with backoff. When the server stops answering (port closed 5 s, or port open but `/__token` silent for 30 s), the window shows the recovery screen and returns to the page it was on. |
| — | Server output went to null | Piped into `%LOCALAPPDATA%\au.com.muventures.jarvis\logs\server.log`, rotated at 5 MB × 3. |
| — | An app-spawned server opened a browser tab | `BROWSER=none`. |
| — | `AGENTIC_OS_NO_BACKGROUND=1` still bound 8091 | A quiet copy no longer starts the lead-preview listener (`scripts/lead-sites/plugin.ts`, test `plugin-quiet.test.ts`). |

The starting/recovery page is driven entirely from Rust: it's navigated to with the status baked
in, and updated in place through `window.__jarvisStatus(...)` via `eval`. It still never navigates
itself (see §2 for why).

### Config file

`~\.jarvis-desktop\config.json` (under the profile root on purpose: new folders under
`%LOCALAPPDATA%`/`%APPDATA%` are redirected when created from an agent session):

```json
{ "repoRoot": "C:\Users\Nebula PC\source\repos\AgenticOS-v4", "port": 8081 }
```

Test-only fields: `bun`, `branch`, `allowWorktree`, `env`, `extraArgs`, `instance` ("test" skips the
single-instance lock and the global shortcut, uses its own WebView2 profile `EBWebView-test` and
`server-test.log`). `JARVIS_DESKTOP_CONFIG` points the app at another file. On port 8081 the app
runs exactly `bun --bun run start`; on any other port, `bun --bun run dev --port N --strictPort`.

### Install (done 28 Sep, 03:21, outside the sandbox)

```powershell
Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine =
  'powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "<repo>\scripts\windows\install-jarvis-desktop.ps1" -SkipBuild' }
```

Checked from a separate WMI-launched process (the real filesystem, not the sandbox's view):
- `C:\Users\Nebula PC\AppData\Local\Jarvis\app.exe` exists (11,054,592 bytes); HKCU uninstall key
  `Jarvis 0.2.0`, `InstallLocation` = that folder.
- Startup `Jarvis.lnk`, Start Menu `Jarvis.lnk` and Desktop `Jarvis.lnk` all target it (they
  targeted the package cache or a missing path before).
- Running: `app.exe` from that path, window title `Jarvis v3.6.1 (264dd50) · shell 0.2.0`, attached
  to the live 8081 ("port 8081 already accepting connections — attaching, not spawning"). UI
  Automation on its WebView2 document `Today — Agentic OS` finds all 8 destinations (Today, Jarvis,
  Receptionist, Work, Memory, Finance, Studio, System).
- Backups: `~\.jarvis-desktop\backup\20260928-031620\` (the old package-cache `app.exe` and the
  three old shortcuts, with `manifest.txt`) and `…\20260928-032159\`. The old package-cache copy
  is left in place, but nothing references it any more.

### Supervisor test on a preview port (live 8081 untouched)

A second, test instance (`JARVIS_INSTANCE=test` config, port 8119, its own temporary worktree,
`AGENTIC_OS_NO_BACKGROUND=1` + `ARGENTIC_PREVIEW=1`, launched via WMI with a WebView2 debug port
for inspection):
1. **Spawn:** nothing on 8119, so it spawned `…\bun\bin\bun.exe --bun run dev --port 8119
   --strictPort --configLoader native`. The status page showed "Starting the OS server on
   127.0.0.1:8119 (70s)".
2. **Dies during boot (H4):** the server tree was killed 2 s after spawn, before it bound the port.
   Log: `server exited (exit code 1)`, then `spawned pid 258076` 4 s later. Vite came up
   ("ready in 72074 ms", captured in `server-test.log`). The window navigated to
   `http://localhost:8119/`, with title `[test] Jarvis v3.6.1 (3d4cf7f) · shell 0.2.0` and all 8
   destinations.
3. **Dies while in use (M5):** killed on `/finance`. The log shows WebView2 navigation failures
   (status 0/9), `server exited`, an immediate respawn (the budget had reset after 120 s healthy),
   and `server stopped answering; showing the recovery screen`. The window came back to
   `http://localhost:8119/finance`.
4. **Crash loop (bounded):** with `bun` pointed at an exe that always exits, the screen counted
   "Restarting in 4s (restart 3 of 5)" … "restart 5 of 5", then stayed on "Jarvis stopped
   restarting the OS server … Next try in about 9 min … Server output: …\server-test.log"
   (`docs/native-perf-20260928/desktop/03-bounded-restarts-stopped.png`).

Two bugs found by this test and fixed: a busy dev server (a cold transform stalling `/__token` for
~4 s) flipped the window to the recovery screen, so there's now a 30 s grace while the port is open.
And after the budget ran out, the screen went back to "Restarting in 454s", so it now stays
"stopped".

Rust tests: `cargo test --release` in `desktop/src-tauri`, 18 passing (config resolution, the repo
sanity check, the real-exe-only bun check, server args, restart budget and backoff, log rotation,
version label, port-scoped app URLs, starting-page escaping).

## Track 8 recheck and fixes (28 Sep 2026, branch `f/t8-reliability-20260928`)

### What the live recheck found (read-only, outside the sandbox via WMI)
- **Installed:** `%LOCALAPPDATA%\Jarvis\app.exe` is **0.2.0** (11,054,592 bytes, 28 Sep 03:21), HKCU uninstall
  `Jarvis 0.2.0`, and the Startup, Start Menu and Desktop `Jarvis.lnk` all target it. The running PID's title
  says `shell 0.2.0`. A check made *inside* Claude desktop's sandbox sees the package-cache copy instead
  (0.1.0, 27 Sep 19:42): that is where "the installed shell is 0.1.0" came from. Check from outside, e.g.
  `Invoke-CimMethod Win32_Process Create` running a script that reads the file's VersionInfo.
- **`where.exe` as bun** in `server-test.log` / `Jarvis.log` is the native-perf crash-loop test, not a
  bug: `~\.jarvis-native-check\test-crashloop.json` sets `"bun": "C:/Windows/System32/where.exe"` to force
  the bounded-restart screen (§ "Supervisor test on a preview port", step 4). The installed app logs
  `bun = ...\npm\node_modules\bun\bin\bun.exe`.
- **Title stale:** `43ec3c8-dirty` while `/__version` said `f334ab7`: the title was read once per
  up-period, and a fast-forward that Vite picks up without a restart never reached it.
- **Two supervisors raced:** at 09:43:53 the app adopted after 20 s and started a server 4 s before the
  PowerShell supervisor did; the loser ran ~8.5 min, then exited 1.
- **Recovery screen every 1-2 min from 11:52:** `/__token` took >10 s on 22 of 90 probes (max 30 s).
  Cause: `GET /__operator/state` (polled every 15 s by the sidebar on every page) re-read and re-parsed
  a 54 MB `.operator-data/workspace.json` per request and sent 8.2 MB (one GET 17 s, the next >60 s).
  Fixed server-side in `scripts/workspace-state-cache.ts` (one parse per file version for read paths).

### Changed
- `supervisor.rs`: `VersionWatch` re-reads `/__version` every 30 s while healthy; the title and tray change
  only when it does. While the PowerShell supervisor's mutex (`Local\AgenticOSSupervisor`, 8081 only)
  exists, an attached server that dies is left to it for 180 s (its 60 s poll + 90 s boot wait), and the
  recovery screen says so; with no mutex the app still adopts after 20 s. A spawned server that hangs
  after a healthy spell is now timed from when it stopped answering (it was never killed before). An
  explicit `JARVIS_BUN`/`"bun"` that isn't a real `bun.exe` is logged.
- Test-only config: `supervisorMutex` (a name, or `""` for none) and `timings.{adoptGraceSecs,
  externalGraceSecs, bootTimeoutSecs, stableAfterSecs, versionRefreshSecs}`.
- `agentic-os-supervisor.ps1`: doesn't start a second copy while a `bun ... --port 8081` started in the
  last 3 min is booting; GETs `/__version` (10 s timeout) every poll and, after 5 consecutive failures,
  kills only the bun tree rooted at the port's listener; at most 3 such restarts in 30 min, then it logs
  and leaves a hung server alone. Parameters (`-Port -Repo -NoGateway -PollSeconds ...`) let a test copy
  run elsewhere with its own mutex.
- Not done, on purpose: a Job Object that kills the app's server when the app is force-killed. The next
  app start attaches to that server (port open), which keeps the OS up; killing it would take the OS down
  with a crashed window.

### Evidence (`MU-Workspace/memory/master-v3/t8-reliability-20260928/raw/desktop-test/`)
- `cargo test --release`: 25 pass (7 new). `tauri build --no-bundle` OK.
- Rebuilt exe as a test instance on 8131 against a fake server (`fake.ts`), via WMI: title
  `aaaa111 -> bbbb222` with no restart; with a stand-in supervisor mutex the app didn't spawn for 12 s and
  re-attached when the other side brought the server back, then adopted after the 25 s test grace; an
  owned server that exited was respawned; one that hung (port closed, process alive) was killed after
  16 s and respawned; with no mutex it adopted after the 5 s test grace (`transcript.txt`,
  `jarvis-log-during-test.txt`).
- Supervisor copy on 8132 (`run-supervisor-test.ps1`, `supervisor-test-log.txt`): a stalled server
  (listening, never answering) was restarted after 3 failed 2 s probes, twice; the third stall was left
  alone by the cap; a server that exited was restarted. 8081 and the live supervisor were untouched.

### Install and relaunch (after review; NOT done by Track 8)
1. Merge the branch into `jarvis-voice` (the live checkout).
2. **Supervisor:** the running copy keeps the old code until restarted. From a normal PowerShell window
   (not a Claude PowerShell tool, whose own command line would match `agentic-os-supervisor`), stop it, then start the Startup item outside any Claude job:
   ```powershell
   Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object CommandLine -match 'agentic-os-supervisor' | Invoke-CimMethod -MethodName Terminate
   Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = 'wscript.exe "C:\Users\Nebula PC\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup\Agentic OS.vbs"' }
   ```
   It finds 8081 listening and answering, so it restarts nothing; check `.operator-data\supervisor.log`
   for `supervisor started (... probe /__version 10s x 5)`.
3. **Desktop app: build 0.2.1 and install it (review T8 F3).** Do NOT use `-SkipBuild`: no 0.2.1 installer
   exists yet, and the main tree's installer folder still holds the 23 Sep `Jarvis_0.1.0_x64-setup.exe`,
   which `-SkipBuild` used to pick up (a downgrade over the installed 0.2.0). The script now refuses any
   installer whose version isn't the one in `desktop/src-tauri/tauri.conf.json` (0.2.1), and checks the
   installed exe's version afterwards, but the build itself is still needed:
   - It needs network (`npm install` in `desktop/`, then `npx tauri build`, several minutes). Run it
     outside the Claude sandbox, from a normal PowerShell window:
     ```powershell
     Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine =
       'powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "C:\Users\Nebula PC\source\repos\AgenticOS-v4\scripts\windows\install-jarvis-desktop.ps1"' }
     ```
     Its transcript is `~\.jarvis-desktop\install-*.log`. It backs up the current exe and shortcuts first.
   - **Verify the build, not just the number.** `(Get-Item "$env:LOCALAPPDATA\Jarvis\app.exe").VersionInfo.ProductVersion`
     is `0.2.1`; and once the app starts, `%LOCALAPPDATA%\au.com.muventures.jarvis\logs\Jarvis.log` has
     `shell 0.2.1 (<sha>)`, where `<sha>` equals `git -C "C:\Users\Nebula PC\source\repos\AgenticOS-v4" rev-parse --short HEAD`
     at build time (a `-dirty` suffix means `desktop/` had uncommitted changes). The window title ends
     `· shell 0.2.1`.
   - Quitting the running app does not stop 8081 (it attached, it didn't spawn).
   - From 0.2.1 the app and this supervisor never both start a server: while the supervisor runs, the app
     leaves the start to it (for up to 180 s), and while the app owns a server it started, it holds
     `Local\JarvisAppServer-8081` and the supervisor leaves restarts and hang-kills to it.
4. **NotebookLM keepalive:** nothing to install; the task runs the main tree's `.vbs`, so after the merge
   its Last Run Result is the refresh's real exit code. The owner still has to sign in again.
