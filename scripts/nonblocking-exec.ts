// Request-path helpers that never block the dev server's event loop (Track 8, API audit F5 P2-4).
//
// Every /__* route shares one event loop with voice, streaming and job polling. An execSync on a
// request path stalls ALL of them for as long as the child runs: /__app_version ran
// `git rev-parse` per call (1.2-1.7 s), the resolveCliBin fallback ran `where <bin>` for
// /__claude_models, /__dream_engines, /__design_makers and /__chat_title (1-2.8 s), and
// /__hermes_status, /__hermes_connections, /__hermes_profiles and /__hermes_memory shelled out
// synchronously (the status route is polled every 4 s).
import { exec, execFile, spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

type RunOptions = { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number };

/** A shell command's stdout, without blocking. Rejects on a non-zero exit or timeout, like execSync. */
export function runText(command: string, options: RunOptions = {}): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    exec(command, { ...options, encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) =>
      error ? reject(error) : resolvePromise(String(stdout)),
    );
  });
}

/** A program's stdout (no shell), without blocking. Rejects on a non-zero exit or timeout. */
export function runFileText(file: string, args: string[], options: RunOptions = {}): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile(file, args, { ...options, encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) =>
      error ? reject(error) : resolvePromise(String(stdout)),
    );
  });
}

/** The .git directory for a checkout: a folder, or a linked worktree's `gitdir:` file. */
function gitDirOf(root: string): string | null {
  const dotGit = join(root, ".git");
  try {
    if (statSync(dotGit).isDirectory()) return dotGit;
    const line = readFileSync(dotGit, "utf8").trim();
    const target = line.startsWith("gitdir:") ? line.slice(7).trim() : "";
    return target ? (isAbsolute(target) ? target : resolve(root, target)) : null;
  } catch {
    return null;
  }
}

/**
 * The checked-out commit's short SHA read from .git's own files (HEAD, the ref, packed-refs), with
 * no git process: microseconds instead of a 1-2 s blocking spawn. "" when it can't be read.
 */
export function gitHeadShortSha(root: string, length = 7): string {
  const gitDir = gitDirOf(root);
  if (!gitDir) return "";
  try {
    const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
    if (/^[0-9a-f]{40}$/i.test(head)) return head.slice(0, length);
    const ref = head.startsWith("ref:") ? head.slice(4).trim() : "";
    if (!ref) return "";
    // A linked worktree keeps HEAD in its own gitdir but refs in the common dir.
    const common = existsSync(join(gitDir, "commondir")) ? resolve(gitDir, readFileSync(join(gitDir, "commondir"), "utf8").trim()) : gitDir;
    for (const dir of [gitDir, common]) {
      const loose = join(dir, ref);
      if (existsSync(loose)) {
        const sha = readFileSync(loose, "utf8").trim();
        if (/^[0-9a-f]{40}$/i.test(sha)) return sha.slice(0, length);
      }
    }
    const packed = join(common, "packed-refs");
    if (existsSync(packed)) {
      for (const line of readFileSync(packed, "utf8").split(/\r?\n/)) {
        const [sha, name] = line.split(" ");
        if (name === ref && /^[0-9a-f]{40}$/i.test(sha ?? "")) return sha.slice(0, length);
      }
    }
  } catch {
    /* unreadable: fall through */
  }
  return "";
}

/**
 * resolveCliBin with memory. Known install locations are checked first (cheap existsSync); the PATH
 * lookup (`where`/`which`) is ALWAYS async (T8b, review T8 S-6: the old synchronous fallback still
 * blocked the server for a missing CLI once per 5 min per name). `resolve()` never spawns: it answers
 * from the cache and, when an entry is missing or stale (a miss older than `missTtlMs`, or a found path
 * that has since disappeared), starts one background lookup and answers with what it knew until that
 * lands. `warm()` (at startup) and `resolveAsync()` wait for the lookup instead.
 */
