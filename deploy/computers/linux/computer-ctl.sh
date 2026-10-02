#!/usr/bin/env bash
# One shared cloud computer's runtime on a Linux host: a separate desktop (its own X display, Chromium profile and
# working folder) running the same companion worker every PC runs. The SAME script runs on the WSL stand-in
# (wsl.exe -d <distro> -- bash -s -- <action> ...) and on a Sydney VPS (ssh <alias> bash -s -- <action> ...).
#
#   computer-ctl.sh check
#   computer-ctl.sh install-bundle <path-to-companion.mjs>
#   computer-ctl.sh provision <name> <display-number> <WxHxD> <vnc-port>   # needs MU_HUB_URL and MU_PAIR_CODE (and optionally MU_LABEL) in the environment
#   computer-ctl.sh start|stop|probe|shot|destroy <name>
#   computer-ctl.sh alloc <name> | alloc-bridge | alloc-list | alloc-record <name>   # the host-level allocator (needs MU_HUB_ID; see ALLOC_PY below)
#
# It installs nothing. It needs no root unless the owner asks for one Linux user per computer (MU_RUN_AS_PREFIX, below). Packages the desktop wants (Xvfb, Chromium, x11vnc, xdotool) are looked up with
# `command -v`; without them a computer still runs, headless: files and commands, no browser. The owner installs the
# packages (deploy/computers/README.md); this script never does.
#
# Layout:  $MU_COMPUTERS_HOME (default ~/mu-computers)/bin/companion.mjs       the companion (one build, shared)
#          $MU_COMPUTERS_HOME/<name>/{cfg,profile,work,run,logs}                this computer only
# Processes: each runs in its own session (setsid) so a computer's companion, Chromium and Xvfb never share a process
# group with another's. Pid files hold "pid start-time" so a recycled pid is never mistaken for ours.

set -u
ACTION="${1:-}"
NAME="${2:-}"
BASE="${MU_COMPUTERS_HOME:-$HOME/mu-computers}"
DIR="$BASE/$NAME"
BIN="$BASE/bin/companion.mjs"
NODE="${MU_NODE:-$(command -v node || true)}"

# ONE LINUX USER PER COMPUTER (optional; needs this script to run as root). With MU_RUN_AS_PREFIX=mu- each computer's processes (Xvfb, x11vnc, the companion
# and its Chromium, which keeps its own sandbox) run as the user <prefix><name>, and its folder is owned by that user with mode 700, so one computer
# cannot read another's FILES directly. That is the whole boundary: the computers share ONE WSL VM, and loopback services (the browser's debugging port, VNC,
# the X display, the hub bridge) are reachable by every user on it, so two bot computers on a host are one trust domain. This is NOT machine isolation.
# Chromium refuses to run as root unless its sandbox is switched off, and this script never switches it off.
RUN_USER=""
if [ "$(id -u)" = 0 ] && [ -n "${MU_RUN_AS_PREFIX:-}" ] && [ -n "$NAME" ]; then
  RUN_USER="${MU_RUN_AS_PREFIX}${NAME}"
  # Over 32 characters: a shortened name plus a hash of the whole name (the hash keeps two long names apart).
  if [ "${#RUN_USER}" -gt 32 ]; then RUN_USER="${MU_RUN_AS_PREFIX}$(printf %s "$NAME" | cut -c1-12)-$(printf %s "$NAME" | sha1sum | cut -c1-8)"; fi
fi
# Fail closed: as root, a computer folder owned by another user is run AS that user even when the prefix setting is missing (never as root).
if [ "$(id -u)" = 0 ] && [ -z "$RUN_USER" ] && [ -n "$NAME" ] && [ -d "$DIR" ]; then
  _o="$(stat -c %U "$DIR" 2>/dev/null)"
  case "$_o" in "" | root | UNKNOWN) ;; *) RUN_USER="$_o" ;; esac
