// Away mode wired to the real PC: screen-hands, Hermes' warm API, the CLIs, files, the sentinel,
// `hermes send`, and two HTTP surfaces:
//   /__operator/away…  the OS card and voice (local, or the owner signed in over Tailscale)
//   /__away/telegram   the Hermes gateway plugin's relay of his Telegram commands (loopback,
//                      its own bearer token, never reachable through Tailscale Serve)
import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { runWarmTask } from "../hermes-api";
import { currentPageMoneyContext } from "../browser-hands";
import { addressBarUrl } from "../screen-hands/refusals";
import { dialogTextOf } from "../screen-hands/plan";
import { parseToolGuardRequest, toolGuard, type ToolGuardDeps } from "./tool-guard";
import { stopOwnedChild } from "../jarvis-execution/child";
import { pcAct } from "../pc-hands";
import { exactRegistrableDomain } from "../../src/lib/money-policy";
import { providerKey } from "../provider-config";
import { readPeople } from "../remote-access";
import type { ScreenHands } from "../screen-hands";
import { hermesNotifier, DEFAULT_OWNER_TELEGRAM } from "./notify";
import type { CliRecipe } from "./policy";
import { createAwayMode, type AwayConfig, type AwayMode } from "./runner";
import { nativeSentinel } from "./sentinel";
import { auditLog, stateStore } from "./store";
import { isAtThisPc, resolveTelegramPrincipal } from "../identity/principal";
import { answerTelegramCode } from "../approvals/telegram-codes";
import type { ApprovalService } from "../approvals/service";
import { listedTelegramIds, personNotifier, type PersonNotifier } from "../approvals/notify";
import { jobsRuntime } from "../jobs/runtime";
import { dataDirFor, dataDirOverride } from "../cloud/data-dir";
import { hubRole } from "../cloud/hub-role";
import { tightenSecret, writeProtectedSecret } from "../identity/local-owner-token";

/** The honest line in the server role: away mode drives a desktop, and the server has none. */
export const SERVER_AWAY_LINE = "Away mode drives a desktop; on the server use your own PC's companion.";

export const DEFAULT_DATA_DIR = "D:\\AgenticOS\\away-mode";

type AwaySettings = Partial<AwayConfig> & { dataDir?: string };
function settings(root: string): AwaySettings {
  try {
    const raw = JSON.parse(readFileSync(join(dataDirFor(root), "away-mode", "config.json"), "utf8"));
    const out: AwaySettings = {};
    for (const k of ["approvalTtlMs", "armIdleMs", "tickMs", "launchWaitMs"] as const) if (Number.isFinite(raw?.[k]) && raw[k] > 0) out[k] = raw[k];
    if (typeof raw?.dataDir === "string" && /^[a-z]:\\/i.test(raw.dataDir)) out.dataDir = raw.dataDir;
    // away.payment: only an explicit true in his own config file switches approvable payments on.
    if (raw?.payments === true) out.payments = true;
    const list = (v: unknown, re: RegExp) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && re.test(x.trim())).map((x) => x.trim()).slice(0, 200) : []);
    // Exact registrable domains only (R5 §5): com.au, vercel.app, github.io, subdomains, IPs and punycode are dropped.
    out.paymentHosts = list(raw?.paymentHosts, /^[a-z0-9.-]+\.[a-z]{2,}$/i)
      .map((h) => exactRegistrableDomain(h))
      .filter((h): h is string => !!h);
    out.savedPayees = list(raw?.savedPayees, /^[\p{L}\p{N} .&'-]{2,60}$/u);
    return out;
  } catch {
    return {};
  }
}

/** His Telegram user ID: the people.json person whose role says owner. */
export function ownerTelegram(root: string) {
  const owner = readPeople(root).find((p) => /\bowner\b/i.test(p.role ?? ""));
  const id = owner?.telegram?.find((t) => /^\d{5,15}$/.test(t));
  return id ?? DEFAULT_OWNER_TELEGRAM;
}

/** Run one CLI recipe with the same bun as this server; the last lines are the result. */
function runCli(root: string) {
  return (recipe: CliRecipe, signal: AbortSignal) =>
    new Promise<{ ok: boolean; output: string }>((resolve) => {
      const bun = /bun(?:\.exe)?$/i.test(process.execPath) ? process.execPath : "bun";
      const child = spawn(bun, recipe.argv, { cwd: root, windowsHide: true, env: { ...process.env, NO_COLOR: "1" } });
      let out = "";
      const keep = (chunk: unknown) => void (out = (out + String(chunk)).slice(-6000));
      child.stdout?.on("data", keep);
      child.stderr?.on("data", keep);
      // Stage 0 F1: end the whole tree (taskkill /t /f), not just bun: a recipe's own children
      // (browsers, sub-CLIs) must not outlive a /stop or a timeout. Direct kill only as a fallback.
      const kill = () => void stopOwnedChild(child).then((stopped) => { if (!stopped) child.kill(); });
      signal.addEventListener("abort", kill, { once: true });
      const timer = setTimeout(kill, recipe.timeoutMs);
      child.on("error", () => resolve({ ok: false, output: "The CLI couldn't start." }));
      child.on("close", (code) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", kill);
        const tail = out.trim().split(/\r?\n/).filter(Boolean).slice(-4).join("\n").slice(-700);
        resolve({ ok: code === 0 && !signal.aborted, output: tail });
      });
    });
}

