/**
 * The supported release workflow for the Dot gateway (`release.request`): Dot asks; a founder approves; the hub's existing
 * release script runs, detached, and Dot reads the outcome. No shell, no code execution and no deploy route exists for Dot.
 *
 *   1. Dot sends a target commit (40 hex), with a git BUNDLE that holds it unless the hub already has the commit. At most
 *      RELEASE_REQUESTS_PER_HOUR requests per identity per hour (which also bounds the approval codes sent to the owner).
 *   2. Before any approval, NOTHING is written to the live checkout. The bundle goes into a throwaway bare repository in a temp
 *      folder outside the checkout and the hub's data folder; that repository BORROWS the live objects read-only
 *      (objects/info/alternates), so the bundle can be verified, its heads listed and the commit checked there: it holds the
 *      commit, the commit FAST-FORWARDS from the live HEAD, and it touches none of the owner's local (overlay) files
 *      (`git status --porcelain=v1 -z` on the live checkout, with optional locks off). No other release may be in flight.
 *   3. It files an approval with the existing approvals service (action "deploy", requested by the hub as a program, for
 *      Usman): answered only by the owner's Telegram code ("approve XXXX-XXXX" in his own DM) or a spoken yes, never by a click
 *      a local program could fake. The message names the commit count, the commit subjects and a diffstat. The code goes to
 *      his DM once and is never stored or logged.
 *   4. Only once that approval is approved, and still valid for the LIVE head (a moved head voids it: its digest names the
 *      base), the hub consumes it, THEN fetches the bundle into refs/gateway-release/<id>/candidate in the live checkout,
 *      re-checks, and launches a DETACHED runner: deploy/windows/release-ryzen.ps1 -Target <sha> -TagName <generated>
 *      -CandidateRef <ref>, through WMI so it outlives the hub restart the release itself performs. The script keeps its
 *      backup, overlay hash check, settle and automatic rollback, and writes its receipt. The temp folder is deleted then, and on
 *      every refusal, rejection, expiry or withdrawal.
 *   5. Dot reads the state and the receipt (`GET /__gateway/release[/<id>]`, `ops.read` diagnostics). A record that stopped
 *      moving (approval consumed but no runner, no receipt in time) is swept to "failed (stale)" and blocks nothing.
 *
 * Every git call is asynchronous with a short timeout: the hub's event loop is never blocked.
 * Off unless the owner sets MU_GATEWAY_RELEASES=1 on the hub (and MU_RELEASE_RECEIPTS_DIR, where receipts land).
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { Principal as ApprovalPrincipal } from "../approvals/principal";
import { writeJsonAtomic } from "./store";

export const RELEASE_ACTION = "deploy";
export const RELEASE_BUNDLE_MAX_BYTES = 700 * 1024;
export const RELEASE_REQUESTS_PER_HOUR = 4;
/** A launch that never got a runner, or a run without a receipt, is stale after these. */
export const RELEASE_STALE_LAUNCH_MS = 5 * 60_000;
export const RELEASE_STALE_RUN_MS = 3 * 60 * 60_000;
export type ReleaseState = "awaiting-approval" | "launching" | "running" | "succeeded" | "failed" | "refused" | "rejected" | "expired" | "cancelled";
const IN_FLIGHT: readonly ReleaseState[] = ["awaiting-approval", "launching", "running"];

export type ReleaseRecord = {
  id: string;
  sha: string;
  baseHead: string;
  tag: string;
  candidateRef: string;
  /** The bundle's head that holds the commit (null: the hub already had the commit). */
  bundleRef: string | null;
  approvalId: string | null;
  state: ReleaseState;
  createdAt: string;
  updatedAt: string;
  /** The gateway session and identity that asked (public ids). */
  session: string;
  identity: string;
  note: string;
  launchedAt?: string;
  runner?: { pid: number | null; startedAt: string };
  receipt?: { file: string; time: string | null; oldHead: string | null; newHead: string | null; rollbackTag: string | null };
};

