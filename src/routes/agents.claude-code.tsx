import { docTitle } from "@/components/shell/destinations";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Cpu, Gauge, ListChecks, MessageSquare, SquareTerminal } from "lucide-react";
import { HermesMissionControl } from "@/components/hermes-mission-control";
import { BrandMark, Button, Disclosure, PageFoot, PageHeader, Widget, WidgetEmpty, WidgetGrid, WidgetList, fmtRelative } from "@/components/ds";
import { JobCard } from "@/components/coding/coding-list";
import { codingClient } from "@/lib/coding-client";
import { claudeVerdict, usesClaude } from "@/lib/claude-code-status";

// ────────────────────────────────────────────────────────────────────────────
// Claude Code (W-B, 29 Sep 2026). Owner: "the Claude Code section doesn't open". The route rendered,
// but it opened onto a copy of Hermes' Mission Control prompt and nothing about Claude Code itself,
// and that panel's one read had no timeout, so on a busy server it could sit on skeletons with no way
// out. The page now answers what the owner came for: is Claude Code ready on this PC, what is it
// working on, and where do I hand it work. Mission Control is still here, folded, unchanged.
// Every value is read (the coding harness's /accounts and /jobs); unread values say so.
// ────────────────────────────────────────────────────────────────────────────

export const Route = createFileRoute("/agents/claude-code")({
  head: () => ({
    meta: [
      { title: docTitle("/agents/claude-code") },
      { name: "description", content: "Claude Code on this PC: whether it's ready, what it's working on, and where to hand it work." },
    ],
  }),
  component: ClaudeCodePage,
});

function ClaudeCodePage() {
  const accounts = useQuery({ queryKey: ["coding", "accounts"], queryFn: () => codingClient.accounts(), staleTime: 60_000, retry: 1 });
  const jobs = useQuery({ queryKey: ["coding", "jobs"], queryFn: () => codingClient.list(), refetchInterval: 15_000, retry: 1 });
  const v = claudeVerdict(accounts.data, accounts.isError);
  const claudeJobs = (jobs.data?.jobs ?? []).filter(usesClaude);
  const windows = v.claude?.allowance?.windows ?? null;
  // L2 (29 Sep): one short state word for the widget; the verdict's sentence is its line.
  const state = v.tone === "ok" ? "Ready" : v.tone === "warn" ? (v.claude?.installed ? "At its limit" : "Not installed") : accounts.isError ? "Unknown" : "Checking…";
  const cli = v.claude ? (v.claude.installed ? (v.claude.cliVersion ?? "Version unknown") : "Not found") : accounts.isError ? "Unknown" : null;
  const allowance = windows && windows.length ? windows.map((w) => `${w.label} ${typeof w.usedPercent === "number" ? `${Math.round(w.usedPercent)}%` : "not read"}`).join(" · ") : null;

  // L2 (29 Sep, owner: "fill the screen like the Inbox"): one headline, then a widget grid that leads
  // with what the page DOES: hand Claude Code a job, and see what it's working on. W-B's verdict,
  // jobs and folded Mission Control are all still here; the source line sits in the page foot.
  return (
    <div className="min-w-0 [overflow-wrap:anywhere]">
      <PageHeader
        title={
          <span className="inline-flex items-center gap-2.5">
            <BrandMark agent="claude-code" size={24} />
            Claude Code
          </span>
        }
        description="Hand Claude Code a job, or see what it's working on."
      />

      <WidgetGrid aria-label="Claude Code">
        <Widget
          icon={SquareTerminal}
          span={2}
          id="claude-code-verdict"
          data-claude-state={v.tone}
          title="On this PC"
          value={state}
          tone={v.tone === "warn" ? "warn" : v.tone === "ok" ? "success" : "muted"}
          line={v.why}
          action={
            <>
              <Button variant="accent" className="h-10 rounded-full px-5" asChild>
                <Link to="/coding"><SquareTerminal aria-hidden="true" /> Give it a coding job</Link>
              </Button>
              <Button variant="outline" className="h-10 rounded-full px-5" asChild>
                <Link to="/chat"><MessageSquare aria-hidden="true" /> Open Chat</Link>
              </Button>
            </>
          }
        />
        <Widget icon={Cpu} title="CLI" value={cli} line={cli === null ? "Not checked yet" : v.claude?.installed ? "Found on this PC" : "Install it and sign in with /login"} />
        <Widget icon={Gauge} title="Plan allowance" value={allowance ? <span className="text-xl">{allowance}</span> : null} line={allowance ? "Your Max plan's cached usage windows" : "Not read yet"} />

        <WidgetList
          icon={ListChecks}
          span={4}
          title="What it's working on"
          badge={jobs.data ? claudeJobs.length : undefined}
          empty={
            jobs.isLoading ? (
              <span role="status">Reading coding jobs…</span>
            ) : jobs.isError ? (
              "Couldn't read the coding jobs. The Coding page retries on its own."
            ) : (
              <WidgetEmpty title="Nothing yet" body="Describe a change on the Coding page, or tell Jarvis “fix X in <repo>, Opus builds, another Opus reviews”." />
            )
          }
          action={
            <Button variant="ghost" className="h-10 rounded-full px-4" asChild>
              <Link to="/coding">All coding jobs <ArrowRight aria-hidden="true" /></Link>
            </Button>
          }
        >
          {claudeJobs.slice(0, 3).map((j) => <li key={j.id} className="py-2 first:pt-0 last:pb-0"><JobCard job={j} /></li>)}
          {claudeJobs.length > 3 && <li className="py-2 text-sm text-muted-foreground">{claudeJobs.length - 3} more on the Coding page · latest updated {fmtRelative(claudeJobs[0].updatedAt)}</li>}
        </WidgetList>

        {/* Mission Control: the same long-term-mission panel as Hermes, folded so it no longer IS the page. */}
        <section aria-label="Long-term missions" className="col-span-full rounded-2xl border border-border bg-card p-2 shadow-sm sm:p-3">
          <Disclosure
            summary={<span className="text-base font-medium">Long-term missions</span>}
            meta="Same missions as Hermes"
            panelClassName="pt-4"
          >
            <HermesMissionControl agent="claude-code" />
          </Disclosure>
        </section>
      </WidgetGrid>

      <PageFoot>
        From the coding harness (/__operator/coding): the CLI it found and your Max plan's cached usage windows. Coding jobs never use an API key.
        {jobs.data ? ` ${claudeJobs.length} coding job${claudeJobs.length === 1 ? "" : "s"} with Claude.` : ""}
      </PageFoot>
    </div>
  );
}