/** Files: new folders and new files only; a delete goes to the Recycle Bin (never permanent). */
const filePort = {
  exists: (path: string) => existsSync(path),
  mkdir: async (path: string) => void (await mkdir(path, { recursive: true })),
  write: async (path: string, text: string) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text, { flag: "wx" });
  },
  recycle: (path: string) =>
    new Promise<void>((resolve, reject) => {
      // The path goes in an environment variable, so nothing in it is ever parsed as PowerShell.
      const ps = spawn(
        "powershell.exe",
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($env:AWAY_BIN_PATH, 'OnlyErrorDialogs', 'SendToRecycleBin')"],
        { windowsHide: true, env: { ...process.env, AWAY_BIN_PATH: path } },
      );
      ps.on("error", reject);
      ps.on("close", (code) => (code === 0 && !existsSync(path) ? resolve() : reject(new Error(`Couldn't move ${path} to the Recycle Bin.`))));
    }),
};

export function createAwayService(root: string, screen: ScreenHands) {
  const conf = settings(root);
  // MU_DATA_DIR set (the cloud hub): the audit trail lives inside it, not on the PC's D: drive.
  const dataDir = conf.dataDir ?? (dataDirOverride() ? join(dataDirOverride()!, "away-audit") : DEFAULT_DATA_DIR);
  const away = createAwayMode({
    ...(hubRole() === "server" ? { disabled: SERVER_AWAY_LINE } : {}),
    store: stateStore(join(dataDirFor(root), "away-mode")),
    audit: auditLog(dataDir),
    sentinel: nativeSentinel(join(dataDir, "bin")),
    notify: hermesNotifier(() => ownerTelegram(root)),
    screen: {
      act: (req, signal) => screen.act(req, signal),
      stopAll: () => screen.stopAll(),
      flags: () => screen.flags(),
      foreground: () => screen.hands.foreground(),
      snapshot: (win) => screen.hands.snapshot(win),
      windows: () => screen.hands.windows(),
      focus: (handle) => screen.hands.focus(handle),
    },
    hermes: async (prompt, signal) => (await runWarmTask(prompt, { signal, plan: null })).text,
    cli: runCli(root),
    files: filePort,
    launch: (app) => pcAct({ action: "open_app", target: app }),
    ownerChat: () => ownerTelegram(root),
    home: homedir(),
    config: () => settings(root),
    // Rules first, always (jev-fallback.ts): a task classifyTask() alone would send to Hermes
    // only gets one bounded, label-only Jev retry when a key is configured.
    jevKey: () => providerKey(root, "TYPESAFE_API_KEY") || providerKey(root, "JEV_API_KEY"),
    peopleNames: () => readPeople(root).map((p) => p.name),
  });
  // One runner per process: a dev-server reload re-runs the plugin without closing the old server,
  // and two runners on one state file would run a task twice.
  const g = globalThis as { __agenticAwayMode?: AwayMode };
  g.__agenticAwayMode?.close();
  g.__agenticAwayMode = away;
  // The Hermes tool guard reads Jarvis Chrome's current page (never starting it) and the window in front.
  const toolGuardDeps: ToolGuardDeps = {
    page: (pageUrl) => currentPageMoneyContext(pageUrl),
    window: async () => {
      const win = await screen.hands.foreground();
      if (!win) return null;
      const snap = await screen.hands.snapshot(win).catch(() => null);
      return { title: win.title, process: win.process, url: snap ? addressBarUrl(snap.elements) : null, text: dialogTextOf(snap, win.title) };
    },
  };
  return { away, relay: relayMiddleware(root, away, { toolGuard: toolGuardDeps }), route: (input: RouteInput) => awayRoute(input, away) };
}
export type AwayService = ReturnType<typeof createAwayService>;

