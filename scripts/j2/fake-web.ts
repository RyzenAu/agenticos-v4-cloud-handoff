// A fake web for the J6 task-loop tests: the agent-browser CLI's answers (the CDP stub) over a small graph of fake pages.
// Nothing here is a browser or a network: pages are data, and clicking, typing and pressing Enter move through them.
// It records every click and typed value, and every press of a button whose name is a final one ("Send", "Pay"…), so a test can
// say "nothing was submitted".
import type { AbRun } from "./agent-browser";

export type FakeNode = {
  role: string;
  name: string;
  /** A link's address: clicking it goes there (in a new tab when `newTab`). */
  url?: string;
  newTab?: boolean;
  /** What the control really carries beside its accessible name. */
  attrs?: Partial<Record<"type" | "autocomplete" | "name" | "id" | "placeholder" | "aria-label" | "title" | "value" | "alt", string>>;
  text?: string;
  depth?: number;
  level?: number;
  /** A heading inside a link: shown by the interactive snapshot too. */
  nested?: boolean;
  /** A lone search box (Enter searches) and where Enter goes. */
  search?: boolean;
  onEnter?: string | ((value: string) => string);
  /** Fields of one form share a group: Enter in a field of a multi-field form would submit it. */
  form?: string;
  onClick?: (web: FakeWebHandle) => void;
};
export type FakePage = {
  title: string;
  text?: string;
  nodes: FakeNode[];
  footer?: string;
  video?: { paused: boolean };
  password?: boolean;
  card?: boolean;
};
export type FakeWebHandle = { page: () => FakePage; goto: (url: string) => void };

const INTERACTIVE = new Set(["link", "button", "textbox", "searchbox", "combobox", "checkbox", "radio", "tab", "menuitem", "switch"]);

