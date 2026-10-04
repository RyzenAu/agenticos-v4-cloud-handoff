import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { ProfilePanel } from "../../src/components/profile/profile-panel";
import { createProfileApi } from "../../src/components/profile/profile-api";
import { startHub, type Hub, type Who } from "./test-harness";
import { pageTokenFor } from "../identity/principal";

// The profile UI against the real /__devices handler (synthetic people, simulated Tailscale).

let hub: Hub;
let root: Root | undefined;
const restore: Array<() => void> = [];
function setGlobal(name: string, value: unknown) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  restore.push(() => (previous ? Object.defineProperty(globalThis, name, previous) : Reflect.deleteProperty(globalThis, name)));
}

beforeEach(async () => (hub = await startHub()));
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  while (restore.length) restore.pop()!();
  await hub.close();
});

/** A fetch that behaves like this person's browser: their Tailscale headers and cookie jar. */
function browserFetch(who: Who, cookie?: string): typeof fetch {
  const jar = new Map<string, string>();
  // The owner's browser at this PC holds his confirmed hub session (the harness mints it); a test can
  // hand in another hub cookie (a pending browser).
  if (who === "local") for (const [k, v] of cookie ? [["mu_session", cookie] as const] : hub.browser("local").jar) jar.set(k, v);
  return (async (input: any, init: any = {}) => {
    const url = String(input);
    const path = url.startsWith("/") ? url : new URL(url).pathname;
    // What GET /__token hands this person (Stage B1): internal at the PC, person-bound remotely.
    const token = who === "local" ? "synthetic-page-token" : pageTokenFor({ personId: who === "stranger" ? "mehroz" : who, via: "tailnet-person" }, "synthetic-page-token");
    if (path === "/__token") return new Response(JSON.stringify({ token }), { headers: { "content-type": "application/json" } });
    const headers: Record<string, string> = { ...(init.headers ?? {}), ...hub.headersFor(who) };
    if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
    const res = await fetch(`${hub.base}${path}`, { ...init, headers });
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [pair] = c.split(";");
      const eq = pair.indexOf("=");
      if (/Max-Age=0/.test(c)) jar.delete(pair.slice(0, eq));
      else jar.set(pair.slice(0, eq), pair.slice(eq + 1));
    }
    return res;
  }) as typeof fetch;
}

async function mount(who: Who, cookie?: string) {
  const { window } = parseHTML("<html><body><main></main></body></html>");
  setGlobal("window", window);
  setGlobal("document", window.document);
  setGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = window.document.querySelector("main")!;
  root = createRoot(container);
  const api = createProfileApi("/__devices", browserFetch(who, cookie));
  await act(async () => root!.render(<ProfilePanel api={api} />));
  const text = () => container.textContent ?? "";
  const waitFor = async (needle: string, ms = 3000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (text().includes(needle)) return true;
      await act(async () => void (await new Promise((r) => setTimeout(r, 25))));
    }
    throw new Error(`"${needle}" never appeared. Page text: ${text().slice(0, 400)}`);
  };
  const click = async (label: string) =>
    act(async () => {
      const button = [...container.querySelectorAll("button")].find((b: any) => b.textContent.trim() === label);
      expect(button).toBeDefined();
      button!.dispatchEvent(new window.Event("click", { bubbles: true }));
    });
  return { container, text, waitFor, click };
}

test("Mehroz pairs this browser with his Tailscale login, then sees his profile", async () => {
  const ui = await mount("mehroz");
  await ui.waitFor("Pair this device");
  expect(ui.text()).toContain("Tailscale says this is Mehroz");
  await ui.click("Pair this device");
  // Stage B1: his verified Tailscale login already signs him in, so the profile shows before pairing;
  // wait for the remembered session itself.
  await ui.waitFor("Paired browser over Tailscale");
  await ui.waitFor("Usman's PC"); // devices load after the profile
  expect(ui.text()).toContain("Signed in as" + "Mehroz");
  expect(ui.text()).toContain("Mehroz's browserthis device");
  expect(ui.text()).toContain("Paired browser over Tailscale");
  expect(ui.text()).toContain("shared memory, Usman's memory, Mehroz's memory · finance"); // V7: full workspace access for both founders
  expect(ui.text()).toContain("Who's online");
  expect(ui.text()).toContain("Usman's PC");
});