// --- the OS card and voice: /__operator/away -------------------------------------------------------
type RouteInput = { path: string; method: string; body: any; remote: { name: string; role?: string } | null; send: (value: unknown, status?: number) => void };
export async function awayRoute({ path, method, body, remote, send }: RouteInput, away: AwayMode): Promise<boolean> {
  if (path !== "/away" && !path.startsWith("/away/")) return false;
  if (method === "GET" && path === "/away") {
    send(away.status());
    return true;
  }
  if (method === "GET" && path === "/away/log") {
    send({ text: away.logText(20) });
    return true;
  }
  // The server drives no desktop: refuse every arming or queueing request for every caller, whoever and wherever (honest, not a 200).
  if (hubRole() === "server" && method === "POST" && path === "/away" && ["on", "resume", "task"].includes(String(body?.action ?? ""))) {
    send({ error: SERVER_AWAY_LINE, said: SERVER_AWAY_LINE }, 501);
    return true;
  }
  // Changes: at this PC, or Usman himself over Tailscale (not anyone else on the tailnet).
  if (remote && !/\bowner\b/i.test(remote.role ?? "")) {
    send({ error: "Only Usman can change away mode." }, 403);
    return true;
  }
  if (method === "POST" && path === "/away") {
    const action = String(body?.action ?? "");
    let said: string;
    let extra: Record<string, unknown> = {};
    if (action === "on") said = await away.turnOn("os");
    else if (action === "off") said = away.turnOff("the OS");
    else if (action === "stop") said = away.stop("the OS");
    else if (action === "resume") said = away.resume();
    else if (action === "task") {
      const added = await away.addTask(typeof body?.text === "string" ? body.text : "", "os");
      said = added.said;
      extra = { ok: added.ok, id: added.id };
    } else if (action === "cancel" && Number.isSafeInteger(body?.id)) said = away.cancel(body.id);
    else {
      send({ error: "Say on, off, stop, resume, task or cancel." }, 400);
      return true;
    }
    send({ said, ...extra, status: away.status() });
    return true;
  }
  return false;
}

// --- the Hermes plugin's relay: /__away/telegram --------------------------------------------------------
export function relayTokenFile(root: string) {
  return join(dataDirFor(root), "away-mode", "relay.token");
}
/** file -> "mtime:ctime:size" of the version whose permissions were last checked (server role). */
const relayTightened = new Map<string, string>();
/** The relay's own bearer token, made once; the Hermes plugin reads the same file. */
export function relayToken(root: string) {
  const file = relayTokenFile(root);
  if (existsSync(file)) {
    const saved = readFileSync(file, "utf8").trim();
    if (/^[a-f0-9]{64}$/.test(saved)) {
      // Server role: a relay bearer written by an older start may carry the folder's ACL on Windows; tighten it in place (same value,
      // so Hermes' plugin keeps working) and never refuse to serve over it.
      // The check runs icacls/PowerShell (~0.7 s, synchronous), so it runs once per version of the file, never per request: an
      // untokened local caller looping on /__away must not be able to stall the hub (final review, 2 Oct 2026).
      if (hubRole() === "server") {
        const st = statSync(file);
        const stamp = `${st.mtimeMs}:${st.ctimeMs}:${st.size}`;
        if (relayTightened.get(file) !== stamp) {
          try {
            if (tightenSecret(file)) console.warn("relay token: permissions were wrong and have been tightened");
          } catch {
            /* the relay still works; the warning is the best we can do */
          }
          const after = statSync(file);
          relayTightened.set(file, `${after.mtimeMs}:${after.ctimeMs}:${after.size}`);
        }
      }
      return saved;
    }
  }
  // Protected from its first byte (Windows ignores mode 0o600): see writeProtectedSecret.
  const token = randomBytes(32).toString("hex");
  writeProtectedSecret(file, token);
  return token;
}
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/**
 * The relay's rate limit (REVIEW-T6 finding 1): per Telegram sender, at most RELAY_PER_MINUTE messages a
 * minute, and at most CODE_REPLIES_PER_MINUTE code replies ("approve …", either code format). A burst past
 * that is answered "slow down" and nothing else runs. Memory only (a restart forgets it: harmless).
 */
export const RELAY_PER_MINUTE = 30;
export const CODE_REPLIES_PER_MINUTE = 5;
const CODE_SHAPED = /^\s*(?:yes|approve|approved|y|no|deny|denied|reject|n)\s+[A-Za-z0-9]{4}(?:[-\s][A-Za-z0-9]{4})?\s*[.!]?\s*$/i;
/** Senders tracked at once. Past this, entries are evicted fairly (see relayLimiter). */
export const RELAY_TRACKED_SENDERS = 1000;
/**
 * Per-sender rate limit. Eviction is fair (REVIEW-T6 R2: posting as 1,001 fake senders used to evict the
 * owner's counter and reset it): a listed person (people.json) is never evicted; idle entries (nothing in the
 * last minute) go first, then the oldest UNKNOWN sender. If only listed people remain, nothing is evicted.
 */
