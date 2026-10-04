// Away mode: Jarvis works through a queue on this PC while Usman is out, one task at a time.
//
// Safety model (code, not prompt):
// - Never, even with his approval: banking and finance, money, password managers and credentials,
//   security settings, installing software, messaging other people (policy.ts), plus screen-hands'
//   own deny-list, which must be switched on for any screen task.
// - Allowlist by default: only reversible steps run on their own. Anything that deletes, submits,
//   deploys or otherwise can't be taken back (policy.approvalReason, screen-hands' FINAL_BUTTON and
//   Jev "can this be undone?" gates) PAUSES the task and sends him a Telegram request with a
//   masked screenshot of the target and a one-time code. Only "yes CODE" from his own chat, before
//   it times out, lets that one action through. A wrong code, another chat or silence: nothing.
// - Locked PC: Windows' secure desktop can't be driven and this never tries (nor touches the lock
//   screen or any security setting). Screen tasks wait; file, CLI and Hermes tasks still run.
// - Kill switch: /stop halts the current action at once and pauses the queue. His own keyboard or
//   mouse (never Jarvis's injected input) also halts it and turns away mode off: he's back.
// - Audit: every step is logged with a timestamp, the action, the target and the result, with a
//   low-res masked screenshot for screen steps, kept 7 days on D:.
import { createHash, createHmac, randomBytes } from "node:crypto";
import { paymentIntent, type PaymentKind, type PaymentNever } from "../../src/lib/money-policy";
import { describePayment, type PaymentDetails } from "../screen-hands/payment";
import type { ScreenDone, ScreenRequest, Snapshot, UiElement } from "../screen-hands";
import { deniedWindow, pickElement, saveDialogEnter, secureField, sensitiveText } from "../screen-hands/plan";
import type { WindowInfo } from "../jarvis-skills/windows";
import {
  allowedPath,
  approvalReason,
  awayHermesRefusal,
  buttonVerdict,
  classifyTask,
  proseApprovalRefusal,
  stripSelfReport,
  needsScreen,
  neverReason,
  neverReasonBesidesMoney,
  neverWindow,
  neverWindowBesidesMoney,
  newCode,
  parseTelegram,
  sameCode,
  TELEGRAM_HELP,
  type AwayVoice,
  type CliRecipe,
  type FileOp,
  type ScreenStep,
} from "./policy";
import { classifyTaskWithJevFallback, type Jev } from "./jev-fallback";
import { CHAT_MONEY_REFUSAL, chatMoneyOrder } from "../jarvis-execution/spoken-money";
import { hermesControlRetentionAdmission } from "../jarvis-execution/hermes-retention";
import type { Rect, Sentinel } from "./sentinel";
import type { AuditLog, AwayState, AwayTask, PendingApproval, PendingPayment, StateStore, TaskSource } from "./store";
import type { Notifier } from "./notify";

