import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SpokenConfirmationLedger } from "../jarvis-execution/voice-confirmation";
import { argsDigest } from "./canonical";
import type { AwayPaymentArgs } from "./policy";
import type { Principal } from "./principal";
import { ApprovalService, QUESTION_TTL_MS } from "./service";

/** Usman in his browser (a human session): these requests are his own, made in the UI. */
const usman: Principal = { personId: "usman", via: "loopback-owner", actor: "human", sessionId: "sess-usman-0001" };
const mehroz: Principal = { personId: "mehroz", via: "tailnet-person", actor: "human", sessionId: "sess-mehroz-0001" };
/** Usman in a signed-in browser session (B1's session id): the only kind of caller a UI confirm counts from. */
const usmanUi: Principal = { personId: "usman", via: "loopback-owner", actor: "human", sessionId: "sess-usman-0001" };
/** The rendered card's nonce for this session, as the UI would send it back on a click. */
const ui = (s: ApprovalService, id: string, p: Principal = usmanUi) => ({ uiConfirm: true as const, cardNonce: s.card(id, p)?.cardNonce ?? "00000000-0000-4000-8000-000000000000" });
const usmanTelegram: Principal = { personId: "usman", via: "telegram-owner" };

let dir: string;
let clock: number;
let ledger: SpokenConfirmationLedger;
const open: ApprovalService[] = [];
const service = (extra: Partial<ConstructorParameters<typeof ApprovalService>[0]> = {}) => {
  const s = new ApprovalService({ path: join(dir, "approvals.sqlite"), now: () => clock, spoken: ledger, code: () => "AB3D", ...extra });
  open.push(s);
  return s;
};
const restart = (s: ApprovalService, extra: Partial<ConstructorParameters<typeof ApprovalService>[0]> = {}) => {
  s.close();
  open.splice(open.indexOf(s), 1);
  return service(extra);
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "b2-approvals-"));
  clock = Date.parse("2026-09-28T02:00:00Z");
  ledger = new SpokenConfirmationLedger(() => clock);
});
afterEach(() => {
  for (const s of open.splice(0)) {
    try {
      s.close();
    } catch {
      /* closed */
    }
  }
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows may hold the WAL briefly */
  }
});

const merge = { repoId: "mu-receptionist", branch: "main", fromSha: "9c1e2ab0000000000000000000000000000000aa", toRef: "main" };
function approvedMerge(s: ApprovalService) {
  const r = s.request({ action: "coding.merge", args: merge, requester: usman, summary: "Merge coding/x @ 9c1e2ab into main", origin: "principal" });
  if (!r.ok) throw new Error("refused");
  const d = s.decide(r.approval.id, usmanUi, "approve", ui(s, r.approval.id));
  expect(d.ok).toBe(true);
  return r.approval.id;
}