type ApprovalLike = { id: string; state: string; expiresAt: string };
export type ReleaseApprovals = {
  request(input: { action: string; args: unknown; requester: ApprovalPrincipal; summary: string; origin: "principal"; scope?: { approverPersonId?: "usman" | "mehroz"; resource?: string; deviceId?: string } }): { ok: true; approval: ApprovalLike; telegramCode?: string } | { ok: false; refusal: { reason: string } };
  get(id: string): ApprovalLike | null;
  consume(id: string, argsDigest: string): { ok: boolean; code?: string };
  cancel(id: string, reason?: string): boolean;
  decide?(id: string, approver: ApprovalPrincipal, decision: "approve" | "reject", evidence?: { telegramCode: string }): { ok: boolean; reason?: string };
  readOnly?: boolean;
};
export type ReleaseReceiptRow = { file: string; time: string | null; oldHead: string | null; newHead: string | null; rollbackTag: string | null };
export type ReleaseRunner = (input: { id: string; sha: string; tag: string; candidateRef: string; runDir: string; repo: string }) => Promise<{ pid: number | null }> | { pid: number | null };
export type GitRun = (cwd: string, args: string[]) => Promise<{ ok: boolean; out: string }>;

export type ReleaseDeskOptions = {
  /** The gateway's data folder (releases.json, release-attempts.json, release-runs/<id>/ for the run log only). */
  dir: string;
  /** The hub's own live checkout. */
  repo: string;
  /** Where the throwaway repositories go (default: the OS temp folder). Must be outside the checkout and the data folder. */
  scratch?: string;
  enabled: () => boolean;
  approvals: () => ReleaseApprovals | null;
  argsDigest: (action: string, args: unknown) => string;
  runner: ReleaseRunner;
  receipts: () => ReleaseReceiptRow[];
  notifyOwner?: (text: string) => Promise<unknown> | unknown;
  alive?: (pid: number) => boolean;
  git?: GitRun;
  now?: () => number;
};

export class ReleaseRefusal extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409 | 413 | 429 | 503,
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

/** The hub itself, as a program, asks on Dot's behalf (approvals never accept the gateway principal as a requester). */
export const RELEASE_REQUESTER: ApprovalPrincipal = { personId: "usman", via: "loopback-owner", actor: "process", deviceId: "hub" };
const SHA = /^[0-9a-f]{40}$/;
const REF = /^refs\/[A-Za-z0-9._/-]{1,200}$/;
const OUTPUT_CAP = 2 * 1024 * 1024;

/** A process run asynchronously, with a timeout and a capped output (never on the hub's event loop). */
export function runAsync(command: string, args: string[], options: { cwd?: string; timeoutMs?: number; env?: Record<string, string> } = {}): Promise<{ ok: boolean; out: string }> {
  return new Promise((done) => {
    let out = "";
    let settled = false;
    const child = spawn(command, args, { cwd: options.cwd, windowsHide: true, env: { ...process.env, ...options.env } });
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // trimEnd only: `git status --porcelain` lines start with a significant space.
      done({ ok, out: out.replace(/\s+$/, "") });
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(false);
    }, options.timeoutMs ?? 20_000);
    child.stdout?.on("data", (d: Buffer) => {
      if (out.length < OUTPUT_CAP) out += d.toString("utf8");
    });
    child.stderr?.on("data", () => undefined);
    child.on("error", () => finish(false));
    child.on("close", (code) => finish(code === 0));
  });
}

