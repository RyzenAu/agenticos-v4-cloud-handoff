import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { chromium } from "playwright-core";
import { NOVNC_VERSION, novncAsset } from "./novnc";
import { startComputersHub, type ComputersHub } from "./test-harness";

setDefaultTimeout(60_000);
let hub: ComputersHub | undefined;
afterEach(async () => {
  await hub?.close();
  hub = undefined;
});

async function setup(rfb: "canned" | "real" = "canned") {
  hub = await startComputersHub();
  hub.host.vncUp = true;
  hub.host.rfb = rfb;
  expect((await hub.api("usman", "POST", "/", { name: "research" })).status).toBe(200);
  await hub.waitFor("online", () => hub!.computers.view("research").state === "online");
  await hub.computers.tick();
  return hub;
}

describe("noVNC, pinned and served by the hub", () => {
  test("the version is pinned in package.json and matches what is installed; only core and vendor scripts are served", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8"));
    expect(pkg.dependencies["@novnc/novnc"]).toBe(NOVNC_VERSION); // exact, no range
    expect(JSON.parse(readFileSync("node_modules/@novnc/novnc/package.json", "utf8")).version).toBe(NOVNC_VERSION);
    expect(novncAsset(process.cwd(), "/assets/novnc/core/rfb.js")?.body.length).toBeGreaterThan(1000);
    for (const bad of ["/assets/novnc/package.json", "/assets/novnc/core/../package.json", "/assets/novnc/core/%2e%2e/package.json", "/assets/novnc/docs/x.js", "/assets/novnc/core/nosuch.js", "/assets/novnc/../../../package.json", "/assets/novnc/core//rfb.js"]) expect(novncAsset(process.cwd(), bad)).toBeNull();
  });

  test("the hub serves the client files and the viewer page to a signed-in founder, with a framing policy", async () => {
    const h = await setup();
    const js = await h.api("usman", "GET", "/assets/novnc/core/rfb.js");
    expect(js.status).toBe(200);
    expect(js.type).toContain("javascript");
    expect((await h.api("usman", "GET", "/assets/novnc/package.json")).status).toBe(404);
    const res = await fetch(`${h.base}/__computers/research/viewer`, { headers: h.headers("usman", false) });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'self'");
    expect(res.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    const html = await res.text();
    expect(html).toContain('import RFB from "/__computers/assets/novnc/core/rfb.js"');
    expect(html).toContain("viewOnly");
    expect((await fetch(`${h.base}/__computers/nosuch/viewer`, { headers: h.headers("usman", false) })).status).toBe(404);
  });

  test("viewer-state says whether THIS person holds the lease; it is the page's view-only switch", async () => {
    const h = await setup();
    expect((await h.api("usman", "GET", "/research/viewer-state")).json).toMatchObject({ canControl: false, me: "usman" });
    await h.api("usman", "POST", "/research/takeover", {});
    expect((await h.api("usman", "GET", "/research/viewer-state")).json).toMatchObject({ canControl: true });
    const other = (await h.api("mehroz", "GET", "/research/viewer-state")).json;
    expect(other).toMatchObject({ canControl: false, me: "mehroz" });
    expect(other.view.controller).toMatchObject({ kind: "person", who: "usman" });
  });

  test("a real browser runs noVNC through the hub: it sees the computer's screen, is view-only until it holds the lease, and acts only while it does", async () => {
    const h = await setup("real");
    let browser;
    try {
      browser = await chromium.launch({ channel: "chrome", headless: true });
    } catch {
      console.warn("Chrome isn't installed here: the real-browser noVNC check was skipped");
      return;
    }
    try {
      const ctx = await browser.newContext();
      const cookie = /mu_session=([^;]+)/.exec(h.headers("usman", false).cookie ?? "")![1];
      await ctx.addCookies([{ name: "mu_session", value: cookie, url: h.base }]);
      const page = await ctx.newPage();
      const messages: any[] = [];
      await page.exposeFunction("seen", (m: unknown) => messages.push(m));
      await page.addInitScript(() => addEventListener("message", (e) => (globalThis as any).seen(e.data)));
      await page.goto(`${h.base}/__computers/research/viewer`);
      await h.waitFor("noVNC to connect and draw", async () => messages.some((m) => m?.source === "mu-computer-viewer" && m.connected), 15_000);
      await h.waitFor("the computer's frame", async () => h.host.rfbSeen.updateRequests > 0);
      // the canvas shows the computer's screen (the fake server paints 0xc8 1e 1e)
      const px = await h.waitFor("a painted canvas", async () => {
        const v = await page.evaluate(() => {
          const c = document.querySelector("canvas") as HTMLCanvasElement | null;
          if (!c || !c.width) return null;
          return [...c.getContext("2d")!.getImageData(5, 5, 1, 1).data];
        });
        return v && v[0] === 0xc8 ? v : null;
      }, 10_000);
      expect(px.slice(0, 3)).toEqual([0xc8, 0x1e, 0x1e]);
      const box = (await page.locator("canvas").boundingBox())!;
      const click = () => page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

      // view-only: clicks and keys never reach the computer
      await click();
      await page.keyboard.press("a");
      await new Promise((r) => setTimeout(r, 400));
      expect(h.host.rfbSeen.pointer).toBe(0);
      expect(h.host.rfbSeen.key).toBe(0);

      // take control (the page's button, which calls our lease): now the same click lands
      await page.getByRole("button", { name: "Take control" }).click();
      await h.waitFor("the lease", () => h.computers.view("research").controller.kind === "person");
      await h.waitFor("the page to see it", async () => messages.some((m) => m?.canControl === true), 8_000);
      await click();
      await h.waitFor("the click to arrive", () => h.host.rfbSeen.pointer > 0, 5_000);
      const landed = h.host.rfbSeen.pointer;

      // return to agent: input stops again, enforced by the hub's gate even if the page were to keep sending
      await page.getByRole("button", { name: "Return to agent" }).click();
      await h.waitFor("the lease to be free", () => h.computers.view("research").controller.kind === null);
      await h.waitFor("the page to see it", async () => messages.at(-1)?.canControl === false, 8_000);
      await click();
      await new Promise((r) => setTimeout(r, 400));
      expect(h.host.rfbSeen.pointer).toBe(landed);
    } finally {
      await browser.close();
    }
  });
});
