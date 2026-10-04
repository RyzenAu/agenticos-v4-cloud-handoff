import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { join } from "node:path";
import {
  createRateLimitedWarn,
  createServePeerCheck,
  findOwningPid,
  isInstalledTailscaled,
  judgePeer,
  peerProcess,
  relayedByTailscaleServe,
  windowsPeerOs,
  type PeerOs,
  type ReqWithSocket,
} from "./serve-peer";

/**
 * REVIEW-S1 R2-3 .. R2-6: the socket peer check (is the other end of this loopback connection Tailscale's
 * own daemon?). A fake OS drives the logic; the Windows tests at the end use the real one, read-only.
 */

const PF = ["c:\\program files"];
const TAILSCALED = "C:\\Program Files\\Tailscale\\tailscaled.exe";
const PEER_PORT = 50123;
const sock = (port = PEER_PORT, remoteAddress = "127.0.0.1") => ({ socket: { remoteAddress, remotePort: port, localPort: 8081 } });

/** A fake OS: one process at pid 4242 with the given facts, and call counters. */
function fakeOs(facts: { image?: string | null; session?: number | null; pid?: number }, calls = { pid: 0, image: 0, session: 0 }) {
  const os: PeerOs = {
    owningPid: () => (calls.pid++, facts.pid ?? 4242),
    image: () => (calls.image++, facts.image === undefined ? TAILSCALED : facts.image),
    sessionId: () => (calls.session++, facts.session === undefined ? 0 : facts.session),
  };
  return { os, calls };
}

describe("R2-6 / N8: tailscaled is recognised by its install location and session 0, not just its name", () => {
  test("Program Files' tailscaled.exe in session 0 is Serve", () => {
    expect(judgePeer(sock(), fakeOs({}).os, PF).verdict).toBe("serve");
    expect(isInstalledTailscaled(TAILSCALED, PF)).toBe(true);
    expect(isInstalledTailscaled("\\\\?\\C:\\Program Files\\Tailscale\\tailscaled.exe", PF)).toBe(true);
    for (const fake of ["C:\\Users\\me\\tailscaled.exe", "C:\\Program Files\\Tailscale\\..\\Evil\\tailscaled.exe", "C:\\Program Files\\Tailscale\\sub\\tailscaled.exe", "D:\\Program Files\\Tailscale\\tailscaled.exe", "\\Device\\HarddiskVolume3\\Program Files\\Tailscale\\tailscaled.exe"])
      expect([fake, isInstalledTailscaled(fake, PF)]).toEqual([fake, false]);
  });

  test("N8: a tailscaled.exe copy elsewhere is refused outright, even in session 0 (no LocalSystem branch)", () => {
    const copy = "C:\\Users\\me\\AppData\\Local\\Temp\\tailscaled.exe";
    expect(judgePeer(sock(), fakeOs({ image: copy }).os, PF)).toMatchObject({ verdict: "not-serve", why: expect.stringContaining("not Tailscale's install") });
    const src = readFileSync(join(import.meta.dir, "serve-peer.ts"), "utf8");
    expect(src).not.toMatch(/isLocalSystem|OpenProcessToken|IsWellKnownSid/);
  });

  test("the real tailscaled binary run in a user's session is not Serve", () => {
    expect(judgePeer(sock(), fakeOs({ session: 1 }).os, PF).verdict).toBe("not-serve");
    expect(judgePeer(sock(), fakeOs({ session: -1 }).os, PF)).toMatchObject({ verdict: "not-serve", why: expect.stringContaining("not session 0") });
  });
});

