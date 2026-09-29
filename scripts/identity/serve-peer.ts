/**
 * AUDIT-A1-3 (R3b): did this request really come through Tailscale Serve?
 *
 * Serve proxies a tailnet request to this server from 127.0.0.1 and stamps Tailscale-User-Login.
 * Any local program can send the same Host and header from 127.0.0.1, and the tailnet name and
 * people.json are not secret. So the headers are only believed when the TCP peer of the socket
 * they arrived on is Tailscale's own daemon: the connection's client end is owned by a process
 * whose image is %ProgramFiles%\Tailscale\tailscaled.exe (REVIEW-S1 R2-6: admin-only to write), running
 * in session 0 (a Windows service). A program running as the owner can't put a process in session 0
 * without elevation, and renaming or copying its own exe moves it neither there nor into Program Files.
 * (A LocalSystem alternative for other install paths was dropped, REVIEW-S1 N8: a non-elevated server
 * can't read a LocalSystem token, and whatever could pass it needs elevation anyway.)
 *
 * This is about the SOCKET. Which tailnet node a request came from (the Serve self-loop, R2-1) is a
 * per-request question, answered in remote-access.ts tailnetPerson from Serve's X-Forwarded-For.
 *
 * Windows only (this is the hub). It asks the OS directly, through bun:ffi, with no child processes:
 * iphlpapi GetExtendedTcpTable for the owning PID of the peer's end, then for that ONE pid
 * (REVIEW-S1 R2-3, where enumerating every process took ~25 ms) its image path through
 * NtQuerySystemInformation(SystemProcessIdInformation), ~0.1 ms without opening the process, and, only
 * for a tailscaled.exe image, whether it runs in session 0.
 *
 * Anything it can't establish is "not Serve": fail closed. A DEFINITIVE answer (the peer was found and
 * is, or isn't, tailscaled) is cached on the socket, since Serve keeps its connections alive. An
 * indefinite one (no table row, an FFI error, a fact the OS wouldn't give) refuses that request only
 * and is asked again next time (REVIEW-S1 R2-4), so a transient miss can't pin a Serve keep-alive
 * connection as "not Serve". Refusals are logged at most once a minute (R2-3), and a count of the
 * ones held back is flushed a minute later even if nothing else is refused (N9).
 */

export type ReqWithSocket = { socket?: { remoteAddress?: string | null; remotePort?: number; localPort?: number } | null };
export type ServePeerCheck = (req: ReqWithSocket) => boolean;
export type PeerProcess = { pid: number; name: string; sessionId: number | null; image: string | null };

/** The OS facts the check needs, one pid at a time. Null = the OS wouldn't say. Injectable for tests. */
export type PeerOs = {
  /** Owner of the loopback connection whose client end is `clientPort` and server end `serverPort`; 0 if none. */
  owningPid(v6: boolean, clientPort: number, serverPort: number): number;
  image(pid: number): string | null;
  sessionId(pid: number): number | null;
};

export type PeerVerdict = { verdict: "serve" | "not-serve" | "unknown"; why: string; peer?: PeerProcess };

const SERVE_EXE = "tailscaled.exe";
const WARN_EVERY_MS = 60_000;

/** %ProgramFiles% (both spellings a 64-bit process sees), then the default. */
export function programFilesDirs(): string[] {
  const dirs = [process.env.ProgramW6432, process.env.ProgramFiles, "C:\\Program Files"].filter((d): d is string => !!d && /^[a-z]:\\/i.test(d));
  return [...new Set(dirs.map((d) => d.replace(/[\\/]+$/, "").toLowerCase()))];
}

