import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  outcomeFrom,
  runVerifier,
  sanitizeAuditEntry,
  sha256Hex,
  targetOf,
  auditTarget,
  sha256Sync,
  type AuditEntry,
  type ControlVerifier,
} from "../src/lib/control-outcome";
import { formatControlResult, gateControlTask, runControlTask, type ControlApproval } from "../src/lib/jarvis-control";
import { auditDir, createAuditLog } from "./control-audit";
import { fileContentVerifier, sha256OfText } from "./control-verifiers";

let dir = "";
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "jarvis-control-p0-"));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const verifier = (status: "passed" | "failed" | "inconclusive", delayMs = 0): ControlVerifier => ({
  name: "fake",
  verify: () => new Promise((r) => setTimeout(() => r({ status, detail: `fake ${status}` }), delayMs)),
});
const hang: ControlVerifier = { name: "hang", verify: () => new Promise(() => undefined) };
const signal = () => new AbortController().signal;
const yes = (task: string): ControlApproval => {
  const now = Date.now();
  const decision = gateControlTask({ task, confirmed: true, pending: { task, at: now }, lastUserUtterance: "yes", now });
  if (decision.action !== "run") throw new Error("Synthetic approval refused");
  return decision.approval;
};

describe("outcome states", () => {
  test("ran with no check is unverified, never success", () => {
    expect(outcomeFrom({ executed: "ok" })).toBe("unverified");
    expect(outcomeFrom({ executed: "ok", verification: null })).toBe("unverified");
  });
  test("the mapping", () => {
    const v = (status: "passed" | "failed" | "inconclusive") => ({ verifier: "x", status, detail: "", ms: 1 });
    expect(outcomeFrom({ executed: "ok", verification: v("passed") })).toBe("success");
    expect(outcomeFrom({ executed: "ok", verification: v("failed") })).toBe("failed");
    expect(outcomeFrom({ executed: "ok", verification: v("inconclusive") })).toBe("unverified");
    expect(outcomeFrom({ executed: "failed", verification: v("passed") })).toBe("failed");
    expect(outcomeFrom({ executed: "cancelled", verification: v("passed") })).toBe("cancelled");
  });
  test("a verification timeout is inconclusive, so the run is unverified (never coerced to success)", async () => {
    const r = await runVerifier(hang, { timeoutMs: 30 });
    expect(r.status).toBe("inconclusive");
    expect(r.detail).toMatch(/timed out/);
    expect(outcomeFrom({ executed: "ok", verification: r })).toBe("unverified");
  });
  test("a verifier that throws is inconclusive", async () => {
    const r = await runVerifier({ name: "boom", verify: async () => { throw new TypeError("nope"); } });
    expect(r.status).toBe("inconclusive");
  });
  test("an unverified result never reads as done", () => {
    const said = formatControlResult({ outcome: "unverified", report: "I saved the file. All done!" });
    expect(said).toMatch(/^Unverified: /);
    expect(formatControlResult({ outcome: "success", report: "Saved.", verification: { verifier: "file-content", status: "passed", detail: "sha256 matches (10 bytes)", ms: 1 } })).toMatch(/^Verified done/);
  });
});

