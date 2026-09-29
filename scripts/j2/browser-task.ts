// J6: `browser.task`, the multi-step browser goal on the J2 hands (agent-browser against Jarvis Chrome, never Hermes).
//
//   goal sentence -> up to 8 steps of: snapshot (refs) -> ONE next action -> execute through BrowserHands -> re-snapshot
//   -> one plain answer, "done" or "couldn't", that says where it ended up.
//
// The chooser is rules first: each goal shape (scripts/j2/task-intents.ts) has a driver that reads the page and picks the
// next action. A goal the rules don't know is chosen step by step by the free brain in a strict JSON action schema
// (TASK_ACTION_SCHEMA); Jev routes to it (browser.task) and never to the screen hands.
//
// Every input action still passes the existing gates inside BrowserHands (S2c final buttons, the S2e money verdicts, secret
// fields): the loop never presses a submit/send/pay/confirm and never types into a password, card or code field. It also
// stops, in one line, when the page has drifted from the goal: an unexpected sign-in, cookie consent, captcha (never solved),
// paywall or payment page, or a site other than the one named ("your turn").
import type { BrowserHands, PageView, TreeNode } from "./agent-browser";
import { PAGE_LABELS, ordinalOf, parseTaskGoal, type Nth, type PageKind, type TaskShape, type TaskSite } from "./task-intents";
import { cleanUtterance } from "./intents";
import { safePageText, safeTitle } from "./page-redact";
import { finalButtonText } from "../browser-hands";
import { moneyContextLevel, moneySurfaceRefusal, registrableDomain } from "../../src/lib/money-policy";
import { conflicts, ruleFor, savedDetails, type Detail } from "../screen-hands/form-fill";
import { openedWhereLine } from "../jarvis-skills/windows";
import { spokenUrls } from "../jev";

/** The step cap for a goal (a form with several fields gets more: each field is a step). */
export const TASK_STEP_CAP = 8;
export const FORM_STEP_CAP = 12;
/** A step that takes longer than this gets ONE short "Still working." (spoken once for the whole task). */
export const SLOW_STEP_MS = 6_000;

// --- the action schema -----------------------------------------------------------------------------------------------------
/** One next action. This is the whole vocabulary: the rules and the brain choose from it and nothing else. */
export type TaskAction =
  | { do: "open_url"; url: string; label?: string }
  | { do: "click"; ref: string }
  | { do: "type"; ref: string; text: string }
  | { do: "press"; key: "Enter" }
  | { do: "scroll"; dir: "up" | "down" | "bottom" }
  | { do: "back" }
  | { do: "select_tab"; index: number }
  | { do: "read"; what?: "page" | "footer" }
  | { do: "wait" }
  | { do: "finish"; said: string }
  | { do: "stop"; reason: string; yourTurn?: boolean };

/** The strict JSON the brain answers with, one object per step (also the description the brain is given). */
export const TASK_ACTION_SCHEMA = {
  open_url: { do: "open_url", url: "https://… (http or https only)" },
  click: { do: "click", ref: "a ref from the page list, e.g. e12 (a link or a NON-final button)" },
  type: { do: "type", ref: "a ref of a text box, never a password, card or code field", text: "the words to type (≤ 200 chars)" },
  press: { do: "press", key: "Enter (only in a lone search box)" },
  scroll: { do: "scroll", dir: "up | down | bottom" },
  back: { do: "back" },
  select_tab: { do: "select_tab", index: "1-based tab number" },
  read: { do: "read", what: "page | footer" },
  finish: { do: "finish", said: "one sentence: what happened" },
  stop: { do: "stop", reason: "why you can't go on", yourTurn: "true when he must do the next part himself" },
} as const;

export type TaskOutcome = { ok: boolean; said: string; steps: number; trace: string[]; ended: { url: string; title: string } | null };

// --- state and dependencies ------------------------------------------------------------------------------------------------
type HistoryItem = { action: TaskAction; ok: boolean; note: string };
export type TaskState = {
  goal: string;
  shape: TaskShape;
  /** Actions run so far (a `wait` doesn't count). */
  step: number;
  view: PageView | null;
  tree: TreeNode[];
  history: HistoryItem[];
  scratch: {
    waits: number;
    where?: string;
    opened?: boolean;
    resultsUrl?: string;
    resultsIndex?: number;
    picked?: string;
    playTried?: boolean;
    formHandled: Set<string>;
    filled: string[];
    blank: string[];
    contactTried?: boolean;
    scrolled?: boolean;
    read?: string;
    readTitle?: string;
    expectHost?: string;
    siteName?: string;
    fresh?: boolean;
    clickedFrom?: { url: string; title: string; text: string };
  };
};

export type DecideInput = {
  goal: string;
  step: number;
  cap: number;
  url: string;
  title: string;
  /** The controls on the page, names cut short. Untrusted text: the model must treat it as data. */
  nodes: Array<{ ref: string; role: string; name: string; url?: string }>;
  history: string[];
  schema: typeof TASK_ACTION_SCHEMA;
};

export type SearchMemory = { engine: "google" | "youtube" | "generic"; query?: string; url: string; nth: number; at: number };
const MEMORY_TTL_MS = 15 * 60_000;
let lastSearch: SearchMemory | null = null;
/** What the last search-and-open was (so "go back and open the next one" knows which one was next). */
export const rememberSearch = (m: Omit<SearchMemory, "at">, now = Date.now()) => void (lastSearch = { ...m, at: now });
export const recallSearch = (now = Date.now()): SearchMemory | null => (lastSearch && now - lastSearch.at <= MEMORY_TTL_MS ? lastSearch : null);
export const forgetSearch = () => void (lastSearch = null);

