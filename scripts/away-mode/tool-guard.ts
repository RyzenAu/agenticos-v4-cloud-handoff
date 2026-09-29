// The Hermes tool guard (S2e, 29 Sep): Hermes' `browser_*` and `computer_use` tools drive Jarvis Chrome and his
// real screen with no money gate of their own, and a two-turn chat ("shall I place the order?" → "yes") gets past
// any per-message check. The installed Hermes plugin's pre_tool_call hook (scripts/away-mode/hermes-plugin-
// installed) asks THIS guard before every such action, over the loopback relay (POST /__away/tool-guard, the
// relay's own bearer token), and blocks what it refuses. It runs the SAME checks as the OS's own executors:
//   - the S2c final/money-button gate (finalButtonText over the shared FINAL_BUTTON + moneyButton lists),
//   - P's money-page context (moneyContextLevel, as screen-hands and /browser/act use it),
//   - money windows and pages (moneySurfaceRefusal / moneyWindowRefusal) and money hosts (moneyHost),
//   - card numbers typed anywhere (cardNumberIn).
// Money moves are refused: the owner's policy allows none from an agent (away.payment is OFF; even when on, it
// runs only through away mode's own screen steps with his one-time code, never through Hermes). Anything else
// (reading, scrolling, ordinary clicks and typing on ordinary pages) is allowed. The plugin fails CLOSED for
// browser and screen input when this guard can't be reached. Pure verdict + injectable readers; no logging of
// typed text.
import { finalButtonText, type PageMoneyContext } from "../browser-hands";
import { cardNumberIn, moneyButton, moneyContextLevel, moneyHost, moneySurfaceRefusal } from "../../src/lib/money-policy";
import { commitPress } from "../screen-hands/plan";

export type ToolGuardRequest = {
  /** Hermes' tool name ("browser_click", "computer_use"). */
  tool: string;
  /** The tool's arguments as Hermes will run them. */
  args: Record<string, unknown>;
  /** The clicked element's text, when the plugin could read it (browser refs are opaque to the OS). */
  label?: string | null;
  /** The address of the page the tool's own browser session is on (the tab it acts on), when the plugin could read it. */
  pageUrl?: string | null;
};
export type ToolGuardVerdict = { allow: true } | { allow: false; message: string };
/** The window in front for computer_use: title, address (if a browser), process and its visible text. */
export type ScreenWindowContext = { title: string; url?: string | null; process?: string | null; text: string };
export type ToolGuardContext = { page?: PageMoneyContext | null; window?: ScreenWindowContext | null };

const READ_ONLY_BROWSER = new Set(["browser_snapshot", "browser_get_images", "browser_vision", "browser_console", "browser_scroll", "browser_back", "browser_vault_list"]);
const READ_ONLY_SCREEN = new Set(["capture", "list_apps", "list_windows", "wait", "scroll"]);

export type ToolKind = "other" | "read" | "navigate" | "browser-input" | "screen-input";
/** What kind of action a Hermes tool call is. Pure. */
export function toolKind(tool: string, args: Record<string, unknown> = {}): ToolKind {
  const name = String(tool ?? "");
  if (name === "computer_use") return READ_ONLY_SCREEN.has(String(args.action ?? "").toLowerCase()) ? "read" : "screen-input";
  if (!name.startsWith("browser_")) return "other";
  if (READ_ONLY_BROWSER.has(name)) return "read";
  if (name === "browser_navigate") return "navigate";
  return "browser-input";
}

const BLOCKED = (why: string) =>
  `Not done: ${why}. Payments, purchases, trades and bets are never made by an agent from chat (away payments are off); it's his to do himself at the PC. Nothing was pressed or typed.`;