export function createCliBinResolver(options: {
  candidates: (name: string) => string[];
  isWindows: boolean;
  /** Async PATH lookup; injectable for tests. */
  lookupAsync?: (name: string) => Promise<string | undefined>;
  missTtlMs?: number;
  now?: () => number;
  exists?: (path: string) => boolean;
}) {
  const exists = options.exists ?? existsSync;
  const now = options.now ?? Date.now;
  const missTtl = options.missTtlMs ?? 5 * 60_000;
  const cache = new Map<string, { path?: string; at: number }>();
  const pending = new Map<string, Promise<string | undefined>>();
  let lookups = 0;
  const firstExisting = (out: string) =>
    out
      .split(/\r?\n/)
      .map((s) => s.trim())
      .find((s) => s && exists(s));
  const lookupAsync =
    options.lookupAsync ??
    ((name: string) => runFileText(options.isWindows ? "where" : "which", [name], { timeout: 3000 }).then(firstExisting, () => undefined));
  const fresh = (name: string, hit: { path?: string; at: number } | undefined) =>
    hit && (hit.path ? exists(hit.path) : now() - hit.at < missTtl);
  const lookup = (name: string): Promise<string | undefined> => {
    let p = pending.get(name);
    if (!p) {
      lookups++;
      p = lookupAsync(name)
        .catch(() => undefined)
        .then((path) => (cache.set(name, { path, at: now() }), path))
        .finally(() => pending.delete(name));
      pending.set(name, p);
    }
    return p;
  };
  return {
    /** Never spawns and never waits. A stale or missing entry is refreshed in the background. */
    resolve(name: string): string | undefined {
      const known = options.candidates(name).find((p) => exists(p));
      if (known) return known;
      const hit = cache.get(name);
      if (fresh(name, hit)) return hit!.path;
      void lookup(name);
      // A path that vanished is not served; a stale miss stays a miss until the lookup answers.
      return hit?.path && exists(hit.path) ? hit.path : undefined;
    },
    /** As resolve(), but waits for the (async) lookup when the cache can't answer. */
    async resolveAsync(name: string): Promise<string | undefined> {
      const known = options.candidates(name).find((p) => exists(p));
      if (known) return known;
      const hit = cache.get(name);
      if (fresh(name, hit)) return hit!.path;
      return lookup(name);
    },
    /** Background lookups for names not yet cached (or whose entry went stale). Never throws. */
    async warm(names: string[]): Promise<void> {
      await Promise.all(
        names.map(async (name) => {
          if (options.candidates(name).some((p) => exists(p)) || fresh(name, cache.get(name))) return;
          await lookup(name);
        }),
      );
    },
    get lookups() {
      return lookups;
    },
  };
}

/** A value kept for `ttlMs` and while `stamp()` is unchanged (e.g. a binary's mtime); one refresh at a time. */
export function createTimedCache<T>(ttlMs: number, now: () => number = Date.now) {
  const entries = new Map<string, { value: T; at: number; stamp: string }>();
  const pending = new Map<string, Promise<T>>();
  return {
    async get(key: string, stamp: string, load: () => Promise<T>): Promise<T> {
      const e = entries.get(key);
      if (e && e.stamp === stamp && now() - e.at < ttlMs) return e.value;
      let p = pending.get(key);
      if (!p) {
        p = load()
          .then((value) => (entries.set(key, { value, at: now(), stamp }), value))
          .finally(() => pending.delete(key));
        pending.set(key, p);
      }
      return p;
    },
  };
}

/** A file's identity for createTimedCache (size + mtime), "-" when missing. */
export function fileStamp(path: string | null | undefined): string {
  if (!path) return "-";
  try {
    const s = statSync(path);
    return `${s.size}:${s.mtimeMs}`;
  } catch {
    return "-";
  }
}


/**
 * Run a program (no shell) and, on timeout, kill its whole process tree, not just the direct child
 * (review T8 S-4: `exec` goes through cmd.exe, and a timeout killed only cmd.exe while the bun.exe it
 * started kept running). Resolves with stdout; rejects on a non-zero exit, a timeout or a spawn error.
 */
