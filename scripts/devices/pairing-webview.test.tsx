import { afterEach, beforeEach, expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { ProfilePanel } from "../../src/components/profile/profile-panel";
import { consoleCodeCommand, createProfileApi } from "../../src/components/profile/profile-api";
import { startHub, type Hub, type Who } from "./test-harness";
import { pageTokenFor } from "../identity/principal";

/**
 * R7 journey B: pairing from the desktop app's WebView (a browser that keeps one cookie jar for the hub's HTTPS origin) on the
 * SERVER hub, where a bare Tailscale login is never confirmed. The failure the owner saw: the pairing was "not recognised". The boundary:
 * the hub (correctly) ignores a pending cookie, so /me said `session: null` and the page offered "Pair this device" again, with a notice
 * that claimed the device was paired. These tests pin the honest states, the exact console command, and that nothing here weakens pairing.
 */

let hub: Hub;
let root: Root | undefined;
const restore: Array<() => void> = [];
function setGlobal(name: string, value: unknown) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  restore.push(() => (previous ? Object.defineProperty(globalThis, name, previous) : Reflect.deleteProperty(globalThis, name)));
}

beforeEach(async () => (hub = await startHub({ hubRole: "server" })));
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  while (restore.length) restore.pop()!();
  await hub.close();
});

/** One WebView profile: its own persistent cookie jar for the hub origin, surviving a "restart" (a new mount with the same jar). */
function webview(who: Exclude<Who, "local">) {
  const jar = new Map<string, string>();
  const setCookies: string[] = [];
  const fetchImpl = (async (input: any, init: any = {}) => {
    const url = String(input);
    const path = url.startsWith("/") ? url : new URL(url).pathname;
    const token = pageTokenFor({ personId: who === "stranger" ? "mehroz" : who, via: "tailnet-person" }, "synthetic-page-token");
    if (path === "/__token") return new Response(JSON.stringify({ token }), { headers: { "content-type": "application/json" } });
    const headers: Record<string, string> = { ...(init.headers ?? {}), ...hub.headersFor(who) };
    if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
    const res = await fetch(`${hub.base}${path}`, { ...init, headers });
    for (const c of res.headers.getSetCookie?.() ?? []) {
      setCookies.push(c);
      const [pair] = c.split(";");
      const eq = pair.indexOf("=");
      if (/Max-Age=0/.test(c)) jar.delete(pair.slice(0, eq));
      else jar.set(pair.slice(0, eq), pair.slice(eq + 1));
    }
    return res;
  }) as typeof fetch;
  return { jar, setCookies, fetchImpl };
}

async function mount(view: ReturnType<typeof webview>) {
  if (root) await act(async () => root!.unmount());
  const { window } = parseHTML("<html><body><main></main></body></html>");
  setGlobal("window", window);
  setGlobal("document", window.document);
  setGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = window.document.querySelector("main")!;
  root = createRoot(container);
  await act(async () => root!.render(<ProfilePanel api={createProfileApi("/__devices", view.fetchImpl)} />));
  const text = () => container.textContent ?? "";
  const waitFor = async (needle: string, ms = 3000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (text().includes(needle)) return true;
      await act(async () => void (await new Promise((r) => setTimeout(r, 25))));
    }
    throw new Error(`"${needle}" never appeared. Page text: ${text().slice(0, 500)}`);
  };
  const click = async (label: string) =>
    act(async () => {
      const button = [...container.querySelectorAll("button")].find((b: any) => b.textContent.trim() === label);
      expect(button).toBeDefined();
      button!.dispatchEvent(new window.Event("click", { bubbles: true }));
    });
  // linkedom has no <input type>, so React's native input event never fires onChange; call the handler React attached instead.
  const type = async (selector: string, value: string) =>
    act(async () => {
      const input = container.querySelector(selector) as any;
      expect(input).toBeTruthy();
      const propsKey = Object.keys(input).find((k) => k.startsWith("__reactProps$"))!;
      input[propsKey].onChange({ target: { value }, currentTarget: { value } });
    });
  const submit = async (formSelector = "[data-testid='waiting-for-code'] form") =>
    act(async () => {
      const form = container.querySelector(formSelector) as any;
      expect(form).toBeTruthy();
      form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    });
  return { container, text, waitFor, click, type, submit };
}

