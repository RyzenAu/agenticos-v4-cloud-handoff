// "Save it as X" / "open the file X" through an app's own common file dialog (Save As, Open), for
// screen_act everywhere (Notepad, Paint, Office, anything using the Windows file dialog).
//
// Windows 11's dialog ignores a file name set programmatically (UIA ValuePattern.SetValue or
// WM_SETTEXT): it reads back fine, then Save writes the dialog's own suggestion instead (found live
// 27 Sep; the same finding is public: github.com/marcelocruzrpa/ultrafast-computer-use PR #4, and
// greatscottgadgets/packetry issue #302). Its lower pane (File name, Save, Cancel) also isn't reliably
// in a UIA tree walk. So, by Win32 control id:
//   1. the dialog must be owned by the window he's working in (never a dialog of another window);
//   2. File name (Edit 1001) is focused through UIA and confirmed focused;
//   3. the name goes in as real input (Ctrl+A, paste; his clipboard restored) and is read back exactly;
//   4. Save/Open (Button 1) is pressed by id, only when its text says Save/Open (UIA Invoke, or
//      BM_CLICK for a classic button with no pattern): never Enter, never the pointer;
//   5. a "replace it?" prompt is always answered No (nothing is overwritten); an error prompt is
//      left for him and reported; nothing is claimed saved until the dialog has closed AND the
//      effect is checked (the file on disk for a full path, else his window's title).
import { basename } from "node:path";
import { existsSync } from "node:fs";
import type { WindowInfo } from "../jarvis-skills/windows";
import { vetAction, type UiElement, type VetContext } from "./plan";

export type FileDialogKind = "save" | "open";
export type DialogOps = {
  owner(handle: number): Promise<number>;
  /** GA_ROOTOWNER: a flyout or editor island (Windows 11 Notepad's RichEditD2DPT) → its app frame. */
  rootOwner(handle: number): Promise<number>;
  alive(handle: number): Promise<boolean>;
  info(handle: number): Promise<{ fileBox: boolean; button1: string; button2: string } | null>;
  focusFileName(handle: number): Promise<boolean>;
  /** Exact read-back after real input (screen-hands' SetDialogValue); throws when it doesn't match. */
  setFileName(handle: number, text: string): Promise<boolean>;
  press(handle: number, id: number, label: string): Promise<"invoke" | "bmclick">;
  promptButtons(handle: number): Promise<string[]>;
  pressPrompt(handle: number, label: string): Promise<boolean>;
};
export type FileDialogDeps = {
  ops: DialogOps;
  foreground(): Promise<WindowInfo | null>;
  windows(): Promise<WindowInfo[]>;
  keys(handle: number, chord: string): Promise<void>;
  signal: AbortSignal;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** The vet context of the run (deny-list, confirmed label, the window). */
  vet: Omit<VetContext, "focused">;
  exists?: (path: string) => boolean;
  /**
   * The app's own menu way in (File → Save as / Open, through UIA), tried when the accelerator
   * opened nothing: Windows 11 Notepad ignores Ctrl+S while its frame holds the focus. `target`
   * is the handle input may go to (the window, or its own flyout/island in front).
   */
  menu?(kind: FileDialogKind, target: () => Promise<number>): Promise<boolean>;
  /** How long to wait for the dialog to open and to close (ms). */
  openMs?: number;
  closeMs?: number;
};
export type FileDialogResult = {
  ok: boolean;
  said: string;
  did: string[];
  /** The effect was checked independently (the file on disk, or the window's title). */
  verified: boolean;
  outcome?: "unverified";
  stopped?: boolean;
  /** How Button 1 was pressed. */
  pressed?: "invoke" | "bmclick";
  /** What was checked: "file" (on disk) or "title". */
  check?: "file" | "title";
  dialog?: number;
};

export const DIALOG_BUTTON: Record<FileDialogKind, string> = { save: "Save", open: "Open" };
/** The keyboard way into each dialog (Notepad, Paint, WordPad, Office's Ctrl+O; Ctrl+Shift+S is Save As). */
export const DIALOG_CHORD: Record<FileDialogKind, string> = { save: "ctrl+shift+s", open: "ctrl+o" };
/** The File name box as the vet sees it (the deny-list and the typing rules apply to it). */
export const FILE_NAME_BOX: UiElement = {
  id: -1001, type: "Edit", x: 0, y: 0, w: 1, h: 1, password: false, enabled: true, focused: true, hasValue: true, readOnly: false,
  name: "File name:", aid: "1001", help: "", value: "",
};
export const isDialog = (w: Pick<WindowInfo, "cls"> | null | undefined) => !!w && w.cls === "#32770";
export const absolutePath = (name: string) => /^(?:[a-z]:[\\/]|\\\\[^\\]+\\)/i.test(name.trim());
const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

