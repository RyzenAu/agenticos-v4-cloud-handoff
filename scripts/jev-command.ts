/**
 * The one Jarvis entry for doing things (Wave 2, 27 Sep 2026):
 *
 *   his request → hard refusals (code) → which machine (resolveTarget) → Jev's structured decision
 *   (intent + confidence, one request) → the right executor → fresh observation → independent check
 *   → one short spoken line + the full step log (/screen/runs).
 *
 * Executors behind it:
 *   screen   the Jev-first screen_act loop over UIA (native Windows) or Playwright (Jarvis Chrome)
 *   browser  the app-owned Playwright browser (public pages: YouTube search/open/play/pause/watch)
 *   app      PowerPoint through COM (create/open/edit/show), opening apps by name
 *   file     an authorised document by name, opened in its default app
 *   answer   deterministic answers (receptionist margins from the economics model)
 * and explicit handoffs (logged) for what isn't an action: open-ended writing, planning, advice or a
 * question about the screen go to the existing LLM routes; OS pages go back to the client to open.
 *
 * Jev chooses; the executor acts; gates are code: secret requests are refused before Jev is asked (money requests
 * are not, since 29 Sep; the executors refuse money goals, screens and buttons),
 * final buttons need his spoken yes (the voice pipeline's server-side event), and nothing is
 * repeated after an uncertain result. Numbers never come from a model.
 */
import type { ScreenDone, ScreenEvent, ScreenHands } from "./screen-hands/index";
import { launchOnlyNote } from "./jarvis-execution/spoken-money";
import { goalSlots, JEV_CONTROL_ACT } from "./screen-hands/jev-control";
import { screenGoalRefusal } from "./screen-hands/refusals";
import type { RunHandle, RunRecord } from "./screen-hands/run-log";
import { routeDesktopCommand, type DesktopRoute } from "./jev-desktop";
import { buildCall, type JevAnswers } from "./jev-router";
import { localTarget, THIS_PC_DEVICE_ID, type LocalTarget, type ResolveTarget } from "./jev-target";
import { marginAnswer, parseMarginQuery } from "./jev-margin";
import { fileNameIn, openFileByName, type FileDeps } from "./jev-files";
import { deckOp as runDeckOp, parseDeckRequest, type DeckOp, type DeckState } from "./jev-powerpoint";
import { watchAndSummarise, type AppBrowser, type Summarise } from "./browser/app-browser";
import { pcIntent, type StartApp } from "./pc-hands";
import { windowIsApp } from "./jarvis-skills/windows";
import { tidyHead } from "./screen-hands/plan";
import { voiceDestination } from "../src/lib/voice-actions";
import type { ExecutorResult, JevDecision, PageContext, SpecialistId, SurfaceThresholds } from "./jarvis-command/contracts";
import { planContinuation } from "./jarvis-command/continuation";
import { googleSearchUrl, linkedSteps, planRules, safeHost, searchQueryIn, siteIn } from "./jarvis-command/plan";
import { policyFor, thresholdsFor } from "./jarvis-command/thresholds";
import { jevOutageLine } from "./jev-controller";

export type CommandRequest = {
  utterance: string;
  /** Who asked (the devices track's person id). Default "usman". */
  personId?: string;
  /** "on my laptop": the machine he named, if any. */
  spokenTarget?: string;
  source?: RunRecord["source"];
  /** Track 2: the Job the command service records this run in (the B2 mirror then skips the run). */
  jobId?: string;
  /**
   * Track 2: the device the command service already resolved from the VERIFIED principal (resolveTarget).
   * When set, `personId` is ignored and this must be the hub; the entry never re-resolves from a body field.
   */
  target?: { deviceId: string; owner: "usman" | "mehroz" };
  /** Which surface's thresholds apply ("voice" or "typed"). */
  surface?: "voice" | "typed";
  pageContext?: PageContext | null;
  /**
   * Round 10: the command service already asked Jev (its one bounded decision) and Jev chose this lane on this PC. The entry then fills the
   * exact arguments by rule and does NOT ask Jev again; its decisions after this are labelled as filling Jev's lane.
   */
  decided?: { lane: "device.open" | "device.screen"; confidence: number };
  /**
   * Round 10: the command service already found Jev unavailable for this request (this reason). The entry does NOT ask Jev again (one bounded
   * budget per request); its exact lanes run as the labelled fallback and anything open-ended gets the outage line.
   */
  jevUnavailable?: string;
};
export type CommandKind = "screen" | "browser" | "app" | "file" | "answer" | "navigate" | "handoff" | "refused" | "ask" | "unavailable";
export type CommandDone = {
  type: "done";
  ok: boolean;
  said: string;
  kind: CommandKind;
  runId: string;
  route?: { intent: string; confidence: number; source: "jev" | "rules" | "unavailable" };
  navigate?: { path: string };
  url?: string;
  handoff?: { to: SpecialistId; intent: string; reason: string; utterance?: string };
  decision?: JevDecision;
  verified?: boolean | null;
  /** When the post-action check passed (ms epoch), for a lane that reports it. */
  checkedAt?: number;
  /** After a stop: the step that couldn't be cancelled, settling later (the service records its real outcome). */
  lateWork?: Promise<LateResult>;
  outcome?: ScreenDone["outcome"];
  ask?: boolean;
  stopped?: boolean;
  confirm?: string;
  /** The unfinished screen goal; earlier verified setup must never be replayed on yes. */
  resumeGoal?: string;
  refused?: boolean;
  numbers?: Record<string, unknown>;
};
export type CommandEvent = ScreenEvent | CommandDone | { type: "decision"; decision: JevDecision };