test("a bare Tailscale login on the server hub says it is waiting for a code, not that it is paired", async () => {
  const wv = webview("mehroz");
  const ui = await mount(wv);
  await ui.waitFor("Pair this device");
  expect(ui.text()).toContain("you'll finish with a one-time code"); // said before the click, not discovered after
  await ui.click("Pair this device");
  await ui.waitFor("This browser needs a code");
  expect(ui.text()).toContain("not confirmed yet");
  expect(ui.text()).not.toContain("This device is paired.");
  // The one clear next action: the exact console command, for the right person, plus where to type the code.
  expect(ui.text()).toContain("bun scripts/identity/pair-code.ts --for mehroz --port 8081");
  expect(ui.text()).toContain("Then type the code here");
  expect(ui.text()).toContain("Already confirmed on another browser?");
  // Audit 2 item 12: an unconfirmed browser is shown only what it can really do, and no page called Profile is mentioned.
  expect(ui.text()).toContain("Read-only shared workspace. This browser can't approve or change anything until it is confirmed.");
  expect(ui.text()).not.toMatch(/finance|control of your own devices|Code for a browser|Code for a companion/);
  expect(ui.text()).not.toMatch(/\bProfile\b/);
  expect(ui.text()).toContain("System › Devices and people");
  // A bare login stays unconfirmed: the cookie it earned is pending and opens nothing local-owner.
  const me = await (await wv.fetchImpl("/__devices/me")).json();
  expect(me.session).toBeNull();
  expect(me.principal.actor).toBe("process");
  expect(me.waitingSession).toMatchObject({ personId: "mehroz", pending: true, via: "tailnet" });
  expect(JSON.stringify(me)).not.toMatch(/"code"|[A-Z0-9]{4}-[A-Z0-9]{4}/); // /me never carries a code
});

test("the hub's pairing command sits behind a collapsed Technical detail, under a plain sentence (R7 review m7)", async () => {
  const wv = webview("mehroz");
  const ui = await mount(wv);
  await ui.waitFor("Pair this device");
  await ui.click("Pair this device");
  await ui.waitFor("This browser needs a code");
  const detail = ui.container.querySelector("[data-testid='console-code-detail']") as any;
  expect(detail?.tagName.toLowerCase()).toBe("details");
  expect(detail.hasAttribute("open")).toBe(false);
  expect(detail.querySelector("summary").textContent).toBe("Technical detail");
  expect(detail.textContent).toContain("pair-code.ts");
  const clone = ui.container.cloneNode(true) as any;
  clone.querySelectorAll("details").forEach((d: any) => d.remove());
  expect(clone.textContent).not.toMatch(/pair-code|scripts\/|bun /);
  expect(clone.textContent).toContain("Run the pairing command on the hub PC");
});

test("the waiting state survives a WebView restart (same cookie jar) and the wrong code does not confirm it", async () => {
  const wv = webview("mehroz");
  const first = await mount(wv);
  await first.waitFor("Pair this device");
  await first.click("Pair this device");
  await first.waitFor("This browser needs a code");

  const second = await mount(wv); // app restarted: a new page, the persisted cookie
  await second.waitFor("This browser needs a code");
  expect(second.text()).not.toContain("Paired browser over Tailscale");

  await second.type("[data-testid='waiting-for-code'] input", "WRNG-CODE");
  await second.submit();
  await second.waitFor("That code is wrong, used or expired");
  expect(second.text()).toContain("This browser needs a code");
  const me = await (await wv.fetchImpl("/__devices/me")).json();
  expect(me.session).toBeNull();
});