export async function runFileDialog(kind: FileDialogKind, name: string, win: WindowInfo, deps: FileDialogDeps): Promise<FileDialogResult> {
  const { ops, signal } = deps;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const exists = deps.exists ?? existsSync;
  const label = DIALOG_BUTTON[kind];
  const verb = kind === "save" ? "saved" : "opened";
  const did: string[] = [];
  const fail = (said: string, extra: Partial<FileDialogResult> = {}): FileDialogResult => ({ ok: false, said, did, verified: false, ...extra });
  const stopped = (): FileDialogResult => fail("Stopped.", { stopped: true });
  const file = name.trim();

  // The name itself passes the typing rules (no codes, card numbers, keys; not into a secure field).
  const typing = vetAction({ do: "type", text: file, field: FILE_NAME_BOX }, { ...deps.vet, focused: FILE_NAME_BOX });
  if (!typing.ok) return fail(typing.said);
  if (signal.aborted) return stopped();

  // 1. The dialog: the one in front if he's already in it, else opened from his window by keyboard.
  let dialog: WindowInfo | null = isDialog(win) ? win : null;
  let parent = dialog ? await ops.owner(dialog.handle).catch(() => 0) : win.handle;
  // Input may go to his window, or to a flyout/island window in front whose root owner is his window.
  const target = async () => {
    const front = await deps.foreground().catch(() => null);
    if (!front || front.handle === win.handle) return win.handle;
    return (await ops.rootOwner(front.handle).catch(() => 0)) === win.handle ? front.handle : win.handle;
  };
  const ours = async (w: WindowInfo | null) =>
    isDialog(w) && w!.handle !== win.handle && ((await ops.owner(w!.handle).catch(() => 0)) === win.handle || (await ops.rootOwner(w!.handle).catch(() => 0)) === win.handle);
  const waitDialog = async (ms: number) => {
    for (const until = now() + ms; !dialog && now() < until; ) {
      if (signal.aborted) return;
      await sleep(250);
      const front = await deps.foreground().catch(() => null);
      if (await ours(front)) dialog = front;
    }
  };
  if (!dialog) {
    const chord = DIALOG_CHORD[kind];
    const key = vetAction({ do: "key", keys: chord, label: chord }, { ...deps.vet, focused: null });
    if (!key.ok) return fail(key.said);
    await deps.keys(await target(), chord);
    did.push(`pressed ${chord}`);
    await waitDialog(deps.menu ? Math.min(2500, deps.openMs ?? 6000) : deps.openMs ?? 6000);
    if (signal.aborted) return stopped();
    if (!dialog && deps.menu && (await deps.menu(kind, target).catch(() => false))) {
      did.push(`chose File, ${kind === "save" ? "Save as" : "Open"}`);
      await waitDialog(deps.openMs ?? 6000);
      if (signal.aborted) return stopped();
    }
    if (!dialog) return fail(`No ${kind === "save" ? "Save As" : "Open"} dialog came up from ${chord}${deps.menu ? " or the File menu" : ""}, so nothing was ${verb}.`);
  }
  if (!parent) return fail("That dialog doesn't belong to a window I can check, so I left it alone.", { dialog: dialog.handle });

  // 2. It must be a file dialog whose button 1 is Save/Open.
  // A freshly opened dialog builds its lower pane a beat later: look for the File name box briefly.
  let info = await ops.info(dialog.handle).catch(() => null);
  for (let i = 0; i < 10 && info && !info.fileBox && !signal.aborted; i++) {
    await sleep(200);
    info = await ops.info(dialog.handle).catch(() => null);
  }
  if (!info?.fileBox) return fail(`That dialog has no File name box, so I left it alone.`, { dialog: dialog.handle });
  if (!sameName(info.button1, label)) return fail(`That dialog's main button says "${info.button1.slice(0, 20)}", not "${label}", so I left it alone.`, { dialog: dialog.handle });
  if (signal.aborted) return stopped();

  // 3. Focus File name, put the name in as real input, read it back exactly.
  // A dialog that has only just opened can refuse the focus once or twice while it settles.
  let focused = false;
  for (let i = 0; i < 4 && !focused && !signal.aborted; i++) {
    if (i) await sleep(250);
    focused = await ops.focusFileName(dialog.handle);
  }
  if (signal.aborted) return stopped();
  if (!focused) return fail(`I couldn't put the cursor in the File name box, so nothing was ${verb}.`, { dialog: dialog.handle });
  let typed = false;
  try {
    typed = await ops.setFileName(dialog.handle, file);
  } catch (error) {
    return fail(`${(error as Error).message}`.slice(0, 200), { dialog: dialog.handle });
  }
  if (!typed) return fail(`The File name box didn't read back exactly, so nothing was ${verb}.`, { dialog: dialog.handle });
  did.push(`typed the file name ${file.length <= 40 ? `"${file}"` : `"…${file.slice(-39)}"`}`);
  if (signal.aborted) return stopped();

  // 4. Button 1, by id, only when it still says Save/Open. The same vet as any click.
  const button: UiElement = { ...FILE_NAME_BOX, id: -1, type: "Button", name: label, aid: "1", hasValue: false, focused: false };
  const press = vetAction({ do: "click", element: button }, { ...deps.vet, focused: FILE_NAME_BOX });
  if (!press.ok) return fail(press.said, { dialog: dialog.handle });
  const pressed = await ops.press(dialog.handle, 1, label);
  did.push(`pressed ${label}`);

  // 5. Wait for the dialog to close; a prompt in front is a replace question (No) or an error (his).
  let closed = false;
  for (const until = now() + (deps.closeMs ?? 8000); now() < until; ) {
    if (signal.aborted) return { ...stopped(), pressed, dialog: dialog.handle };
    await sleep(250);
    if (!(await ops.alive(dialog.handle).catch(() => true))) {
      closed = true;
      break;
    }
    const front = await deps.foreground().catch(() => null);
    if (!isDialog(front) || front!.handle === dialog.handle) continue;
    const owner = await ops.owner(front!.handle).catch(() => 0);
    if (owner !== dialog.handle && owner !== parent) continue;
    const buttons = await ops.promptButtons(front!.handle).catch(() => [] as string[]);
    if (buttons.some((b) => sameName(b, "No")) && buttons.some((b) => sameName(b, "Yes"))) {
      const declined = await ops.pressPrompt(front!.handle, "No").catch(() => false);
      return fail(
        declined
          ? `${basename(file)} already exists. I answered No, so nothing was overwritten; the ${kind === "save" ? "Save As" : "Open"} dialog is still open for you.`
          : `Windows asked whether to replace ${basename(file)} and I couldn't answer No, so it's waiting for you. Nothing was overwritten by me.`,
        { pressed, dialog: dialog.handle },
      );
    }
    return fail(`Windows showed a message ("${front!.title.slice(0, 40)}") instead, so nothing was ${verb}. It's waiting for you.`, { pressed, dialog: dialog.handle });
  }
  if (!closed) return fail(`The dialog didn't close after ${label}, so I can't say it was ${verb}.`, { pressed, dialog: dialog.handle, outcome: "unverified" });

  // 6. Independent check: the file on disk for a full path; else his window's title names it.
  if (kind === "save" && absolutePath(file)) {
    const there = await (async () => {
      for (let i = 0; i < 12; i++) {
        if (exists(file)) return true;
        await sleep(250);
      }
      return false;
    })();
    return there
      ? { ok: true, said: `Saved it as ${basename(file)}.`, did, verified: true, pressed, check: "file", dialog: dialog.handle }
      : fail(`The dialog closed but ${basename(file)} isn't on disk, so I can't say it saved.`, { pressed, dialog: dialog.handle, outcome: "unverified" });
  }
  const want = basename(file.replace(/\//g, "\\").split("\\").pop() ?? file).toLowerCase();
  const stem = want.replace(/\.[a-z0-9]{1,6}$/i, "");
  for (let i = 0; i < 8; i++) {
    const title = ((await deps.windows().catch(() => [] as WindowInfo[])).find((w) => w.handle === parent)?.title ?? "").toLowerCase();
    if (title && (title.includes(want) || (stem.length >= 3 && title.includes(stem)))) return { ok: true, said: `${kind === "save" ? "Saved it as" : "Opened"} ${basename(file)}.`, did, verified: true, pressed, check: "title", dialog: dialog.handle };
    await sleep(250);
  }
  return fail(`The dialog closed, but I can't confirm ${basename(file)} was ${verb}.`, { pressed, dialog: dialog.handle, outcome: "unverified" });
}
