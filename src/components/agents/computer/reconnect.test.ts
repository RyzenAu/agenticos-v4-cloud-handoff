// Reconnect always ends in a message, and only does what can really be done.
// @ts-ignore: the browser tsconfig has no bun types (bun test supplies this module).
import { afterEach, describe, expect, test } from "bun:test";
import type { ComputerView, ScreenView } from "@/lib/computers-client";
import { reconnectComputer } from "@/lib/computers-client";

const realFetch = globalThis.fetch;
afterEach(() => void (globalThis.fetch = realFetch));
const calls: { url: string; method: string }[] = [];
const fake = (screen?: Partial<ScreenView>) => {
  calls.length = 0;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? "GET" });
    const json = String(url).endsWith("/screen") ? { screen: { applicable: true, ok: true, checking: false, layer: null, reason: null, next: null, nextLabel: null, ...screen } } : String(url).includes("/__token") ? { token: "t" } : {};
    return new Response(JSON.stringify(json), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
};
const computer = (over: Partial<ComputerView> = {}) => ({ name: "research", label: "Research", state: "online", ...over }) as ComputerView;

describe("Reconnect for a bot's computer", () => {
  test("a computer that isn't on this hub: says so and where to fix it, and sends nothing", async () => {
    fake();
    const r = await reconnectComputer(null, "research");
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/research isn't on this hub, so there is nothing to reconnect.*Setup/);
    expect((await reconnectComputer(null, null)).message).toMatch(/no computer/);
    expect(calls).toEqual([]);
  });
  test("already starting: says so, starts nothing", async () => {
    fake();
    expect(await reconnectComputer(computer({ state: "starting" }))).toMatchObject({ ok: true, message: expect.stringMatching(/already starting/) });
    expect(calls).toEqual([]);
  });
  test("online: checks the screen now and reports what it found, working or not", async () => {
    fake({ ok: true });
    expect(await reconnectComputer(computer())).toMatchObject({ ok: true, message: "Research is online and its screen is working." });
    expect(calls.map((c) => c.url)).toEqual(["/__computers/research/screen"]);
    fake({ ok: false, layer: "vnc", reason: "The screen server (VNC) isn't running.", nextLabel: "Restart display" });
    expect(await reconnectComputer(computer())).toMatchObject({ ok: false, message: "The screen server (VNC) isn't running. Next: Restart display." });
  });
  test("failed or stopped: runs the real start, and says it is reconnecting", async () => {
    fake();
    const r = await reconnectComputer(computer({ state: "failed" }));
    expect(r).toMatchObject({ ok: true, message: expect.stringMatching(/Reconnecting: starting the computer/) });
    expect(calls.some((c) => c.method === "POST" && c.url === "/__computers/research/action")).toBe(true);
  });
});