fi
# Root-trusted state (pid files, owner key, hub id) lives in a root-owned sibling that the computer's user cannot write; without a per-computer user it is the folder itself.
if [ -n "$RUN_USER" ]; then CTL="$BASE/.ctl/$NAME"; else CTL="$DIR"; fi
# user_ok: the user exists AND its home is exactly this computer's home. User names are host-wide, so a name another hub or a person already uses is never adopted, killed or deleted.
user_ok() { [ -n "$RUN_USER" ] && [ "$(getent passwd "$RUN_USER" 2>/dev/null | cut -d: -f6)" = "$DIR/home" ]; }
user_exists() { getent passwd "$RUN_USER" >/dev/null 2>&1; }
guard_user() {
  if [ -n "$RUN_USER" ] && user_exists && ! user_ok; then echo "{\"ok\":false,\"error\":\"the user $RUN_USER exists but is not this computer's; refusing to use it\"}"; exit 3; fi
}
# as_user <cmd...>: run it as this computer's user (or as the caller when there is none).
as_user() {
  if [ -n "$RUN_USER" ]; then setpriv --reuid="$RUN_USER" --regid="$RUN_USER" --init-groups env HOME="$DIR/home" USER="$RUN_USER" LOGNAME="$RUN_USER" "$@"; else "$@"; fi
}

# A browser: the distro's chromium, else a headless browser installed for this host without root (install-browser).
CHROMIUM="$(command -v chromium 2>/dev/null || true)"
[ -n "$CHROMIUM" ] || CHROMIUM="$(ls -d "$BASE"/browser/chromium_headless_shell-*/*/chrome-headless-shell 2>/dev/null | head -1)"

json_bool() { if [ "$1" = 1 ]; then printf true; else printf false; fi; }

check_name() {
  case "$NAME" in
    "" | *[!a-z0-9-]* | -*) echo '{"ok":false,"error":"bad computer name"}'; exit 2 ;;
  esac
}

stt() { sed 's/^.*) //' "/proc/$1/stat" 2>/dev/null | awk '{print $20}'; }
record() { printf '%s %s\n' "$1" "$(stt "$1")" >"$2"; }
# OWNERSHIP. Every process of a computer is started with MU_COMPUTER_KEY=<hub>.<name>.<nonce> in its environment (cfg/owner.key, made at provision,
# never shared); Chromium inherits it from the companion. A process is this computer's only if its environment carries that exact line, so nothing
# is ever stopped by name, and a recycled pid or another hub's Xvfb is never touched. Pid files stay as a quick check (pid + start time) but a pid is
# "alive" only if it also carries the marker.
KEY=""
load_key() { KEY="$(cat "$CTL/cfg/owner.key" 2>/dev/null)"; }
owned() { [ -n "$KEY" ] && grep -qazxF -- "MU_COMPUTER_KEY=$KEY" "/proc/$1/environ" 2>/dev/null; }
owned_pids() {
  [ -n "$KEY" ] || return 0
  grep -lazxF -- "MU_COMPUTER_KEY=$KEY" /proc/[0-9]*/environ 2>/dev/null | sed -n 's|^/proc/\([0-9]*\)/environ$|\1|p' | grep -vx "$$"
}
alive() {
  [ -f "$1" ] || return 1
  local pid st
  read -r pid st <"$1" || return 1
  [ -n "${pid:-}" ] && [ -n "${st:-}" ] && [ "$(stt "$pid")" = "$st" ] && owned "$pid"
}
pidof_file() { [ -f "$1" ] && awk '{print $1}' "$1"; }

# launch <pidfile-name> <logfile> <cmd...>: detached, own session, never tied to the caller's terminal.
launch() {
  local nm="$1" log="$2"
  shift 2
  rm -f "$CTL/run/$nm.raw"
  # A computer's browser speaks English (LC_ALL/LANGUAGE): with no locale set, example.com answered in the first of its many languages and the desktop showed boxes for glyphs no installed font has.
  # WSLg exports WAYLAND_DISPLAY / XDG_SESSION_TYPE=wayland: x11vnc then refuses ("Wayland display server detected") and a browser could draw on the OWNER's desktop. A computer is X11 only.
  local priv=()
  [ -n "$RUN_USER" ] && priv=(setpriv --reuid="$RUN_USER" --regid="$RUN_USER" --init-groups env HOME="$DIR/home" USER="$RUN_USER" LOGNAME="$RUN_USER")
  # The pid is written by root into the root-owned run folder; the log is opened by the inner shell AFTER privileges are dropped, so root never opens a file in the user's folder.
  nohup setsid sh -c 'echo $$ >"$0"; exec "$@"' "$CTL/run/$nm.raw" "${priv[@]}" env -u WAYLAND_DISPLAY -u XDG_SESSION_TYPE -u MU_COMPUTER_NO_SANDBOX "MU_COMPUTER_KEY=$KEY" LC_ALL=C.UTF-8 LANGUAGE=en_AU:en sh -c 'exec >>"$0" 2>&1 </dev/null; exec "$@"' "$log" "$@" </dev/null >/dev/null 2>&1 &
  disown
  local i
  for i in 1 2 3 4 5 6 7 8 9 10; do [ -s "$CTL/run/$nm.raw" ] && break; sleep 0.1; done
  local pid
  pid="$(cat "$CTL/run/$nm.raw" 2>/dev/null)"
  [ -n "$pid" ] && record "$pid" "$CTL/run/$nm.pid"
}

