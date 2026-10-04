import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { conversationStore, type SavedMessage } from "./conversations";

const who = { personId: "fixture-owner", hub: true };
function fixture(run: (store: ReturnType<typeof conversationStore>, root: string) => void) {
  const root = mkdtempSync(join(tmpdir(), "conversation-capacity-"));
  try { run(conversationStore(root), root); }
  finally { rmSync(root, { recursive: true, force: true }); }
}
const messages = (count: number): SavedMessage[] => Array.from({ length: count }, (_, n) => ({ role: "user", text: `Synthetic turn ${n}` }));
const file = (root: string) => join(root, ".operator-data/conversations.json");

test("typed capacity refusal is atomic; duplicates at capacity remain idempotent across restart", () => fixture((store, root) => {
  const thread = store.ensureThread({ personId: who.personId })!;
  store.save({ ...thread, messages: messages(499) }, who);
  const last = { key: "request-500:user", role: "user" as const, text: "The last accepted turn" };
  expect(store.appendMessage(thread.id, last)).toBe(true);
  const before = readFileSync(file(root), "utf8");
  const restart = conversationStore(root);
  expect(restart.appendMessage(thread.id, last)).toBe(false);
  expect(readFileSync(file(root), "utf8")).toBe(before);
  const pending = { key: "request-501:user", role: "user" as const, text: "Never acknowledge a dropped turn" };
  expect(() => restart.appendMessage(thread.id, pending)).toThrow("up to 500 messages");
  expect(readFileSync(file(root), "utf8")).toBe(before);
  expect(restart.get(thread.id)!.messages).toHaveLength(500);
  // A rejected key was not claimed. After an ordinary client message is removed, retry can save it once.
  const read = restart.get(thread.id)!;
  restart.save({ ...read, messages: read.messages.slice(1) }, who);
  expect(restart.appendMessage(thread.id, pending)).toBe(true);
  expect(restart.appendMessage(thread.id, pending)).toBe(false);
  expect(conversationStore(root).get(thread.id)!.messages.at(-1)!.text).toBe(pending.text);
}));

test("a read with 500 client messages plus 300 server results can be saved without losing either", () => fixture((store, root) => {
  const thread = store.ensureThread({ personId: who.personId })!;
  const saved = store.save({ ...thread, messages: messages(500) }, who);
  store.linkJob(thread.id, { jobId: "bound-draft", kind: "coding", title: "Synthetic draft", state: "awaiting_confirmation" });
  for (let n = 0; n < 300; n++) store.appendEntry(thread.id, { key: `result-${n}`, jobId: "bound-draft", state: "report", text: `Saved result ${n}` });
  const read = store.get(thread.id)!;
  expect(read.messages).toHaveLength(800);
  expect(read.revision).toBe(saved.revision);
  const renamed = store.save({ ...read, title: "Renamed at capacity" }, who);
  expect(renamed.messages).toHaveLength(800);
  expect(conversationStore(root).get(thread.id)).toEqual(renamed);
  expect(renamed.personId).toBe(who.personId);
  expect(renamed.jobs).toEqual(read.jobs);
  expect(renamed.entries).toEqual(read.entries);
  // Omission of server entries is still not deletion, and cannot erase jobs or their origin binding.
  const clientOnly = store.save({ ...renamed, messages: messages(500) }, who);
  expect(clientOnly.messages).toHaveLength(800);
  expect(clientOnly.jobs).toEqual(read.jobs);
  expect(clientOnly.entries).toEqual(read.entries);
}));

