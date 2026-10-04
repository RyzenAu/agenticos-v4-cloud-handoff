// Choosing a bot. Two shapes of the same list:
//   BotRail      (wide screens) a persistent left list: each bot with its initial, its name and one live line (Ready, Working on …, Needs you …),
//                then "New bot" and "Archived". A bot that needs you carries a dot AND the words, never colour alone.
//   BotSelector  (tablet and phone) a compact row of names (a native select when there are many), then "New bot" and "Show archived".
// Archived bots are not listed (they take no requests); "Archived" lists them, and a bot opened from there appears in the list, marked
// archived, for as long as it is open. The New bot form and the archived list open in the page, not inside the list, so a narrow rail never
// squeezes a form (BotPanels). The list pattern (identity and live state beside the work) is the idea, from Rakazo's bots sidebar; no code.
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Archive, Plus } from "lucide-react";
import { Button } from "@/components/ds";
import { cn } from "@/lib/utils";
import { PhoneSelect } from "@/components/ds/phone-select";
import { agentBots, botQueryKeys, type AgentBotsClient } from "@/lib/agent-bots";
import { ArchivedBotsPanel } from "@/components/agents/setup/archived-list";
import { NewBotPanel } from "@/components/agents/setup/new-bot-form";
import { liveSources, type SetupSources } from "@/components/agents/setup/sources";
import { isArchivedBot, type Bot } from "./bots";
import { RecentWork } from "./recent-work";
import type { RecentItem } from "./recent";
import { TONE_DOT, shortStatus, type BotStatus, type BotStatusKind } from "./status";

export type BotPanel = "new" | "archived" | null;

/** Pure: the bots the list shows: every active bot, plus the open one when it is archived (so it can be seen and left). */
export function visibleBots<T extends Pick<Bot, "id" | "lifecycle">>(bots: readonly T[], value: string): T[] {
  return bots.filter((b) => !isArchivedBot(b) || b.id === value);
}

/** Pure: the letter on a bot's identity mark. */
export const initialOf = (name: string) => (name.trim().charAt(0) || "?").toUpperCase();

const DIALOGS = '[role="dialog"],[role="alertdialog"],[aria-modal="true"],dialog';

/**
 * Pure: what Escape does inside an open bot-list panel.
 *   "ignore" something else already took it (defaultPrevented) or it was meant for a dialog;
 *   "keep"   the New bot form has text in it: closing would lose it, so Escape does nothing and Cancel is the deliberate way out;
 *   "close"  otherwise. The archived list holds no input, so it always closes.
 */
export function escapeInPanel(e: { key: string; defaultPrevented: boolean; target: EventTarget | null }, panel: "new" | "archived", root: ParentNode | null): "ignore" | "keep" | "close" {
  if (e.key !== "Escape" || e.defaultPrevented) return "ignore";
  const target = e.target as Element | null;
  if (target?.closest?.(DIALOGS)) return "ignore";
  if (panel === "new") {
    const fields = Array.from(root?.querySelectorAll?.("input:not([type=checkbox]):not([type=radio]), textarea") ?? []) as Array<HTMLInputElement | HTMLTextAreaElement>;
    if (fields.some((f) => f.value.trim() !== "")) return "keep";
  }
  return "close";
}

/** The New bot form and the archived list, where the page puts them. Closing, creating and bringing a bot back all land here. */
export function BotPanels({ panel, onPanel, bots, onChange, client = agentBots, sources = liveSources }: { panel: BotPanel; onPanel: (p: BotPanel) => void; bots: readonly Bot[]; onChange: (id: string) => void; client?: AgentBotsClient; sources?: SetupSources }) {
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: botQueryKeys.all });
  // Escape closes the panel (not when it would lose typed text) and focus goes back to the button that opened it.
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!panel) return;
    if (escapeInPanel(e, panel, e.currentTarget) !== "close") return;
    e.preventDefault();
    onPanel(null);
    const opener = panel === "new" ? "new-bot" : "archived-bots";
    requestAnimationFrame(() => (document.querySelector(`[aria-controls="${opener}"]`) as HTMLElement | null)?.focus());
  };
  if (panel === "new") {
    return (
      <div onKeyDown={onKeyDown}>
      <NewBotPanel
        bots={bots}
        client={client}
        sources={sources}
        onCancel={() => onPanel(null)}
        onCreated={(bot) => {
          onPanel(null);
          // The list is read again first, so the page finds the new bot when it opens it (no "there is no agent called" flash).
          void refresh().then(() => onChange(bot.id));
        }}
      />
      </div>
    );
  }
  if (panel === "archived") {
    return (
      <div onKeyDown={onKeyDown}>
      <ArchivedBotsPanel
        bots={bots.filter(isArchivedBot)}
        client={client}
        onOpen={(id) => {
          onPanel(null);
          onChange(id);
        }}
        onChanged={() => void refresh()}
      />
      </div>
    );
  }
  return null;
}

