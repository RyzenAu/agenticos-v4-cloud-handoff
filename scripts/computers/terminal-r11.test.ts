// Round 11 (defect 4): GET /__computers/events showed "terminal-open" and "terminal-close" twice for one terminal session. Two opens arriving
// together (the terminal panel's mount effect runs twice in the dev build; a double click) both started a shell, so two sessions were logged
// for what the person saw as one terminal. A second open while one is opening now re-attaches to it: one open, one close.
import { describe, expect, test } from "bun:test";
import { createTerminals, type TerminalProcess } from "./terminal";

function fakeProc() {
  const exit: ((c: number | null) => void)[] = [];
  const proc: TerminalProcess = { write: () => undefined, resize: () => undefined, close: () => { for (const l of exit) l(0); }, onData: () => undefined, onExit: (l) => void exit.push(l) };
  return proc;
}

describe("one terminal session is logged once", () => {
  test("two opens at the same moment start one shell: one terminal-open, and one terminal-close when it ends", async () => {
    const usman = { personId: "usman", session: "s-1" };
    const holder = usman;
    const log: string[] = [];
    let opened = 0;
    const terms = createTerminals({
      holds: (_c, who) => (holder.session === who.session ? null : "Take control first."),
      open: async () => { opened++; await new Promise((r) => setTimeout(r, 30)); return fakeProc(); },
      log: (_c, kind) => void log.push(kind),
    });
    const [a, b] = await Promise.all([terms.start("research", usman), terms.start("research", usman)]);
    expect(a.ok && b.ok).toBe(true);
    expect(a.ok && b.ok && a.id === b.id).toBe(true);
    expect([a.ok && a.attached, b.ok && b.attached].sort()).toEqual([false, true]);
    expect(opened).toBe(1);
    terms.closeAll();
    expect(log.filter((k) => k === "terminal-open")).toHaveLength(1);
    expect(log.filter((k) => k === "terminal-close")).toHaveLength(1);
  });
});

describe("review follow-up: a failed open with two waiters starts one shell, not two", () => {
  test("the first open fails; the two callers waiting on it retry as ONE open", async () => {
    const usman = { personId: "usman", session: "s-1" };
    const log: string[] = [];
    let opened = 0;
    const terms = createTerminals({
      holds: () => null,
      open: async () => { opened++; await new Promise((r) => setTimeout(r, 20)); if (opened === 1) throw new Error("host busy"); return fakeProc(); },
      log: (_c, kind) => void log.push(kind),
    });
    const results = await Promise.all([terms.start("research", usman), terms.start("research", usman), terms.start("research", usman)]);
    expect(results[0].ok).toBe(false);
    expect(opened).toBe(2);
    const ok = results.slice(1).filter((r) => r.ok);
    expect(ok).toHaveLength(2);
    expect(new Set(ok.map((r) => (r.ok ? r.id : ""))).size).toBe(1);
    expect(log.filter((k) => k === "terminal-open")).toHaveLength(1);
  });
});
