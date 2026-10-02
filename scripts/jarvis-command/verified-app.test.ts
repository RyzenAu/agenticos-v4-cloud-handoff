import { test, expect } from "bun:test";
import { openVerifiedApp, type AppOpenDeps } from "./verified-app";
import type { WindowInfo } from "../jarvis-skills/windows";
const app: WindowInfo = { handle: 42, process: "Claude", title: "Claude", cls: "App" };
test("reuse an existing app, focus it, and only report completion after foreground verification", async () => {
  let front: WindowInfo | null = null;
  const launches: string[] = [],
    focuses: number[] = [];
  const r = await openVerifiedApp("Claude", new AbortController().signal, {
    windows: async () => [app],
    foreground: async () => front,
    focus: async (h) => {
      focuses.push(h);
      front = app;
    },
    launch: async (name) => {
      launches.push(name);
      return { ok: true, said: "Launch queued" };
    },
    sleep: async () => {},
    now: () => 123,
  });
  expect(r).toMatchObject({ ok: true, checkedAt: 123 });
  expect(focuses).toEqual([42]);
  expect(launches).toEqual([]);
});
test("a launch acknowledgement and a Chrome tab titled Claude are not evidence of the app opening", async () => {
  const wrong: WindowInfo = {
    handle: 11,
    process: "chrome",
    title: "Claude",
    cls: "Chrome_WidgetWin_1",
  };
  let launches = 0;
  const deps: AppOpenDeps = {
    windows: async () => [wrong],
    foreground: async () => wrong,
    focus: async () => true,
    launch: async () => {
      launches++;
      return { ok: true, said: "All set" };
    },
    sleep: async () => {},
  };
  expect(await openVerifiedApp("Claude", new AbortController().signal, deps)).toMatchObject({
    ok: false,
  });
  expect(launches).toBe(1);
});
test("a focus failure stops subsequent work and a stop during launch never claims completion", async () => {
  const deps: AppOpenDeps = {
    windows: async () => [app],
    foreground: async () => null,
    focus: async () => false,
    launch: async () => ({ ok: true, said: "Started" }),
    sleep: async () => {},
  };
  expect(await openVerifiedApp("Claude", new AbortController().signal, deps)).toMatchObject({
    ok: false,
  });
  const controller = new AbortController();
  deps.windows = async () => [];
  deps.launch = async () => {
    controller.abort();
    return { ok: true, said: "Started" };
  };
  expect(await openVerifiedApp("Claude", controller.signal, deps)).toMatchObject({
    ok: false,
    said: expect.stringContaining("Stopped"),
  });
});