test("the name picker narrows access and says so", async () => {
  const ui = await mount("mehroz");
  await ui.waitFor("Pair this device");
  await ui.click("Pair this device");
  // Stage B1: his verified Tailscale login already signs him in, so the profile shows before pairing;
  // wait for the remembered session itself.
  await ui.waitFor("Paired browser over Tailscale");
  await ui.click("Usman");
  await ui.waitFor("Showing as Usman, but this device is paired to Mehroz");
  expect(ui.text()).toContain("no device control");
});

test("Usman at his PC sees everyone's devices and can make a code for Mehroz", async () => {
  const ui = await mount("local");
  await ui.waitFor("At Usman's PC (this computer)");
  expect(ui.text()).toContain("finance");
  // His own browser here is listed (the confirmed hub session the gate minted on his first page load).
  expect(ui.text()).toContain("This PC's browserthis device");
  await ui.click("Code for a companion");
  await ui.waitFor("Companion code for Usman");
  expect(ui.text()).toMatch(/[A-Z2-9]{4}-[A-Z2-9]{4}/);
});

test("a stranger's browser gets a clear refusal, not a profile", async () => {
  const ui = await mount("stranger");
  await ui.waitFor("Local host required");
});

test("REVIEW-S1 F2b: the owner makes a confirm code on his confirmed browser; a pending browser is never shown one", async () => {
  const ui = await mount("local");
  await ui.waitFor("Confirm a new browser at this PC");
  expect(ui.text()).not.toMatch(/[A-Z2-9]{4}-[A-Z2-9]{4}/);
  await ui.click("Make a confirm code");
  await ui.waitFor("Make another code");
  expect(ui.text()).toMatch(/[A-Z2-9]{4}-[A-Z2-9]{4}/);
  await act(async () => root!.unmount());
  root = undefined;
  const pending = encodeURIComponent(hub.svc.store.mintSession("usman", "This PC's browser", "hub", { pending: true }).cookie);
  const other = await mount("local", pending);
  await other.waitFor("Confirm this browser");
  expect(other.text()).toContain("type the code here");
  expect(other.text()).not.toMatch(/[A-Z2-9]{4}-[A-Z2-9]{4}/);
  // R7 review m6: the confirm command sits behind a collapsed "Technical detail"; the page above it is plain words.
  const details = [...other.container.querySelectorAll("details")] as any[];
  const holder = details.find((d) => /confirm-browser/.test(d.textContent));
  expect(holder).toBeTruthy();
  expect(holder.hasAttribute("open")).toBe(false);
  expect(holder.querySelector("summary").textContent).toBe("Technical detail");
  const clone = other.container.cloneNode(true) as any;
  clone.querySelectorAll("details").forEach((d: any) => d.remove());
  expect(clone.textContent).not.toMatch(/confirm-browser|scripts\//);
  expect(clone.textContent).toContain("run the confirm command on the hub PC");
});

// Radix's AlertDialog can't open under linkedom: its layout-effect guard is fixed when the module first
// loads (a no-op without a document, and bun shares one module cache across test files) and its
// focus/scroll locks need layout APIs linkedom lacks. These tests are about the panel's flow, not
// Radix, so the dialog is swapped for a plain one with the same parts for this file, then restored.
const realDialog = { ...(await import("../../src/components/ui/alert-dialog")) };
const DialogCtx = React.createContext<(open: boolean) => void>(() => {});
const Pass = ({ children }: { children?: React.ReactNode }) => <>{children}</>;
mock.module("../../src/components/ui/alert-dialog", () => ({
  ...realDialog,
  AlertDialog: ({ open, onOpenChange, children }: { open?: boolean; onOpenChange?: (o: boolean) => void; children?: React.ReactNode }) =>
    open ? <DialogCtx.Provider value={onOpenChange ?? (() => {})}><div role="alertdialog">{children}</div></DialogCtx.Provider> : null,
  AlertDialogContent: Pass,
  AlertDialogHeader: Pass,
  AlertDialogFooter: Pass,
  AlertDialogTitle: Pass,
  AlertDialogDescription: Pass,
  AlertDialogCancel: ({ children }: { children?: React.ReactNode }) => {
    const set = React.useContext(DialogCtx);
    return <button type="button" onClick={() => set(false)}>{children}</button>;
  },
  AlertDialogAction: ({ children, onClick }: { children?: React.ReactNode; onClick?: () => void }) => <button type="button" onClick={onClick}>{children}</button>,
}));
afterAll(() => void mock.module("../../src/components/ui/alert-dialog", () => realDialog));

async function waitForDialog(needle: string, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if ((document.querySelector('[role="alertdialog"]')?.textContent ?? "").includes(needle)) return;
    await act(async () => void (await new Promise((r) => setTimeout(r, 25))));
  }
  throw new Error(`dialog never showed "${needle}". Body: ${(document.body.textContent ?? "").slice(-300)}`);
}

