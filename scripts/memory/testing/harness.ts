/**
 * Test harness: a TEMP copy of the synthetic mini-wiki, a TEMP app-owned state dir, and the
 * fake Hindsight server. Never the real vault, never a real bank.
 */
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createMemoryApi, type MemoryApi } from "../api";
import { localApprovals } from "../approvals";
import { answerTelegramCode, registerTelegramCodeHandler } from "../../approvals/telegram-codes";
import { MEMORY_ACTIONS } from "../../approvals/adapters/memory";
import { memoryPrincipalFrom } from "../plugin";
import { SpokenConfirmationLedger } from "../../jarvis-execution/voice-confirmation";
import { resolveMemorySettings } from "../settings";
import type { Principal } from "../types";
import { startFakeHindsight, type FakeHindsight } from "./fake-hindsight";

export const FIXTURE = fileURLToPath(new URL("../fixtures/mini-wiki", import.meta.url));
export const SYNTHETIC_KEY = "synthetic-test-key-not-a-secret";
/** A synthetic approval secret in the TEMP dir: tests never read the real proxy secrets on D:. */
export const SYNTHETIC_APPROVAL_SECRET = "synthetic-approval-secret-not-real";
export const BANK = "syn-connector";
/**
 * People in a browser session (B1 actor "human", with B1's own principal and its session key, as the
 * server resolves them); a program is `agentOf(...)` (no session); Telegram DMs are `telegramOf(...)`.
 */
export const usman: Principal = {
  id: "usman",
  name: "Usman",
  via: "local",
  actor: "human",
  os: { personId: "usman", via: "loopback-owner", actor: "human", sessionId: "sess-usman-00000001", deviceId: "hub" },
};
export const mehroz: Principal = {
  id: "mehroz",
  name: "Mehroz",
  via: "tailnet",
  actor: "human",
  os: { personId: "mehroz", via: "paired-session", actor: "human", sessionId: "sess-mehroz-0000001", deviceId: "mehroz-laptop" },
};
/** The same person's program (Claude Code, Hermes, curl): B1 actor "process", no browser session. */
export const agentOf = (p: Principal): Principal => ({ ...p, actor: "process", ...(p.os ? { os: { personId: p.os.personId, via: p.os.via, actor: "process" as const } } : {}) });
/** The person's own Telegram DM, verified by the gateway relay (B1: telegram-owner, human). */
export const telegramOf = (p: Principal): Principal => ({ id: p.id, name: p.name, via: "telegram", actor: "human", os: { personId: p.id, via: "telegram-owner", actor: "human" } });
/**
 * A reply typed in a person's Telegram DM, through the same path the Hermes relay uses: the approval
 * service claims the code (or counts a miss), then the memory handler answers. Null = not a code reply.
 */
export async function telegramReply(api: MemoryApi, who: Principal, text: string, notify?: (personId: string, text: string) => unknown): Promise<string | null> {
  const sender = { personId: who.id as "usman" | "mehroz", via: "telegram-owner" as const, actor: (who.actor ?? "process") as "human" | "process", displayName: who.name };
  const off = registerTelegramCodeHandler({ actions: MEMORY_ACTIONS, answer: (id, s, yes, code) => api.approvals.answerTelegram(id, memoryPrincipalFrom(s)!, yes, code) });
  try {
    return await answerTelegramCode(sender, text, () => api.approvals.service(), notify ? { notify } : {});
  } finally {
    off();
  }
}
/** The same person after their browser session was revoked: B1 no longer vouches a human session. */
export const revokedOf = (p: Principal): Principal => ({ ...p, actor: "process", ...(p.os ? { os: { personId: p.os.personId, via: p.os.via, actor: "process" as const } } : {}) });

const temps: string[] = [];
const fakes: FakeHindsight[] = [];

export async function cleanup() {
  for (const f of fakes.splice(0)) await f.stop();
  for (const d of temps.splice(0))
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* an approvals.sqlite still open in this process (WAL): the OS temp cleaner takes it */
    }
}

export type Harness = {
  base: string;
  vault: string;
  state: string;
  fake: FakeHindsight;
  env: Record<string, string>;
  api: MemoryApi;
  make: (envOverride?: Record<string, string>) => MemoryApi;
  bankDocs: () => Map<string, import("./fake-hindsight").FakeDoc>;
  /** Move the test clock forward (waits, back-off, hold-until). */
  advance: (ms: number) => void;
  /** The test clock (ms), for a store opened beside the api. */
  clock: () => number;
  /** The voice pipeline's spoken-yes ledger (the approval service redeems from it). */
  spoken: SpokenConfirmationLedger;
  /** Telegram DMs the approval service sent (a program's one-time codes), captured instead of sent. */
  telegram: { personId: string; text: string }[];
  /** The last one-time code sent to this person's Telegram DM. */
  codeFor: (personId: string) => string | null;
  /** The Memory page's card for this approval in `who`'s browser session, then its button. */
  approveUi: (api: MemoryApi, approvalId: string, who?: Principal) => ReturnType<MemoryApi["approvals"]["grant"]>;
};

