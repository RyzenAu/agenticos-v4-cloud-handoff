import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTaskXml, createReminderTasks, idFromTaskName, MIN_TASK_HORIZON_MS, TASK_FOLDER, TASK_PREFIX, taskName, type CommandRunner, type RunResult } from "./reminder-tasks";

// Every test here injects a fake CommandRunner — nothing in this file ever calls the real
// schtasks.exe, per the "unit tests never shell out" rule for this feature.
const dirs: string[] = [];
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-reminder-tasks-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function spyRunner(handler: (args: string[]) => RunResult) {
  const calls: string[][] = [];
  const run: CommandRunner = async (args) => {
    calls.push(args);
    return handler(args);
  };
  return { run, calls };
}

describe("task naming", () => {
  test("taskName / idFromTaskName round-trip", () => {
    expect(taskName("t_abc123")).toBe(`${TASK_FOLDER}\\${TASK_PREFIX}t_abc123`);
    expect(idFromTaskName(`${TASK_FOLDER}\\${TASK_PREFIX}t_abc123`)).toBe("t_abc123");
    expect(idFromTaskName("\\MU\\SomethingElse")).toBeNull();
    expect(idFromTaskName(`${TASK_PREFIX}bare`)).toBe("bare");
  });
});

describe("buildTaskXml", () => {
  test("no stored credential, interactive-only, one-shot, self-cleanup backstop", () => {
    const xml = buildTaskXml({ dueAt: new Date(2026, 8, 25, 15, 30, 0), args: ["-File", "C:\\x\\y.ps1", "-Text", "call the bank"] });
    expect(xml).toContain("<LogonType>InteractiveToken</LogonType>");
    expect(xml).toContain("<RunLevel>LeastPrivilege</RunLevel>");
    expect(xml).not.toContain("<UserId>");
    expect(xml).not.toContain("<LogonPassword");
    expect(xml).toContain("<DeleteExpiredTaskAfter>PT0S</DeleteExpiredTaskAfter>");
    expect(xml).toContain("2026-09-25T15:30:00");
    expect(xml).toContain("<Command>powershell.exe</Command>");
    // The reminder text travels as one quoted argv token, never inside a -Command string.
    expect(xml).toContain("&quot;call the bank&quot;");
    expect(xml).not.toContain("-Command");
  });
  test("argv text is XML-escaped, not string-interpolated into script logic", () => {
    const xml = buildTaskXml({ dueAt: new Date(2026, 8, 25, 15, 30, 0), args: ["-Text", 'he said "hi" & <bye>'] });
    expect(xml).toContain("&amp;");
    expect(xml).toContain("&lt;bye&gt;");
    expect(xml).toContain("&quot;");
  });
});