/** The two list-level actions, shared by both shapes. */
function ListActions({ panel, onPanel, archived, className }: { panel: BotPanel; onPanel: (p: BotPanel) => void; archived: number; className?: string }) {
  return (
    <div className={cn("flex flex-wrap items-center gap-1", className)}>
      <Button type="button" variant="ghost" size="sm" aria-expanded={panel === "new"} aria-controls="new-bot" onClick={() => onPanel(panel === "new" ? null : "new")}>
        <Plus className="h-4 w-4" aria-hidden="true" />
        New bot
      </Button>
      <Button type="button" variant="ghost" size="sm" aria-expanded={panel === "archived"} aria-controls="archived-bots" onClick={() => onPanel(panel === "archived" ? null : "archived")}>
        <Archive className="h-4 w-4" aria-hidden="true" />
        {panel === "archived" ? "Hide archived" : `Show archived${archived ? ` (${archived})` : ""}`}
      </Button>
    </div>
  );
}

/** Arrow keys move through a radio group and focus follows the choice. */
function stepKeys(e: React.KeyboardEvent<HTMLButtonElement>, ids: string[], index: number, onChange: (id: string) => void, keys: { next: string[]; prev: string[] }) {
  const step = keys.next.includes(e.key) ? 1 : keys.prev.includes(e.key) ? -1 : 0;
  if (!step) return;
  e.preventDefault();
  onChange(ids[(index + step + ids.length) % ids.length]);
  const group = e.currentTarget.parentElement;
  requestAnimationFrame(() => (group?.querySelector('[aria-checked="true"]') as HTMLElement | null)?.focus());
}

export function BotRail({ bots, value, statuses, onChange, panel, onPanel, className, recent, onOpenRecent }: { bots: readonly Bot[]; value: string; statuses: Record<string, BotStatus>; onChange: (id: string) => void; panel: BotPanel; onPanel: (p: BotPanel) => void; className?: string; recent?: readonly RecentItem[]; onOpenRecent?: (href: string) => void }) {
  const shown = visibleBots(bots, value);
  const archived = bots.filter(isArchivedBot).length;
  const ids = shown.map((b) => b.id);
  return (
    <nav aria-label="Agents" className={cn("flex min-h-0 flex-col gap-3", className)} data-testid="bot-rail">
      <div role="radiogroup" aria-label="Choose an agent" className="flex min-h-0 flex-col gap-1 overflow-y-auto">
        {shown.map((b, i) => {
          const selected = b.id === value;
          const st = statuses[b.id];
          const line = st ? shortStatus(st, b) : "";
          return (
            <button
              key={b.id}
              type="button"
              role="radio"
              aria-checked={selected}
              tabIndex={selected ? 0 : -1}
              title={st?.text}
              data-bot-row={b.id}
              data-status={st?.kind}
              onClick={() => onChange(b.id)}
              onKeyDown={(e) => stepKeys(e, ids, i, onChange, { next: ["ArrowDown", "ArrowRight"], prev: ["ArrowUp", "ArrowLeft"] })}
              className={cn("ds-interactive flex w-full items-center gap-3 rounded-2xl px-3 py-2.5 text-left", selected ? "bg-card ring-1 ring-border" : "hover:bg-surface-raised")}
            >
              <span aria-hidden="true" className={cn("grid size-10 shrink-0 place-items-center rounded-full border text-base font-semibold", selected ? "border-brand/60 bg-inset text-brand" : "border-border bg-inset text-muted-foreground")}>
                {initialOf(b.name)}
              </span>
              <span className="min-w-0 flex-1">
                <span className={cn("block truncate text-[15px] font-medium", selected ? "text-foreground" : "text-foreground/90")}>{b.name}</span>
                {st && (
                  <span className="mt-0.5 flex items-center gap-1.5 text-sm text-muted-foreground">
                    <span aria-hidden="true" className={cn("size-2 shrink-0 rounded-full", TONE_DOT[st.tone])} />
                    <span className="truncate">{line}</span>
                  </span>
                )}
              </span>
            </button>
          );
        })}
      </div>
      <ListActions panel={panel} onPanel={onPanel} archived={archived} className="flex-col items-stretch [&>button]:justify-start" />
      <RecentWork items={recent ?? []} onOpen={onOpenRecent} className="overflow-y-auto" />
    </nav>
  );
}

