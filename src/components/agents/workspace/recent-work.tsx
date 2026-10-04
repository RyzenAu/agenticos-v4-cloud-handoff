// The bot list's "Recent work": a few real items, each a link to the job, its result or the bot's Tasks. Nothing here when nothing has run.
import type { MouseEvent } from "react";
import { cn } from "@/lib/utils";
import type { RecentItem } from "./recent";

export function RecentWork({ items, onOpen, className }: { items: readonly RecentItem[]; onOpen?: (href: string) => void; className?: string }) {
  if (!items.length) return null;
  const go = (href: string) => (e: MouseEvent<HTMLAnchorElement>) => {
    if (!onOpen || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    onOpen(href);
  };
  return (
    <section aria-labelledby="recent-work-h" className={cn("flex flex-col gap-1", className)} data-testid="recent-work">
      <h3 id="recent-work-h" className="px-3 text-sm font-medium text-muted-foreground">Recent work</h3>
      <ul className="flex flex-col">
        {items.map((r) => (
          <li key={r.key}>
            <a href={r.href} onClick={go(r.href)} title={`${r.title}. ${r.label}`} className="ds-interactive flex flex-col gap-0.5 rounded-xl px-3 py-2 hover:bg-surface-raised" data-recent={r.key}>
              <span className="line-clamp-2 text-[15px] text-foreground">{r.title}</span>
              <span className="text-sm text-muted-foreground">{r.botName} · {r.stateWord} · <span className="underline underline-offset-2">{r.label}</span></span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}
