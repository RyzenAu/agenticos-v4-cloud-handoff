// Recent work for the bot list: the few newest things any bot did, each with the one link that leads to it. Derived from what the services
// already report (a coding job, a shared computer's current or last job), never stored. Pure so it can be tested without a page.
// Pattern from Rakazo's bot list (recent activity beside each bot's live state); written for the M&U design system, no code copied.
import { codingTask } from "@/components/agents/tasks/tasks";
import type { CodingJob } from "@/lib/coding-client";
import type { ComputerView } from "@/lib/computers-client";
import { computerForBot, isArchivedBot, workspaceHref, type Bot } from "./bots";

export type RecentItem = {
  key: string;
  botId: string;
  botName: string;
  title: string;
  /** "Finished", "Needs you" ... straight from the task's own end state; for a computer job only what the computer reports (working now, or the last job). */
  stateWord: string;
  href: string;
  /** What the link opens: the result itself only when the job truly has one. */
  label: "Open result" | "Open job" | "Open tasks";
};

const clip = (s: string, n = 64) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
export const hrefOf = (botId: string, tab: "tasks") => {
  const h = workspaceHref(botId, tab);
  return `/agents/workspace/${encodeURIComponent(h.params?.botId ?? botId)}?tab=${h.search.tab}`;
};

/** Pure: up to `limit` recent items, newest coding job first, then computer jobs (they carry no timestamp, so they follow). */
export function recentWork(input: { bots: readonly Bot[]; computers: readonly ComputerView[]; coding: readonly CodingJob[] | null | undefined }, limit = 3): RecentItem[] {
  const active = input.bots.filter((b) => !isArchivedBot(b));
  const builder = active.find((b) => b.coding.enabled);
  const out: RecentItem[] = [];
  if (builder) {
    const jobs = [...(input.coding ?? [])].filter((j) => !j.supersededBy).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)).slice(0, limit);
    for (const j of jobs) {
      const t = codingTask(j, null);
      out.push({ key: `coding:${j.id}`, botId: builder.id, botName: builder.name, title: clip(t.title), stateWord: t.stateWord, href: t.result ? t.result.href : `/coding/${j.id}`, label: t.result ? "Open result" : "Open job" });
    }
  }
  const seen = new Set<string>();
  for (const b of active) {
    const c = computerForBot(b, input.computers);
    const ref = c?.assigned ?? c?.lastJob ?? null;
    if (!c || !ref || seen.has(ref.jobId)) continue;
    seen.add(ref.jobId);
    out.push({ key: `computer:${ref.jobId}`, botId: b.id, botName: b.name, title: clip(ref.title || ref.jobId), stateWord: c.assigned ? "Working now" : "Last job", href: hrefOf(b.id, "tasks"), label: "Open tasks" });
  }
  return out.slice(0, limit);
}
