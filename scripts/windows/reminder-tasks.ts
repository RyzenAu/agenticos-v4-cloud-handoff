// Windows-native backup for Jarvis reminders. A reminder normally fires from the in-process
// scheduler (see ../jarvis-skills/timers.ts), but that only works while this OS process (and
// Hermes) is actually running. This registers a one-shot Task Scheduler task per reminder so it
// still fires — as a plain toast — even across a crash or restart.
//
// Idea only, not code: borrowed from FatihMakes/Mark-LIV's actions/reminder.py (CC BY-NC 4.0,
// non-commercial — see the 25 Sep 2026 Ministry review of that repo), which pairs Task Scheduler
// with a local notification. Two things done differently here, per the Ministry's stronger
// recommendation:
//   - ONE FIXED runner script (jarvis-reminder-fire.ps1) is reused for every reminder. The
//     message is always passed as -File argv data, never spliced into a -Command string and
//     never used to generate a fresh per-reminder script (Mark-LIV writes a new .py file per
//     reminder with the message embedded as a JSON literal — avoided here on purpose).
//   - current-user, interactive-only registration: no /RU or /RP, no stored password, no
//     elevation (LogonType InteractiveToken + RunLevel LeastPrivilege — only fires while this
//     user is logged on, which is exactly the "OS not running" case this exists for anyway).
//
// Every schtasks call goes through the injectable `run`, so unit tests never shell out for real.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

export const TASK_FOLDER = "\\MU";
export const TASK_PREFIX = "JarvisReminder-";
/** Below this horizon the in-process timer alone is reliable enough; skip the task entirely. */
export const MIN_TASK_HORIZON_MS = 10 * 60_000;

export const taskName = (id: string) => `${TASK_FOLDER}\\${TASK_PREFIX}${id}`;
/** Reverses taskName() for the startup sweep; null for anything not one of ours. */
export function idFromTaskName(name: string): string | null {
  const short = name.trim().replace(/^\\+/, "").split("\\").pop() ?? "";
  return short.startsWith(TASK_PREFIX) ? short.slice(TASK_PREFIX.length) || null : null;
}

export type RunResult = { code: number; stdout: string; stderr: string };
/** Every schtasks invocation goes through this. Swap for a spy/mock in tests. */
export type CommandRunner = (args: string[]) => Promise<RunResult>;

export const defaultRunner: CommandRunner = (args) =>
  new Promise((resolve) => {
    execFile("schtasks.exe", args, { windowsHide: true, timeout: 15_000 }, (error, stdout, stderr) => {
      const code = error ? ((error as NodeJS.ErrnoException).code === undefined ? 1 : Number((error as { code?: unknown }).code) || 1) : 0;
      resolve({ code, stdout: stdout?.toString() ?? "", stderr: stderr?.toString() ?? "" });
    });
  });

function pad(n: number, w = 2) {
  return String(n).padStart(w, "0");
}
/** Local wall-clock time, no offset — Task Scheduler reads a bare StartBoundary as local time. */
function localIso(d: Date) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function xmlEscape(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}
/** cmd-line quoting for the <Arguments> element: each token double-quoted, inner quotes doubled. */
function quoteArgs(args: string[]) {
  return args.map((a) => `"${a.replace(/"/g, '""')}"`).join(" ");
}

/**
 * The task XML: no <UserId>, no stored credential — LogonType InteractiveToken + RunLevel
 * LeastPrivilege runs as whoever is logged on when the trigger fires, nothing more. One-shot
 * (no repetition), and DeleteExpiredTaskAfter is a Task-Scheduler-side backstop for cleanup —
 * the fire script also deletes itself, since DeleteExpiredTaskAfter is only swept periodically.
 */
export function buildTaskXml(options: { dueAt: Date; args: string[] }) {
  // DeleteExpiredTaskAfter needs a trigger EndBoundary to know when the task "expires" — a few
  // minutes past due is plenty of slack for the fire script to run and self-delete first.
  const endBoundary = new Date(options.dueAt.getTime() + 5 * 60_000);
  return [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    "  <RegistrationInfo><Description>Jarvis reminder (M&amp;U Ventures)</Description></RegistrationInfo>",
    "  <Triggers><TimeTrigger>",
    `    <StartBoundary>${localIso(options.dueAt)}</StartBoundary>`,
    `    <EndBoundary>${localIso(endBoundary)}</EndBoundary>`,
    "    <Enabled>true</Enabled>",
    "  </TimeTrigger></Triggers>",
    "  <Principals><Principal>",
    "    <LogonType>InteractiveToken</LogonType>",
    "    <RunLevel>LeastPrivilege</RunLevel>",
    "  </Principal></Principals>",
    "  <Settings>",
    "    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>",
    "    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>",
    "    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>",
    "    <StartWhenAvailable>true</StartWhenAvailable>",
    "    <ExecutionTimeLimit>PT2M</ExecutionTimeLimit>",
    "    <DeleteExpiredTaskAfter>PT0S</DeleteExpiredTaskAfter>",
    "    <Enabled>true</Enabled>",
    "  </Settings>",
    "  <Actions><Exec>",
    "    <Command>powershell.exe</Command>",
    `    <Arguments>${xmlEscape(quoteArgs(options.args))}</Arguments>`,
    "  </Exec></Actions>",
    "</Task>",
  ].join("\r\n");
}

