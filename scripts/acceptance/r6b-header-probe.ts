// Round 6b: does the page header's breadcrumb run under the right-hand controls (Go to..., Jarvis chip)? Real browser, isolated hub only.
import { chromium } from "playwright-core";
const hub = process.argv[2] ?? "http://127.0.0.1:8153";
if (/:8081\b/.test(hub)) throw new Error("not the live hub");
const ctx = await chromium.launchPersistentContext(process.argv[3] ?? "D:/AgenticOS-r6-data/gate-profile", { channel: "chrome", headless: true, reducedMotion: "reduce" });
const p = ctx.pages()[0] ?? (await ctx.newPage());
const rows: unknown[] = [];
for (const [w, h] of [[1440, 900], [1024, 800], [768, 900], [390, 844]]) {
  await p.setViewportSize({ width: w, height: h });
  await p.goto(`${hub}/computers`, { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(3500);
  rows.push(await p.evaluate((vw) => {
    const hdr = document.querySelector("header.sh-header");
    const left = hdr?.children[0] as HTMLElement | undefined;
    const right = hdr?.children[1] as HTMLElement | undefined;
    const r = (e?: Element | null) => (e ? e.getBoundingClientRect() : null);
    const l = r(left), rr = r(right);
    const crumb = left?.querySelector("nav, ol, [aria-label*=readcrumb]") ?? left;
    const c = r(crumb);
    const kids = [...(left?.querySelectorAll("*") ?? [])].map((e) => e.getBoundingClientRect()).filter((b) => b.width > 0);
    const textRight = Math.max(...kids.map((b) => b.right), 0);
    return { vw, leftBox: l && [Math.round(l.left), Math.round(l.right)], rightBox: rr && [Math.round(rr.left), Math.round(rr.right)], breadcrumbTextRight: Math.round(textRight), overlapPx: rr ? Math.max(0, Math.round(textRight - rr.left)) : null, pageScrollsSideways: document.documentElement.scrollWidth > vw };
  }, w));
  await p.screenshot({ path: `D:/AgenticOS-r6-data/gate-out/header-${w}.png`, clip: { x: 0, y: 0, width: w, height: 80 } });
}
console.log(JSON.stringify(rows, null, 1));
await ctx.close();