// Audit F3-02: revoke asks first, names what it revokes and what else changes, and says it worked.
test("Usman revokes Mehroz's browser only after a confirmation that names it, then sees a visible notice", async () => {
  const laptop = hub.browser("mehroz");
  expect((await laptop.post("/pair/tailnet", { label: "Mehroz's laptop" })).status).toBe(200);
  const ui = await mount("local");
  await ui.waitFor("Mehroz's laptop");
  await ui.click("Revoke");
  // Nothing is sent on the first click: the browser is still listed and still signed in.
  await waitForDialog('Revoke "Mehroz\'s laptop"?');
  const dialog = () => document.querySelector('[role="alertdialog"]')?.textContent ?? "";
  expect(dialog()).toContain("Mehroz's browser, paired");
  expect(dialog()).toContain("can pair a browser again with their Tailscale login");
  expect((await laptop.get("/me")).json.session).not.toBeNull();
  await act(async () => {
    const confirm = [...document.querySelectorAll('[role="alertdialog"] button')].find((b: any) => b.textContent.trim() === "Revoke browser");
    expect(confirm).toBeDefined();
    confirm!.dispatchEvent(new (window as any).Event("click", { bubbles: true }));
  });
  await ui.waitFor('Revoked "Mehroz\'s laptop".');
  const notice = ui.container.querySelector('[data-testid="profile-notice"]');
  expect(notice).not.toBeNull();
  expect(notice!.closest(".sr-only")).toBeNull();
  expect((await laptop.get("/me")).json.session ?? null).toBeNull();
});

test("Cancel sends nothing; 'Revoke and require a code' revokes and turns off Tailscale self-pairing", async () => {
  const laptop = hub.browser("mehroz");
  await laptop.post("/pair/tailnet", { label: "Lost phone" });
  const ui = await mount("local");
  await ui.waitFor("Lost phone");
  const dialogButton = (label: string) =>
    act(async () => {
      const b = [...document.querySelectorAll('[role="alertdialog"] button')].find((x: any) => x.textContent.trim() === label);
      expect(b).toBeDefined();
      b!.dispatchEvent(new (window as any).Event("click", { bubbles: true }));
    });
  await ui.click("Revoke");
  await waitForDialog('Revoke "Lost phone"?');
  const dialog = () => document.querySelector('[role="alertdialog"]')?.textContent ?? "";
  expect(dialog()).toContain("Revoke and require a code: Mehroz's next new device will need a one-time pairing code");
  await dialogButton("Cancel");
  expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  expect((await laptop.get("/me")).json.session).not.toBeNull();
  expect(ui.text()).not.toContain("Revoked");

  await ui.click("Revoke");
  await waitForDialog('Revoke "Lost phone"?');
  await dialogButton("Revoke and require a code");
  await ui.waitFor("Revoked \"Lost phone\". Mehroz's next new device needs a pairing code.");
  expect((await laptop.get("/me")).json.session ?? null).toBeNull();
  expect((await hub.browser("mehroz").post("/pair/tailnet", { label: "New phone" })).status).not.toBe(200);
});

test("revokeConsequence: this device, and a companion machine", async () => {
  const { revokeConsequence } = await import("../../src/components/profile/profile-panel");
  const people = [{ id: "usman" as const, name: "Usman" }, { id: "mehroz" as const, name: "Mehroz" }];
  const session = { id: "s1", personId: "mehroz" as const, label: "Study PC", via: "code" as const, createdAt: 1, expiresAt: 2, lastSeen: 1, revoked: false, expired: false, current: true };
  const own = revokeConsequence({ kind: "session", session }, people);
  expect(own.lines[0]).toBe("This is the browser you're using now. It is signed out as soon as you confirm.");
  const device = { id: "d1", owner: "mehroz" as const, kind: "companion" as const, label: "Mehroz's PC", aliases: [], primary: false, online: true, lastSeen: 1, micOwned: false, busy: false, pairedAt: 1, expiresAt: 2, revoked: false };
  const machine = revokeConsequence({ kind: "device", device }, people);
  expect(machine.title).toBe('Revoke "Mehroz\'s PC"?');
  expect(machine.lines[0]).toContain("Jarvis can't act on it until it's paired again");
});