export function runTree(file: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; timeout: number }): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(file, args, { cwd: options.cwd, env: options.env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
    let out = "";
    let done = false;
    child.stdout?.setEncoding("utf8").on("data", (d: string) => { if (out.length < 1 << 20) out += d; });
    child.stderr?.resume();
    const finish = (error: Error | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      error ? reject(error) : resolvePromise(out);
    };
    const timer = setTimeout(() => {
      killTree(child.pid);
      finish(Object.assign(new Error(`${file} timed out after ${options.timeout} ms; its process tree was stopped`), { code: "ETIMEDOUT" }));
    }, options.timeout);
    child.on("error", (e) => finish(e));
    child.on("close", (code) => finish(code === 0 ? null : new Error(`${file} exited with code ${code}`)));
  });
}

export type CaptureResult = { status: number | null; stdout: string; stderr: string; timedOut: boolean; error: Error | null };

/**
 * spawnSync's result shape, without blocking (T8b, review T8 S-6): exit status, stdout and stderr
 * (each capped at `maxBuffer`), whether it timed out (the whole process tree is stopped then), and a
 * spawn error such as ENOENT. Never rejects, so a caller written against spawnSync keeps its checks.
 */
export function runCapture(
  file: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number; maxBuffer?: number; input?: string } = {},
): Promise<CaptureResult> {
  return new Promise((resolvePromise) => {
    const max = options.maxBuffer ?? 16 * 1024 * 1024;
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let done = false;
    let child: ReturnType<typeof spawn>;
    // Declared before spawn (review T8b-F1): a synchronous spawn throw (a .cmd/.bat shim is EINVAL on
    // Windows, a NUL in the path) calls finish() straight away, and reading a later `const timer` there
    // was a ReferenceError that made this promise reject.
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (status: number | null, error: Error | null) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      resolvePromise({ status, stdout, stderr, timedOut, error });
    };
    try {
      child = spawn(file, args, { cwd: options.cwd, env: options.env, windowsHide: true, stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"], detached: process.platform !== "win32" });
    } catch (e) {
      finish(null, e as Error);
      return;
    }
    timer = options.timeout
      ? setTimeout(() => {
          timedOut = true;
          killTree(child.pid);
          finish(null, Object.assign(new Error(`${file} timed out after ${options.timeout} ms; its process tree was stopped`), { code: "ETIMEDOUT" }));
        }, options.timeout)
      : null;
    child.stdout?.setEncoding("utf8").on("data", (d: string) => { if (stdout.length < max) stdout += d; });
    child.stderr?.setEncoding("utf8").on("data", (d: string) => { if (stderr.length < max) stderr += d; });
    if (options.input !== undefined) child.stdin?.end(options.input);
    child.on("error", (e) => finish(null, e));
    child.on("close", (code) => finish(code, null));
  });
}

/** Stop a process and everything it started. */
export function killTree(pid: number | undefined) {
  if (!pid) return;
  try {
    if (process.platform === "win32") spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).on("error", () => undefined);
    else process.kill(-pid, "SIGKILL");
  } catch {
    /* already gone */
  }
}

/**
 * One run at a time (review T8 S-4: /__refresh_data and the three dream paths could run aggregate.ts
 * side by side, each rewriting live-data.json). A request during a run gets ONE follow-up run after it
 * (it may be asking because it just wrote something the running copy started too early to see); every
 * request made during that run shares the follow-up's result.
 */
export function singleFlight(run: () => Promise<void>) {
  let current: Promise<void> | null = null;
  let next: Promise<void> | null = null;
  let runs = 0;
  const start = (): Promise<void> => {
    runs++;
    const p = Promise.resolve().then(run).finally(() => {
      if (current === p) current = null;
    });
    current = p;
    return p;
  };
  return {
    run(): Promise<void> {
      if (!current) return start();
      next ??= current.catch(() => undefined).then(() => {
        next = null;
        return start();
      });
      return next;
    },
    get runs() {
      return runs;
    },
  };
}
