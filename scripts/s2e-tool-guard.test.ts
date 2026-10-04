// S2e (29 Sep): the Hermes tool guard, the chat classifier's misses, the coding misses and the installer's verify
// step. SYNTHETIC: fake pages and windows, a temp relay root, a real loopback relay; nothing real is driven.
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chooseGuardTarget, currentPageMoneyContext, samePageUrl, type PageMoneyContext } from "./browser-hands";
import { chatMoneyOrder, codingMoneyRefusal } from "./jarvis-execution/spoken-money";
import { toolGuard, toolGuardVerdict, toolKind } from "./away-mode/tool-guard";
import { relayMiddleware, relayTokenFile } from "./away-mode/service";
import { PLUGIN_SOURCE, verifyInstalled } from "./away-mode/install-hermes-plugin";

const dirs: string[] = [];
const temp = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), p));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* Windows may hold a handle briefly */ }
  }
});

const page = (over: Partial<PageMoneyContext> = {}): PageMoneyContext => ({
  title: "Checkout", url: "https://shop.example.com/checkout", text: "Checkout\nOrder total: A$49.00\nPlace your order", nearby: "", controls: "Place your order", embeds: false, progress: false, ...over,
});
const plainPage = page({ title: "Docs", url: "https://docs.example.com/guide", text: "Docs\nGetting started\nNext", controls: "Next" });
const PEOPLE = ["Usman", "Mehroz"];

describe("the tool guard's verdict (the OS's own money checks)", () => {
  test("which Hermes tools it looks at", () => {
    expect(toolKind("browser_snapshot")).toBe("read");
    expect(toolKind("browser_click")).toBe("browser-input");
    expect(toolKind("browser_navigate")).toBe("navigate");
    expect(toolKind("computer_use", { action: "capture" })).toBe("read");
    expect(toolKind("computer_use", { action: "click" })).toBe("screen-input");
    expect(toolKind("terminal")).toBe("other");
  });
  test("money buttons and commits on a money page are refused; ordinary presses are allowed", () => {
    for (const label of ["Place your order", "Pay now", "Buy now", "Subscribe", "Confirm purchase"])
      expect(toolGuardVerdict({ tool: "browser_click", args: { ref: "@e5" }, label }, { page: page() }).allow).toBe(false);
    expect(toolGuardVerdict({ tool: "browser_click", args: { ref: "@e5" }, label: "Continue" }, { page: page() }).allow).toBe(false);
    expect(toolGuardVerdict({ tool: "browser_click", args: { ref: "@e5" }, label: null }, { page: page() }).allow).toBe(false); // unknown label on a money page
    expect(toolGuardVerdict({ tool: "browser_press", args: { key: "Enter" } }, { page: page() }).allow).toBe(false);
    expect(toolGuardVerdict({ tool: "browser_click", args: { ref: "@e2" }, label: "Next" }, { page: plainPage }).allow).toBe(true);
    expect(toolGuardVerdict({ tool: "browser_type", args: { ref: "@e3", text: "hello" } }, { page: plainPage }).allow).toBe(true);
    // On a payment step itself an agent presses nothing at all (stricter than /browser/act, which has his voice).
    expect(toolGuardVerdict({ tool: "browser_click", args: { ref: "@e2" }, label: "Show more" }, { page: page() }).allow).toBe(false);
    expect(toolGuardVerdict({ tool: "browser_click", args: { ref: "@e2" }, label: "Show more" }, { page: plainPage }).allow).toBe(true);
  });
  test("money hosts, money pages and windows, card numbers", () => {
    expect(toolGuardVerdict({ tool: "browser_navigate", args: { url: "https://www.coinspot.com.au/buy" } }).allow).toBe(false);
    expect(toolGuardVerdict({ tool: "browser_navigate", args: { url: "https://www.youtube.com/" } }).allow).toBe(true);
    expect(toolGuardVerdict({ tool: "browser_click", args: { ref: "@e1" }, label: "Next" }, { page: page({ title: "NetBank", url: "https://www.my.commbank.com.au/netbank/Logon" }) }).allow).toBe(false);
    expect(toolGuardVerdict({ tool: "browser_type", args: { ref: "@e3", text: "4111 1111 1111 1111" } }, { page: plainPage }).allow).toBe(false);
    expect(toolGuardVerdict({ tool: "computer_use", args: { action: "click", element: 4 } }, { window: { title: "CommSec - Trade", process: "chrome", text: "Buy 10 BHP" } }).allow).toBe(false);
    expect(toolGuardVerdict({ tool: "computer_use", args: { action: "click", element: 4 } }, { window: { title: "Untitled - Notepad", process: "notepad", text: "shopping list" } }).allow).toBe(true);
  });
  test("can't read the page or window: input is refused (fail closed); reading is allowed", async () => {
    const deps = { page: async () => null, window: async () => { throw new Error("no screen"); } };
    expect((await toolGuard({ tool: "browser_click", args: { ref: "@e1" }, label: "Next" }, deps)).allow).toBe(false);
    expect((await toolGuard({ tool: "computer_use", args: { action: "type", text: "hi" } }, deps)).allow).toBe(false);
    expect((await toolGuard({ tool: "browser_snapshot", args: {} }, deps)).allow).toBe(true);
  });
});

