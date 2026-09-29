// Desk payments wired to the real PC: the agent-browser hands on Jarvis Chrome, away mode's receipts file, and his own
// config (.operator-data/desk-payments/config.json: his billers and his bank's site; never a secret, never a card).
//
// A preview copy of the OS (AGENTIC_OS_NO_BACKGROUND=1) started with DESK_PAY_SYNTHETIC=1 gets a FAKE Jarvis Chrome and
// receipts in its own scratch folder instead: a bill page whose "Pay" button only changes a JS object. That is how the
// confirm card is looked at without a real browser, bank, card or payment. Nothing else reads that variable.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { agentBrowserExe, createAgentBrowserHands, spawnRunner, type BrowserHands } from "../j2/agent-browser";
import { auditLog } from "../away-mode/store";
import { nativeSentinel } from "../away-mode/sentinel";
import { awayDataDir } from "../away-mode/service";
import { backgroundJobsDisabled } from "../preview-guard";
import type { DeskConfig } from "./request";
import { createDeskPayments, type DeskPayments } from "./service";

const str = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);

/** His billers (alias → site) and his bank's site, from .operator-data/desk-payments/config.json. Sites only; bad entries dropped. */
export function readDeskConfig(root: string): DeskConfig {
  try {
    const raw = JSON.parse(readFileSync(join(root, ".operator-data", "desk-payments", "config.json"), "utf8")) as Record<string, unknown>;
    const site = /^(?:https?:\/\/)?(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/.*)?$/i;
    const billers: Record<string, string> = {};
    if (raw.billers && typeof raw.billers === "object")
      for (const [alias, host] of Object.entries(raw.billers as Record<string, unknown>).slice(0, 100)) {
        const h = str(host, 100);
        if (/^[\p{L}\p{N} .&'-]{2,40}$/u.test(alias) && h && site.test(h)) billers[alias.toLowerCase()] = h.replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/\/.*$/, "").toLowerCase();
      }
    const bank = str(raw.bank, 100);
    return { billers, ...(bank && site.test(bank) ? { bank } : {}) };
  } catch {
    return {};
  }
}

/**
 * Away mode's own state file, read strictly: on → true, off or never written → false, and an unreadable or corrupt file → null
 * (away-mode/store.ts maps that to "off", which is right for away mode but not for deciding he is at his desk). Pure I/O.
 */
export function awayStateOn(root: string): boolean | null {
  const file = join(root, ".operator-data", "away-mode", "state.json");
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "ENOENT" ? false : null;
  }
  try {
    const parsed = JSON.parse(raw) as { version?: unknown; on?: unknown };
    return parsed && typeof parsed === "object" && parsed.version === 1 && typeof parsed.on === "boolean" ? parsed.on : null;
  } catch {
    return null;
  }
}

export function createLiveDeskPayments(options: {
  root: string;
  awayOn: () => boolean | null;
  present?: () => Promise<string | null>;
  ensure?: () => Promise<boolean>;
}): DeskPayments {
  const synthetic = process.env.DESK_PAY_SYNTHETIC === "1" && backgroundJobsDisabled();
  // Presence: the away sentinel's own idle and lock readings (a tiny helper, started once on a real server), polled every 10 s.
  let presence: { locked: boolean | null; idleMs: number | null } | null = null;
  if (!synthetic && !backgroundJobsDisabled() && process.platform === "win32" && process.env.NODE_ENV !== "test") {
    try {
      const sentinel = nativeSentinel(join(awayDataDir(options.root), "bin"));
      const poll = async () => {
        if (!sentinel.running) await sentinel.start().catch(() => false);
        presence = sentinel.running ? { locked: await sentinel.locked().catch(() => null), idleMs: await sentinel.idleMs().catch(() => null) } : null;
      };
      void poll();
      setInterval(() => void poll(), 10_000).unref?.();
    } catch {
      presence = null;
    }
  }
  let hands: BrowserHands | null | undefined;
  const realHands = async (): Promise<BrowserHands | null> => {
    if (hands !== undefined) return hands;
    const exe = agentBrowserExe();
    hands = exe ? createAgentBrowserHands({ run: spawnRunner(exe) }) : null;
    return hands;
  };
  const fakeHands = async (): Promise<BrowserHands> => {
    if (hands) return hands;
    const { billPage, fakeChrome } = await import("./fake-bank");
    const chrome = fakeChrome({ "https://originenergy.com.au/pay": billPage() });
    chrome.world.go("https://originenergy.com.au/pay");
    hands = createAgentBrowserHands({ run: chrome.run, port: 9222 });
    return hands;
  };
  const receiptDir = synthetic ? join(options.root, ".operator-data", "desk-payments", "synthetic") : awayDataDir(options.root);
  const audit = auditLog(receiptDir);
  return createDeskPayments({
    hands: synthetic ? fakeHands : realHands,
    ensure: synthetic ? undefined : options.ensure,
    present: synthetic ? undefined : options.present,
    receipts: { write: (entry) => audit.receipt(entry) },
    awayOn: options.awayOn,
    presence: () => presence,
    config: () => readDeskConfig(options.root),
    settleMs: synthetic ? 0 : undefined,
    afterPressMs: synthetic ? 0 : undefined,
    sleep: synthetic ? async () => undefined : undefined,
    log: (line) => void audit.write({ action: "desk-payment", result: line }),
  });
}