describe("R2-3: cheap for a local program's connections, and quiet in the log", () => {
  test("a non-tailscaled peer is refused on its image alone: its session is never looked up", () => {
    const { os, calls } = fakeOs({ image: "C:\\Users\\me\\bin\\curl.exe" });
    expect(judgePeer(sock(), os, PF)).toMatchObject({ verdict: "not-serve", why: "curl.exe (pid 4242)" });
    expect(calls).toEqual({ pid: 1, image: 1, session: 0 });
  });

  test("the Windows layer looks up one pid; it no longer enumerates every process through WTS", () => {
    const src = readFileSync(join(import.meta.dir, "serve-peer.ts"), "utf8");
    expect(src).not.toContain("WTSEnumerateProcesses");
    expect(src).toContain("SystemProcessIdInformation");
  });

  test("refusals are logged at most once a minute, with a count of the quiet ones", () => {
    let t = 1_000_000;
    const lines: string[] = [];
    const check = createServePeerCheck(() => fakeOs({ image: "C:\\x\\bun.exe" }).os, { warn: (l) => lines.push(l), now: () => t, dirs: () => PF });
    for (let i = 0; i < 100; i++) expect(check(sock(PEER_PORT + i))).toBe(false);
    expect(lines).toHaveLength(1);
    t += 61_000;
    expect(check(sock(PEER_PORT + 500))).toBe(false);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("and 99 more refused in the last minute");
  });

  test("N9: a burst that ends in silence is still counted: the held-back count is flushed a minute later", () => {
    let t = 5_000_000;
    const lines: string[] = [];
    const timers: { fn: () => void; ms: number }[] = [];
    const check = createServePeerCheck(() => fakeOs({ image: "C:\\x\\curl.exe" }).os, { warn: (l) => lines.push(l), now: () => t, dirs: () => PF, setTimer: (fn, ms) => void timers.push({ fn, ms }) });
    for (let i = 0; i < 50; i++) check(sock(PEER_PORT + i));
    expect(lines).toHaveLength(1);
    expect(timers).toHaveLength(1); // one flush scheduled for the whole burst
    expect(timers[0].ms).toBeLessThanOrEqual(60_000);
    t += 60_000;
    timers[0].fn();
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("49 more refused in the last minute");
    timers[0].fn(); // nothing more to report
    expect(lines).toHaveLength(2);
  });

  test("N9: the flush timer is unref'd by default, so it never keeps a process alive", () => {
    const warn = createRateLimitedWarn("[t]", { warn: () => {} });
    const real = globalThis.setTimeout;
    let unrefd = false;
    (globalThis as any).setTimeout = (fn: () => void, ms: number) => {
      const h = real(fn, ms) as any;
      const orig = h.unref?.bind(h);
      h.unref = () => ((unrefd = true), orig?.());
      return h;
    };
    try {
      warn("first");
      warn("second");
    } finally {
      (globalThis as any).setTimeout = real;
    }
    expect(unrefd).toBe(true);
  });
});

describe("R2-4: only definitive answers are cached on the socket", () => {
  const quiet = { warn: () => {}, dirs: () => PF };

  test("an exception refuses that request only; the next request on the same socket is checked again", () => {
    let fail = true;
    const { os, calls } = fakeOs({});
    const check = createServePeerCheck(() => {
      if (fail) throw new Error("table race (synthetic)");
      return os;
    }, quiet);
    const req = sock();
    expect(check(req)).toBe(false);
    fail = false;
    expect(check(req)).toBe(true);
    expect(check(req)).toBe(true);
    expect(calls.pid).toBe(1); // the positive answer is cached
  });

  test("no table row, or an image or session the OS wouldn't give: refused, not cached", () => {
    for (const facts of [{ pid: 0 }, { image: null }, { session: null }]) {
      const { os, calls } = fakeOs(facts);
      const check = createServePeerCheck(() => os, quiet);
      const req = sock();
      expect(check(req)).toBe(false);
      expect(check(req)).toBe(false);
      expect([JSON.stringify(facts), calls.pid]).toEqual([JSON.stringify(facts), 2]);
    }
  });

  test("a definitive 'not tailscaled' is cached for the socket", () => {
    const { os, calls } = fakeOs({ image: "C:\\x\\curl.exe" });
    const check = createServePeerCheck(() => os, quiet);
    const req = sock();
    expect([check(req), check(req), check(req)]).toEqual([false, false, false]);
    expect(calls.pid).toBe(1);
  });
});

