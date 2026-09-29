import { describe, expect, test } from "bun:test";
import { createToastSender, toastArgs } from "./windows/jarvis-toast";

describe("toastArgs", () => {
  test("passes title and message as separate argv entries, not one interpolated string", () => {
    const args = toastArgs("C:\\scripts\\jarvis-toast.ps1", "Hermes gateway", "The gateway is down.");
    expect(args).toContain("Hermes gateway");
    expect(args).toContain("The gateway is down.");
    // Neither value is ever glued into another argument.
    expect(args.some((a) => a.includes("Hermes gateway") && a !== "Hermes gateway")).toBe(false);
    expect(args.join(" ")).not.toContain("-Command");
  });

  test("uses -File (never -Command) with the given script path", () => {
    const args = toastArgs("C:\\scripts\\jarvis-toast.ps1", "t", "m");
    const fileIndex = args.indexOf("-File");
    expect(fileIndex).toBeGreaterThanOrEqual(0);
    expect(args[fileIndex + 1]).toBe("C:\\scripts\\jarvis-toast.ps1");
  });

  test("text that looks like PowerShell stays a single inert argument", () => {
    const hostile = '"; Remove-Item C:\\ -Recurse -Force; $x="';
    const args = toastArgs("script.ps1", "Title", hostile);
    expect(args).toContain(hostile);
    // It must land as exactly one argv element — never split, never concatenated with others.
    expect(args.filter((a) => a === hostile).length).toBe(1);
  });

  test("defaults the app id to Jarvis; a custom one is respected", () => {
    expect(toastArgs("s.ps1", "t", "m")).toContain("Jarvis");
    expect(toastArgs("s.ps1", "t", "m", "CustomApp")).toContain("CustomApp");
  });
});

describe("createToastSender", () => {
  test("on Windows, runs powershell.exe with -File and the given title/message", () => {
    const calls: { file: string; args: string[] }[] = [];
    const send = createToastSender({ platform: "win32", run: (file, args) => calls.push({ file, args }) });
    send("Session watcher", "The dental run needs input.");
    expect(calls.length).toBe(1);
    expect(calls[0].file).toBe("powershell.exe");
    expect(calls[0].args).toContain("Session watcher");
    expect(calls[0].args).toContain("The dental run needs input.");
  });

  test("does nothing on a non-Windows platform", () => {
    const calls: unknown[] = [];
    const send = createToastSender({ platform: "darwin", run: (...args) => calls.push(args) });
    send("Title", "Message");
    expect(calls.length).toBe(0);
  });

  test("never throws even with unusual text", () => {
    const send = createToastSender({ platform: "win32", run: () => {} });
    expect(() => send("", "")).not.toThrow();
    expect(() => send("Emoji 🎉", "Ünïcödé and \n newlines")).not.toThrow();
  });
});
