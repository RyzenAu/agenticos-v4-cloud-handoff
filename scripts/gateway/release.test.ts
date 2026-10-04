import { afterAll, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { argsDigest } from "../approvals/canonical";
import { ApprovalService } from "../approvals/service";
import { answerTelegramCode, registerTelegramCodeHandler } from "../approvals/telegram-codes";
import { pageTokenFor, type Principal } from "../identity/principal";
import { SpokenConfirmationLedger } from "../jarvis-execution/voice-confirmation";
import { createGatewayRoutes } from "./hub-plugin";
import { createReleaseDesk, porcelainPaths, RELEASE_ACTION, RELEASE_BUNDLE_MAX_BYTES, RELEASE_REQUESTS_PER_HOUR, RELEASE_STALE_LAUNCH_MS, releaseCodeHandler, type ReleaseDesk, type ReleaseReceiptRow, type ReleaseRunner } from "./release";

/**
 * The release workflow with a FAKE runner (no release script is ever started): a real temp git repository as the hub's
 * live checkout, the real approvals service, the real Telegram-code path the owner answers with, and Dot's route.
 * Before the owner's approval NOTHING reaches the live checkout: the bundle is checked in a throwaway repository.
 */

setDefaultTimeout(120_000);

const base = mkdtempSync(join(tmpdir(), "gw-release-"));
afterAll(() => {
  try {
    rmSync(base, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  } catch {
    /* Windows may hold a handle briefly */
  }
});
const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync("git", ["-C", cwd, "-c", "user.email=test@example.test", "-c", "user.name=Synthetic", ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};
const commit = (cwd: string, file: string, text: string, message = `change ${file}`) => {
  writeFileSync(join(cwd, file), text);
  git(cwd, "add", file);
  git(cwd, "commit", "-q", "-m", message);
  return git(cwd, "rev-parse", "HEAD");
};
/** Everything git holds for the live checkout: every object and every ref. */
const liveState = (live: string) => ({ objects: git(live, "count-objects", "-v"), refs: git(live, "for-each-ref", "--format=%(refname) %(objectname)") });

type World = { skew: { value: number }; root: string; live: string; dev: string; gwDir: string; scratch: string; desk: ReleaseDesk; approvals: ApprovalService; codes: string[]; messages: string[]; launched: Array<{ sha: string; tag: string; candidateRef: string }>; receipts: ReleaseReceiptRow[]; alive: { value: boolean }; enabled: { value: boolean }; runner: { impl: ReleaseRunner | null }; unregister: () => void };
let n = 0;
function world(): World {
  const root = join(base, `w${++n}`);
  const live = join(root, "live");
  const dev = join(root, "dev");
  const gwDir = join(root, "gateway");
  const scratch = join(base, `scratch-${n}`);
  mkdirSync(live, { recursive: true });
  git(live, "init", "-q", "-b", "main");
  git(live, "config", "core.autocrlf", "false");
  commit(live, "a.txt", "one\n");
  spawnSync("git", ["clone", "-q", live, dev]);
  const approvals = new ApprovalService({ path: join(root, "approvals.sqlite"), spoken: new SpokenConfirmationLedger() });
  const codes: string[] = [];
  const messages: string[] = [];
  const launched: World["launched"] = [];
  const receipts: ReleaseReceiptRow[] = [];
  const alive = { value: true };
  const enabled = { value: true };
  const skew = { value: 0 };
  const runner: World["runner"] = { impl: null };
  const desk = createReleaseDesk({
    dir: gwDir,
    repo: live,
    scratch,
    enabled: () => enabled.value,
    approvals: () => approvals as never,
    argsDigest,
    runner: (input) => (runner.impl ? runner.impl(input) : (launched.push({ sha: input.sha, tag: input.tag, candidateRef: input.candidateRef }), { pid: 4242 })),
    receipts: () => receipts,
    notifyOwner: (text) => void (messages.push(text), codes.push(/approve ([2-9A-HJ-NP-TV-Z]{4}-[2-9A-HJ-NP-TV-Z]{4})/.exec(text)?.[1] ?? "")),
    alive: () => alive.value,
    now: () => Date.now() + skew.value,
  });
  const unregister = registerTelegramCodeHandler(releaseCodeHandler(desk, () => approvals as never));
  return { skew, root, live, dev, gwDir, scratch, desk, approvals, codes, messages, launched, receipts, alive, enabled, runner, unregister };
}
/** Dot's bundle of the new commits only (live head .. dev branch). */
const bundleOf = (w: World, from: string) => {
  const file = join(w.dev, "..", `c${Date.now()}${Math.random().toString(36).slice(2, 6)}.bundle`);
  git(w.dev, "bundle", "create", file, `${from}..main`);
  return readFileSync(file).toString("base64");
};
const owner: Principal = { personId: "usman", via: "telegram-owner", actor: "human", displayName: "Usman" };
const reply = (w: World, word: "approve" | "deny", code = w.codes.at(-1)!) => answerTelegramCode(owner, `${word} ${code}`, () => w.approvals);
const scratchEmpty = (w: World) => !existsSync(w.scratch) || readdirSync(w.scratch).length === 0;

let w: World;
beforeEach(() => {
  w?.unregister();
  w = world();
});

describe("the release workflow", () => {
  test("before approval nothing reaches the live checkout; after the owner's Telegram yes, one detached run, then the receipt", async () => {
    const liveHead = git(w.live, "rev-parse", "HEAD");
    const before = liveState(w.live);
    const target = commit(w.dev, "b.txt", "new feature\n", "Add the synthetic feature");
    const record = await w.desk.request({ sha: target, bundle: bundleOf(w, liveHead), session: "abc", identity: "id-1" });
    expect(record).toMatchObject({ sha: target, baseHead: liveHead, state: "awaiting-approval", bundleRef: expect.stringMatching(/^refs\//) });
    expect(record.tag).toMatch(/^rollback\/pre-dot-\d{8}t\d{6}$/);
    // The live checkout is byte-for-byte as it was: no new object, no ref; the bundle waits in the temp folder only.
    expect(liveState(w.live)).toEqual(before);
    expect(existsSync(join(w.scratch, record.id, "candidate.bundle"))).toBe(true);
    expect(existsSync(join(w.gwDir, "release-runs", record.id))).toBe(false);
    // The approval, and the owner's message: the commit count, the subjects and a diffstat.
    expect(w.approvals.get(record.approvalId!)).toMatchObject({ action: RELEASE_ACTION, state: "pending" });
    expect(w.messages).toHaveLength(1);
    expect(w.messages[0]).toContain("1 commit");
    expect(w.messages[0]).toContain("Add the synthetic feature");
    expect(w.messages[0]).toMatch(/1 file changed/);
    // No approval yet: nothing runs, however often the state is read; a second request is refused.
    for (let i = 0; i < 3; i++) await w.desk.reconcile();
    expect(w.launched).toEqual([]);
    await expect(w.desk.request({ sha: target, session: "abc", identity: "id-1" })).rejects.toThrow(/in flight/);
    expect(w.approvals.decide(record.approvalId!, { personId: "usman", via: "paired-session", actor: "human", sessionId: "sk-usman-session" }, "approve", { uiConfirm: true, cardNonce: "x" } as never).ok).toBe(false);
    // The owner replies with his code: consumed, the candidate brought in as ONE ref, launched exactly once, temp folder gone.
    expect(await reply(w, "approve")).toContain("Approved");
    expect(w.launched).toEqual([{ sha: target, tag: record.tag, candidateRef: record.candidateRef }]);
    expect(git(w.live, "rev-parse", record.candidateRef)).toBe(target);
    expect(git(w.live, "rev-parse", "HEAD")).toBe(liveHead); // the script, not the hub, moves HEAD
    expect((await w.desk.get(record.id))!.state).toBe("running");
    expect(w.approvals.get(record.approvalId!)!.state).toBe("consumed");
    expect(scratchEmpty(w)).toBe(true);
    await w.desk.reconcile();
    expect(w.launched).toHaveLength(1);
    w.receipts.push({ file: "release-20261004T120000.json", time: "2026-10-04T12:00:00+11:00", oldHead: liveHead, newHead: target, rollbackTag: record.tag });
    expect(await w.desk.get(record.id)).toMatchObject({ state: "succeeded", receipt: { newHead: target } });
  });

  test("every refused request leaves nothing behind: no objects, refs, run folder or temp folder", async () => {
    const liveHead = git(w.live, "rev-parse", "HEAD");
    const t = commit(w.dev, "b.txt", "x\n");
    const good = bundleOf(w, liveHead);
    // Not a fast-forward (the live branch moved on after the bundle was made).
    commit(w.live, "c.txt", "live moved\n");
    const before = liveState(w.live);
    const refusals: Array<[unknown, RegExp]> = [
      [{ sha: t, bundle: good }, /fast-forward/],
      [{ sha: "f".repeat(40), bundle: good }, /does not hold that commit|verify/],
      [{ sha: t, bundle: Buffer.from("not a bundle").toString("base64") }, /does not verify/],
    ];
    for (const [input, why] of refusals) await expect(w.desk.request({ ...(input as object), session: "s", identity: `id-${Math.random()}` } as never)).rejects.toThrow(why);
    expect(liveState(w.live)).toEqual(before);
    expect(scratchEmpty(w)).toBe(true);
    expect(existsSync(join(w.gwDir, "release-runs"))).toBe(false);
    expect(w.approvals.list({ limit: 10 })).toEqual([]);
    expect(w.messages).toEqual([]);
  });

  test("overlay touch (including a rename and a quoted path) and the other early refusals", async () => {
    const head = git(w.live, "rev-parse", "HEAD");
    const t = commit(w.dev, "a.txt", "changed upstream\n");
    writeFileSync(join(w.live, "a.txt"), "owner's local edit\n");
    const before = liveState(w.live);
    await expect(w.desk.request({ sha: t, bundle: bundleOf(w, head), session: "s", identity: "o" })).rejects.toThrow(/owner's local files \(a\.txt\)/);
    expect(readFileSync(join(w.live, "a.txt"), "utf8")).toBe("owner's local edit\n");
    expect(liveState(w.live)).toEqual(before);
    // The -z parser: renames carry both paths; spaces and quotes come through unquoted.
    expect(porcelainPaths("R  new name.txt\0old \"name\".txt\0 M plain.txt\0?? dir/file with space.md\0")).toEqual(["new name.txt", 'old "name".txt', "plain.txt", "dir/file with space.md"]);
    // Bad input refused before any work.
    await expect(w.desk.request({ sha: "abc", session: "s", identity: "o2" })).rejects.toThrow(/40-character/);
    await expect(w.desk.request({ sha: t, bundle: "not base64 !!", session: "s", identity: "o2" })).rejects.toThrow(/base64/);
    await expect(w.desk.request({ sha: t, bundle: Buffer.alloc(RELEASE_BUNDLE_MAX_BYTES + 1).toString("base64"), session: "s", identity: "o2" })).rejects.toThrow(/larger than/);
    await expect(w.desk.request({ sha: t, session: "s", identity: "o2" })).rejects.toThrow(/does not have that commit/);
    w.enabled.value = false;
    await expect(w.desk.request({ sha: t, session: "s", identity: "o2" })).rejects.toThrow(/not switched on/);
    expect(scratchEmpty(w)).toBe(true);
  });

  test("at most a few requests per identity per hour, refused ones included; no approval code is sent past the cap", async () => {
    const head = git(w.live, "rev-parse", "HEAD");
    const t = commit(w.dev, "b.txt", "x\n");
    for (let i = 0; i < RELEASE_REQUESTS_PER_HOUR; i++) await expect(w.desk.request({ sha: "f".repeat(40), bundle: bundleOf(w, head), session: "s", identity: "looping" })).rejects.toThrow(/does not hold/);
    await expect(w.desk.request({ sha: t, bundle: bundleOf(w, head), session: "s", identity: "looping" })).rejects.toThrow(/At most 4 release requests an hour/);
    expect(w.messages).toEqual([]);
    // Another identity is not blocked by it; an hour later the first one may ask again.
    const ok = await w.desk.request({ sha: t, bundle: bundleOf(w, head), session: "s", identity: "other" });
    expect(ok.state).toBe("awaiting-approval");
    await w.desk.cancel(ok.id);
    w.skew.value = 3_600_001;
    expect((await w.desk.request({ sha: t, bundle: bundleOf(w, head), session: "s", identity: "looping" })).state).toBe("awaiting-approval");
  });

  test("git work never blocks the event loop", async () => {
    const head = git(w.live, "rev-parse", "HEAD");
    const t = commit(w.dev, "b.txt", "x\n");
    let ticks = 0;
    const timer = setInterval(() => ticks++, 1);
    const pending = w.desk.request({ sha: t, bundle: bundleOf(w, head), session: "s", identity: "loop" });
    // The request is still running (git is a separate process); the loop keeps turning meanwhile.
    await new Promise((r) => setTimeout(r, 30));
    const during = ticks;
    await pending;
    clearInterval(timer);
    expect(during).toBeGreaterThan(5);
  });

  test("refused at approval: turned down, stale (head moved); nothing launches, the live repo gets nothing, the temp folder goes", async () => {
    const liveHead = git(w.live, "rev-parse", "HEAD");
    const target = commit(w.dev, "b.txt", "x\n");
    const record = await w.desk.request({ sha: target, bundle: bundleOf(w, liveHead), session: "s", identity: "a" });
    expect(await reply(w, "deny")).toContain("Turned down");
    expect((await w.desk.get(record.id))!.state).toBe("rejected");
    expect(scratchEmpty(w)).toBe(true);
    const again = await w.desk.request({ sha: target, bundle: bundleOf(w, liveHead), session: "s", identity: "a" });
    commit(w.live, "hotfix.txt", "hand release\n");
    const before = liveState(w.live);
    await reply(w, "approve");
    const after = (await w.desk.get(again.id))!;
    expect(after.state).toBe("refused");
    expect(after.note).toMatch(/moved|fast-forward/);
    expect(w.launched).toEqual([]);
    expect(liveState(w.live)).toEqual(before);
    expect(scratchEmpty(w)).toBe(true);
  });

  test("stale records are swept and stop blocking: a consumed approval with no launch, a launch with no runner, a run with no receipt", async () => {
    const liveHead = git(w.live, "rev-parse", "HEAD");
    const target = commit(w.dev, "b.txt", "x\n");
    // A runner that never answers: the record stays "launching" until swept.
    w.runner.impl = () => new Promise(() => undefined);
    const record = await w.desk.request({ sha: target, bundle: bundleOf(w, liveHead), session: "s", identity: "b" });
    void reply(w, "approve");
    await new Promise((r) => setTimeout(r, 300));
    expect((JSON.parse(readFileSync(join(w.gwDir, "releases.json"), "utf8")) as Array<{ id: string; state: string }>).find((x) => x.id === record.id)!.state).toBe("launching");
    w.runner.impl = null;
    // A new desk (as after a hub restart) sweeps it once the launch is older than the bound.
    w.skew.value = RELEASE_STALE_LAUNCH_MS + 1_000;
    const fresh = createReleaseDesk({ dir: w.gwDir, repo: w.live, scratch: w.scratch, enabled: () => true, approvals: () => w.approvals as never, argsDigest, runner: () => ({ pid: null }), receipts: () => [], now: () => Date.now() + w.skew.value });
    const swept = (await fresh.get(record.id))!;
    expect(swept.state).toBe("failed");
    expect(swept.note).toContain("stale");
    // It no longer blocks a new request.
    const next = await fresh.request({ sha: target, bundle: bundleOf(w, liveHead), session: "s", identity: "c" });
    expect(next.state).toBe("awaiting-approval");
  });

  test("a waiting request can be withdrawn; the approval is cancelled and the temp folder removed", async () => {
    const liveHead = git(w.live, "rev-parse", "HEAD");
    const target = commit(w.dev, "b.txt", "x\n");
    const record = await w.desk.request({ sha: target, bundle: bundleOf(w, liveHead), session: "s", identity: "d" });
    expect((await w.desk.cancel(record.id)).state).toBe("cancelled");
    expect(w.approvals.get(record.approvalId!)!.state).toBe("cancelled");
    expect(scratchEmpty(w)).toBe(true);
    expect(spawnSync("git", ["-C", w.live, "rev-parse", "--verify", record.candidateRef]).status).not.toBe(0);
    await expect(w.desk.cancel(record.id)).rejects.toThrow(/only a waiting request/);
  });

  test("the scratch folder may not be inside the checkout or the data folder", () => {
    expect(() => createReleaseDesk({ dir: w.gwDir, repo: w.live, scratch: join(w.live, "tmp"), enabled: () => true, approvals: () => null, argsDigest, runner: () => ({ pid: null }), receipts: () => [] })).toThrow(/outside/);
    expect(() => createReleaseDesk({ dir: w.gwDir, repo: w.live, scratch: join(w.gwDir, "tmp"), enabled: () => true, approvals: () => null, argsDigest, runner: () => ({ pid: null }), receipts: () => [] })).toThrow(/outside/);
  });

  test("Dot's route: release.request needed; a founder cannot use it; answers carry no paths", async () => {
    const TOKEN = "release-route-token";
    const principalOf = (req: IncomingMessage): Principal | null => {
      const who = String(req.headers["x-test-who"] ?? "");
      if (who === "usman") return { personId: "usman", via: "paired-session", actor: "human", sessionId: "sk-u", displayName: "Usman" };
      return who.startsWith("dot:") ? { personId: "dot" as never, via: "gateway", actor: "process", sessionId: "gw:" + "ab".repeat(12), displayName: "Dot", capabilities: ["view", ...who.slice(4).split(",").filter(Boolean)], gatewayIdentityId: "0123456789abcdef" } : null;
    };
    const handle = createGatewayRoutes({ root: base, internalToken: () => TOKEN, dir: join(base, "route-gw"), principal: principalOf, operate: { env: () => ({}), readOnly: () => false, release: () => w.desk } });
    const server = createServer((req, res) => void handle(req, res));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/__gateway`;
    const call = async (who: string, method: string, path: string, body?: unknown) => {
      const p = principalOf({ headers: { "x-test-who": who } } as never);
      const res = await fetch(url + path, { method, headers: { "x-test-who": who, "content-type": "application/json", ...(method !== "GET" && p ? { "x-claude-os-token": pageTokenFor(p, TOKEN) } : {}) }, body: method === "GET" ? undefined : JSON.stringify(body ?? {}) });
      return { status: res.status, text: await res.text() };
    };
    try {
      const liveHead = git(w.live, "rev-parse", "HEAD");
      const target = commit(w.dev, "b.txt", "x\n");
      const body = { sha: target, bundle: bundleOf(w, liveHead) };
      expect((await call("dot:ops.read,crm.write", "POST", "/release", body)).status).toBe(403);
      expect((await call("usman", "POST", "/release", body)).status).toBe(403);
      const made = await call("dot:release.request", "POST", "/release", body);
      expect(made.status).toBe(202);
      const id = JSON.parse(made.text).release.id as string;
      expect(JSON.parse(made.text).release.identity).toBe("0123456789abcdef");
      const read = await call("dot:release.request", "GET", `/release/${id}`);
      expect(JSON.parse(read.text).release.state).toBe("awaiting-approval");
      for (const r of [made, read]) expect(r.text).not.toContain(base);
      expect((await call("dot:release.request", "POST", "/release", body)).status).toBe(409);
      for (const path of [`/release/${id}/approve`, `/release/${id}/run`, "/release/run"]) expect([path, (await call("dot:release.request", "POST", path, {})).status]).toEqual([path, 404]);
      expect((await call("dot:release.request", "POST", `/release/${id}/cancel`)).status).toBe(200);
      // The per-identity cap answers 429 through the route.
      let last = 0;
      for (let i = 0; i < RELEASE_REQUESTS_PER_HOUR + 1; i++) last = (await call("dot:release.request", "POST", "/release", { sha: "f".repeat(40), bundle: body.bundle })).status;
      expect(last).toBe(429);
      expect(w.launched).toEqual([]);
    } finally {
      server.closeAllConnections?.();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