test("a console code confirms the browser; it works once, for the right person only", async () => {
  const wv = webview("mehroz");
  const ui = await mount(wv);
  await ui.waitFor("Pair this device");
  await ui.click("Pair this device");
  await ui.waitFor("This browser needs a code");

  // Made for Usman: a wrong code for Mehroz, and not burnt by his attempt.
  const forUsman = hub.svc.store.createCode("usman", "browser", "usman").code;
  await ui.type("[data-testid='waiting-for-code'] input", forUsman);
  await ui.submit();
  await ui.waitFor("That code is wrong, used or expired");

  // What scripts/identity/pair-code.ts asks the hub for: a one-time browser code for Mehroz.
  const code = hub.svc.store.createCode("mehroz", "browser", "usman").code;
  await ui.type("[data-testid='waiting-for-code'] input", code);
  await ui.submit();
  await ui.waitFor("Paired browser over Tailscale");
  expect(ui.text()).not.toContain("This browser needs a code");
  const me = await (await wv.fetchImpl("/__devices/me")).json();
  expect(me.session).toMatchObject({ personId: "mehroz", via: "code" });
  expect(me.principal).toMatchObject({ personId: "mehroz", via: "paired-session", actor: "human" });
  expect(me.waitingSession).toBeNull();
  // The pending session this browser held is retired by the redeem, so it is not left in the list to be approved later.
  expect(hub.svc.store.sessions("mehroz").filter((x) => x.pending && !x.revokedAt)).toHaveLength(0);

  // One time: the same code in another browser is refused.
  const other = webview("mehroz");
  const res = await other.fetchImpl("/__devices/pair/redeem", { method: "POST", headers: { "content-type": "application/json", "x-claude-os-token": pageTokenFor({ personId: "mehroz", via: "tailnet-person" }, "synthetic-page-token") }, body: JSON.stringify({ code }) });
  expect(res.status).toBe(403);
});

test("a confirmed browser of the same person approves the waiting one; the other founder cannot", async () => {
  // Mehroz's first browser is confirmed with a console code.
  const a = webview("mehroz");
  const uiA = await mount(a);
  await uiA.waitFor("Pair this device");
  await uiA.click("Pair this device");
  await uiA.waitFor("This browser needs a code");
  await uiA.type("[data-testid='waiting-for-code'] input", hub.svc.store.createCode("mehroz", "browser", "usman").code);
  await uiA.submit();
  await uiA.waitFor("Paired browser over Tailscale");

  // His second browser (a new WebView profile) pairs with the bare login and waits.
  const b = webview("mehroz");
  const uiB = await mount(b);
  await uiB.waitFor("Pair this device");
  await uiB.click("Pair this device");
  await uiB.waitFor("This browser needs a code");

  const waitingB = (await (await b.fetchImpl("/__devices/me")).json()).waitingSession;
  expect(uiB.text()).toContain(waitingB.matchCode); // the waiting page shows the same code the approver is asked for

  // Usman cannot approve it (manage only your own devices) ...
  const usmanRows = (await hub.browser("usman").post("/pair/tailnet", { label: "Usman PC" })).json;
  expect(usmanRows.pending).toBe(true);
  const pendingId = hub.svc.store.sessions("mehroz").find((s) => s.pending)!.id;
  const refused = await hub.browser("usman").post("/sessions/approve", { sessionId: pendingId });
  expect(refused.status).toBe(403);

  // ... but Mehroz's confirmed first browser sees an Approve button and uses it.
  const uiA2 = await mount(a);
  await uiA2.waitFor("waiting to be confirmed");
  await uiA2.click("Approve…");
  await uiA2.waitFor("Approve only if this matches the code on the new device");
  expect(uiA2.text()).not.toContain(waitingB.matchCode); // the approver's screen never shows it (it cannot be copied from there)
  const listed = (await (await a.fetchImpl("/__devices/sessions")).json()).sessions.find((x: any) => x.id === waitingB.id);
  expect(listed).toBeDefined();
  expect(listed.matchCode).toBeUndefined(); // nor does the session list another session receives
  expect(uiA2.text()).toContain(waitingB.source);
  // A wrong code is refused by the SERVER and nothing is approved.
  await uiA2.type("[data-testid='approve-form'] input", "ZZZ-999");
  await uiA2.submit("[data-testid='approve-form']");
  await uiA2.waitFor("does not match");
  expect(hub.svc.store.sessions("mehroz").find((x) => x.id === waitingB.id)?.pending).toBe(true);
  await uiA2.click("Approve…");
  await uiA2.type("[data-testid='approve-form'] input", waitingB.matchCode.toLowerCase().replace("-", " "));
  await uiA2.submit("[data-testid='approve-form']");
  await uiA2.waitFor("It is confirmed now");
  const meB = await (await b.fetchImpl("/__devices/me")).json();
  expect(meB.session).toMatchObject({ personId: "mehroz", via: "tailnet" });
  expect(meB.principal.actor).toBe("human");
});