export type TaskDeps = {
  hands: BrowserHands;
  /** Open a URL in a new Jarvis Chrome tab, remember it as "it", bring the window forward: the spoken "where" or a failure. */
  open: (url: string, label: string) => Promise<{ ok: boolean; said: string; where?: string; targetId?: string }>;
  /** Bring Jarvis Chrome forward on his main screen (for a goal on the page already in front): the window skill's line. */
  present?: () => Promise<string | null>;
  /** A tab the loop switched to (a link opened one): it becomes "it". */
  retarget?: (targetId: string, title: string) => void;
  /** The brain's next action for a goal the rules don't know (raw JSON, validated here). */
  decide?: (input: DecideInput) => Promise<unknown>;
  /** His saved details for a form (default: .operator-data/business.json). */
  details?: () => Detail[];
  /** The search pages (tests and the synthetic check point them at local fake pages). */
  urls?: { google?: (query: string) => string; youtube?: (query: string) => string; gmail?: string };
  sleep?: (ms: number) => Promise<void>;
  /** One short "Still working." when a step takes longer than `slowMs`. */
  progress?: (line: string) => void;
  slowMs?: number;
  stepCap?: number;
  now?: () => number;
};

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const clip = (s: string, n: number) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const hostOf = (url: string) => {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return "";
  }
};
const hostnameOf = (url: string) => hostOf(url).replace(/:\d+$/, "");
const firstSentence = (s: string) => {
  const t = clip(s, 400);
  const end = t.search(/[.!?](?:\s|$)/);
  return (end > 0 ? t.slice(0, end) : t).replace(/[.!?]+$/, "").slice(0, 170);
};
const quote = (s: string) => `"${clip(s, 80)}"`;
/** "your main screen" from the window skill's line, or null. */
export function whereFrom(placed: string | null): string | null {
  return openedWhereLine("x", placed).match(/^Opened .+? in Chrome on (.+)\.$/)?.[1] ?? null;
}

