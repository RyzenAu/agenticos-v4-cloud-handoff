// Desk payments (P1, 29 Sep 2026). At his desk a payment request is UNDERSTOOD, shown ONCE on a confirm card (payee,
// exact amount, site, what for), and DONE through the browser hands while he watches, once he clicks Confirm or says
// yes. Away mode keeps its own stricter rules (scripts/away-mode, unchanged).
//
//   request  his words → page read in Jarvis Chrome → ONE exact payment → a pending payment (nothing pressed)
//   confirm  his click or his yes (with the turn's one-time ticket) → the page read AGAIN → same payment? → ONE press
//            of the ONE bound control → the page read for a confirmation → a receipt line either way
//   cancel   his no, the card's Cancel, or 2 minutes
//
// What can start a payment: only his own words at the desk (spoken or typed): the voice turn's rules, the typed command
// entry, and the screen/control lanes when THEIR words were his. A model's tool call never can (free-voice guardToolCall
// rebuilds it from his last words or drops it), and nothing on a page, in an email or in a file reaches this module.
// Never, even here: trades and investing, crypto, betting, and Jarvis typing a card number, code or password (he types
// those; Jarvis stops at the field and says so). No amount cap: the amount is shown big and re-checked at the press.
import { createHash } from "node:crypto";
import { confirmationReply } from "../../src/lib/jarvis-control";
import { listedMoneyHostKind, registrableDomain } from "../../src/lib/money-policy";
import { spokenConfirmations } from "../jarvis-execution/voice-confirmation";
import { aiUsageIntent } from "../ai-usage/jarvis-intent";
import type { BrowserHands } from "../j2/agent-browser";
import type { PaymentReceipt } from "../away-mode/store";
import type { Principal } from "../identity/principal";
import { scrub } from "../away-mode/store";
import { analyseDeskPage, diffPayment, payCandidates, type DeskAnalysis, type SnapshotRef } from "./page";
import { deskMoneyOrder, deskOpenOrder, deskPayOrder, formatMoney, parseDeskRequest, payeeFits, spokenMoney, type DeskConfig, type DeskRequest } from "./request";
import { deskOpenVerdict, deskVerdict, NOT_DESK_LINE, type DeskVerdict } from "./policy";
import { createDeskStore, publicView, type DeskStore, type PaymentSource, type PendingPayment, type PublicPayment } from "./store";

export type DeskHands = Pick<BrowserHands, "active" | "snapshot" | "readDesk" | "namesOf" | "openDesk" | "activate" | "pressBound">;
export type DeskDeps = {
  /** Jarvis Chrome's hands (agent-browser), or null when they aren't installed. */
  hands: () => Promise<DeskHands | null>;
  /** Start Jarvis Chrome when it isn't running; true when its DevTools port answers. */
  ensure?: () => Promise<boolean>;
  /** Bring Jarvis Chrome forward on his main screen, so he watches. */
  present?: () => Promise<string | null>;
  /** Where receipt lines go (away mode's receipts/receipts.jsonl). A false answer means it couldn't be written. */
  receipts: { write(entry: PaymentReceipt): boolean };
  /** Is away mode on? null when it can't be read (then it is not the desk). */
  awayOn: () => boolean | null;
  /** Is he at the PC? The last local input and whether the screen is locked (null = unknown). Unknown does not block; a locked or long-idle PC does. */
  presence?: () => { locked: boolean | null; idleMs: number | null } | null;
  /** The most idle time (ms) that still counts as at the desk (default 30 minutes). */
  idleLimitMs?: number;
  /**
   * Only start a payment from words he was heard to say in the last 90 s (the voice turn and the typed box record them):
   * a model's tool call, a page's text or a script's request that isn't his words creates nothing. Default true.
   */
  requireHeard?: boolean;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  config?: () => DeskConfig;
  ttlMs?: number;
  /** Wait after opening a page, and before reading the outcome of a press (tests: 0). */
  settleMs?: number;
  afterPressMs?: number;
  log?: (line: string) => void;
};
export type DeskCtx = { desk: DeskVerdict; source?: PaymentSource };
export type DeskResult = { ok: boolean; said: string; pending?: PublicPayment; refused?: boolean; asks?: boolean };
export type DeskTurn = { call: Record<string, unknown> } | { say: string; /** A never line (a trade, crypto, a bet, card details). */ refused?: boolean; /** A one-line question back. */ ask?: boolean } | null;

