// Copy or archive this bot (the last Setup section), and the notice an archived bot shows at the top of its Setup.
// Presentational: the rules (rev, refusals, "after current work") are in setup-controller.ts and on the hub.
import { useState } from "react";
import { fmtDateTime, fmtDay } from "@/lib/format";
import { Button, Disclosure, Notice } from "@/components/ds";
import type { BotHistoryEntry, BotView } from "@/lib/agent-bots";
import { SetupSection, type SectionStatus } from "./controls";
import { SECTION_IDS } from "./setup-model";
import type { ManageState } from "./setup-controller";

const cap = (id: string) => (id ? id.charAt(0).toUpperCase() + id.slice(1) : "someone");
const day = (ms: number) => fmtDay(ms, { year: true });

/** Pure: one line of the history, newest-first reading: "Mehroz changed instructions, memory". Field names only; the hub never sends the values. */
export function historyLine(e: BotHistoryEntry): string {
  const who = e.by && e.by !== "unknown" ? cap(e.by) : "Someone";
  switch (e.action) {
    case "created": return `${who} made it`;
    case "duplicated": return e.note ? `${who} copied it from ${cap(e.note.replace(/^from\s+/, ""))}` : `${who} made it as a copy`;
    case "archived": return e.note ? `${who} archived it (${e.note})` : `${who} archived it`;
    case "unarchived": return `${who} brought it back`;
    case "edited": return e.note ? `${who} changed ${e.note}` : `${who} changed its settings`;
  }
}

/** Pure: the entries newest first. */
export const newestFirst = (history: readonly BotHistoryEntry[] | undefined): BotHistoryEntry[] => [...(history ?? [])].sort((a, b) => b.at - a.at);

const SHOWN = 5;

/** Who changed what, and when: collapsed by default, five lines, "Show all" for the rest. Nothing is shown when the hub recorded nothing. */
export function RecentChanges({ bot }: { bot: Pick<BotView, "history"> }) {
  const [all, setAll] = useState(false);
  const rows = newestFirst(bot.history);
  if (rows.length === 0) return null;
  const shown = all ? rows : rows.slice(0, SHOWN);
  return (
    <section data-testid="recent-changes" aria-label="Recent changes" className="rounded-2xl border border-border">
      <Disclosure summary="Recent changes" meta={`${rows.length}`}>
        <ul className="flex flex-col divide-y divide-border px-3 pb-2">
          {shown.map((e, i) => (
            <li key={`${e.at}-${i}`} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 py-2 text-sm">
              <span className="min-w-0">{historyLine(e)}</span>
              <time dateTime={new Date(e.at).toISOString()} className="shrink-0 text-muted-foreground">{fmtDateTime(e.at)}</time>
            </li>
          ))}
        </ul>
        {rows.length > SHOWN && (
          <div className="px-3 pb-3">
            <Button type="button" variant="ghost" size="sm" aria-expanded={all} onClick={() => setAll((v) => !v)}>
              {all ? "Show fewer" : `Show all ${rows.length}`}
            </Button>
          </div>
        )}
      </Disclosure>
    </section>
  );
}

/** One line of who made the bot and what has happened to it, from what the hub recorded. */
export function provenance(bot: Pick<BotView, "createdBy" | "createdAt" | "duplicatedFrom" | "archived" | "lifecycle">, nameOf: (id: string) => string = cap): string {
  const made = bot.createdBy ? `${bot.duplicatedFrom ? `Copied from ${nameOf(bot.duplicatedFrom)}` : "Made"} by ${cap(bot.createdBy)} on ${day(bot.createdAt)}.` : "";
  const archived = bot.archived ? `Archived by ${cap(bot.archived.by)} on ${day(bot.archived.at)}.` : "";
  return [made, archived].filter(Boolean).join(" ");
}

