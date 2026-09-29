// scripts/memory/t6-verify-live.ts, the owner-run live verification, run END TO END against a SYNTHETIC
// OS/Hindsight stack (testing/t6-synthetic-os.ts: the real memory routes over a TEMP vault copy and the fake
// Hindsight in proxy mode). Never 8081, the pilot or the real vault. REVIEW-T6 "Post-deploy live verification".
import { afterEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { likelyConflict } from "./derived";
import { BANK, cleanup as cleanupHarness, usman } from "./testing/harness";
import { startSyntheticOs, type SyntheticOs } from "./testing/t6-synthetic-os";
import { cleanupOutcome, cryptoPick, findLeftovers, runFacts, sessionCheck, TAG_PREFIX } from "./t6-verify-lib";

const SCRIPT = join(import.meta.dir, "t6-verify-live.ts");
const stacks: SyntheticOs[] = [];
const temps: string[] = [];
afterEach(async () => {
  for (const s of stacks.splice(0)) await s.stop();
  await cleanupHarness();
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function stack(opts: Parameters<typeof startSyntheticOs>[0]) {
  const s = await startSyntheticOs(opts);
  stacks.push(s);
  return s;
}

/** Runs the script against the synthetic stack; returns its exit code, output and JSON. */
async function verify(s: SyntheticOs) {
  const dir = mkdtempSync(join(tmpdir(), "mu-t6-verify-"));
  temps.push(dir);
  const out = join(dir, "out.json");
  const proxyLog = join(dir, "proxy.jsonl");
  writeFileSync(proxyLog, "");
  const proxyPort = new URL(s.h.fake.url).port;
  const p = Bun.spawn(
    [process.execPath, "--no-env-file", SCRIPT, "--os-port", String(s.port), "--proxy-port", proxyPort, "--bank", BANK, "--vault", s.h.vault, "--proxy-log", proxyLog, "--out", out, "--poll-ms", "40", "--max-wait-ms", "8000"],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  const json = existsSync(out) ? JSON.parse(readFileSync(out, "utf8")) : null;
  return { code, stdout, stderr, json };
}

/** Every approval the synthetic OS ever filed, in any state. */
const approvalsEver = (s: SyntheticOs) => s.h.api.approvals.service().list({ limit: 500 });
const memoriesEver = (s: SyntheticOs) => s.h.api.list({ kind: "memory", includeSuperseded: true });
const testNotes = (s: SyntheticOs) => readdirSync(join(s.h.vault, "wiki", "topics", "general")).filter((f) => f.startsWith("zz-t6-"));
const T = { timeout: 90_000 };

describe("t6-verify-live against a synthetic OS", () => {
  test(
    "an UNCONFIRMED session (S1: a page load's session is a program): part A and the forget checks are skipped with the reason; no forget is sent, no approval filed, no Telegram code; nothing left behind",
    async () => {
      const s = await stack({ session: "pending" });
      const r = await verify(s);
      expect(r.stderr).toBe("");
      expect(r.code).toBe(0);
      expect(r.json.failed).toBe(0);
      expect(r.json.session).toMatchObject({ human: false, actor: "process", pending: true });
      const skipped = r.json.results.filter((x: any) => x.skipped).map((x: any) => x.step);
      expect(skipped).toEqual(["A save", "A receipt", "A recall", "A correction", "A forget b", "C forget c (section)", "C forget c (note)"]);
      for (const x of r.json.results.filter((x: any) => x.skipped)) expect(String(x.observed)).toContain("Telegram code");
      expect(r.stdout).toContain("SKIP  [A forget b]");
      // B (no approvals anywhere) and C's create/delete still ran and passed.
      const passed = r.json.results.filter((x: any) => !x.skipped).map((x: any) => x.step);
      expect(passed).toEqual(expect.arrayContaining(["B create", "B edit", "B rename", "B forget a", "B re-include", "B delete", "C create", "C delete", "receipts", "end state"]));
      // The only forget sent is kind a (unindex), which needs no approval: nothing reached the approval service.
      expect(s.requests.filter((x) => x === "POST /__memory/forget")).toHaveLength(1);
      expect(s.requests.some((x) => x.startsWith("POST /__memory/approvals"))).toBe(false);
      expect(approvalsEver(s)).toHaveLength(0);
      expect(s.h.telegram).toHaveLength(0);
      // Nothing left: no memory saved, no test note, no document in the fake pool, nothing in the JSON.
      expect(memoriesEver(s)).toHaveLength(0);
      expect(testNotes(s)).toEqual([]);
      expect([...s.h.bankDocs().values()].filter((d) => d.content.includes(r.json.run))).toHaveLength(0);
      expect(r.json.leftovers).toEqual([]);
      expect(r.stdout).toContain("checks passed; 7 skipped (this session isn't a confirmed person");
    },
    T,
  );

  test(
    "a CONFIRMED person's session: the full path runs (forget b and both forget c's approved with the page's button, as his own request), no Telegram code; a second run's facts don't collide with the first",
    async () => {
      const s = await stack({ session: "confirmed" });
      const first = await verify(s);
      expect(first.stderr).toBe("");
      expect(first.json.results.filter((x: any) => !x.ok)).toEqual([]);
      expect(first.code).toBe(0);
      expect(first.json.skipped).toBe(0);
      expect(first.json.session).toMatchObject({ human: true, actor: "human" });
      const steps = first.json.results.map((x: any) => x.step);
      expect(steps).toEqual(expect.arrayContaining(["A save", "A receipt", "A recall", "A correction", "A forget b", "C forget c (section)", "C forget c (note)"]));
      // Three forgets, each a person's own request approved on the card; nothing for Telegram.
      const ever = approvalsEver(s);
      expect(ever).toHaveLength(3);
      expect(ever.every((a: any) => a.state === "consumed")).toBe(true);
      expect(s.h.telegram).toHaveLength(0);
      expect(first.json.leftovers).toEqual([]);
      expect(memoriesEver(s)).toHaveLength(0);
      expect(testNotes(s)).toEqual([]);

      // Runs 2 and 3 used to fail at "[A save]" as a contradiction of an earlier run's fact. A second run on the
      // same store (now clean) passes too, with different wording.
      const second = await verify(s);
      expect(second.json.results.filter((x: any) => !x.ok)).toEqual([]);
      expect(second.code).toBe(0);
      expect(second.json.run).not.toBe(first.json.run);
    },
    { timeout: 150_000 },
  );

  test(
    "PREFLIGHT: an earlier run's leftover (a memory and its superseded version, plus a zz-t6 note) stops the run before anything is saved, listing them",
    async () => {
      const s = await stack({ session: "confirmed" });
      // Run 1's leftovers as the review found them: a current memory whose older version is superseded.
      const old = runFacts("aae97a", cryptoPick((n) => randomBytes(n)));
      const v1 = await s.h.api.remember(usman, { text: old.fact });
      if (!v1.ok) throw new Error(v1.message);
      const v2 = await s.h.api.correct(usman, v1.memory.id, { text: old.fixed });
      if (!v2.ok) throw new Error(v2.message);
      writeFileSync(join(s.h.vault, "wiki", "topics", "general", "zz-t6-forget-check-aae97a.md"), "# T6 live check aae97a forget\n\nleft behind\n");
      const before = memoriesEver(s).length;
      const docsBefore = s.h.bankDocs().size;
      const r = await verify(s);
      expect(r.code).toBe(1);
      const pre = r.json.results.find((x: any) => x.step === "preflight");
      expect(pre.ok).toBe(false);
      expect(pre.what).toContain("stopped before saving anything");
      const ids = r.json.preflight_leftovers.map((l: any) => l.id);
      expect(ids).toEqual(expect.arrayContaining([v1.memory.id, v2.id, "wiki/topics/general/zz-t6-forget-check-aae97a.md"]));
      expect(r.json.preflight_leftovers.find((l: any) => l.id === v1.memory.id).status).toBe("superseded");
      // Nothing after the preflight ran: no save, no note, no forget, no approval.
      expect(r.json.results.map((x: any) => x.step)).toEqual(["setup", "setup", "setup", "setup", "setup", "preflight"]);
      expect(memoriesEver(s).length).toBe(before);
      expect(s.h.bankDocs().size).toBe(docsBefore);
      expect(s.requests.some((x) => x === "POST /__memory/remember" || x === "POST /__memory/forget")).toBe(false);
      expect(approvalsEver(s)).toHaveLength(0);
      expect(testNotes(s)).toEqual(["zz-t6-forget-check-aae97a.md"]);
      expect(r.json.leftovers).toEqual([]);
    },
    T,
  );

  test(
    "HONEST CLEAN-UP: a forget left unapproved (202) is reported as NEEDS APPROVAL with its approval id, never as removed, and goes into the JSON's leftovers",
    async () => {
      const s = await stack({ session: "confirmed", refuseCards: true });
      const r = await verify(s);
      expect(r.code).toBe(1);
      const left = r.json.leftovers;
      const mems = memoriesEver(s).map((m) => m.id);
      expect(mems.length).toBe(2);
      expect(left.map((l: any) => l.target).sort()).toEqual([...mems].sort());
      expect(left.every((l: any) => l.state === "needs-approval" && /approval/.test(l.detail) && !!l.approval_id)).toBe(true);
      expect(r.stdout).toContain("NEEDS APPROVAL");
      expect(r.stdout).not.toMatch(/cleanup: mem-[0-9a-f]+: removed/);
      expect(r.stdout).toContain('FAIL  [clean-up] 2 item(s) from this run are still there; see "leftovers" in the JSON');
      // The unapproved asks were the person's own (no Telegram code), and the test notes were deleted anyway.
      expect(s.h.telegram).toHaveLength(0);
      expect(testNotes(s)).toEqual([]);
    },
    T,
  );
});

describe("t6-verify-lib", () => {
  test("two runs' facts never look like a contradiction (likelyConflict), whatever words are drawn", () => {
    // Seeded, so the test is the same every time.
    let seed = 12345;
    const pick = (n: number) => ((seed = (seed * 48271) % 2147483647), seed % n);
    const runs = Array.from({ length: 150 }, (_, i) => runFacts((0x100000 + i * 7919).toString(16), pick));
    for (let i = 0; i < runs.length; i++)
      for (let j = i + 1; j < runs.length; j++)
        for (const a of [runs[i].fact, runs[i].fixed]) for (const b of [runs[j].fact, runs[j].fixed]) expect(likelyConflict(a, b)).toBe(false);
    // The worst case: every drawn word the same (only the run id differs) still stays below the threshold.
    const same = () => 0;
    const x = runFacts("aae97a", same), y = runFacts("bbf01c", same);
    for (const a of [x.fact, x.fixed]) for (const b of [y.fact, y.fixed]) expect(likelyConflict(a, b)).toBe(false);
    // Inside one run, the correction is (by design) the same subject: /correct files it as one chain.
    expect(x.fact).toContain(`${TAG_PREFIX} aae97a:`);
    expect(x.fixed).not.toBe(x.fact);
    // The old wording (7am vs 8am, only the run id differing) did collide: the bug this replaces.
    expect(likelyConflict("T6 live check aae97a: the synthetic Verifieraae97a clinic opens at 8am on weekdays.", "T6 live check 1b2c3d: the synthetic Verifier1b2c3d clinic opens at 7am on weekdays.")).toBe(true);
  });

  test("sessionCheck: only a confirmed human session counts; pending, a program or no answer is not human", () => {
    expect(sessionCheck(200, { principal: { actor: "human" }, hubSession: { pending: false } }).human).toBe(true);
    expect(sessionCheck(200, { principal: { actor: "human" }, hubSession: null }).human).toBe(true);
    const pending = sessionCheck(200, { principal: { actor: "process" }, hubSession: { pending: true } });
    expect(pending).toMatchObject({ human: false, pending: true });
    expect(pending.reason).toContain("Telegram code");
    expect(sessionCheck(200, { principal: { actor: "process" }, hubSession: { pending: false } }).human).toBe(false);
    expect(sessionCheck(200, { principal: { actor: "human" }, hubSession: { pending: true } }).human).toBe(false);
    expect(sessionCheck(200, { principal: null }).human).toBe(false);
    expect(sessionCheck(404, "Not found").human).toBe(false);
  });

  test("findLeftovers: tagged rows (any status) and zz-t6 notes; nothing else", () => {
    const rows = [
      { id: "mem-1", kind: "memory", status: "current", text: `${TAG_PREFIX} aae97a: x`, title: "x", source: { kind: "memory" } },
      { id: "mem-0", kind: "memory", status: "superseded", text: `${TAG_PREFIX} aae97a: y`, title: "y", source: { kind: "memory" } },
      { id: "n-1", kind: "note", status: "current", text: "z", title: "z", source: { kind: "vault", path: "wiki/topics/general/zz-t6-sync-check-aae97a.md" } },
      { id: "mem-2", kind: "memory", status: "current", text: "The dental clinic opens at 8am.", title: "clinic", source: { kind: "memory" } },
    ];
    const l = findLeftovers(rows, ["wiki/topics/general/zz-t6-sync-check-aae97a.md", "wiki/topics/general/zz-t6-forget-check-aae97a.md"]);
    expect(l.map((x) => x.id)).toEqual(["mem-1", "mem-0", "n-1", "wiki/topics/general/zz-t6-forget-check-aae97a.md"]);
  });

  test("cleanupOutcome: 200 is removed; 202 is needs-approval (with its id); not asked is needs-approval; anything else failed", () => {
    expect(cleanupOutcome("mem-1", { asked: true, ask: { status: 202 }, done: { status: 200, body: { message: "Deleted" } } }).state).toBe("removed");
    const pending = cleanupOutcome("mem-1", { asked: true, ask: { status: 202, body: { message: "This needs approval first.", approval: { id: "apr-1", requested_actor: "process" } } }, done: null });
    expect(pending).toMatchObject({ state: "needs-approval", approval_id: "apr-1" });
    expect(pending.detail).toContain("202");
    expect(cleanupOutcome("mem-1", { asked: false }).state).toBe("needs-approval");
    expect(cleanupOutcome("mem-1", { asked: true, ask: { status: 422, body: { code: "not-found" } } }).state).toBe("removed");
    expect(cleanupOutcome("mem-1", { asked: true, ask: { status: 403, body: { error: "Refresh this page" } } }).state).toBe("failed");
    expect(cleanupOutcome("mem-1", null).state).toBe("failed");
  });
});
