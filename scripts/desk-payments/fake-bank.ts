// A FAKE Jarvis Chrome for desk payment tests and the synthetic preview: the agent-browser CLI's answers over a few
// pages a test can change between the confirm card and the press (a bill page, a bank review step, a login, a shop cart).
// SYNTHETIC: no browser, no network, no real bank, no card data: every number, name and host here is made up, and the
// "Pay" button only ever mutates a JS object. `run` plugs into createAgentBrowserHands({ run }).
import { createHash } from "node:crypto";
import type { AbRun } from "../j2/agent-browser";
import type { DeskPage } from "../j2/agent-browser";

export type FakeControl = { role: string; name: string; text?: string; aria?: string; title?: string; value?: string };
export type FakePage = {
  title: string;
  text: string;
  controls: FakeControl[];
  fields?: Partial<DeskPage["fields"]>;
  /** Not finished loading for this many reads (the hands wait for `ready`). */
  loading?: number;
  /** Something drawn over the buttons (an overlay, a frame): what a click at a button's centre would really hit. */
  overlay?: string;
  /** A press of a control by name: mutate the world (navigate to a receipt page, change an amount…). */
  onClick?: (name: string, world: FakeWorld) => void;
};
export type FakeTab = { tabId: string; targetId: string; title: string; url: string; type: "page"; history: string[] };
export type FakeWorld = { pages: Record<string, FakePage>; tabs: FakeTab[]; go(url: string): void; active(): FakeTab };
/** Test hook: the final press may be a checked page evaluation instead of a separate CLI click. */
export function isDeskPressCall(argv: string[]): boolean {
  if (argv.includes("click")) return true;
  const at = argv.indexOf("eval");
  return at >= 0 && typeof argv[at + 2] === "string" && Buffer.from(argv[at + 2], "base64").toString("utf8").startsWith("/*DESK_ATOMIC_PRESS:");
}

const BASE_FIELDS: DeskPage["fields"] = { passwordPresent: false, passwordEmpty: false, cardPresent: false, cardEmpty: false, cardFrame: false, otpEmpty: false };

/** An electricity bill at its pay step, with a saved card: Total A$120.00, "Pay A$120.00". The receipt page follows a press. */
export function billPage(o: { payee?: string; amount?: string; button?: string; receiptText?: string; extra?: string } = {}): FakePage {
  const payee = o.payee ?? "Origin Energy";
  const amount = o.amount ?? "A$120.00";
  const button = o.button ?? `Pay ${amount}`;
  return {
    title: `Pay your bill - ${payee}`,
    text: `Pay your bill\nPaying: ${payee}\nAccount 4471 2210\nTotal ${amount}\nPaying with card ending 4242${o.extra ? `\n${o.extra}` : ""}`,
    controls: [{ role: "link", name: "Back to account" }, { role: "button", name: button }, { role: "button", name: "Cancel" }],
    onClick: (name, world) => {
      if (name !== button) return;
      const tab = world.active();
      world.pages[tab.url] = {
        title: "Payment successful",
        text: o.receiptText ?? `Payment successful\nThank you for your payment of ${amount} to ${payee}\nReceipt number: OE-88231907`,
        controls: [{ role: "link", name: "Back to account" }],
      };
      tab.title = "Payment successful";
    },
  };
}
/** A bank's login: the password is empty, so it's his to type. */
export const loginPage = (bank = "Fake Bank"): FakePage => ({
  title: `${bank} - Log in`,
  text: `Log in to ${bank}\nMember number\nPassword`,
  controls: [{ role: "button", name: "Log in" }],
  fields: { passwordPresent: true, passwordEmpty: true },
});
/** A bank review step: pay a saved payee, with a bare "Confirm" button. */
export const bankReviewPage = (o: { payee?: string; amount?: string } = {}): FakePage => ({
  title: "Fake Bank - Review your payment",
  text: `Review your payment\nPaying: ${o.payee ?? "Telstra"}\nFrom account: Everyday 1234\nAmount ${o.amount ?? "$89.90"}\nTotal ${o.amount ?? "$89.90"}`,
  controls: [{ role: "button", name: "Confirm" }, { role: "button", name: "Cancel" }],
  onClick: (name, world) => {
    if (name !== "Confirm") return;
    const tab = world.active();
    world.pages[tab.url] = { title: "Payment complete", text: "Payment complete\nReceipt number: FB-55012345\nThank you for your payment", controls: [] };
    tab.title = "Payment complete";
  },
});
/** A page with no way to pay (a home page, a plain site). */
export const homePage = (name = "Origin Energy"): FakePage => ({ title: `${name} | Home`, text: `Welcome to ${name}\nYour energy, sorted.`, controls: [{ role: "link", name: "Log in" }, { role: "link", name: "Plans" }] });

