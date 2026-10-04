// One bot's conversation with its computer beside it. It wires the pieces that already exist: the chat (ChatSlot -> BotChat), the computer
// view and its control-lease controls (ComputerTab), and the layout that places them. Nothing here talks to the hub itself.
// The chat reports what the bot is doing (activity); the panel shows the task and the next blocker from that, using chat-state's recoveryFor.
import { useState } from "react";
import { Notice } from "@/components/ds";
import { NO_ACTIVITY, type ChatActivity } from "@/components/agents/chat/bot-chat";
import { ComputerTab } from "@/components/agents/computer/computer-tab";
import type { ComputerView } from "@/lib/computers-client";
import type { Bot } from "../bots";
import type { BotStatus } from "../status";
import { ChatSlot } from "../slots";
import { ChatComputerLayout } from "./chat-computer-layout";

/**
 * `heldByPerson`: the computer panel already says who holds the controls and what happens to the paused job (its headline and detail), so a take-over
 * notice here would be the same sentence a third time (round 8: "You have the controls", "Research's job is paused...", then "Paused while you have the
 * controls"). Any other blocker (an approval, an offline computer) is still shown.
 */
export function PanelContext({ activity, hideTask, heldByPerson }: { activity: ChatActivity; hideTask?: boolean; heldByPerson?: boolean }) {
  const task = hideTask ? null : activity.task;
  const recovery = heldByPerson && activity.recovery?.kind === "take-over" ? null : activity.recovery;
  if (!task && !recovery) return null;
  return (
    <div className="flex flex-col gap-2" data-testid="panel-context">
      {task && (
        <p className="text-sm" data-testid="panel-task">
          <span className="text-muted-foreground">Task </span>
          <span className="font-medium">{task}</span>
        </p>
      )}
      {recovery && (
        <Notice tone={recovery.tone} title={recovery.title}>
          <span data-testid="panel-blocker">{recovery.body}</span>
        </Notice>
      )}
    </div>
  );
}

export function Conversation({ bot, status, computer, computerReason, me, nameOf, openComputer, onComputerOpened, viewportWidth, toolbarHost, onExpandedChange, onComputerShownChange }: { onExpandedChange?: (expanded: boolean) => void; onComputerShownChange?: (shown: boolean) => void; toolbarHost?: HTMLElement | null; bot: Bot; status: BotStatus; computer: ComputerView | null; computerReason: string | null; me: string | null; nameOf: (id: string) => string; openComputer?: boolean; onComputerOpened?: () => void; viewportWidth?: number }) {
  const [activity, setActivity] = useState<ChatActivity>(NO_ACTIVITY);
  return (
    <ChatComputerLayout
      botName={bot.name}
      hasComputer={!!bot.computer}
      computerLabel={computer?.label || `${bot.name}'s computer`}
      openRequest={openComputer}
      onOpenRequestHandled={onComputerOpened}
      viewportWidth={viewportWidth}
      toolbarHost={toolbarHost}
      onExpandedChange={onExpandedChange}
      onComputerShownChange={onComputerShownChange}
      chat={<ChatSlot bot={bot} status={status} computer={computer} onActivity={setActivity} />}
      renderComputer={() => (
        <ComputerTab
          compact
          botName={bot.name}
          botId={bot.id}
          computerName={bot.computer}
          computer={computer}
          me={me}
          nameOf={nameOf}
          unavailable={computerReason}
          context={<PanelContext activity={activity} hideTask={!!computer?.assigned} heldByPerson={computer?.controller.kind === "person"} />}
        />
      )}
    />
  );
}