describe("which tab the guard reads (REVIEW S2e: the targeted or visible tab, never just the first)", () => {
  const plain = { id: "A", url: "https://docs.example.com/guide", visible: true };
  const checkout = { id: "B", url: "https://shop.example.com/checkout", visible: false };
  test("the tab the tool targets, by its address; the one visible tab otherwise; else nothing", () => {
    expect(chooseGuardTarget([plain, checkout], "https://shop.example.com/checkout#pay")?.id).toBe("B");
    expect(chooseGuardTarget([plain, checkout], null)?.id).toBe("A");
    expect(chooseGuardTarget([plain, checkout], "https://elsewhere.example.com/")).toBeNull(); // not open: can't tell
    expect(chooseGuardTarget([plain, { ...checkout, url: plain.url }], plain.url)).toBeNull(); // two tabs at one address
    expect(chooseGuardTarget([plain, { ...checkout, visible: true }], null)).toBeNull(); // two windows showing
    expect(chooseGuardTarget([{ ...plain, visible: false }, checkout], null)).toBeNull();
    expect(samePageUrl("https://a.example.com/x?y=1#z", "https://a.example.com/x?y=1")).toBe(true);
    expect(samePageUrl("https://a.example.com/x?y=1", "https://a.example.com/x?y=2")).toBe(false);
  });

  test("a click on a BACKGROUND checkout tab is blocked though the tab in front is harmless (fake Jarvis Chrome over CDP)", async () => {
    // A fake Chrome DevTools endpoint: the harmless docs tab first and in front, a checkout tab behind it.
    const tabs = [
      { id: "A", ctx: plainPage, visible: true },
      { id: "B", ctx: page(), visible: false },
    ];
    const cdp = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req, server) {
        const id = new URL(req.url).pathname.split("/").pop() ?? "";
        return server.upgrade(req, { data: { id } }) ? undefined : new Response("no", { status: 400 });
      },
      websocket: {
        message(ws, raw) {
          const msg = JSON.parse(String(raw));
          const tab = tabs.find((t) => t.id === (ws.data as { id: string }).id)!;
          const value = msg.params?.expression === "document.visibilityState" ? (tab.visible ? "visible" : "hidden") : tab.ctx;
          ws.send(JSON.stringify({ id: msg.id, result: { result: { value } } }));
        },
      },
    });
    const list = () => tabs.map((t) => ({ id: t.id, type: "page", title: t.ctx.title, url: t.ctx.url, webSocketDebuggerUrl: `ws://127.0.0.1:${cdp.port}/devtools/page/${t.id}` }));
    const request = (async () => new Response(JSON.stringify(list()))) as unknown as typeof fetch;
    const deps = { page: (pageUrl: string | null) => currentPageMoneyContext(pageUrl, request), window: async () => null };
    try {
      // The tool's own session is on the background checkout tab: THAT page is read, and the press is refused.
      expect((await currentPageMoneyContext("https://shop.example.com/checkout", request))?.title).toBe("Checkout");
      for (const label of ["Place your order", "Continue", null]) {
        const v = await toolGuard({ tool: "browser_click", args: { ref: "@e5" }, label, pageUrl: "https://shop.example.com/checkout" }, deps);
        expect(v.allow).toBe(false);
      }
      expect((await toolGuard({ tool: "browser_press", args: { key: "Enter" }, pageUrl: "https://shop.example.com/checkout" }, deps)).allow).toBe(false);
      // On the harmless tab, an ordinary click goes ahead.
      expect((await toolGuard({ tool: "browser_click", args: { ref: "@e2" }, label: "Next", pageUrl: "https://docs.example.com/guide" }, deps)).allow).toBe(true);
      // Address unknown: the one visible tab is read.
      expect((await currentPageMoneyContext(null, request))?.title).toBe("Docs");
      // Address unknown and the checkout tab in front too (two windows): can't tell which, so refused.
      tabs[1].visible = true;
      expect(await currentPageMoneyContext(null, request)).toBeNull();
      expect((await toolGuard({ tool: "browser_click", args: { ref: "@e2" }, label: "Next" }, deps)).allow).toBe(false);
      // The tool's address isn't any open tab: refused.
      expect((await toolGuard({ tool: "browser_click", args: { ref: "@e2" }, label: "Next", pageUrl: "https://elsewhere.example.com/" }, deps)).allow).toBe(false);
    } finally {
      cdp.stop(true);
    }
  }, 30_000);
});

