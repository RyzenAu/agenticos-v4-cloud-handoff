// BotChat: one bot's conversation and the single command surface for that bot. Typed and spoken requests, a concise acknowledgement, live
// background progress, honest blockers with a recovery, the result with its files, and links to the job and the bot's computer.
//
// It owns no routes and no shell: the workspace mounts it (`<BotChat bot=... conversationId=... />`) and may pass `links`, `onNavigate` and
// `status`. All data goes through src/lib/agent-chat.ts (the `api` prop swaps it for a fake in tests and the fixture).
import { useEffect, useMemo, useRef, useState } from "react";
import { Notice, EmptyState } from "@/components/ds";
import { type AgentChatApi } from "@/lib/agent-chat";
import { cn } from "@/lib/utils";
import { recoveryFor, toBlocks, type Item, type Recovery, type Run } from "./chat-state";
import { AckLine, NoteLine, RequestBubble, RunCard, defaultLinks, type ChatLinks } from "./entries";
import { Composer } from "./composer";
import { ReadNotice } from "./read-notice";
import { VoiceButton, type VoiceStarter } from "./voice-button";
import { useBotChat, type Notification, type Subscribe } from "./use-bot-chat";

export type BotChatBot = { id: string; name: string; computer?: string | null };
/** What the bot is doing right now, for a surface beside the conversation (the computer panel): the task, and what it needs from the person. */
export type ChatActivity = { task: string | null; state: "running" | "blocked" | null; recovery: Recovery | null };
export const NO_ACTIVITY: ChatActivity = { task: null, state: null, recovery: null };

/** Pure: the newest blocked run if there is one (it is the next thing the person can act on), else the newest running one. */
export function activityOf(blocks: readonly ReturnType<typeof toBlocks>[number][]): ChatActivity {
  const runs = blocks.filter((b): b is Run => b.type === "run");
  const run = [...runs].reverse().find((r) => r.status === "blocked") ?? [...runs].reverse().find((r) => r.status === "running");
  if (!run) return NO_ACTIVITY;
  return { task: run.title || null, state: run.status === "blocked" ? "blocked" : "running", recovery: recoveryFor(run) };
}

export type BotChatStatus = { state: "ready" | "working" | "needs-you" | "offline" | "unconfigured"; reasons?: string[] };

