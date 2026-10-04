// The workspace of one coding agent job: a one-line summary first ("Coding agent — building on Claude Max 2"), what waits for
// you, the primary actions, then the pieces a workspace needs that the readable summary doesn't carry (conversation and
// latest result, working files and output, routines). The readable job summary (job-summary.tsx) is reused underneath, unchanged.
// Independently written; Open Dot (composio-community/open-dot @ f838e17) was studied for how a workspace is organised.
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ExternalLink, MonitorSmartphone } from "lucide-react";
import type { ReactNode } from "react";
import { Badge, Button, DeviceStatusSlot, Disclosure, Surface, fmtRelative } from "@/components/ds";
import { Fact, WaitingNotice } from "@/components/agents/workspace-parts";
import { jobLabel, jobStateLabel, type CodingEvent, type CodingJob, type JobView } from "@/lib/coding-client";
import { readComputers } from "@/lib/computers-client";
import { useDevices } from "@/lib/use-devices";
import { locationSlot } from "./job-summary";
import { needsYouLine } from "./coding-list";
import { needsYou } from "./needs-you";
import { accountWords } from "@/lib/coding-glance";
export { accountWords };
import type { Tone } from "@/components/ds";

const ACTING: Record<string, string> = {
  preparing: "preparing",
  building: "building",
  integrating: "integrating the branches",
  testing: "testing",
  reviewing: "reviewing",
  gating: "at the final check",
  applying: "applying the approved step",
};
const ENDED: Record<string, string> = { completed: "finished", failed: "failed", cancelled: "stopped", interrupted: "interrupted", blocked_allowance: "paused at an account limit", needs_owner: "paused on one step", awaiting_approval: "finished, merge waiting for approval", draft: "plan needs fixes", awaiting_confirmation: "plan ready, waiting to start" };

/** Pure: the one-line summary of a coding job from the job record alone (the list has no readable view). */
export function codingSummary(job: CodingJob): { headline: string; tone: Tone; waiting: string | null; acting: boolean } {
  const live = job.runs.find((r) => ["running", "starting", "needs_input"].includes(r.state)) ?? null;
  const run = live ?? [...job.runs].reverse()[0] ?? job.runs[0] ?? null;
  const on = run ? accountWords(run.binding.accountSlot) : null;
  const acting = ACTING[job.state];
  const verb = acting ?? (job.supersededBy ? "superseded by newer work" : ENDED[job.state]) ?? jobStateLabel(job.state).label.toLowerCase();
  const headline = acting && on ? `Coding agent — ${verb} on ${on}` : `Coding agent — ${verb}${on && !acting ? ` (${on})` : ""}`;
  return { headline, acting: !!acting, tone: jobLabel(job).tone, waiting: needsYou(job) ? `Waiting for you — ${needsYouLine(job).replace(/^./, (c) => c.toLowerCase())}` : null };
}

/** Pure: the agent's latest words on this job: its own final summary, else the last line Jarvis spoke about it. */
export function latestAgentLine(events: readonly CodingEvent[]): { who: string; text: string } | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    const p = e.payload as { final?: boolean; text?: string; line?: string };
    if (e.type === "text" && p.final && p.text) return { who: e.roleId ?? "Agent", text: String(p.text).slice(0, 600) };
  }
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    const p = e.payload as { line?: string };
    if (e.type === "spoken" && p.line) return { who: "Jarvis", text: String(p.line).slice(0, 400) };
  }
  return null;
}

