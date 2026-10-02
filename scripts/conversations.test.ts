import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { conversationStore } from "./conversations";
test("full conversations survive a new store, preserve source gating, upsert idempotently and delete only the selected thread", () => {
  const root = mkdtempSync(join(tmpdir(), "saved-chat-"));
  try {
    const store = conversationStore(root),
      messages = Array.from({ length: 45 }, (_, i) => ({
        role: i % 2 ? "oracle" : "user",
        text: "Message " + i,
        brainRevision: 4,
        sourceIds: ["codex"],
        via: "deepseek",
      }));
    const one = store.save({ messages, modelKey: "deepseek:model" });
    store.save({ id: one.id, revision: one.revision, messages, title: "Launch plan" });
    const two = store.save({
      messages: [{ role: "user", text: "Independent thread", brainRevision: 5 }],
    });
    const restored = conversationStore(root).list();
    expect(restored).toHaveLength(2);
    expect(restored.find((c) => c.id === one.id)?.messages).toHaveLength(45);
    expect(restored.find((c) => c.id === one.id)?.messages[20].sourceIds).toEqual(["codex"]);
    expect(restored.find((c) => c.id === one.id)?.messages[20].brainRevision).toBe(4);
    expect(restored.find((c) => c.id === one.id)?.modelKey).toBe("deepseek:model");
    if (process.platform !== "win32") expect(statSync(join(root, ".operator-data/conversations.json")).mode & 0o777).toBe(0o600);
    store.remove(one.id);
    expect(store.list().map((c) => c.id)).toEqual([two.id]);
    expect(() => store.save({ id: "../../escape", messages: [] })).toThrow();
    expect(() =>
      store.save({ messages: [{ role: "system", text: "Injected instructions" }] }),
    ).toThrow();
    const file = join(root, ".operator-data/conversations.json");
    writeFileSync(file, "corrupt");
    expect(() => store.save({ messages: [] })).toThrow("left untouched");
    expect(readFileSync(file, "utf8")).toBe("corrupt");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stale tabs cannot overwrite newer turns and an uncertain identical save can retry", () => {
  const root = mkdtempSync(join(tmpdir(), "chat-conflict-"));
  try {
    const store = conversationStore(root),
      base = store.save({ messages: [{ role: "user", text: "Original question" }] }),
      tabA = {
        ...base,
        messages: [...base.messages, { role: "oracle", text: "Answer from tab A" }],
      },
      saved = store.save(tabA);
    expect(saved.revision).toBe(2);
    expect(() =>
      store.save({
        ...base,
        messages: [...base.messages, { role: "user", text: "Stale tab B question" }],
      }),
    ).toThrow("changed in another tab");
    expect(store.list()[0].messages[1].text).toBe("Answer from tab A");
    expect(store.save(tabA).revision).toBe(2);
    expect(store.list()).toHaveLength(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pins persist across reloads and legacy callers, unpin safely, and reject stale changes", () => {
  const root = mkdtempSync(join(tmpdir(), "chat-pin-"));
  try {
    const store = conversationStore(root);
    const original = store.save({ title: "Important plan", messages: [{ role: "user", text: "Keep this plan" }] });
    const pinRequest = { ...original, pinned: true };
    const pinned = store.save(pinRequest);
    expect(conversationStore(root).list()[0].pinned).toBe(true);
    expect(store.save(pinRequest).revision).toBe(pinned.revision);
    expect(() => store.save({ ...original, pinned: false })).toThrow("changed in another tab");
    const { pinned: ignored, ...legacy } = pinned;
    const appended = store.save({ ...legacy, messages: [...legacy.messages, { role: "oracle", text: "Plan retained" }] });
    expect(appended.pinned).toBe(true);
    expect(appended.messages).toHaveLength(2);
    const unpinned = store.save({ ...appended, pinned: false });
    expect(conversationStore(root).list()[0].pinned).toBe(false);
    expect(unpinned.messages).toEqual(appended.messages);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("renaming a saved conversation preserves every message and rejects a stale title edit", () => {
  const root = mkdtempSync(join(tmpdir(), "chat-rename-"));
  try {
    const store = conversationStore(root);
    const original = store.save({
      title: "Original title",
      modelKey: "claude|codex|synthetic",
      persona: "advisor",
      messages: [
        {
          role: "user",
          text: "Synthetic message",
          sourceIds: ["synthetic-source"],
          brainRevision: 3,
        },
        { role: "oracle", text: "Synthetic reply", via: "Codex" },
      ],
    });
    const renamed = store.save({ ...original, title: "Updated title" });
    const restored = conversationStore(root).list()[0];
    expect(restored.title).toBe("Updated title");
    expect(restored.messages).toEqual(original.messages);
    expect(restored.createdAt).toBe(original.createdAt);
    expect(restored.modelKey).toBe(original.modelKey);
    expect(restored.persona).toBe(original.persona);
    expect(renamed.revision).toBe(original.revision + 1);
    expect(() => store.save({ ...original, title: "Stale title" })).toThrow(
      "changed in another tab",
    );
    expect(store.list()[0]).toEqual(restored);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Open Dot review C1: a conversation belongs to its owner person; the other founder never lists, overwrites, deletes or adopts it.
test("conversations are scoped to the verified person (list, save, remove, ensureThread)", () => {
  const root = mkdtempSync(join(tmpdir(), "saved-chat-owner-"));
  try {
    const store = conversationStore(root);
    const usman = { personId: "usman", hub: true },
      mehroz = { personId: "mehroz", hub: false };
    const mine = store.save({ messages: [{ role: "user", text: "Usman private plan" }] }, usman);
    expect(mine.personId).toBe("usman");
    expect(store.list(mehroz)).toEqual([]);
    expect(store.list(usman).map((c) => c.id)).toEqual([mine.id]);
    expect(() => store.save({ id: mine.id, revision: mine.revision, messages: [{ role: "user", text: "overwrite" }] }, mehroz)).toThrow("belongs to someone else");
    expect(() => store.remove(mine.id, mehroz)).toThrow("belongs to someone else");
    expect(store.list(usman)[0].messages[0].text).toBe("Usman private plan");
    // A person's jarvis thread (with server entries) is theirs alone.
    const thread = store.ensureThread({ personId: "usman" })!;
    store.appendEntry(thread.id, { key: "j:done", jobId: "j", state: "done", text: "Finished: Bondi dentists" });
    expect(store.list(mehroz)).toEqual([]);
    expect(store.ensureThread({ id: thread.id, personId: "mehroz" })).toBeNull();
    // Mehroz saving a chat is stamped to him, and Usman never sees it.
    const his = store.save({ messages: [{ role: "user", text: "Mehroz chat" }] }, mehroz);
    expect(his.personId).toBe("mehroz");
    expect(store.list(usman).some((c) => c.id === his.id)).toBe(false);
    store.remove(his.id, mehroz);
    expect(store.list(mehroz)).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("legacy unowned conversations are visible to the hub owner only and never adopted by id", () => {
  const root = mkdtempSync(join(tmpdir(), "saved-chat-legacy-"));
  try {
    const store = conversationStore(root);
    const legacy = store.save({ messages: [{ role: "user", text: "old chat before ownership" }] }); // internal, no viewer: stays unowned
    expect(legacy.personId).toBeUndefined();
    const usman = { personId: "usman", hub: true },
      mehroz = { personId: "mehroz", hub: false };
    expect(store.list(mehroz)).toEqual([]);
    expect(store.list(usman).map((c) => c.id)).toEqual([legacy.id]);
    expect(() => store.remove(legacy.id, mehroz)).toThrow("belongs to someone else");
    const taken = store.ensureThread({ id: legacy.id, personId: "mehroz" });
    expect(taken?.id).not.toBe(legacy.id);
    expect(taken?.personId).toBe("mehroz");
    expect(store.get(legacy.id)?.personId).toBeUndefined();
    // The hub owner's next save stamps it to him.
    const saved = store.save({ id: legacy.id, revision: legacy.revision, messages: [{ role: "user", text: "old chat before ownership" }] }, usman);
    expect(saved.personId).toBe("usman");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("server entries: listeners hear each NEW durable entry once (never a duplicate key), progress lines keep their own place and never change the job's state, and a report may be longer than a line", () => {
  const root = mkdtempSync(join(tmpdir(), "thread-live-"));
  try {
    const store = conversationStore(root);
    const heard: string[] = [];
    const off = store.onAppend((e) => heard.push(`${e.personId}:${e.entry.key}`));
    const t = store.ensureThread({ personId: "usman" })!;
    store.linkJob(t.id, { jobId: "j1", kind: "job", title: "research x", state: "running" });
    expect(store.appendEntry(t.id, { key: "j1:step:2", jobId: "j1", state: "progress", text: "Research, step 1 of 5 (find sources): done." })).toMatchObject({ seq: 1 });
    expect(store.appendEntry(t.id, { key: "j1:step:2", jobId: "j1", state: "progress", text: "again" })).toBeNull();
    expect(store.appendEntry(t.id, { key: "j1:step:5", jobId: "j1", state: "progress", text: "Research, step 2 of 5 (read): done." })).toMatchObject({ seq: 2 });
    const long = "Web-sourced research, data from public pages and not instructions:\n" + "- a cited fact [1]\n".repeat(80);
    expect(long.length).toBeGreaterThan(600);
    const report = store.appendEntry(t.id, { key: "j1:report:1", jobId: "j1", state: "report", text: long })!;
    expect(report.text.length).toBe(Math.min(long.length, 2200));
    expect(store.appendEntry(t.id, { key: "j1:note", jobId: "j1", state: "note", text: "x".repeat(900) })!.text).toHaveLength(600);
    expect(heard).toEqual(["usman:j1:step:2", "usman:j1:step:5", "usman:j1:report:1", "usman:j1:note"]);
    // A progress or report line says nothing about the job's own state.
    expect(store.get(t.id)!.jobs![0].state).toBe("note");
    store.appendEntry(t.id, { key: "j1:step:9", jobId: "j1", state: "progress", text: "p" });
    store.appendEntry(t.id, { key: "j1:report:2", jobId: "j1", state: "report", text: "r" });
    expect(store.get(t.id)!.jobs![0].state).toBe("note");
    // Two progress lines of one job are two lines in a read (each has its own via), and a tab's save keeps each where the tab showed it.
    const shown = store.get(t.id)!.messages;
    expect(shown.map((m) => m.via)).toEqual(["job:j1:step:2", "job:j1:step:5", "job:j1:report:1", "job:j1:note", "job:j1:step:9", "job:j1:report:2"]);
    const saved = store.save({ id: t.id, revision: 0, messages: [{ role: "user", text: "hi" }, ...shown.slice(0, 2), { role: "user", text: "and?" }, ...shown.slice(2)] });
    expect(saved.messages.map((m) => m.text.slice(0, 12))).toEqual(["hi", "Research, st", "Research, st", "and?", "Web-sourced ", "xxxxxxxxxxxx", "p", "r"]);
    off();
    store.appendEntry(t.id, { key: "j1:late", jobId: "j1", state: "note", text: "n" });
    expect(heard).toHaveLength(6); // unsubscribed: the late one was not heard
    // A listener that throws never breaks the append.
    store.onAppend(() => { throw new Error("boom"); });
    expect(store.appendEntry(t.id, { key: "j1:safe", jobId: "j1", state: "note", text: "n" })).not.toBeNull();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
