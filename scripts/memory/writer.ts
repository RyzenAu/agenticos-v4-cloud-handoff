/**
 * ONE writer for the real memory (REVIEW-STAGE-D B5). The real vault and the real shared pool (the
 * pilot proxy) are written only by the canonical AgenticOS: this machine's main tree
 * (C:\Users\<you>\source\repos\AgenticOS-v4) serving on port 8081, holding the writer lock. Any other
 * copy (a dev server in another worktree, a preview, a second instance) is read-only, whatever
 * MU_MEMORY_WRITES says: its own state dir would give the vault's notes new ids and duplicate them,
 * and its documents would be orphaned when it goes away.
 *
 * A copy set up for testing with its OWN synthetic vault and store (MU_WIKI_ROOT and
 * MEMORY_STATE_DIR both set, neither being the real ones) and its own Hindsight (not the pilot
 * proxy) may write: nothing it writes can touch the real memory.
 *
 * Overrides (for a moved install only): MU_MEMORY_WRITER_ROOT, MU_MEMORY_WRITER_PORT.
 */
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { atomicWrite } from "./wiki-store";

export const PILOT_PROXY_PORTS = [8878, 8888];
export type WriterDecision = { ok: true; lock: string | null } | { ok: false; reason: string };

const canon = (p: string) => {
  const abs = resolve(p);
  let real = abs;
  try {
    real = realpathSync.native(abs);
  } catch {
    /* not there yet */
  }
  return real.replace(/[\\/]+$/, "").toLowerCase();
};

export function defaultVaultRoot() {
  return join(homedir(), "source", "repos", "mu-ventures-obsidian-wiki");
}
export function canonicalWriterRoot(env: Record<string, string | undefined>) {
  return env.MU_MEMORY_WRITER_ROOT || join(homedir(), "source", "repos", "AgenticOS-v4");
}
export function canonicalWriterPort(env: Record<string, string | undefined>) {
  return Number(env.MU_MEMORY_WRITER_PORT || 8081);
}
export function lockPath(env: Record<string, string | undefined>) {
  return env.MU_MEMORY_WRITER_LOCK || join(homedir(), ".config", "agentic-os", "memory-writer.lock.json");
}

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

/**
 * May this process write memory? `vaultRoot` / `hindsightUrl` are the resolved settings; `explicit`
 * says whether MU_WIKI_ROOT and MEMORY_STATE_DIR were both set by the operator.
 */
export function writerDecision(input: {
  env: Record<string, string | undefined>;
  appRoot: string;
  port: number | null;
  vaultRoot: string;
  stateDir: string;
  hindsightUrl: string | null;
  explicit: boolean;
  pid?: number;
}): WriterDecision {
  const { env } = input;
  const realVault = canon(env.MU_MEMORY_REAL_VAULT || defaultVaultRoot()) === canon(input.vaultRoot);
  let pilotPool = false;
  if (input.hindsightUrl) {
    const u = new URL(input.hindsightUrl);
    pilotPool = PILOT_PROXY_PORTS.includes(Number(u.port || 80));
  }
  if (!realVault && !pilotPool) {
    return input.explicit
      ? { ok: true, lock: null }
      : { ok: false, reason: "A copy writes only with its own synthetic vault AND store (MU_WIKI_ROOT and MEMORY_STATE_DIR both set)." };
  }
  // The real vault or the real pool: only the canonical AgenticOS on its own port, holding the lock.
  if (canon(input.appRoot) !== canon(canonicalWriterRoot(env)))
    return { ok: false, reason: `Read-only copy: only the main AgenticOS (${canonicalWriterRoot(env)}) writes the real memory.` };
  if (input.port !== canonicalWriterPort(env)) return { ok: false, reason: `Read-only copy: the memory writer serves on port ${canonicalWriterPort(env)}.` };
  const file = lockPath(env);
  const pid = input.pid ?? process.pid;
  try {
    if (existsSync(file)) {
      const held = JSON.parse(readFileSync(file, "utf8")) as { pid?: number; root?: string; port?: number };
      if (held.pid && held.pid !== pid && alive(held.pid))
        return { ok: false, reason: `Another AgenticOS process (pid ${held.pid}) holds the memory writer lock.` };
    }
    mkdirSync(dirname(file), { recursive: true });
    atomicWrite(file, JSON.stringify({ pid, root: canon(input.appRoot), port: input.port, state_dir: input.stateDir, at: new Date().toISOString() }) + "\n");
    return { ok: true, lock: file };
  } catch {
    return { ok: false, reason: "The memory writer lock couldn't be taken, so memory stays read-only." };
  }
}