test("an interleaved typed append cannot bypass capacity through the companion snapshot merge", () => fixture((store, root) => {
  const thread = store.ensureThread({ personId: who.personId })!;
  const tab = store.save({ ...thread, messages: messages(499) }, who);
  conversationStore(root).appendMessage(thread.id, { key: "server-late:user", role: "user", text: "Arrived while the tab was open" });
  const before = readFileSync(file(root), "utf8");
  expect(() => store.save({ ...tab, messages: messages(500) }, who)).toThrow("up to 500 messages");
  expect(readFileSync(file(root), "utf8")).toBe(before);
  expect(store.get(thread.id)!.messages.at(-1)!.via).toBe("say:server-late:user");
  // The same partial transcript can still be saved within capacity; omission never means deletion.
  const saved = store.save({ ...tab, title: "Safe rename" }, who);
  expect(saved.messages).toHaveLength(500);
  expect(saved.messages.at(-1)!.via).toBe("say:server-late:user");
}));

test("message and input bounds still reject over-capacity bodies without mutating history", () => fixture((store, root) => {
  const saved = store.save({ messages: messages(1) }, who);
  const before = readFileSync(file(root), "utf8");
  expect(() => store.save({ ...saved, messages: messages(501) }, who)).toThrow("up to 500 messages");
  expect(() => store.save({ ...saved, messages: messages(801).map(m => ({ ...m, via: "job:forged" })) }, who)).toThrow("up to 500 messages");
  expect(readFileSync(file(root), "utf8")).toBe(before);
}));

test("legacy over-cap history permits metadata-only saves and retries, but no over-cap additions or edits", () => fixture((store, root) => {
  const thread = store.ensureThread({ personId: who.personId })!;
  // Synthetic fixture representing an over-cap record created by the previous preservation merge.
  const legacy = { ...thread, messages: messages(501).map((m, n) => ({ ...m, via: `say:legacy-${n}:user` })) };
  writeFileSync(file(root), JSON.stringify([legacy]));
  for (let n = 0; n < 300; n++) store.appendEntry(thread.id, { key: `legacy-job-${n}`, jobId: "bound-job", state: "report", text: `Saved result ${n}` });
  const read = store.get(thread.id)!;
  expect(read.messages).toHaveLength(801);
  const rename = { ...read, title: "Legacy metadata rename", pinned: true };
  const renamed = store.save(rename, who);
  expect(renamed.messages).toEqual(read.messages);
  expect(store.save(rename, who)).toEqual(renamed); // acknowledgment lost, same snapshot retried
  // A partial companion transcript can also preserve the exact same existing typed history.
  const partial = store.save({ ...renamed, title: "Partial transcript rename", messages: [] }, who);
  expect(partial.messages).toEqual(read.messages);
  expect(conversationStore(root).get(thread.id)).toEqual(partial);
  const before = readFileSync(file(root), "utf8");
  const typed = partial.messages.filter(m => !m.via?.startsWith("job:"));
  expect(() => store.save({ ...partial, messages: [...typed, { role: "user", text: "New data" }] }, who)).toThrow("up to 500 messages");
  expect(() => store.save({ ...partial, messages: typed.map((m, n) => n === 0 ? { ...m, text: "Changed above capacity" } : m) }, who)).toThrow("up to 500 messages");
  expect(() => store.save({ ...read, title: "Stale metadata" }, who)).toThrow("changed in another tab");
  expect(readFileSync(file(root), "utf8")).toBe(before);
}));

test("capacity changes preserve founder isolation and stale snapshot protection", () => fixture((store, root) => {
  const saved = store.save({ messages: messages(500) }, who);
  const other = { personId: "other-founder", hub: false };
  const before = readFileSync(file(root), "utf8");
  expect(() => store.save({ ...saved, messages: [] }, other)).toThrow("belongs to someone else");
  expect(() => store.remove(saved.id, other)).toThrow("belongs to someone else");
  expect(store.list(other)).toEqual([]);
  expect(readFileSync(file(root), "utf8")).toBe(before);
  const current = store.save({ ...saved, messages: saved.messages.slice(1) }, who);
  expect(() => store.save({ ...saved, title: "Stale edit" }, who)).toThrow("changed in another tab");
  expect(conversationStore(root).get(saved.id)).toEqual(current);
}));
