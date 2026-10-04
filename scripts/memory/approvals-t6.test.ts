// Track 6: forget approvals on B2's durable approval service. TEMP synthetic vault + FAKE Hindsight.
// The matrix the brief asks for: a program's request, the other founder, a forged or revoked session,
// a changed target, replay, and restart. (The flows themselves are also covered in mcp.test.ts,
// connector.test.ts, connector-proxy.test.ts, voice-intents.test.ts and voice-turn.test.ts.)
import { afterEach, describe, expect, test } from "bun:test";
import { agentOf, cleanup, mehroz, revokedOf, setup, telegramOf, telegramReply, usman } from "./testing/harness";
import type { Principal } from "./types";
import { readFileSync } from "node:fs";
import { join } from "node:path";
const read = (vault: string, rel: string) => readFileSync(join(vault, rel), "utf8");

afterEach(cleanup);
const T = { timeout: 30_000 };

async function memoryWithAsk(h: Awaited<ReturnType<typeof setup>>, who: Principal, text: string) {
  const m = await h.api.remember(usman, { text, channel: "voice" });
  if (!m.ok) throw new Error(m.message);
  const ask = await h.api.forget(who, { kind: "memory", target: m.memory.id });
  if (ask.ok || !ask.approval) throw new Error("expected approval-required");
  return { id: m.memory.id, approvalId: ask.approval.id, ask };
}

