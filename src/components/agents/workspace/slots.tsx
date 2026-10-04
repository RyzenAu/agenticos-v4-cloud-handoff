// The Chat and Setup tabs: the bot's conversation (B2's BotChat) and its setup (B4's BotSetup), wired by the lead at integration.
// The conversation id is per (signed-in person, bot): `agent:<personId>:<botId>`; the person comes from the verified principal
// (/__devices/me), never from a typed name.
import { useNavigate } from "@tanstack/react-router";
import { Button, EmptyState } from "@/components/ds";
import { BotChat, type BotChatStatus, type ChatActivity } from "@/components/agents/chat/bot-chat";
import { BotSetup } from "@/components/agents/setup/bot-setup";
import { useSignedIn } from "@/components/shell/signed-in";
import { agentConversationId } from "@/lib/agent-chat";
import { reconnectComputer, type ComputerView } from "@/lib/computers-client";
import type { Bot } from "./bots";
import type { BotStatus } from "./status";

export type SlotProps = { bot: Bot; status: BotStatus };
export type ChatSlotProps = SlotProps & { onActivity?: (a: ChatActivity) => void };

/** The shell's status kinds mapped onto the chat's: a computer held by a person reads as "needs you" in the conversation. */
export function chatStatusFrom(status: BotStatus, bot: Bot): BotChatStatus {
  const state: BotChatStatus["state"] = status.kind === "held" ? "needs-you" : status.kind;
  return { state, reasons: bot.readiness?.reasons ?? [status.text] };
}

/** Pure: why the command box is off, or undefined. An archived bot takes no requests; a bot with no usable computer and no coding has nothing to run them on. */
export function inputOff(bot: Pick<Bot, "lifecycle" | "computer" | "coding" | "readiness">, status?: Pick<BotStatus, "kind">): string | undefined {
  if (bot.lifecycle === "archived" || bot.lifecycle === "archiving") return "Archived: unarchive it to talk to it";
  if (status?.kind === "unconfigured") return "Choose a computer in Setup first";
  return undefined;
}

/**
 * Pure: the status the conversation may show as a banner. Only a bot that has a computer (on this hub) which is stopped or asleep: that banner's Reconnect does
 * something real. Not for an archived bot, not for a bot with no computer (the header says that, once, with its one action).
 */
export function chatBannerStatus(bot: Pick<Bot, "lifecycle" | "computer">, status: Pick<BotStatus, "kind">): { state: "offline" } | undefined {
  if (bot.lifecycle === "archived" || bot.lifecycle === "archiving" || !bot.computer) return undefined;
  return status.kind === "offline" ? { state: "offline" } : undefined;
}

/** The conversation a browser that is not confirmed gets: nothing private, and the one real next step (the confirm-code panel on System). */
export const PAIRING_HREF = "/system#system-devices";
export function UnconfirmedChat() {
  return (
    <EmptyState
      title="Sign in to talk to this bot"
      body="Each founder has their own conversation with a bot, and it stays hidden until this browser is confirmed with a code."
      action={<Button asChild variant="accent"><a href={PAIRING_HREF}>Confirm this browser</a></Button>}
    />
  );
}

export function ChatSlot({ bot, status, onActivity, computer = null }: ChatSlotProps & { computer?: ComputerView | null }) {
  const me = useSignedIn();
  const navigate = useNavigate();
  if (!me?.id) return <UnconfirmedChat />;
  return (
    <BotChat
      bot={{ id: bot.id, name: bot.name, computer: bot.computer }}
      conversationId={agentConversationId(me.id, bot.id)}
      // The page's header says what state the bot is in, once. The conversation adds a banner only where its Reconnect can do something real, and a box that is off when nothing could run.
      status={chatBannerStatus(bot, status)}
      onReconnect={async () => (await reconnectComputer(computer, bot.computer)).message}
      inputDisabled={inputOff(bot, status)}
      onActivity={onActivity}
      links={{ computer: () => (bot.computer ? `/agents/workspace/${bot.id}?tab=computer` : null) }}
      onNavigate={(href) => (href.startsWith("/__") ? window.open(href, "_blank", "noopener") : void navigate({ to: href }))}
    />
  );
}

export function SetupSlot({ bot }: SlotProps) {
  const navigate = useNavigate();
  return <BotSetup botId={bot.id} navigate={(to: string) => void navigate({ to })} />;
}