/** The verdict for one Hermes tool call, given what's on the page or screen. Pure. */
export function toolGuardVerdict(req: ToolGuardRequest, ctx: ToolGuardContext = {}): ToolGuardVerdict {
  const args = req.args && typeof req.args === "object" ? req.args : {};
  const kind = toolKind(req.tool, args);
  if (kind === "other" || kind === "read") return { allow: true };
  const typed = typeof args.text === "string" ? args.text : typeof args.value === "string" ? args.value : "";
  if (typed && cardNumberIn(typed)) return { allow: false, message: BLOCKED("that types a card number") };

  if (kind === "navigate") {
    const url = String(args.url ?? "");
    if (url && (moneyHost(url) || moneySurfaceRefusal({ url }))) return { allow: false, message: BLOCKED("that's a bank, broker, exchange, betting or payment site") };
    return { allow: true };
  }

  if (kind === "browser-input") {
    const page = ctx.page;
    if (!page) return { allow: false, message: BLOCKED("I couldn't read the page it would act on") };
    if (moneySurfaceRefusal({ title: page.title, url: page.url })) return { allow: false, message: BLOCKED("that page is a bank, broker, exchange, betting or payment screen") };
    const label = String(req.label ?? "").trim();
    // A money button (P's list: Pay now, Place order, Buy, Subscribe, Donate, Bet…) is never pressed.
    if (label && moneyButton(label)) return { allow: false, message: BLOCKED(`"${label.slice(0, 60)}" is a money button`) };
    const key = String(args.key ?? "");
    const commits = req.tool === "browser_click" ? (label ? commitPress(label) || finalButtonText(label) : true)
      : req.tool === "browser_press" ? /^(?:enter|return|space|\s)$/i.test(key)
      : req.tool === "browser_type" ? false
      : true; // browser_cdp, browser_exec, browser_dialog, vault fills: raw control of the page
    const level = moneyContextLevel({
      title: page.title, url: page.url, text: page.text, element: label ? { name: label } : null, controls: page.controls,
      commit: commits, embeds: page.embeds, nearby: page.nearby, progress: page.progress,
    });
    if (level && (level.level === "transactional" || commits)) return { allow: false, message: BLOCKED(`there's money on that page (${level.reason})`) };
    return { allow: true };
  }

  // computer_use input on his real screen.
  const win = ctx.window;
  if (!win) return { allow: false, message: BLOCKED("I couldn't read the window it would act on") };
  if (moneySurfaceRefusal({ title: win.title, url: win.url ?? null, process: win.process ?? null })) return { allow: false, message: BLOCKED("that window is a bank, broker, exchange, betting or payment screen") };
  const level = moneyContextLevel({ title: win.title, url: win.url ?? null, process: win.process ?? null, text: win.text, commit: true });
  if (level) return { allow: false, message: BLOCKED(`there's money on that screen (${level.reason})`) };
  return { allow: true };
}

export type ToolGuardDeps = {
  /**
   * The page the tool acts on (browser-hands currentPageMoneyContext): the tab at `pageUrl`, else the one visible
   * tab; null when it can't tell which (the verdict then refuses).
   */
  page: (pageUrl: string | null) => Promise<PageMoneyContext | null>;
  /** The window in front on his screen (screen-hands foreground + snapshot). */
  window: () => Promise<ScreenWindowContext | null>;
};
/** Read only what the tool needs, then decide. A reader that throws counts as "couldn't read" (fail closed). */
export async function toolGuard(req: ToolGuardRequest, deps: ToolGuardDeps): Promise<ToolGuardVerdict> {
  const kind = toolKind(req.tool, req.args ?? {});
  const page = kind === "browser-input" ? await deps.page(req.pageUrl ?? null).catch(() => null) : null;
  const window = kind === "screen-input" ? await deps.window().catch(() => null) : null;
  return toolGuardVerdict(req, { page, window });
}

/** The request body as the relay received it: only the fields the guard reads, bounded. Pure. */
export function parseToolGuardRequest(body: unknown): ToolGuardRequest | null {
  const b = body && typeof body === "object" ? (body as Record<string, unknown>) : null;
  if (!b || typeof b.tool !== "string" || !b.tool || b.tool.length > 80) return null;
  const rawArgs = b.args && typeof b.args === "object" && !Array.isArray(b.args) ? (b.args as Record<string, unknown>) : {};
  const args: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rawArgs).slice(0, 30)) {
    if (typeof v === "string") args[k] = v.slice(0, 2000);
    else if (typeof v === "number" || typeof v === "boolean") args[k] = v;
    else if (Array.isArray(v) && v.length <= 4 && v.every((x) => typeof x === "number")) args[k] = v;
  }
  const label = typeof b.label === "string" ? b.label.slice(0, 300) : null;
  const pageUrl = typeof b.pageUrl === "string" && /^https?:\/\//i.test(b.pageUrl) ? b.pageUrl.slice(0, 2000) : null;
  return { tool: b.tool, args, label, pageUrl };
}
