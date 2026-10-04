import { honestWebsiteText } from "@/lib/call-queue";
// The lead drawer's "Evidenced issues" block: the top three problems scripts/leads/issues.ts found
// on the business's own site, each linked to the page it was seen on, plus the opener hook built
// from them. Read-only — nothing here fetches, sends or dials.
import { ExternalLink } from "lucide-react";
import { Badge, DetailSection } from "@/components/ds";
import type { LeadIssues } from "@/lib/leads";
import { fmtDay } from "@/lib/format";

const SEVERITY: Record<1 | 2 | 3, { label: string; tone: "danger" | "warn" | "neutral" }> = {
  3: { label: "Severe", tone: "danger" },
  2: { label: "Moderate", tone: "warn" },
  1: { label: "Minor", tone: "neutral" },
};
const OFFER: Record<string, string> = { redesign: "Website fix", receptionist: "AI receptionist", both: "Website + receptionist" };

export function LeadIssuesBlock({ issues }: { issues: LeadIssues | null }) {
  if (!issues) return null;
  const checked = fmtDay(new Date(issues.checkedAt), { year: true });
  return (
    <DetailSection title="Evidenced issues" actions={<span className="text-sm text-muted-foreground">Checked {checked}</span>}>
      {issues.top.length === 0 ? (
        <p className="text-sm text-muted-foreground">{honestWebsiteText(issues.statusNote) || "Nothing evidenced to fix on their site."}</p>
      ) : (
        <ol className="flex flex-col gap-2.5">
          {issues.top.map((i) => (
            <li key={i.code} className="flex flex-col gap-1 text-sm">
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge tone={SEVERITY[i.severity].tone}>{SEVERITY[i.severity].label}</Badge>
                <Badge tone="neutral">{OFFER[i.offer] ?? i.offer}</Badge>
              </div>
              <p className="text-foreground">{honestWebsiteText(i.finding)}</p>
              <p className="break-words text-xs text-muted-foreground">
                {i.url ? (
                  <a href={i.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 underline-offset-2 hover:text-foreground hover:underline">
                    <ExternalLink className="size-3" aria-hidden="true" />
                    {i.source === "site" ? "Seen on their site" : "Listing"}
                  </a>
                ) : "No link"}
                {" — "}{i.seen}
              </p>
            </li>
          ))}
        </ol>
      )}
      {issues.hook && <p className="mt-2 rounded bg-inset p-2 text-sm italic">Opener hook: “I noticed {issues.hook}.”</p>}
    </DetailSection>
  );
}