# Stop exactly this computer's processes: the ones whose environment carries its marker. TERM, wait, then KILL what is left (re-read each time).
stop_owned() {
  local p i
  for p in $(owned_pids); do kill -TERM "$p" 2>/dev/null; done
  for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do [ -z "$(owned_pids)" ] && break; sleep 0.2; done
  for p in $(owned_pids); do kill -KILL "$p" 2>/dev/null; done
  # Whatever the computer's own user still runs (a helper that lost the marker) goes too, but only for a user that is provably this computer's.
  if user_ok; then pkill -KILL -u "$RUN_USER" 2>/dev/null; fi
  rm -f "$CTL"/run/*.pid "$CTL"/run/*.raw 2>/dev/null
}

cfg_get() { # key -> value from cfg/computer.json (flat string/number keys only)
  sed -n "s/.*\"$1\": *\"\{0,1\}\([^\",}]*\)\"\{0,1\}.*/\1/p" "$DIR/cfg/computer.json" 2>/dev/null | head -1
}


# ---------------------------------------------------------------------------------------------------------------------------------------------
# The host-level allocator. Display numbers and ports are HOST-wide, but several hubs (two checkouts on one PC, a test hub beside the live one)
# can run computers on one host. One lock-protected registry, $MU_ALLOC_DIR/alloc.json (flock on alloc.lock; default ~/mu-computers), hands each
# computer a display number, a VNC port and a DevTools port that no other computer of ANY hub has, and records who owns it (hub id, computer
# name, device id, directory, pids). An entry is reclaimed only when its computer directory is gone, every recorded process is provably dead
# (the pid is gone or its start time changed), and nothing on the host is using its display or ports. A stopped-but-provisioned computer keeps
# its numbers. Needs python3 (standard library only).
# ---------------------------------------------------------------------------------------------------------------------------------------------
ALLOC_PY="$(cat <<'PYEOF'
import fcntl, json, os, sys, time

cmd, args = sys.argv[1], sys.argv[2:]
adir = os.environ["MU_ALLOC_DIR"]
os.makedirs(adir, exist_ok=True)
lock = open(os.path.join(adir, "alloc.lock"), "a+")
fcntl.flock(lock, fcntl.LOCK_EX)
path = os.path.join(adir, "alloc.json")
try:
    data = json.load(open(path))
    entries = data["entries"]
except Exception:
    entries = []


def save():
    tmp = path + ".%d.tmp" % os.getpid()
    with open(tmp, "w") as f:
        json.dump({"version": 1, "entries": entries}, f, indent=1)
    os.replace(tmp, path)


def start_time(pid):
    try:
        with open("/proc/%d/stat" % int(pid)) as f:
            return f.read().rsplit(")", 1)[1].split()[19]
    except Exception:
        return None


def alive(spec):
    return start_time(spec[0]) == str(spec[1])


def table(p):
    try:
        with open(p) as f:
            return f.read()
    except Exception:
        return ""


def listening(port):
    hexp = ":%04X " % port
    for p in ("/proc/net/tcp", "/proc/net/tcp6"):
        for line in table(p).splitlines()[1:]:
            f = line.split()
            if len(f) > 3 and f[3] == "0A" and f[1].endswith(hexp.strip()):
                return True
    return False


def display_in_use(d):
    if os.path.exists("/tmp/.X11-unix/X%d" % d):
        return True
    if any(l.rstrip().endswith("@/tmp/.X11-unix/X%d" % d) for l in table("/proc/net/unix").splitlines()):
        return True
    lockf = "/tmp/.X%d-lock" % d
    if os.path.exists(lockf):
        try:
            pid = int(open(lockf).read().strip())
            if start_time(pid) is not None:
                return True
        except Exception:
            pass
    return False


def reclaim():
    keep = []
    for e in entries:
        if e.get("kind") == "bridge":
            keep.append(e)
            continue
        pids = e.get("pids", [])
        dead = not any(alive(s) for s in pids)
        gone = not os.path.isdir(e.get("dir", "/nonexistent"))
        old = (time.time() - e.get("createdAt", 0)) > 600
        busy = display_in_use(e["display"]) or listening(e["vncPort"]) or listening(e["cdpPort"])
        if gone and dead and not busy and (pids or old):
            continue
        keep.append(e)
    entries[:] = keep