test("machineLine: a shared bot computer is never \"shared's machine\"; a person's own device is theirs", async () => {
  const { machineLine } = await import("../../src/components/profile/profile-panel");
  const people = [{ id: "usman" as const, name: "Usman" }, { id: "mehroz" as const, name: "Mehroz" }];
  expect(machineLine({ owner: "shared", kind: "cloud-computer", online: true, busy: false }, people)).toBe("Shared bot computer · online");
  expect(machineLine({ owner: "shared", kind: "cloud-computer", online: false, busy: false }, people)).toBe("Shared bot computer · offline");
  expect(machineLine({ owner: "usman", kind: "hub", online: true, busy: false }, people)).toBe("Usman's PC · online");
  expect(machineLine({ owner: "mehroz", kind: "companion", online: true, busy: true }, people)).toBe("Mehroz's computer · online, working");
});

test("browsers opened at this PC are counted, not listed as identical revocable rows", async () => {
  const { window } = parseHTML("<html><body><main></main></body></html>");
  setGlobal("window", window);
  setGlobal("document", window.document);
  setGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = window.document.querySelector("main")!;
  root = createRoot(container);
  const hubSession = (id: string) => ({ id, personId: "usman", label: "This PC's browser", via: "hub", createdAt: 1, expiresAt: Date.now() + 86_400_000, lastSeen: 1, revoked: false, expired: false, current: false });
  const api = {
    me: async () => ({ authorised: true, via: "loopback", person: { id: "usman", name: "Usman" }, displayAs: null, sharedOnly: false, local: true, session: null, canSelfPair: false, people: [{ id: "usman", name: "Usman" }], permissions: { business: true, memory: ["shared"], finance: true, devices: "own" } }),
    devices: async () => ({ devices: [], people: [] }),
    sessions: async () => ({ sessions: [hubSession("h1"), hubSession("h2"), hubSession("h3")] }),
  } as any;
  await act(async () => root!.render(<ProfilePanel api={api} />));
  await act(async () => void (await new Promise((r) => setTimeout(r, 50))));
  expect(container.textContent).toContain("Plus 3 browsers opened at this PC");
  expect(container.textContent).not.toContain("This PC's browser");
  expect([...container.querySelectorAll("button")].filter((b: any) => b.textContent.trim() === "Revoke")).toHaveLength(0);
});

test("merge review: a pending browser at this PC is listed and revocable, never folded into the count", async () => {
  const { window } = parseHTML("<html><body><main></main></body></html>");
  setGlobal("window", window);
  setGlobal("document", window.document);
  setGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = window.document.querySelector("main")!;
  root = createRoot(container);
  const hubSession = (id: string, extra: Record<string, unknown> = {}) => ({ id, personId: "usman", label: "This PC's browser", via: "hub", createdAt: 1, expiresAt: Date.now() + 86_400_000, lastSeen: 1, revoked: false, expired: false, current: false, ...extra });
  const api = {
    me: async () => ({ authorised: true, via: "loopback", person: { id: "usman", name: "Usman" }, displayAs: null, sharedOnly: false, local: true, session: null, canSelfPair: false, people: [{ id: "usman", name: "Usman" }], permissions: { business: true, memory: ["shared"], finance: true, devices: "own" } }),
    devices: async () => ({ devices: [], people: [] }),
    sessions: async () => ({ sessions: [hubSession("h1"), hubSession("h2"), hubSession("p1", { pending: true })] }),
  } as any;
  await act(async () => root!.render(<ProfilePanel api={api} />));
  await act(async () => void (await new Promise((r) => setTimeout(r, 50))));
  expect(container.textContent).toContain("waiting to be confirmed");
  expect(container.textContent).toContain("Plus 2 other browsers opened at this PC");
  expect([...container.querySelectorAll("button")].filter((b: any) => b.textContent.trim() === "Revoke")).toHaveLength(1);
});