describe("runControlTask", () => {
  const exec = (reply: string) => {
    const calls: string[] = [];
    return { calls, execute: async (task: string) => (calls.push(task), reply) };
  };

  test("Hermes' narration alone is unverified", async () => {
    const { execute } = exec("Opened Notepad and saved the note.");
    const r = await runControlTask("Open Notepad", { signal: signal(), session: {}, approval: null, execute });
    expect(r).toMatchObject({ kind: "result", outcome: "unverified", tier: "local-reversible" });
    if (r.kind === "result") expect(r.said).toMatch(/^Unverified/);
  });
  test("a passing independent check makes it success; a failing one, failed", async () => {
    const pass = await runControlTask("Open Notepad", { signal: signal(), session: {}, approval: null, execute: exec("done").execute, verifier: verifier("passed") });
    const fail = await runControlTask("Open Notepad", { signal: signal(), session: {}, approval: null, execute: exec("done").execute, verifier: verifier("failed") });
    const slow = await runControlTask("Open Notepad", { signal: signal(), session: {}, approval: null, execute: exec("done").execute, verifier: hang, verifyTimeoutMs: 20 });
    expect([pass, fail, slow].map((r) => (r.kind === "result" ? r.outcome : r.kind))).toEqual(["success", "failed", "unverified"]);
  });
  test("Hermes' own failure is failed, and the verifier isn't even asked", async () => {
    let asked = false;
    const r = await runControlTask("Open Notepad", {
      signal: signal(),
      session: {},
      approval: null,
      execute: exec("Hermes could not start the task (status 500). Nothing was done.").execute,
      verifier: { name: "x", verify: async () => ((asked = true), { status: "passed", detail: "" }) },
    });
    expect(r).toMatchObject({ outcome: "failed" });
    expect(asked).toBe(false);
  });
  test("an abort is cancelled", async () => {
    const c = new AbortController();
    const r = await runControlTask("Open Notepad", {
      signal: c.signal,
      session: {},
      approval: null,
      execute: async () => {
        c.abort();
        const e = new Error("aborted");
        e.name = "AbortError";
        throw e;
      },
    });
    expect(r).toMatchObject({ outcome: "cancelled" });
  });
  test("external-effect without a spoken yes is refused before the executor runs", async () => {
    const { calls, execute } = exec("sent");
    const entries: AuditEntry[] = [];
    const r = await runControlTask("email Brooke the draft", { signal: signal(), session: {}, approval: null, execute, audit: (e) => void entries.push(e) });
    expect(calls).toEqual([]);
    expect(r).toMatchObject({ outcome: "failed", tier: "external-effect" });
    expect(entries).toMatchObject([{ action: "control_pc", outcome: "refused", tier: "external-effect", approval: "none" }]);
    const ok = await runControlTask("email Brooke the draft", { signal: signal(), session: {}, approval: yes("email Brooke the draft"), execute });
    expect(calls).toEqual(["email Brooke the draft"]);
    expect(ok).toMatchObject({ outcome: "unverified" });
  });
  test("dry run: the planned steps and tier, the executor never runs, one preview audit entry", async () => {
    const { calls, execute } = exec("should not run");
    const entries: AuditEntry[] = [];
    const r = await runControlTask("Open Notepad, type hello, then empty the recycle bin", {
      signal: signal(),
      session: {},
      approval: yes("Open Notepad, type hello, then empty the recycle bin"),
      execute,
      dryRun: true,
      audit: (e) => void entries.push(e),
    });
    expect(calls).toEqual([]);
    expect(r.kind).toBe("preview");
    if (r.kind === "preview") {
      expect(r.plan.tier).toBe("external-effect");
      expect(r.plan.steps).toHaveLength(3);
      expect(r.said).toMatch(/^Preview only/);
    }
    expect(entries).toMatchObject([{ action: "preview", outcome: "preview", tier: "external-effect", target: "Notepad" }]);
  });
  test("a failing audit sink is flagged, not silently swallowed", async () => {
    const r = await runControlTask("Open Notepad", { signal: signal(), session: {}, approval: null, execute: exec("ok").execute, audit: () => { throw new Error("disk full"); } });
    expect(r).toMatchObject({ auditFailed: true });
  });
});

describe("file-content verifier", () => {
  test("passes on a matching file, normalising CRLF and a BOM, and never exposes the content", async () => {
    const text = "M&U demo note — synthetic — 2026-09-27T00:00:00Z\nline two";
    const path = join(dir, "note.txt");
    writeFileSync(path, "\uFEFF" + text.replace(/\n/g, "\r\n"), "utf8");
    const r = await runVerifier(fileContentVerifier({ path, expectedSha256: sha256OfText(text) }));
    expect(r.status).toBe("passed");
    expect(r.detail).not.toContain("synthetic");
    expect(r.detail).toMatch(/sha256 matches/);
  });
  test("fails on different content or a missing file", async () => {
    const path = join(dir, "other.txt");
    writeFileSync(path, "something else", "utf8");
    expect((await runVerifier(fileContentVerifier({ path, expectedSha256: sha256OfText("expected") }))).status).toBe("failed");
    expect((await runVerifier(fileContentVerifier({ path: join(dir, "nope.txt"), expectedSha256: sha256OfText("x") }))).detail).toBe("file missing");
  });
  test("a bad expected hash is inconclusive", async () => {
    expect((await runVerifier(fileContentVerifier({ path: join(dir, "note.txt"), expectedSha256: "nothex" }))).status).toBe("inconclusive");
  });
  test("the WebCrypto and node hashes agree", async () => {
    expect(await sha256Hex("hello\nworld")).toBe(sha256OfText("hello\r\nworld"));
  });
});

