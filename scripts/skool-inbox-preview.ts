import { importInboxSnapshot } from "./inbox-imports";
import type { SkoolChannel } from "./skool-messages";
import type { OperatorState } from "../src/lib/operator";

/** Persist the latest conversation preview; full history stays in the Skool reader. */
export function updateSkoolInboxPreviews(state: OperatorState, channels: SkoolChannel[]) {
  const messages = channels.filter(channel => channel.lastMessage).map(channel => ({
    id: channel.id,
    remoteId: channel.lastMessage!.id,
    threadId: channel.id,
    from: channel.lastMessage!.fromSelf ? `You → ${channel.name}` : channel.name,
    subject: `Conversation with ${channel.name}`,
    body: channel.lastMessage!.content || "[Attachment in Skool]",
    receivedAt: channel.lastMessage!.createdAt,
    direction: channel.lastMessage!.fromSelf ? "outbound" : "inbound",
    read: !channel.unread,
    url: channel.originalUrl,
  }));
  for (let i = 0; i < messages.length; i += 100)
    importInboxSnapshot(state, { provider: "skool", account: "Skool on this Mac", via: "file", messages: messages.slice(i, i + 100) });
  return messages.length;
}