export function createFakeWeb(pages: Record<string, FakePage> | ((url: string) => FakePage | null | undefined)) {
  type Tab = { tabId: string; targetId: string; url: string; history: string[]; values: Map<FakeNode, string>; focus: FakeNode | null };
  const lookup = (url: string): FakePage => {
    const p = typeof pages === "function" ? pages(url) : pages[url] ?? pages[url.replace(/\/$/, "")] ?? pages[`${url}/`];
    return p ?? { title: `${url}`, text: `The page at ${url}.`, nodes: [] };
  };
  const tabs: Tab[] = [{ tabId: "t1", targetId: "T1", url: "chrome://newtab/", history: ["chrome://newtab/"], values: new Map(), focus: null }];
  let active = 0;
  let n = 1;
  const log: string[] = [];
  const clicked: string[] = [];
  const typed: Array<{ field: string; text: string }> = [];
  const submitted: string[] = [];
  const FINAL = /^(?:send|submit|pay|confirm|place order|buy|post|publish|delete|book|subscribe)\b/i;
  let refs: FakeNode[] = [];
  const tab = () => tabs[active];
  const pageNow = () => lookup(tab().url);
  const goto = (t: Tab, url: string) => {
    t.url = url;
    t.history.push(url);
    t.values = new Map();
    t.focus = null;
  };
  const handle: FakeWebHandle = { page: pageNow, goto: (url) => goto(tab(), url) };
  const shown = (p: FakePage, interactive: boolean) => p.nodes.filter((x) => !interactive || INTERACTIVE.has(x.role) || (x.role === "heading" && x.nested));
  const view = (t: Tab) => {
    const p = lookup(t.url);
    return { url: t.url, title: p.title, ready: true, text: `${p.title} ${p.text ?? ""}`.replace(/\s+/g, " ").slice(0, 2500), password: !!p.password, card: !!p.card, video: p.video ? { paused: p.video.paused, ended: false } : null };
  };

  const run: AbRun = async (argv) => {
    const cmd = argv.slice(4).filter((a) => a !== "--json");
    const ok = (data: unknown = {}) => ({ code: 0, stdout: JSON.stringify({ success: true, data, error: null }) + "\n", stderr: "" });
    const bad = (error: string) => ({ code: 1, stdout: JSON.stringify({ success: false, data: null, error }) + "\n", stderr: "" });
    log.push(cmd.join(" "));
    const [c, sub, arg] = cmd;
    const t = tab();
    const page = pageNow();
    const nodeOf = (ref: string) => refs[Number(String(ref).replace("@e", "")) - 1];
    if (c === "tab") {
      if (!sub) return ok({ tabs: tabs.map((x, i) => ({ tabId: x.tabId, targetId: x.targetId, title: lookup(x.url).title, url: x.url, type: "page", active: i === active })) });
      if (sub === "new") {
        const nt: Tab = { tabId: `t${++n}`, targetId: `T${n}`, url: "about:blank", history: ["about:blank"], values: new Map(), focus: null };
        tabs.push(nt);
        active = tabs.length - 1;
        if (arg) goto(nt, arg);
        return ok({ tabId: nt.tabId, targetId: nt.targetId, url: nt.url, total: tabs.length });
      }
      if (sub === "close") {
        if (tabs.length === 1) return bad("Cannot close the last tab");
        tabs.splice(active, 1);
        active = Math.min(active, tabs.length - 1);
        return ok({});
      }
      const i = tabs.findIndex((x) => x.tabId === sub || x.targetId === sub);
      if (i < 0) return bad(`No tab ${sub}`);
      active = i;
      return ok({ tabId: tabs[i].tabId, targetId: tabs[i].targetId, url: tabs[i].url });
    }
    if (c === "open") return goto(t, sub), ok({ url: sub });
    if (c === "back") {
      if (t.history.length < 2) return bad("No previous page");
      t.history.pop();
      t.url = t.history[t.history.length - 1];
      return ok({ url: t.url });
    }
    if (c === "forward" || c === "reload") return ok({ url: t.url });
    if (c === "scroll") return ok({ scrolled: true });
    if (c === "get" && sub === "title") return ok({ title: page.title });
    if (c === "get" && sub === "url") return ok({ url: t.url });
    if (c === "get" && sub === "text" && String(arg).startsWith("@e")) {
      const x = nodeOf(arg);
      return x ? ok({ text: x.text ?? x.name }) : bad("Element not found");
    }
    if (c === "get" && sub === "text") return ok({ text: `${page.text ?? ""}` });
    if (c === "get" && sub === "attr") {
      const x = nodeOf(arg);
      if (!x) return bad("Element not found");
      const key = cmd[3];
      const own = x.attrs?.[key as keyof NonNullable<FakeNode["attrs"]>];
      if (own !== undefined) return ok({ value: own });
      if (key === "aria-label" || key === "title" || key === "value" || key === "alt") return ok({ value: null });
      return ok({ value: x.role === "searchbox" && key === "type" ? "search" : null });
    }
    if (c === "snapshot") {
      const interactive = cmd.includes("-i");
      const list = shown(page, interactive);
      refs = list;
      const lines = list.map((x, i) => `${"  ".repeat(x.depth ?? 0)}- ${x.role} "${x.name.replace(/"/g, '\\"')}" [${[x.level ? `level=${x.level}` : "", `ref=e${i + 1}`, x.url && cmd.includes("-u") ? `url=${x.url}` : ""].filter(Boolean).join(", ")}]`);
      const refMap: Record<string, { role: string; name: string }> = {};
      list.forEach((x, i) => (refMap[`e${i + 1}`] = { role: x.role, name: x.name }));
      return ok({ refs: refMap, snapshot: lines.join("\n") });
    }
    if (c === "eval") {
      const js = Buffer.from(String(cmd[2] ?? ""), "base64").toString("utf8");
      if (js.startsWith("/*view*/")) return ok({ result: view(t) });
      if (js.startsWith("/*focus*/")) {
        const f = t.focus;
        if (!f) return ok({ result: { ok: false } });
        const others = f.search ? 0 : page.nodes.filter((x) => x !== f && x.form && x.form === f.form && (x.role === "textbox" || x.role === "combobox")).length;
        return ok({ result: { ok: true, inSearch: !!f.search || f.role === "searchbox", others } });
      }
      if (js.startsWith("/*footer*/")) return ok({ result: page.footer ?? "" });
      if (js.startsWith("/*bottom*/")) return ok({ result: true });
      return ok({ result: { title: page.title, url: t.url, text: `${page.title}\n${page.text ?? ""}`, nearby: "", controls: page.nodes.map((x) => x.name).join("\n"), embeds: false, progress: false } });
    }
    if (c === "click") {
      const x = nodeOf(sub);
      if (!x) return bad("Element not found");
      clicked.push(x.name);
      if (x.role === "button" && FINAL.test(x.name)) submitted.push(x.name);
      x.onClick?.(handle);
      if (x.url) {
        if (x.newTab) {
          const nt: Tab = { tabId: `t${++n}`, targetId: `T${n}`, url: x.url, history: [x.url], values: new Map(), focus: null };
          tabs.push(nt);
        } else goto(t, x.url);
      }
      return ok({ clicked: sub });
    }
    if (c === "fill") {
      const x = nodeOf(sub);
      if (!x) return bad("Element not found");
      t.values.set(x, String(arg));
      t.focus = x;
      typed.push({ field: x.name, text: String(arg) });
      return ok({ filled: sub });
    }
    if (c === "press") {
      const f = t.focus;
      if (String(sub).toLowerCase() === "enter" && f?.onEnter) {
        const value = t.values.get(f) ?? "";
        goto(t, typeof f.onEnter === "function" ? f.onEnter(value) : f.onEnter);
      } else if (String(sub).toLowerCase() === "enter" && f?.form) submitted.push(`Enter in ${f.name}`);
      return ok({ pressed: sub });
    }
    return bad(`unknown command ${c}`);
  };
  return { run, tabs, log, clicked, typed, submitted, active: () => tabs[active], get count() { return tabs.length; } };
}