/** The one switch for a harness: writes + Hindsight → on; Hindsight only → read; writes without Hindsight → on with HINDSIGHT_URL=off. */
export function switchEnv(writes: boolean, hindsight: boolean, url: string): Record<string, string> {
  if (writes) return { MU_MEMORY_WRITES: "on", HINDSIGHT_URL: hindsight ? url : "off" };
  return { MU_MEMORY_WRITES: hindsight ? "read" : "off", HINDSIGHT_URL: url };
}

export async function setup(opts: { writes?: boolean; hindsight?: boolean; url?: string; proxy?: boolean; writerCapability?: boolean } = {}): Promise<Harness> {
  const base = mkdtempSync(join(tmpdir(), "mu-memory-connector-"));
  temps.push(base);
  const vault = join(base, "vault");
  const state = join(base, "app", ".operator-data", "memory");
  cpSync(FIXTURE, vault, { recursive: true });
  // proxy: true behaves like the client proxy (no key, approval tokens on deletes, its own write gate).
  const fake = await startFakeHindsight(
    opts.proxy ? { approvalSecret: SYNTHETIC_APPROVAL_SECRET, ...(opts.writerCapability !== undefined ? { writerCapability: opts.writerCapability } : {}) } : { apiKey: SYNTHETIC_KEY },
  );
  fakes.push(fake);
  const secretFile = join(base, "synthetic-approval.key");
  writeFileSync(secretFile, SYNTHETIC_APPROVAL_SECRET + "\n");
  const env: Record<string, string> = {
    ...switchEnv(opts.writes !== false, opts.hindsight !== false, opts.url ?? fake.url),
    HINDSIGHT_BANK: BANK,
    ...(opts.proxy ? {} : { HINDSIGHT_API_KEY: SYNTHETIC_KEY }),
    HINDSIGHT_APPROVAL_SECRET_FILE: secretFile,
    MU_WIKI_ROOT: vault,
    MU_WIKI_VAULT_NAME: "mini-wiki",
    MEMORY_STATE_DIR: state,
  };
  let t = Date.parse("2026-09-28T01:00:00.000Z");
  const now = () => new Date((t += 1000));
  const peek = () => t;
  const spoken = new SpokenConfirmationLedger(peek);
  const telegram: { personId: string; text: string }[] = [];
  const notify = (personId: string, text: string) => (telegram.push({ personId, text }), { ok: true, detail: "captured by the test" });
  const make = (envOverride: Record<string, string> = {}) => {
    const e = { ...env, ...envOverride };
    const settings = resolveMemorySettings(e, join(base, "app"));
    // Each api (a "restart") opens the SAME durable approvals store in the state dir, as the OS would.
    return createMemoryApi({
      settings,
      env: e,
      now,
      indexWaitMs: 8000,
      timeouts: { retain: 4000, recall: 4000, other: 4000 },
      spoken,
      approvals: () => localApprovals(settings.stateDir, { spoken, now: peek, notify }),
    });
  };
  const codeFor = (personId: string) => {
    const m = [...telegram].reverse().find((x) => x.personId === personId)?.text.match(/approve ([A-Z0-9]{4}-[A-Z0-9]{4})/);
    return m ? m[1] : null;
  };
  const approveUi = (api: MemoryApi, approvalId: string, who: Principal = usman) => {
    const card = api.approvals.card(approvalId, who);
    return api.approvals.grant(approvalId, who, "ui", { cardNonce: card?.cardNonce ?? "00000000-0000-4000-8000-000000000000" });
  };
  return { base, vault, state, fake, env, api: make(), make, bankDocs: () => fake.bank(BANK), advance: (ms: number) => void (t += ms), clock: peek, spoken, telegram, codeFor, approveUi };
}

/** sha256 of every file under a folder, for "nothing here changed" checks. */
export function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (rel: string) => {
    for (const name of readdirSync(join(dir, rel))) {
      const r = rel ? `${rel}/${name}` : name;
      if (statSync(join(dir, r)).isDirectory()) walk(r);
      else out[r] = createHash("sha256").update(readFileSync(join(dir, r))).digest("hex");
    }
  };
  walk("");
  return out;
}

/** Every file under a folder as text (to prove a value never landed there). */
export function allText(dir: string): string {
  const snap = snapshot(dir);
  return Object.keys(snap)
    .map((r) => readFileSync(join(dir, r), "utf8"))
    .join("\n");
}