def find(key):
    for e in entries:
        if e["key"] == key:
            return e
    return None


def out(**kw):
    print(json.dumps(dict(ok=True, **kw)))


def fail(msg):
    print(json.dumps({"ok": False, "error": msg}))
    sys.exit(5)


reclaim()
if cmd == "take":
    hub, name, base, adir_c = args[0], args[1], int(args[2]), args[3]
    key = hub + "/" + name
    e = find(key)
    if not e:
        used_d = {x.get("display") for x in entries if x.get("kind") != "bridge"}
        used_p = {p for x in entries for p in (x.get("vncPort"), x.get("cdpPort"), x.get("port")) if p}
        for d in range(base, base + 4000):
            v, c = 5900 + d, 9300 + d
            if d in used_d or v in used_p or c in used_p or v == c:
                continue
            if display_in_use(d) or listening(v) or listening(c):
                continue
            e = {"key": key, "hub": hub, "name": name, "display": d, "vncPort": v, "cdpPort": c, "dir": adir_c, "createdAt": time.time(), "pids": []}
            entries.append(e)
            break
        if not e:
            fail("no free display numbers on this host")
    else:
        e["dir"] = adir_c
    save()
    out(display=e["display"], vncPort=e["vncPort"], cdpPort=e["cdpPort"])
elif cmd == "record":
    hub, name, device = args[0], args[1], args[2]
    e = find(hub + "/" + name)
    if e:
        if device != "-":
            e["deviceId"] = device
        e["pids"] = [[int(p), s] for p, s in (a.split(":", 1) for a in args[3:] if ":" in a)]
        save()
    out()
elif cmd == "release":
    hub, name = args[0], args[1]
    entries[:] = [x for x in entries if x["key"] != hub + "/" + name]
    save()
    out()
elif cmd == "bridge":
    hub = args[0]
    avoid = {int(x) for x in (args[1].split(",") if len(args) > 1 and args[1] else [])}
    key = "bridge:" + hub
    e = find(key)
    if e and e["port"] in avoid:
        entries.remove(e)
        e = None
    if not e:
        used = {p for x in entries for p in (x.get("vncPort"), x.get("cdpPort"), x.get("port")) if p}
        port = next((p for p in range(8200, 8400) if p not in used and p not in avoid), None)
        if port is None:
            fail("no free bridge port")
        e = {"key": key, "kind": "bridge", "hub": hub, "port": port, "createdAt": time.time()}
        entries.append(e)
    save()
    out(port=e["port"])
elif cmd == "list":
    out(entries=entries)
else:
    fail("unknown allocator command")
PYEOF
)"
alloc_py() { MU_ALLOC_DIR="${MU_ALLOC_DIR:-$HOME/mu-computers}" python3 -c "$ALLOC_PY" "$@"; }

load_key
DISP="$(cfg_get display)"
DISP="${DISP#:}"
# computer.json lives in the computer's own folder, writable by its user: root uses these values (rm of an X lock, ports, a resolution) only after validating them.
valid_cfg() {
  case "$DISP" in "" | *[!0-9]*) return 1 ;; esac
  [ "${#DISP}" -le 4 ] || return 1
  case "${VNC:-0}" in "" | *[!0-9]*) return 1 ;; esac
  case "${RES:-1280x800x24}" in *[!0-9x]*) return 1 ;; esac
  [ -z "${RES:-}" ] || printf %s "$RES" | grep -Eq '^[0-9]{3,4}x[0-9]{3,4}x[0-9]{1,2}$'
}
RES="$(cfg_get resolution)"
VNC="$(cfg_get vncPort)"

# Is display :N accepting clients? Xvfb listens on a unix socket file under /tmp/.X11-unix AND an abstract socket of the same name. On WSLg
# hosts /tmp/.X11-unix is a READ-ONLY mount (only WSLg's :0 lives there), so the file can never be created and only the abstract socket exists;
# clients (Chromium, x11vnc) connect to that one. Either is ready. MU_X11_DIR / MU_PROC_NET_UNIX exist only so a test can point this at fixtures.
display_ready() {
  [ -S "${MU_X11_DIR:-/tmp/.X11-unix}/X$1" ] && return 0
  grep -q "@/tmp/.X11-unix/X$1$" "${MU_PROC_NET_UNIX:-/proc/net/unix}" 2>/dev/null && return 0
  return 1
}
x_ready() { display_ready "$DISP"; }

