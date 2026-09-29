// "The harness" on the Coding page (W-B, 29 Sep 2026): who can do the work (the Claude subscription and
// the Codex accounts, with Codex's sandbox-isolation state), which repos it may touch, and the rules in
// plain words. Read-only: every value comes from /__operator/coding/accounts and /repos; a value that
// wasn't read says so ("not read", "—"), never a made-up zero.
import { FolderGit2, ShieldCheck, ShieldAlert, Users } from "lucide-react";
import type { ReactNode } from "react";
import { BrandMark, Disclosure, fmtRelative } from "@/components/ds";
import { cn } from "@/lib/utils";
import { HARNESS_POLICY } from "@/lib/coding-pipeline";
import type { CodingAccount, CodingAccounts, CodingRepo } from "@/lib/coding-client";

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

const pct = (v: number | null | undefined) => (typeof v === "number" ? `${Math.round(v)}%` : "not read");

function AccountRow({ a }: { a: CodingAccount }) {
  const claude = a.accountSlot === "claude:max";
  const name = claude ? "Claude Code · Max subscription" : `Codex · ${a.accountSlot.replace("codex:", "")}${"plan" in a ? ` (${a.plan === "chatgpt-pro" ? "Pro" : "Plus"})` : ""}`;
  const windows = claude && "allowance" in a ? a.allowance?.windows ?? null : null;
  const reading = !claude && "reading" in a ? a.reading : null;
  return (
    <li className="flex min-w-0 items-start gap-3 py-3" data-account={a.accountSlot}>
      <BrandMark agent={claude ? "claude-code" : "codex"} size={20} />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-foreground">{name}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {a.installed ? `CLI ${a.cliVersion ?? "version unknown"}` : "CLI not found on this PC"}
          {claude
            ? windows && windows.length
              ? ` · ${windows.map((w) => `${w.label} ${pct(w.usedPercent)}`).join(" · ")}`
              : " · allowance not read yet"
            : ` · window ${pct(reading?.peakPercent)}${"creditsAllowed" in a && a.creditsAllowed ? " · may use its paid credits" : ""}`}
        </p>
      </div>
      <Pill tone={a.installed ? "success" : "warn"}>{a.installed ? "Ready" : "Not installed"}</Pill>
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
          <ul className="-my-3 divide-y divide-border" aria-label="Accounts the harness can use">
            {data.accounts.map((a) => <AccountRow key={a.accountSlot} a={a} />)}
          </ul>
          <div className="mt-4 rounded-xl bg-inset p-4" data-isolation={iso?.state ?? "unknown"}>
            <p className="flex items-center gap-2 text-sm font-medium text-foreground">
              {iso?.state === "protected" ? <ShieldCheck className="size-4 text-success" aria-hidden="true" /> : <ShieldAlert className="size-4 text-warn" aria-hidden="true" />}
              {iso ? iso.label : "Codex isolation: not checked"}
            </p>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              {iso ? iso.detail : "This server didn't report it. The harness still checks it before any Codex role."}
              {iso?.approvedAt ? ` Applied ${fmtRelative(iso.approvedAt)} on ${iso.protectedPaths ?? "—"} paths.` : ""}
            </p>
          </div>
          <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
            Each role stays on the account it started on. A new Codex job goes to the least-used connected account; nothing rotates mid-run.
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