export function fakeChrome(pages: Record<string, FakePage>, options: { blockAttr?: boolean } = {}) {
  const tabs: FakeTab[] = [{ tabId: "t1", targetId: "T1", title: "New Tab", url: "chrome://newtab/", type: "page", history: ["chrome://newtab/"] }];
  let active = 0;
  let n = 1;
  const log: string[] = [];
  const clicked: string[] = [];
  const reads: Record<string, number> = {};
  let lastBox = "";
  const fallback = (url: string): FakePage => ({ title: (() => { try { return new URL(url).hostname; } catch { return "page"; } })(), text: `The page at ${url}.`, controls: [] });
  const pageOf = (url: string) => pages[url] ?? fallback(url);
  const world: FakeWorld = {
    pages,
    tabs,
    go(url) {
      const t = tabs[active];
      t.url = url;
      t.title = url.startsWith("http") ? pageOf(url).title : "New Tab";
      t.history.push(url);
    },
    active: () => tabs[active],
  };
  const tabsView = () => tabs.map((t, i) => ({ tabId: t.tabId, targetId: t.targetId, title: t.title, url: t.url, type: "page", active: i === active }));
  const run: AbRun = async (argv) => {
    const cmd = argv.slice(4).filter((a) => a !== "--json");
    const ok = (data: unknown = {}) => ({ code: 0, stdout: JSON.stringify({ success: true, data, error: null }) + "\n", stderr: "" });
    const bad = (error: string) => ({ code: 1, stdout: JSON.stringify({ success: false, data: null, error }) + "\n", stderr: "" });
    log.push(cmd.join(" "));
    const tab = tabs[active];
    const page = pageOf(tab.url);
    const [c, sub, arg] = cmd;
    if (c === "tab") {
      if (!sub) return ok({ tabs: tabsView() });
      if (sub === "new") {
        const t: FakeTab = { tabId: `t${++n}`, targetId: `T${n}`, title: "New Tab", url: "about:blank", type: "page", history: ["about:blank"] };
        tabs.push(t);
        active = tabs.length - 1;
        if (arg) world.go(arg);
        return ok({ tabId: t.tabId, targetId: t.targetId, url: t.url, total: tabs.length });
      }
      if (sub === "close") {
        if (tabs.length === 1) return bad("Cannot close the last tab");
        tabs.splice(active, 1);
        active = Math.min(active, tabs.length - 1);
        return ok({});
      }
      const i = tabs.findIndex((t) => t.tabId === sub || t.targetId === sub);
      if (i < 0) return bad(`No tab ${sub}`);
      active = i;
      return ok({ tabId: tabs[i].tabId, targetId: tabs[i].targetId, url: tabs[i].url });
    }
    if (c === "open") return world.go(sub), ok({ url: sub });
    const control = (ref: string) => page.controls[Number(String(ref).replace("@e", "")) - 1];
    if (c === "get" && sub === "text" && String(arg).startsWith("@e")) {
      const ctl = control(arg);
      return ctl ? ok({ text: ctl.text ?? ctl.name }) : bad("Element not found");
    }
    if (c === "get" && sub === "attr") {
      if (options.blockAttr) return bad("Element not found");
      const ctl = control(cmd[2]);
      const key = cmd[3] === "aria-label" ? "aria" : cmd[3];
      return ctl ? ok({ value: (ctl as Record<string, string | undefined>)[key] ?? null }) : bad("Element not found");
    }
    if (c === "scrollintoview") return ok({});
    if (c === "get" && sub === "box") {
      lastBox = String(arg);
      return control(arg) ? ok({ x: 10, y: 10, width: 120, height: 32 }) : bad("Element not found");
    }
    if (c === "get" && sub === "title") return ok({ title: page.title });
    if (c === "get" && sub === "url") return ok({ url: tab.url });
    if (c === "get" && sub === "text") return ok({ text: page.text });
    if (c === "snapshot") {
      const refs: Record<string, { role: string; name: string }> = {};
      page.controls.forEach((ctl, i) => (refs[`e${i + 1}`] = { role: ctl.role, name: ctl.name }));
      return ok({ refs, snapshot: Object.entries(refs).map(([r, v]) => `- ${v.role} "${v.name}" [ref=${r}]`).join("\n") });
    }
    if (c === "eval") {
      const script = Buffer.from(String(arg === undefined ? "" : cmd[2] ?? arg), "base64").toString("utf8");
      const atomic = /^\/\*DESK_ATOMIC_PRESS:([A-Za-z0-9+/=]+)\*\//.exec(script);
      if (atomic) {
        const expected = JSON.parse(Buffer.from(atomic[1], "base64").toString("utf8")) as { url: string; title: string; hash: string; name: string };
        if (tab.url.split("#")[0] !== expected.url) return ok({ result: { state: "moved" } });
        if (page.title !== expected.title || createHash("sha256").update(page.text.slice(0, 12000)).digest("hex") !== expected.hash) return ok({ result: { state: "changed" } });
        const ctl = control(lastBox);
        if (page.overlay || !ctl || !ctl.name.toLowerCase().includes(expected.name.toLowerCase())) return ok({ result: { state: "covered" } });
        clicked.push(ctl.name);
        page.onClick?.(ctl.name, world);
        return ok({ result: { state: "clicked" } });
      }
      if (/elementFromPoint/.test(script)) {
        const ctl = control(lastBox);
        return ok({ result: page.overlay ? { name: page.overlay } : ctl ? { name: ctl.name } : null });
      }
      const desk = /passwordPresent/.test(script);
      if (desk) {
        const key = `${tab.url}`;
        reads[key] = (reads[key] ?? 0) + 1;
        return ok({ result: { title: page.title, url: tab.url, ready: !(page.loading && reads[key] <= page.loading), text: page.text, controls: page.controls.map((x) => x.name).join("\n"), embeds: false, progress: false, fields: { ...BASE_FIELDS, ...page.fields } } });
      }
      return ok({ result: { title: page.title, url: tab.url, text: `${page.title}\n${page.text}`, nearby: "", controls: page.controls.map((x) => x.name).join("\n"), embeds: false, progress: false } });
    }
    if (c === "click") {
      const ctl = control(sub);
      clicked.push(ctl ? ctl.name : sub);
      if (ctl) page.onClick?.(ctl.name, world);
      return ok({ clicked: sub });
    }
    if (c === "back" || c === "forward" || c === "reload" || c === "scroll") return ok({ url: tab.url });
    return bad(`unknown command ${c}`);
  };
  return { run, tabs, log, clicked, pages, world, active: () => tabs[active] };
}
export type FakeChrome = ReturnType<typeof fakeChrome>;