export type ReminderTaskItem = { id: string; dueAt: string; text: string };
export type ReminderTaskHost = {
  /** Registers the backup task. False if this platform isn't Windows or schtasks refused. */
  register(item: ReminderTaskItem): Promise<boolean>;
  /** Deletes the task; safe to call even if it never existed (e.g. was below the horizon). */
  remove(id: string): Promise<void>;
  /** Records that the in-process scheduler already delivered this one (dedupe with the task). */
  markDelivered(id: string): void;
  /** Startup sweep: delete any \MU\JarvisReminder-* task not among the given active ids. */
  cleanupStale(activeIds: string[]): Promise<void>;
};

const MAX_DELIVERED = 200;

/** A preview (ARGENTIC_PREVIEW=1) or quiet copy (AGENTIC_OS_NO_BACKGROUND=1) of the OS: never real Windows tasks. */
export function previewCopy(env: NodeJS.ProcessEnv = process.env) {
  return env.AGENTIC_OS_NO_BACKGROUND === "1" || env.ARGENTIC_PREVIEW === "1";
}

export function createReminderTasks(root: string, deps: { run?: CommandRunner; platform?: NodeJS.Platform; preview?: boolean } = {}): ReminderTaskHost {
  const platform = deps.platform ?? process.platform;
  // A preview or quiet copy registers, removes and sweeps NO real scheduled task (REVIEW-T2 R2): its
  // reminders stay in its own in-app scheduler, and its startup sweep can never delete the live OS's tasks.
  const preview = deps.preview ?? previewCopy();
  const run = deps.run ?? defaultRunner;
  const dataDir = join(root, ".operator-data");
  const deliveredFile = join(dataDir, "jarvis-reminders-delivered.json");
  const toastScript = join(__dirname, "jarvis-toast.ps1");
  const fireScript = join(__dirname, "jarvis-reminder-fire.ps1");

  function readDelivered(): Record<string, string> {
    try {
      if (!existsSync(deliveredFile)) return {};
      const data = JSON.parse(readFileSync(deliveredFile, "utf8"));
      return data && typeof data === "object" ? data : {};
    } catch {
      return {};
    }
  }
  function writeDelivered(map: Record<string, string>) {
    mkdirSync(dataDir, { recursive: true });
    const tmp = `${deliveredFile}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
    writeFileSync(tmp, JSON.stringify(map));
    renameSync(tmp, deliveredFile);
  }

  return {
    async register(item) {
      if (platform !== "win32" || preview) return false;
      const args = [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        fireScript,
        "-Id",
        item.id,
        "-Text",
        item.text,
        "-StateFile",
        deliveredFile,
        "-TaskName",
        taskName(item.id),
        "-ToastScript",
        toastScript,
      ];
      const xml = buildTaskXml({ dueAt: new Date(item.dueAt), args });
      mkdirSync(dataDir, { recursive: true });
      const xmlPath = join(dataDir, `.reminder-task-${item.id}.xml`);
      // schtasks /XML wants a real UTF-16LE file matching the declared encoding — Node's
      // "utf16le" write doesn't add the BOM by itself, and without it schtasks misreads the
      // byte order and rejects the file as malformed.
      writeFileSync(xmlPath, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, "utf16le")]));
      try {
        const result = await run(["/Create", "/TN", taskName(item.id), "/XML", xmlPath, "/F"]);
        return result.code === 0;
      } finally {
        try {
          unlinkSync(xmlPath);
        } catch {
          /* best-effort cleanup of the scratch XML */
        }
      }
    },
    async remove(id) {
      if (preview) return;
      if (platform !== "win32") return;
      try {
        await run(["/Delete", "/TN", taskName(id), "/F"]);
      } catch {
        /* nothing to delete, or schtasks refused — either way, nothing else to do */
      }
    },
    markDelivered(id) {
      const map = readDelivered();
      map[id] = new Date().toISOString();
      const pruned = Object.fromEntries(
        Object.entries(map)
          .sort((a, b) => (a[1] < b[1] ? 1 : -1))
          .slice(0, MAX_DELIVERED),
      );
      writeDelivered(pruned);
    },
    async cleanupStale(activeIds) {
      if (preview) return;
      if (platform !== "win32") return;
      let result: RunResult;
      try {
        result = await run(["/Query", "/TN", `${TASK_FOLDER}\\${TASK_PREFIX}*`, "/FO", "LIST"]);
      } catch {
        return;
      }
      if (result.code !== 0) return;
      const active = new Set(activeIds);
      const names = [...result.stdout.matchAll(/^TaskName:\s*(.+)$/gim)].map((m) => m[1].trim());
      for (const name of names) {
        const id = idFromTaskName(name);
        if (!id || active.has(id)) continue;
        try {
          await run(["/Delete", "/TN", name, "/F"]);
        } catch {
          /* best-effort; next startup sweep will try again */
        }
      }
    },
  };
}