const baseName = (path: string) => path.slice(Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/")) + 1);

/** Is this image Tailscale's own daemon in Program Files (e.g. C:\Program Files\Tailscale\tailscaled.exe)? */
export function isInstalledTailscaled(image: string, dirs = programFilesDirs()): boolean {
  const path = image.replace(/^\\\\\?\\/, "").replace(/\//g, "\\").toLowerCase();
  if (path.includes("\\..\\") || path.includes("\\.\\")) return false;
  return dirs.some((pf) => path === `${pf}\\tailscale\\${SERVE_EXE}`);
}

/** The peer of this loopback socket, judged. Pure given `os`; exported for tests. */
export function judgePeer(req: ReqWithSocket, os: PeerOs, dirs = programFilesDirs()): PeerVerdict {
  const s = req.socket;
  const remotePort = Number(s?.remotePort);
  const localPort = Number(s?.localPort);
  const address = String(s?.remoteAddress ?? "");
  if (!remotePort || !localPort) return { verdict: "unknown", why: "a socket with no ports" };
  const v6 = address === "::1";
  if (!v6 && address !== "127.0.0.1" && address !== "::ffff:127.0.0.1") return { verdict: "not-serve", why: `a non-loopback peer (${address.slice(0, 48)})` };
  const pid = os.owningPid(v6, remotePort, localPort);
  if (!pid) return { verdict: "unknown", why: "a peer with no row in the TCP table" };
  const image = os.image(pid);
  if (!image) return { verdict: "unknown", why: `pid ${pid}, whose image this PC couldn't read` };
  const peer: PeerProcess = { pid, name: baseName(image), sessionId: null, image };
  const session = () => (peer.sessionId === null ? "session ?" : peer.sessionId < 0 ? "not session 0" : `session ${peer.sessionId}`);
  const label = () => `${peer.name} (pid ${pid}, ${session()})`;
  // Not tailscaled: refused on the image alone (a local program's connection costs one ~0.1 ms lookup).
  if (peer.name.toLowerCase() !== SERVE_EXE) return { verdict: "not-serve", why: `${peer.name} (pid ${pid})`, peer };
  peer.sessionId = os.sessionId(pid);
  if (peer.sessionId === null) return { verdict: "unknown", why: `${label()}, whose session this PC couldn't read`, peer };
  if (peer.sessionId !== 0) return { verdict: "not-serve", why: label(), peer };
  if (isInstalledTailscaled(image, dirs)) return { verdict: "serve", why: label(), peer };
  return { verdict: "not-serve", why: `${label()} at ${image.slice(0, 120)}, not Tailscale's install`, peer };
}

export type RateLimitedWarnOptions = {
  warn?: (line: string) => void;
  now?: () => number;
  /** Schedules the flush of a held-back count (tests pass their own). */
  setTimer?: (fn: () => void, ms: number) => void;
  everyMs?: number;
};

/**
 * One warning line a minute at most. Refusals held back are counted and reported on the next line, or
 * (REVIEW-S1 N9) by a flush a minute after the last line if nothing else is refused in between, so a
 * burst that ends in silence is still counted in the log.
 */
export function createRateLimitedWarn(prefix: string, opts: RateLimitedWarnOptions = {}) {
  const warn = opts.warn ?? ((line: string) => console.warn(line));
  const now = opts.now ?? Date.now;
  const every = opts.everyMs ?? WARN_EVERY_MS;
  const setTimer =
    opts.setTimer ??
    ((fn: () => void, ms: number) => {
      const t = setTimeout(fn, ms) as { unref?: () => void };
      t.unref?.();
    });
  let lastWarn = -Infinity;
  let quiet = 0;
  let flushPending = false;

  function flush() {
    flushPending = false;
    if (!quiet) return;
    warn(`${prefix} ${quiet} more refused in the last minute.`);
    lastWarn = now();
    quiet = 0;
  }

  return (message: string) => {
    const t = now();
    if (t - lastWarn < every) {
      quiet++;
      if (!flushPending) {
        flushPending = true;
        setTimer(flush, Math.max(1, lastWarn + every - t));
      }
      return;
    }
    const extra = quiet ? ` (and ${quiet} more refused in the last minute)` : "";
    lastWarn = t;
    quiet = 0;
    warn(`${prefix} ${message}${extra}.`);
  };
}

/** A socket-peer check over the given OS facts: caches definitive answers only, and rate-limits its warnings. */
export function createServePeerCheck(os: () => PeerOs, opts: RateLimitedWarnOptions & { dirs?: () => string[] } = {}) {
  const verdicts = new WeakMap<object, boolean>();
  // So a real Serve request refused here (a lock-out) shows up in the log, without flooding it.
  const log = createRateLimitedWarn("[identity] Tailscale sign-in headers ignored:", opts);
  const note = (why: string) => log(`they came from ${why}, not Tailscale Serve`);

  const check: ServePeerCheck = (req) => {
    const socket = req.socket;
    if (!socket || typeof socket !== "object") return false;
    const known = verdicts.get(socket);
    if (known !== undefined) return known;
    let result: PeerVerdict;
    try {
      result = judgePeer(req, os(), opts.dirs?.() ?? programFilesDirs());
    } catch (error) {
      result = { verdict: "unknown", why: `a peer this PC couldn't check (${String((error as Error)?.message ?? error).slice(0, 120)})` };
    }
    if (result.verdict !== "unknown") verdicts.set(socket, result.verdict === "serve");
    if (result.verdict !== "serve") note(result.why);
    return result.verdict === "serve";
  };
  return check;
}

/** The default check the identity layer uses for every Serve-looking request. */
export const relayedByTailscaleServe: ServePeerCheck = createServePeerCheck(win);

/**
 * The image path of the process on the other end of this loopback connection, or null (not Windows, not
 * loopback, or the OS wouldn't say). About a millisecond. Used to tell navigation sources apart
 * (REVIEW-S1 N1); never an identity on its own.
 */
export function peerImage(req: ReqWithSocket): string | null {
  if (process.platform !== "win32") return null;
  try {
    const s = req.socket;
    const address = String(s?.remoteAddress ?? "");
    const v6 = address === "::1";
    if (!v6 && address !== "127.0.0.1" && address !== "::ffff:127.0.0.1") return null;
    const os = win();
    const pid = os.owningPid(v6, Number(s?.remotePort), Number(s?.localPort));
    return pid ? os.image(pid) : null;
  } catch {
    return null;
  }
}

/** The process that owns the client end of this loopback connection, or null. Exported for tests. */
export function peerProcess(req: ReqWithSocket): PeerProcess | null {
  if (process.platform !== "win32") return null;
  try {
    const os = win();
    const peer = judgePeer(req, os).peer ?? null;
    if (peer && peer.sessionId === null) peer.sessionId = os.sessionId(peer.pid);
    return peer;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// The TCP table (pure, so the row match is testable with synthetic tables).

const port = (dword: number) => ((dword & 0xff) << 8) | ((dword >>> 8) & 0xff);
const IPV4_LOOPBACK = 0x0100007f;

function isV6Loopback(t: DataView, o: number) {
  for (let i = 0; i < 15; i++) if (t.getUint8(o + i) !== 0) return false;
  return t.getUint8(o + 15) === 1;
}

/**
 * The owning pid of the loopback row whose local end is `clientPort` and remote end `serverPort`, or 0.
 * MIB_TCPTABLE_OWNER_PID / MIB_TCP6TABLE_OWNER_PID: a DWORD count, then the rows.
 *   v4 row (24 bytes): state, localAddr, localPort, remoteAddr, remotePort, pid.
 *   v6 row (56 bytes): localAddr[16], localScope, localPort, remoteAddr[16], remoteScope, remotePort, state, pid.
 * Both ends must be loopback (127.0.0.1, or ::1 for v6: REVIEW-S1 R2-5), not just the ports.
 */
export function findOwningPid(t: DataView, v6: boolean, clientPort: number, serverPort: number): number {
  const n = t.getUint32(0, true);
  const rowSize = v6 ? 56 : 24;
  for (let i = 0; i < n; i++) {
    const o = 4 + i * rowSize;
    if (o + rowSize > t.byteLength) break;
    const lp = port(t.getUint32(o + (v6 ? 20 : 8), true));
    const rp = port(t.getUint32(o + (v6 ? 44 : 16), true));
    if (lp !== clientPort || rp !== serverPort) continue;
    if (v6 ? !isV6Loopback(t, o) || !isV6Loopback(t, o + 24) : t.getUint32(o + 4, true) !== IPV4_LOOPBACK || t.getUint32(o + 12, true) !== IPV4_LOOPBACK) continue;
    return t.getUint32(o + (v6 ? 52 : 20), true);
  }
  return 0;
}

// ---------------------------------------------------------------------------------------------
// Win32 through bun:ffi (loaded on first use; unavailable means fail closed).

let loaded: PeerOs | null | undefined;

/** The real Windows OS facts (throws where unavailable). Exported for tests. */
export function windowsPeerOs(): PeerOs {
  return win();
}

function win(): PeerOs {
  if (loaded === undefined) {
    try {
      loaded = process.platform === "win32" ? loadWin() : null;
    } catch {
      loaded = null;
    }
  }
  if (!loaded) throw new Error("Serve peer check unavailable");
  return loaded;
}

function loadWin(): PeerOs {
  // bun:ffi (the server runs under `bun --bun`); typed loosely so tsc needs no Bun types.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { dlopen, FFIType, ptr } = require("bun:ffi") as any;
  const ip = dlopen("iphlpapi.dll", {
    GetExtendedTcpTable: { args: [FFIType.ptr, FFIType.ptr, FFIType.i32, FFIType.u32, FFIType.u32, FFIType.u32], returns: FFIType.u32 },
  });
  const nt = dlopen("ntdll.dll", {
    NtQuerySystemInformation: { args: [FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
  });
  const k32 = dlopen("kernel32.dll", {
    ProcessIdToSessionId: { args: [FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
    QueryDosDeviceW: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.u32 },
  });
  const AF_INET = 2;
  const AF_INET6 = 23;
  const TCP_TABLE_OWNER_PID_ALL = 5;
  const ERROR_INSUFFICIENT_BUFFER = 122;
  const STATUS_INFO_LENGTH_MISMATCH = 0xc0000004;
  const SYSTEM_SESSION_PROCESS_INFORMATION = 53;
  const SYSTEM_PROCESS_ID_INFORMATION = 88;
  const wide = (text: string) => new Uint16Array([...text].map((c) => c.charCodeAt(0)).concat(0));
  const fromWide = (buf: Uint16Array, chars: number) => {
    let out = "";
    for (let i = 0; i < chars && i < buf.length; i++) out += String.fromCharCode(buf[i]);
    return out;
  };

  function table(v6: boolean): DataView | null {
    let size = 64 * 1024;
    for (let attempt = 0; attempt < 4; attempt++) {
      const buf = new Uint8Array(size);
      const sz = new Uint32Array([size]);
      const rc = ip.symbols.GetExtendedTcpTable(ptr(buf), ptr(sz), 0, v6 ? AF_INET6 : AF_INET, TCP_TABLE_OWNER_PID_ALL, 0);
      if (rc === 0) return new DataView(buf.buffer);
      if (rc !== ERROR_INSUFFICIENT_BUFFER) return null;
      size = sz[0] + 16 * 1024;
    }
    return null;
  }

  // "\Device\HarddiskVolume3\..." → "C:\...", with the drive map refreshed at most once a minute.
  let devices: { at: number; map: [string, string][] } = { at: -Infinity, map: [] };
  function dosPath(ntPath: string) {
    if (Date.now() - devices.at > 60_000) {
      const map: [string, string][] = [];
      const target = new Uint16Array(1024);
      for (let c = 65; c <= 90; c++) {
        const drive = `${String.fromCharCode(c)}:`;
        if (!k32.symbols.QueryDosDeviceW(ptr(wide(drive)), ptr(target), target.length)) continue;
        const end = target.indexOf(0);
        const dev = fromWide(target, end < 0 ? target.length : end);
        if (dev) map.push([`${dev.toLowerCase()}\\`, `${drive}\\`]);
      }
      devices = { at: Date.now(), map };
    }
    const lower = ntPath.toLowerCase();
    const hit = devices.map.find(([dev]) => lower.startsWith(dev));
    return hit ? hit[1] + ntPath.slice(hit[0].length) : ntPath;
  }

  // Pids found NOT to be in session 0, for a minute: a program looping connections through a copy of
  // tailscaled in its own session costs one enumeration per pid, not one per connection.
  const notSession0 = new Map<number, number>();

  function inSession0(pid: number): boolean | null {
    const t = Date.now();
    const until = notSession0.get(pid);
    if (until !== undefined && until > t) return false;
    let size = 512 * 1024;
    for (let attempt = 0; attempt < 4; attempt++) {
      const out = new Uint8Array(size);
      const req = new DataView(new ArrayBuffer(16)); // SYSTEM_SESSION_PROCESS_INFORMATION: SessionId, SizeOfBuf, Buffer
      req.setUint32(0, 0, true);
      req.setUint32(4, size, true);
      req.setBigUint64(8, BigInt(ptr(out)), true);
      const need = new Uint32Array(1);
      const rc = nt.symbols.NtQuerySystemInformation(SYSTEM_SESSION_PROCESS_INFORMATION, ptr(new Uint8Array(req.buffer)), 16, ptr(need)) >>> 0;
      if (rc === STATUS_INFO_LENGTH_MISMATCH) {
        size = Math.max(need[0] + 64 * 1024, size * 2);
        continue;
      }
      if (rc !== 0) return null;
      // SYSTEM_PROCESS_INFORMATION (x64): NextEntryOffset @0, UniqueProcessId @0x50.
      const dv = new DataView(out.buffer);
      for (let o = 0; o + 0x58 <= dv.byteLength; ) {
        if (Number(dv.getBigUint64(o + 0x50, true)) === pid) return true;
        const next = dv.getUint32(o, true);
        if (!next) break;
        o += next;
      }
      if (notSession0.size > 256) notSession0.clear();
      notSession0.set(pid, t + 60_000);
      return false;
    }
    return null;
  }

  return {
    owningPid(v6, clientPort, serverPort) {
      const t = table(v6);
      return t ? findOwningPid(t, v6, clientPort, serverPort) : 0;
    },
    /**
     * The image path of ONE pid, without opening the process (a non-elevated caller can't open a
     * LocalSystem service like tailscaled): SystemProcessIdInformation, about 0.1 ms.
     */
    image(pid) {
      const name = new Uint16Array(1024);
      const info = new DataView(new ArrayBuffer(24)); // SYSTEM_PROCESS_ID_INFORMATION: HANDLE pid; UNICODE_STRING ImageName
      info.setBigUint64(0, BigInt(pid), true);
      info.setUint16(8, 0, true);
      info.setUint16(10, name.byteLength, true);
      info.setBigUint64(16, BigInt(ptr(name)), true);
      if (nt.symbols.NtQuerySystemInformation(SYSTEM_PROCESS_ID_INFORMATION, ptr(new Uint8Array(info.buffer)), 24, null) !== 0) return null;
      const path = fromWide(name, info.getUint16(8, true) / 2);
      return path ? dosPath(path) : null;
    },
    /**
     * The pid's session: ProcessIdToSessionId where the caller may open it (its own processes), else
     * whether it is among session 0's processes (0, or -1 for "some other session"). Only asked for a
     * peer whose image is tailscaled.exe, so a local program's connection never pays for the enumeration.
     */
    sessionId(pid) {
      const out = new Uint32Array(1);
      if (k32.symbols.ProcessIdToSessionId(pid, ptr(out))) return out[0];
      const zero = inSession0(pid);
      return zero === null ? null : zero ? 0 : -1;
    },
  };
}
