import { spawn } from "node:child_process";
import { join } from "node:path";

/** One row of an independent OS process table. `created` is epoch ms, or null if
 * the OS did not report it. No command lines, owners or environments are read. */
export type ProcessRow = { pid: number; ppid: number; created: number | null };
export type TreeMember = { pid: number; created: number | null };
export type ProcessAccounting = () => Promise<ProcessRow[]>;

const TOLERANCE_MS = 1500;
const near = (a: number, b: number) => Math.abs(a - b) <= TOLERANCE_MS;

/** Independent process accounting: asks the OS for the whole process table instead of
 * trusting the kill command's own exit status. Rejects if the table cannot be read, so
 * callers stay quarantined (an unreadable table is never "tree gone"). */
export const systemProcessTable: ProcessAccounting = () => new Promise((resolve, reject) => {
  const win = process.platform === "win32";
  const executable = win
    ? join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    : "ps";
  const args = win
    ? ["-NoProfile", "-NonInteractive", "-Command",
      "Get-CimInstance Win32_Process | ForEach-Object { '{0},{1},{2}' -f $_.ProcessId,$_.ParentProcessId," +
      "$(if ($_.CreationDate) { ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() } else { '' }) }"]
    : ["-A", "-o", "pid=,ppid=,etimes="];
  const env = win ? { SystemRoot: process.env.SystemRoot || "C:\\Windows" } : { PATH: "/usr/bin:/bin" };
  const child = spawn(executable, args, { env, stdio: ["ignore", "pipe", "ignore"], windowsHide: true, shell: false });
  let out = "";
  const timer = setTimeout(() => { child.kill(); reject(new Error("Process accounting timed out")); }, 20_000);
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { out += chunk; if (out.length > 16 * 1024 * 1024) child.kill(); });
  child.once("error", () => { clearTimeout(timer); reject(new Error("Process accounting unavailable")); });
  child.once("close", (code) => {
    clearTimeout(timer);
    if (code !== 0) return reject(new Error("Process accounting failed"));
    const now = Date.now();
    const rows: ProcessRow[] = [];
    for (const line of out.split(/\r?\n/)) {
      const parts = win ? line.trim().split(",") : line.trim().split(/\s+/);
      if (parts.length < 2 || !parts[0]) continue;
      const pid = Number(parts[0]), ppid = Number(parts[1]);
      if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(ppid)) continue;
      const raw = parts[2] ? Number(parts[2]) : NaN;
      const created = Number.isFinite(raw) ? (win ? raw : now - raw * 1000) : null;
      rows.push({ pid, ppid, created });
    }
    // A table without this very process is not a real table.
    if (!rows.some((row) => row.pid === process.pid)) return reject(new Error("Process accounting incomplete"));
    resolve(rows);
  });
});

/** Live members of a tree rooted at `root`, expanded transitively through parent links.
 * A child must not predate its parent (guards against a reused parent PID). */
export function captureTree(table: ProcessRow[], root: TreeMember): TreeMember[] {
  const live = new Map(table.map((row) => [row.pid, row]));
  const rootRow = live.get(root.pid);
  const first: TreeMember = rootRow && (root.created === null || rootRow.created === null || near(rootRow.created, root.created))
    ? { pid: root.pid, created: rootRow.created ?? root.created } : root;
  const members = new Map<number, TreeMember>([[first.pid, first]]);
  for (let grew = true; grew;) {
    grew = false;
    for (const row of table) {
      const parent = members.get(row.ppid);
      if (!parent || members.has(row.pid) || row.pid === row.ppid) continue;
      if (parent.created !== null && row.created !== null && row.created + TOLERANCE_MS < parent.created) continue;
      members.set(row.pid, { pid: row.pid, created: row.created });
      grew = true;
    }
  }
  return [...members.values()];
}

/** True while any recorded member, or any live process parented by a member, may still
 * exist. Unknown creation times are resolved towards "present" (fail closed), except that
 * a process created after the quarantine began cannot be a member itself. */
export function treeStillPresent(table: ProcessRow[], members: TreeMember[], since: number): boolean {
  const live = new Map(table.map((row) => [row.pid, row]));
  const byPid = new Map(members.map((member) => [member.pid, member]));
  const isMember = (row: ProcessRow, member: TreeMember) => member.created !== null
    ? row.created === null || near(row.created, member.created)
    : row.created === null || row.created <= since + TOLERANCE_MS;
  for (const member of members) {
    const row = live.get(member.pid);
    if (row && isMember(row, member)) return true;
  }
  for (const row of table) {
    const member = byPid.get(row.ppid);
    if (!member || row.pid === row.ppid) continue;
    // The member PID is now held by an unrelated process: its own children are not ours.
    const reuser = live.get(row.ppid);
    if (reuser && reuser.created !== null && row.created !== null && row.created + TOLERANCE_MS >= reuser.created) continue;
    if (member.created === null || row.created === null || row.created + TOLERANCE_MS >= member.created) return true;
  }
  return false;
}
