import { describe, expect, test } from "bun:test";
import type { PsHost } from "../jarvis-skills/ps-host";
import { FLAGS_OFF } from "./flags";
import { nativeHands, runScreenAct, type Hands } from "./index";
import { nativeScreen } from "./native";
import type { UiElement } from "./plan";

// All native execution is replaced by a synthetic host. No PowerShell or desktop input.
const filename = String.raw`D:\synthetic` + "\\" + "long-folder-".repeat(12) + "report.txt";
const dialog = { handle: 42, process: "Notepad", cls: "#32770", title: "Save as" };
const field: UiElement = {
  id: 1, type: "Edit", name: "File name:", aid: "1001", help: "",
  x: 100, y: 100, w: 200, h: 24, password: false, enabled: true,
  focused: true, hasValue: true, readOnly: false, value: "",
};

function fixture(type: Hands["type"], readback: UiElement | null) {
  const keys: string[] = [];
  let attempted = false;
  const hands: Hands = {
    foreground: async () => dialog, windows: async () => [dialog], focus: async () => true,
    snapshot: async () => ({ window: { x: 0, y: 0, w: 800, h: 600 }, elements: [field], focused: field, browser: false }),
    focused: async () => attempted ? readback : field, at: async () => null, click: async () => undefined,
    type: async (handle, text) => { attempted = true; return type(handle, text); },
    keys: async (_handle, chord) => { keys.push(chord); },
    wheel: async () => undefined, capture: async () => null,
  };
  return { keys, run: () => runScreenAct({ goal: `type ${filename} in there then press Tab` }, {
    hands, flags: { ...FLAGS_OFF, denylist: true, recheck: true },
    signal: new AbortController().signal, sleep: async () => undefined,
  }) };
}

describe("dialog filename confirmation boundaries", () => {
  // Wrong focus, absent filename control and unequal Win32 readback all share the
  // helper's `failed` response. Its adapter mapping is already tested in away-regressions.
  for (const response of ["failed", "moved"] as const) {
    test(`${response} aborts the screen action before fallback typing or the next key`, async () => {
      const scripts: string[] = [];
      const ps: PsHost = {
        run: async (script) => { scripts.push(script); return response; },
        close: () => undefined, warm: () => undefined,
      };
      const native = nativeHands(ps, nativeScreen(ps));
      const f = fixture(native.type, { ...field, value: filename });
      const result = await f.run();
      expect(result.ok).toBe(false);
      expect(scripts).toHaveLength(1);
      expect(scripts[0]).toContain("SetDialogValue(42,");
      expect(f.keys).toEqual([]);
    });
  }

  for (const [label, readback] of [
    ["exact UIA text", { ...field, value: filename }],
    ["unreadable UIA value", { ...field, hasValue: false }],
    ["missing UIA focus", null],
  ] as const) {
    test(`${label} cannot replace native confirmation`, async () => {
      const typed: string[] = [];
      const f = fixture(async (_handle, text) => { typed.push(text); }, readback);
      const result = await f.run();
      expect(result).toMatchObject({ ok: false, said: expect.stringMatching(/did not read back exactly/) });
      expect(typed).toEqual([filename]);
      expect(f.keys).toEqual([]);
    });
  }

  test("exact native confirmation survives a truncated UIA filename and permits the next key", async () => {
    const typed: string[] = [];
    const f = fixture(async (_handle, text) => { typed.push(text); return true; }, { ...field, value: filename.slice(0, 120) });
    expect((await f.run()).ok).toBe(true);
    expect(typed).toEqual([filename]);
    expect(f.keys).toEqual(["tab"]);
  });
});