test("the pairing cookie is scoped for the HTTPS origin: HttpOnly, SameSite=Strict, Secure, whole site, 30 days", async () => {
  const wv = webview("mehroz");
  await wv.fetchImpl("/__devices/pair/tailnet", { method: "POST", headers: { "content-type": "application/json", "x-claude-os-token": pageTokenFor({ personId: "mehroz", via: "tailnet-person" }, "synthetic-page-token") }, body: JSON.stringify({ label: "Desktop app" }) });
  const c = wv.setCookies.find((x) => x.startsWith("mu_session="))!;
  expect(c).toBeDefined();
  expect(c).toContain("HttpOnly");
  expect(c).toContain("SameSite=Strict"); // the desktop app's own navigation() is same-origin, so Strict still sends it
  expect(c).toContain("Secure"); // arrived over the Serve HTTPS origin
  expect(c).toContain("Path=/");
  expect(c).not.toMatch(/Domain=/i); // host-only: another port of the same host shares it only because browsers ignore ports, which the hub tolerates
  expect(c).toContain(`Max-Age=${30 * 24 * 60 * 60}`); // persistent, so WebView2 writes it to its profile
});

test("the console command names the right person and the hub's own port", () => {
  expect(consoleCodeCommand("mehroz")).toBe("bun scripts/identity/pair-code.ts --for mehroz --port 8081");
  expect(consoleCodeCommand("usman")).toBe("bun scripts/identity/pair-code.ts --for usman --port 8081");
  expect(consoleCodeCommand(null)).toBe("bun scripts/identity/pair-code.ts --for usman --port 8081");
  expect(consoleCodeCommand("someone-else")).toBe("bun scripts/identity/pair-code.ts --for usman --port 8081");
});

test("server side: approving a pending Tailscale browser needs ITS match code (missing or wrong is refused, a script's browser cannot be approved by a blind click)", async () => {
  // Mehroz's real, confirmed browser.
  const real = hub.browser("mehroz");
  const first = await real.post("/pair/tailnet", { label: "first" });
  const code = hub.svc.store.createCode("mehroz", "browser", "usman").code;
  expect((await real.post("/pair/redeem", { code, label: "Desktop app" })).status).toBe(200);
  // A program on his machine pairs a pending session and picks the SAME friendly label as his app.
  const script = hub.browser("mehroz");
  const pending = (await script.post("/pair/tailnet", { label: "Desktop app" })).json;
  expect(pending.pending).toBe(true);
  // His new real browser (the one he is actually sitting at) is pending too, with its own code.
  const mine = hub.browser("mehroz");
  const mineP = (await mine.post("/pair/tailnet", { label: "Desktop app" })).json;
  expect(mineP.session.matchCode).toMatch(/^[0-9A-F]{3}-[0-9A-F]{3}$/);
  expect(pending.session.matchCode).not.toBe(mineP.session.matchCode);
  const id = pending.session.id as string;
  const still = () => hub.svc.store.sessions("mehroz").find((x) => x.id === id)?.pending === true;

  const none = await real.post("/sessions/approve", { sessionId: id });
  expect(none.status).toBe(400);
  const blank = await real.post("/sessions/approve", { sessionId: id, matchCode: "  " });
  expect(blank.status).toBe(400);
  // The code on his own screen, typed against the script's row: refused.
  const blind = await real.post("/sessions/approve", { sessionId: id, matchCode: mineP.session.matchCode });
  expect(blind.status).toBe(403);
  expect(blind.json.error).toContain("does not match");
  expect(still()).toBe(true);
  // The other founder never gets as far as the code.
  expect((await hub.browser("usman").post("/sessions/approve", { sessionId: id, matchCode: pending.session.matchCode })).status).toBe(403);
  // The matching code approves, in any letter case or spacing.
  const ok = await real.post("/sessions/approve", { sessionId: mineP.session.id, matchCode: mineP.session.matchCode.toLowerCase().replace("-", " ") });
  expect(ok.status).toBe(200);
  expect(still()).toBe(true); // the script's session is untouched
  void first;
});