const CONFIRMED_TEXT = /\b(?:payment\s+(?:successful|complete(?:d)?|received|confirmed|made)|(?:thank|thanks)\s+(?:you\s+)?for\s+your\s+(?:payment|order|purchase|donation|contribution)|order\s+(?:confirmed|complete|placed|received)|donation\s+(?:received|complete|successful)|receipt\s+(?:number|no\b|#)|paid\s+in\s+full|you(?:'ve| have)\s+paid)\b/i;
const REFERENCE = /\b(?:reference|receipt|confirmation|order|transaction|payment)\s*(?:number|no\.?|#|id|code)?\s*[:#]?\s*((?=[A-Z0-9-]*\d)[A-Z0-9][A-Z0-9-]{5,})/i;
const NO_HANDS = "My browser hands aren't installed on this PC, so I can't do that. Nothing was paid.";
const hostOf = (url: string | null | undefined) => {
  try {
    return url ? new URL(url).hostname.toLowerCase().replace(/^www\./, "") : "";
  } catch {
    return "";
  }
};
const reg = (host: string) => registrableDomain(host) ?? host;

export function createDeskPayments(deps: DeskDeps) {
  const clock = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const store: DeskStore = createDeskStore({ ttlMs: deps.ttlMs, now: clock });
  const config = () => deps.config?.() ?? {};
  const log = (line: string) => deps.log?.(line);
  /** One thing at a time: a request or a press while another is running waits its turn by refusing politely. */
  let busy = false;
  async function serial<T>(work: () => Promise<T>, busyResult: T): Promise<T> {
    if (busy) return busyResult;
    busy = true;
    try {
      return await work();
    } finally {
      busy = false;
    }
  }
  const BUSY: DeskResult = { ok: false, said: "I'm in the middle of another payment step; say it again in a moment." };

  // --- what he was heard to say (provenance of a request) ---------------------------------------------------------------
  const HEARD_MS = 90_000;
  const heardWords = new Map<string, number>();
  const wordsKey = (text: string) =>
    String(text ?? "").normalize("NFKC").toLowerCase().replace(/^\s*(?:(?:uh+|um+|umm+|er+m?|hmm+|ah+)[,\s]+)+/, "").replace(/[^\p{L}\p{N}$]+/gu, " ").trim().slice(0, 600);
  /** Record words he said or typed (the voice turn and the typed box call this before anything else reads them). */
  function heard(text: string) {
    const now = clock();
    for (const [k, at] of heardWords) if (now - at > HEARD_MS) heardWords.delete(k);
    const key = wordsKey(text);
    if (key) heardWords.set(key, now);
    while (heardWords.size > 40) heardWords.delete(heardWords.keys().next().value!);
  }
  const wasHeard = (text: string) => {
    const at = heardWords.get(wordsKey(text));
    return at !== undefined && clock() - at <= HEARD_MS;
  };
  /** The typed box's count of commands: a newer typed command supersedes a payment asked in an earlier one. */
  let typedEpoch = 0;

  // --- reading the page --------------------------------------------------------------------------------------------
  /** The page in front, read until it has finished loading (a few tries), with the controls and their names. */
  async function readAnalysis(hands: DeskHands): Promise<{ analysis: DeskAnalysis; targetId: string | null; refs: SnapshotRef[]; tab: { targetId: string; url: string } | null; pageHash: string; pageTitle: string }> {
    const tab = await hands.active().catch(() => null);
    let page = await hands.readDesk().catch(() => null);
    for (let i = 0; i < 5 && page && !page.ready; i++) {
      await sleep(deps.settleMs === 0 ? 0 : 400);
      page = await hands.readDesk().catch(() => null);
    }
    if (!page) return { analysis: { ok: false, kind: "unreadable", said: "I couldn't read the page in Jarvis Chrome, so nothing was set up." }, targetId: tab?.targetId ?? null, refs: [], tab: null, pageHash: "", pageTitle: "" };
    const refs = await hands.snapshot().catch(() => [] as SnapshotRef[]);
    const names = new Map<string, string[]>();
    for (const c of payCandidates(refs, page.text)) {
      const n = await hands.namesOf(c.ref).catch(() => null);
      if (n) names.set(c.ref, [c.name, ...n.all]);
    }
    return { analysis: analyseDeskPage({ page, refs, names }), targetId: tab?.targetId ?? null, refs, tab: tab ? { targetId: tab.targetId, url: tab.url } : null, pageHash: createHash("sha256").update(page.text).digest("hex"), pageTitle: page.title };
  }

  // --- a request ---------------------------------------------------------------------------------------------------
  async function request(text: string, ctx: DeskCtx): Promise<DeskResult> {
    if (!ctx.desk.ok) return { ok: false, said: NOT_DESK_LINE, refused: true };
    // Only his own words start a payment: text a model, a page or a script supplied that he wasn't heard to say creates nothing.
    if (deps.requireHeard !== false && !wasHeard(text)) return { ok: false, said: "I only set up a payment from your own words. Say it and I will.", refused: true };
    const parsed = parseDeskRequest(text, config());
    if (!parsed) return { ok: false, said: "Who and how much?", asks: true };
    if (!parsed.ok) return { ok: false, said: parsed.said, refused: "never" in parsed, asks: "ask" in parsed };
    if (parsed.request.vague && !(await hasPagePayingContext())) return { ok: false, said: "Who and how much?", asks: true };
    return serial(() => prepare(parsed.request, ctx), BUSY);
  }
  /** "pay the bill" with a payment page already in front: that page. Without one, nothing says what to pay. */
  async function hasPagePayingContext(): Promise<boolean> {
    const hands = await deps.hands().catch(() => null);
    if (!hands) return false;
    return !!(await hands.active().catch(() => null));
  }

  async function prepare(req: DeskRequest, ctx: DeskCtx): Promise<DeskResult> {
    const hands = await deps.hands();
    if (!hands) return { ok: false, said: NO_HANDS };
    let opened = false;
    let tab = await hands.active().catch(() => null);
    let peeked: Awaited<ReturnType<typeof readAnalysis>> | null = null;
    if (req.host) {
      const there = tab && reg(hostOf(tab.url)) === req.host;
      // Already on a payment page that pays what he named (his bank's pay step for "the Telstra bill")? That page, not a new tab.
      if (!there && tab) {
        const peek = await readAnalysis(hands);
        // (Only when he named a payee, the page pays it, AND the page is a real bank, payment or government site: a page on any
        // other host that merely says it is that biller is never paid; the real site he named is opened instead.)
        const moneyKind = peek.analysis.ok ? listedMoneyHostKind(peek.analysis.details.host) : null;
        if (peek.analysis.ok && (moneyKind === "bank" || moneyKind === "payment" || moneyKind === "gov") && (!!req.payee && payeeFits(req.payee, { payee: peek.analysis.details.payee, host: peek.analysis.details.host, title: peek.analysis.details.title, stated: peek.analysis.details.stated }))) peeked = peek;
      }
      if (!there && !peeked) {
        // A payment only ever opens a site whose address can be read (no shortener, raw IP or look-alike), and never a broker, exchange or bookie.
        const allowed = deskOpenVerdict(req.url ?? `https://${req.host}/`);
        if (!allowed.ok) return { ok: false, said: allowed.said, refused: true };
        let o = await hands.openDesk(req.url ?? `https://${req.host}/`, "new-tab");
        if (!o.ok && deps.ensure && /connect|refused|ECONN|not running|no browser|CDP/i.test(o.said) && (await deps.ensure())) o = await hands.openDesk(req.url ?? `https://${req.host}/`, "new-tab");
        if (!o.ok) return { ok: false, said: o.said, refused: /trade|crypto|bets|can't read where/i.test(o.said) };
        if (o.targetId) await hands.activate(o.targetId).catch(() => false);
        await deps.present?.().catch(() => null);
        await sleep(deps.settleMs ?? 1200);
        opened = true;
        tab = await hands.active().catch(() => null);
      }
    } else if (!tab) {
      return { ok: false, said: "Jarvis Chrome isn't open. Open the payment page there, then say pay this.", asks: true };
    }
    if (!tab) return { ok: false, said: "I can't find the page in Jarvis Chrome, so nothing was set up." };
    const read = peeked ?? (await readAnalysis(hands));
    const a = read.analysis;
    if (!a.ok) {
      const lead = opened ? `Opened ${req.host}. ` : "";
      // A page that just isn't a payment page yet: the lead and one line, never a lecture.
      return { ok: false, said: `${lead}${a.said}`, refused: a.kind === "never", asks: a.kind !== "never" };
    }
    const d = a.details;
    // What he said must be what the page shows: a different amount or payee stops it, and says which.
    if (req.amount && (req.amount !== d.amount || (req.currency && /^[A-Z]{3}$/.test(d.currency) && req.currency !== d.currency)))
      return { ok: false, said: `That page says ${spokenMoney(d.amount, d.currency)}, not ${spokenMoney(req.amount, req.currency)}. I haven't set up a payment.` };
    if (req.payee && !payeeFits(req.payee, { payee: d.payee, host: d.host, title: d.title, stated: d.stated }))
      return { ok: false, said: `That page pays ${d.payee}, not ${req.payee}. I haven't set up a payment.` };
    const existing = store.same(a.digest, clock());
    if (existing) {
      // (Asked again: this is now the line he is answering, so a yes right after it counts for this payment.)
      if (ctx.source === "typed") existing.typedEpoch = typedEpoch;
      return { ok: true, said: `Still waiting: ${existing.prompt}`, pending: publicView(existing) };
    }
    const named = req.host && reg(d.host) !== req.host ? req.host : null;
    const prompt = line(d.amount, d.currency, d.payee, d.host, named, d.recurring);
    const p = store.create(
      {
        source: ctx.source ?? "voice", request: req, what: req.what, payee: d.payee, amount: d.amount, currency: d.currency, raw: d.raw,
        host: d.host, url: d.url, title: d.title, button: d.label, last4: d.last4,
        bound: { targetId: read.targetId ?? tab.targetId, control: a.control, lines: a.lines, digest: a.digest },
        prompt, named, recurring: d.recurring, typedEpoch: ctx.source === "typed" ? typedEpoch : null,
      },
      clock(),
    );
    log(`desk payment ${p.id} asked: ${p.what} ${formatMoney(p.amount, p.currency)} to ${p.payee} on ${p.host}`);
    return { ok: true, said: p.prompt, pending: publicView(p) };
  }
  /**
   * The one line for the card and for speech: "Pay A$120 to Origin Energy on originenergy.com.au? Say yes to go." When the page
   * shows a repeating figure it says so ("… Then: Renews at A$499.00/year."), and when the site isn't the one he named, which.
   */
  function line(amount: string, currency: string, payee: string, host: string, named: string | null, recurring: string | null): string {
    const n = named ? ` (you named ${named})` : "";
    const then = recurring ? ` Then: ${recurring.replace(/[.?!]+$/, "")}.` : "";
    return `Pay ${spokenMoney(amount, currency)} to ${payee} on ${host}${n}?${then} Say yes to go.`;
  }

  // --- his confirmation --------------------------------------------------------------------------------------------
  async function confirm(id: string, proof: { how: "card-click" | "spoken-yes" | "typed-yes"; ticket?: unknown }, ctx: DeskCtx): Promise<DeskResult> {
    if (!ctx.desk.ok) return { ok: false, said: NOT_DESK_LINE, refused: true };
    // One step at a time: no new request can open another tab and re-map the page's controls while a press is under way.
    return serial(async () => {
      const now = clock();
      let how: "card-click" | "spoken-yes" | "typed-yes" = "card-click";
      if (proof.how !== "card-click") {
        // A yes must carry the ticket the turn rules minted for THIS payment (a model's or a page's "confirm" has none), and the
        // label is the verified path recorded with the ticket, never the caller's word for it.
        const verified = store.redeemTicket(proof.ticket, id, now);
        if (!verified) return { ok: false, said: "I didn't get a clear yes for that payment, so nothing was paid." };
        how = verified;
      } else if (typeof id !== "string") return { ok: false, said: "Which payment?" };
      const c = store.consume(id, how, now);
      if (!c.ok) {
        const said = c.why === "expired" ? "That payment request timed out, so nothing was paid. Say it again." : c.why === "busy" ? "Another payment is being made right now, so nothing else was paid." : c.why === "used" ? "That payment was already dealt with." : "There's no payment waiting.";
        return { ok: false, said };
      }
      // Keep the serial lock until the browser call actually settles. Returning on a timer could permit
      // another payment while the first click is still in flight. The browser runner has its own call timeout.
      return await execute(c.pending, c.confirmed, how);
    }, BUSY);
  }

  async function execute(p: PendingPayment, confirmed: import("./confirmed").ConfirmedPress, how: string): Promise<DeskResult> {
    const money = formatMoney(p.amount, p.currency);
    const receipt = (outcome: PaymentReceipt["outcome"], reference: string | null = null) =>
      deps.receipts.write({
        ts: new Date(clock()).toISOString(), task: 0, mode: "desk", id: p.id, kind: p.request.kind, what: p.what, amount: p.amount, currency: p.currency,
        payee: scrub(p.payee).slice(0, 80), host: p.host, reference: reference ? scrub(reference).slice(0, 40) : null, outcome, how, source: p.source, button: scrub(p.button).slice(0, 60),
      });
    const stop = (why: string, state: "stopped" | "failed" = "stopped"): DeskResult => {
      const said = state === "stopped" ? `Stopped: ${why}. Nothing was paid.` : why;
      store.finish(p.id, state, said);
      receipt(state);
      log(`desk payment ${p.id} ${state}: ${why}`);
      return { ok: false, said };
    };
    try {
      const hands = await deps.hands();
      if (!hands) return stop(NO_HANDS, "failed");
      const read = await readAnalysis(hands);
      if (read.targetId !== p.bound.targetId) return stop("it's a different tab now");
      const diff = diffPayment({ host: p.host, payee: p.payee, amount: p.amount, currency: p.currency, control: p.bound.control, lines: p.bound.lines, targetId: p.bound.targetId }, read.analysis, read.targetId, formatMoney);
      if (diff.length) return stop(diff.join("; "));
      const fresh = read.analysis;
      if (!fresh.ok) return stop(fresh.said.replace(/\.$/, ""));
      if (fresh.digest !== p.bound.digest) return stop("the page changed since you were asked");
      // The audit line goes down BEFORE the press: with no audit trail there is no payment.
      if (!receipt("pressing")) return stop("I couldn't write the receipt line first, so nothing was paid", "failed");
      // The browser checks the same URL, page text and button under the pointer in the same evaluation that presses it.
      const pressed = await hands.pressBound(confirmed, fresh.control.ref, { name: fresh.control.name, targetId: p.bound.targetId, url: p.url, pageHash: read.pageHash, pageTitle: read.pageTitle });
      // A press refused BEFORE the click (the page moved, something is over the button): nothing was pressed, and it says so.
      if (!pressed.ok && pressed.clicked === false) return stop(pressed.said.replace(/,? so nothing was pressed\.?$/i, "").replace(/\.$/, ""));
      if (!pressed.ok) {
        const said = `${pressed.said} It may or may not have gone through: check ${p.host} before trying again.`;
        store.finish(p.id, "unknown", said);
        receipt("unknown");
        return { ok: false, said };
      }
      await sleep(deps.afterPressMs ?? 1500);
      const after = await hands.readDesk().catch(() => null);
      const refsAfter = await hands.snapshot().catch(() => [] as SnapshotRef[]);
      const stillThere = payCandidates(refsAfter, after?.text ?? "").some((c) => c.sig === p.bound.control.sig) && !!after && reg(hostOf(after.url)) === reg(p.host) && after.url.split("#")[0] === p.url.split("#")[0];
      const text = `${after?.title ?? ""}\n${after?.text ?? ""}`.slice(0, 6000);
      const ok = CONFIRMED_TEXT.test(text) && !stillThere;
      const reference = REFERENCE.exec(text)?.[1] ?? null;
      const wrote = receipt(ok ? "confirmed" : "unknown", reference);
      if (ok) {
        const said = `Paid ${money} to ${p.payee}${reference ? `, reference ${reference}` : ""}.${wrote ? " Receipt saved." : " I couldn't save the receipt line."}`;
        store.finish(p.id, "done", said);
        log(`desk payment ${p.id} paid`);
        return { ok: true, said };
      }
      const said = `I pressed "${p.button}" once for ${money} to ${p.payee}, but I couldn't see a confirmation. I won't press it again: check ${p.host} yourself.`;
      store.finish(p.id, "unknown", said);
      log(`desk payment ${p.id} outcome unknown`);
      return { ok: false, said };
    } catch (error) {
      const said = `That went wrong partway (${String((error as Error)?.message ?? error).slice(0, 80)}). I won't press it again: check ${p.host} before trying again.`;
      store.finish(p.id, "unknown", said);
      receipt("unknown");
      return { ok: false, said };
    }
  }

  // --- cancel, status ----------------------------------------------------------------------------------------------
  function cancel(id: string | "all", reason?: string): DeskResult {
    const n = store.cancel(id, clock(), reason);
    return { ok: n > 0, said: n === 0 ? "Nothing was waiting." : n === 1 ? "Cancelled. Nothing was paid." : `Cancelled ${n}. Nothing was paid.` };
  }
  function status(ctx: { desk: DeskVerdict }) {
    if (!ctx.desk.ok) return { desk: false as const, now: clock(), pending: [] as PublicPayment[], recent: [] as Array<{ id: string; state: string; said: string; payee: string; amount: string; currency: string; settledAt: number }> };
    const now = clock();
    return {
      desk: true as const,
      now,
      ttlMs: store.ttl,
      pending: store.live(now).map(publicView),
      // What just finished (paid, stopped, timed out, cancelled): the card shows it for a moment.
      recent: store.recent().filter((p) => p.settledAt && now - p.settledAt < 60_000).map((p) => ({ id: p.id, state: p.state, said: p.result ?? "", payee: p.payee, amount: p.amount, currency: p.currency, settledAt: p.settledAt! })),
    };
  }

  // --- the turn rules: his words → a tool call the client runs, or a line -------------------------------------------
  /**
   * His words at the desk. Returns a `payment` skill call for the client to run (request, confirm with a ticket, cancel),
   * or a browser open for a bank or payment site, or a line to say; null when it isn't a payment matter (the usual rules
   * go on). `answered`: another yes/no question already took this reply. Nothing here presses or opens anything itself.
   */
  async function turn(
    text: string,
    t: {
      desk: boolean;
      answered?: boolean;
      /**
       * Where the words came from. `voice` (the default): the voice turn, whose conversation the client builds. `typed`: the typed
       * command box. A command a MODEL sends (jarvis_command, control_pc…) is never `typed`, and its "yes" is never a yes.
       */
      channel?: "voice" | "typed";
      /** Voice: what Jarvis said just before these words (the assistant message right before them). */
      previousAssistant?: string | null;
      /** Voice: the STT ledger's id for a spoken whole-utterance yes (verified here, not trusted). */
      spokenYes?: string | null;
      /** Record these words as heard (default true; false for words a tool call carried, which he was not heard to say). */
      record?: boolean;
    },
  ): Promise<DeskTurn> {
    if (!t.desk) return null;
    const now = clock();
    const channel = t.channel ?? "voice";
    const reply = confirmationReply(text);
    if (t.record !== false) heard(text);
    // A newer typed command (anything but a yes or no) supersedes a payment asked in an earlier one.
    if (channel === "typed" && t.record !== false && reply !== "yes" && reply !== "no") typedEpoch++;
    const live = store.live(now);
    if (live.length && !t.answered && (reply === "yes" || reply === "no")) {
      // A yes or no answers the payment only when it answers the payment's OWN question: voice, when the line right before it was
      // that question; the typed box, when no other typed command came in between. Otherwise it answers something else and the
      // card just waits (the Confirm button always works). A model's command never gets here as `typed`.
      const prev = t.previousAssistant ?? "";
      const bound = channel === "typed" ? live.filter((p) => p.typedEpoch === typedEpoch) : live.filter((p) => prev.length > 0 && prev.includes(p.prompt));
      if (bound.length) {
        if (reply === "no") return { say: cancel("all").said };
        if (live.length > 1)
          return { say: `${live.length} payments are waiting (${live.slice(0, 3).map((p) => `${spokenMoney(p.amount, p.currency)} to ${p.payee}`).join(", ")}). Tap Confirm on the one you want, or say cancel.` };
        const p = live[0];
        // A voice-route yes is never silently recast as typed. Only the server's own STT ledger can confirm speech.
        if (channel === "voice" && (!t.spokenYes || !spokenConfirmations.redeem(t.spokenYes, { after: p.createdAt })))
          return { say: "I need to hear your yes to this payment again. Nothing was paid.", ask: true };
        return { call: { skill: "payment", action: "confirm", id: p.id, ticket: store.mintTicket(p.id, channel === "voice" ? "spoken-yes" : "typed-yes", now) } };
      }
    }
    // "what's my AI spend, and pay it": the spend is the skill's, and it asks for the payment part itself.
    if (aiUsageIntent(text)) return null;
    const open = deskOpenOrder(text, config());
    if (open) return open.ok ? { call: { skill: "browser", action: "open", url: open.url, name: open.name } } : { say: open.said, refused: true };
    if (deskMoneyOrder(text)) {
      // The never lines and "which amount?" need no page and no round trip: said at once. A real request goes to the skill.
      const parsed = parseDeskRequest(text, config());
      if (parsed && !parsed.ok) return "never" in parsed ? { say: parsed.said, refused: true } : { say: parsed.said, ask: true };
      return { call: { skill: "payment", action: "request", text: text.slice(0, 600) } };
    }
    return null;
  }

  /** The payment part of a compound request ("what's my spend, and pay it"): the confirm line, or the one question. */
  async function compound(text: string, ctx: DeskCtx): Promise<string> {
    const parsed = parseDeskRequest(text, config());
    if (!parsed) return "Who and how much?";
    if (!parsed.ok) return parsed.said;
    const r = parsed.request;
    // ("pay it" after a spend question says nothing about who: ask, never guess the page in front of him.)
    if (!r.payee && !r.host && !r.amount) return "Who and how much?";
    return (await request(text, ctx)).said;
  }

  // --- the /jarvis/skill payment calls ------------------------------------------------------------------------------
  async function skill(body: unknown, ctx: DeskCtx): Promise<{ ok: boolean; said: string; ms: number; skill: "payment" }> {
    const started = Date.now();
    const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
    const done = (r: { ok: boolean; said: string }) => ({ ok: r.ok, said: r.said, ms: Date.now() - started, skill: "payment" as const });
    const action = String(b.action ?? "");
    if (action === "request") return done(await request(typeof b.text === "string" ? b.text : "", { ...ctx, source: ctx.source ?? "voice" }));
    if (action === "confirm") {
      const how = b.how === "spoken-yes" ? "spoken-yes" : "typed-yes";
      return done(await confirm(String(b.id ?? ""), { how, ticket: b.ticket }, ctx));
    }
    if (action === "cancel") return done(cancel(typeof b.id === "string" && b.id ? b.id : "all"));
    if (action === "status") {
      const s = status(ctx);
      return done({ ok: true, said: s.pending.length ? s.pending.map((p) => `${spokenMoney(p.amount, p.currency)} to ${p.payee} is waiting for your yes`).join("; ") + "." : "No payment is waiting." });
    }
    return done({ ok: false, said: "I don't know that payment action." });
  }

  return {
    store,
    /** The desk verdict for a request's verified principal, with away mode read now. */
    verdict(principal: Principal | null): DeskVerdict {
      let awayOn: boolean | null;
      try {
        awayOn = deps.awayOn();
      } catch {
        awayOn = null;
      }
      let presence: { locked: boolean | null; idleMs: number | null } | null = null;
      try {
        presence = deps.presence?.() ?? null;
      } catch {
        presence = null;
      }
      return deskVerdict({ principal, awayOn, presence, idleLimitMs: deps.idleLimitMs });
    },
    request, confirm, cancel, status, turn, compound, skill, heard,
    openOrder: (text: string) => deskOpenOrder(text, config()),
    payOrder: deskPayOrder,
  };
}
export type DeskPayments = ReturnType<typeof createDeskPayments>;
