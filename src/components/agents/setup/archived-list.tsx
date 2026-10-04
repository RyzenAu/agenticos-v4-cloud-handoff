// "Show archived": the archived bots, each with Open (its tasks, results and conversations stay readable) and Unarchive. Archiving itself is in a
// bot's Setup, where its confirmation and the work in the way are shown; this list only brings bots back.
import { fmtDay } from "@/lib/format";
import { useState } from "react";
import { Button, Surface } from "@/components/ds";
import { STALE_MESSAGE, type AgentBotsClient, type BotId } from "@/lib/agent-bots";

export type ArchivedRow = { id: BotId; name: string; purpose: string; rev?: number; lifecycle?: string; archived?: { at: number; by: string } | null };

const cap = (id: string) => (id ? id.charAt(0).toUpperCase() + id.slice(1) : "someone");
const day = (ms: number) => fmtDay(ms, { year: true });

/** The words under a row: who archived it and when, or that its earlier jobs are still finishing. */
export function archivedLine(b: ArchivedRow): string {
  const when = b.archived ? `Archived ${day(b.archived.at)} by ${cap(b.archived.by)}.` : "Archived.";
  return b.lifecycle === "archiving" ? `${when} Its earlier jobs are still finishing.` : when;
}

export type UnarchiveOutcome = { ok: true } | { ok: false; stale: boolean; message: string };

/** Pure over the client: bring one bot back, against the rev the list was showing. A stale rev is the "Changed elsewhere" message, never an overwrite. */
export async function unarchiveBot(client: AgentBotsClient, bot: ArchivedRow): Promise<UnarchiveOutcome> {
  if (typeof bot.rev !== "number") return { ok: false, stale: true, message: STALE_MESSAGE };
  const r = await client.archive(bot.id, bot.rev, { archived: false });
  if (r.kind === "ok") return { ok: true };
  if (r.kind === "stale") return { ok: false, stale: true, message: r.message };
  return { ok: false, stale: false, message: r.message };
}

export function ArchivedBotsPanel({ bots, client, onOpen, onChanged }: { bots: readonly ArchivedRow[]; client: AgentBotsClient; onOpen: (id: BotId) => void; onChanged: () => void }) {
  const [busy, setBusy] = useState<BotId | null>(null);
  const [problem, setProblem] = useState<{ id: BotId; message: string; stale: boolean } | null>(null);
  async function bringBack(b: ArchivedRow) {
    setBusy(b.id);
    setProblem(null);
    const r = await unarchiveBot(client, b);
    setBusy(null);
    if (r.ok) onChanged();
    else setProblem({ id: b.id, message: r.message, stale: r.stale });
  }
  return (
    <Surface as="section" aria-labelledby="archived-bots-title" data-testid="archived-bots" className="flex max-w-[46rem] flex-col gap-3">
      <div>
        <h2 id="archived-bots-title" className="text-lg font-semibold leading-snug tracking-[-0.01em]">Archived bots</h2>
        <p className="mt-1 max-w-[62ch] text-sm text-muted-foreground">They take no new requests. Their tasks, results and conversations stay readable.</p>
      </div>
      {bots.length === 0 ? (
        <p data-testid="archived-empty" className="py-2 text-sm text-muted-foreground">Nothing is archived. A bot you archive from its Setup appears here, and can be brought back.</p>
      ) : (
        <ul className="divide-y divide-border">
          {bots.map((b) => (
            <li key={b.id} className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <p className="text-base font-medium">{b.name}</p>
                <p className="max-w-[62ch] text-sm text-muted-foreground">{archivedLine(b)}</p>
                {problem?.id === b.id && (
                  <p role="alert" className="mt-2 text-sm text-foreground">
                    {problem.message}
                    {problem.stale && (
                      <>
                        {" "}
                        <button type="button" className="font-medium underline underline-offset-4" onClick={onChanged}>
                          Reload
                        </button>
                      </>
                    )}
                  </p>
                )}
              </div>
              <div className="flex shrink-0 gap-2">
                <Button type="button" variant="outline" size="sm" disabled={busy !== null} onClick={() => onOpen(b.id)}>
                  Open
                </Button>
                <Button type="button" variant="accent" size="sm" disabled={busy !== null} onClick={() => void bringBack(b)}>
                  {busy === b.id ? "Unarchiving…" : "Unarchive"}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Surface>
  );
}