export function ManageSection({
  bot,
  manage,
  locked,
  status,
  onDuplicate,
  onAskArchive,
  onCancel,
  onArchive,
  onUnarchive,
  onOpen,
  onDismissCopy,
  routines = [],
  releasedNames = null,
  botName,
}: {
  /** A bot's name from its id, for "Copied from …". Absent: the id, tidied. */
  botName?: (id: string) => string;
  bot: BotView;
  /** Names of the routines linked to this bot: archiving releases them, and the confirmation says so. */
  routines?: string[];
  /** The routines this archived bot released, by name; a routine since deleted is "a routine that no longer exists". Null: not known (just count them). */
  releasedNames?: string[] | null;
  manage: ManageState;
  /** A pending "Changed elsewhere" notice blocks every change. */
  locked: boolean;
  status: SectionStatus;
  onDuplicate: () => void;
  onAskArchive: () => void;
  onCancel: () => void;
  onArchive: (o: { afterCurrentWork: boolean }) => void;
  onUnarchive: () => void;
  onOpen: (id: string) => void;
  onDismissCopy: () => void;
}) {
  const busy = manage.busy !== null;
  const off = busy || locked;
  const archived = bot.lifecycle === "archived" || bot.lifecycle === "archiving";
  const copy = manage.duplicated;
  return (
    <SetupSection id={SECTION_IDS.manage} title="Copy or archive" description={`Make a copy of ${bot.name}, or archive it when it is no longer needed. Nothing it has done is ever deleted.`} status={status}>
      {provenance(bot, botName) && (
        <p className="max-w-[62ch] text-sm text-muted-foreground" data-testid="manage-provenance">
          {provenance(bot, botName)}
        </p>
      )}

      <div className="flex flex-col gap-3 border-t border-border pt-5">
        <h3 className="text-base font-semibold">Copy</h3>
        <p className="max-w-[62ch] text-sm text-muted-foreground">
          Makes “{bot.name} copy” with the same purpose, instructions, computer, coding and model settings. Nothing else comes with it: no routines, conversations, tasks or results. If it uses the same computer, that computer runs one task at a time.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" variant="outline" disabled={off || !!copy} onClick={onDuplicate}>
            {manage.busy === "duplicate" ? "Copying…" : "Duplicate"}
          </Button>
          {locked && <span data-reason="" className="text-sm text-muted-foreground">Reload the latest first; see the notice at the top.</span>}
          {copy && !locked && <span data-reason="" className="text-sm text-muted-foreground">Dismiss the notice below to make another copy.</span>}
        </div>
        {copy && (
          <Notice
            tone="success"
            title={`Made “${copy.name}”`}
            action={
              <div className="flex gap-2">
                <Button type="button" variant="accent" size="sm" onClick={() => onOpen(copy.id)}>
                  Open it
                </Button>
                <Button type="button" variant="ghost" size="sm" onClick={onDismissCopy}>
                  Dismiss
                </Button>
              </div>
            }
          >
            It starts with no routines, conversations or tasks. Check its computer and instructions in its Setup.
          </Notice>
        )}
      </div>

      <div className="flex flex-col gap-3 border-t border-border pt-5">
        <h3 className="text-base font-semibold">{archived ? "Archived" : "Archive"}</h3>
        {archived ? (
          <>
            <p className="max-w-[62ch] text-sm text-muted-foreground" data-testid="manage-archived">
              {bot.lifecycle === "archiving" ? `${bot.name} is hidden and takes no new requests. The jobs it had when it was archived are finishing; nothing is stopped.` : `${bot.name} is hidden from the agent list and takes no new requests. Its tasks, results and conversations stay readable.`}
            </p>
            {(bot.releasedRoutines?.length ?? 0) > 0 && (
              <p data-testid="manage-released" className="max-w-[62ch] text-sm text-muted-foreground">
                It released {bot.releasedRoutines!.length === 1 ? "a routine" : `${bot.releasedRoutines!.length} routines`} when it was archived{releasedNames ? ` (${releasedNames.join(", ")})` : ""}. They run as nobody until they are linked to a bot in Setup; unarchiving does not link them again.
              </p>
            )}
            <div className="flex flex-wrap items-center gap-3">
              <Button type="button" variant="accent" disabled={off} onClick={onUnarchive}>
                {manage.busy === "unarchive" ? "Unarchiving…" : "Unarchive"}
              </Button>
            </div>
          </>
        ) : manage.confirming === "archive" ? (
          <div data-testid="archive-confirm" role="group" aria-label={`Archive ${bot.name}`} className="flex flex-col gap-4 rounded-2xl bg-inset p-5">
            {manage.blocked ? (
              <>
                <div>
                  <p className="text-base font-semibold">{bot.name} has work open</p>
                  <ul data-testid="archive-work" className="mt-2 flex flex-col gap-1 text-sm">
                    {manage.blocked.work.map((w) => (
                      <li key={w.jobId}>
                        “{w.title}” <span className="text-muted-foreground">({w.kind === "coding" ? "coding job" : "computer task"}, {w.phase === "waiting" ? "waiting for you" : "running"})</span>
                      </li>
                    ))}
                  </ul>
                </div>
                <p className="max-w-[62ch] text-sm text-muted-foreground">Nothing was archived. Archive after current work: new requests are refused straight away, and these jobs finish on their own. Nothing is stopped.</p>
                <Released routines={routines} />
                <div className="flex flex-wrap gap-3">
                  <Button type="button" variant="accent" disabled={off} onClick={() => onArchive({ afterCurrentWork: true })}>
                    {manage.busy === "archive" ? "Archiving…" : "Archive after current work"}
                  </Button>
                  <Button type="button" variant="ghost" disabled={busy} onClick={onCancel}>
                    Cancel
                  </Button>
                </div>
              </>
            ) : (
              <>
                <div>
                  <p className="text-base font-semibold">Archive {bot.name}?</p>
                  <p className="mt-1 max-w-[62ch] text-sm text-muted-foreground">It disappears from the agent list and takes no new requests: Jarvis will say it is archived. Its tasks, results and conversations stay readable here. You can unarchive it at any time.</p>
                </div>
                <Released routines={routines} />
                <div className="flex flex-wrap gap-3">
                  <Button type="button" variant="accent" disabled={off} onClick={() => onArchive({ afterCurrentWork: false })}>
                    {manage.busy === "archive" ? "Archiving…" : `Archive ${bot.name}`}
                  </Button>
                  <Button type="button" variant="ghost" disabled={busy} onClick={onCancel}>
                    Cancel
                  </Button>
                </div>
              </>
            )}
          </div>
        ) : (
          <>
            <p className="max-w-[62ch] text-sm text-muted-foreground">Hides {bot.name} from the agent list and stops it taking new requests. Its tasks, results and conversations stay readable, and nothing it is running is stopped. You can unarchive it later.</p>
            <div className="flex flex-wrap items-center gap-3">
              <Button type="button" variant="outline" disabled={off} onClick={onAskArchive}>
                Archive…
              </Button>
            </div>
          </>
        )}
        {manage.error && (
          <p role="alert" data-testid="manage-error" className="rounded-xl bg-danger-soft px-4 py-3 text-sm text-foreground">
            {manage.error}
          </p>
        )}
      </div>
    </SetupSection>
  );
}

