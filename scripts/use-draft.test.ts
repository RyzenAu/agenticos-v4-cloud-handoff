import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { clearDrafts, DRAFT_TTL_MS, readDraft, restoredText, writeDraft } from "../src/lib/use-draft";

const store = new Map<string, string>();
const fakeStorage = () => ({
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  key: (i: number) => [...store.keys()][i] ?? null,
  get length() {
    return store.size;
  },
});

// Restore the globals this file replaces: another test file in the same process (round3-context) needs its own `window`.
const hadWindow = Object.prototype.hasOwnProperty.call(globalThis, "window");
const originalWindow = (globalThis as any).window;
function restoreWindow() {
  if (hadWindow) (globalThis as any).window = originalWindow;
  else delete (globalThis as any).window;
}
beforeAll(() => void 0);
beforeEach(() => {
  store.clear();
  (globalThis as any).window = { localStorage: fakeStorage() };
});
afterEach(restoreWindow);
afterAll(restoreWindow);

describe("restoring a draft never overwrites typed text (R11)", () => {
  test("typed after hydration but before sign-in resolves: the typed text wins over a stored draft", () => {
    expect(restoredText("check the leads", "an older draft", "")).toBe("check the leads");
  });
  test("nothing typed yet: the stored draft comes back", () => {
    expect(restoredText("", "an older draft", "")).toBe("an older draft");
    expect(restoredText("", "", "")).toBe("");
  });
  test("a different person on this browser gets only their own draft, never the previous person's text", () => {
    expect(restoredText("usman's words", "mehroz draft", "usman")).toBe("mehroz draft");
    expect(restoredText("usman's words", "", "usman")).toBe("");
  });
});

describe("draft storage", () => {
  test("an unfinished form is remembered and cleared by an empty write", () => {
    writeDraft("coding-request", "Fix the calendar", "usman");
    expect(readDraft("coding-request", "usman")).toBe("Fix the calendar");
    writeDraft("coding-request", "", "usman");
    expect(readDraft("coding-request", "usman")).toBe("");
  });
  test("blocked storage never throws", () => {
    (globalThis as any).window = { get localStorage() { throw new Error("blocked"); } };
    expect(() => writeDraft("k", "v", "usman")).not.toThrow();
    expect(readDraft("k", "usman")).toBe("");
  });
});

describe("round 3 fixer, finding 7: drafts are per person and never hold a credential", () => {
  test("a second person on the same browser does not see the first person's draft", () => {
    writeDraft("memory-note", "Call the landlord about the lease on Friday", "usman");
    expect(readDraft("memory-note", "mehroz")).toBe("");
    expect(readDraft("memory-note", "")).toBe("");
    expect(readDraft("memory-note", "usman")).toBe("Call the landlord about the lease on Friday");
  });
  test("nothing is stored until the person is known", () => {
    writeDraft("memory-note", "A note nobody owns yet", "");
    expect([...store.keys()]).toEqual([]);
  });
  test("text that looks like a credential is not persisted, and typing it removes the earlier draft", () => {
    writeDraft("memory-note", "Remember the wifi plan for the office", "usman");
    writeDraft("memory-note", "the wifi password is sunflower99", "usman");
    expect(readDraft("memory-note", "usman")).toBe("");
    expect([...store.values()].join(" ")).not.toContain("sunflower99");
    writeDraft("memory-note", "my password is only hunter2", "usman");
    expect([...store.values()].join(" ")).not.toContain("hunter2");
  });
  test("a secret already sitting in storage (an older draft) is not restored", () => {
    store.set("agentic-os.draft.v2.usman.memory-note", JSON.stringify({ v: "the password is Xk9#mP2vL", at: Date.now() }));
    expect(readDraft("memory-note", "usman")).toBe("");
    expect(store.size).toBe(0);
  });
  test("old unkeyed drafts are never read and are removed on a sweep; other people's drafts go when a person changes", () => {
    store.set("agentic-os.draft.v1.memory-note", "an old raw draft");
    expect(readDraft("memory-note", "usman")).toBe("");
    writeDraft("coding-request", "mine", "usman");
    writeDraft("coding-request", "theirs", "mehroz");
    clearDrafts("mehroz");
    expect(readDraft("coding-request", "usman")).toBe("");
    expect(readDraft("coding-request", "mehroz")).toBe("theirs");
    expect(store.has("agentic-os.draft.v1.memory-note")).toBe(false);
    clearDrafts();
    expect(store.size).toBe(0);
  });
  test("a draft expires", () => {
    const t0 = 1_000_000;
    writeDraft("jarvis-request", "Open the leads page", "usman", t0);
    expect(readDraft("jarvis-request", "usman", t0 + DRAFT_TTL_MS - 1)).toBe("Open the leads page");
    expect(readDraft("jarvis-request", "usman", t0 + DRAFT_TTL_MS + 1)).toBe("");
  });
});

describe("finding 6: test isolation", () => {
  test("this file leaves the global window as it found it", () => {
    restoreWindow();
    expect(Object.prototype.hasOwnProperty.call(globalThis, "window")).toBe(hadWindow);
  });
});
