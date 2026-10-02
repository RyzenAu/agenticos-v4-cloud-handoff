// Read-only look at a running journey hub: bun scripts/computers/peek.ts [--hub url] ; prints the computers and the lifecycle log (no secrets).
import { chromium } from "playwright-core";
import { join } from "node:path";
const i = process.argv.indexOf("--hub");
const hub = i >= 0 ? process.argv[i + 1] : "http://127.0.0.1:8112";
const ctx = await chromium.launchPersistentContext(join(process.env.TEMP ?? ".", "mu-computers-peek-profile"), { channel: "chrome", headless: true });
const page = ctx.pages()[0] ?? (await ctx.newPage());
await page.goto(`${hub}/`, { waitUntil: "domcontentloaded" });
const get = (p: string) => page.evaluate(async (path) => (await fetch(`/__computers${path}`)).json(), p);
const l = (await get("/")) as any;
console.log(JSON.stringify(l.computers.map((c: any) => ({ name: c.name, state: c.state, desired: c.desired, failure: c.failure, recoveries: c.recoveries, controller: c.controller, resource: c.resource })), null, 1));
console.log(((await get("/events")) as any).events.map((e: any) => `${new Date(e.at).toISOString().slice(11, 19)} ${e.computer}: ${e.type}${e.detail ? ` (${e.detail})` : ""}`).join("\n"));
await ctx.close();
