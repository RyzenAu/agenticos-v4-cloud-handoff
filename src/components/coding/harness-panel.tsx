// "The coding system" on the Coding page (W-B, 29 Sep 2026): who can do the work (the Claude subscription and
// the Codex accounts, with Codex's sandbox-isolation state), which repos it may touch, and the rules in
// plain words. Read-only: every value comes from /__operator/coding/accounts and /repos; a value that
// wasn't read says so ("not read", "—"), never a made-up zero.
import { FolderGit2, ShieldCheck, ShieldAlert, Users } from "lucide-react";
import type { ReactNode } from "react";
import { BrandMark, Disclosure, fmtRelative } from "@/components/ds";
import { cn } from "@/lib/utils";
import { HARNESS_POLICY } from "@/lib/coding-pipeline";
import { claudeAccountLabel, isClaudeAccount, type ClaudeCodingAccount, type CodingAccount, type CodingAccounts, type CodingRepo } from "@/lib/coding-client";
import { AllowanceMeter, knownPercent } from "./allowance-meter";

function Card({ icon, title, children, className }: { icon: ReactNode; title: string; children: ReactNode; className?: string }) {
  return (
    <section className={cn("h-full min-w-0 rounded-2xl border border-border bg-card p-5 shadow-sm sm:p-6", className)} aria-label={title}>
      <h3 className="flex items-center gap-2.5 text-base font-semibold text-foreground">
        <span aria-hidden="true" className="grid size-8 place-items-center rounded-full bg-inset text-muted-foreground">{icon}</span>
        {title}
      </h3>
      <div className="mt-4">{children}</div>
    </section>
  );
}

function Pill({ tone = "neutral", children }: { tone?: "neutral" | "success" | "warn"; children: ReactNode }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs leading-5", tone === "success" ? "bg-success-soft text-success" : tone === "warn" ? "bg-warn-soft text-warn" : "bg-inset text-muted-foreground")}>
      {children}
    </span>
  );
}

const pct = (v: number | null | undefined) => (knownPercent(v) ? `${Math.round(v)}%` : "not read");

const PLAN: Record<string, string> = { "claude-max-20x": "Max 20x", "claude-max-5x": "Max 5x", "claude-pro": "Pro" };
const MODEL: Record<string, string> = { "claude-opus-5-5": "Opus 5.5", "claude-sonnet-5": "Sonnet 5", "claude-fable-5-1": "Fable 5.1", "claude-haiku-4-5": "Haiku 4.5" };
const modelName = (id: string) => MODEL[id] ?? id;

/** A Claude login: connected only on a real sign-in check of its own profile; unread usage says "unknown". */
function ClaudeRow({ a }: { a: ClaudeCodingAccount }) {
  const c = a.connection;
  const state = c?.state ?? "unknown";
  const windows = a.allowance?.windows ?? [];
  const verified = a.modelsVerified ?? [];
  return (
    <li className="flex min-w-0 items-start gap-3 py-3" data-account={a.accountSlot} data-connection={state}>
      <BrandMark agent="claude-code" size={20} />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-foreground">
          {claudeAccountLabel(a)} <span className="font-normal text-muted-foreground">· Claude Code{a.plan ? ` · ${PLAN[a.plan] ?? a.plan}` : ""}</span>
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {state === "connected"
            ? `Signed in${c?.subscription ? ` (reports plan "${c.subscription}")` : ""}${c?.checkedAt ? `, checked ${fmtRelative(c.checkedAt)}` : ""}`
            : state === "signed-out"
              ? `Not connected: ${c?.reason ?? "not signed in"}`
              : `Connection unknown${c?.reason ? `: ${c.reason}` : ""}`}
          {a.profile ? ` · ${a.profile}` : ""}
          {a.installed ? ` · CLI ${a.cliVersion ?? "version unknown"}` : " · CLI not found on this PC"}
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Models: {a.models.map(modelName).join(", ")}
          {verified.length ? ` · ran here: ${verified.map(modelName).join(", ")}` : " · none run on this account yet"}
        </p>
        {windows.length
          ? windows.map((w, i) => <AllowanceMeter key={`${w.label}:${i}`} label={w.label} percent={w.usedPercent} resetsAt={w.resetsAt} />)
          : <p className="mt-1 text-xs text-muted-foreground">Usage and reset: unknown (not read from this account yet)</p>}
      </div>
      <Pill tone={state === "connected" ? "success" : state === "signed-out" ? "warn" : "neutral"}>{state === "connected" ? "Connected" : state === "signed-out" ? "Not connected" : "Unknown"}</Pill>
    </li>
  );
}

