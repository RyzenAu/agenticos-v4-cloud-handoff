import { expect, test } from "bun:test";
import { EMPTY_STATE } from "../src/lib/operator";
import { updateSkoolInboxPreviews } from "./skool-inbox-preview";
import type { SkoolChannel } from "./skool-messages";
const channel: SkoolChannel = {
  id: "a".repeat(32), name: "Example member", selfId: "b".repeat(32), updatedAt: "2026-09-16T10:00:00Z",
  unread: true, unreadCount: 1, originalUrl: `https://www.skool.com/?ch=${"a".repeat(32)}`,
  lastMessage: { id: "c".repeat(32), content: "Could you review my project?", createdAt: "2026-09-16T10:00:00Z", senderId: "d".repeat(32), fromSelf: false, attachmentCount: 0 },
};
test("a confirmed reply replaces its conversation preview without duplicating or losing local work", () => {
  const state = structuredClone(EMPTY_STATE);
  state.brainSources = { email: false };
  updateSkoolInboxPreviews(state, [channel]);
  expect(state.inbox[0].direction).toBe("inbound");
  Object.assign(state.inbox[0], { draft: "A separate saved thought", read: true, readOverride: true, category: "waiting" });
  updateSkoolInboxPreviews(state, [{ ...channel, lastMessage: { ...channel.lastMessage!, id: "e".repeat(32), fromSelf: true, senderId: channel.selfId!, content: "I have reviewed it.", createdAt: "2026-09-16T10:05:00Z" } }]);
  expect(state.inbox).toHaveLength(1);
  expect(state.inbox[0]).toMatchObject({ direction: "outbound", body: "I have reviewed it.", threadId: channel.id, draft: "A separate saved thought", read: true, category: "waiting" });
  expect(state.brainSources.email).toBe(false);
  expect(state.inboxImports?.[0].count).toBe(1);
});
test("large conversation imports stay complete and attachment-only previews remain useful", () => {
  const state = structuredClone(EMPTY_STATE);
  const channels = Array.from({ length: 205 }, (_, i) => ({ ...channel, id: i.toString(16).padStart(32, "0"), lastMessage: { ...channel.lastMessage!, content: "", attachmentCount: 1 } }));
  expect(updateSkoolInboxPreviews(state, channels)).toBe(205);
  expect(state.inbox).toHaveLength(205);
  expect(state.inbox.every(item => item.body === "[Attachment in Skool]")).toBe(true);
  expect(state.inboxImports?.[0].count).toBe(205);
  expect(updateSkoolInboxPreviews(state, [{ ...channel, lastMessage: null }])).toBe(0);
});