export function relayLimiter(now: () => number = Date.now, listed: () => Set<string> = () => new Set()) {
  const seen = new Map<string, { all: number[]; codes: number[] }>();
  const evict = (t: number, keep: string) => {
    const people = listed();
    for (const [k, v] of seen) if (k !== keep && !people.has(k) && !v.all.some((x) => t - x < 60_000)) seen.delete(k);
    if (seen.size <= RELAY_TRACKED_SENDERS) return;
    let oldest: string | null = null;
    let oldestAt = Infinity;
    for (const [k, v] of seen) {
      if (k === keep || people.has(k)) continue;
      const last = v.all[v.all.length - 1] ?? 0;
      if (last < oldestAt) (oldestAt = last), (oldest = k);
    }
    if (oldest !== null) seen.delete(oldest);
  };
  return (senderId: string, text: string): boolean => {
    const t = now();
    const key = senderId || "unknown";
    const s = seen.get(key) ?? { all: [], codes: [] };
    s.all = s.all.filter((x) => t - x < 60_000);
    s.codes = s.codes.filter((x) => t - x < 60_000);
    const code = CODE_SHAPED.test(text);
    if (s.all.length >= RELAY_PER_MINUTE || (code && s.codes.length >= CODE_REPLIES_PER_MINUTE)) return (seen.set(key, s), false);
    s.all.push(t);
    if (code) s.codes.push(t);
    seen.set(key, s);
    if (seen.size > RELAY_TRACKED_SENDERS) evict(t, key);
    return true;
  };
}

export function relayMiddleware(
  root: string,
  away: AwayMode,
  options: { approvals?: () => ApprovalService; limiter?: ReturnType<typeof relayLimiter>; notify?: PersonNotifier; toolGuard?: ToolGuardDeps } = {},
) {
  const allow = options.limiter ?? relayLimiter(Date.now, () => listedTelegramIds(root));
  const notify = options.notify ?? personNotifier(root);
  const approvals = options.approvals ?? (() => jobsRuntime(root).approvals);
  return async (req: IncomingMessage, res: ServerResponse) => {
    const reply = (status: number, value: unknown) => {
      res.statusCode = status;
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Cache-Control", "no-store");
      res.end(JSON.stringify(value));
    };
    // Tailscale Serve also arrives on loopback: at this PC means a loopback socket, a local Host and no
    // relay header at all (Tailscale-*, X-Forwarded-*, Forwarded, Via, X-Real-IP), per the one
    // identity contract (scripts/identity/principal.ts). The gateway bearer below is the real proof.
    if (!isAtThisPc(req)) return reply(403, { error: "loopback only" });
    const auth = String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    if (!same(auth, relayToken(root))) return reply(401, { error: "invalid token" });
    const path = (req.url ?? "").split("?")[0];
    if (req.method !== "POST" || (path !== "/telegram" && path !== "/tool-guard")) return reply(404, { error: "not found" });
    let raw = "";
    for await (const chunk of req as any) {
      raw += chunk;
      if (raw.length > 16_000) return reply(413, { error: "too large" });
    }
    let body: any;
    try {
      body = JSON.parse(raw || "{}");
    } catch {
      return reply(400, { error: "bad json" });
    }
    // The Hermes tool guard (S2e): the plugin's pre_tool_call hook asks before every browser / computer_use
    // action; the verdict runs the OS's own money checks (scripts/away-mode/tool-guard.ts). No guard wired:
    // refuse, so the plugin blocks (fail closed).
    if (path === "/tool-guard") {
      const guardReq = parseToolGuardRequest(body);
      if (!guardReq) return reply(400, { allow: false, message: "Not done: the tool guard couldn't read that request." });
      if (!options.toolGuard) return reply(200, { allow: false, message: "Not done: the tool guard isn't running on the PC. Nothing was pressed or typed." });
      return reply(200, await toolGuard(guardReq, options.toolGuard));
    }
    const str = (v: unknown) => (typeof v === "string" || typeof v === "number" ? String(v) : "");
    const sender = { platform: str(body.platform), userId: str(body.user_id), chatId: str(body.chat_id), chatType: str(body.chat_type) };
    // The gateway proved itself with the relay bearer above; the sender is verified against people.json
    // (a listed person's own DM) by the one identity contract. No hard-coded fallback id.
    const principal = resolveTelegramPrincipal(sender, { root, gatewayVerified: true });
    if (!allow(sender.userId, str(body.text).slice(0, 200)))
      return reply(429, { handled: true, reply: "That's a lot of messages at once, so I've paused for a minute. Nothing was done." });
    // Track 6: a reply in the Telegram-code format ("approve K7PQ-M4XZ") is answered by the approval service
    // (a match, or a counted miss); it never goes on to away mode. Away mode's 4-character codes do, as before.
    const claimed = await answerTelegramCode(principal, str(body.text).slice(0, 200), approvals, { notify });
    if (claimed) return reply(200, { handled: true, reply: claimed });
    const result = await away.telegram({ ...sender, text: str(body.text).slice(0, 4000), principal });
    return reply(200, result);
  };
}