/** git, asynchronously, short timeout, no optional locks (a read never writes the live index), never a prompt. */
export const defaultGit: GitRun = (cwd, args) => runAsync("git", ["-C", cwd, ...args], { timeoutMs: 20_000, env: { GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" } });

/** `git status --porcelain=v1 -z`: every path an entry names, both sides of a rename or copy, unquoted. */
export function porcelainPaths(z: string): string[] {
  const parts = z.split("\0").filter((p) => p.length);
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (entry.length < 4) continue;
    out.push(entry.slice(3));
    // A rename or copy is followed by its ORIGINAL path as the next NUL-separated field.
    if (entry[0] === "R" || entry[0] === "C" || entry[1] === "R" || entry[1] === "C") {
      if (parts[i + 1] !== undefined) out.push(parts[++i]);
    }
  }
  return out;
}

/** Production runner: copies the release script into the run folder and launches it through WMI (not a child of the hub). */
export function wmiReleaseRunner(options: { receiptsDir: string; script: string }): ReleaseRunner {
  return async ({ sha, tag, candidateRef, runDir, repo }) => {
    mkdirSync(runDir, { recursive: true });
    const script = join(runDir, "release-ryzen.ps1");
    copyFileSync(options.script, script);
    const log = join(runDir, "release.log");
    const q = (s: string) => s.replace(/'/g, "''");
    // The live branch, as it is now (the script refuses to run on any other branch).
    const branch = (await defaultGit(repo, ["rev-parse", "--abbrev-ref", "HEAD"])).out.trim();
    if (!/^[A-Za-z0-9._/-]{1,100}$/.test(branch) || branch === "HEAD") throw new Error("The hub's checkout is not on a branch, so no release was started.");
    const inner = `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${script}" -Target ${sha} -TagName ${tag} -CandidateRef ${candidateRef} -Branch ${branch} -Repo "${repo}" -LogDir "${options.receiptsDir}"`;
    const commandLine = `cmd.exe /d /c "${inner} > "${log}" 2>&1"`;
    const ps = `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '${q(commandLine)}'; CurrentDirectory = '${q(repo)}' }; if ($r.ReturnValue -ne 0) { exit 1 }; $r.ProcessId`;
    const r = await runAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { timeoutMs: 60_000 });
    if (!r.ok) throw new Error("The release runner could not be started.");
    const pid = Number(r.out.trim());
    return { pid: Number.isInteger(pid) && pid > 0 ? pid : null };
  };
}

const defaultAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const inside = (child: string, parent: string) => {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};
/** One line a Telegram message may carry: plain characters only. */
const plain = (s: string, max: number) => s.replace(/[^\w .,:;()#/+'-]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

export function createReleaseDesk(options: ReleaseDeskOptions) {
  const now = options.now ?? Date.now;
  const git = options.git ?? defaultGit;
  const alive = options.alive ?? defaultAlive;
  const file = join(options.dir, "releases.json");
  const attemptsFile = join(options.dir, "release-attempts.json");
  const scratchRoot = resolve(options.scratch ?? join(tmpdir(), "mu-gateway-release"));
  if (inside(scratchRoot, options.repo) || inside(scratchRoot, options.dir) || inside(options.repo, scratchRoot)) throw new Error("The release scratch folder must be outside the live checkout and the hub's data folder.");
  const iso = () => new Date(now()).toISOString();
  const scratchOf = (id: string) => join(scratchRoot, id);
  const dropScratch = (id: string) => rmSync(scratchOf(id), { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  /** One request or launch at a time in this process: the in-flight rule cannot be raced. */
  let chain: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(work: () => Promise<T>): Promise<T> => {
    const next = chain.then(work, work);
    chain = next.catch(() => undefined);
    return next;
  };

  const read = (): ReleaseRecord[] => {
    try {
      const rows = JSON.parse(readFileSync(file, "utf8")) as ReleaseRecord[];
      return Array.isArray(rows) ? rows : [];
    } catch {
      return [];
    }
  };
  const write = (rows: ReleaseRecord[]) => {
    mkdirSync(options.dir, { recursive: true });
    writeJsonAtomic(file, rows.slice(-50));
  };
  const update = (id: string, patch: Partial<ReleaseRecord>) => {
    const rows = read();
    const i = rows.findIndex((r) => r.id === id);
    if (i < 0) return null;
    rows[i] = { ...rows[i], ...patch, updatedAt: iso() };
    write(rows);
    return rows[i];
  };
  /** Ended for good: the record, its temp folder and (if one was made) its live candidate ref. */
  const settle = async (r: ReleaseRecord, patch: Partial<ReleaseRecord>) => {
    dropScratch(r.id);
    await git(options.repo, ["update-ref", "-d", r.candidateRef]);
    return update(r.id, patch);
  };
  const head = async () => {
    const r = await git(options.repo, ["rev-parse", "HEAD"]);
    if (!r.ok || !SHA.test(r.out)) throw new ReleaseRefusal(503, "The hub's checkout could not be read, so no release was asked for.", "no-head");
    return r.out;
  };
  /** The owner's local (uncommitted) files that the change from `from` to `to` (in repository `at`) would touch. */
  const overlayTouched = async (at: string, from: string, to: string) => {
    const overlay = porcelainPaths((await git(options.repo, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])).out);
    const changed = (await git(at, ["diff", "--name-only", "-z", from, to])).out.split("\0").filter(Boolean);
    return changed.filter((p) => overlay.some((o) => p === o || p.startsWith(`${o.replace(/\/$/, "")}/`)));
  };
  const argsOf = (r: Pick<ReleaseRecord, "id" | "sha" | "baseHead" | "tag" | "candidateRef">) => ({ kind: "agenticos.release", release: r.id, sha: r.sha, baseHead: r.baseHead, tag: r.tag, candidateRef: r.candidateRef });

  /** Fast-forward and overlay checks for `sha` from `base`, inside repository `at` (the throwaway one, or the live one at launch). */
  async function check(at: string, sha: string, base: string) {
    if (sha === base) throw new ReleaseRefusal(409, "That commit is already live.", "already-live");
    if (!(await git(at, ["merge-base", "--is-ancestor", base, sha])).ok) throw new ReleaseRefusal(409, "That commit does not fast-forward from the live head, so it cannot be released this way.", "not-fast-forward");
    const touched = await overlayTouched(at, base, sha);
    if (touched.length) throw new ReleaseRefusal(409, `The release would change the owner's local files (${touched.slice(0, 5).join(", ")}${touched.length > 5 ? ", ..." : ""}).`, "overlay");
  }

  /** At most RELEASE_REQUESTS_PER_HOUR requests per identity per rolling hour (counted before any work, refused ones included). */
  function takeAttempt(identity: string) {
    let attempts: Array<{ identity: string; at: number }> = [];
    try {
      attempts = JSON.parse(readFileSync(attemptsFile, "utf8"));
      if (!Array.isArray(attempts)) attempts = [];
    } catch {
      attempts = [];
    }
    const hourAgo = now() - 3_600_000;
    attempts = attempts.filter((a) => a && a.at > hourAgo);
    if (attempts.filter((a) => a.identity === identity).length >= RELEASE_REQUESTS_PER_HOUR) throw new ReleaseRefusal(429, `At most ${RELEASE_REQUESTS_PER_HOUR} release requests an hour. Wait, then ask again.`, "rate");
    attempts.push({ identity, at: now() });
    mkdirSync(options.dir, { recursive: true });
    writeJsonAtomic(attemptsFile, attempts);
  }

  /** Dot asks. Resolves to the record (state awaiting-approval). Writes nothing to the live checkout. */
  function request(input: { sha: unknown; bundle?: unknown; session: string; identity?: string }): Promise<ReleaseRecord> {
    if (!options.enabled()) return Promise.reject(new ReleaseRefusal(503, "Releases through the gateway are not switched on for this hub (MU_GATEWAY_RELEASES, owner action).", "disabled"));
    const approvals = options.approvals();
    if (!approvals || approvals.readOnly) return Promise.reject(new ReleaseRefusal(503, "The approvals service is not available here, so no release was asked for.", "no-approvals"));
    const sha = String(input.sha ?? "").toLowerCase();
    if (!SHA.test(sha)) return Promise.reject(new ReleaseRefusal(400, "sha must be the full 40-character commit id.", "bad-sha"));
    const identity = String(input.identity || input.session || "unknown").slice(0, 40);
    let bytes: Buffer | null = null;
    if (input.bundle !== undefined && input.bundle !== null) {
      if (typeof input.bundle !== "string") return Promise.reject(new ReleaseRefusal(400, "bundle must be base64 text of a git bundle.", "bad-bundle"));
      bytes = Buffer.from(input.bundle, "base64");
      if (!bytes.length || bytes.toString("base64").replace(/=+$/, "") !== input.bundle.replace(/\s+/g, "").replace(/=+$/, "")) return Promise.reject(new ReleaseRefusal(400, "bundle is not valid base64.", "bad-bundle"));
      if (bytes.length > RELEASE_BUNDLE_MAX_BYTES) return Promise.reject(new ReleaseRefusal(413, `The bundle is larger than ${RELEASE_BUNDLE_MAX_BYTES / 1024} KB. Bundle only the new commits (git bundle create x.bundle <live head>..<branch>).`, "bundle-too-large"));
    }
    try {
      takeAttempt(identity);
    } catch (error) {
      return Promise.reject(error);
    }
    return exclusive(async () => {
      await reconcileNow();
      const busy = read().find((r) => IN_FLIGHT.includes(r.state));
      if (busy) throw new ReleaseRefusal(409, `A release is already in flight (${busy.id}, ${busy.state}). One at a time.`, "in-flight");
      const id = `rel-${new Date(now()).toISOString().replace(/[-:]/g, "").slice(0, 15)}-${randomBytes(3).toString("hex")}`;
      const candidateRef = `refs/gateway-release/${id}/candidate`;
      const base = await head();
      const scratch = scratchOf(id);
      try {
        // The throwaway repository: its own objects, the live ones borrowed read-only. Nothing reaches the live checkout.
        mkdirSync(scratch, { recursive: true });
        if (!(await git(scratch, ["init", "--bare", "--quiet"])).ok) throw new ReleaseRefusal(503, "The release check could not start.", "scratch");
        const objects = await git(options.repo, ["rev-parse", "--path-format=absolute", "--git-path", "objects"]);
        if (!objects.ok) throw new ReleaseRefusal(503, "The hub's checkout could not be read.", "no-objects");
        writeFileSync(join(scratch, "objects", "info", "alternates"), `${objects.out.trim()}\n`);
        let bundleRef: string | null = null;
        if (bytes) {
          const bundleFile = join(scratch, "candidate.bundle");
          writeFileSync(bundleFile, bytes);
          if (!(await git(scratch, ["bundle", "verify", "--quiet", bundleFile])).ok) throw new ReleaseRefusal(409, "The bundle does not verify against the hub's checkout (its base commits are not here).", "bundle-unverified");
          const heads = (await git(scratch, ["bundle", "list-heads", bundleFile])).out.split("\n").map((l) => l.trim().split(/\s+/)).filter((p) => p.length === 2);
          const match = heads.find(([s, ref]) => s === sha && REF.test(ref));
          if (!match) throw new ReleaseRefusal(409, "The bundle does not hold that commit as one of its heads.", "bundle-missing-sha");
          bundleRef = match[1];
          if (!(await git(scratch, ["fetch", "--no-tags", "--quiet", bundleFile, `${bundleRef}:refs/candidate`])).ok) throw new ReleaseRefusal(409, "The bundle could not be read.", "bundle-fetch");
        } else if (!(await git(scratch, ["cat-file", "-e", `${sha}^{commit}`])).ok) throw new ReleaseRefusal(409, "The hub does not have that commit. Send a bundle that holds it.", "no-candidate");
        await check(scratch, sha, base);
        // What the owner is asked to approve, in plain words.
        const count = Number((await git(scratch, ["rev-list", "--count", `${base}..${sha}`])).out) || 0;
        const subjects = (await git(scratch, ["log", "--format=%s", "-n", "5", `${base}..${sha}`])).out.split("\n").filter(Boolean).map((s) => plain(s, 80));
        const stat = plain((await git(scratch, ["diff", "--shortstat", base, sha])).out, 120);
        const tag = `rollback/pre-dot-${new Date(now()).toISOString().replace(/[-:]/g, "").slice(0, 15).toLowerCase()}`;
        const record: ReleaseRecord = { id, sha, baseHead: base, tag, candidateRef, bundleRef, approvalId: null, state: "awaiting-approval", createdAt: iso(), updatedAt: iso(), session: input.session.slice(0, 40), identity, note: "Waiting for the owner's approval (his Telegram code or a spoken yes)." };
        const summary = `Release ${sha.slice(0, 8)} to production (fast-forward from ${base.slice(0, 8)}, ${count} commit${count === 1 ? "" : "s"}), asked for by Dot through the gateway`;
        const res = approvals.request({ action: RELEASE_ACTION, args: argsOf(record), requester: RELEASE_REQUESTER, summary, origin: "principal", scope: { approverPersonId: "usman", resource: `release:${id}`, deviceId: "hub" } });
        if (!res.ok) throw new ReleaseRefusal(409, `The approval could not be asked for: ${res.refusal.reason}`, "approval-refused");
        record.approvalId = res.approval.id;
        write([...read(), record]);
        // A commit the hub already had needs nothing kept; a bundle stays in the temp folder until launch or refusal.
        if (!bytes) dropScratch(id);
        if (res.telegramCode && options.notifyOwner) {
          // To the owner's own DM, once. Never stored, logged or returned.
          const lines = [`AgenticOS: ${summary}.`, ...(subjects.length ? [`Commits: ${subjects.join(" | ")}${count > subjects.length ? ` (+${count - subjects.length} more)` : ""}`] : []), ...(stat ? [`Changes: ${stat}`] : []), `To approve, reply "approve ${res.telegramCode}" (valid ${Math.max(1, Math.round((Date.parse(res.approval.expiresAt) - now()) / 60000))} min). Ignore it and nothing is released.`];
          void Promise.resolve(options.notifyOwner(lines.join("\n"))).catch(() => undefined);
        }
        return record;
      } catch (error) {
        dropScratch(id);
        throw error;
      }
    });
  }

  /**
   * Move every record forward from what is true now: the approval's state, the runner's process, the receipts and the clock.
   * Safe to call at any time and from any process (a restarted hub picks up where the old one left off).
   */
  async function reconcileNow(): Promise<ReleaseRecord[]> {
    for (const r of read()) {
      if (r.state === "awaiting-approval" && r.approvalId) {
        const a = options.approvals()?.get(r.approvalId);
        if (!a) continue;
        if (a.state === "rejected") await settle(r, { state: "rejected", note: "The owner turned the release down. Nothing was released." });
        else if (a.state === "expired" || (a.state === "pending" && Date.parse(a.expiresAt) <= now())) await settle(r, { state: "expired", note: "The approval expired. Nothing was released." });
        else if (a.state === "cancelled") await settle(r, { state: "cancelled", note: "The approval was withdrawn. Nothing was released." });
        else if (a.state === "consumed") await settle(r, { state: "failed", note: "failed (stale): the approval was used but the release never started (the hub stopped in between). Nothing was released; ask again." });
        else if (a.state === "approved") await launch(r);
      } else if (r.state === "launching") {
        if (now() - Date.parse(r.launchedAt ?? r.updatedAt) > RELEASE_STALE_LAUNCH_MS) await settle(r, { state: "failed", note: "failed (stale): the release was approved but its runner never started. Nothing was released; ask again." });
      } else if (r.state === "running") {
        const receipt = options.receipts().find((x) => !!x.newHead && x.newHead.length >= 7 && r.sha.startsWith(x.newHead));
        if (receipt) {
          update(r.id, { state: "succeeded", receipt, note: "Released. The script's receipt is attached." });
          continue;
        }
        const pid = r.runner?.pid ?? null;
        const started = r.runner ? Date.parse(r.runner.startedAt) : Date.parse(r.updatedAt);
        if (pid && !alive(pid) && now() - started > 5_000) update(r.id, { state: "failed", note: "The release script ended without a receipt: it refused or rolled back (the checkout and data are back where they were). See the run log." });
        else if (!pid && now() - started > RELEASE_STALE_LAUNCH_MS) update(r.id, { state: "failed", note: "failed (stale): the runner reported no process and no receipt arrived." });
        else if (now() - started > RELEASE_STALE_RUN_MS) update(r.id, { state: "failed", note: "failed (stale): no receipt within 3 hours. Check the run log and the hub's version before asking again." });
      }
    }
    return read();
  }
  const reconcile = () => exclusive(reconcileNow);

  /** The approval is approved: consume it (bound to the LIVE base), then bring the candidate into the live checkout, re-check, launch once. */
  async function launch(r: ReleaseRecord) {
    const approvals = options.approvals();
    if (!approvals || !r.approvalId) return;
    if (read().some((x) => x.id !== r.id && (x.state === "running" || x.state === "launching"))) return void (await settle(r, { state: "refused", note: "Another release was running when this one was approved. Nothing was released; ask again." }));
    let base: string;
    try {
      base = await head();
    } catch {
      return;
    }
    // A moved head means the approval was for a different change: its digest names the old base, so consuming it fails and voids it.
    const consumed = approvals.consume(r.approvalId, options.argsDigest(RELEASE_ACTION, argsOf({ ...r, baseHead: base })));
    if (!consumed.ok) return void (await settle(r, { state: "refused", note: consumed.code === "digest-mismatch" ? "The live head moved after the approval, so the approval was void. Nothing was released; ask again." : `The approval could not be used (${consumed.code}). Nothing was released.` }));
    update(r.id, { state: "launching", launchedAt: iso(), note: "Approved. Bringing the candidate in and starting the release script." });
    try {
      // Only now does anything reach the live checkout: the approved candidate, as one ref.
      const brought = r.bundleRef ? await git(options.repo, ["fetch", "--no-tags", "--quiet", join(scratchOf(r.id), "candidate.bundle"), `${r.bundleRef}:${r.candidateRef}`]) : await git(options.repo, ["update-ref", r.candidateRef, r.sha]);
      if (!brought.ok) throw new ReleaseRefusal(409, "The approved candidate could not be brought into the hub's checkout.", "candidate");
      const cand = await git(options.repo, ["rev-parse", "--verify", `${r.candidateRef}^{commit}`]);
      if (!cand.ok || cand.out !== r.sha) throw new ReleaseRefusal(409, "The candidate in the hub's checkout is not the approved commit.", "candidate");
      await check(options.repo, r.sha, base);
    } catch (error) {
      return void (await settle(r, { state: "refused", note: `${(error as Error).message} Nothing was released.` }));
    }
    try {
      const run = await options.runner({ id: r.id, sha: r.sha, tag: r.tag, candidateRef: r.candidateRef, runDir: join(options.dir, "release-runs", r.id), repo: options.repo });
      update(r.id, { state: "running", runner: { pid: run.pid, startedAt: iso() }, note: "The release script is running (backup, fast-forward, health check, settle; automatic rollback on failure)." });
      dropScratch(r.id);
    } catch (error) {
      await settle(r, { state: "failed", note: `${(error as Error).message} Nothing was released.` });
    }
  }

  /** Withdraw a request that is still waiting for approval. */
  function cancel(id: string): Promise<ReleaseRecord> {
    return exclusive(async () => {
      const r = read().find((x) => x.id === id);
      if (!r) throw new ReleaseRefusal(404, "No such release request.", "unknown");
      if (r.state !== "awaiting-approval") throw new ReleaseRefusal(409, `That release is ${r.state}; only a waiting request can be withdrawn.`, "not-waiting");
      if (r.approvalId) options.approvals()?.cancel(r.approvalId, "withdrawn by the requester");
      return (await settle(r, { state: "cancelled", note: "Withdrawn. Nothing was released." }))!;
    });
  }

  /** The run log, without paths (the script names backup and config copies). */
  function logTail(id: string, lines = 60): string[] {
    const f = join(options.dir, "release-runs", id, "release.log");
    if (!/^rel-[0-9a-zT]+-[0-9a-f]{6}$/.test(id) || !existsSync(f) || statSync(f).size > 4 * 1024 * 1024) return [];
    return readFileSync(f, "utf8").replace(/^﻿/, "").split(/\r?\n/).filter(Boolean).slice(-lines).map((l) => l.replace(/[A-Za-z]:\\[^\s"';]+/g, "<path>").slice(0, 300));
  }

  return {
    request,
    reconcile,
    cancel,
    logTail,
    scratchRoot,
    list: async () => (await reconcile()).slice().reverse(),
    get: async (id: string) => (await reconcile()).find((r) => r.id === id) ?? null,
    ownsApproval: (approvalId: string) => read().some((r) => r.approvalId === approvalId),
  };
}

export type ReleaseDesk = ReturnType<typeof createReleaseDesk>;

/**
 * The answer to the owner's Telegram reply for a gateway release ("approve XXXX-XXXX" / "deny XXXX-XXXX" in his own DM;
 * scripts/approvals/telegram-codes.ts matched the code to the approval first). Decides it with the approvals service, then
 * moves the desk on (an approved release launches here).
 */
export function releaseCodeHandler(desk: ReleaseDesk, approvals: () => ReleaseApprovals | null) {
  return {
    actions: [RELEASE_ACTION] as const,
    answer: async (approvalId: string, sender: unknown, yes: boolean, code: string) => {
      if (!desk.ownsApproval(approvalId)) return "That approval isn't a gateway release. Nothing was done.";
      const decided = approvals()?.decide?.(approvalId, sender as ApprovalPrincipal, yes ? "approve" : "reject", { telegramCode: code });
      if (!decided?.ok) return `Not done: ${decided?.reason ?? "the approvals service is not available"}.`;
      const after = (await desk.reconcile()).find((r) => r.approvalId === approvalId);
      return yes ? `Approved. Release ${after?.sha.slice(0, 8) ?? ""}: ${after?.state ?? "starting"}.` : "Turned down. Nothing was released.";
    },
  };
}
