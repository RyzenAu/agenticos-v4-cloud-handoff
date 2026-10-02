/** Synthetic, loopback-only browser acceptance. No provider keys or user browser profile. */
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { createJarvisEntry } from "../jev-command";
import { stubResolveTarget } from "../jev-target";
import { createScreenHands, parseScreenRequest, type Hands } from "../screen-hands/index";
import { FLAGS_OFF } from "../screen-hands/flags";
import { SpokenConfirmationLedger } from "../jarvis-execution/voice-confirmation";
import type { Overlay } from "../screen-hands/overlay";
import type { AppBrowser } from "../browser/app-browser";

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(req) {
    const path = new URL(req.url).pathname;
    const body =
      path === "/form"
        ? `<title>Synthetic contact</title><label>Name<input id="name" aria-label="Name"></label><button id="submit">Submit</button><p id="result"></p><script>window.typed=0;window.submits=0;document.querySelector('input').addEventListener('input',()=>window.typed++);document.querySelector('button').addEventListener('click',()=>{window.submits++;document.querySelector('#result').textContent='Recorded (synthetic)';});</script>`
        : `<title>Synthetic start</title><a href="/form">Contact</a>`;
    return new Response(body, { headers: { "Content-Type": "text/html" } });
  },
});
const origin = `http://127.0.0.1:${server.port}`;
const browser = await chromium.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: true,
});
const context = await browser.newContext({ viewport: { width: 1100, height: 800 } });
await context.route("**/*", (route) =>
  new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
);
const page = await context.newPage();
let nativeReads = 0;
const native = () => {
  nativeReads++;
  throw new Error("Native desktop must not be used for this owned browser page");
};
const hands = {
  foreground: async () => native(),
  windows: async () => native(),
  snapshot: async () => native(),
  focused: async () => native(),
  focus: async () => native(),
  type: async () => native(),
  click: async () => native(),
  keys: async () => native(),
  wheel: async () => native(),
} as unknown as Hands;
const noop = () => {};
const overlay = {
  glide: async () => {},
  ring: noop,
  caption: noop,
  tap: noop,
  flash: noop,
  hide: noop,
  follow: noop,
  home: noop,
  thinking: noop,
  stat: async () => null,
  watch: noop,
  onClick: () => noop,
  excludeFromCapture: async () => true,
  warm: noop,
  pid: () => null,
  affinity: null,
  close: noop,
} satisfies Overlay;
let now = 10000;
const spoken = new SpokenConfirmationLedger(() => now);
const screen = createScreenHands({
  key: () => "",
  hands,
  overlay,
  flags: () => ({ ...FLAGS_OFF }),
  jarvisChrome: null,
  audit: null,
  spoken,
  now: () => now,
  ps: { run: async () => "", warm: noop, close: noop },
});
let opens = 0;
const owned = {
  page: () => page,
  open: async (url: string) => {
    opens++;
    await page.goto(url);
    return { ok: true, said: "Opened the synthetic fixture." };
  },
} as unknown as AppBrowser;
const entry = createJarvisEntry({
  screen,
  resolver: { resolve: stubResolveTarget, source: "stub" },
  jevKey: () => "",
  front: async () => ({ process: "notepad", title: "Synthetic unrelated window", handle: 11 }),
  browser: async () => owned,
  summarise: null,
  files: { open: async () => {}, titles: async () => [] },
  openApp: async () => ({ ok: false, said: "Not part of this fixture" }),
});
try {
  const signal = new AbortController().signal;
  const goal = `open ${origin}/ then click Contact then click Name field then type "alpha then click Submit" then click Submit`;
  const asked = await entry.handle({ utterance: goal }, signal);
  assert.equal(asked.confirm, "Submit");
  assert.equal(asked.ok, false);
  assert.equal(page.url(), origin + "/form");
  const state = () =>
    page.evaluate(() => ({
      typed: (window as any).typed,
      submits: (window as any).submits,
      value: (document.querySelector("input") as HTMLInputElement).value,
    }));
  assert.deepEqual(await state(), { typed: 1, submits: 0, value: "alpha then click Submit" });
  const invalid = await screen.act(
    parseScreenRequest({ goal: asked.resumeGoal, confirm: "Submit" }),
    signal,
  );
  assert.equal(invalid.steps, 0);
  assert.equal(invalid.confirm, "Submit");
  assert.equal((await state()).typed, 1);
  now += 1000;
  const yes = spoken.record("yes")!;
  now += 100;
  const done = await screen.act(
    parseScreenRequest({ goal: asked.resumeGoal, confirm: "Submit", spokenYes: yes.id }),
    signal,
  );
  assert.equal(done.ok, true);
  assert.deepEqual(await state(), { typed: 1, submits: 1, value: "alpha then click Submit" });
  const replay = await screen.act(
    parseScreenRequest({ goal: asked.resumeGoal, confirm: "Submit", spokenYes: yes.id }),
    signal,
  );
  assert.equal(replay.ok, false);
  assert.equal(replay.steps, 0);
  assert.equal((await state()).submits, 1);
  assert.equal(opens, 1);
  assert.equal(nativeReads, 0);
  assert.equal(
    screen.runs.list().every((run) => run.executor === "playwright" || run.executor === "uia"),
    true,
  );
  const run = screen.runs.get(asked.runId);
  assert.equal(run?.executor, "playwright");
  console.log(
    JSON.stringify({
      acceptance: "owned page → link → field → literal dictation → approval → one submission",
      pass: true,
      pageOpened: opens,
      typed: 1,
      submitted: 1,
      replayActions: 0,
      nativeDesktopReads: nativeReads,
      providerCalls: 0,
    }),
  );
} finally {
  screen.close();
  await context.close();
  await browser.close();
  await server.stop(true);
}
