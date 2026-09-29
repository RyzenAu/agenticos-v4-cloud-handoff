// Integration guard (J6 + P1): the host's desk verdict must reach the browser skill through the skills runner, and only there.
// A merge once dropped `desk: ctx.desk === true`, which silently made every desk "open my bank" fall back to the strict open.
// SYNTHETIC: recording hands, no browser, no network, no Windows.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJarvisSkills } from "../jarvis-skills";
import { forgetReferent } from "../jarvis-skills/referent";
import type { BrowserHands } from "./agent-browser";
import { fakeWindows } from "./fake-windows";

const dirs: string[] = [];
afterEach(() => {
  forgetReferent();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function rig() {
  const opened: string[] = [];
  const hands = {
    open: async (url: string) => (opened.push(`open:${url}`), { ok: true, said: "Opened.", targetId: "T1" }),
    openDesk: async (url: string) => (opened.push(`desk:${url}`), { ok: true, said: "Opened.", targetId: "T1" }),
    activate: async () => ({ ok: true, said: "" }),
    tabs: async () => [],
  } as unknown as BrowserHands;
  const dir = mkdtempSync(join(tmpdir(), "desk-handoff-"));
  dirs.push(dir);
  const skills = createJarvisSkills(dir, {
    events: { submit: () => undefined },
    now: () => Date.UTC(2026, 8, 29),
    ps: fakeWindows().ps,
    vault: () => null,
    browser: { hands, ensure: async () => false },
  });
  return { opened, skills };
}
const req = { skill: "browser", action: "open", url: "https://bank.example.com/pay" };

describe("desk verdict reaches the browser skill", () => {
  test("at the desk, the desk open is used", async () => {
    const { opened, skills } = rig();
    await skills.run(req, { desk: true });
    expect(opened).toEqual(["desk:https://bank.example.com/pay"]);
  });
  test("no verdict, a remote caller, or a desk claim in the request body: the ordinary open", async () => {
    for (const [body, options] of [
      [req, {}],
      [req, { desk: false }],
      [req, { desk: true, remote: true }],
      [{ ...req, desk: true }, {}],
    ] as const) {
      const { opened, skills } = rig();
      await skills.run(body, options);
      expect(opened.every((o) => o.startsWith("open:"))).toBe(true);
    }
  });
});