export function CodingWorkspace({ view, events, actions, onOpenTab, children }: { view: JobView; events: readonly CodingEvent[]; actions: ReactNode; onOpenTab: (tab: "changes" | "plan") => void; children?: ReactNode }) {
  const job = view.job;
  const r = view.readable;
  const s = codingSummary(job);
  const slot = r ? locationSlot(r, view.receipts) : null;
  const computers = useQuery({ queryKey: ["computers"], queryFn: readComputers, staleTime: 5_000, retry: false });
  const device = view.receipts.find((x) => x.executionLocation === "cloud")?.executionDevice ?? null;
  const shared = computers.data?.status === "ok" ? computers.data.computers.find((c) => c.id === device) ?? null : null;
  const said = latestAgentLine(events);
  const files = r?.diff?.files ?? [];
  const patch = r?.diff?.patchArtefact ?? null;
  const done = ["completed", "failed", "cancelled", "awaiting_approval"].includes(job.state);
  return (
    <Surface className="mb-6 flex flex-col gap-4" data-workspace="coding" data-job-state={job.state} aria-label="Agent workspace">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h2 className="min-w-0 flex-1 basis-full text-lg font-medium leading-snug sm:basis-0" data-testid="workspace-headline">{s.headline}</h2>
      </div>
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Agent actions">
        {actions}
        <Button asChild variant="outline">
          <Link to="/computers" hash={shared ? `computer-${shared.name}` : undefined}>
            <MonitorSmartphone className="h-4 w-4" aria-hidden="true" /> Open computer
          </Link>
        </Button>
        <Button variant="outline" onClick={() => onOpenTab("changes")}>{done ? "Open result" : "See changes so far"}</Button>
        <Button asChild variant="outline">
          <Link to="/agents/workspace/$botId" params={{ botId: "builder" }} search={{ tab: "tasks" }}>Open in Builder workspace</Link>
        </Button>
      </div>
      <dl className="divide-y divide-border" aria-label="Workspace facts">
        <Fact label="Computer">
          {slot ? <DeviceStatusSlot device={slot} className="text-[15px]" /> : "Not reported"}
          {shared ? <span className="text-muted-foreground"> · shared computer {shared.label || shared.name}, {shared.state}</span> : null}
        </Fact>
        {/* R11: the account and model per role are said once, in "Who is doing it" above (with a mismatch in amber). */}
        <Fact label="Latest message">
          <span className="block text-muted-foreground" data-testid="latest-line">
            {said ? `${said.who === "Jarvis" ? "Jarvis" : said.who.replace(/-\d+$/, "")}: ${said.text}` : "No message from the agent yet."}
          </span>
        </Fact>
        <Fact label="The work">
          {files.length ? (
            <>
              {files.slice(0, 5).map((f) => f.path).join(", ")}{files.length > 5 ? ` and ${files.length - 5} more` : ""}{" "}
              <button type="button" className="underline underline-offset-2 hover:text-foreground" onClick={() => onOpenTab("changes")}>See the changes</button>
            </>
          ) : (
            "No files changed yet"
          )}
          {patch ? (
            <> · <a className="inline-flex items-center gap-1 underline underline-offset-2 hover:text-foreground" href={`/__operator/coding/artefacts/${job.id}/${patch}`} target="_blank" rel="noreferrer">
              The patch <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
            </a></>
          ) : null}
          {r?.result.merged ? " · merged" : r && files.length ? ` · not merged; it is on ${r.result.jobBranch}` : ""}
        </Fact>
      </dl>
      {children && (
        <div className="-mx-3">
          <Disclosure summary={<span className="font-medium">Where this stands</span>} meta="Plan, tests, review" defaultOpen>
            {children}
          </Disclosure>
        </div>
      )}
    </Surface>
  );
}

/** Before dispatch: where this job will run, named. Coding agents run on the machine the hub runs on; a shared computer isn't a target yet. */
export function RunsOnLine() {
  const devices = useDevices();
  const computers = useQuery({ queryKey: ["computers"], queryFn: readComputers, staleTime: 5_000, retry: false });
  const hub = (devices.data ?? []).find((d) => d.kind === "hub");
  const where = hub ? (hub.label || hub.displayLabel || hub.id) : devices.isLoading ? "reading…" : "the machine this hub runs on";
  const shared = computers.data?.status === "ok" ? computers.data.computers.length : 0;
  return (
    <p className="text-[15px]" data-testid="runs-on">
      <span className="text-muted-foreground">It will run on </span>
      <strong className="font-medium">{where}</strong>
      <span className="text-muted-foreground">{hub ? ` (${hub.online === false ? "offline" : hub.online ? "online" : "status not reported"})` : ""}{shared ? ` · ${shared} shared computer${shared === 1 ? "" : "s"} can't take coding jobs yet` : ""}</span>
    </p>
  );
}
