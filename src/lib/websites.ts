// Client side of /__websites (scripts/websites/plugin.ts): the Sales -> Website page's data.
export type ThumbState = { key: string; at: string | null; stale: boolean; error: string | null; busy: boolean };

export type ClientBrief = {
  status: string | null;
  updated: string | null;
  previewDue: string | null;
  launchTarget: string | null;
  checklist: { done: number; total: number; next: string | null };
};

export type OurSite = {
  id: string;
  kind: "client" | "flagship";
  name: string;
  vertical: "dental" | "legal" | "real-estate";
  url: string;
  alsoAt: string[];
  project: string;
  linkedProject: string | null;
  deployedAt: string | null;
  repo: { path: string; exists: boolean; commit: { at: string; subject: string } | null };
  brief: ClientBrief | null;
  thumb: ThumbState | null;
};

export type PreviewExtras = {
  leadId: number;
  lead: { website: string; name: string; status: string; area: string } | null;
  previewThumb: ThumbState | null;
  realThumb: ThumbState | null;
  deployedProjectAt: string | null;
};

export type LocalTemplate = { vertical: string; flagship: string | null; builtAt: string | null; kind: string | null; localUrl: string; thumb: ThumbState | null };
export type LocalDraft = {
  folder: string;
  name: string;
  leadId: number | null;
  vertical: string | null;
  direction: string | null;
  builtAt: string | null;
  qaPass: boolean | null;
  localUrl: string;
  thumb: ThumbState | null;
};

export type WebsitesOverview = {
  sites: OurSite[];
  previews: PreviewExtras[];
  templates: LocalTemplate[];
  drafts: LocalDraft[];
  previewServer: { port: number; listening: boolean; error: string | null } | null;
  vercel: { at: string | null; error: string | null; refreshing: boolean };
  thumbs: { capturing: string | null; queued: string[] };
};

export async function websitesOverview(): Promise<WebsitesOverview> {
  const res = await fetch("/__websites/overview");
  if (!res.headers.get("content-type")?.includes("application/json")) throw new Error("Start Agentic OS with bun run dev to see your websites.");
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

/** Queue missing or stale screenshots (all of them, or just `keys`). Returns what was queued. */
export async function queueScreenshots(body: { keys?: string[]; force?: boolean } = {}): Promise<string[]> {
  const token = (await (await fetch("/__token")).json()).token;
  const res = await fetch("/__websites/thumbs", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Claude-OS-Token": token },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data.queued ?? [];
}

/** The screenshots a plain "take missing" request would queue: missing or out of date, not already
 *  queued, and not a capture that failed with nothing to show (scripts/websites/thumbs.ts
 *  enqueueThumbs without force). Viewing the page never queues them (audit F3-28). */
export function screenshotsToTake(o: Pick<WebsitesOverview, "sites" | "previews" | "templates" | "drafts">): ThumbState[] {
  const all = [
    ...o.sites.map((s) => s.thumb),
    ...o.previews.flatMap((p) => [p.previewThumb, p.realThumb]),
    ...o.templates.map((t) => t.thumb),
    ...o.drafts.map((d) => d.thumb),
  ];
  return all.filter((t): t is ThumbState => !!t && t.stale && !t.busy && !(t.error && (t.at === null || t.key.startsWith("real-"))));
}

/** A failed screenshot request, in plain English (never the bare "Failed to fetch"). */
export function screenshotErrorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (/failed to fetch|networkerror|load failed|network request failed/i.test(message))
    return "Couldn't reach Agentic OS to take screenshots. Check it's running, then try again.";
  if (error instanceof SyntaxError || /unexpected token|json/i.test(message))
    return "Agentic OS sent back something unexpected, so no screenshots were queued. Refresh the page and try again.";
  const status = /^Request failed \((\d+)\)$/.exec(message)?.[1];
  if (status) return `Screenshots couldn't be queued: Agentic OS answered with error ${status}. Try again in a minute.`;
  return message ? `Screenshots couldn't be queued: ${message}` : "Screenshots couldn't be queued. Try again in a minute.";
}

export const thumbSrc = (t: ThumbState | null) => (t?.at ? `/__websites/thumb?key=${encodeURIComponent(t.key)}&t=${encodeURIComponent(t.at)}` : null);

export function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** Whole days from today (local calendar) to a YYYY-MM-DD date; negative once past. */
export function daysUntil(day: string, now = new Date()): number {
  const [y, m, d] = day.split("-").map(Number);
  const target = new Date(y, m - 1, d).getTime();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return Math.round((target - today) / 86_400_000);
}

export function inDays(n: number): string {
  if (n === 0) return "today";
  if (n === 1) return "tomorrow";
  if (n === -1) return "yesterday";
  return n > 0 ? `in ${n} days` : `${-n} days ago`;
}