describe("Track 6 · who can approve a forget", () => {
  test(
    "a person's own request: their session's card approves it; the other founder's own session card may too (one shared pool); a program, a forged nonce or another session's card can't",
    async () => {
      const h = await setup();
      const a = await memoryWithAsk(h, usman, "The synthetic Kookaburra account pays on the 5th.");
      expect(a.ask.approval?.approve_with).toBe("button");
      // A program has no browser session: no card, no grant.
      expect(h.api.approvals.card(a.approvalId, agentOf(usman))).toBeNull();
      expect((await h.api.approvals.grant(a.approvalId, agentOf(usman), "ui", { cardNonce: "00000000-0000-4000-8000-000000000000" })).ok).toBe(false);
      // Forged: a nonce nobody issued.
      expect((await h.api.approvals.grant(a.approvalId, usman, "ui", { cardNonce: "11111111-1111-4111-8111-111111111111" })).ok).toBe(false);
      // Another session's card: a nonce issued to Usman's session can't be used from a second session of his.
      const card = h.api.approvals.card(a.approvalId, usman)!;
      const otherSession: Principal = { ...usman, os: { ...usman.os!, sessionId: "sess-usman-99999999" } };
      expect((await h.api.approvals.grant(a.approvalId, otherSession, "ui", { cardNonce: card.cardNonce })).ok).toBe(false);
      // (That try spent the nonce: a card is single use, even a misused one.)
      expect((await h.api.approvals.grant(a.approvalId, usman, "ui", { cardNonce: card.cardNonce })).ok).toBe(false);
      expect(h.bankDocs().has(a.id)).toBe(true);
      // The other founder, in HIS own session with a card rendered to him: approved (equal founders, one pool).
      const g = await h.approveUi(h.api, a.approvalId, mehroz);
      expect(g.ok && g.result.ok).toBe(true);
      expect(h.api.approvals.get(a.approvalId)).toMatchObject({ granted_by: "mehroz", granted_via: "ui", state: "consumed" });
      expect(h.bankDocs().has(a.id)).toBe(false);
    },
    T,
  );

  test("a revoked session: a card issued before the revocation no longer approves anything", async () => {
    const h = await setup();
    const a = await memoryWithAsk(h, usman, "The synthetic Lorikeet desk closes at 3pm.");
    const card = h.api.approvals.card(a.approvalId, usman)!;
    // B1 no longer vouches this browser as a human session (the session was revoked): same person, no session.
    const r = await h.api.approvals.grant(a.approvalId, revokedOf(usman), "ui", { cardNonce: card.cardNonce });
    expect(r.ok).toBe(false);
    expect(h.api.approvals.card(a.approvalId, revokedOf(usman))).toBeNull();
    expect(h.bankDocs().has(a.id)).toBe(true);
    expect(h.api.approvals.get(a.approvalId)?.state).toBe("pending");
  });

  test("a program's request and the other founder: Mehroz's Telegram can't answer Usman's code, and his click can't answer a program at all", async () => {
    const h = await setup();
    const a = await memoryWithAsk(h, agentOf(usman), "The synthetic Currawong clinic opens at 7.");
    expect(a.ask.approval).toMatchObject({ requested_actor: "process", approve_with: "voice-or-telegram", telegram: "sending" });
    await Promise.resolve();
    expect(h.api.approvals.get(a.approvalId)?.telegram).toBe("sent"); // only once the send finished
    expect(h.telegram.map((t) => t.personId)).toEqual(["usman"]); // only the requester is messaged
    const code = h.codeFor("usman")!;
    expect(h.api.approvals.card(a.approvalId, mehroz)).toBeNull();
    expect(await telegramReply(h.api, telegramOf(mehroz), `approve ${code}`)).toMatch(/doesn't match|Nothing is waiting/);
    // A Telegram principal that isn't a person's own interactive DM is refused too.
    expect(await telegramReply(h.api, { ...telegramOf(usman), actor: "process" }, `approve ${code}`)).toBeNull();
    expect(h.bankDocs().has(a.id)).toBe(true);
    expect(await telegramReply(h.api, telegramOf(usman), `approve ${code}`)).toContain("Approved and done");
    expect(h.bankDocs().has(a.id)).toBe(false);
  });
});

describe("Track 6 · a program's request approved by voice", () => {
  test(
    "'approve the pending forget': Jarvis reads the program's request back through the ONE question registry; only a spoken yes after it approves, and the server runs it; 'no' refuses it",
    async () => {
      const { handleMemoryUtterance } = await import("./voice-intents");
      const h = await setup();
      const a = await memoryWithAsk(h, agentOf(usman), "The synthetic Pardalote desk opens at 9.");
      const b = await memoryWithAsk(h, agentOf(usman), "The synthetic Firetail courier comes at 2.");
      const voice = { channel: "voice" as const };
      // A typed request can list it but never asks (no question, nothing approvable by typing).
      const typed = await handleMemoryUtterance(h.api, usman, "approve the pending forget", {}, { channel: "ui" });
      expect(typed.pending).toBeNull();
      expect(typed.spoken).toContain("A program acting for Usman asked");
      const early = h.spoken.record("yes"); // said BEFORE the question below
      h.advance(1000);
      const ask = await handleMemoryUtterance(h.api, usman, "approve the pending forget", {}, voice);
      expect(ask.outcome).toBe("needs-confirm");
      expect(ask.spoken).toContain("A program acting for Usman asked");
      expect(ask.spoken).toContain("Pardalote"); // readable, from the store as it is now (the approvals store holds ids only)
      expect(ask.spoken).toContain("1 more after this");
      // A yes said BEFORE the question can't answer it.
      const stale = await handleMemoryUtterance(h.api, usman, "yes", { pending: ask.pending }, { ...voice, spokenYes: () => early?.id ?? null });
      expect(stale.outcome).not.toBe("forgotten");
      expect(h.bankDocs().has(a.id)).toBe(true);
      const again = await handleMemoryUtterance(h.api, usman, "approve the pending forget", {}, voice);
      h.advance(1000);
      const yes = h.spoken.record("yes")!;
      const done = await handleMemoryUtterance(h.api, usman, "yes", { pending: again.pending }, { ...voice, spokenYes: () => yes.id });
      expect(done.outcome).toBe("forgotten");
      expect(h.bankDocs().has(a.id)).toBe(false);
      expect(h.api.approvals.get(a.approvalId)).toMatchObject({ state: "consumed", granted_via: "voice", outcome: "succeeded" });
      // The next one: "no" refuses it.
      const next = await handleMemoryUtterance(h.api, usman, "approve the pending forget", {}, voice);
      expect(next.spoken).toContain("Firetail");
      const no = await handleMemoryUtterance(h.api, usman, "no", { pending: next.pending }, voice);
      expect(no.outcome).toBe("cancelled");
      expect(h.api.approvals.get(b.approvalId)?.state).toBe("rejected");
      expect(h.bankDocs().has(b.id)).toBe(true);
      expect((await handleMemoryUtterance(h.api, usman, "approve the pending forget", {}, voice)).spoken).toBe("Nothing is waiting for approval.");
    },
    T,
  );
});

describe("Track 6 · binding, replay and restart", () => {
  test(
    "a changed target: an approval for one item never forgets another, and the misuse voids it",
    async () => {
      const h = await setup();
      const a = await memoryWithAsk(h, usman, "The synthetic Galah account renews in June.");
      const other = await h.api.remember(usman, { text: "The synthetic Rosella account renews in July.", channel: "voice" });
      if (!other.ok) throw new Error(other.message);
      // Approve it at the approvals layer only (as if the run were cut off), then try to spend it elsewhere.
      const { localApprovals } = await import("./approvals");
      const gate = localApprovals(h.state, { spoken: h.spoken, now: h.clock });
      const raw = gate.card(a.approvalId, usman)!; // cards are per process (memory-only)
      expect(gate.grant(a.approvalId, usman, "ui", { cardNonce: raw.cardNonce }).ok).toBe(true);
      const wrong = await h.api.forget(usman, { kind: "memory", target: other.memory.id, approval_id: a.approvalId });
      expect(!wrong.ok && wrong.code).toBe("approval-denied");
      expect(h.bankDocs().has(other.memory.id)).toBe(true);
      expect(h.api.approvals.get(a.approvalId)?.state).toBe("cancelled"); // voided, not left usable
      const right = await h.api.forget(usman, { kind: "memory", target: a.id, approval_id: a.approvalId });
      expect(right.ok).toBe(false); // the voided approval can't be used for its own item either
      expect(h.bankDocs().has(a.id)).toBe(true);
    },
    T,
  );

  test(
    "restart: a pending program request survives; its old Telegram code can't be checked any more (keys are memory-only), and asking again sends a fresh one that works once",
    async () => {
      const h = await setup();
      const a = await memoryWithAsk(h, agentOf(usman), "The synthetic Magpie courier comes at 11.");
      const oldCode = h.codeFor("usman")!;
      const restarted = h.make(); // a new process: B2's recover() drops code hashes (their key was in memory)
      expect(restarted.approvals.pending().some((x) => x.id === a.approvalId && x.state === "pending")).toBe(true);
      expect(await telegramReply(restarted, telegramOf(usman), `approve ${oldCode}`)).toMatch(/doesn't match|Nothing is waiting/);
      expect(h.bankDocs().has(a.id)).toBe(true);
      // The agent asks again: the same pending approval, a fresh code to the owner's DM.
      const again = await restarted.forget(agentOf(usman), { kind: "memory", target: a.id });
      expect(!again.ok && again.approval?.id).toBe(a.approvalId);
      const fresh = h.codeFor("usman")!;
      expect(await telegramReply(restarted, telegramOf(usman), `approve ${fresh}`)).toContain("Approved and done");
      expect(h.bankDocs().has(a.id)).toBe(false);
      // Replay after use, and after another restart: nothing.
      expect(await telegramReply(h.make(), telegramOf(usman), `approve ${fresh}`)).toMatch(/doesn't match|Nothing is waiting/);
      expect(h.make().approvals.get(a.approvalId)).toMatchObject({ state: "consumed", granted_via: "telegram", outcome: "succeeded" });
    },
    T,
  );

  test("REVIEW-T6 finding 1: brute force. 248 wrong codes: 3 misses void the code and lock guessing; the right code then approves nothing; a spoken yes still can", async () => {
    const h = await setup();
    const a = await memoryWithAsk(h, agentOf(usman), "The synthetic Willet desk opens at 8.");
    const code = h.codeFor("usman")!;
    expect(code).toMatch(/^[2-9A-HJ-NP-TV-Z]{4}-[2-9A-HJ-NP-TV-Z]{4}$/); // 8 characters, unambiguous alphabet
    const guesses: string[] = [];
    for (let i = 0; guesses.length < 248; i++) {
      const g = `${"23456789ABCDEFGH"[i % 16]}${"JKMNPQRS"[(i >> 4) % 8]}AA-BBBB`;
      if (g !== code) guesses.push(g);
    }
    const replies: string[] = [];
    for (const g of guesses) replies.push((await telegramReply(h.api, telegramOf(usman), `approve ${g}`)) ?? "");
    expect(replies[0]).toContain("(1/3)");
    expect(replies[2]).toContain("your waiting codes are now void");
    expect(replies.slice(3).every((r) => r.includes("codes are paused"))).toBe(true);
    // The right code now approves nothing: the code is void and guessing is locked.
    expect(await telegramReply(h.api, telegramOf(usman), `approve ${code}`)).toContain("codes are paused");
    expect(h.api.approvals.get(a.approvalId)?.state).toBe("pending");
    expect(h.bankDocs().has(a.id)).toBe(true);
    // After the window the lock lifts, but the old code stays void (a miss); asking again sends a fresh one.
    h.advance(16 * 60_000);
    expect(await telegramReply(h.api, telegramOf(usman), `approve ${code}`)).toMatch(/doesn't match|Nothing is waiting/);
    await h.api.forget(agentOf(usman), { kind: "memory", target: a.id });
    const fresh = h.codeFor("usman")!;
    expect(fresh).not.toBe(code);
    expect(await telegramReply(h.api, telegramOf(usman), `approve ${fresh}`)).toContain("Approved and done");
    expect(h.bankDocs().has(a.id)).toBe(false);
  });

  test("a wrong code through B2's decide still counts per approval: three reject it", async () => {
    const h = await setup();
    const a = await memoryWithAsk(h, agentOf(usman), "The synthetic Sanderling desk opens at 8.");
    const code = h.codeFor("usman")!;
    const wrong = code === "ZZZZ-9999" ? "YYYY-8888" : "ZZZZ-9999";
    for (let i = 0; i < 3; i++) await h.api.approvals.grant(a.approvalId, telegramOf(usman), "telegram", { telegramCode: wrong });
    expect(h.api.approvals.get(a.approvalId)?.state).toBe("rejected");
    expect(h.bankDocs().has(a.id)).toBe(true);
  });

  test("ordinary Telegram text is never taken for a code (no miss): 'approve payments', 'yes everyone'", async () => {
    const h = await setup();
    await memoryWithAsk(h, agentOf(usman), "The synthetic Knot desk opens at 8.");
    for (const text of ["approve payments", "yes everyone", "approve K7PQM4XZ", "approve the pending forget"]) expect(await telegramReply(h.api, telegramOf(usman), text)).toBeNull();
    const code = h.codeFor("usman")!;
    expect(await telegramReply(h.api, telegramOf(usman), `approve ${code.toLowerCase().replace("-", " ")}`)).toContain("Approved and done"); // case and a space are fine
  });
});

describe("REVIEW-T6 should-fix items", () => {
  test(
    "finding 4 (S2 merged): 'yes, forget it' doesn't dead-end: Jarvis re-asks, and a plain spoken yes then approves",
    async () => {
      const { handleMemoryUtterance } = await import("./voice-intents");
      const h = await setup();
      const m = await h.api.remember(usman, { text: "The synthetic Oriole desk opens at 7.", channel: "voice" });
      if (!m.ok) throw new Error(m.message);
      const voice = { channel: "voice" as const };
      const ask = await handleMemoryUtterance(h.api, usman, "forget that", { lastFactsUsed: [m.memory.id] }, voice);
      expect(ask.outcome).toBe("needs-confirm");
      h.advance(1000);
      // S2's ledger: "yes, forget it" is not a whole-utterance yes; it records nothing and closes the question.
      expect(h.spoken.record("yes, forget it")).toBeNull();
      const odd = await handleMemoryUtterance(h.api, usman, "yes, forget it", { pending: ask.pending }, { ...voice, spokenYes: () => null });
      expect(odd.outcome).toBe("needs-confirm");
      expect(odd.spoken).toContain('just say "yes"');
      expect(h.bankDocs().has(m.memory.id)).toBe(true);
      h.advance(1000);
      const yes = h.spoken.record("yes")!; // stamped with the question Jarvis just re-asked
      const done = await handleMemoryUtterance(h.api, usman, "yes", { pending: odd.pending }, { ...voice, spokenYes: () => yes.id });
      expect(done.outcome).toBe("forgotten");
      expect(h.bankDocs().has(m.memory.id)).toBe(false);
    },
    T,
  );

  test("finding 5: a spoken yes counts only from a person; a question is never put to a program", async () => {
    const h = await setup();
    const a = await memoryWithAsk(h, usman, "The synthetic Rail desk opens at 6.");
    expect(h.api.approvals.ask(a.approvalId, agentOf(usman))).toBeNull();
    const q = h.api.approvals.ask(a.approvalId, usman)!;
    h.advance(1000);
    const yes = h.spoken.record("yes")!;
    const byProgram = await h.api.approvals.grant(a.approvalId, agentOf(usman), "voice", { spokenYes: yes.id, questionId: q.questionId });
    expect(byProgram.ok).toBe(false);
    expect(h.bankDocs().has(a.id)).toBe(true);
  });

  test("finding 6: a section forget stores a hash of the heading, never its words, and still runs", async () => {
    const h = await setup();
    await h.api.sync({ force: true });
    const rel = "wiki/topics/business/receptionist-playbook.md";
    const ask = await h.api.forget(usman, { kind: "full", target: rel, heading: "Escalation" });
    if (ask.ok || !ask.approval) throw new Error("expected approval-required");
    const stored = h.api.approvals.get(ask.approval.id)!;
    expect(stored.target).toMatch(/#h-[0-9a-f]{16}$/);
    expect(JSON.stringify(stored)).not.toMatch(/Escalation|duty dentist/i);
    const g = await h.approveUi(h.api, ask.approval.id, usman);
    expect(g.ok && g.result.ok).toBe(true);
    expect(read(h.vault, rel)).not.toContain("duty dentist");
    expect(JSON.stringify(h.api.approvals.get(ask.approval.id))).not.toMatch(/Escalation/i);
  });

  test("finding 7: a mismatched forget from a program doesn't cancel a person's approval; the person's own does", async () => {
    const h = await setup();
    const a = await memoryWithAsk(h, usman, "The synthetic Coot desk opens at 5.");
    const other = await h.api.remember(usman, { text: "The synthetic Moorhen courier comes at 3.", channel: "voice" });
    if (!other.ok) throw new Error(other.message);
    const byProgram = await h.api.forget(agentOf(usman), { kind: "memory", target: other.memory.id, approval_id: a.approvalId });
    expect(!byProgram.ok && byProgram.code).toBe("approval-denied");
    expect(h.api.approvals.get(a.approvalId)?.state).toBe("pending"); // untouched
    const byPerson = await h.api.forget(usman, { kind: "memory", target: other.memory.id, approval_id: a.approvalId });
    expect(!byPerson.ok && byPerson.code).toBe("approval-denied");
    expect(h.api.approvals.get(a.approvalId)?.state).toBe("cancelled");
  });
});

describe("REVIEW-T6 R2 follow-ups", () => {
  test("nothing pending: junk codes can't pre-trip anyone's lockout (they're not guesses at anything)", async () => {
    const h = await setup();
    for (let i = 0; i < 10; i++) expect(await telegramReply(h.api, telegramOf(usman), `approve ZZZZ-${"ABCDEFGHJK"[i]}AAA`)).toContain("Nothing is waiting");
    expect(h.api.approvals.lockouts()).toEqual([]);
    // A later genuine request still works with its code.
    const a = await memoryWithAsk(h, agentOf(usman), "The synthetic Pipit desk opens at 9.");
    expect(await telegramReply(h.api, telegramOf(usman), `approve ${h.codeFor("usman")}`)).toContain("Approved and done");
    expect(h.bankDocs().has(a.id)).toBe(false);
  });

  test("a lockout is told to the person whose codes are paused (their own DM, once) and shown on the Memory page", async () => {
    const h = await setup();
    await memoryWithAsk(h, agentOf(usman), "The synthetic Robin desk opens at 9.");
    const told: { personId: string; text: string }[] = [];
    const notify = (personId: string, text: string) => void told.push({ personId, text });
    for (let i = 0; i < 5; i++) await telegramReply(h.api, telegramOf(usman), `approve YYYY-${"ABCDE"[i]}AAA`, notify);
    expect(told).toHaveLength(1);
    expect(told[0].personId).toBe("usman");
    expect(told[0].text).toContain("paused until");
    expect(told[0].text).toContain("saying yes to Jarvis");
    const locks = h.api.approvals.lockouts();
    expect(locks).toMatchObject([{ personId: "usman", misses: 3 }]);
    const { memoryMiddleware } = await import("./plugin");
    const mw = memoryMiddleware({ api: () => h.api, principalFor: () => usman });
    const status = await new Promise<any>((resolve) =>
      mw(
        { method: "GET", url: "/status", headers: { host: "localhost:8081" }, socket: { remoteAddress: "127.0.0.1" } } as never,
        { statusCode: 200, setHeader() {}, end(b: string) { resolve(JSON.parse(b)); } } as never,
        () => resolve(null),
      ),
    );
    expect(status.code_lockouts).toMatchObject([{ personId: "usman", misses: 3 }]);
  });
});