describe("request", () => {
  test("stores only the digest, masks the summary and is asked ONCE for the same exact action", () => {
    const s = service();
    const a = s.request({ action: "coding.merge", args: merge, requester: usman, summary: "Merge for ops@example.com 0412 345 678", origin: "principal" });
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    expect(a.approval.state).toBe("pending");
    expect(a.approval.argsDigest).toBe(argsDigest("coding.merge", merge));
    expect(a.approval.summary).not.toContain("ops@example.com");
    expect(a.approval.summary).not.toContain("345 678");
    const again = s.request({ action: "coding.merge", args: { ...merge }, requester: usman, summary: "again", origin: "principal" });
    expect(again.ok && again.reused && again.approval.id === a.approval.id).toBe(true);
    const other = s.request({ action: "coding.merge", args: { ...merge, fromSha: "abcdef1" }, requester: usman, summary: "new sha", origin: "principal" });
    expect(other.ok && !other.reused).toBe(true);
  });

  test("the money refusal runs BEFORE request: nothing is written for a refused request", () => {
    const s = service();
    for (const [action, args] of [
      ["finance.transfer", { to: "x", amount: 100 }],
      ["screen.press", { label: "Pay now" }],
      ["crypto.swap", {}],
      ["control.run", { task: "buy 10 shares of BHP on CommSec" }],
    ] as const) {
      const r = s.request({ action, args, requester: usman, summary: "x", origin: "principal" });
      expect(r.ok).toBe(false);
    }
    const injected = s.request({ action: "coding.merge", args: merge, requester: usman, summary: "x", origin: "observed-content" });
    expect(injected.ok).toBe(false);
    if (!injected.ok) expect(injected.refusal.code).toBe("observed-content");
    s.close();
    open.splice(0);
    const db = new Database(join(dir, "approvals.sqlite"), { readonly: true });
    expect((db.query("SELECT COUNT(*) AS n FROM approvals").get() as { n: number }).n).toBe(0);
    db.close();
  });

  test("an unknown or routine action is not approvable (fail closed)", () => {
    const s = service();
    const r = s.request({ action: "screen.scroll", args: {}, requester: usman, summary: "scroll", origin: "principal" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusal.code).toBe("unknown-action");
  });
});

describe("consume: single use, digest, expiry, replay", () => {
  test("consume is an atomic one-shot; a second consume is refused", () => {
    const s = service();
    const id = approvedMerge(s);
    const digest = argsDigest("coding.merge", merge);
    expect(s.consume(id, digest).ok).toBe(true);
    const replay = s.consume(id, digest);
    expect(replay).toMatchObject({ ok: false, code: "consumed" });
  });

  test("a pending approval can't be consumed", () => {
    const s = service();
    const r = s.request({ action: "coding.merge", args: merge, requester: usman, summary: "m", origin: "principal" });
    if (!r.ok) throw new Error();
    expect(s.consume(r.approval.id, r.approval.argsDigest)).toMatchObject({ ok: false, code: "not-approved" });
  });

  test("a digest mismatch is refused and voids the approval (the action changed)", () => {
    const s = service();
    const id = approvedMerge(s);
    const changed = s.consume(id, argsDigest("coding.merge", { ...merge, fromSha: "1234567" }));
    expect(changed).toMatchObject({ ok: false, code: "digest-mismatch" });
    expect(s.get(id)!.state).toBe("cancelled");
    expect(s.consume(id, argsDigest("coding.merge", merge)).ok).toBe(false);
  });

  test("expiry refuses consume and decide", () => {
    const s = service();
    const id = approvedMerge(s);
    clock += 61 * 60_000;
    expect(s.consume(id, argsDigest("coding.merge", merge))).toMatchObject({ ok: false, code: "expired" });
    expect(s.get(id)!.state).toBe("expired");
    const r = s.request({ action: "memory.forget", args: { t: 1 }, requester: usman, summary: "f", origin: "principal" });
    if (!r.ok) throw new Error();
    clock += 11 * 60_000;
    expect(s.decide(r.approval.id, usmanUi, "approve", ui(s, r.approval.id))).toMatchObject({ ok: false, code: "expired" });
  });

  test("the outcome is written once, only after consumption", () => {
    const s = service();
    const id = approvedMerge(s);
    expect(s.recordOutcome(id, "succeeded")).toBe(false);
    s.consume(id, argsDigest("coding.merge", merge));
    expect(s.recordOutcome(id, "succeeded")).toBe(true);
    expect(s.recordOutcome(id, "failed")).toBe(false);
    expect(s.get(id)!.outcome).toBe("succeeded");
  });
});

describe("restart durability", () => {
  test("pending stays pending; approved-unconsumed stays usable until expiry; consumed never replays", () => {
    let s = service();
    const pending = s.request({ action: "memory.forget", args: { target: "m1" }, requester: usman, summary: "forget m1", origin: "principal" });
    const approved = approvedMerge(s);
    const used = s.request({ action: "deploy", args: { site: "a" }, requester: usman, summary: "deploy", origin: "principal" });
    if (!pending.ok || !used.ok) throw new Error();
    s.decide(used.approval.id, usmanUi, "approve", ui(s, used.approval.id));
    s.consume(used.approval.id, used.approval.argsDigest);

    s = restart(s);
    const recovered = s.recover();
    expect(recovered.unknownOutcomes).toBe(1);
    expect(s.get(pending.approval.id)!.state).toBe("pending");
    expect(s.get(approved)!.state).toBe("approved");
    expect(s.get(used.approval.id)).toMatchObject({ state: "consumed", outcome: "unknown" });
    // Still usable after the restart, once.
    expect(s.consume(approved, argsDigest("coding.merge", merge)).ok).toBe(true);
    expect(s.consume(used.approval.id, used.approval.argsDigest)).toMatchObject({ ok: false, code: "consumed" });
    // And it can still be decided after the restart.
    expect(s.decide(pending.approval.id, usmanUi, "approve", ui(s, pending.approval.id)).ok).toBe(true);
  });

  test("an approved-unconsumed approval that expires across a restart is not usable", () => {
    let s = service();
    const id = approvedMerge(s);
    s = restart(s);
    clock += 2 * 60 * 60_000;
    s.recover();
    expect(s.get(id)!.state).toBe("expired");
    expect(s.consume(id, argsDigest("coding.merge", merge)).ok).toBe(false);
  });

  test("a read-only second server can read but never write", () => {
    const s = service();
    approvedMerge(s);
    const ro = service({ readOnly: true });
    expect(ro.list().length).toBe(1);
    expect(() => ro.request({ action: "deploy", args: {}, requester: usman, summary: "d", origin: "principal" })).toThrow();
    expect(() => ro.recover()).toThrow();
  });
});

describe("evidence", () => {
  const forget = (s: ApprovalService) => {
    const r = s.request({ action: "memory.forget", args: { target: "m1", planDigest: "p" }, requester: usman, summary: "Forget m1", origin: "principal" });
    if (!r.ok) throw new Error();
    return r.approval.id;
  };

  test("a spoken yes binds to the question just asked for THIS approval, single use", () => {
    const s = service();
    const id = forget(s);
    const q = s.ask(id, usman);
    clock += 1_000;
    const yes = ledger.record("yes")!;
    expect(s.decide(id, usman, "approve", { spokenYes: yes.id, questionId: q.questionId })).toMatchObject({ ok: true });
    expect(s.get(id)!.evidence).toBe("spokenYes");
  });

  test("a yes said BEFORE the question can't approve it", () => {
    const s = service();
    const id = forget(s);
    const early = ledger.record("yes")!;
    clock += 1_000;
    const q = s.ask(id, usman);
    expect(s.decide(id, usman, "approve", { spokenYes: early.id, questionId: q.questionId })).toMatchObject({ ok: false, code: "no-spoken-yes" });
  });

  test("a yes to another approval's question, or to a superseded question, can't approve it", () => {
    const s = service();
    const a = forget(s);
    const b = s.request({ action: "memory.forget", args: { target: "m2", planDigest: "p" }, requester: usman, summary: "Forget m2", origin: "principal" });
    if (!b.ok) throw new Error();
    const qa = s.ask(a, usman);
    clock += 500;
    const qb = s.ask(b.approval.id, usman); // supersedes qa: one question at a time
    clock += 500;
    const yes = ledger.record("yes please")!;
    expect(s.decide(a, usman, "approve", { spokenYes: yes.id, questionId: qa.questionId })).toMatchObject({ ok: false, code: "no-question" });
    expect(s.decide(a, usman, "approve", { spokenYes: yes.id, questionId: qb.questionId })).toMatchObject({ ok: false, code: "no-question" });
    expect(s.decide(b.approval.id, usman, "approve", { spokenYes: yes.id, questionId: qb.questionId }).ok).toBe(true);
  });

  test("a typed yes is refused: no server STT event exists for it, and a string is not an event", () => {
    const s = service();
    const id = forget(s);
    const q = s.ask(id, usman);
    clock += 1_000;
    expect(s.decide(id, usman, "approve", { spokenYes: "yes", questionId: q.questionId })).toMatchObject({ ok: false, code: "no-spoken-yes" });
    expect(s.decide(id, usman, "approve", { spokenYes: "00000000-0000-4000-8000-000000000000", questionId: q.questionId })).toMatchObject({ ok: false });
    // A spoken event can't be reused for a second approval.
    const yes = ledger.record("yes")!;
    expect(s.decide(id, usman, "approve", { spokenYes: yes.id, questionId: q.questionId }).ok).toBe(true);
    const other = s.request({ action: "memory.forget", args: { target: "m9", planDigest: "p" }, requester: usman, summary: "Forget m9", origin: "principal" });
    if (!other.ok) throw new Error();
    const q2 = s.ask(other.approval.id, usman);
    expect(s.decide(other.approval.id, usman, "approve", { spokenYes: yes.id, questionId: q2.questionId }).ok).toBe(false);
  });

  test("a question expires", () => {
    const s = service();
    const id = forget(s);
    const q = s.ask(id, usman);
    clock += QUESTION_TTL_MS + 1;
    const yes = ledger.record("yes")!;
    expect(s.decide(id, usman, "approve", { spokenYes: yes.id, questionId: q.questionId })).toMatchObject({ ok: false, code: "no-question" });
  });

  test("control is voice-only: a UI confirm (a typed yes) is refused where a spoken yes is required", () => {
    const s = service();
    const r = s.request({ action: "control.run", args: { task: "open notepad and write a note" }, requester: usman, summary: "Open Notepad", origin: "principal" });
    if (!r.ok) throw new Error(JSON.stringify(r));
    expect(s.decide(r.approval.id, usmanUi, "approve", ui(s, r.approval.id))).toMatchObject({ ok: false, code: "evidence-required" });
  });

  test("uiConfirm needs a verified UI session: Telegram and the companion are refused, a paired session needs its id", () => {
    const s = service();
    const id = forget(s);
    expect(s.decide(id, usmanTelegram, "approve", { uiConfirm: true })).toMatchObject({ ok: false, code: "unverified-session" });
    expect(s.decide(id, { personId: "usman", via: "companion" }, "approve", { uiConfirm: true })).toMatchObject({ ok: false });
    expect(s.decide(id, { personId: "usman", via: "paired-session" }, "approve", { uiConfirm: true })).toMatchObject({ ok: false });
    expect(s.decide(id, mehroz, "approve", ui(s, id, mehroz))).toMatchObject({ ok: true });
    expect(s.get(id)!.approver).toMatchObject({ personId: "mehroz" });
  });

  test("the approver must be a verified Principal (never screen text or a body)", () => {
    const s = service();
    const id = forget(s);
    expect(s.decide(id, { personId: "Usman", via: "loopback-owner" } as never, "approve", { uiConfirm: true })).toMatchObject({ ok: false, code: "unverified" });
    expect(s.decide(id, "usman" as never, "approve", { uiConfirm: true })).toMatchObject({ ok: false, code: "unverified" });
  });

  test("reject is final", () => {
    const s = service();
    const id = forget(s);
    expect(s.decide(id, usman, "reject").ok).toBe(true);
    expect(s.decide(id, usmanUi, "approve", ui(s, id))).toMatchObject({ ok: false, code: "rejected" });
  });

  test("production coding actions are decided only by the named approver", () => {
    const s = service();
    const r = s.request({ action: "git.push.production", args: merge, requester: mehroz, summary: "push", origin: "principal", scope: { approverPersonId: "usman" } });
    if (!r.ok) throw new Error();
    expect(s.decide(r.approval.id, mehroz, "approve", ui(s, r.approval.id, mehroz))).toMatchObject({ ok: false, code: "wrong-approver" });
    expect(s.decide(r.approval.id, usmanUi, "approve", ui(s, r.approval.id)).ok).toBe(true);
  });
});

describe("away.payment (V8)", () => {
  const bill: AwayPaymentArgs = {
    taskId: "away-12",
    host: "my.origin.com.au",
    payee: { id: "biller-origin", name: "Origin Energy", saved: true },
    amount: { minor: 18450, currency: "AUD" },
    element: { label: "Pay bill", ref: "uia:button#pay" },
    category: "bill",
  };
  const ask = (s: ApprovalService, args: unknown = bill, origin: "principal" | "observed-content" = "principal") =>
    s.request({ action: "away.payment", args, requester: usman, summary: "Pay Origin Energy A$184.50", origin });

  test("approvable only with the away code from the owner's verified channel; single use; bound digest", () => {
    const s = service();
    const r = ask(s);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.awayCode).toBe("AB3D");
    expect(Date.parse(r.approval.expiresAt) - clock).toBe(10 * 60_000);
    // A UI confirm or a spoken yes can't approve money.
    expect(s.decide(r.approval.id, usmanUi, "approve", ui(s, r.approval.id))).toMatchObject({ ok: false, code: "evidence-required" });
    // Mehroz can't answer Usman's payment, even with the right code.
    expect(s.decide(r.approval.id, { personId: "mehroz", via: "telegram-owner" }, "approve", { awayCode: "AB3D" })).toMatchObject({ ok: false, code: "wrong-approver" });
    expect(s.decide(r.approval.id, usmanTelegram, "approve", { awayCode: "ab3d" }).ok).toBe(true);
    // The page is re-verified before the press: a different amount voids it.
    const live = { ...bill, amount: { minor: 18450, currency: "AUD" } };
    expect(s.consume(r.approval.id, argsDigest("away.payment", live)).ok).toBe(true);
    expect(s.consume(r.approval.id, argsDigest("away.payment", live))).toMatchObject({ ok: false, code: "consumed" });
    expect(s.recordOutcome(r.approval.id, "succeeded")).toBe(true);
  });

  test("a changed page (amount, payee, host or button) voids the approval before the press", () => {
    const s = service();
    const r = ask(s);
    if (!r.ok) throw new Error();
    s.decide(r.approval.id, usmanTelegram, "approve", { awayCode: "AB3D" });
    expect(s.consume(r.approval.id, argsDigest("away.payment", { ...bill, amount: { minor: 99999, currency: "AUD" } }))).toMatchObject({ ok: false, code: "digest-mismatch" });
    expect(s.consume(r.approval.id, argsDigest("away.payment", bill)).ok).toBe(false);
  });

  test("three wrong codes reject it; the code is never stored in plain text", () => {
    const s = service();
    const r = ask(s);
    if (!r.ok) throw new Error();
    expect(s.decide(r.approval.id, usmanTelegram, "approve", { awayCode: "ZZZ9" })).toMatchObject({ code: "wrong-code" });
    expect(s.decide(r.approval.id, usmanTelegram, "approve", { awayCode: "ZZZ8" })).toMatchObject({ code: "wrong-code" });
    expect(s.decide(r.approval.id, usmanTelegram, "approve", { awayCode: "ZZZ7" })).toMatchObject({ code: "rejected" });
    expect(s.decide(r.approval.id, usmanTelegram, "approve", { awayCode: "AB3D" }).ok).toBe(false);
    s.close();
    open.splice(0);
    const db = new Database(join(dir, "approvals.sqlite"), { readonly: true });
    const dump = JSON.stringify(db.query("SELECT * FROM approvals").all());
    db.close();
    expect(dump).not.toContain("AB3D");
  });

  test("expires after 10 minutes", () => {
    const s = service();
    const r = ask(s);
    if (!r.ok) throw new Error();
    clock += 10 * 60_000 + 1;
    expect(s.decide(r.approval.id, usmanTelegram, "approve", { awayCode: "AB3D" })).toMatchObject({ ok: false, code: "expired" });
  });

  test("a restart drops a pending payment (its code key lived in memory): nothing on disk can approve it", () => {
    let s = service();
    const r = ask(s);
    if (!r.ok) throw new Error();
    s = restart(s);
    expect(s.recover().awayCodesDropped).toBe(1);
    expect(s.get(r.approval.id)).toMatchObject({ state: "cancelled", reason: "restart-code-lost" });
    expect(s.decide(r.approval.id, usmanTelegram, "approve", { awayCode: "AB3D" }).ok).toBe(false);
  });

  test("refused before request: trades, crypto, betting, new payees, typed credentials, observed content", () => {
    const s = service();
    const cases: [unknown, string, ("principal" | "observed-content")?][] = [
      [{ ...bill, host: "www.commsec.com.au" }, "trade"],
      [{ ...bill, payee: { id: "p1", name: "Buy ETF units", saved: true } }, "trade"],
      [{ ...bill, payee: { id: "p1", name: "Coinbase Bitcoin", saved: true } }, "crypto"],
      [{ ...bill, host: "www.sportsbet.com.au" }, "betting"],
      [{ ...bill, host: "www.coinspot.com.au" }, "crypto"],
      [{ ...bill, element: { label: "Place bet", ref: "x" } }, "betting"],
      [{ ...bill, payee: { id: "p1", name: "New person", saved: false } }, "new-payee"],
      [{ ...bill, element: { label: "Add payee and pay", ref: "x" } }, "new-payee"],
      [{ ...bill, cardNumber: "4111111111111111" }, "typed-credentials"],
      [{ ...bill, payee: { id: "p1", name: "Origin 4111 1111 1111 1111", saved: true } }, "typed-credentials"],
      [{ ...bill, otp: "123456" }, "typed-credentials"],
      [{ ...bill, category: "transfer" }, "payment-out-of-scope"],
      [bill, "observed-content", "observed-content"],
    ];
    for (const [args, code, origin] of cases) {
      const r = ask(s, args, origin ?? "principal");
      expect({ code: r.ok ? "ok" : r.refusal.code, args }).toEqual({ code, args });
    }
    expect(s.list().length).toBe(0);
  });

  test("every other path keeps refusing money", () => {
    const s = service();
    for (const action of ["screen.press", "control.run", "lesson.run", "message.send"]) {
      const r = s.request({ action, args: { label: "Pay now $50" }, requester: usman, summary: "x", origin: "principal" });
      expect(r.ok).toBe(false);
    }
    const run = s.request({ action: "away.run", args: { task: "transfer $500 to savings" }, requester: usman, summary: "x", origin: "principal" });
    expect(run.ok).toBe(false);
  });

  test("donations, zakat and subscriptions to saved payees are approvable", () => {
    const s = service();
    for (const category of ["zakat", "sadaqah", "donation", "subscription", "renewal", "invoice", "purchase"] as const) {
      const r = ask(s, { ...bill, category, taskId: `t-${category}` });
      expect(r.ok).toBe(true);
    }
  });
});
