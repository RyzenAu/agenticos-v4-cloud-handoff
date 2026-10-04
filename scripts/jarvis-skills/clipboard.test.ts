import { describe, expect, test } from "bun:test";
import { answerClipboard, clipboardIntent, spokenClipboard } from "./clipboard";
import { b64 } from "./ps-host";
import type { PsHost } from "./ps-host";

function fakePs(clipboard: string | null) {
  const scripts: string[] = [];
  const ps: PsHost = {
    run: async (script) => {
      scripts.push(script);
      if (script.includes("GetText")) return clipboard === null ? "NOTEXT" : `T${b64(clipboard)}`;
      if (script.includes("SetText")) return "OK";
      return "";
    },
    close: () => undefined,
    warm: () => undefined,
  };
  return { ps, scripts };
}

describe("clipboard phrases", () => {
  test("read and copy", () => {
    expect(clipboardIntent("read my clipboard")).toEqual({ skill: "clipboard", action: "read" });
    expect(clipboardIntent("what's on my clipboard")).toEqual({ skill: "clipboard", action: "read" });
    expect(clipboardIntent("what did I just copy")).toEqual({ skill: "clipboard", action: "read" });
    expect(clipboardIntent("copy that", "It's 3 pm, sir.")).toEqual({ skill: "clipboard", action: "copy", text: "It's 3 pm, sir." });
    expect(clipboardIntent("Copy that to my clipboard.", "x")).toMatchObject({ action: "copy" });
    expect(clipboardIntent("copy what you just said", "y")).toMatchObject({ action: "copy", text: "y" });
  });
  test("not clipboard commands", () => {
    for (const phrase of ["copy the link", "copy this file to my desktop", "paste", "read my emails", "read this", "clipboard manager settings"])
      expect(clipboardIntent(phrase)).toBeNull();
  });
});

describe("reading aloud", () => {
  test("short text, long text, empty, not text", () => {
    expect(spokenClipboard("Meeting moved to 4")).toBe("Your clipboard says: Meeting moved to 4");
    const long = "word ".repeat(100);
    const said = spokenClipboard(long);
    expect(said).toStartWith("Your clipboard has 499 characters. It starts: word word");
    expect(said.length).toBeLessThan(360);
    expect(spokenClipboard("   ")).toBe("Your clipboard is empty, sir.");
    expect(spokenClipboard(null)).toContain("no text");
  });
  test("never reads a secret aloud", () => {
    for (const secret of ["sk-proj-abcdefghijklmnopqrstuvwxyz123456", "password: hunter2", "4111 1111 1111 1111", "Xk9#pLm2$qR7"])
      expect(spokenClipboard(secret)).toBe("Your clipboard holds something that looks like a password or key, sir, so I won't read it aloud.");
  });
  test("through the Windows helper", async () => {
    expect(await answerClipboard({ skill: "clipboard", action: "read" }, fakePs("Hello from the clipboard").ps)).toBe("Your clipboard says: Hello from the clipboard");
    expect(await answerClipboard({ skill: "clipboard", action: "read" }, fakePs("ghp_abcdefghijklmnopqrstuvwxyz0123456789").ps)).toContain("won't read it aloud");
  });
});

describe("copy that", () => {
  test("copies his last answer, passing it as base64 (never as script)", async () => {
    const { ps, scripts } = fakePs("");
    const line = `It's 3 pm'; Remove-Item C:\\ -Recurse; '`;
    expect(await answerClipboard({ skill: "clipboard", action: "copy", text: line }, ps)).toBe("Copied to your clipboard, sir.");
    expect(scripts[0]).not.toContain("Remove-Item");
    expect(scripts[0]).toContain(b64(line));
  });
  test("nothing to copy, or a secret", async () => {
    const { ps, scripts } = fakePs("");
    expect(await answerClipboard({ skill: "clipboard", action: "copy", text: " " }, ps)).toBe("I haven't said anything worth copying yet, sir.");
    expect(await answerClipboard({ skill: "clipboard", action: "copy", text: "the key is sk-ant-abcdefghijklmnopqrstu" }, ps)).toContain("rather not");
    expect(scripts).toEqual([]);
  });
});