describe("audit log", () => {
  const SECRET = "PII-MARKER-7f3a synthetic note text";
  test("append-only JSONL with metadata only: no typed text, no task text, no transcript", async () => {
    const log = createAuditLog({ dir: join(dir, "audit") });
    const typedSha256 = await sha256Hex(SECRET);
    log.append({
      ts: "2026-09-27T01:02:03.000Z",
      taskId: "t_abcdef123456",
      action: "type",
      target: "D:\\tmp\\jarvis-demo\\note-1.txt",
      tier: "local-reversible",
      approval: "flag",
      jevConfidence: 0.8234,
      outcome: "step-ok",
      typedSha256,
      // Everything below must be dropped.
      text: SECRET,
      task: `type ${SECRET}`,
      transcript: SECRET,
      screenshot: "data:image/png;base64,AAAA",
    });
    log.append({ ts: "2026-09-27T01:02:04.000Z", taskId: "t_abcdef123456", action: "verify", tier: "local-reversible", approval: "flag", outcome: "success", verifier: "file-content", verification: "passed" });
    const raw = readFileSync(log.files()[0], "utf8");
    expect(raw.split("\n").filter(Boolean)).toHaveLength(2);
    expect(raw).not.toContain("PII-MARKER");
    expect(raw).not.toContain("synthetic note");
    expect(raw).not.toContain("base64");
    expect(raw).not.toContain("jarvis-demo\\\\");
    const [first] = log.read();
    expect(first).toEqual({
      ts: "2026-09-27T01:02:03.000Z",
      taskId: "t_abcdef123456",
      action: "type",
      // A-L4: a file name is hashed (sha256 of the lower-cased basename), never kept in plain text.
      target: `sha256-${sha256Sync("note-1.txt").slice(0, 16)}`,
      tier: "local-reversible",
      approval: "flag",
      jevConfidence: 0.823,
      outcome: "step-ok",
      typedSha256,
    });
    // Appending never rewrites earlier lines.
    log.append({ ts: "2026-09-27T01:02:05.000Z", taskId: "t_abcdef123456", action: "save", tier: "local-reversible", approval: "flag", outcome: "step-ok" });
    expect(readFileSync(log.files()[0], "utf8").startsWith(raw)).toBe(true);
  });
  test("malformed entries are rejected, and a plaintext 'hash' can't sneak through", () => {
    const log = createAuditLog({ dir: join(dir, "audit-2") });
    expect(() => log.append({ taskId: "t_abcdef123456", action: "type" })).toThrow(/rejected/);
    expect(() => log.append({ ts: "now", taskId: "t_abcdef123456", action: "type", tier: "n/a", approval: "none", outcome: "preview" })).toThrow();
    expect(() => log.append({ ts: "2026-09-27T01:02:03.000Z", taskId: "x", action: "type", tier: "n/a", approval: "none", outcome: "preview" })).toThrow();
    const e = sanitizeAuditEntry({ ts: "2026-09-27T01:02:03.000Z", taskId: "t_abcdef123456", action: "type", tier: "n/a", approval: "none", outcome: "preview", typedSha256: SECRET, verifier: SECRET });
    expect(JSON.stringify(e)).not.toContain("PII");
  });
  test("the directory is configurable", () => {
    expect(auditDir("C:\\repo", {})).toBe(join("C:\\repo", ".operator-data", "audit"));
    expect(auditDir("C:\\repo", { JARVIS_AUDIT_DIR: dir })).toBe(dir);
  });
  test("targetOf keeps an allow-listed app word; a path or any other word is hashed (A-L4)", () => {
    expect(targetOf("Open Notepad and type hello")).toBe("Notepad");
    const hashed = targetOf("save it to D:\\tmp\\jarvis-demo\\note-5.txt");
    expect(hashed).toBe(`sha256-${sha256Sync("note-5.txt").slice(0, 16)}`);
    expect(hashed).not.toContain("note");
    expect(targetOf("open C:\\Users\\x\\Patient-Jane-Smith.pdf")).toMatch(/^sha256-[a-f0-9]{16}$/);
    expect(targetOf("open Wollongong")).toMatch(/^sha256-[a-f0-9]{16}$/);
    expect(targetOf("what time is it")).toBeUndefined();
  });
  test("auditTarget is idempotent and keeps app names; sha256Sync matches the standard vectors", () => {
    expect(sha256Sync("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256Sync("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Sync("a".repeat(1000))).toBe("41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3");
    const h = auditTarget("Patient-Jane-Smith.pdf")!;
    expect(h).toMatch(/^sha256-[a-f0-9]{16}$/);
    expect(auditTarget(h)).toBe(h);
    expect(auditTarget("POWERPNT.EXE")).toBe("POWERPNT");
    expect(auditTarget("Calculator")).toBe("Calculator");
    const e = sanitizeAuditEntry({ ts: "2026-09-27T01:02:03.000Z", taskId: "t_abcdef123456", action: "open", tier: "read-only", approval: "none", outcome: "success", target: "Patient-Jane-Smith.pdf" });
    expect(JSON.stringify(e)).not.toMatch(/Jane|Smith|Patient/);
  });
});