export type ScreenPort = {
  act(req: ScreenRequest, signal: AbortSignal): Promise<ScreenDone>;
  stopAll(): number;
  /** screen-hands' hardening flags; away screen tasks need the deny-list on. */
  flags(): { denylist: boolean };
  foreground(): Promise<WindowInfo | null>;
  snapshot(win: WindowInfo): Promise<Snapshot>;
  /** Top-level windows, and bringing one to the front (an app launched from a background process can open behind). */
  windows?(): Promise<WindowInfo[]>;
  focus?(handle: number): Promise<boolean>;
};
export type FilePort = {
  exists(path: string): boolean;
  mkdir(path: string): Promise<void>;
  /** Never overwrites: fails if the file exists. */
  write(path: string, text: string): Promise<void>;
  /** To the Recycle Bin, never a permanent delete. */
  recycle(path: string): Promise<void>;
};
export type AwayDeps = {
  /**
   * MU_HUB_ROLE=server: away mode drives a DESKTOP (the screen, windows, apps), and the server has none. When set, this
   * line is the answer to every way of turning it on, resuming it or queueing a task (the OS card, voice, Telegram), and
   * the runner never ticks: nothing can run, whoever asks. Unset elsewhere.
   */
  disabled?: string;
  store: StateStore;
  audit: AuditLog;
  sentinel: Sentinel;
  notify: Notifier;
  screen: ScreenPort;
  hermes: (prompt: string, signal: AbortSignal) => Promise<string>;
  cli: (recipe: CliRecipe, signal: AbortSignal) => Promise<{ ok: boolean; output: string }>;
  files: FilePort;
  launch: (app: string) => Promise<{ ok: boolean; said: string }>;
  ownerChat: () => string;
  home: string;
  now?: () => number;
  code?: () => string;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** TypeSafe Jev's API key, read fresh on each task (it can rotate) — rules-first fallback for a
   *  task classifyTask() alone would send to Hermes; see jev-fallback.ts. No key: rules only. */
  jevKey?: () => string;
  /** Fixed settings, or a function read on every use (the service re-reads its config file). */
  config?: Partial<AwayConfig> | (() => Partial<AwayConfig>);
  /**
   * The Hermes control admission (AUDIT F4 F6): the same code-owned 503 block that voice control_pc hits
   * (scripts/jarvis-execution/hermes-retention.ts). Production never passes this, so the real gate applies;
   * only synthetic tests with a fake Hermes may admit.
   */
  hermesAdmission?: () => { permitted: boolean; body?: { code?: string; error?: string } };
  /** The people in his chats (.operator-data/people.json): a line addressed to one of them isn't an order to Jarvis. */
  peopleNames?: () => string[];
};
export type AwayConfig = {
  /** How long an approval request waits for his code. */
  approvalTtlMs: number;
  /** The PC must have been idle this long (his real input) before tasks start. */
  armIdleMs: number;
  tickMs: number;
  /** How long a launched app gets to come to the front. */
  launchWaitMs: number;
  /**
   * away.payment (28 Sep owner policy): with this on, the owner's own task may pay a bill or invoice, buy,
   * subscribe or renew, donate (zakat, sadaqah) or pay a SAVED payee, each only after his one-time code for
   * that exact payment. Off by default: the owner switches it on in .operator-data/away-mode/config.json.
   */
  payments: boolean;
  /**
   * away.payment's allowlist (REVIEW-SAFETY-R4 finding 2): the sites a payment may happen on (his billers,
   * shops, charities, his bank), and the payees already saved at his bank that a transfer may go to. Empty:
   * nothing is approvable, whatever the task says.
   */
  paymentHosts: string[];
  savedPayees: string[];
};
export const DEFAULT_CONFIG: AwayConfig = { approvalTtlMs: 10 * 60_000, armIdleMs: 15_000, tickMs: 2_000, launchWaitMs: 10_000, payments: false, paymentHosts: [], savedPayees: [] };
/** A payment approval never waits longer than this, whatever approvalTtlMs says. */
export const PAYMENT_TTL_MS = 10 * 60_000;
const NEVER_PAYMENT: Record<PaymentNever, string> = {
  trade: "trades and investing orders",
  crypto: "crypto (buying, selling, swapping, sending, staking or minting)",
  betting: "betting, gambling and lotteries",
  "new-payee": "adding a new payee or paying to new bank details",
  "bank-transfer": "a bank transfer to a person (only a payee already saved in your bank or app can be approved)",
  "card-details": "typing a card number, CVV, bank password or one-time code (only saved payment methods)",
};
/** Confirmation words on the page after the press: a receipt, not a guess. */
const CONFIRMED = /\b(?:thank\s+you\s+for\s+your\s+(?:payment|order|purchase|donation|gift|zakat|sadaqah|renewal|subscription)|payment\s+(?:successful|received|complete(?:d)?|confirmed|approved|processed)|successfully\s+(?:paid|renewed|subscribed|donated|purchased)|order\s+(?:placed|confirmed)|(?:confirmation|reference|receipt|transaction|order)\s+(?:number|no\.?|id|#)|donation\s+(?:received|complete(?:d)?)|subscription\s+(?:active|confirmed|renewed)|(?:has|have)\s+been\s+(?:paid|renewed))\b/i;
const REFERENCE = /\b(?:reference|ref|receipt|confirmation|order|transaction)\s*(?:number|no\.?|#|id|code)?\s*[:#]?\s*((?=[A-Z-]*\d)[A-Z0-9][A-Z0-9-]{3,30})\b/i;

type Outcome =
  | { kind: "done"; result: string; shot?: string | null }
  | { kind: "failed"; result: string }
  | { kind: "refused"; result: string; confirm?: string }
  | { kind: "stopped"; result: string }
  | { kind: "locked"; step: number }
  | { kind: "approval"; action: string; confirm?: string; step: number; shot?: string | null; payment?: PaymentDetails };
type Approved = { step: number; confirm?: string; payment?: { digest: string } };
export type TelegramInbound = {
  platform: string;
  userId: string;
  chatId: string;
  chatType: string;
  text: string;
  /**
   * The verified sender (Stage B1 resolveTelegramPrincipal), set by the /__away/telegram relay after
   * the Hermes gateway proved itself with its bearer: a listed person's own DM, or null. When the
   * relay supplies it, it alone decides; there is no fallback owner id.
   */
  principal?: { personId: string; via: string } | null;
};

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const short = (t: AwayTask) => `#${t.id} ${clip(t.text, 60)}`;
const ACTIVE = new Set(["queued", "running", "awaiting_approval"]);

/** Hermes' brief while he's away: reversible only, no screen, and a line back when it must stop. */
export function awayHermesPrompt(task: string, approved?: string) {
  return [
    "Away mode (Jarvis, unattended): Usman is away from this PC and can't be asked anything. Do this task now:",
    task,
    "",
    "Hard rules:",
    "- Only reversible actions: read, list, download, copy, move or rename into folders, create new files, run local scripts that only write new files.",
    "- Do NOT delete, overwrite, send, post, submit, pay, buy, deploy, publish, install or uninstall anything, change any setting, sign in, or message anyone.",
    "- Never open banking or finance sites, password managers, credential stores or security settings. Never read .env files or tokens.",
    "- Don't use computer_use or drive the screen. Use the terminal, files and CLIs only.",
    "- If the task needs one of the forbidden actions, stop before it and reply with exactly one line: NEEDS_APPROVAL: <the single action you would take, with exact paths or names>.",
    "- If it can only be done by clicking on screen, reply with one line: NEEDS_SCREEN: <why>.",
    approved ? `- Usman approved exactly this one action with his one-time code, so you may do it once and nothing more like it: ${approved}` : "",
    "Otherwise finish the task and reply in at most three short lines: what you did and where the result is (full paths).",
  ]
    .filter(Boolean)
    .join("\n");
}

export function createAwayMode(deps: AwayDeps) {
  const settings = deps.config;
  const cfg = (): AwayConfig => ({ ...DEFAULT_CONFIG, ...((typeof settings === "function" ? settings() : settings) ?? {}) });
  const now = deps.now ?? Date.now;
  const iso = () => new Date(now()).toISOString();
  const sleep = deps.sleep ?? ((ms: number, signal?: AbortSignal) => new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
  }));
  const { store, audit, sentinel, screen, files } = deps;
  // F9: one-time codes are never written to disk; the state file holds an HMAC under this in-memory key.
  const codeKey = randomBytes(32);
  const hashCode = (code: string) => createHmac("sha256", codeKey).update(code.trim().toUpperCase()).digest("hex");
  let running: { taskId: number; controller: AbortController; screenStep: boolean } | null = null;
  let busy = false;
  /** An approved task is about to carry on: nothing else may start in between. */
  let resuming = false;
  let lastRealInput = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  let offInput: (() => void) | null = null;
  let closed = false;
  let lockedNow: boolean | null = null;

  const log = (entry: Parameters<AuditLog["write"]>[0]) => audit.write(entry);
  const tell = (text: string, image?: string | null) => {
    void deps.notify({ text, ...(image ? { image } : {}) }).then((r) => {
      if (!r.ok) log({ action: "telegram", result: `not sent: ${r.detail}` });
    });
  };
  const state = () => store.read();
  const task = (id: number) => state().tasks.find((t) => t.id === id);
  const queued = (s: AwayState = state()) => s.tasks.filter((t) => t.status === "queued");

  // --- the sentinel: his input, the lock ----------------------------------------------------------
  async function startSentinel() {
    const ok = await sentinel.start().catch(() => false);
    if (!ok) return false;
    offInput?.();
    offInput = sentinel.onInput((input) => {
      // Moves during a screen step may be Jarvis restoring his pointer; a click or key never is.
      if (input.kind === "move" && running?.screenStep) return;
      lastRealInput = input.at;
      const s = state();
      if (s.on && s.armed) void back(input.kind);
    });
    return true;
  }

  /** He touched the keyboard or mouse after being away: halt now, away mode off. */
  async function back(kind: string) {
    const s = state();
    if (!s.on) return;
    const current = running ? task(running.taskId) : null;
    halt();
    const pending = s.pending;
    store.update((st) => {
      st.on = false;
      st.armed = false;
      if (st.pending) {
        const t = st.tasks.find((x) => x.id === st.pending!.taskId);
        if (t) Object.assign(t, { status: "not_approved", endedAt: iso(), result: "Not approved: you came back to the PC first." });
        st.pending = null;
      }
    });
    log({ action: "back", result: `local ${kind} input: away mode off${current ? `, stopped #${current.id}` : ""}` });
    sentinel.stop();
    const left = queued().length;
    tell(
      [
        "You're back at the PC, so away mode is off.",
        current ? `Stopped ${short(current)}.` : "",
        pending ? `Cancelled the approval request for #${pending.taskId}.` : "",
        left ? `${left} task${left === 1 ? "" : "s"} still queued: /away on to carry on.` : "",
      ].filter(Boolean).join(" "),
    );
  }

  /** Abort whatever runs (between any two sub-steps) and stop screen-hands' loops and lessons. */
  function halt() {
    if (!running) return false;
    running.controller.abort();
    try {
      screen.stopAll();
    } catch {
      /* already stopped */
    }
    return true;
  }

  // --- the loop ---------------------------------------------------------------------------------------
  async function tick() {
    if (deps.disabled) return;
    if (busy || closed) return;
    busy = true;
    try {
      expireApproval();
      const s = state();
      if (!s.on || s.paused || s.pending || running || resuming) return;
      if (!s.armed) {
        if (now() - lastRealInput < cfg().armIdleMs) return;
        store.update((st) => void (st.armed = true));
        log({ action: "armed", result: `idle ${Math.round((now() - lastRealInput) / 1000)} s` });
        const n = queued().length;
        tell(`Away mode armed. ${n ? `Starting on ${n} task${n === 1 ? "" : "s"}.` : "Queue's empty: send /task <job>."}`);
      }
      const list = queued();
      if (!list.length) return;
      const locked = sentinel.running ? await sentinel.locked() : null;
      if (locked !== lockedNow) {
        if (locked !== null) log({ action: "lock", result: locked ? "PC is locked" : "PC is unlocked" });
        lockedNow = locked;
        if (!locked) store.update((st) => void delete st.lockedNoticeAt);
      }
      // The lock check awaited: an approval may have resumed a task meanwhile.
      if (resuming || running || state().pending || !state().on || state().paused) return;
      const next = locked ? list.find((t) => !needsScreen(t.plan)) : list[0];
      if (locked && list.some((t) => needsScreen(t.plan)) && !state().lockedNoticeAt) {
        store.update((st) => void (st.lockedNoticeAt = iso()));
        tell("PC is locked — can't do screen tasks; skill/CLI tasks still run.");
      }
      if (!next) return;
      await run(next.id);
    } finally {
      busy = false;
    }
  }

  function expireApproval() {
    const p = state().pending;
    if (!p || Date.parse(p.expiresAt) > now()) return;
    const t = task(p.taskId);
    store.update((st) => {
      st.pending = null;
      const x = st.tasks.find((y) => y.id === p.taskId);
      if (x) Object.assign(x, { status: "not_approved", endedAt: iso(), result: `Not approved (timed out): ${p.action}` });
    });
    log({ task: p.taskId, action: "approval", target: p.action, result: "timed out: not approved, nothing done" });
    tell(`Not approved (timed out): ${clip(p.action, 160)}. Nothing was done${t ? `; ${short(t)} is closed` : ""}.`);
  }

  async function run(id: number, approved?: Approved) {
    const t = task(id);
    if (!t) return;
    const controller = new AbortController();
    running = { taskId: id, controller, screenStep: false };
    store.update((st) => {
      const x = st.tasks.find((y) => y.id === id)!;
      x.status = "running";
      x.startedAt ??= iso();
    });
    if (!approved) {
      log({ task: id, action: "start", target: t.text, result: `route ${t.route}` });
      tell(`Started ${short(t)} (${t.route === "cli" ? "CLI" : t.route}).`);
    } else log({ task: id, action: "resume", target: t.text, result: `approved step ${approved.step}` });
    let outcome: Outcome;
    try {
      outcome = await execute(t, controller.signal, approved);
    } catch (error) {
      outcome = controller.signal.aborted ? { kind: "stopped", result: "Stopped." } : { kind: "failed", result: clip((error as Error).message || "It failed.", 300) };
    } finally {
      running = null;
    }
    // /stop wins the race (REVIEW-SAFETY-R3 §4): a reply that lands after the abort is recorded as stopped,
    // never announced as "Done" after "Stopped"; what came back is kept so he can check it.
    if (controller.signal.aborted && outcome.kind !== "stopped")
      outcome = { kind: "stopped", result: outcome.kind === "done" ? `Stopped. The step had already finished before the stop landed: ${clip(outcome.result, 300)} Check it before relying on it.` : "Stopped mid-task." };
    finish(id, outcome);
  }

  function finish(id: number, outcome: Outcome) {
    const t = task(id)!;
    if (outcome.kind === "approval") {
      const code = (deps.code ?? newCode)();
      const payment: PendingPayment | null = outcome.payment ? { ...outcome.payment, kind: paymentKindOf(t) ?? "payment", argsDigest: argsDigest(id, outcome.step, outcome.payment.digest) } : null;
      const ttl = payment ? Math.min(cfg().approvalTtlMs, PAYMENT_TTL_MS) : cfg().approvalTtlMs;
      const pending: PendingApproval = {
        codeHash: hashCode(code),
        taskId: id,
        action: outcome.action,
        ...(outcome.confirm ? { confirm: outcome.confirm } : {}),
        step: outcome.step,
        createdAt: iso(),
        expiresAt: new Date(now() + ttl).toISOString(),
        wrong: 0,
        ...(outcome.shot ? { shot: outcome.shot } : {}),
        ...(payment ? { payment } : {}),
      };
      store.update((st) => {
        st.pending = pending;
        const x = st.tasks.find((y) => y.id === id)!;
        x.status = "awaiting_approval";
        x.step = outcome.step;
      });
      log({ task: id, action: "approval", target: outcome.action, result: `asked, ${Math.round(ttl / 60_000)} min to answer`, ...(outcome.shot ? { shot: outcome.shot } : {}) });
      if (payment) {
        tell(
          [
            `PAYMENT approval needed for ${short(t)}:`,
            clip(outcome.action, 400),
            payment.url ? `Page: ${clip(payment.url, 160)}` : "",
            `Reply "yes ${code}" to allow THIS ONE payment, or "no ${code}". It expires in ${Math.round(ttl / 60_000)} min, and a different amount, payee, page or button cancels it.`,
          ].filter(Boolean).join("\n"),
          outcome.shot,
        );
        return;
      }
      tell(
        [
          `Approval needed for ${short(t)}:`,
          clip(outcome.action, 300),
          `Reply "yes ${code}" to allow it once, or "no ${code}". Nothing happens otherwise; this times out in ${Math.round(ttl / 60_000)} min.`,
          outcome.shot ? "" : "(No screen involved.)",
        ].filter(Boolean).join("\n"),
        outcome.shot,
      );
      return;
    }
    if (outcome.kind === "locked") {
      store.update((st) => {
        const x = st.tasks.find((y) => y.id === id)!;
        x.status = "queued";
        x.step = outcome.step;
      });
      log({ task: id, action: "lock", result: "PC locked mid-task: the screen task waits" });
      tell(`PC is locked — can't do screen tasks; skill/CLI tasks still run. ${short(t)} waits.`);
      return;
    }
    const status = outcome.kind === "done" ? "done" : outcome.kind === "refused" ? "refused" : outcome.kind === "stopped" ? "stopped" : "failed";
    store.update((st) => {
      const x = st.tasks.find((y) => y.id === id)!;
      Object.assign(x, { status, endedAt: iso(), result: clip(outcome.result, 800) });
    });
    log({ task: id, action: "end", target: t.text, result: `${status}: ${outcome.result}` });
    if (outcome.kind === "stopped") return; // /stop and "he's back" send their own line
    const word = outcome.kind === "done" ? "Done" : outcome.kind === "refused" ? "Refused" : "Failed";
    tell(`${word}: ${short(t)}\n${clip(outcome.result, 600)}`, outcome.kind === "done" ? outcome.shot : null);
  }

  // --- routes -------------------------------------------------------------------------------------------
  async function execute(t: AwayTask, signal: AbortSignal, approved?: Approved): Promise<Outcome> {
    const door = doorCheck(t.text);
    if ("refusal" in door) return { kind: "refused", result: `${door.refusal}. Nothing was done.` };
    const payKind = door.payKind;
    // "Delete that test file" queued before the file existed: resolve it now against the last file
    // an away task wrote, so it's the built-in (exactly known, step-gated) delete, not a Hermes job.
    let plan = t.plan;
    if (plan.route === "hermes" && !approved) {
      const again = classifyTask(t.text, state().lastPath);
      if (again.route !== "hermes") {
        plan = again;
        store.update((st) => Object.assign(st.tasks.find((y) => y.id === t.id)!, { plan: again, route: again.route }));
      }
    }
    // A payment runs only as screen steps he can see in the approval (Hermes never gets a money task).
    if (payKind && plan.route !== "screen")
      return { kind: "refused", result: "A payment runs only as screen steps I can show you before paying (e.g. \"open Chrome, click Pay now\"), never through Hermes. Nothing was done." };
    // Hermes (warm API, called directly, Stage 0 F1): the shared refusal and the control allowlist run
    // FIRST, before any code is asked for (REVIEW-SAFETY finding 5: he was asked for a code for a task
    // the allowlist then refused).
    if (plan.route === "hermes") {
      const offList = awayHermesRefusal(t.text);
      if (offList) {
        log({ task: t.id, action: "hermes", target: clip(t.text, 120), result: `refused before Hermes: ${offList}` });
        return { kind: "refused", result: `Not sent to Hermes while you're away: ${offList}. Nothing was done.` };
      }
      // Until Stage B's durable approvals: an approval through Hermes binds only to words, never to an
      // exact action, so ANY Hermes task that would need one (delete, publish, restart, book, cancel,
      // subscribe, accept…) is refused, never asked about or replayed.
      const why = approvalReason(t.text);
      if (why) return { kind: "refused", result: `Not done while you're away: it needs your approval (${why}), and an approval through Hermes can only bind to words, not an exact action. Stage B brings exact, approvable actions; until then do it yourself, or queue an exact step (e.g. "delete D:\\tmp\\x.txt"). Nothing was done.` };
    }
    // Screen tasks never press a final or money button unattended (REVIEW-SAFETY finding 1), so a task
    // whose words need an approval is refused up front rather than asked about.
    if (plan.route === "screen") {
      // (The payment itself is approved by code at the exact press; any OTHER irreversible word still refuses.)
      const why = approvalReason(
        payKind
          ? t.text
              .replace(/\b(?:send|give)\s+(?:my\s+|the\s+|our\s+|some\s+|a\s+)?(?:zakat|zakah|sadaqah|sadaqa|donation|payment|money|funds|fitrah|charity)\b/gi, "")
              .replace(/\b(?:pay\w*|subscri\w*|renew\w*|book\w*|submit\w*|accept\w*|agree\w*|donat\w*|purchase\w*|buy\w*|order\w*|check\s?out)\b/gi, "")
          : t.text,
      );
      if (why) return { kind: "refused", result: `Not done while you're away: ${why}, and final presses aren't made unattended (Stage B's durable approvals will re-enable exact ones). Nothing was done.` };
    }
    // CLI recipes (fixed argv) whose words are irreversible are asked about before anything runs
    // (file steps are gated one by one below, since each is known exactly).
    if (plan.route === "cli" && !approved) {
      const why = approvalReason(t.text);
      if (why) return { kind: "approval", action: `Run this task (${why}): ${t.text}`, step: -1 };
    }
    if (plan.route === "file") return fileTask(t, plan.ops, signal, approved);
    if (plan.route === "cli") {
      const r = await deps.cli(plan.recipe, signal);
      log({ task: t.id, action: "cli", target: plan.recipe.argv.join(" "), result: r.ok ? "ok" : "failed" });
      return r.ok ? { kind: "done", result: r.output || `${plan.recipe.name} finished.` } : { kind: "failed", result: r.output || `${plan.recipe.name} failed.` };
    }
    if (plan.route === "screen") return screenTask(t, plan.steps, signal, approved, payKind);
    // No approved prose is ever replayed to Hermes (F3 / REVIEW-SAFETY finding 5): Hermes gets the task
    // text only, under the away brief. (An old approval restored from before this change is ignored.)
    if (approved) return { kind: "refused", result: "Not done: an approval through Hermes can only bind to words, not an exact action, so it isn't replayed (until Stage B). Nothing was done." };
    // The same Hermes control block as voice control_pc (AUDIT F4 F6): until per-task transcript and
    // log suppression is verified, nothing is dispatched to Hermes from away mode either.
    const admission = (deps.hermesAdmission ?? hermesControlRetentionAdmission)();
    if (!admission.permitted) {
      log({ task: t.id, action: "hermes", target: clip(t.text, 120), result: `refused before Hermes: ${admission.body?.code ?? "control refused"}` });
      return { kind: "refused", result: `Not sent to Hermes while you're away: ${admission.body?.error ?? "Hermes control is unavailable. Nothing was dispatched."}` };
    }
    const text = (await deps.hermes(awayHermesPrompt(t.text), signal)).trim();
    log({ task: t.id, action: "hermes", target: clip(t.text, 120), result: clip(text, 300) });
    const ask = text.match(/NEEDS_APPROVAL:\s*(.+)/i);
    if (ask) {
      const action = ask[1].trim().slice(0, 300);
      const never2 = neverReason(action);
      if (never2) return { kind: "refused", result: `Hermes stopped before "${clip(action, 120)}", and that's never allowed while you're away (${never2}).` };
      // Any NEEDS_APPROVAL (money, delete, publish, account, restart, book, cancel, subscribe, accept…):
      // refused until Stage B, never asked about or replayed, because the approval would bind to prose.
      const bound = proseApprovalRefusal(action) ?? "that action";
      return { kind: "refused", result: `Hermes stopped before "${clip(action, 120)}". An approval for ${bound} through Hermes binds only to words, not an exact action, so I won't ask for it or replay it (until Stage B). Nothing was done.` };
    }
    const screenOnly = text.match(/NEEDS_SCREEN:\s*(.+)/i);
    if (screenOnly) return { kind: "failed", result: `This one needs clicking on screen (${clip(screenOnly[1], 160)}). Queue it as steps, e.g. "open Excel, click File, …".` };
    return { kind: "done", result: text || "Hermes finished without a report; check the result before relying on it." };
  }

  async function fileTask(t: AwayTask, ops: FileOp[], signal: AbortSignal, approved?: Approved): Promise<Outcome> {
    const done: string[] = [];
    for (let i = Math.max(0, t.step ?? 0); i < ops.length; i++) {
      if (signal.aborted) return { kind: "stopped", result: "Stopped." };
      const op = ops[i];
      if (!allowedPath(op.path, deps.home)) return { kind: "refused", result: `${op.path} is outside the folders away mode may touch (D:\\tmp, Desktop, Documents, Downloads).` };
      if (op.op === "mkdir") {
        await files.mkdir(op.path);
        log({ task: t.id, action: "mkdir", target: op.path, result: "ok" });
        done.push(`made ${op.path}`);
      } else if (op.op === "write") {
        if (files.exists(op.path)) return { kind: "refused", result: `${op.path} already exists; I won't overwrite it while you're away.` };
        await files.write(op.path, op.text);
        store.update((st) => void (st.lastPath = op.path));
        log({ task: t.id, action: "write", target: op.path, result: `ok (${op.text.length} chars)` });
        done.push(`wrote ${op.path}`);
      } else {
        if (!files.exists(op.path)) return { kind: "failed", result: `There's no file at ${op.path}.` };
        if (!(approved && approved.step === i)) return { kind: "approval", action: `Delete ${op.path} (to the Recycle Bin)`, step: i };
        await files.recycle(op.path);
        log({ task: t.id, action: "delete", target: op.path, result: "moved to the Recycle Bin (approved)" });
        done.push(`binned ${op.path}`);
      }
      store.update((st) => void (st.tasks.find((y) => y.id === t.id)!.step = i + 1));
    }
    return { kind: "done", result: done.length ? `${done.join("; ")}.` : "Nothing to do." };
  }

  // --- screen -------------------------------------------------------------------------------------------
  /** A masked, low-res screenshot of the window in front (or of `ring`'s neighbourhood). */
  async function shotOf(taskId: number, label: string, target?: string | null, payment = false): Promise<string | null> {
    if (!sentinel.running) return null;
    try {
      const win = await screen.foreground();
      // (A payment's own page is shown to him in the approval and the receipt, masked like every shot.)
      if (!win || deniedWindow(win) || (payment ? neverWindowBesidesMoney(win) : neverWindow(win))) return null;
      const snap = await screen.snapshot(win);
      const masks: Rect[] = snap.elements.filter((e) => secureField(e) || (e.value && sensitiveText(e.value))).map(rectOf);
      const ring = target ? pickElement(snap, target).element : null;
      const area = ring ? around(rectOf(ring), snap.window) : snap.window;
      const path = audit.shotPath(taskId, label);
      return (await sentinel.shot(path, area, masks, ring ? rectOf(ring) : null, ring ? 960 : 800)) ? path : null;
    } catch {
      return null;
    }
  }

  async function screenTask(t: AwayTask, steps: ScreenStep[], signal: AbortSignal, approved?: Approved, payKind: PaymentKind | null = null): Promise<Outcome> {
    if (!screen.flags().denylist) return { kind: "refused", result: "Screen tasks need screen-hands' deny-list switched on (JARVIS_SCREEN_DENYLIST or the flags file)." };
    let app: string | null = null;
    let lastShot: string | null = null;
    const did: string[] = [];
    const act = async (i: number, goal: string, confirm?: string, onlyWindow?: number): Promise<Outcome | null> => {
      if (signal.aborted) return { kind: "stopped", result: "Stopped." };
      if ((await sentinel.locked()) === true) return { kind: "locked", step: i };
      const front = await screen.foreground().catch(() => null);
      const off = deniedWindow(front) ?? (payKind ? neverWindowBesidesMoney(front) : neverWindow(front));
      if (off) return { kind: "refused", result: off };
      if (app && front && front.process.toLowerCase() !== app) return { kind: "failed", result: `Another window (${front.process}) came to the front, so I stopped rather than type into it.` };
      if (running) running.screenStep = true;
      let r: ScreenDone;
      try {
        // Nobody at the PC: screen-hands denies by default (navigation presses only, never on a money page).
        const payment = payKind ? { kind: payKind, hosts: cfg().paymentHosts, payees: cfg().savedPayees, ...(approved?.payment && approved.step === i ? { approved: { digest: approved.payment.digest } } : {}) } : undefined;
        r = await screen.act({ goal, unattended: true, ...(confirm ? { confirm } : {}), ...(onlyWindow ? { onlyWindow } : {}), ...(payment ? { payment } : {}) }, signal);
      } finally {
        if (running) running.screenStep = false;
      }
      // The approved payment was pressed (once): whatever else happened, capture the page and write the receipt.
      if (r.paid) return paidOutcome(t, i, r.paid, signal);
      if (r.stopped || signal.aborted) return { kind: "stopped", result: "Stopped." };
      // A money press on the owner's own payment task: stop and ask for his code for EXACTLY this payment.
      if (r.payment && payKind) {
        const shot = await shotOf(t.id, `pay-${i}`, r.payment.label, true);
        log({ task: t.id, action: "payment", target: describePayment(r.payment), result: r.payment.changed ? "changed since the approval: asked again" : "asked for approval" });
        return { kind: "approval", action: `${r.payment.changed ? "The page changed since your approval. " : ""}Pay ${describePayment(r.payment)}`, step: i, shot, payment: r.payment };
      }
      // No owner present: a final or money button is NEVER pressed (REVIEW-SAFETY finding 1). Screen-hands
      // refuses money buttons itself; any other final press it asks about is refused here, not offered
      // for a code. (The one exception, Enter on a Save dialog for a new file, is handled by the caller.)
      if (r.refused) return { kind: "refused", result: `${r.said} (screen step: ${clip(goal, 60)})` };
      if (r.confirm) {
        const verdict = buttonVerdict(r.confirm);
        const why = "never" in verdict ? verdict.never : "a final press, which is never made unattended (until Stage B)";
        return { kind: "refused", result: `It reached "${clip(r.confirm, 40)}", which is never pressed while you're away (${why}). Nothing was pressed.`, confirm: r.confirm };
      }
      // Keep the machine outcome in the existing persisted string; no state schema change.
      // Put it first so result/notification clipping cannot discard the outcome.
      const outcome = r.outcome ? `[screen outcome: ${r.outcome}] ` : "";
      if (r.ask) return { kind: "failed", result: `${outcome}It needs an answer I can't get while you're away: ${r.said}` };
      if (!r.ok) return { kind: "failed", result: `${outcome}${r.said || "The screen step didn't work."}` };
      const shot = await shotOf(t.id, `step-${i}`);
      if (shot) lastShot = shot;
      log({ task: t.id, action: "screen", target: goal, result: clip(r.said, 200), ...(shot ? { shot } : {}) });
      did.push(r.said.replace(/\.$/, ""));
      return null;
    };
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const resumeFrom = t.step ?? 0;
      // An app is always (re)opened; other steps before the resume point already ran.
      if (i < resumeFrom && step.kind !== "open") continue;
      if (signal.aborted) return { kind: "stopped", result: "Stopped." };
      if ((await sentinel.locked()) === true) return { kind: "locked", step: i };
      const confirm = approved && approved.step === i ? approved.confirm : undefined;
      if (step.kind === "open") {
        if (i < resumeFrom) {
          app = await frontProcess(step.app);
          continue;
        }
        const off = neverReason(step.app);
        if (off) return { kind: "refused", result: `Never while you're away: ${off}.` };
        const r = await deps.launch(step.app);
        log({ task: t.id, action: "open", target: step.app, result: r.said });
        if (!r.ok) return { kind: "failed", result: r.said };
        app = await waitForApp(step.app, signal);
        if (!app) return { kind: "failed", result: `${step.app} didn't come to the front.` };
        did.push(`opened ${step.app}`);
      } else if (step.kind === "wait") {
        await sleep(step.ms, signal);
      } else if (step.kind === "act") {
        const out = await act(i, step.goal, confirm);
        if (out) return out;
      } else {
        if (!allowedPath(step.path, deps.home)) return { kind: "refused", result: `${step.path} is outside the folders away mode may save to.` };
        if (files.exists(step.path)) return { kind: "refused", result: `${step.path} already exists; I won't overwrite it while you're away.` };
        // screen-hands won't type text that looks like a password, and a path mixing capitals,
        // digits and backslashes does: say so before opening a dialog it can't fill.
        if (sensitiveText(step.path)) return { kind: "failed", result: `Screen typing refuses ${step.path} (it looks like a password to the secret check). Use a folder and file name without digits.` };
        // Save As, then a check that the file really landed.
        let out = await act(i, "press ctrl+s", confirm);
        if (out) return out;
        // Keyboard only: when Save As opens, its name box has the focus with the default name
        // selected, so typing replaces it and Enter saves. (Win11 Notepad's dialog and its main
        // window trade the front while it opens, which trips a click's window check.)
        let dialog = false;
        // (screen-hands may report the dialog's owner window as the one in front, so this is a
        // best-effort wait; the check that the file landed below is what counts.)
        for (let w = 0; w < 8 && !dialog && !signal.aborted; w++) {
          await sleep(300, signal);
          const f = await screen.foreground().catch(() => null);
          dialog = !!f && /\bsave\b/i.test(f.title) && (!app || f.process.toLowerCase() === app);
        }
        await sleep(dialog ? 400 : 600, signal);
        out = await act(i, `type ${step.path}`, confirm);
        if (out) return out;
        out = await act(i, "press enter", confirm);
        // Enter in a form field asks for a yes. Here it only saves a NEW file in an allowed folder
        // (no overwrite was checked above), which can be deleted again: an exact action answered by
        // code, logged. The only confirm away mode ever supplies to screen-hands.
        if (out?.kind === "refused" && /^enter$/i.test(out.confirm ?? "") && !files.exists(step.path) && (await saveBoxFocused())) {
          log({ task: t.id, action: "screen", target: "Enter (Save)", result: "auto-confirmed: a new file in an allowed folder (no overwrite)" });
          out = await act(i, "press enter", "enter");
        }
        if (out) return out;
        await sleep(1200, signal);
        if (!files.exists(step.path)) return { kind: "failed", result: `I pressed Save but ${step.path} isn't there.` };
        store.update((st) => void (st.lastPath = step.path));
        did.push(`saved ${step.path}`);
      }
      store.update((st) => void (st.tasks.find((y) => y.id === t.id)!.step = i + 1));
    }
    return { kind: "done", result: did.length ? `${did.join("; ")}.` : "Done.", shot: lastShot };
  }

  /**
   * The Save dialog's own Enter (REVIEW-SAFETY-R3 §4): only when, looked at fresh, the focus is the File
   * name box of a window titled Save / Save As. A Delete, Publish or Send button that stole the focus never gets it.
   */
  async function saveBoxFocused(): Promise<boolean> {
    const front = await screen.foreground().catch(() => null);
    if (!front) return false;
    const snap = await screen.snapshot(front).catch(() => null);
    const focused = snap?.focused ?? snap?.elements.find((e) => e.focused) ?? null;
    return saveDialogEnter(focused, front.title);
  }

  /**
   * At the door (queueing) and again before running: the never list, or, with away.payment on, the owner's
   * OWN task words read for an approvable payment (never a page, email, message, file or Hermes reply).
   */
  function doorCheck(text: string): { refusal: string } | { payKind: PaymentKind | null } {
    const intent = cfg().payments ? paymentIntent(text) : null;
    if (intent && "never" in intent) return { refusal: `Never, even with your approval: ${NEVER_PAYMENT[intent.never]}` };
    const payKind: PaymentKind | null = intent && "approvable" in intent ? intent.approvable : null;
    const never = payKind ? neverReasonBesidesMoney(text) : neverReason(text);
    return never ? { refusal: `Never while you're away: ${never}` } : { payKind };
  }
  /** The payment kind of the owner's task (for the pending approval and the receipt). */
  function paymentKindOf(t: AwayTask): PaymentKind | null {
    const intent = paymentIntent(t.text);
    return intent && "approvable" in intent ? intent.approvable : null;
  }
  /** Binds the code to this task, this step and this exact payment. */
  function argsDigest(taskId: number, step: number, digest: string) {
    return createHash("sha256").update(`away.payment|${taskId}|${step}|${digest}`).digest("hex");
  }
  /**
   * After the ONE approved press: read the page for a confirmation, write a receipt and tell him. With no
   * confirmation the outcome is UNKNOWN: never pressed again, marked unknown, and he's told to check.
   */
  async function paidOutcome(t: AwayTask, i: number, paid: PaymentDetails, signal: AbortSignal): Promise<Outcome> {
    store.update((st) => void (st.tasks.find((y) => y.id === t.id)!.step = i + 1));
    await sleep(1500, signal);
    const front = await screen.foreground().catch(() => null);
    const snap = front ? await screen.snapshot(front).catch(() => null) : null;
    const text = [front?.title ?? "", ...(snap?.elements ?? []).filter((e) => ["Text", "Pane", "Window", "Document", "Group"].includes(e.type)).map((e) => e.name)].join("\n").slice(0, 4000);
    // Confirmed only when the page SAYS so and the pay button is gone (a bill page's "last paid" isn't a receipt).
    const stillThere = (snap?.elements ?? []).some((e) => e.enabled && e.name.trim().toLowerCase() === paid.label.trim().toLowerCase() && !["Text", "Pane", "Document"].includes(e.type));
    const confirmed = CONFIRMED.test(text) && !stillThere;
    const reference = text.match(REFERENCE)?.[1] ?? null;
    const shot = await shotOf(t.id, "receipt", null, true);
    const receipt = { ts: iso(), task: t.id, kind: paymentKindOf(t) ?? "payment", amount: paid.amount, currency: paid.currency, payee: paid.payee, host: paid.host, reference, outcome: confirmed ? ("confirmed" as const) : ("unknown" as const), ...(shot ? { shot } : {}) };
    const saved = audit.receipt ? audit.receipt(receipt) : false;
    log({ task: t.id, action: "payment", target: describePayment(paid), result: `${confirmed ? "paid" : "OUTCOME UNKNOWN"}${reference ? ` (ref ${reference})` : ""}${saved ? "; receipt written" : ""}`, ...(shot ? { shot } : {}) });
    if (!confirmed)
      return { kind: "failed", result: `Payment outcome UNKNOWN: I pressed "${paid.label}" once for ${describePayment(paid)} and couldn't see a confirmation. I won't press it again. Check ${paid.host ?? "the account"} yourself.` };
    return { kind: "done", result: `Paid ${describePayment(paid)} at ${new Date(now()).toLocaleTimeString("en-AU", { timeZone: "Australia/Sydney", hour: "2-digit", minute: "2-digit" })}${reference ? `, reference ${reference}` : ""}. Receipt saved.`, shot };
  }

  const appKey = (app: string) => app.toLowerCase().replace(/\.exe$/, "").replace(/[^a-z0-9]/g, "");
  async function frontProcess(app: string) {
    const f = await screen.foreground().catch(() => null);
    return f && (appKey(f.process).includes(appKey(app)) || appKey(f.title).includes(appKey(app))) ? f.process.toLowerCase() : null;
  }
  async function waitForApp(app: string, signal: AbortSignal) {
    const started = now();
    const until = started + cfg().launchWaitMs;
    let focused = false;
    while (now() < until && !signal.aborted) {
      const p = await frontProcess(app);
      if (p) return p;
      // Windows keeps a window opened from a background process behind the one in front: after a
      // moment, bring the newly opened app's window forward (never any other app's).
      if (!focused && now() - started >= 1500 && screen.windows && screen.focus) {
        const win = (await screen.windows().catch(() => [])).find((w) => appKey(w.process) === appKey(app) || appKey(w.process).includes(appKey(app)));
        if (win && !deniedWindow(win) && !neverWindow(win)) focused = await screen.focus(win.handle).catch(() => false);
      }
      await sleep(400, signal);
    }
    return null;
  }

  // --- commands ---------------------------------------------------------------------------------------
  async function turnOn(from: TaskSource) {
    if (deps.disabled) return deps.disabled;
    const s = state();
    if (s.on) return `Away mode is already on${s.armed ? " and armed" : ""}. ${queueLine()}`;
    const sentinelOk = await startSentinel();
    const idle = sentinelOk ? await sentinel.idleMs() : null;
    lastRealInput = now() - (idle ?? (from === "telegram" ? cfg().armIdleMs : 0));
    store.update((st) => {
      st.on = true;
      st.armed = false;
      st.paused = false;
      st.since = iso();
      delete st.lockedNoticeAt;
    });
    log({ action: "on", result: `from ${from}${sentinelOk ? "" : " (sentinel unavailable: no lock or input detection)"}` });
    ensureTimer();
    void tick();
    const armedSoon = now() - lastRealInput >= cfg().armIdleMs;
    return [
      `Away mode on.`,
      armedSoon ? "" : `I'll start once the PC has been idle ${Math.round(cfg().armIdleMs / 1000)} s; any key or mouse after that switches it off.`,
      sentinelOk ? "" : "Warning: I can't watch the keyboard, mouse or lock screen, so screen tasks won't run.",
      queueLine(),
    ].filter(Boolean).join(" ");
  }

  function turnOff(from: string) {
    // A copy: the store updates its state object in place.
    const wasOn = state().on;
    const stopped = halt();
    store.update((st) => {
      st.on = false;
      st.armed = false;
      if (st.pending) {
        const t = st.tasks.find((x) => x.id === st.pending!.taskId);
        if (t) Object.assign(t, { status: "not_approved", endedAt: iso(), result: "Not approved: away mode was switched off." });
        st.pending = null;
      }
    });
    sentinel.stop();
    log({ action: "off", result: `from ${from}${stopped ? " (stopped the running task)" : ""}` });
    return wasOn ? `Away mode off.${stopped ? " Stopped the task that was running." : ""} ${queueLine()}` : `Away mode was already off. ${queueLine()}`;
  }

  /**
   * The kill switch. Honest limits (REVIEW-SAFETY finding 5): screen steps and CLI recipes stop at once
   * (screen-hands aborts between sub-steps; CLI recipes end with taskkill /t /f). A Hermes job does NOT:
   * away mode reaches Hermes through its warm gateway, and aborting that HTTP request doesn't cancel the
   * agent's tools already running on the gateway. That is why the away brief allows only reversible
   * actions, and why Stage B moves away execution to exact actions run by our own executor.
   */
  function stop(from: string) {
    const current = running ? task(running.taskId) : null;
    const hermesRunning = !!current && current.route === "hermes" && !!running;
    const halted = halt();
    const pending = state().pending;
    store.update((st) => {
      st.paused = true;
      if (st.pending) {
        const t = st.tasks.find((x) => x.id === st.pending!.taskId);
        if (t) Object.assign(t, { status: "not_approved", endedAt: iso(), result: "Not approved: stopped." });
        st.pending = null;
      }
    });
    try {
      screen.stopAll();
    } catch {
      /* nothing running */
    }
    log({ action: "stop", result: `kill switch from ${from}${halted ? `: halted #${current?.id}` : ""}` });
    return [
      halted && current ? `Stopped ${short(current)}.` : "Nothing was running.",
      hermesRunning ? "Hermes may still finish the step it had started: I can't cancel a job already on its gateway (only reversible steps are allowed there)." : "",
      pending ? `Cancelled the approval for #${pending.taskId}.` : "",
      "The queue is paused: /away resume to carry on.",
    ].filter(Boolean).join(" ");
  }

  function resume() {
    if (deps.disabled) return deps.disabled;
    store.update((st) => void (st.paused = false));
    log({ action: "resume", result: "queue resumed" });
    void tick();
    return `Resumed. ${state().on ? "" : "Away mode is off: /away on to start. "}${queueLine()}`;
  }

  async function addTask(text: string, from: TaskSource): Promise<{ ok: boolean; id?: number; said: string }> {
    if (deps.disabled) return { ok: false, said: deps.disabled };
    const clean = text.trim().slice(0, 600);
    if (clean.length < 3) return { ok: false, said: "What should I do? e.g. /task tidy Downloads" };
    const s = state();
    const key = deps.jevKey?.() || "";
    const jev: Jev | null = key ? { key } : null;
    const plan = await classifyTaskWithJevFallback(clean, s.lastPath, jev);
    const door = doorCheck(clean);
    const never = "refusal" in door ? door.refusal : null;
    const id = s.nextId;
    const t: AwayTask = { id, text: clean, route: plan.route, plan, from, status: never ? "refused" : "queued", createdAt: iso(), ...(never ? { endedAt: iso(), result: `${never}.` } : {}) };
    store.update((st) => {
      st.nextId = id + 1;
      st.tasks.push(t);
    });
    log({ task: id, action: "queue", target: clean, result: never ? `refused: ${never}` : `queued (${plan.route}) from ${from}` });
    if (never) return { ok: false, said: `I won't do that. ${never}. #${id} not queued.` };
    const gate = plan.route === "file" ? (plan.ops.some((o) => o.op === "delete") ? "the delete needs your code" : "") : approvalReason(clean) ? "needs your code before it starts" : "";
    void tick();
    return { ok: true, id, said: `Queued #${id} (${plan.route === "cli" ? "CLI" : plan.route}${gate ? `; ${gate}` : ""}).${state().on ? "" : " Away mode is off: /away on to start."}` };
  }

  function cancel(id: number) {
    const t = task(id);
    if (!t || t.status !== "queued") return `#${id} isn't waiting in the queue.`;
    store.update((st) => Object.assign(st.tasks.find((x) => x.id === id)!, { status: "cancelled", endedAt: iso(), result: "Cancelled." }));
    log({ task: id, action: "cancel", result: "cancelled" });
    return `Cancelled ${short(t)}.`;
  }

  /** "yes CODE" / "no CODE". Only his own chat, only the live code, only before it expires. */
  function answer(yes: boolean, code: string, sender: { owner: boolean; chat: string }) {
    expireApproval();
    const p = state().pending;
    if (!sender.owner) {
      log({ action: "approval", target: `chat ${sender.chat}`, result: `refused: not the owner's chat (a ${yes ? "yes" : "no"} with a code)` });
      return "Only Usman's own chat can answer away-mode approvals. Nothing was done.";
    }
    if (!p) return "Nothing is waiting for approval (it may have timed out). Nothing was done.";
    if (!p.codeHash || !sameCode(hashCode(code), p.codeHash)) {
      const wrong = p.wrong + 1;
      if (wrong >= 3) {
        store.update((st) => {
          st.pending = null;
          const x = st.tasks.find((y) => y.id === p.taskId);
          if (x) Object.assign(x, { status: "not_approved", endedAt: iso(), result: "Not approved: three wrong codes." });
        });
        log({ task: p.taskId, action: "approval", target: p.action, result: "three wrong codes: not approved, nothing done" });
        return "Three wrong codes, so that request is cancelled. Nothing was done.";
      }
      store.update((st) => void (st.pending && (st.pending.wrong = wrong)));
      log({ task: p.taskId, action: "approval", result: `wrong code (${wrong}/3)` });
      return "That code doesn't match the request. Nothing was done.";
    }
    store.update((st) => void (st.pending = null));
    if (!yes) {
      store.update((st) => {
        const x = st.tasks.find((y) => y.id === p.taskId);
        if (x) Object.assign(x, { status: "not_approved", endedAt: iso(), result: `Not approved (you said no): ${p.action}` });
      });
      log({ task: p.taskId, action: "approval", target: p.action, result: "denied: nothing done" });
      return `OK, not doing it. ${clip(p.action, 120)} was skipped.`;
    }
    log({ task: p.taskId, action: "approval", target: p.action, result: "approved from the owner's chat" });
    if (p.payment && p.payment.argsDigest !== argsDigest(p.taskId, p.step ?? 0, p.payment.digest)) {
      log({ task: p.taskId, action: "approval", target: p.action, result: "refused: the payment binding didn't verify; nothing done" });
      return "That approval doesn't match its payment any more, so nothing was done.";
    }
    const approved: Approved = { step: p.step ?? 0, ...(p.confirm ? { confirm: p.confirm } : {}), ...(p.payment ? { payment: { digest: p.payment.digest } } : {}) };
    resuming = true;
    void (async () => {
      while (busy || running) await sleep(100);
      busy = true;
      try {
        await run(p.taskId, approved);
      } finally {
        busy = false;
        resuming = false;
      }
      void tick();
    })();
    return `Approved once: ${clip(p.action, 140)}. Carrying on.`;
  }

  // --- reporting ---------------------------------------------------------------------------------------
  function queueLine() {
    const q = queued();
    return q.length ? `Queue: ${q.map((t) => `#${t.id}`).join(", ")}.` : "Queue's empty.";
  }
  function status() {
    const s = state();
    return {
      on: s.on,
      armed: s.armed,
      paused: s.paused,
      since: s.since ?? null,
      locked: lockedNow,
      watching: sentinel.running,
      running: running ? running.taskId : null,
      pending: s.pending
        ? {
            taskId: s.pending.taskId,
            action: s.pending.action,
            expiresAt: s.pending.expiresAt,
            // The OS card shows the exact payment too (never the code).
            ...(s.pending.payment ? { payment: { kind: s.pending.payment.kind, payee: s.pending.payment.payee, host: s.pending.payment.host, amount: s.pending.payment.amount, currency: s.pending.payment.currency, label: s.pending.payment.label, last4: s.pending.payment.last4 } } : {}),
          }
        : null,
      tasks: s.tasks.slice(-25).map(({ plan, ...t }) => t),
      config: { approvalTtlMs: cfg().approvalTtlMs, armIdleMs: cfg().armIdleMs },
    };
  }
  function statusText() {
    const s = state();
    const lines = [
      `Away mode: ${s.on ? (s.armed ? "ON (armed)" : "ON (waiting for the PC to go idle)") : "off"}${s.paused ? " · paused" : ""}${lockedNow === true ? " · PC locked" : lockedNow === false ? " · PC unlocked" : ""}`,
    ];
    const run = running ? task(running.taskId) : null;
    if (run) lines.push(`Running: ${short(run)} (${run.route})`);
    if (s.pending) {
      const t = task(s.pending.taskId);
      const mins = Math.max(0, Math.ceil((Date.parse(s.pending.expiresAt) - now()) / 60_000));
      lines.push(`Waiting for your code: ${t ? short(t) : `#${s.pending.taskId}`}: ${clip(s.pending.action, 100)} (${mins} min left)`);
    }
    const q = queued(s);
    lines.push(q.length ? `Queued: ${q.map((t) => `${short(t)} (${t.route})`).join("; ")}` : "Queue's empty.");
    const recent = s.tasks.filter((t) => !ACTIVE.has(t.status)).slice(-3);
    if (recent.length) lines.push(`Recent: ${recent.map((t) => `#${t.id} ${t.status.replace("_", " ")}`).join(", ")}`);
    return lines.join("\n");
  }
  function logText(n: number) {
    const entries = audit.tail(n);
    if (!entries.length) return "The away log is empty.";
    return entries
      .map((e) => `${new Date(e.ts).toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, timeZone: "Australia/Sydney" })} ${e.task ? `#${e.task} ` : ""}${e.action}${e.target ? ` ${clip(e.target, 50)}` : ""} → ${clip(e.result, 90)}`)
      .join("\n");
  }

  /** His Telegram message (via the Hermes plugin): handled here, or null to let Hermes answer it. */
  async function telegram(msg: TelegramInbound): Promise<{ handled: boolean; reply: string | null }> {
    if (msg.platform !== "telegram") return { handled: false, reply: null };
    const cmd = parseTelegram(msg.text);
    if (!cmd) {
      // Free text is Hermes' to answer, money QUESTIONS included ("what did I spend", "how do I pay a BPAY
      // bill"). A money ORDER is refused here in code, from anyone's chat (REVIEW S2d-1): Hermes' Telegram tools
      // (browser on Jarvis Chrome, computer_use) have no money gate of their own, and a typed chat yes isn't the
      // owner's spoken yes. The longer-term fix is a Hermes pre_tool_call hook that runs the OS money checks on
      // every browser/computer_use action (docs/AWAY-MODE-MONEY.md). Away tasks keep their own door check below.
      if (!chatMoneyOrder(msg.text, deps.peopleNames?.() ?? [])) return { handled: false, reply: null };
      log({ action: "telegram", target: `chat ${msg.chatId}`, result: "refused before Hermes: a money order in free text" });
      return { handled: true, reply: CHAT_MONEY_REFUSAL };
    }
    // Away mode runs on the hub (Usman's PC), so its orders and approvals are the hub owner's. From the
    // relay, the verified Telegram principal decides; the legacy chat-id check is only for callers that
    // don't pass one (tests, older wiring).
    const owner = deps.ownerChat();
    const isOwner =
      "principal" in msg
        ? msg.principal?.via === "telegram-owner" && msg.principal.personId === "usman"
        : /^\d{5,15}$/.test(owner) && msg.userId === owner && msg.chatId === owner && msg.chatType === "dm";
    if (cmd.cmd === "approve" || cmd.cmd === "deny") return { handled: true, reply: answer(cmd.cmd === "approve", cmd.code, { owner: isOwner, chat: msg.chatId }) };
    if (!isOwner) {
      log({ action: "telegram", target: `chat ${msg.chatId}`, result: `ignored /${cmd.cmd}: not the owner's chat` });
      return { handled: true, reply: msg.chatType === "dm" ? "Away mode only takes orders from Usman's own chat." : null };
    }
    log({ action: "telegram", result: `/${cmd.cmd}` });
    switch (cmd.cmd) {
      case "on":
        return { handled: true, reply: await turnOn("telegram") };
      case "off":
        return { handled: true, reply: turnOff("telegram") };
      case "stop":
        return { handled: true, reply: stop("telegram") };
      case "resume":
        return { handled: true, reply: resume() };
      case "status":
        return { handled: true, reply: statusText() };
      case "log":
        return { handled: true, reply: logText(cmd.n) };
      case "task":
        return { handled: true, reply: (await addTask(cmd.text, "telegram")).said };
      case "cancel":
        return { handled: true, reply: cancel(cmd.id) };
      default:
        return { handled: true, reply: TELEGRAM_HELP };
    }
  }

  /** The voice intent's action: the line Jarvis says. */
  async function voice(intent: AwayVoice): Promise<string> {
    if ("task" in intent) return (await addTask(intent.task, "voice")).said;
    if ("status" in intent) return statusText().split("\n").slice(0, 3).join(". ");
    return intent.on ? turnOn("voice") : turnOff("voice");
  }

  function ensureTimer() {
    if (timer || closed) return;
    timer = setInterval(() => void tick(), cfg().tickMs);
    timer.unref?.();
  }

  /** Start-up: tasks cut off by a restart are closed (never silently re-run); an on-state resumes watching. */
  async function start() {
    if (deps.disabled) {
      // A state file carried over from a PC (away mode on, a queue) must not run here: disarm it and never tick.
      store.update((st) => {
        st.on = false;
        st.armed = false;
      });
      log({ action: "disabled", result: "away mode is off on the server: it drives a desktop" });
      return;
    }
    const cut = state().tasks.filter((t) => t.status === "running" || t.status === "awaiting_approval");
    const pending = state().pending;
    if (store.recover(iso())) {
      log({ action: "recover", result: "closed tasks interrupted by a restart" });
      if (cut.length || pending)
        tell(`The OS restarted, so I closed ${cut.map(short).join("; ") || "the task in progress"} without finishing it${pending ? ` (the approval for #${pending.taskId} no longer counts)` : ""}. Nothing more was done; queue it again if you still want it.`);
    }
    try {
      audit.prune();
    } catch {
      /* D: missing */
    }
    if (state().on) {
      await startSentinel();
      lastRealInput = now() - ((await sentinel.idleMs()) ?? 0);
      store.update((st) => void (st.armed = false));
      ensureTimer();
    }
  }

  return {
    start,
    turnOn,
    turnOff,
    stop,
    resume,
    addTask,
    cancel,
    answer,
    telegram,
    voice,
    status,
    statusText,
    logText,
    tick,
    /** For tests: pretend his last real input was at `at`. */
    _input(at: number) {
      lastRealInput = at;
    },
    get running() {
      return running?.taskId ?? null;
    },
    /** A tick or an approved task is in progress. */
    get busy() {
      return busy || resuming;
    },
    close() {
      closed = true;
      if (timer) clearInterval(timer);
      timer = null;
      halt();
      offInput?.();
      sentinel.stop();
    },
  };
}
export type AwayMode = ReturnType<typeof createAwayMode>;

const rectOf = (e: Pick<UiElement, "x" | "y" | "w" | "h">): Rect => ({ x: e.x, y: e.y, w: e.w, h: e.h });
/** About 1100×700 around the target, inside the window: enough context to see what it is. */
function around(target: Rect, win: Rect): Rect {
  const w = Math.min(win.w, 1100);
  const h = Math.min(win.h, 700);
  const x = Math.min(Math.max(win.x, target.x + target.w / 2 - w / 2), win.x + win.w - w);
  const y = Math.min(Math.max(win.y, target.y + target.h / 2 - h / 2), win.y + win.h - h);
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
}
