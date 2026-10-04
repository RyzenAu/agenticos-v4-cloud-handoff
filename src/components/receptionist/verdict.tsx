import { Surface } from "@/components/ds";
import type { Incident, Verdict } from "@/lib/receptionist";
import { Incidents } from "./incidents";
import { cn } from "@/lib/utils";
import { fmtDay } from "@/lib/format";

const border = { ok: "border-l-success", warn: "border-l-warn", bad: "border-l-danger", neutral: "border-l-border-strong" };

export function Decision({ verdict, generatedAt, incidents = [] }: { verdict: Verdict; generatedAt: string; incidents?: Incident[] }) {
  return <Surface as="section" aria-labelledby="receptionist-decision" className={cn("border-l-2", border[verdict.tone])}>
    <p className="ds-label text-xs text-muted-foreground">{fmtDay(new Date(generatedAt), { weekday: "long" })}</p>
    <h2 id="receptionist-decision" className={cn("mt-1 text-xl font-semibold sm:text-2xl", verdict.tone === "bad" ? "text-danger" : "text-foreground")}>{verdict.decision}</h2>
    <p className="mt-2 text-sm text-muted-foreground">{verdict.facts.join(" · ")}</p>
    <p className="mt-3 text-sm text-foreground"><span className="font-medium">Next:</span> {verdict.next}</p>
    <Incidents incidents={incidents} />
  </Surface>;
}