start_xvfb() {
  command -v Xvfb >/dev/null 2>&1 || return 0
  alive "$CTL/run/xvfb.pid" && return 0
  # Display numbers are host-wide. If something that is NOT this computer's Xvfb already answers on this one (another computer, another hub's, the
  # owner's), refuse: starting anyway would put this computer's browser on a stranger's screen (found in the round-3 run, two hubs on one distro).
  if display_ready "$DISP"; then XVFB_WHY="display :$DISP is already in use by another X server"; return 6; fi
  rm -f "/tmp/.X11-unix/X$DISP" "/tmp/.X$DISP-lock" 2>/dev/null
  local extra=()
  [ -w /tmp/.X11-unix ] || extra=(-nolisten unix)
  launch xvfb "$DIR/logs/xvfb.log" Xvfb ":$DISP" -screen 0 "${RES:-1280x800x24}" -nolisten tcp "${extra[@]}" -noreset
  local i
  for i in $(seq 1 60); do alive "$CTL/run/xvfb.pid" || break; x_ready && break; sleep 0.1; done
  x_ready || { XVFB_WHY="display did not start"; return 5; }
  # The socket accepts before the screen is set up; a client that connects too early (x11vnc: "screen size is bogus") exits. Wait until it answers.
  if command -v xdotool >/dev/null 2>&1; then
    for i in $(seq 1 50); do DISPLAY=":$DISP" xdotool getdisplaygeometry >/dev/null 2>&1 && return 0; sleep 0.1; done
  else
    sleep 0.5
  fi
  return 0
}

start_vnc() {
  command -v x11vnc >/dev/null 2>&1 || return 0
  alive "$CTL/run/vnc.pid" && return 0
  # Loopback only, inside this computer. The hub reaches it through a stdio tunnel (wsl.exe/ssh), never a network port.
  # WSLg exports WAYLAND_DISPLAY; x11vnc then refuses ("Wayland display server detected"), so the computer's own X session is named explicitly.
  launch vnc "$DIR/logs/vnc.log" env -u WAYLAND_DISPLAY -u XDG_SESSION_TYPE x11vnc -norc -display ":$DISP" -localhost -noipv6 -rfbportv6 -1 -rfbport "${VNC:-5901}" -forever -shared -nopw -noxdamage -quiet
}

do_stop() {
  [ -d "$CTL/run" ] || return 0
  stop_owned
}

start_companion() {
  alive "$CTL/run/companion.pid" && return 0
  [ -f "$BIN" ] || { echo '{"ok":false,"error":"companion bundle not installed"}'; exit 3; }
  [ -n "$NODE" ] || { echo '{"ok":false,"error":"node not found on this host"}'; exit 3; }
  local env_extra=()
  x_ready && env_extra+=("DISPLAY=:$DISP")
  [ -n "$CHROMIUM" ] && env_extra+=("MU_CHROMIUM=$CHROMIUM")
  # Without WAYLAND_DISPLAY Chromium opens on this computer's own X display, never on the host desktop (WSLg).
  launch companion "$DIR/logs/companion.log" env -u WAYLAND_DISPLAY -u XDG_SESSION_TYPE "${env_extra[@]}" "MU_COMPUTER_DIR=$DIR" "$NODE" "$BIN" run --config "$DIR/cfg"
}

new_key() {
  install -d -m 700 "$CTL" "$CTL/cfg" 2>/dev/null || mkdir -p "$CTL/cfg"
  KEY="${MU_HUB_ID:-hub}.$NAME.$(head -c12 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  (umask 077; printf '%s' "$KEY" >"$CTL/cfg/owner.key"; printf '%s' "${MU_HUB_ID:-hub}" >"$CTL/cfg/hub.id")
}
hub_id() { printf '%s' "${MU_HUB_ID:-$(cat "$CTL/cfg/hub.id" 2>/dev/null)}"; }
# Tell the allocator which processes this computer has now (best effort: the registry is advisory for reclaiming, the marker is the authority).
record_pids() {
  command -v python3 >/dev/null 2>&1 || return 0
  local args=() f pid st dev
  for f in companion xvfb vnc; do
    if [ -f "$CTL/run/$f.pid" ]; then read -r pid st <"$CTL/run/$f.pid"; [ -n "${pid:-}" ] && args+=("$pid:$st"); fi
  done
  dev="$(cfg_get deviceId)"
  alloc_py record "$(hub_id)" "$NAME" "${dev:--}" "${args[@]}" >/dev/null 2>&1 || true
}

