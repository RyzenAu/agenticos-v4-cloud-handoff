#!/usr/bin/env bun
/**
 * Scroll success-rate bench for a computer's own browser path (the CDP backend a bot computer's companion runs): the local fixture pages plus
 * optional real public pages, N attempts each, the new container-aware scroller against the old window-only one on the SAME pages.
 *
 *   build for a computer's host (Node 22, no Bun there):  bun scripts/computers/scroll-bench.ts --build D:\prog-scratch\r4\scroll-bench.mjs
 *   run on that host:  xvfb-run -a node scroll-bench.mjs --fixtures <dir> [--real] [--pairs 6] [--out result.json]
 *
 * An attempt is a success only when the report AND an independent oracle agree. The oracle is a different in-page script from the picker: it records
 * every scrollable element's scrollTop plus the window before and after. "Scrolled N px" must be matched by something really moving in that direction;
 * "already at the bottom/top" must be matched by no sizeable scroller having room left. A report the oracle contradicts counts as a FALSE REPORT.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { CdpSession, findChromium, tabs } from "../../companion/linux/cdp";
import { createLinuxExecutors, liveBrowserBackend } from "../../companion/linux/executors-linux";

const argv = process.argv.slice(2);
const flag = (n: string) => argv.includes(`--${n}`);
const arg = (n: string, d: string) => (flag(n) ? argv[argv.indexOf(`--${n}`) + 1] : d);

if (flag("build")) {
  const out = resolve(arg("build", "scroll-bench.mjs"));
  const r = await Bun.build({ entrypoints: [import.meta.path], target: "node", outdir: join(tmpdir(), `sb-${process.pid}`), naming: "scroll-bench.mjs" });
  if (!r.success) throw new Error(r.logs.map((l) => l.message).join("; "));
  writeFileSync(out, await r.outputs[0].text());
  rmSync(join(tmpdir(), `sb-${process.pid}`), { recursive: true, force: true });
  console.log(`built ${out}`);
  process.exit(0);
}

const ORACLE = `(() => {
  const root = document.scrollingElement || document.documentElement;
  const ov = (e) => (e ? getComputedStyle(e).overflowY : 'visible');
  const locked = ['hidden', 'clip'].includes(ov(document.documentElement) !== 'visible' ? ov(document.documentElement) : ov(document.body));
  const out = [{ k: 'window', top: Math.round(scrollY), max: locked ? 0 : Math.max(0, Math.round(root.scrollHeight - innerHeight)), big: true }];
  let n = 0;
  for (const el of document.querySelectorAll('*')) {
    if (++n > 8000) break;
    if (el === root) continue;
    const cs = getComputedStyle(el);
    if (!/(auto|scroll|overlay)/.test(cs.overflowY) || el.scrollHeight - el.clientHeight <= 1) continue;
    const r = el.getBoundingClientRect();
    const w = Math.max(0, Math.min(innerWidth, r.right) - Math.max(0, r.left)), h = Math.max(0, Math.min(innerHeight, r.bottom) - Math.max(0, r.top));
    if (w * h < 1500) continue;
    out.push({ k: (el.tagName + (el.id ? '#' + el.id : '')).slice(0, 40), top: Math.round(el.scrollTop), max: Math.round(el.scrollHeight - el.clientHeight), big: w * h >= 0.25 * innerWidth * innerHeight });
  }
  return JSON.stringify(out);
})()`;
type Probe = { k: string; top: number; max: number; big: boolean }[];

const exe = process.env.MU_CHROMIUM || findChromium() || "";
if (!exe) throw new Error("No Chromium on this host.");
const port = 9500 + Math.floor(Math.random() * 300);
const profile = mkdtempSync(join(tmpdir(), "scroll-bench-"));
const display = process.env.DISPLAY || undefined;
const backend = liveBrowserBackend({ port, profileDir: profile, chromiumPath: exe, display, noSandbox: process.platform === "linux", windowSize: "1280x800" });
const oldBackend = { ...backend, scrollContainer: undefined };
const fresh = createLinuxExecutors({ name: "bench-new", workdir: join(profile, "w1"), browser: backend });
const legacy = createLinuxExecutors({ name: "bench-old", workdir: join(profile, "w2"), browser: oldBackend });
const ctx = () => ({ signal: new AbortController().signal, owner: "usman" as const, log: () => undefined, progress: undefined as undefined | ((s: any) => void) });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function probe(tabId: string): Promise<Probe> {
  const t = (await tabs(port)).find((x) => x.id === tabId)!;
  const s = await CdpSession.connect(t.webSocketDebuggerUrl!);
  try {
    return JSON.parse(await s.evaluate<string>(ORACLE)) as Probe;
  } finally {
    s.close();
  }
}

type Page = { name: string; url: string; real: boolean };
const dir = resolve(arg("fixtures", "."));
const pages: Page[] = [
  ...["doc", "panels", "modal", "virtual", "banner"].map((n) => ({ name: `fixture:${n}`, url: pathToFileURL(join(dir, `${n}.html`)).href, real: false })),
  ...(flag("real")
    ? [
        { name: "real:wikipedia", url: "https://en.wikipedia.org/wiki/Sydney", real: true },
        { name: "real:mdn", url: "https://developer.mozilla.org/en-US/docs/Web/CSS/overflow", real: true },
        { name: "real:bbc", url: "https://www.bbc.com/news", real: true },
        { name: "real:hn", url: "https://news.ycombinator.com/", real: true },
      ]
    : []),
];
const pairs = Number(arg("pairs", "6"));

type Attempt = { page: string; mode: "new" | "old"; dy: number; said: string; reportedOk: boolean; verified: boolean | null; oracle: "agrees" | "contradicts"; why: string; ms: number };
const attempts: Attempt[] = [];

async function loadPage(p: Page) {
  const tab = await backend.open(p.url);
  for (let i = 0; i < 100; i++) {
    const f = await backend.read(tab).catch(() => null);
    if (f?.ready === "complete") break;
    await sleep(200);
  }
  await sleep(p.real ? 1500 : 300);
  return tab;
}

for (const mode of ["new", "old"] as const) {
  const run = mode === "new" ? fresh : legacy;
  for (const p of pages) {
    let tab: string;
    try {
      tab = await loadPage(p);
    } catch (e) {
      console.log(`skip ${p.name}: ${(e as Error).message}`);
      continue;
    }
    for (let i = 0; i < pairs * 2; i++) {
      const down = i < pairs;
      const dy = (down ? 1 : -1) * [500, 700, 400, 600, 800, 450][i % 6];
      const before = await probe(tab);
      const t0 = Date.now();
      const r: any = await run["input.scroll"]({ dy, ...(mode === "new" ? { tabId: tab } : {}) }, ctx());
      const ms = Date.now() - t0;
      await sleep(150);
      const after = await probe(tab);
      const moved = after.some((a, j) => before[j] && a.k === before[j].k && Math.sign(a.top - before[j].top) === Math.sign(dy));
      const roomLeft = after.some((a) => a.big && (dy > 0 ? a.max - a.top > 1 : a.top > 1));
      const saidMoved = /^Scrolled (down|up)/.test(r.said);
      const saidEdge = /^Already at the|^Nothing on this page/.test(r.said);
      let oracle: "agrees" | "contradicts" = "agrees";
      let why = "";
      if (saidMoved && !moved) (oracle = "contradicts"), (why = "reported movement, nothing moved");
      else if (saidEdge && roomLeft) (oracle = "contradicts"), (why = "reported a boundary, a big scroller still had room");
      else if (!saidMoved && !saidEdge && moved) (oracle = "contradicts"), (why = "reported no movement, something moved");
      else if (!saidMoved && !saidEdge && roomLeft) why = "did not scroll although a big scroller had room";
      attempts.push({ page: p.name, mode, dy, said: String(r.said).slice(0, 90), reportedOk: !!r.ok, verified: r.verified ?? null, oracle, why, ms });
    }
    await fetch(`http://127.0.0.1:${port}/json/close/${tab}`).catch(() => undefined);
  }
}

// Success: the report was ok AND verified AND the oracle agrees (so a boundary only counts when it is a true boundary).
const ok = (a: Attempt) => a.reportedOk && a.verified === true && a.oracle === "agrees";
const summary: Record<string, unknown> = {};
for (const mode of ["new", "old"] as const) {
  const rows = attempts.filter((a) => a.mode === mode);
  const byPage: Record<string, string> = {};
  for (const p of pages) {
    const r = rows.filter((a) => a.page === p.name);
    if (r.length) byPage[p.name] = `${r.filter(ok).length}/${r.length}`;
  }
  const times = rows.map((a) => a.ms).sort((a, b) => a - b);
  summary[mode] = {
    attempts: rows.length, success: rows.filter(ok).length, rate: rows.length ? Math.round((1000 * rows.filter(ok).length) / rows.length) / 10 : null,
    falseReports: rows.filter((a) => a.oracle === "contradicts").length, p50Ms: times[Math.floor(times.length / 2)] ?? null, p95Ms: times[Math.min(times.length - 1, Math.ceil(times.length * 0.95) - 1)] ?? null, byPage,
    failures: rows.filter((a) => !ok(a)).slice(0, 12).map((a) => `${a.page} dy=${a.dy}: ${a.said}${a.why ? ` [${a.why}]` : ""}`),
  };
}
const result = { at: new Date().toISOString(), host: process.platform, browser: exe.split("/").pop(), headed: !!display, summary, attempts };
if (flag("out")) writeFileSync(arg("out", "scroll-bench-result.json"), JSON.stringify(result, null, 1));
console.log(JSON.stringify(summary, null, 1));
try {
  const v: any = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const s = await CdpSession.connect(v.webSocketDebuggerUrl);
  await s.send("Browser.close").catch(() => undefined);
  s.close();
} catch {
  /* gone */
}
await sleep(500);
rmSync(profile, { recursive: true, force: true });
process.exit(0);