export type EntryDeps = {
  screen: Pick<ScreenHands, "act" | "runs">;
  /** The Jev (TypeSafe) key, from the runtime reference; "" = no Jev. */
  jevKey: () => string;
  request?: typeof fetch;
  front: () => Promise<{ process: string; title: string; handle?: number } | null>;
  /** The app-owned browser (opened on first use). */
  browser: () => Promise<AppBrowser | null>;
  summarise: Summarise | null;
  files: FileDeps;
  deck?: (op: DeckOp) => Promise<DeckState>;
  openApp: (name: string, signal: AbortSignal) => Promise<{ ok: boolean; said: string; checkedAt?: number }>;
  apps?: () => StartApp[] | Promise<StartApp[]>;
  /** Is a video open in the app browser right now? ("watch this" then means that video.) */
  activeVideo?: () => Promise<boolean>;
  resolver?: { resolve: ResolveTarget; source: "devices" | "stub" };
  /** Track 2 executors on THIS PC: a line into a NEW Notepad doc, a NEW never-saved PowerPoint (both read back). */
  notepad?: (text: string, signal: AbortSignal) => Promise<ExecutorResult>;
  deckBlank?: (title: string, signal: AbortSignal) => Promise<ExecutorResult>;
  /** Per-surface Jev thresholds (default: the inherited set, with its calibration run id). */
  thresholds?: (surface: "voice" | "typed") => SurfaceThresholds;
};