describe("R2-5: the IPv6 row match requires ::1 at both ends, not just the ports", () => {
  const be = (n: number) => ((n & 0xff) << 8) | ((n >> 8) & 0xff); // network-order port in a DWORD
  function v6Table(rows: { local: number[]; remote: number[]; lp: number; rp: number; pid: number }[]) {
    const view = new DataView(new ArrayBuffer(4 + rows.length * 56));
    view.setUint32(0, rows.length, true);
    rows.forEach((r, i) => {
      const o = 4 + i * 56;
      r.local.forEach((b, j) => view.setUint8(o + j, b));
      view.setUint32(o + 20, be(r.lp), true);
      r.remote.forEach((b, j) => view.setUint8(o + 24 + j, b));
      view.setUint32(o + 44, be(r.rp), true);
      view.setUint32(o + 52, r.pid, true);
    });
    return view;
  }
  const loop6 = [...Array(15).fill(0), 1];
  const other6 = [0xfd, 0x7a, 0x11, 0x5c, 0xa1, 0xe0, ...Array(9).fill(0), 1];

  test("a non-loopback row with the same port pair is skipped; the ::1 row is found", () => {
    const t = v6Table([
      { local: other6, remote: other6, lp: PEER_PORT, rp: 8081, pid: 111 },
      { local: loop6, remote: other6, lp: PEER_PORT, rp: 8081, pid: 112 },
      { local: other6, remote: loop6, lp: PEER_PORT, rp: 8081, pid: 113 },
      { local: loop6, remote: loop6, lp: PEER_PORT, rp: 8081, pid: 222 },
    ]);
    expect(findOwningPid(t, true, PEER_PORT, 8081)).toBe(222);
    expect(findOwningPid(v6Table([{ local: other6, remote: other6, lp: PEER_PORT, rp: 8081, pid: 111 }]), true, PEER_PORT, 8081)).toBe(0);
  });

  test("IPv4 still requires 127.0.0.1 at both ends", () => {
    const view = new DataView(new ArrayBuffer(4 + 2 * 24));
    view.setUint32(0, 2, true);
    const row = (i: number, local: number, remote: number, pid: number) => {
      const o = 4 + i * 24;
      view.setUint32(o + 4, local, true);
      view.setUint32(o + 8, be(PEER_PORT), true);
      view.setUint32(o + 12, remote, true);
      view.setUint32(o + 16, be(8081), true);
      view.setUint32(o + 20, pid, true);
    };
    row(0, 0x0501a8c0, 0x0100007f, 111); // 192.168.1.5 → 127.0.0.1
    row(1, 0x0100007f, 0x0100007f, 222);
    expect(findOwningPid(view, false, PEER_PORT, 8081)).toBe(222);
  });
});

describe.if(process.platform === "win32")("the real Windows peer check (read-only OS queries)", () => {
  async function onRealSocket(host: string, fn: (req: IncomingMessage) => void) {
    const probe = createServer((r, s) => {
      fn(r);
      s.end("ok");
    });
    await new Promise<void>((r) => probe.listen(0, host, () => r()));
    const port = (probe.address() as { port: number }).port;
    const warn = console.warn;
    console.warn = () => {};
    try {
      for (let i = 0; i < 6; i++) await (await fetch(`http://${host.includes(":") ? `[${host}]` : host}:${port}/`, { headers: { connection: "close" } })).text();
    } finally {
      console.warn = warn;
      probe.closeAllConnections?.();
      await new Promise<void>((r) => probe.close(() => r()));
    }
  }

  test("over 127.0.0.1 and ::1 it names this test process (image and session) and refuses it, in well under 31 ms", async () => {
    for (const host of ["127.0.0.1", "::1"]) {
      const seen: { peer: ReturnType<typeof peerProcess>; verdict: boolean; ms: number }[] = [];
      await onRealSocket(host, (r) => {
        const t0 = performance.now();
        const verdict = relayedByTailscaleServe(r as ReqWithSocket);
        const ms = performance.now() - t0;
        seen.push({ peer: peerProcess(r as ReqWithSocket), verdict, ms });
      });
      for (const s of seen) {
        expect([host, s.peer?.pid, s.verdict]).toEqual([host, process.pid, false]);
        expect(s.peer?.name).toMatch(/^bun/i);
        expect(s.peer?.image).toMatch(/bun[^\\]*\.exe$/i);
        expect(s.peer?.sessionId).not.toBe(0);
      }
      const later = seen.slice(1).map((s) => s.ms).sort((a, b) => a - b);
      expect([host, later[Math.floor(later.length / 2)] < 10]).toEqual([host, true]);
    }
  });

  test("the running Tailscale service, if any, is recognised: installed tailscaled.exe in session 0", () => {
    const list = Bun.spawnSync(["tasklist", "/FI", "IMAGENAME eq tailscaled.exe", "/FO", "CSV", "/NH"], { stdout: "pipe", stderr: "pipe" }).stdout.toString();
    const pids = [...list.matchAll(/"tailscaled\.exe","(\d+)"/gi)].map((m) => Number(m[1]));
    if (!pids.length) return; // Tailscale not running on this machine
    const os = windowsPeerOs();
    for (const pid of pids) {
      const image = os.image(pid);
      expect([pid, image && isInstalledTailscaled(image), os.sessionId(pid)]).toEqual([pid, true, 0]);
    }
  });
});