/** What archiving does to the bot's routines, said before the person confirms. Nothing when it has none. */
function Released({ routines }: { routines: string[] }) {
  if (routines.length === 0) return null;
  return (
    <p data-testid="archive-releases" className="max-w-[62ch] rounded-xl bg-card px-4 py-3 text-sm text-foreground">
      Archiving also releases {routines.length === 1 ? "this routine" : `these ${routines.length} routines`}: {routines.join(", ")}. {routines.length === 1 ? "It stays" : "They stay"} in Automations and can be linked to another bot; unarchiving does not link {routines.length === 1 ? "it" : "them"} again.
    </p>
  );
}

/** Shown above everything on an archived bot's Setup: the settings are read-only until it is unarchived. */
export function ArchivedNotice({ bot, busy, onUnarchive }: { bot: BotView; busy: boolean; onUnarchive: () => void }) {
  const finishing = bot.lifecycle === "archiving";
  return (
    <Notice
      tone="info"
      title={finishing ? `${bot.name} is archived and finishing its last jobs` : `${bot.name} is archived`}
      action={
        <Button type="button" variant="accent" size="sm" disabled={busy} onClick={onUnarchive}>
          Unarchive
        </Button>
      }
    >
      <span data-testid="archived-notice">It takes no new requests, so its settings are read-only. Its tasks, results and conversations are still here.</span>
    </Notice>
  );
}