/** True when the person asked for no motion: smooth scrolling and arrival easing are then off. */
export function prefersReducedMotion(): boolean {
  try {
    return typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

export function BotChat({
  bot,
  conversationId,
  status,
  links,
  onNavigate,
  onNotify,
  onReconnect,
  onActivity,
  api,
  subscribe,
  voice = true,
  startVoice,
  initialDraft,
  className,
  inputDisabled,
}: {
  /** The command box is off, with the reason as its placeholder (an archived bot, a bot with no computer). The conversation stays readable. */
  inputDisabled?: string;
  bot: BotChatBot;
  conversationId: string;
  status?: BotChatStatus;
  links?: Partial<ChatLinks>;
  onNavigate?: (href: string) => void;
  /** A completion, a failure or a "needs you" arrived live (once per job). The shell can use it for a badge or a toast. */
  onNotify?: (n: Notification) => void;
  /** The Reconnect action for an offline bot (the shell knows how to reconnect its computer). Default: re-read the conversation. It may answer with a sentence: it is shown where the person clicked. */
  onReconnect?: () => void | Promise<string | void>;
  /** Told whenever the current task or its blocker changes (never twice for the same thing). The conversation stays the only reader of the thread. */
  onActivity?: (a: ChatActivity) => void;
  api?: AgentChatApi;
  subscribe?: Subscribe;
  voice?: boolean;
  startVoice?: VoiceStarter;
  initialDraft?: string;
  className?: string;
}) {
  const chat = useBotChat({ botId: bot.id, conversationId, api, subscribe, onNotify });
  const merged = useMemo<ChatLinks>(() => {
    const base = defaultLinks(bot.computer ? "/computers" : null);
    return { ...base, ...(links ?? {}) };
  }, [links, bot.computer]);

  const activity = useMemo(() => activityOf(chat.blocks), [chat.blocks]);
  const activityKey = JSON.stringify(activity);
  const lastActivity = useRef<string | null>(null);
  useEffect(() => {
    if (lastActivity.current === activityKey) return;
    lastActivity.current = activityKey;
    onActivity?.(activity);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activityKey]);

  // Arrivals after the first load ease in; history never animates.
  const loadedKeys = useRef<Set<string> | null>(null);
  if (chat.loaded && !loadedKeys.current) loadedKeys.current = new Set(chat.blocks.flatMap((b) => (b.type === "run" ? [b.jobId] : [])));
  const isFresh = (run: Run) => !!loadedKeys.current && !loadedKeys.current.has(run.jobId);

  // Keep the latest at the bottom when the person is already there (never yank them back up from older messages).
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current && typeof el.scrollTo === "function") el.scrollTo({ top: el.scrollHeight, behavior: prefersReducedMotion() ? "auto" : "smooth" });
  }, [chat.blocks, chat.loaded]);

  const requestOf = (key: string) => {
    const b = chat.blocks.find((x) => x.type === "request" && x.item.key === key);
    return b && b.type === "request" ? b.item : undefined;
  };
  /** Send an ack's request again. When its outcome was never learned the SAME event id is used, so the hub runs it once at most; a request the hub declined is a fresh command. */
  const resend = (ack: Item) => {
    const req = requestOf(ack.key);
    if (req) void chat.send(req.text, req.source ?? "typed", ack.unconfirmed ? ack.key : undefined);
  };
  const onAction = (action: string, run: Run) => {
    if (action === "retry") {
      // Retrying sends the original request again (a new command, a new job), from the same conversation.
      const origin = chat.blocks.find((b) => b.type === "request" && b.item.jobId === run.jobId);
      if (origin && origin.type === "request") void chat.send(origin.item.text, "typed");
      else onNavigate?.(merged.job(run.jobId, run.jobKind));
    } else if (action === "reconnect") void doReconnect();
  };

  // Reconnect always ends in a visible answer: busy while it works, then the sentence it returned.
  const [reconnect, setReconnect] = useState<{ busy: boolean; message: string | null }>({ busy: false, message: null });
  const doReconnect = async () => {
    if (reconnect.busy) return;
    setReconnect({ busy: true, message: null });
    let message: string | null = null;
    try {
      const out = await (onReconnect ?? (async () => void chat.refresh()))();
      message = typeof out === "string" ? out : null;
    } catch {
      message = "Couldn't reconnect just now.";
    }
    setReconnect({ busy: false, message });
  };
  const offline = status?.state === "offline" || status?.state === "unconfigured";
  // Nothing to show because the read failed is not "no conversation yet".
  const empty = chat.loaded && chat.blocks.length === 0 && !chat.issue;

  return (
    <section className={cn("flex min-h-0 flex-1 flex-col gap-3", className)} aria-label={`${bot.name} conversation`} data-bot={bot.id}>
      {offline && (
        <Notice
          tone="warn"
          title={status?.state === "unconfigured" ? `${bot.name} is not set up yet` : `${bot.name} is offline`}
          action={
            status?.state === "offline" ? (
              <button type="button" disabled={reconnect.busy} className="ds-interactive rounded-lg px-3 py-2 text-sm font-medium hover:bg-surface-raised disabled:opacity-60" onClick={() => void doReconnect()}>
                {reconnect.busy ? "Reconnecting…" : "Reconnect"}
              </button>
            ) : undefined
          }
        >
          {status?.state === "unconfigured" ? `${bot.name} has no computer yet. Pick one in Setup.` : `${bot.name} can't start new work until its computer is back. Reconnect, or pick a computer in Setup.`}
          {status?.reasons?.length ? ` ${status.reasons.join(" ")}` : ""}
          {reconnect.message && <span role="status" data-testid="reconnect-result" className="mt-1 block font-medium">{reconnect.message}</span>}
        </Notice>
      )}
      {/* Both can be true at once (an offline bot and an unreadable hub store): each says its own cause, neither hides the other. */}
      {chat.issue && <ReadNotice issue={chat.issue} onTryAgain={() => void chat.refresh()} />}
      {chat.streamDown && !chat.issue && (
        <div data-testid="stream-down">
          <Notice tone="info" title="Live updates are paused" role="status">
            This page can't hear the hub right now, so it checks every few seconds instead. Nothing is lost.
          </Notice>
        </div>
      )}

      <div
        ref={scroller}
        role="log"
        aria-label={`${bot.name} conversation`}
        aria-live="off"
        tabIndex={0}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
        className="min-h-0 flex-1 space-y-4 overflow-y-auto rounded-2xl px-1 py-2 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        {!chat.loaded && <p className="px-3 text-sm text-muted-foreground">Loading the conversation…</p>}
        {empty && (
          // R11: the status line above already says why a bot can't take requests (and offers the fix); this stays the normal empty state.
          inputDisabled ? (
            <p className="px-3 py-2 text-sm text-muted-foreground" data-empty="chat">No messages yet.</p>
          ) : (
            <EmptyState variant="row" title={`Ask ${bot.name} for something`} body="Type it or say it. Progress and the finished result land here, so you can leave and come back." />
          )
        )}
        {chat.blocks.map((b) =>
          b.type === "request" ? (
            <RequestBubble key={b.item.via} item={b.item} />
          ) : b.type === "ack" ? (
            <AckLine key={b.item.via} item={b.item} links={merged} onNavigate={onNavigate} onAction={(a) => { if (a === "reconnect") (onReconnect ?? (() => void chat.refresh()))(); }} onRetry={b.item.ok === false ? () => resend(b.item) : undefined} onCheck={b.item.unconfirmed ? () => void chat.refresh() : undefined} />
          ) : b.type === "note" ? (
            <NoteLine key={b.item.via} item={b.item} />
          ) : (
            <RunCard key={`run:${b.jobId}`} run={b} links={merged} onNavigate={onNavigate} onStop={(id) => void chat.stop(id)} stopNote={chat.stopNotes[b.jobId]} onAction={onAction} fresh={isFresh(b)} />
          ),
        )}
      </div>

      {/* One polite line per completion, said once; history never speaks. */}
      <p className="sr-only" role="status" aria-live="polite">
        {chat.announcement}
      </p>

      <Composer
        botName={bot.name}
        initialDraft={initialDraft}
        disabled={inputDisabled}
        onSend={(t) => void chat.send(t, "typed")}
        voice={voice && !inputDisabled ? <VoiceButton botId={bot.id} botName={bot.name} conversationId={conversationId} start={startVoice} /> : undefined}
      />
    </section>
  );
}

export { toBlocks };