/** `panel` and `onPanel` together let the page own which panel is open (and put it where it likes); without them the selector shows its own beneath the row. */
export function BotSelector({ bots, value, kinds, onChange, client = agentBots, sources = liveSources, panel: controlled, onPanel, recent, onOpenRecent }: { bots: readonly Bot[]; value: string; kinds: Record<string, BotStatusKind>; onChange: (id: string) => void; client?: AgentBotsClient; sources?: SetupSources; panel?: BotPanel; onPanel?: (p: BotPanel) => void; recent?: readonly RecentItem[]; onOpenRecent?: (href: string) => void }) {
  const [own, setOwn] = useState<BotPanel>(null);
  const panel = onPanel ? controlled ?? null : own;
  const setPanel = onPanel ?? setOwn;
  const shown = visibleBots(bots, value);
  const archived = bots.filter(isArchivedBot);
  const many = shown.length > 3;
  const text = (b: Bot) => `${b.name}${isArchivedBot(b) ? " (archived)" : kinds[b.id] === "needs-you" ? " (needs you)" : ""}`;
  return (
    <>
      {many && <PhoneSelect label="Choose an agent" value={value} onChange={onChange} options={shown.map((b) => ({ value: b.id, text: text(b) }))} />}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div
          role="radiogroup"
          aria-label="Choose an agent"
          className={cn("max-w-full items-center gap-0.5 overflow-x-auto rounded-full border border-border bg-inset p-1", many ? "hidden sm:inline-flex" : "inline-flex")}
        >
          {shown.map((b, i) => {
            const selected = b.id === value;
            return (
              <button
                key={b.id}
                type="button"
                role="radio"
                aria-checked={selected}
                tabIndex={selected ? 0 : -1}
                onClick={() => onChange(b.id)}
                onKeyDown={(e) => stepKeys(e, shown.map((x) => x.id), i, onChange, { next: ["ArrowRight", "ArrowDown"], prev: ["ArrowLeft", "ArrowUp"] })}
                className={cn("ds-interactive inline-flex h-10 shrink-0 items-center gap-2 whitespace-nowrap rounded-full px-4 text-sm font-medium sm:text-base", selected ? "bg-card text-foreground shadow-sm ring-1 ring-border" : "text-muted-foreground hover:text-foreground")}
              >
                {b.name}
                {isArchivedBot(b) && <span className="text-sm font-normal text-muted-foreground">archived</span>}
                {!isArchivedBot(b) && kinds[b.id] === "needs-you" && (
                  <>
                    <span aria-hidden="true" className="h-2 w-2 rounded-full bg-warn" />
                    <span className="sr-only">needs you</span>
                  </>
                )}
              </button>
            );
          })}
        </div>
        <ListActions panel={panel} onPanel={setPanel} archived={archived.length} />
      </div>
      {recent && recent.length > 0 && (
        <details className="group" data-testid="recent-work-fold">
          <summary className="ds-interactive w-fit cursor-pointer rounded-lg px-1 py-1 text-sm text-muted-foreground hover:text-foreground">Recent work ({recent.length})</summary>
          <RecentWork items={recent} onOpen={onOpenRecent} className="pt-1" />
        </details>
      )}
      {!onPanel && <BotPanels panel={panel} onPanel={setPanel} bots={bots} onChange={onChange} client={client} sources={sources} />}
    </>
  );
}