case "$ACTION" in
  alloc)
    check_name
    command -v python3 >/dev/null 2>&1 || { echo '{"ok":false,"error":"python3 is needed on this host for the display allocator"}'; exit 3; }
    case "${MU_HUB_ID:-}" in "" | *[!A-Za-z0-9-]*) echo '{"ok":false,"error":"bad hub id"}'; exit 2 ;; esac
    alloc_py take "$MU_HUB_ID" "$NAME" "${MU_DISPLAY_BASE:-101}" "$DIR"
    ;;
  alloc-bridge)
    command -v python3 >/dev/null 2>&1 || { echo '{"ok":false,"error":"python3 is needed on this host for the display allocator"}'; exit 3; }
    case "${MU_HUB_ID:-}" in "" | *[!A-Za-z0-9-]*) echo '{"ok":false,"error":"bad hub id"}'; exit 2 ;; esac
    alloc_py bridge "$MU_HUB_ID" "${MU_AVOID_PORTS:-}"
    ;;
  alloc-record)
    check_name
    record_pids
    echo '{"ok":true}'
    ;;
  alloc-list)
    alloc_py list
    ;;
  display-ready)
    # internal: exit 0 when display :<NAME> is accepting clients (NAME is the display number here)
    display_ready "${2:-}"
    exit $?
    ;;
  check)
    present=()
    missing=()
    for c in Xvfb chromium x11vnc xdotool; do
      if command -v "$c" >/dev/null 2>&1; then present+=("$c")
      elif [ "$c" = chromium ] && [ -n "$CHROMIUM" ]; then present+=("chromium-headless-shell")
      else missing+=("$c"); fi
    done
    [ -n "$NODE" ] && present+=(node) || missing+=(node)
    # Fonts: without a real sans-serif family Chromium draws page text as empty boxes (found on a bare Kali). Reported like a missing package.
    if ! command -v fc-match >/dev/null 2>&1; then missing+=(fonts)
    else
      sans="$(fc-match -f '%{family}' sans-serif 2>/dev/null)"
      if [ -z "$sans" ] || printf %s "$sans" | grep -qi mono || [ "$(fc-list : family 2>/dev/null | sort -u | wc -l)" -lt 3 ]; then missing+=(fonts); else present+=(fonts); fi
    fi
    j() { local IFS=,; local out=""; for x in "$@"; do out="$out\"$x\","; done; printf '%s' "[${out%,}]"; }
    printf '{"ok":true,"host":"%s","node":"%s","uid":%s,"runAs":%s,"runAsIgnored":%s,"present":%s,"missing":%s}\n' "$(hostname)" "$([ -n "$NODE" ] && "$NODE" --version)" "$(id -u)" "$([ -n "${MU_RUN_AS_PREFIX:-}" ] && [ "$(id -u)" = 0 ] && echo true || echo false)" "$([ -n "${MU_RUN_AS_PREFIX:-}" ] && [ "$(id -u)" != 0 ] && echo true || echo false)" "$(j "${present[@]}")" "$(j "${missing[@]}")"
    ;;
  install-browser)
    # A headless Chromium for this host, into $BASE/browser, with no root: Playwright's chromium-headless-shell (about 270 MB, from
    # Playwright's CDN, not the distro). Only run when the owner asks for it (the hub never does this on its own).
    mkdir -p "$BASE/tools" || exit 2
    command -v npm >/dev/null 2>&1 || { echo '{"ok":false,"error":"npm not found on this host"}'; exit 3; }
    cd "$BASE/tools" || exit 2
    [ -f package.json ] || npm init -y >/dev/null 2>&1
    npm i --no-audit --no-fund playwright-core@1.63.0 >"$BASE/tools/npm.log" 2>&1 || { echo '{"ok":false,"error":"npm install failed"}'; exit 4; }
    PLAYWRIGHT_BROWSERS_PATH="$BASE/browser" npx playwright-core install chromium-headless-shell >>"$BASE/tools/npm.log" 2>&1 || { echo '{"ok":false,"error":"browser download failed"}'; exit 4; }
    echo '{"ok":true}'
    ;;
  install-bundle)
    src="${2:-}"
    # A relative name is resolved inside this host's computers folder (a bundle staged there by the hub), never against the caller's directory.
    case "$src" in
      *..*) echo '{"ok":false,"error":"no such bundle"}'; exit 2 ;;
      /*) ;;
      *) src="$BASE/$src" ;;
    esac
    [ -f "$src" ] || { echo '{"ok":false,"error":"no such bundle"}'; exit 2; }
    mkdir -p "$BASE/bin" && cp "$src" "$BIN.new" && mv "$BIN.new" "$BIN"
    echo '{"ok":true}'
    ;;
  provision)
    check_name
    DISP_N="${3:-}"; RES_N="${4:-1280x800x24}"; VNC_N="${5:-}"; CDP_N="${6:-}"; LABEL="${MU_LABEL:-$NAME}"
    [ -n "${MU_HUB_URL:-}" ] && [ -n "${MU_PAIR_CODE:-}" ] || { echo '{"ok":false,"error":"hub url and pairing code are required"}'; exit 2; }
    guard_user
    if [ -n "$RUN_USER" ]; then
      command -v setpriv >/dev/null 2>&1 || { echo '{"ok":false,"error":"setpriv is needed to run a computer as its own user"}'; exit 3; }
      install -d -m 755 "$BASE" "$BASE/bin" 2>/dev/null
      install -d -m 700 "$BASE/.ctl" "$CTL" "$CTL/cfg" "$CTL/run" || { echo '{"ok":false,"error":"could not prepare the computer control folder"}'; exit 3; }
      if ! user_exists; then
        useradd --no-create-home --home-dir "$DIR/home" --shell /usr/sbin/nologin --user-group "$RUN_USER" 2>"$CTL/useradd.log" || { echo '{"ok":false,"error":"could not create the computer user"}'; exit 3; }
      fi
      user_ok || { echo '{"ok":false,"error":"the computer user is not set up as expected"}'; exit 3; }
      [ -e "$DIR" ] || install -d -o "$RUN_USER" -g "$RUN_USER" -m 700 "$DIR"
      [ "$(stat -c %U "$DIR")" = "$RUN_USER" ] || { echo '{"ok":false,"error":"the computer folder is not owned by its user"}'; exit 3; }
      as_user mkdir -p "$DIR/cfg" "$DIR/profile" "$DIR/work" "$DIR/logs" "$DIR/home"
      as_user chmod 700 "$DIR" "$DIR/cfg"
    else
      mkdir -p "$DIR/cfg" "$DIR/profile" "$DIR/work" "$CTL/run" "$DIR/logs"
      chmod 700 "$DIR" "$DIR/cfg" 2>/dev/null
    fi
    [ -f "$CTL/cfg/owner.key" ] || new_key
    load_key
    [ -f "$BIN" ] || { echo '{"ok":false,"error":"companion bundle not installed"}'; exit 3; }
    # The pairing code reaches the companion through its environment (MU_PAIR_CODE), never its command line: other users on this host can read command lines.
    as_user sh -c 'exec >"$0" 2>&1 </dev/null; exec "$@"' "$DIR/logs/pair.log" "$NODE" "$BIN" pair --hub "$MU_HUB_URL" --name "$NAME" --label "$LABEL" --config "$DIR/cfg" \
      --display "$DISP_N" --resolution "$RES_N" --vnc-port "$VNC_N" ${CDP_N:+--browser-port "$CDP_N"} --workdir "$DIR/work" --profile "$DIR/profile" \
      || { echo "{\"ok\":false,\"error\":\"pairing failed: $(tr -d '\"\\\n' <"$DIR/logs/pair.log" | cut -c1-200)\"}"; exit 4; }
    echo '{"ok":true}'
    ;;
  start)
    check_name
    [ -f "$DIR/cfg/computer.json" ] || { echo '{"ok":false,"error":"not provisioned"}'; exit 2; }
    guard_user
    valid_cfg || { echo '{"ok":false,"error":"computer.json has an invalid display, port or resolution"}'; exit 2; }
    if [ -n "$RUN_USER" ]; then install -d -m 700 "$BASE/.ctl" "$CTL" "$CTL/cfg" "$CTL/run"; as_user mkdir -p "$DIR/logs"; else mkdir -p "$CTL/run" "$DIR/logs"; fi
    if [ -z "$KEY" ]; then new_key; fi
    XVFB_WHY=""
    start_xvfb || { rc=$?; echo "{\"ok\":false,\"error\":\"${XVFB_WHY:-display did not start}\"}"; exit "$rc"; }
    start_vnc
    start_companion
    record_pids
    echo '{"ok":true}'
    ;;
  stop)
    check_name
    do_stop
    echo '{"ok":true}'
    ;;
  destroy)
    check_name
    guard_user
    HUB="$(hub_id)"
    do_stop
    # Anything the computer's own user still runs (a browser helper that outlived the marker sweep) would recreate files after the folder is gone.
    if user_ok; then pkill -KILL -u "$RUN_USER" 2>/dev/null; sleep 0.3; fi
    case "$DIR" in
      "$BASE"/?*) rm -rf -- "$DIR"; [ -e "$DIR" ] && { sleep 0.5; rm -rf -- "$DIR"; } ;;
    esac
    case "$CTL" in
      "$BASE"/.ctl/?*) rm -rf -- "$CTL" ;;
    esac
    if [ -n "$RUN_USER" ] && user_exists; then
      # The user's own temp files (Chromium leaves folders in /tmp) go first, then the user; a failure is reported, never hidden.
      find /tmp -maxdepth 1 -user "$RUN_USER" -exec rm -rf -- {} + 2>/dev/null
      userdel "$RUN_USER" >/dev/null 2>&1 || { echo "{\"ok\":false,\"error\":\"the computer was removed but its user $RUN_USER could not be deleted\"}"; exit 5; }
    fi
    if [ -n "$HUB" ] && command -v python3 >/dev/null 2>&1; then alloc_py release "$HUB" "$NAME" >/dev/null 2>&1 || true; fi
    echo '{"ok":true}'
    ;;
  probe)
    check_name
    [ -d "$CTL/run" ] || { echo '{"ok":true,"companion":false,"xvfb":null,"vnc":null,"browser":false,"procs":0,"rssKb":0,"cpu":null}'; exit 0; }
    comp=0; alive "$CTL/run/companion.pid" && comp=1
    if command -v Xvfb >/dev/null 2>&1; then xv=0; alive "$CTL/run/xvfb.pid" && xv=1; xvj="$(json_bool $xv)"; else xvj=null; fi
    if command -v x11vnc >/dev/null 2>&1; then vn=0; alive "$CTL/run/vnc.pid" && vn=1; vnj="$(json_bool $vn)"; else vnj=null; fi
    br=0
    for p in $(owned_pids); do tr '\0' ' ' <"/proc/$p/cmdline" 2>/dev/null | grep -q -- "--user-data-dir=$DIR/profile" && { br=1; break; }; done
    sids=""
    for f in companion xvfb vnc; do alive "$CTL/run/$f.pid" && sids="$sids,$(pidof_file "$CTL/run/$f.pid")"; done
    procs=0; rss=0; cpu=null
    if [ -n "$sids" ]; then
      clk="$(getconf CLK_TCK 2>/dev/null || echo 100)"
      # Every process of this computer: its sessions (companion, Xvfb, x11vnc and the browser the companion started) plus any
      # browser running on this computer's profile.
      pids() { owned_pids | sort -un; }
      sample() {
        local n=0 j=0 r=0 p v
        for p in $(pids); do
          set -- $(sed 's/^.*) //' "/proc/$p/stat" 2>/dev/null)
          [ -n "${1:-}" ] || continue
          n=$((n + 1)); j=$((j + ${12:-0} + ${13:-0}))
          # PSS, not RSS: Chromium's processes share most of their pages, and summing RSS counted them several times over (4975 MB reported for a real
          # 0.9 GB computer in the round-3 run). Falls back to RSS where smaps_rollup is unreadable.
          v="$(awk '/^Pss:/ {print $2}' "/proc/$p/smaps_rollup" 2>/dev/null)"
          [ -n "$v" ] || v="$(awk '/^VmRSS:/ {print $2}' "/proc/$p/status" 2>/dev/null)"
          r=$((r + ${v:-0}))
        done
        echo "$n $r $j"
      }
      read -r n1 r1 t1 <<<"$(sample)"
      sleep 1
      read -r n2 r2 t2 <<<"$(sample)"
      procs="${n2:-0}"; rss="${r2:-0}"
      # Jiffies used in about one second, as a percentage of one core.
      cpu="$(( (${t2:-0} - ${t1:-0}) * 100 / clk ))"
    fi
    printf '{"ok":true,"companion":%s,"xvfb":%s,"vnc":%s,"browser":%s,"procs":%s,"rssKb":%s,"cpu":%s}\n' "$(json_bool $comp)" "$xvj" "$vnj" "$(json_bool $br)" "$procs" "$rss" "$cpu"
    ;;
  shot)
    check_name
    alive "$CTL/run/companion.pid" || { echo '{"ok":false,"error":"computer not running"}'; exit 2; }
    as_user "$NODE" "$BIN" shot --config "$DIR/cfg"
    ;;
  *)
    echo '{"ok":false,"error":"unknown action"}'
    exit 2
    ;;
esac