describe("createReminderTasks", () => {
  test("register(): below the horizon is the caller's job, not this module's — but non-Windows always skips", async () => {
    const { run, calls } = spyRunner(() => ({ code: 0, stdout: "", stderr: "" }));
    const tasks = createReminderTasks(temp(), { run, platform: "darwin", preview: false });
    const ok = await tasks.register({ id: "t_1", dueAt: new Date(Date.now() + 3600_000).toISOString(), text: "call the bank" });
    expect(ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  test("register(): calls schtasks /Create with /TN and /XML, cleans up the scratch XML file", async () => {
    const root = temp();
    const seenXmlPaths: string[] = [];
    const { run, calls } = spyRunner((args) => {
      const xmlIndex = args.indexOf("/XML");
      if (xmlIndex >= 0) seenXmlPaths.push(args[xmlIndex + 1]);
      return { code: 0, stdout: "", stderr: "" };
    });
    const tasks = createReminderTasks(root, { run, platform: "win32", preview: false });
    const ok = await tasks.register({ id: "t_2", dueAt: new Date(Date.now() + 3600_000).toISOString(), text: "send the proposal" });
    expect(ok).toBe(true);
    expect(calls[0][0]).toBe("/Create");
    expect(calls[0]).toContain("/TN");
    expect(calls[0]).toContain(taskName("t_2"));
    expect(calls[0]).toContain("/F");
    expect(seenXmlPaths).toHaveLength(1);
    expect(existsSync(seenXmlPaths[0])).toBe(false); // deleted after the call
  });

  test("register(): false when schtasks itself fails", async () => {
    const { run } = spyRunner(() => ({ code: 1, stdout: "", stderr: "Access is denied." }));
    const tasks = createReminderTasks(temp(), { run, platform: "win32", preview: false });
    const ok = await tasks.register({ id: "t_3", dueAt: new Date(Date.now() + 3600_000).toISOString(), text: "x" });
    expect(ok).toBe(false);
  });

  test("remove(): calls schtasks /Delete /F and swallows a \"doesn't exist\" failure", async () => {
    const { run, calls } = spyRunner(() => ({ code: 1, stdout: "", stderr: "ERROR: The system cannot find the file specified." }));
    const tasks = createReminderTasks(temp(), { run, platform: "win32", preview: false });
    await expect(tasks.remove("t_4")).resolves.toBeUndefined();
    expect(calls[0]).toEqual(["/Delete", "/TN", taskName("t_4"), "/F"]);
  });

  test("remove(): no-op on non-Windows", async () => {
    const { run, calls } = spyRunner(() => ({ code: 0, stdout: "", stderr: "" }));
    const tasks = createReminderTasks(temp(), { run, platform: "linux", preview: false });
    await tasks.remove("t_5");
    expect(calls).toHaveLength(0);
  });

  test("markDelivered(): round-trips through the state file the fire script reads", () => {
    const root = temp();
    const tasks = createReminderTasks(root, { run: async () => ({ code: 0, stdout: "", stderr: "" }), platform: "win32", preview: false });
    tasks.markDelivered("t_6");
    const file = join(root, ".operator-data", "jarvis-reminders-delivered.json");
    expect(existsSync(file)).toBe(true);
    const map = JSON.parse(require("node:fs").readFileSync(file, "utf8"));
    expect(Object.keys(map)).toContain("t_6");
  });

  test("cleanupStale(): deletes tasks whose id isn't active, leaves the rest", async () => {
    const queryOutput = [
      `Folder: ${TASK_FOLDER}`,
      "TaskName: " + taskName("keep"),
      "Next Run Time: N/A",
      "",
      "TaskName: " + taskName("stale"),
      "Next Run Time: N/A",
    ].join("\r\n");
    const { run, calls } = spyRunner((args) => (args[0] === "/Query" ? { code: 0, stdout: queryOutput, stderr: "" } : { code: 0, stdout: "", stderr: "" }));
    const tasks = createReminderTasks(temp(), { run, platform: "win32", preview: false });
    await tasks.cleanupStale(["keep"]);
    const deleteCalls = calls.filter((c) => c[0] === "/Delete");
    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0]).toContain(taskName("stale"));
  });

  test("cleanupStale(): a failed /Query is not fatal", async () => {
    const { run } = spyRunner(() => ({ code: 1, stdout: "", stderr: "no tasks" }));
    const tasks = createReminderTasks(temp(), { run, platform: "win32", preview: false });
    await expect(tasks.cleanupStale([])).resolves.toBeUndefined();
  });

  test("MIN_TASK_HORIZON_MS is 10 minutes", () => {
    expect(MIN_TASK_HORIZON_MS).toBe(10 * 60_000);
  });
});

describe("preview and quiet copies never touch real Windows tasks (REVIEW-T2 R2)", () => {
  test("register, remove and the startup sweep make no schtasks call at all", async () => {
    const { run, calls } = spyRunner(() => ({ code: 0, stdout: "", stderr: "" }));
    const tasks = createReminderTasks(temp(), { run, platform: "win32", preview: true });
    expect(await tasks.register({ id: "t_p", dueAt: new Date(Date.now() + 3600_000).toISOString(), text: "synthetic" })).toBe(false);
    await tasks.remove("t_p");
    await tasks.cleanupStale([]);
    expect(calls).toEqual([]);
  });
  test("previewCopy() reads the two preview switches", async () => {
    const { previewCopy } = await import("./reminder-tasks");
    expect(previewCopy({ ARGENTIC_PREVIEW: "1" } as never)).toBe(true);
    expect(previewCopy({ AGENTIC_OS_NO_BACKGROUND: "1" } as never)).toBe(true);
    expect(previewCopy({} as never)).toBe(false);
  });
});
