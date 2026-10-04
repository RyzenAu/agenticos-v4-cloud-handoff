// @ts-ignore: the browser tsconfig has no bun types (bun test supplies this module).
import { afterEach, describe, expect, test } from "bun:test";
import React, { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { readFileSync } from "node:fs";
import { WorkspaceStage, inertProps } from "./stage";
import { statusActionVisible, type StatusAction } from "./status";

let root: Root | undefined;
const restore: Array<() => void> = [];
function setGlobal(name: string, value: unknown) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  restore.push(() => (previous ? Object.defineProperty(globalThis, name, previous) : Reflect.deleteProperty(globalThis, name)));
}
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  while (restore.length) restore.pop()!();
});

/** A stand-in for the conversation: a draft held in state, and a count of how many times it was mounted. */
let mounts = 0;
function FakeChat() {
  const [draft, setDraft] = useState("");
  React.useEffect(() => {
    mounts += 1;
  }, []);
  return (
    <div>
      <textarea data-testid="draft" value={draft} readOnly />
      <button data-testid="type" onClick={() => setDraft("Compare the three clinics")} />
    </div>
  );
}
function Page({ panels }: { panels: Array<"new" | "archived" | null> }) {
  const [i, setI] = useState(0);
  return (
    <div>
      <button data-testid="next" onClick={() => setI((n) => n + 1)} />
      <WorkspaceStage panel={panels[i] ? <p data-testid="panel">{panels[i]}</p> : null}>
        <FakeChat />
      </WorkspaceStage>
    </div>
  );
}

describe("WorkspaceStage: a bot-list panel never unmounts the conversation", () => {
  test("a draft survives opening and closing New bot and Show archived", async () => {
    const { window } = parseHTML("<html><body><main></main></body></html>");
    setGlobal("window", window);
    setGlobal("document", window.document);
    setGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    mounts = 0;
    const container = window.document.querySelector("main")!;
    root = createRoot(container);
    await act(async () => root!.render(<Page panels={[null, "new", null, "archived", null]} />));
    const box = () => container.querySelector('[data-testid="draft"]') as HTMLTextAreaElement;
    const first = box();
    await act(async () => void (container.querySelector('[data-testid="type"]') as HTMLElement).dispatchEvent(new (window as any).Event("click", { bubbles: true })));
    expect(box().value).toBe("Compare the three clinics");
    for (const expected of ["new", null, "archived", null] as const) {
      await act(async () => void (container.querySelector('[data-testid="next"]') as HTMLElement).dispatchEvent(new (window as any).Event("click", { bubbles: true })));
      expect(container.querySelector('[data-testid="panel"]')?.textContent ?? null).toBe(expected);
      expect(container.querySelector('[data-testid="workspace-body"]')!.getAttribute("data-hidden")).toBe(expected ? "true" : null);
      expect(box()).toBe(first); // the same element: not remounted
      expect(box().value).toBe("Compare the three clinics");
    }
    expect(mounts).toBe(1);
  });

  test("the page really uses it: no conditional that drops the body while a panel is open", () => {
    const page = readFileSync(new URL("./workspace-page.tsx", import.meta.url), "utf8");
    expect(page).toContain("<WorkspaceStage");
    expect(page).not.toMatch(/!panel\s*&&/);
    // everything outside the full-screen computer is made inert: the list or selector, and the header with the tab row
    expect((page.match(/inertWhile\(fullScreen\)/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });
});

describe("inertProps", () => {
  test("inert only while asked", () => {
    expect(inertProps(true)).toEqual({ inert: true });
    expect(inertProps(false)).toEqual({});
  });
});

describe("statusActionVisible: the header action on Chat", () => {
  const toComputer: StatusAction = { label: "Show computer", tab: "computer" };
  test("with the computer panel closed a specific next step is there and points at the computer; a plain Show computer is not repeated beside the toggle", () => {
    expect(statusActionVisible({ label: "Reconnect", tab: "computer" }, "chat", false)).toBe(true);
    expect(statusActionVisible(toComputer, "chat", false)).toBe(false);
  });
  test("with the computer showing it would repeat itself, so it goes", () => {
    expect(statusActionVisible(toComputer, "chat", true)).toBe(false);
  });
  test("on Tasks or Setup it is always offered; never on the tab it names; nothing without an action", () => {
    expect(statusActionVisible(toComputer, "setup", true)).toBe(true);
    expect(statusActionVisible({ label: "Open Setup", tab: "setup" }, "setup", false)).toBe(false);
    expect(statusActionVisible({ label: "Open Tasks", tab: "tasks" }, "chat", true)).toBe(true);
    expect(statusActionVisible(null, "chat", false)).toBe(false);
  });
});