describe("the whole chain: the Hermes plugin hook → the loopback relay → the OS verdict (fake Hermes tool calls)", () => {
  const python = spawnSync("python", ["--version"], { encoding: "utf8" });
  test.skipIf(python.status !== 0)("a money press is blocked, an ordinary one allowed, reading never asked about", async () => {
    const root = temp("s2e-relay-");
    mkdirSync(join(root, ".operator-data", "away-mode"), { recursive: true });
    const token = "a".repeat(64);
    writeFileSync(relayTokenFile(root), token);
    let current: PageMoneyContext = page();
    const asked: (string | null)[] = [];
    const relay = relayMiddleware(root, { telegram: async () => ({ handled: false, reply: null }) } as never, {
      toolGuard: { page: async (pageUrl) => (asked.push(pageUrl), current), window: async () => ({ title: "Untitled - Notepad", process: "notepad", text: "" }) },
      approvals: () => ({}) as never,
    });
    const server = createServer((req, res) => {
      if ((req.url ?? "").startsWith("/__away")) {
        req.url = (req.url ?? "").slice("/__away".length) || "/";
        void relay(req, res);
      } else res.writeHead(404).end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as { port: number }).port;
    try {
      const plugin = join(PLUGIN_SOURCE, "__init__.py").replace(/\\/g, "/");
      const relayJson = join(root, "relay.json");
      writeFileSync(relayJson, JSON.stringify({ url: `http://127.0.0.1:${port}/__away/telegram`, tokenFile: relayTokenFile(root) }));
      const script = join(root, "hook.py");
      const run = (tool: string, args: Record<string, unknown>, label: string | null) => {
        writeFileSync(script, [
          "import importlib.util, json, pathlib",
          `spec = importlib.util.spec_from_file_location("p", ${JSON.stringify(plugin)})`,
          "m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)",
          `m._CONFIG_FILE = pathlib.Path(${JSON.stringify(relayJson.replace(/\\/g, "/"))})`,
          `m._ref_label = lambda ref, task_id: ${label === null ? "None" : JSON.stringify(label)}`,
          `m._page_url = lambda task_id: "https://shop.example.com/checkout"`,
          `print(json.dumps(m.on_pre_tool_call(tool_name=${JSON.stringify(tool)}, args=json.loads(${JSON.stringify(JSON.stringify(args))}), task_id="t1")))`,
        ].join("\n"));
        return new Promise<unknown>((resolve) => {
          const { spawn } = require("node:child_process") as typeof import("node:child_process");
          const child = spawn("python", [script], { env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
          let out = "";
          child.stdout.on("data", (c: Buffer) => (out += String(c)));
          child.on("close", () => resolve(JSON.parse(out.trim().split(/\r?\n/).pop() || "null")));
        });
      };
      expect(await run("browser_click", { ref: "@e5" }, "Place your order")).toMatchObject({ action: "block" });
      expect(asked[0]).toBe("https://shop.example.com/checkout"); // the targeted tab's address reached the reader
      expect(await run("browser_click", { ref: "@e5" }, "Continue")).toMatchObject({ action: "block" });
      current = plainPage;
      expect(await run("browser_click", { ref: "@e2" }, "Next")).toBeNull();
      expect(await run("browser_navigate", { url: "https://www.sportsbet.com.au/" }, null)).toMatchObject({ action: "block" });
      expect(await run("browser_snapshot", {}, null)).toBeNull();
      expect(await run("computer_use", { action: "click", element: 2 }, null)).toBeNull();
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  }, 60_000);
});

describe("chat classifier and coding misses (S2e)", () => {
  test.each(["grab the AirPods from Amazon for me", "get me 0.1 BTC", "yep, place it", "grab me the cheapest flight to Lahore and book it", "snag two tickets to the Coldplay gig", "book two Qantas tickets to Lahore", "place the order", "sort out the Telstra bill for me", "upgrade my OpenRouter plan"])(
    "%p is a money order",
    (text) => expect(chatMoneyOrder(text)).toBe(true),
  );
  test.each(["Mehroz, can you buy milk on the way home?", "hey usman: pay you back tomorrow", "order the leads by score", "get me the report", "book a meeting with Mehroz", "place it on my calendar for Friday", "yes", "go ahead"])(
    "%p is not",
    (text) => expect(chatMoneyOrder(text, PEOPLE)).toBe(false),
  );
  // REVIEW S2e: only a line addressed to a real person in the chat (people.json) is exempt.
  test.each(["Quick, buy 1 bitcoin now", "Urgent: pay the Telstra bill", "Listen, place a bet", "Mate, buy 1 bitcoin now", "Jarvis, buy the AirPods", "Hermes: place the order"])(
    "%p is an order (the first word isn't one of the people)",
    (text) => expect(chatMoneyOrder(text, PEOPLE)).toBe(true),
  );
  test("with no people list, no line is exempt", () => expect(chatMoneyOrder("Mehroz, can you buy milk on the way home?")).toBe(true));
  test.each(["write a script that buys 1 bitcoin with my Coinbase key and run it", "write a cron job that tops up OpenRouter credits and deploy it", "build a bot that places bets on Sportsbet every Saturday"])(
    "coding: %p is refused",
    (text) => expect(codingMoneyRefusal(text)).not.toBeNull(),
  );
  test.each(["fix the checkout bug", "fix the Stripe webhook handler", "run the payment tests", "write a script that parses the NAB CSV"])("coding: %p still works", (text) =>
    expect(codingMoneyRefusal(text)).toBeNull(),
  );
});

describe("the installer's verify step", () => {
  test("the repo's installed variant relays codes, money orders and has the tool guard", () => {
    expect(verifyInstalled(PLUGIN_SOURCE)).toEqual({ installed: true, approvalCodes: true, moneyOrderRelay: true, toolGuard: true, matchesRepo: true });
  });
  test("a plugin like the live one of 25 Sep (no XXXX-XXXX pattern) is reported as not relaying codes", () => {
    const target = temp("s2e-verify-");
    writeFileSync(join(target, "__init__.py"), '_COMMAND = re.compile(r"^\\s*(?:/(?:away|task|log)|(?:yes|no)\\s+[A-Za-z0-9]{4})$")\ndef register(ctx):\n    ctx.register_hook("pre_gateway_dispatch", on_dispatch)\n');
    expect(verifyInstalled(target)).toMatchObject({ installed: true, approvalCodes: false, moneyOrderRelay: false, toolGuard: false, matchesRepo: false });
    expect(verifyInstalled(join(target, "missing"))).toMatchObject({ installed: false });
  });
});