function AccountRow({ a }: { a: CodingAccount }) {
  if (isClaudeAccount(a)) return <ClaudeRow a={a} />;
  const name = `Codex · ${a.accountSlot.replace("codex:", "")} (${a.plan === "chatgpt-pro" ? "Pro" : "Plus"})`;
  const reading = a.reading;
  return (
    <li className="flex min-w-0 items-start gap-3 py-3" data-account={a.accountSlot}>
      <BrandMark agent="codex" size={20} />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-foreground">{name}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {a.installed ? `CLI ${a.cliVersion ?? "version unknown"}` : "CLI not found on this PC"}
          {` · window ${pct(reading?.peakPercent)}${a.creditsAllowed ? " · may use its paid credits" : ""}`}
        </p>
        {reading && <AllowanceMeter label="Busiest account window" percent={reading.peakPercent} resetsAt={reading.resetsAt} />}
      </div>
      <Pill tone={a.installed ? "neutral" : "warn"}>{a.installed ? "Installed" : "Not installed"}</Pill>
    </li>
  );
}

export function AgentsCard({ data, error }: { data: CodingAccounts | null; error: string | null }) {
  const iso = data?.codexIsolation;
  return (
    <Card icon={<Users className="size-4" />} title="Agents and accounts">
      {error ? (
        <p className="text-sm text-muted-foreground">Couldn't read the accounts: {error}</p>
      ) : !data ? (
        <p className="text-sm text-muted-foreground" role="status">Reading the accounts…</p>
      ) : (
        <>
          <ul className="-my-3 divide-y divide-border" aria-label="Accounts the coding system can use">
            {data.accounts.map((a) => <AccountRow key={a.accountSlot} a={a} />)}
          </ul>
          <div className="mt-4 rounded-xl bg-inset p-4" data-isolation={iso?.state ?? "unknown"}>
            <p className="flex items-center gap-2 text-sm font-medium text-foreground">
              {iso?.state === "protected" ? <ShieldCheck className="size-4 text-success" aria-hidden="true" /> : <ShieldAlert className="size-4 text-warn" aria-hidden="true" />}
              {iso ? iso.label : "Codex isolation: not checked"}
            </p>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              {iso ? iso.detail : "This server didn't report it. The coding system still checks it before any Codex role."}
              {iso?.approvedAt ? ` Applied ${fmtRelative(iso.approvedAt)} on ${iso.protectedPaths ?? "—"} paths.` : ""}
            </p>
            {iso?.technical && (
              <Disclosure summary={<span className="text-xs font-medium">Technical detail</span>}>
                <p className="text-xs leading-relaxed text-muted-foreground">{iso.technical}</p>
              </Disclosure>
            )}
          </div>
          <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
            Each role stays on the account it started on. A new Claude role goes to your first signed-in Claude account below its limit (you can pick another before Start); a new Codex job goes to the least-used connected account. Nothing rotates mid-run.
          </p>
        </>
      )}
    </Card>
  );
}

export function ReposCard({ repos, error }: { repos: CodingRepo[] | null; error: string | null }) {
  return (
    <Card icon={<FolderGit2 className="size-4" />} title="Repos it can work on">
      {error ? (
        <p className="text-sm text-muted-foreground">Couldn't read the repo list: {error}</p>
      ) : !repos ? (
        <p className="text-sm text-muted-foreground" role="status">Reading the repo list…</p>
      ) : repos.length === 0 ? (
        <p className="text-sm leading-relaxed text-muted-foreground">
          No repos are registered yet, so no job can start. Add them to <code className="font-mono text-xs">.operator-data/coding/repos.json</code> (repo, base branch, protected branches and the exact check commands).
        </p>
      ) : (
        <ul className="-my-2 divide-y divide-border" aria-label="Registered repos">
          {repos.map((r) => (
            <li key={r.id} className="min-w-0 py-2.5">
              <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-foreground">
                <span className="font-mono text-sm">{r.id}</span>
                <span className="text-xs font-normal text-muted-foreground">from {r.defaultBaseRef}</span>
              </p>
              <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                {r.description}
                {r.checks?.length ? ` · checks: ${r.checks.map((c) => c.id).join(", ")}` : " · no checks registered"}
              </p>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export function PolicyCard() {
  return (
    <Card icon={<ShieldCheck className="size-4" />} title="The rules">
      <ul className="-mx-3 -my-1" aria-label="Harness rules">
        {HARNESS_POLICY.map((p) => (
          <li key={p.title}>
            <Disclosure summary={<span className="font-medium">{p.title}</span>}>
              <p className="text-sm leading-relaxed text-muted-foreground">{p.body}</p>
            </Disclosure>
          </li>
        ))}
      </ul>
    </Card>
  );
}