const YOUTUBE = /\byou\s?tube\b|\byt\b/i;
const WATCH = /\b(?:watch|summari[sz]e|what(?:'s| is)? (?:important|matters)|tell me what matters|key points|main points)\b/i;
const PLAY_PAUSE = /\b(?:pause|play|resume|stop the video|unpause)\b/i;

/** His words → the YouTube steps, in order. Pure. */
export function youtubeSteps(text: string): Array<{ do: "open" } | { do: "search"; query: string } | { do: "open_result"; title?: string; index?: number } | { do: "play" | "pause" } | { do: "watch" }> {
  const steps: ReturnType<typeof youtubeSteps> = [];
  const t = text.replace(/\s+/g, " ").trim();
  if (/\bopen (?:up )?you\s?tube\b/i.test(t) || (YOUTUBE.test(t) && !/\bsearch|video|watch\b/i.test(t))) steps.push({ do: "open" });
  const search = /\bsearch(?: you\s?tube)?(?: for)? ["“']?(.+?)["”']?(?=,| and (?:then )?(?:open|play|pause|click|watch)| then |$)/i.exec(t);
  if (search) steps.push({ do: "search", query: search[1].replace(/\s+on you\s?tube$/i, "").trim() });
  const titled = /\b(?:open|play|click)(?: the)? (?:video|one|result)(?: called| titled| named)? ["“']([^"”']{2,100})["”']/i.exec(t);
  const nth = /\b(?:open|play|click)(?: on)? the (first|second|third|1st|2nd|3rd|top) (?:video|one|result)\b/i.exec(t);
  if (titled) steps.push({ do: "open_result", title: titled[1] });
  else if (nth) steps.push({ do: "open_result", index: { first: 1, "1st": 1, top: 1, second: 2, "2nd": 2, third: 3, "3rd": 3 }[nth[1].toLowerCase() as "first"] });
  // "play the first video" / "play the video called X" open a result; a separate "pause it" / "play it" toggles.
  const lastPlay = [...t.matchAll(/\b(pause|resume|unpause|play)\b(?! (?:on )?the (?:(?:first|second|third|1st|2nd|3rd|top)\b|(?:video|one|result) (?:called|titled|named)\b))/gi)].pop()?.[1]?.toLowerCase();
  if (lastPlay && !(lastPlay === "play" && (titled || nth) && !/\b(?:then|and) play\b/i.test(t))) steps.push({ do: lastPlay === "pause" ? "pause" : "play" });
  if (WATCH.test(t) && !search) steps.push({ do: "watch" });
  return steps;
}

/**
 * A lane that can't itself be cancelled (the app browser, PowerPoint COM) raced against his stop: the stop
 * answers at once and honestly ("may still finish"), so a slow page or deck step never ignores a stop and
 * quarantines every later command (REVIEW-T2 R3). Pure over its inputs.
 */
export type LateResult = { ok: boolean; said: string };
/** The work a stop left running: what it did in the end, once it settles (REVIEW-T2 R4 F1). */
const lateOf = <T,>(work: Promise<T>): Promise<LateResult> =>
  work.then(
    (v) => {
      const x = v as { ok?: unknown; said?: unknown };
      return { ok: x?.ok === true, said: String(x?.said ?? "finished") };
    },
    (e) => ({ ok: false, said: `it failed: ${String((e as Error)?.message ?? e).slice(0, 120)}` }),
  );
export function untilStopped<T>(work: Promise<T>, signal: AbortSignal, stopped: T, late?: Promise<LateResult>[]): Promise<T> {
  if (signal.aborted) {
    late?.push(lateOf(work));
    work.catch(() => undefined);
    return Promise.resolve(stopped);
  }
  return new Promise<T>((resolve, reject) => {
    const onStop = () => {
      // The step keeps going (it can't be cancelled): its real outcome is recorded on the job when it lands.
      late?.push(lateOf(work));
      resolve(stopped);
    };
    signal.addEventListener("abort", onStop, { once: true });
    work.then(
      (v) => (signal.removeEventListener("abort", onStop), resolve(v)),
      (e) => (signal.removeEventListener("abort", onStop), reject(e)),
    );
  });
}
const PAGE_STOPPED = { ok: false, said: "Stopped. The page may still finish loading in my browser; nothing else was done.", stopped: true } as const;

export function createJarvisEntry(deps: EntryDeps) {
  async function handle(req: CommandRequest, signal: AbortSignal, onEvent: (e: CommandEvent) => void = () => undefined): Promise<CommandDone> {
    const utterance = String(req.utterance ?? "").trim().slice(0, 600);
    const slots = goalSlots(utterance);
    const surface = req.surface ?? (req.source === "voice" ? "voice" : "typed");
    const thresholds = (deps.thresholds ?? thresholdsFor)(surface);
    const log = deps.screen.runs.start({ request: slots.goal, source: req.source ?? "command", ...(req.jobId ? { jobId: req.jobId } : {}) });
    const say = (stage: "intent" | "act" | "check" | "ask" | "outcome" | "fallback", text: string, speak = false) => {
      const line = slots.mask(text).slice(0, 300);
      onEvent({ type: "narrate", stage, text: line, ...(speak ? { speak: true } : {}) });
      log.step({ stage, text: line, ...(speak ? { spoken: true } : {}) });
    };
    let decision: JevDecision | undefined;
    let deviceId: string | undefined;
    /** Jev's typed decision for this command (§3.4), logged beside the lane it picked and sent to the caller. */
    const decide = (d: Omit<JevDecision, "calibrationRunId" | "deviceId">) => {
      decision = { ...d, ...(d.target ? { target: slots.mask(d.target).slice(0, 80) } : {}), ...(deviceId ? { deviceId } : {}), calibrationRunId: thresholds.calibrationRunId };
      log.step({ stage: "decision", text: `Decision: ${decision.op} → ${decision.policy}${decision.delegateTo ? ` (${decision.delegateTo})` : ""}, ${Math.round(decision.confidence * 100)}% (${decision.source}): ${decision.why}`, jev: { op: decision.op, confidence: decision.confidence, policy: decision.policy, ms: 0, inputTokens: null, outputTokens: null, by: decision.source === "jev" ? "jev" : decision.source === "fallback" ? "fallback" : "rule" } });
      onEvent({ type: "decision", decision });
    };
    const late: Promise<LateResult>[] = [];
    const finish = (done: Omit<CommandDone, "type" | "runId">): CommandDone => {
      const out: CommandDone = { type: "done", runId: log.id, ...done, ...(decision && !done.decision ? { decision } : {}), ...(done.stopped && late.length ? { lateWork: Promise.all(late).then((rs) => rs[rs.length - 1]) } : {}) };
      log.end({ ok: out.ok, said: slots.mask(out.said), ...(out.outcome ? { outcome: out.outcome } : {}), ...(out.ask ? { ask: true } : {}), ...(out.stopped ? { stopped: true } : {}), ...(out.confirm ? { confirm: out.confirm } : {}) });
      onEvent(out);
      return out;
    };
    if (!utterance) return finish({ ok: false, said: "Do what?", kind: "ask", ask: true });
    say("intent", `Asked: ${slots.goal}`);

    // 1. Hard refusals in code (secrets and private data): before Jev, before any machine. A money REQUEST is
    //    not refused here (owner decision 29 Sep: "money requests are fine"); executing one stays gated where
    //    it would run: the screen executor refuses money goals, banks and money buttons, and the app browser
    //    never opens a money site.
    const goal = screenGoalRefusal(utterance);
    const refusal = goal?.kind === "secret-or-private-data" ? goal : null;
    if (refusal) {
      log.set({ route: { kind: "refused" }, executor: "none" });
      log.step({ stage: "refused", text: refusal.kind, spoken: true });
      decide({ op: "refuse", confidence: 1, policy: "done", source: "rules", why: `refused in code: ${refusal.kind}` });
      return finish({ ok: false, said: refusal.said, kind: "refused", refused: true });
    }
    // 2. Which machine. Only this PC's executors run here. The command service passes the device it
    //    resolved from the VERIFIED principal; without it (older callers) the entry resolves itself.
    let target: LocalTarget;
    if (req.target) {
      target = req.target.deviceId === THIS_PC_DEVICE_ID
        ? { ok: true, deviceId: req.target.deviceId, owner: req.target.owner, source: "devices" }
        : { ok: false, said: `That's for ${req.target.deviceId}, not this PC, so nothing ran here.`, source: "devices" };
    } else target = await localTarget({ personId: req.personId ?? "usman", ...(req.spokenTarget ? { spokenTarget: req.spokenTarget } : {}) }, deps.resolver);
    log.step({ stage: "target", text: target.ok ? `Target: ${target.deviceId} (${target.owner}; routing ${target.source})` : `Target refused (routing ${target.source})` });
    if (!target.ok) return finish({ ok: false, said: target.said, kind: "refused", refused: true });
    deviceId = target.deviceId;
    log.set({ target: { deviceId: target.deviceId, owner: target.owner } });
    if (signal.aborted) return finish({ ok: false, said: "Stopped.", kind: "screen", stopped: true });

    // 3. Jev's decision (one request: intent + every sub-choice), with the window in front as context.
    //    In the look-again band he looks once more (a fresh window read, a fresh decision), then asks.
    const askJevOnce = async () => {
      const front = await deps.front().catch(() => null);
      const route: DesktopRoute = await routeDesktopCommand(utterance, { key: deps.jevKey(), request: deps.request, window: front, timeoutMs: 2500 }).catch(() => ({ kind: "unavailable" as const, reason: "error" }));
      return { front, route };
    };
    let { front, route } = req.jevUnavailable
      ? { front: null, route: { kind: "unavailable" as const, reason: req.jevUnavailable === "no-key" ? "no Jev key" : req.jevUnavailable } as DesktopRoute }
      : req.decided
      ? { front: await deps.front().catch(() => null), route: { kind: req.decided.lane === "device.screen" ? ("screen" as const) : ("elsewhere" as const), intent: req.decided.lane === "device.screen" ? "screen_act" : "website", confidence: req.decided.confidence, outbound: 0, ms: 0, answers: {} } as DesktopRoute }
      : await askJevOnce();
    const logRoute = (r: DesktopRoute, again = false) => {
      if (r.kind === "unavailable") return;
      log.jev(r.ms, r.inputTokens ?? null, r.outputTokens ?? null);
      const policy = r.kind === "unsure" ? policyFor(r.confidence, thresholds) : "act";
      log.step({ stage: "route", text: `Jev${again ? " (looked again)" : ""}: ${r.intent} ${Math.round(r.confidence * 100)}% (${r.kind})`, jev: { op: r.intent, confidence: r.confidence, policy, ms: r.ms, inputTokens: r.inputTokens ?? null, outputTokens: r.outputTokens ?? null, by: "jev" } });
    };
    logRoute(route);
    if (!req.decided && route.kind === "unsure" && policyFor(route.confidence, thresholds) === "look-again" && !signal.aborted) {
      say("check", "Not sure yet; looking again.");
      const again = await askJevOnce();
      logRoute(again.route, true);
      if (again.route.kind !== "unavailable") ({ front, route } = again);
    }
    const jevRoute = route.kind === "unavailable" ? null : route;
    if (!jevRoute) log.step({ stage: "fallback", text: `Jev routing unavailable (${route.kind === "unavailable" ? route.reason : "?"}); using the rules` });
    const routed = jevRoute ? { intent: jevRoute.intent, confidence: jevRoute.confidence, source: "jev" as const } : { intent: "rules", confidence: 0, source: "unavailable" as const };
    const answers: JevAnswers = jevRoute?.answers ?? {};

    // 4. The lane. Deterministic lanes (exact numbers, named decks and files, YouTube, typed executor
    //    shapes) match his words first; Jev's intent decides everything else. Every choice is logged.
    const lane = (kind: CommandKind, executor: RunRecord["executor"], why: string, op?: string, targetName?: string, rules = true) => {
      log.set({ route: { kind, intent: routed.intent, confidence: routed.confidence }, executor });
      log.step({ stage: "route", text: `Lane: ${kind} (${why})` });
      decide({
        op: op ?? kind,
        ...(targetName ? { target: targetName } : {}),
        confidence: rules || !jevRoute ? 1 : jevRoute.confidence,
        policy: kind === "handoff" ? "delegate" : kind === "ask" ? "ask" : "act",
        // Jev out: an exact lane still runs, labelled as the deterministic fallback (never as Jev, never as an ordinary rule).
        source: !jevRoute ? "fallback" : rules ? "rules" : "jev",
        why,
      });
    };

    const margin = parseMarginQuery(utterance);
    if (margin) {
      lane("answer", "deterministic", "a margin question: numbers come from the economics model only", "answer.margin", margin.pkg.shortName);
      const a = marginAnswer(margin);
      say("check", "Computed from src/lib/business-economics.ts (deterministic).");
      return finish({ ok: true, said: a.said, kind: "answer", route: routed, numbers: a.numbers, verified: true });
    }

    const continuation = planContinuation(utterance);
    if (continuation) {
      const blocked = screenGoalRefusal(utterance);
      if (blocked) return finish({ ok: false, refused: true, kind: "refused", said: blocked.said });
      const setup = continuation.setup;
      lane("screen", setup.executor === "open-url" ? "playwright" : "uia", "verified setup followed by the existing Jev screen loop", "task.continue", setup.target);
      say("act", `Opening ${setup.executor === "open-url" ? safeHost(String(setup.args.url)) : setup.target ?? "the app"}.`, true);
      let checked: ExecutorResult;
      let browserPage: import("./screen-hands/browser-exec").PwPage | undefined;
      if (setup.executor === "notepad.type" && deps.notepad) checked = await deps.notepad(String(setup.args.text), signal);
      else if (setup.executor === "deck.blank" && deps.deckBlank) checked = await deps.deckBlank(String(setup.args.title), signal);
      else if (setup.executor === "app.open") {
        const r = await deps.openApp(String(setup.args.name), signal);
        checked = { ...r, verified: r.ok };
      } else if (setup.executor === "open-url") {
        const browser = await deps.browser();
        if (!browser) return finish({ ok: false, kind: "unavailable", said: "My browser isn't available, so nothing opened." });
        const r: { ok: boolean; said: string; stopped?: boolean } = await untilStopped(browser.open(String(setup.args.url)), signal, PAGE_STOPPED, late);
        checked = { ...r, verified: r.ok && !r.stopped };
        browserPage = browser.page();
      } else return finish({ ok: false, kind: "unavailable", said: "The opening step isn't connected, so nothing ran." });
      log.step({ stage: "check", text: checked.said, verified: checked.verified === true });
      if (signal.aborted) return finish({ ok: false, stopped: true, kind: "screen", said: "Stopped. The opening step may have finished; no later steps ran." });
      if (!checked.ok || checked.verified !== true) return finish({ ok: false, kind: "screen", verified: false, outcome: "unverified", said: `${checked.said} I stopped before the remaining steps.` });
      say("check", "The opening step is confirmed. Continuing on that target.");
      let onlyWindow: number | undefined;
      if (!browserPage) {
        const target = await deps.front().catch(() => null);
        const app = setup.executor === "notepad.type" ? "notepad" : setup.executor === "deck.blank" ? "powerpoint" : String(setup.args.name);
        if (!target || !windowIsApp(app, target.process)) return finish({ ok: false, kind: "screen", verified: false, outcome: "unverified", said: `${checked.said} The target app isn't in front, so I stopped before the remaining steps.` });
        onlyWindow = target.handle;
      }
      return screenLane(continuation.remaining, signal, onEvent, log, finish, routed, browserPage, checked.said, onlyWindow);
    }

    const exactRule = planRules(utterance);
    const wantsApp = /^(?:open|launch|start|run|fire up|bring up)\s/i.test(tidyHead(utterance));
    let apps: StartApp[] = [];
    if (wantsApp && exactRule?.lane !== "executor") apps = await Promise.resolve(deps.apps?.() ?? []).catch(() => [] as StartApp[]);
    const installed = pcIntent(utterance, apps);
    const rule = installed?.action === "open_app"
      ? {lane:"executor" as const,executor:"app.open" as const,args:{name:installed.target},op:"app.open",target:installed.target,why:"installed app from the Windows catalogue"}
      : exactRule;
    // Several exact steps in his order ("open Gmail and then YouTube"), here at this PC (his own device): each opened and checked in turn;
    // a failure stops there and says which step, and nothing later runs.
    const linked = linkedSteps(utterance);
    if (linked && linked.length > 1 && linked.every((s) => s.executor === "open-url" || s.executor === "app.open")) {
      lane("browser", "playwright", `${linked.length} exact steps in his order`, "remote.steps", undefined);
      const done: string[] = [];
      for (let i = 0; i < linked.length; i++) {
        if (signal.aborted) return finish({ ok: false, said: "Stopped.", kind: "browser", stopped: true, route: routed });
        const s = linked[i];
        say("act", `Step ${i + 1} of ${linked.length}: ${s.label}.`, true);
        let r: { ok: boolean; said: string; stopped?: boolean };
        if (s.executor === "app.open") r = await deps.openApp(String(s.args.name), signal);
        else {
          const b = await deps.browser();
          r = b ? await untilStopped<{ ok: boolean; said: string; stopped?: boolean }>(b.open(String(s.args.url)), signal, PAGE_STOPPED, late) : { ok: false, said: "My browser isn't available right now, so it didn't open." };
        }
        log.step({ stage: "check", text: r.said, verified: r.ok });
        if (r.stopped) return finish({ ok: false, said: r.said, kind: "browser", stopped: true, route: routed });
        if (!r.ok) return finish({ ok: false, said: `Stopped at step ${i + 1} of ${linked.length} (${s.label}), nothing later ran: ${r.said}`, kind: "browser", route: routed, verified: false, outcome: "unverified" });
        done.push(r.said.replace(/[.!]+$/, ""));
      }
      return finish({ ok: true, said: `Done, every step checked: ${done.join("; ")}.`.slice(0, 400), kind: "browser", route: routed, verified: true });
    }
    if (rule?.lane === "unsupported") {
      lane("ask", "none", rule.why, rule.op);
      return finish({ ok: false, ask: true, kind: "ask", said: rule.said, route: routed });
    }
    if (rule?.lane === "executor" && (rule.executor === "notepad.type" || rule.executor === "deck.blank" || rule.executor === "open-url" || rule.executor === "app.open")) {
      if (rule.executor === "notepad.type" && deps.notepad) {
        lane("app", "uia", rule.why, rule.op, "notepad");
        say("act", "Opening a new Notepad document and typing the line.", true);
        const r = await deps.notepad(String(rule.args.text ?? ""), signal);
        return executorFinish(r, "app", routed, log, finish, signal);
      }
      if (rule.executor === "deck.blank" && deps.deckBlank) {
        lane("app", "app-api", rule.why, rule.op, "powerpoint");
        say("act", "Opening a new PowerPoint and adding the title slide.", true);
        const r = await deps.deckBlank(String(rule.args.title ?? ""), signal);
        return executorFinish(r, "app", routed, log, finish, signal);
      }
      if (rule.executor === "open-url") {
        const url = String(rule.args.url ?? "");
        lane("browser", "playwright", rule.why, rule.op, safeHost(url));
        const b = await deps.browser();
        if (!b) return finish({ ok: false, said: "My browser isn't available right now, so nothing opened.", kind: "browser", route: routed, verified: null });
        say("act", `Opening ${safeHost(url)}.`, true);
        const r: { ok: boolean; said: string; url?: string; stopped?: boolean } = await untilStopped(b.open(url), signal, PAGE_STOPPED, late);
        if (r.stopped) return finish({ ok: false, said: r.said, kind: "browser", stopped: true, route: routed });
        log.step({ stage: "check", text: r.said, verified: r.ok });
        return finish({ ok: r.ok, said: r.said, kind: "browser", route: routed, verified: r.ok, ...(r.url ? { url: r.url } : {}), ...(r.ok ? {} : { outcome: "unverified" as const }) });
      }
      if (rule.executor === "app.open") {
        const name = String(rule.args.name ?? "");
        lane("app", "app-api", rule.why, rule.op, name);
        say("act", `Opening ${name}.`, true);
        const r = await deps.openApp(name, signal);
        log.step({ stage: "check", text: r.said, verified: r.ok });
        return finish({ ok: r.ok, said: `${r.said}${r.ok ? launchOnlyNote(utterance) : ""}`, kind: "app", route: routed, verified: r.ok, ...(r.ok && typeof r.checkedAt === "number" ? { checkedAt: r.checkedAt } : {}), ...(r.ok ? {} : { outcome: "unverified" as const }) });
      }
    }

    const deck = parseDeckRequest(utterance);
    if (deck?.ask) {
      lane("ask", "none", "a named deck with a slide the parser couldn't place: nothing runs", "deck");
      return finish({ ok: false, ask: true, kind: "ask", said: deck.ask, route: routed });
    }
    if (deck && deck.ops.length) {
      lane("app", "app-api", "a PowerPoint deck by name: PowerPoint's own automation", "deck", deck.path.split(/[\\/]/).pop());
      const exec = deps.deck ?? ((op: DeckOp) => runDeckOp(op));
      let last: DeckState | null = null;
      for (const op of deck.ops) {
        if (signal.aborted) return finish({ ok: false, said: "Stopped.", kind: "app", stopped: true, route: routed });
        say("act", `${op.op === "create" ? "Creating" : op.op === "open" ? "Opening" : op.op === "edit" ? "Editing" : op.op === "add" ? "Adding a slide to" : op.op === "show" ? "Showing" : "Closing"} the deck.`, true);
        const stoppedDeck = { ok: false, said: "Stopped. PowerPoint may still finish the step it had started; nothing more was done.", path: op.path, exists: false, slides: null, titles: [], showing: false, showSlide: null, ms: 0 } satisfies DeckState;
        last = await untilStopped(exec(op), signal, stoppedDeck, late);
        if (last === stoppedDeck) return finish({ ok: false, said: last.said, kind: "app", stopped: true, route: routed });
        log.step({ stage: "check", text: last.said, verified: last.ok });
        if (!last.ok) return finish({ ok: false, said: last.said, kind: "app", route: routed, outcome: "unverified", verified: false });
      }
      return finish({ ok: true, said: last?.said ?? "Done.", kind: "app", route: routed, verified: true });
    }

    const fileName = fileNameIn(utterance);
    if (fileName && !YOUTUBE.test(utterance) && !/^about\b/i.test(fileName)) {
      lane("file", "app-api", "a document by name, in the authorised folders", "file.open", fileName);
      say("act", `Looking for ${fileName}.`, true);
      const r = await openFileByName(fileName, deps.files);
      log.step({ stage: "check", text: r.said, verified: r.ok });
      return finish({ ok: r.ok, said: r.said, kind: r.ask ? "ask" : "file", route: routed, verified: r.ask ? null : r.ok, ...(r.ask ? { ask: true } : {}), ...(!r.ok && !r.ask ? { outcome: "unverified" as const } : {}) });
    }

    const intent = routed.intent;
    const videoOpen = WATCH.test(utterance) || PLAY_PAUSE.test(utterance) ? await deps.activeVideo?.().catch(() => false) : false;
    const wantsBrowser = YOUTUBE.test(utterance) || (videoOpen && (WATCH.test(utterance) || PLAY_PAUSE.test(utterance))) || (WATCH.test(utterance) && /\b(?:this|the) video\b/i.test(utterance)) || (intent.startsWith("browser.") && !front) || (PLAY_PAUSE.test(utterance) && /\bvideo\b/i.test(utterance));
    if (wantsBrowser) {
      lane("browser", "playwright", "YouTube or a video: the app-owned browser", "browser.youtube", "youtube");
      return browserLane(utterance, signal, log, say, finish, routed, late);
    }
    if (!jevRoute) {
      // No Jev (no key, a timeout, an error): open-ended words are NOT handed to the screen loop's planner instead (brief §4.12: no
      // unannounced substitute router). Every exact lane above still ran by rule; this one is said plainly, and nothing acts.
      const reason = route.kind === "unavailable" ? route.reason : "unavailable";
      log.set({ route: { kind: "unavailable", intent: "rules", confidence: 0 }, executor: "none" });
      log.step({ stage: "route", text: `Lane: none (Jev unavailable: ${reason}; no substitute router)` });
      decide({ op: "jev.unavailable", confidence: 0, policy: "done", source: "rules", why: `Jev unavailable (${reason}): open-ended request not routed; no substitute router` });
      return finish({ ok: false, kind: "unavailable", said: jevOutageLine(!deps.jevKey() || /no jev key/i.test(reason) ? "no-key" : /timeout|timed/i.test(reason) ? "timeout" : "unavailable"), route: routed, verified: null, numbers: { jev: { state: "unavailable", reason } } });
    }
    if (jevRoute.kind === "unsure") {
      lane("ask", "none", `Jev below ${thresholds.act} after looking again`, "ask", undefined, false);
      return finish({ ok: false, ask: true, kind: "ask", said: `I'm not sure what you want me to do there (${Math.round(jevRoute.confidence * 100)}% sure it's ${intent.replace(/[._]/g, " ")}). Say it another way?`, route: routed });
    }
    // Only screen work drives the window in front (AUDIT-F4 F7): "fix the login bug" (Jev: hermes) is not a
    // reason to click on whatever is open, which is usually the OS itself. Page actions still are.
    if (intent === "screen_act" || (front && intent.startsWith("browser."))) {
      lane("screen", "uia", "work on the window in front: the Jev-first loop", "screen.act", front?.process, false);
      return screenLane(utterance, signal, onEvent, log, finish, routed);
    }
    if (intent === "pc.open_app") {
      if (!apps.length) apps = await Promise.resolve(deps.apps?.() ?? []).catch(() => [] as StartApp[]);
      const call = buildCall(intent, utterance, answers, { apps, skills: [] });
      const name = "name" in call && call.name === "pc_act" ? String((call.arguments as { target?: unknown }).target ?? "") : "";
      if (!name) return finish({ ok: false, said: "I couldn't tell which app to open.", kind: "ask", ask: true, route: routed });
      lane("app", "app-api", `open ${name}`, "app.open", name, false);
      say("act", `Opening ${name}.`, true);
      const r = await deps.openApp(name, signal);
      log.step({ stage: "check", text: r.said, verified: r.ok });
      return finish({ ok: r.ok, said: `${r.said}${r.ok ? launchOnlyNote(utterance) : ""}`, kind: "app", route: routed, verified: r.ok, ...(r.ok && typeof r.checkedAt === "number" ? { checkedAt: r.checkedAt } : {}), ...(r.ok ? {} : { outcome: "unverified" as const }) });
    }
    if (intent === "os_page") {
      const call = buildCall(intent, utterance, answers, { apps: [], skills: [] });
      const path = "name" in call && call.name === "navigate" ? String((call.arguments as { path?: unknown }).path ?? "") : "";
      if (!path) return finish({ ok: false, said: "Which page of the OS?", kind: "ask", ask: true, route: routed });
      lane("navigate", "none", `OS page ${path}: the client opens it`, "navigate", path, false);
      // Say the page the way the OS names it ("Opening Home."), never the raw path ("Opening /business.") (J4).
      return finish({ ok: true, said: `Opening ${voiceDestination(path)?.label ?? "that page"}.`, kind: "navigate", navigate: { path }, route: routed, verified: null });
    }
    if (intent === "website") {
      const call = buildCall(intent, utterance, answers, { apps: [], skills: [] });
      const url = "name" in call && call.name === "open_url" ? String((call.arguments as { url?: unknown }).url ?? "") : "";
      if (url) {
        lane("browser", "playwright", `website ${url}: the app-owned browser`, "open-url", safeHost(url), false);
        const b = await deps.browser();
        if (!b) return finish({ ok: false, said: "My browser isn't available right now.", kind: "browser", route: routed });
        say("act", `Opening ${new URL(url).hostname}.`, true);
        const r: { ok: boolean; said: string; url?: string; stopped?: boolean } = await untilStopped(b.open(url), signal, PAGE_STOPPED, late);
        if (r.stopped) return finish({ ok: false, said: r.said, kind: "browser", stopped: true, route: routed });
        log.step({ stage: "check", text: r.said, verified: r.ok });
        return finish({ ok: r.ok, said: r.said, kind: "browser", route: routed, verified: r.ok, ...(r.url ? { url: r.url } : {}) });
      }
    }
    // Jev chose "open or search on this PC" (the service's decision) and no exact lane matched: the search phrase or the site comes from his words.
    if (req.decided?.lane === "device.open") {
      const query = searchQueryIn(utterance);
      const url = query ? googleSearchUrl(query) : siteIn(utterance);
      if (!url) {
        lane("ask", "none", "Jev chose to open a page here, but the words name no site or search", "ask", undefined, false);
        return finish({ ok: false, ask: true, kind: "ask", said: "Which site should I open, or what should I search for? Nothing has run yet.", route: routed });
      }
      lane("browser", "playwright", query ? "a Google search for exactly his words" : `the site he named`, query ? "web.search" : "open-url", safeHost(url), false);
      const b = await deps.browser();
      if (!b) return finish({ ok: false, said: "My browser isn't available right now, so nothing opened.", kind: "browser", route: routed, verified: null });
      say("act", `Opening ${safeHost(url)}.`, true);
      const r: { ok: boolean; said: string; url?: string; stopped?: boolean } = await untilStopped(b.open(url), signal, PAGE_STOPPED, late);
      if (r.stopped) return finish({ ok: false, said: r.said, kind: "browser", stopped: true, route: routed });
      log.step({ stage: "check", text: r.said, verified: r.ok });
      return finish({ ok: r.ok, said: r.said, kind: "browser", route: routed, verified: r.ok, ...(r.url ? { url: r.url } : {}), ...(r.ok ? {} : { outcome: "unverified" as const }) });
    }
    // Not an action for these executors: an explicit, logged delegation to the existing routes. Nothing
    // ran here, so it is never reported as done: ok:false, and the caller runs the delegate.
    const to: SpecialistId = intent === "screen" ? "vision" : intent === "brain" ? "brain" : "voice-tools";
    const reason =
      to === "brain"
        ? "open-ended writing, planning, advice or a question: the chat brain's job, not a desktop action"
        : to === "vision"
          ? "a question about the screen: the screen-vision route (his Allow) answers it"
          : `the ${intent} tool handles this directly`;
    log.set({ route: { kind: "handoff", intent, confidence: routed.confidence, handoff: to }, executor: "handoff" });
    log.step({ stage: "handoff", text: `Handoff → ${to}: ${reason}` });
    decide({ op: `delegate.${to}`, confidence: routed.confidence, policy: "delegate", delegateTo: to, source: "jev", why: reason });
    return finish({ ok: false, said: to === "brain" ? "That needs thinking or writing rather than hands, so it goes to the chat brain." : to === "vision" ? "That's a question about your screen, so it goes to screen vision." : "That's one for another of my tools.", kind: "handoff", handoff: { to, intent, reason, utterance }, route: routed, verified: null });
  }

  /** An executor result → the done line. Success only when the independent check after the action passed. */
  function executorFinish(r: ExecutorResult, kind: CommandKind, routed: NonNullable<CommandDone["route"]>, log: RunHandle, finish: (d: Omit<CommandDone, "type" | "runId">) => CommandDone, signal: AbortSignal): CommandDone {
    log.step({ stage: "check", text: `${r.said}${r.evidence ? ` [${r.evidence}]` : ""}`, verified: r.verified === true });
    if (signal.aborted && !r.ok) return finish({ ok: false, said: "Stopped.", kind, stopped: true, route: routed, verified: r.verified });
    const ok = r.ok && r.verified === true;
    return finish({ ok, said: r.ok && r.verified !== true ? `${r.said} I couldn't confirm it, so I'm not calling it done.` : r.said, kind, route: routed, verified: r.verified, ...(ok && typeof r.checkedAt === "number" ? { checkedAt: r.checkedAt } : {}), ...(ok ? {} : { outcome: "unverified" as const }) });
  }

  async function screenLane(utterance: string, signal: AbortSignal, onEvent: (e: CommandEvent) => void, log: RunHandle, finish: (d: Omit<CommandDone, "type" | "runId">) => CommandDone, routed: NonNullable<CommandDone["route"]>, browserPage?: import("./screen-hands/browser-exec").PwPage, setupSaid = "", onlyWindow?: number) {
    const done = await deps.screen.act({ goal: utterance, jev: true, requireSpokenYes: true, source: "command", ...(setupSaid ? { resumeFrom: 0 } : {}), ...(browserPage ? { browserPage } : {}), ...(onlyWindow ? { onlyWindow } : {}) }, signal, (e) => onEvent(e), log);
    // A question back (an ask, or a final button waiting for his yes) is not done (REVIEW-JEV §2): ok stays
    // false so the job, the voice batch and the calibration log never count it as a success.
    const waiting = !!done.ask || !!done.confirm;
    return finish({
      ok: done.ok && !waiting && !done.outcome, said: `${setupSaid ? `${setupSaid} ` : ""}${done.said}`, kind: "screen", route: routed, verified: waiting ? null : done.ok && !done.outcome,
      ...(done.outcome ? { outcome: done.outcome } : {}), ...(waiting ? { ask: true } : {}), ...(done.stopped ? { stopped: true } : {}), ...(done.confirm ? { confirm: done.confirm, resumeGoal: utterance } : {}), ...(done.refused ? { refused: true } : {}),
    });
  }

  async function browserLane(
    utterance: string,
    signal: AbortSignal,
    log: RunHandle,
    say: (stage: "intent" | "act" | "check" | "ask" | "outcome" | "fallback", text: string, speak?: boolean) => void,
    finish: (d: Omit<CommandDone, "type" | "runId">) => CommandDone,
    routed: NonNullable<CommandDone["route"]>,
    late: Promise<LateResult>[],
  ): Promise<CommandDone> {
    const steps = youtubeSteps(utterance);
    if (!steps.length) return finish({ ok: false, ask: true, kind: "ask", said: "What should I do on YouTube: search, open a video, play or pause it?", route: routed });
    const b = await deps.browser();
    if (!b) return finish({ ok: false, said: "My browser isn't available right now (Playwright didn't load).", kind: "browser", route: routed });
    let said = "";
    for (const step of steps) {
      if (signal.aborted) return finish({ ok: false, said: "Stopped.", kind: "browser", stopped: true, route: routed });
      let r: { ok: boolean; said: string };
      switch (step.do) {
        case "open":
          say("act", "Opening YouTube.", true);
          r = await untilStopped<{ ok: boolean; said: string }>(b.open("https://www.youtube.com/"), signal, PAGE_STOPPED, late);
          break;
        case "search":
          say("act", `Searching YouTube for ${step.query}.`, true);
          r = await untilStopped<{ ok: boolean; said: string }>(b.youtubeSearch(step.query), signal, PAGE_STOPPED, late);
          break;
        case "open_result":
          say("act", step.title ? `Opening the video "${step.title}".` : `Opening result ${step.index}.`, true);
          r = await untilStopped<{ ok: boolean; said: string }>(b.openResult(step), signal, PAGE_STOPPED, late);
          break;
        case "play":
        case "pause":
          say("act", step.do === "pause" ? "Pausing the video." : "Playing the video.", true);
          r = await untilStopped<{ ok: boolean; said: string }>(b.setPlaying(step.do), signal, PAGE_STOPPED, late);
          break;
        case "watch": {
          say("act", "Reading the video's transcript to find what matters.", true);
          const w = await watchAndSummarise(b, { summarise: deps.summarise, question: utterance, signal });
          log.step({ stage: "check", text: `Watch source: ${w.source}; ${w.points.filter((p) => p.verified).length}/${w.points.length} timestamps verified; ${w.limits}`, verified: w.ok });
          if (w.handoff) log.step({ stage: "handoff", text: `Handoff → LLM (${w.handoff.model ?? "no model"}) for "what matters"; timestamps checked against the transcript` });
          r = { ok: w.ok, said: w.said };
          break;
        }
      }
      if (r === PAGE_STOPPED || signal.aborted) return finish({ ok: false, said: r === PAGE_STOPPED ? r.said : "Stopped.", kind: "browser", stopped: true, route: routed });
      log.step({ stage: "check", text: r.said, verified: r.ok });
      if (!r.ok) return finish({ ok: false, said: r.said, kind: "browser", route: routed, outcome: "unverified" });
      said = r.said;
    }
    return finish({ ok: true, said, kind: "browser", route: routed, url: b.page().url() });
  }

  return { handle };
}
export type JarvisEntry = ReturnType<typeof createJarvisEntry>;