// --- result lists ---------------------------------------------------------------------------------------------------------
export type Result = { ref: string; name: string; url: string; index: number };
const NAV = /^(?:sign in|log in|login|images?|videos?|news|maps|shopping|books|flights|finance|more|settings|tools|privacy|terms|feedback|help|cached|similar|translate this page|skip to main content|accessibility help|google apps|advertisement|sponsored|next|previous|search|home|menu)$/i;
const GOOGLE_HOST = /(?:^|\.)(?:google\.[a-z.]+|googleusercontent\.com|gstatic\.com|googleadservices\.com|googlesyndication\.com|doubleclick\.net|webcache\.googleusercontent\.com)$/i;
const YT_WATCH = /\/watch\?(?:[^#]*&)?v=([\w-]{4,})|\/shorts\/([\w-]{4,})/;

export type Engine = "google" | "youtube" | "generic";
/** Which results page this is, by its address (the search URLs the loop itself builds count too). */
export function engineOf(url: string, own: { google?: string; youtube?: string } = {}): Engine {
  const h = hostnameOf(url);
  const full = hostOf(url);
  if (own.google && full === own.google) return "google";
  if (own.youtube && full === own.youtube) return "youtube";
  if (/(?:^|\.)google\.[a-z.]+$/.test(h)) return "google";
  if (/(?:^|\.)youtube\.com$|(?:^|\.)youtu\.be$/.test(h)) return "youtube";
  return "generic";
}

/** The results on a page, in page order: real results only (no navigation, ads or the engine's own links). Pure. */
export function pickResults(engine: Engine, tree: TreeNode[], engineHost = ""): Result[] {
  const out: Result[] = [];
  const seen = new Set<string>();
  if (engine === "youtube") {
    for (const n of tree) {
      if (n.role !== "link" || !n.url) continue;
      const m = n.url.match(YT_WATCH);
      if (!m) continue;
      const id = m[1] ?? m[2];
      if (seen.has(id) || /^(?:sponsored|ad)\b/i.test(n.name) || n.name.trim().length < 2) continue;
      seen.add(id);
      out.push({ ref: n.ref, name: n.name, url: n.url, index: out.length });
    }
    return out;
  }
  const own = engine === "google" ? engineHost : "";
  const cands = tree.filter((n) => {
    if (n.role !== "link" || !n.url || !/^https?:\/\//i.test(n.url)) return false;
    const h = hostOf(n.url);
    if (!h || (engine === "google" && GOOGLE_HOST.test(h.replace(/:\d+$/, ""))) || (own && h === own)) return false;
    if (/\/aclk\b|adurl=|googleadservices/i.test(n.url)) return false;
    return n.name.trim().length >= (engine === "google" ? 3 : 8) && !NAV.test(n.name.trim());
  });
  // A real result carries its title as a heading (Google): prefer those, else every plausible link.
  const titled = cands.filter((n) => tree[n.index + 1]?.role === "heading" && tree[n.index + 1].depth > n.depth);
  for (const n of titled.length ? titled : cands) {
    const key = n.url!.replace(/#.*$/, "");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ref: n.ref, name: n.name, url: n.url!, index: out.length });
  }
  return out;
}
const nthOf = (results: Result[], nth: number | "last"): Result | null => (nth === "last" ? results[results.length - 1] : results[nth - 1]) ?? null;
const ordinalName = (n: number | "last") => (n === "last" ? "last" : (["", "first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth"][n] ?? `${n}th`));

// --- stop checks (drift) ---------------------------------------------------------------------------------------------------
export type Problem = { kind: "consent" | "captcha" | "login" | "paywall" | "payment"; what: string };
const CAPTCHA = /unusual traffic|captcha|verify (?:that )?(?:you are|you're) (?:a )?human|i'm not a robot|not a robot|are you a robot|press & hold|checking your browser/i;
const CONSENT_TITLE = /before you continue|cookie consent|consent preferences/i;
const PAYWALL = /subscribe to (?:continue|keep) reading|to continue reading|sign in to (?:read|continue reading)|you'?ve reached your (?:free )?(?:article )?limit|this (?:content|article) is (?:only )?for (?:subscribers|members)|start your free trial to read/i;
const LOGIN_URL = /\/(?:log ?in|sign ?in|signin|sign-in|sso|oauth2?|auth(?:orize)?)(?:[/?#.]|$)|accounts\.google\.com|login\.microsoftonline\.com|login\.live\.com|appleid\.apple\.com|auth0\.com|okta\.com/i;
const LOGIN_TITLE = /^(?:sign in|log in|login|sign-in)\b/i;

/** Is the page one the goal shouldn't go on into (a sign-in, cookie consent, captcha, paywall, payment page)? Pure. */
export function pageProblem(view: PageView | null): Problem | null {
  if (!view) return null;
  const host = hostOf(view.url);
  const head = `${view.title} ${view.text.slice(0, 700)}`;
  if (/^consent\./.test(host) || CONSENT_TITLE.test(view.title)) return { kind: "consent", what: "asks you to accept cookies" };
  if (/google\.[a-z.]+\/sorry\b/i.test(view.url) || CAPTCHA.test(head)) return { kind: "captcha", what: "is showing a captcha" };
  // (A pricing or plans page is a page to read, not a payment step: only card fields, a money surface, a checkout path or a total/amount-due block count.)
  const level = moneyContextLevel({ title: view.title, url: view.url, text: view.text, commit: false, controls: "", embeds: false, nearby: "", progress: false } as never);
  if (moneySurfaceRefusal({ title: view.title, url: view.url }) || view.card || (level?.level === "transactional" && !/order, booking, plan or donation step|paid plan/.test(level.reason)))
    return { kind: "payment", what: "is a payment page" };
  // Username-first login pages have no password field yet; their URL/title is enough to stop before typing.
  if (LOGIN_URL.test(view.url) || LOGIN_TITLE.test(view.title) || /^accounts\.google\.com$|^login\.microsoftonline\.com$/.test(host))
    return { kind: "login", what: "wants you to sign in" };
  if (PAYWALL.test(view.text.slice(0, 1200))) return { kind: "paywall", what: "is behind a paywall" };
  return null;
}
/** Landed on a different site than the one named? (www and subdomains of the same site are fine.) Pure. */
export function wrongSite(expectHost: string, url: string): boolean {
  const want = expectHost.replace(/^www\./, "").replace(/:\d+$/, "");
  const got = hostnameOf(url);
  if (!want || !got || /^(?:about|chrome|data)/.test(url)) return false;
  if (want === got) return false;
  const expectedDomain = registrableDomain(want);
  const landedDomain = registrableDomain(got);
  // If either host cannot be parsed, keep the boundary at the exact hostname.
  return !expectedDomain || !landedDomain || expectedDomain !== landedDomain;
}

/** The explicit addresses in this request, or the current page when no address was named. */
function requestedHost(goal: string, currentUrl: string): string | null {
  const named = spokenUrls(goal).map(hostOf).filter(Boolean);
  if (named.length) return named[0];
  const current = hostnameOf(currentUrl);
  return registrableDomain(current) ? current : null;
}

// --- the loop ---------------------------------------------------------------------------------------------------------------
export async function runBrowserTask(input: { goal: string; shape?: TaskShape | null }, deps: TaskDeps): Promise<TaskOutcome> {
  const goal = clip(input.goal, 200);
  const shape: TaskShape = input.shape ?? parseTaskGoal(cleanUtterance(goal)) ?? { kind: "free" };
  const { hands } = deps;
  const sleep = deps.sleep ?? realSleep;
  const cap = deps.stepCap ?? (shape.kind === "fill_form" ? FORM_STEP_CAP : TASK_STEP_CAP);
  const state: TaskState = { goal, shape, step: 0, view: null, tree: [], history: [], scratch: { waits: 0, formHandled: new Set(), filled: [], blank: [] } };
  const trace: string[] = [];
  let slowSaid = false;
  const ended = () => (state.view ? { url: state.view.url, title: state.view.title } : null);

  const couldnt = (reason: string, kind: "plain" | "yourTurn" = "plain"): TaskOutcome => {
    const at = state.view ? `${state.view.title ? `${quote(safeTitle(state.view.title).slice(0, 60))} on ` : ""}${hostOf(state.view.url) || "the page"}` : "";
    const gotTo = at ? ` I got as far as ${at}.` : state.step ? "" : " I hadn't opened anything yet.";
    const why = kind === "yourTurn" ? `${reason}, so it's your turn` : reason;
    return { ok: false, said: `Couldn't finish: ${why.replace(/[.!]+$/, "")}.${gotTo}`, steps: state.step, trace, ended: ended() };
  };
  const done = async (said: string): Promise<TaskOutcome> => ({ ok: true, said, steps: state.step, trace, ended: ended() });

  /** Wait for the page to be loaded and steady, and read it (one read of the tab, reused by the next observation). */
  async function settle(): Promise<void> {
    let last = "";
    for (let i = 0; i < 12; i++) {
      const v = await hands.view();
      const sig = v ? `${v.url}|${v.ready}` : "";
      if (v?.ready && sig === last) {
        state.view = v;
        state.scratch.fresh = true;
        return;
      }
      if (v) state.view = v;
      last = sig;
      await sleep(350);
    }
    state.scratch.fresh = true;
  }
  async function observe(): Promise<void> {
    const wantFull = shape.kind === "read_headline";
    if (!state.scratch.fresh) state.view = await hands.view();
    state.tree = await hands.tree({ interactive: !wantFull });
    state.scratch.fresh = false;
  }

  // A goal on the page already in front brings Jarvis Chrome forward while the first look happens (the answer says where).
  const placing = !opensFirst(shape) && deps.present ? deps.present().then((p) => void (state.scratch.where = whereFrom(p) ?? undefined), () => undefined) : null;
  for (let guard = 0; guard < cap + 6; guard++) {
    if (state.step >= cap) return couldnt(`that took more than ${cap} steps`);
    // 1. See the page (a goal that opens something itself has nothing to look at yet).
    const needsLook = state.history.length > 0 || !opensFirst(shape);
    if (needsLook) await observe();
    // 2. Stop if it's the wrong page.
    const problem = pageProblem(state.view);
    if (problem) return couldnt(`${hostOf(state.view!.url) || "the page"} ${problem.what}`, "yourTurn");
    // Named-site goals stay on that site after *every* navigation. A link can redirect or open an unrelated tab too.
    // Search-result goals intentionally leave the engine, so they do not set expectHost past the result click.
    if (state.scratch.expectHost && state.view && wrongSite(state.scratch.expectHost, state.view.url))
      return couldnt(`I landed on ${hostOf(state.view.url)} instead of ${state.scratch.expectHost}`);
    // A goal on the page already in front is bound to that page's site, so its links are inspected too.
    if (!state.history.length && !state.scratch.expectHost && state.view && ["find_page", "contact_read", "fill_form"].includes(shape.kind) && "site" in shape && shape.site === null) {
      const current = hostnameOf(state.view.url);
      if (registrableDomain(current)) state.scratch.expectHost = current;
    }
    // 3. Choose ONE next action.
    if (placing) await placing;
    let action: TaskAction;
    try {
      action = await choose(state, deps);
    } catch (e) {
      return couldnt(firstSentence((e as Error).message) || "I couldn't work out the next step");
    }
    trace.push(describeAction(action));
    if (action.do === "finish") return await done(action.said);
    if (action.do === "stop") return couldnt(action.reason, action.yourTurn ? "yourTurn" : "plain");
    // A site-bound task looks at where a link goes BEFORE clicking it.
    if (action.do === "click") {
      const refusal = offSiteClickRefusal(state, action.ref);
      if (refusal) return couldnt(refusal);
    }
    const prev = state.history[state.history.length - 1];
    if (prev && action.do !== "wait" && JSON.stringify(prev.action) === JSON.stringify(action) && prev.ok) return couldnt("I was going round in circles");
    // 4. Do it (one step), telling him once if it's slow.
    const timer = deps.progress && !slowSaid ? setTimeout(() => ((slowSaid = true), deps.progress!("Still working.")), deps.slowMs ?? SLOW_STEP_MS) : null;
    let result: { ok: boolean; said: string };
    try {
      result = await execute(action, state, deps, settle, sleep);
    } finally {
      if (timer) clearTimeout(timer);
    }
    state.history.push({ action, ok: result.ok, note: result.said });
    if (action.do !== "wait") state.step++;
    // A form field that turns out to be a password, card or code box (or can't be read) is left alone, and the rest goes on.
    if (!result.ok && action.do === "type" && shape.kind === "fill_form" && /password, card or code field|couldn't read that field/i.test(result.said)) {
      const left = state.scratch.filled.pop();
      if (left) state.scratch.blank.push(left);
      continue;
    }
    if (!result.ok) return couldnt(firstSentence(result.said));
  }
  return couldnt(`that took more than ${cap} steps`);
}

const opensFirst = (shape: TaskShape) => shape.kind === "search_open" || shape.kind === "gmail_search" || shape.kind === "site_click" || (["find_page", "read_headline", "read_footer", "contact_read", "fill_form"].includes(shape.kind) && "site" in shape && shape.site !== null);

function describeAction(a: TaskAction): string {
  switch (a.do) {
    case "open_url": return `open ${hostOf(a.url) || a.url.slice(0, 40)}`;
    case "click": return `click ${a.ref}`;
    case "type": return `type into ${a.ref}`;
    case "press": return "press Enter";
    case "scroll": return `scroll ${a.dir}`;
    case "read": return `read ${a.what ?? "page"}`;
    case "select_tab": return `tab ${a.index}`;
    case "finish": return "finish";
    case "stop": return `stop: ${a.reason.slice(0, 60)}`;
    default: return a.do;
  }
}

// --- executing one action (always through the hands, so every gate still applies) ------------------------------------------
async function execute(a: TaskAction, state: TaskState, deps: TaskDeps, settle: () => Promise<void>, sleep: (ms: number) => Promise<void>): Promise<{ ok: boolean; said: string }> {
  const { hands } = deps;
  switch (a.do) {
    case "open_url": {
      const label = a.label ?? hostOf(a.url);
      const r = await deps.open(a.url, label);
      if (!r.ok) return { ok: false, said: r.said };
      if (r.where) state.scratch.where = r.where;
      state.scratch.opened = true;
      await settle();
      return { ok: true, said: "Opened." };
    }
    case "click": {
      state.scratch.clickedFrom = state.view ? { url: state.view.url, title: state.view.title, text: state.view.text } : undefined;
      const before = (await hands.tabs()).length;
      const r = await hands.clickRef(a.ref);
      if (!r.ok) return r;
      await settle();
      const after = await hands.tabs();
      // A link that opened a new tab: work in that one from here.
      if (after.length > before) {
        const fresh = after[after.length - 1];
        await hands.activate(fresh.targetId);
        deps.retarget?.(fresh.targetId, fresh.title);
        await settle();
      }
      return r;
    }
    case "type":
      return hands.typeInto(a.ref, a.text);
    case "press": {
      const r = await hands.pressEnterInSearch();
      if (r.ok) await settle();
      return r;
    }
    case "scroll": {
      const r = a.dir === "bottom" ? await hands.scrollToBottom() : await hands.scroll(a.dir);
      await sleep(150);
      return r;
    }
    case "back": {
      const r = await hands.back();
      if (r.ok) await settle();
      return r;
    }
    case "select_tab": {
      const r = await hands.selectTab(a.index);
      if (r.ok) await settle();
      return r;
    }
    case "read": {
      if (a.what === "footer") {
        state.scratch.read = await hands.footerText();
        return { ok: true, said: "Read." };
      }
      const p = await hands.read();
      if (!p.ok) return { ok: false, said: p.said ?? "I couldn't read the page." };
      state.scratch.read = p.text;
      state.scratch.readTitle = p.title;
      return { ok: true, said: "Read." };
    }
    case "wait":
      state.scratch.waits++;
      await sleep(500);
      await settle();
      return { ok: true, said: "Waited." };
    default:
      return { ok: false, said: "That isn't a step I can take." };
  }
}

// --- choosing the next action -----------------------------------------------------------------------------------------------
const wait = (state: TaskState, why: string): TaskAction => (state.scratch.waits < 4 ? { do: "wait" } : { do: "stop", reason: why });
const linkNamed = (tree: TreeNode[], re: RegExp, roles = /^(?:link|button|tab|menuitem)$/) => tree.find((n) => roles.test(n.role) && re.test(n.name) && n.name.trim().length < 60 && !finalButtonText(n.name));

async function choose(state: TaskState, deps: TaskDeps): Promise<TaskAction> {
  const s = state.shape;
  switch (s.kind) {
    case "search_open": return searchOpen(state, deps, s);
    case "open_nth": return openNth(state, deps, s);
    case "site_click": return siteClick(state, s.site, s.label);
    case "find_page": return findPage(state, s.site, s.page);
    case "gmail_search": return gmailSearch(state, deps, s.query);
    case "read_headline": return readHeadline(state, s.site);
    case "read_footer": return readFooter(state, s.site);
    case "contact_read": return contactRead(state, s.site, s.what);
    case "fill_form": return fillForm(state, deps, s.site, s.wants);
    case "free": return free(state, deps);
  }
}

const enginePage = (deps: TaskDeps, engine: "google" | "youtube", query: string) =>
  engine === "youtube" ? (deps.urls?.youtube ?? ((q) => `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`))(query) : (deps.urls?.google ?? ((q) => `https://www.google.com/search?q=${encodeURIComponent(q)}`))(query);
const engineHosts = (deps: TaskDeps) => ({ google: hostOf(enginePage(deps, "google", "x")), youtube: hostOf(enginePage(deps, "youtube", "x")) });
const titleOf = (state: TaskState) => safeTitle(state.view?.title ?? "").replace(/\s+[-|]\s+(?:YouTube|Google Search)$/i, "").slice(0, 80) || hostOf(state.view?.url ?? "") || "the page";

/** After the click: is it a video page that should be playing? Click play once if it's paused; then finish. */
function watchOrFinish(state: TaskState, engine: Engine, what: string): TaskAction {
  const v = state.view?.video ?? null;
  const title = titleOf(state);
  // A result that opened an error page (HTTP 404/5xx, or a soft "not found" page) is a failure, not a success.
  const broken = errorPageReason(state.view, state.tree);
  if (broken) return { do: "stop", reason: `the result opened an error page (${broken}), not a working page` };
  if (engine !== "youtube") return { do: "finish", said: `${what}: ${title}${where(state)}.` };
  if (!v && state.scratch.waits < 3) return { do: "wait" };
  if (!v) return { do: "finish", said: `${what}: ${title}${where(state)}.` };
  if (v.paused && !state.scratch.playTried) {
    const play = state.tree.find((n) => n.role === "button" && /^(?:play|resume)\b/i.test(n.name));
    if (play) {
      state.scratch.playTried = true;
      return { do: "click", ref: play.ref };
    }
  }
  return { do: "finish", said: v.paused ? `${what}: ${title}, but it's still paused,${where(state)}.` : `${what}: ${title}, playing,${where(state)}.` };
}
const where = (state: TaskState) => (state.scratch.where ? ` on ${state.scratch.where}` : " in Chrome");

/** Words an error page uses (HTTP error pages, "soft" 404s served with status 200, the browser's own error pages). */
const ERROR_PAGE = /\b404\b|\bnot found\b|page (?:unavailable|(?:can(?:no|'|’)t|could not) be found|(?:doesn'?t|does not) exist)|access denied|\bforbidden\b|internal server error|bad gateway|service unavailable|can(?:no|'|’)t be reached|\berr_[a-z_]+\b|video unavailable|no longer available|\b(?:error|status) (?:403|410|500|502|503)\b/i;
/** Why this page is an error page (an HTTP error status or clear error-page content), or null when it looks like a real page. Pure. */
export function errorPageReason(view: PageView | null, tree: TreeNode[] = []): string | null {
  if (!view) return null;
  if (typeof view.status === "number" && view.status >= 400) return `HTTP ${view.status}`;
  if (/^chrome-error:/i.test(view.url)) return "the browser's error page";
  const headings = tree.filter((n) => n.role === "heading" && (n.level ?? 1) <= 2).map((n) => n.name).join(" ");
  const hit = `${view.title} ${headings} ${view.text.slice(0, 250)}`.match(ERROR_PAGE);
  return hit ? `it says "${clip(hit[0], 40)}"` : null;
}

/**
 * A site-bound task never clicks a link before its destination is known to be on that site: the href is resolved against the
 * page it is on (relative, protocol-relative and fragment links included) and compared, by registrable domain, with the
 * site the task is bound to. A link that leaves it, is not a web address (javascript:, data:, mailto:...), or whose address
 * can't be read is refused with a brief reason (null when the click may go ahead). Pure. A redirect the server makes after the
 * click can't be seen here: the landing check after every navigation still catches that.
 */
export function offSiteClickRefusal(state: Pick<TaskState, "tree" | "view" | "scratch">, ref: string): string | null {
  const bound = state.scratch.expectHost;
  if (!bound) return null;
  const node = state.tree.find((n) => n.ref === ref);
  if (!node) return null;
  const label = quote(node.name || node.role);
  if (!node.url) return node.role === "link" ? `I didn't click ${label}: I can't tell where that link goes` : null;
  let dest: URL;
  try {
    dest = new URL(node.url, state.view?.url || undefined);
  } catch {
    return `I didn't click ${label}: I can't tell where that link goes`;
  }
  if (dest.protocol !== "http:" && dest.protocol !== "https:") return `I didn't click ${label}: it isn't a web page on ${bound}`;
  if (wrongSite(bound, dest.href)) return `I didn't click ${label}: it goes to ${hostOf(dest.href)}, outside ${bound}`;
  return null;
}

/** A clicked link is only a candidate. Verify the resulting page, including same-URL tab changes. */
function reachedPage(state: TaskState, label: RegExp): boolean {
  const now = state.view;
  const before = state.scratch.clickedFrom;
  if (!now || !before) return false;
  const changed = now.url !== before.url || now.title !== before.title || now.text !== before.text;
  if (!changed) return false;
  let path = "";
  try { path = decodeURIComponent(new URL(now.url).pathname).replace(/[-_]+/g, " "); } catch { /* the title can still prove it */ }
  const heading = state.tree.filter((n) => n.role === "heading").map((n) => n.name).join(" ");
  if (errorPageReason(now, state.tree)) return false;
  return label.test(`${now.title} ${heading}`) || (label.test(path) && label.test(now.text));
}

function searchOpen(state: TaskState, deps: TaskDeps, s: Extract<TaskShape, { kind: "search_open" }>): TaskAction {
  const hosts = engineHosts(deps);
  const engineName = s.engine === "youtube" ? "YouTube" : "Google";
  const what = `Searched ${engineName} for ${quote(s.query)} and opened the ${ordinalName(s.nth === "next" ? 1 : s.nth)} ${s.engine === "youtube" ? "video" : "result"}`;
  if (!state.history.length) {
    const url = enginePage(deps, s.engine, s.query);
    state.scratch.expectHost = hostOf(url);
    return { do: "open_url", url, label: engineName };
  }
  const last = state.history[state.history.length - 1];
  if (last.action.do === "click" && state.scratch.picked) {
    if (state.scratch.picked === state.view?.url && state.scratch.waits < 3) return { do: "wait" };
    if (state.scratch.picked === state.view?.url) return { do: "stop", reason: "the click didn't open anything" };
    return watchOrFinish(state, s.engine, what);
  }
  if (state.history.some((h) => h.action.do === "click") && state.scratch.playTried) return watchOrFinish(state, s.engine, what);
  // On the results page: choose the result to open.
  const results = pickResults(s.engine, state.tree, hosts.google);
  const n = s.nth === "next" ? 1 : s.nth;
  const hit = nthOf(results, n);
  if (!hit) return wait(state, `I couldn't see ${s.engine === "youtube" ? "any videos" : "a list of results"} on ${engineName}`);
  state.scratch.picked = state.view?.url ?? "";
  state.scratch.resultsUrl = state.view?.url;
  state.scratch.resultsIndex = typeof n === "number" ? n : results.length;
  rememberSearch({ engine: s.engine, query: s.query, url: state.view?.url ?? "", nth: typeof n === "number" ? n : results.length });
  state.scratch.expectHost = undefined; // A search result is allowed to leave Google or YouTube.
  return { do: "click", ref: hit.ref };
}

function openNth(state: TaskState, deps: TaskDeps, s: Extract<TaskShape, { kind: "open_nth" }>): TaskAction {
  const hosts = engineHosts(deps);
  const what = () => `Opened the ${ordinalName(state.scratch.resultsIndex ?? 1)} ${engineOf(state.scratch.resultsUrl ?? "", hosts) === "youtube" ? "video" : "result"}`;
  const last = state.history[state.history.length - 1];
  // "Go back and open the next one": back first.
  if (s.back && !state.history.length) return { do: "back" };
  if (last?.action.do === "click" && state.scratch.picked !== undefined) {
    if (state.scratch.picked === state.view?.url && state.scratch.waits < 3) return { do: "wait" };
    if (state.scratch.picked === state.view?.url) return { do: "stop", reason: "the click didn't open anything" };
    return watchOrFinish(state, engineOf(state.scratch.resultsUrl ?? "", hosts), what());
  }
  if (state.scratch.playTried) return watchOrFinish(state, engineOf(state.scratch.resultsUrl ?? "", hosts), what());
  const url = state.view?.url ?? "";
  const engine = engineOf(url, hosts);
  const results = pickResults(engine, state.tree, hosts.google);
  if (!results.length) return state.history.length > 0 || state.scratch.waits >= 3 ? { do: "stop", reason: "I can't see a list of results on this page" } : { do: "wait" };
  let n: number | "last";
  if (s.nth === "next") {
    const mem = recallSearch();
    if (!mem) return { do: "stop", reason: "I don't know which result you were on. Say which number" };
    n = mem.nth + 1;
  } else n = s.nth;
  const hit = nthOf(results, n);
  if (!hit) return { do: "stop", reason: `there's no ${ordinalName(n)} result on this page` };
  state.scratch.picked = url;
  state.scratch.resultsUrl = url;
  state.scratch.resultsIndex = n === "last" ? results.length : n;
  rememberSearch({ engine, url, nth: n === "last" ? results.length : n, ...(recallSearch()?.query ? { query: recallSearch()!.query } : {}) });
  return { do: "click", ref: hit.ref };
}

function siteClick(state: TaskState, site: TaskSite, label: string): TaskAction {
  if (!state.history.length) {
    state.scratch.expectHost = hostOf(site.url);
    state.scratch.siteName = site.name;
    return { do: "open_url", url: site.url, label: site.name };
  }
  const last = state.history[state.history.length - 1];
  if (last.action.do === "click") return reachedPage(state, new RegExp(escapeRe(label), "i"))
    ? { do: "finish", said: `Went to ${site.name} and clicked ${quote(label)}: ${titleOf(state)}${where(state)}.` }
    : { do: "stop", reason: `I couldn't verify the ${quote(label)} page after clicking` };
  const want = label.toLowerCase();
  const hit = linkNamed(state.tree, new RegExp(`^${escapeRe(want)}$`, "i")) ?? linkNamed(state.tree, new RegExp(`^${escapeRe(want)}\\b`, "i")) ?? linkNamed(state.tree, new RegExp(escapeRe(want), "i"));
  if (!hit) return state.tree.length || state.scratch.waits >= 3 ? { do: "stop", reason: `I can't see a ${quote(label)} link on ${hostOf(state.view?.url ?? site.url)}` } : wait(state, `the page didn't load`);
  return { do: "click", ref: hit.ref };
}
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function findPage(state: TaskState, site: TaskSite | null, page: PageKind): TaskAction {
  if (site && !state.history.length) {
    state.scratch.expectHost = hostOf(site.url);
    return { do: "open_url", url: site.url, label: site.name };
  }
  const last = state.history[state.history.length - 1];
  const pageName = page === "faq" ? "FAQ" : `${page[0].toUpperCase()}${page.slice(1)}`;
  if (last?.action.do === "click") return reachedPage(state, PAGE_LABELS[page])
    ? { do: "finish", said: `Found the ${pageName} page${site ? ` on ${site.name}` : ""}: ${titleOf(state)}${where(state)}.` }
    : { do: "stop", reason: `I couldn't verify the ${pageName} page after clicking` };
  const re = PAGE_LABELS[page];
  const cands = state.tree.filter((n) => /^(?:link|tab|menuitem)$/.test(n.role) && re.test(n.name) && n.name.trim().length < 50 && !finalButtonText(n.name));
  // The plainest name first ("Pricing" before "See our pricing plans for teams").
  const hit = cands.sort((a, b) => a.name.split(/\s+/).length - b.name.split(/\s+/).length || a.index - b.index)[0];
  if (!hit) return state.tree.length || state.scratch.waits >= 3 ? { do: "stop", reason: `I couldn't find a ${pageName} link on ${hostOf(state.view?.url ?? "") || "this page"}` } : wait(state, "the page didn't load");
  return { do: "click", ref: hit.ref };
}

function gmailSearch(state: TaskState, deps: TaskDeps, query: string): TaskAction {
  const url = deps.urls?.gmail ?? "https://mail.google.com/";
  const gmailHost = hostOf(url);
  if (!state.history.length) {
    // (No wrong-site stop for Gmail: a landing on Google's own sign-in or marketing page is "your turn", said below.)
    return { do: "open_url", url, label: "Gmail" };
  }
  const host = hostOf(state.view?.url ?? "");
  // Not signed in on Jarvis Chrome (Google's marketing page or its sign-in): his to do.
  if (host !== gmailHost) return { do: "stop", reason: `Gmail isn't signed in on Jarvis Chrome (it landed on ${host || "another page"})`, yourTurn: true };
  const last = state.history[state.history.length - 1];
  if (last.action.do === "press") return { do: "finish", said: `Searched Gmail for ${quote(query)}${where(state)}.` };
  if (last.action.do === "type") return { do: "press", key: "Enter" };
  const box = state.tree.find((n) => /^(?:searchbox|textbox|combobox)$/.test(n.role) && /search/i.test(n.name));
  if (!box) return state.tree.length && state.scratch.waits >= 3 ? { do: "stop", reason: "I can't see Gmail's search box", yourTurn: true } : wait(state, "Gmail's search box didn't appear");
  return { do: "type", ref: box.ref, text: query };
}

const HEADLINE_SKIP = /^(?:skip to|menu|search|sign in|log in|subscribe|home|latest|top stories?|news|live|watch|listen|more|weather|advertisement|newsletters?|contact|about|help|privacy|terms)\b/i;
function readHeadline(state: TaskState, site: TaskSite | null): TaskAction {
  if (site && !state.history.length) {
    state.scratch.expectHost = hostOf(site.url);
    state.scratch.siteName = site.name;
    return { do: "open_url", url: site.url, label: site.name };
  }
  const nodes = state.tree.slice(0, 1500);
  const heading = nodes.find((n) => n.role === "heading" && (n.level ?? 3) <= 3 && n.name.trim().length >= 20 && !HEADLINE_SKIP.test(n.name.trim()));
  const link = heading ? null : nodes.find((n) => n.role === "link" && n.name.trim().length >= 30 && !HEADLINE_SKIP.test(n.name.trim()));
  const found = heading ?? link;
  if (!found) return nodes.length || state.scratch.waits >= 3 ? { do: "stop", reason: "I couldn't find a headline on the page" } : wait(state, "the page didn't load");
  const safe = safePageText(found.name.trim(), 300);
  const text = safe.text.replace(/\[hidden\]/g, "").trim();
  if (!text) return { do: "stop", reason: "the headline looked sensitive, so I left it" };
  return { do: "finish", said: `The top story${site ? ` on ${site.name}` : ` on ${hostOf(state.view?.url ?? "") || "this page"}`} is ${quote(text)}.` };
}

function readFooter(state: TaskState, site: TaskSite | null): TaskAction {
  if (site && !state.history.length) {
    state.scratch.expectHost = hostOf(site.url);
    return { do: "open_url", url: site.url, label: site.name };
  }
  if (!state.scratch.scrolled) {
    state.scratch.scrolled = true;
    return { do: "scroll", dir: "bottom" };
  }
  if (state.scratch.read === undefined) return { do: "read", what: "footer" };
  const safe = safePageText(state.scratch.read, 400);
  const gist = clip(safe.text.replace(/\[hidden\]/g, "").trim(), 320).replace(/\[[^\]]*$/, "").trim();
  if (!gist) return { do: "finish", said: `I scrolled to the bottom of ${hostOf(state.view?.url ?? "") || "the page"}, but there's no footer text to read${where(state)}.` };
  return { do: "finish", said: `The footer says: ${gist}${safe.hidden ? ` (${safe.hidden} sensitive bit${safe.hidden > 1 ? "s" : ""} left out)` : ""}.` };
}

const PHONE = /(?:\+?61[\s-]?\(?0?\)?[\s-]?[2-478](?:[\s-]?\d){8}|\(0[2-8]\)[\s-]?\d{4}[\s-]?\d{4}|\b0[2-478](?:[\s-]?\d){8}\b|\b1[38]00[\s-]?\d{3}[\s-]?\d{3}\b|\b13[\s-]?\d{2}[\s-]?\d{2}\b|\+\d{1,3}[\s-]?\(?\d{1,4}\)?(?:[\s-]?\d{2,4}){2,4})/;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
function contactRead(state: TaskState, site: TaskSite | null, what: "phone" | "email" | "address"): TaskAction {
  if (site && !state.history.length) {
    state.scratch.expectHost = hostOf(site.url);
    return { do: "open_url", url: site.url, label: site.name };
  }
  const url = state.view?.url ?? "";
  const onContact = /contact/i.test(url) || /contact/i.test(state.view?.title ?? "") || state.scratch.contactTried;
  if (!onContact) {
    const hit = linkNamed(state.tree, PAGE_LABELS.contact);
    if (hit) {
      state.scratch.contactTried = true;
      return { do: "click", ref: hit.ref };
    }
    // No Contact link: the page itself may carry the number.
  }
  // The tel: / mailto: links first (an exact number), then the words on the page.
  const tel = state.tree.find((n) => n.url?.startsWith("tel:"));
  const mail = state.tree.find((n) => n.url?.startsWith("mailto:"));
  const pageName = onContact ? "Contact page" : "page";
  // (The link's own words when they are the number, "02 9999 1234", else the number in its address.)
  if (what === "phone" && tel?.url) return { do: "finish", said: `The phone number on the ${pageName} is ${/^[+\d][\d\s().-]{6,}$/.test(tel.name.trim()) ? tel.name.trim() : decodeURIComponent(tel.url.slice(4)).trim()}.` };
  if (what === "email" && mail?.url) return { do: "finish", said: `The email on the ${pageName} is ${decodeURIComponent(mail.url.slice(7)).split("?")[0]}.` };
  if (state.scratch.read === undefined) return { do: "read", what: "page" };
  const safe = safePageText(state.scratch.read, 6000).text;
  if (what === "phone") {
    const p = safe.match(PHONE)?.[0];
    if (p) return { do: "finish", said: `The phone number on the ${pageName} is ${p.trim()}.` };
  } else if (what === "email") {
    const e = safe.match(EMAIL)?.[0];
    if (e) return { do: "finish", said: `The email on the ${pageName} is ${e}.` };
  } else {
    const a = safe.match(/(?:address|find us|visit us|location)[:\s-]*([^\n]{10,120}?\b\d{4}\b)/i)?.[1] ?? safe.match(/\b\d{1,4}[A-Za-z]?\s+[A-Z][\w' -]{2,40}\s+(?:St|Street|Rd|Road|Ave|Avenue|Pde|Parade|Hwy|Highway|Lane|Ln|Drive|Dr|Place|Pl)\b[^.\n]{0,60}?\b\d{4}\b/)?.[0];
    if (a) return { do: "finish", said: `The address on the ${pageName} is ${clip(a, 120)}.` };
  }
  return { do: "stop", reason: `I couldn't find a ${what === "phone" ? "phone number" : what} on the ${pageName}` };
}

function fillForm(state: TaskState, deps: TaskDeps, site: TaskSite | null, wants: string[] | "all"): TaskAction {
  if (site && !state.history.length) {
    state.scratch.expectHost = hostOf(site.url);
    return { do: "open_url", url: site.url, label: site.name };
  }
  const fields = state.tree.filter((n) => n.role === "textbox" && !/search/i.test(n.name));
  // No form on this page yet: the Contact link takes you to one.
  if (!fields.length && !state.scratch.contactTried) {
    const hit = linkNamed(state.tree, PAGE_LABELS.contact);
    if (hit) {
      state.scratch.contactTried = true;
      return { do: "click", ref: hit.ref };
    }
  }
  if (!fields.length) return state.tree.length && state.scratch.waits >= 3 ? { do: "stop", reason: "I can't see a form on this page" } : wait(state, "I can't see a form on this page");
  const details = (deps.details ?? (() => savedDetails()))();
  const byKey = new Map(details.map((d) => [d.key, d]));
  const allowed = (key: string) => wants === "all" || wants.includes(key);
  for (const f of fields) {
    if (state.scratch.formHandled.has(f.ref)) continue;
    state.scratch.formHandled.add(f.ref);
    const label = f.name.trim();
    let key = ruleFor(label);
    // A bare "Name" is his full name when he has one saved.
    if (key === "first_name" && /^(?:your |full )?name\b\*?$/i.test(label) && byKey.has("full_name")) key = "full_name";
    if (!key || !allowed(key) || conflicts(label, key)) continue;
    const d = byKey.get(key);
    if (!d) {
      state.scratch.blank.push(label);
      continue;
    }
    state.scratch.filled.push(label);
    return { do: "type", ref: f.ref, text: d.value };
  }
  // Every field is dealt with: stop before the button, whatever it's called. Never pressed.
  const button = state.tree.find((n) => n.role === "button" && finalButtonText(n.name)) ?? state.tree.find((n) => n.role === "button" && /^(?:send|submit|book|request|enquire|inquire|contact|get in touch)\b/i.test(n.name));
  const filled = state.scratch.filled;
  if (!filled.length) return { do: "stop", reason: state.scratch.blank.length ? `I don't have your ${state.scratch.blank.slice(0, 2).join(" or ").toLowerCase()} saved, so I left the form as it was` : "none of its fields matched what you asked me to fill" };
  const names = filled.length > 1 ? `${filled.slice(0, -1).join(", ")} and ${filled[filled.length - 1]}` : filled[0];
  const blank = state.scratch.blank.length ? ` I left ${state.scratch.blank.slice(0, 3).join(" and ")} blank: it isn't saved.` : "";
  return { do: "finish", said: `Filled ${names} on ${site?.name ?? hostOf(state.view?.url ?? "the form")}${where(state)}.${blank} Ready for you to press ${button ? clip(button.name, 30) : "Send"}.` };
}

// --- the brain's turn (goals the rules don't know) --------------------------------------------------------------------------
async function free(state: TaskState, deps: TaskDeps): Promise<TaskAction> {
  if (!deps.decide) throw new Error("I don't know how to do that one on my own yet");
  const cap = deps.stepCap ?? TASK_STEP_CAP;
  const raw = await deps.decide({
    goal: state.goal,
    step: state.step,
    cap,
    url: state.view?.url ?? "",
    title: clip(safeTitle(state.view?.title ?? ""), 100),
    nodes: state.tree.slice(0, 60).map((n) => ({ ref: n.ref, role: n.role, name: clip(n.name, 80), ...(n.url ? { url: clip(n.url, 120) } : {}) })),
    history: state.history.slice(-5).map((h) => `${describeAction(h.action)} -> ${h.ok ? "ok" : "failed"}`),
    schema: TASK_ACTION_SCHEMA,
  });
  const a = validateAction(raw, state);
  if (!a) throw new Error("I couldn't work out the next step");
  const scope = requestedHost(state.goal, state.view?.url ?? "");
  if (a.do === "open_url") {
    if (!scope) return { do: "stop", reason: "I need a website named in your request before opening a new site" };
    if (wrongSite(scope, a.url)) return { do: "stop", reason: `that address is outside ${scope}; name the other site in a new request if you want me to go there` };
    state.scratch.expectHost = scope;
  } else if ((a.do === "click" || a.do === "type" || a.do === "press") && scope) {
    if (state.view && wrongSite(scope, state.view.url)) return { do: "stop", reason: `this page is outside ${scope}` };
    state.scratch.expectHost = scope;
  }
  return a;
}

/** The brain's JSON, checked against the schema and the page: an unknown ref, a bad address or a made-up verb is refused. Pure. */
export function validateAction(raw: unknown, state: Pick<TaskState, "tree">): TaskAction | null {
  const o = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  if (!o) return null;
  const has = (ref: unknown) => typeof ref === "string" && state.tree.some((n) => n.ref === ref);
  const str = (v: unknown, n: number) => (typeof v === "string" ? clip(v, n) : "");
  switch (o.do) {
    case "open_url": {
      const url = str(o.url, 500);
      return /^https?:\/\/[^\s]+$/i.test(url) ? { do: "open_url", url } : null;
    }
    case "click":
      return has(o.ref) ? { do: "click", ref: String(o.ref) } : null;
    case "type": {
      const text = str(o.text, 200);
      return has(o.ref) && text ? { do: "type", ref: String(o.ref), text } : null;
    }
    case "press":
      return o.key === "Enter" ? { do: "press", key: "Enter" } : null;
    case "scroll":
      return o.dir === "up" || o.dir === "down" || o.dir === "bottom" ? { do: "scroll", dir: o.dir } : null;
    case "back":
      return { do: "back" };
    case "select_tab":
      return Number.isInteger(o.index) && (o.index as number) >= 1 && (o.index as number) <= 20 ? { do: "select_tab", index: o.index as number } : null;
    case "read":
      return { do: "read", what: o.what === "footer" ? "footer" : "page" };
    case "wait":
      return { do: "wait" };
    case "finish": {
      const said = safePageText(str(o.said, 240), 240).text.replace(/\[hidden\]/g, "").trim();
      return said ? { do: "finish", said } : null;
    }
    case "stop": {
      const reason = str(o.reason, 160);
      return reason ? { do: "stop", reason, ...(o.yourTurn === true ? { yourTurn: true } : {}) } : null;
    }
    default:
      return null;
  }
}

export { ordinalOf };
export type { Nth };
