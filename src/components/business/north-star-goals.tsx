// The long-term goals at the top of Goals: what Usman and Mehroz are working towards, read from
// the M&U wiki's shared-goals page. The business goal shows real progress (revenue towards the
// monthly target from the NAB ledger, clients and leads from the wiki, catalogue and CRM). The deen
// and personal goals are shown respectfully, as goals: no progress numbers, only the current step
// he has written for this week, month or quarter when one speaks to that goal.
// L3 (29 Sep 2026): widgets in a grid that fills the width (the business goal spans the row; the
// others sit side by side), no section heading or blurb: the one source line sits under the grid.
import { Link } from "@tanstack/react-router";
import { BookOpen, Heart, Moon, Target, TrendingUp } from "lucide-react";
import { useState, useEffect } from "react";
import { Widget, WidgetGrid } from "@/components/ds";
import { CalmFigure, Pill } from "@/components/calm/calm";
import { WidgetLink } from "@/components/shell/widgets";
import { useBusinessWorkspace, type ProgressGoal } from "@/lib/business-workspace";
import { goalPeriodState } from "@/lib/goal-periods";
import { useBusinessFactQueries, type WikiFacts } from "@/lib/business-facts";
import { RevenueRing, useBriefModel } from "./mu-brief";
import { fmtProse } from "@/lib/format";

type WikiGoal = WikiFacts["goals"][number];

const HORIZON_LABEL: Record<ProgressGoal["horizon"], string> = { week: "This week", month: "This month", quarter: "This quarter" };

/** Which long-term goal a horizon goal speaks to, by its words. Pure; null when none clearly does. */
export function goalTheme(text: string): "quran" | "allah" | "marry" | "business" | null {
  const t = text.toLowerCase();
  if (/quran|qur'an|hifz|itqan|rememori[sz]|revis/.test(t)) return "quran";
  if (/allah|worship|salah|prayer|deen|faith|dhikr|masjid|mosque/.test(t)) return "allah";
  if (/marr|nikah|spouse/.test(t)) return "marry";
  if (/\$|\d+\s*k\b|revenue|client|agency|business|sales|leads?\b|a month/.test(t)) return "business";
  return null;
}

export function themeOfWikiGoal(g: Pick<WikiGoal, "title" | "kind">): "quran" | "allah" | "marry" | "business" | null {
  return goalTheme(g.title) ?? (g.kind === "business" ? "business" : null);
}

const ICON = { quran: BookOpen, allah: Moon, marry: Heart, business: TrendingUp } as const;
/** The short widget title for a goal (the goal itself is the big text inside). */
const THEME_TITLE = { quran: "Quran", allah: "Closer to Allah", marry: "Marriage", business: "Business" } as const;

/** The horizon goals (current period) that mention a theme, newest first. */
export function stepsFor(theme: ReturnType<typeof goalTheme>, goals: ProgressGoal[], now: Date): ProgressGoal[] {
  if (!theme) return [];
  return goals
    .filter((g) => goalPeriodState(g, now) === "current" && g.status !== "done")
    .filter((g) => {
      // A goal can speak to several themes ("5k a month and closer to Allah"): match any clause.
      return g.title.split(/,|\band\b/i).some((part) => goalTheme(part) === theme);
    })
    .sort((a, b) => ["week", "month", "quarter"].indexOf(a.horizon) - ["week", "month", "quarter"].indexOf(b.horizon));
}

/** The business goal first (it carries the numbers), then deen, then personal; wiki order within each. */
export function orderGoals<T extends Pick<WikiGoal, "title" | "kind">>(goals: T[]): T[] {
  const rank = (g: T) => (themeOfWikiGoal(g) === "business" ? 0 : g.kind === "deen" ? 1 : 2);
  return goals.map((g, i) => ({ g, i })).sort((a, b) => rank(a.g) - rank(b.g) || a.i - b.i).map((x) => x.g);
}

export function NorthStarGoals() {
  const facts = useBusinessFactQueries();
  const { model, saveTarget } = useBriefModel();
  const workspace = useBusinessWorkspace();
  const goals = workspace.data?.progress?.goals ?? [];
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => setNow(new Date()), []);
  const wiki = facts.wiki.data;
  const longTerm = (workspace.data?.profile as { longTermDirection?: string } | undefined)?.longTermDirection?.trim() || "";
  const ordered = wiki?.found && wiki.goals.length ? orderGoals(wiki.goals) : [];
  const business = ordered.filter((g) => themeOfWikiGoal(g) === "business");
  const others = ordered.filter((g) => themeOfWikiGoal(g) !== "business");

  return (
    <section className="mb-6" aria-label="What you and Mehroz are working towards" id="north-star">
      {facts.wiki.loading ? (
        <WidgetGrid aria-busy="true">
          <Widget icon={Target} title="Long-term goals" value={null} line="Reading your goals from the M&U wiki…" span={2} />
        </WidgetGrid>
      ) : !wiki || !wiki.found || !wiki.goals.length ? (
        <WidgetGrid>
          <Widget
            icon={Target}
            title="Long-term goals"
            span={4}
            value={<span className="text-2xl">Unknown</span>}
            tone="muted"
            line={
              <>
                {!wiki ? "Your long-term goals couldn't be read" : !wiki.found ? `The M&U wiki wasn't found (vault "${wiki.vault}")` : "No goals on the shared-goals page yet"}. Long-term goals come from the M&U wiki, one bold line per goal.
                {longTerm ? ` Your saved direction: "${longTerm}".` : ""}
              </>
            }
            action={<WidgetLink to="/memory-map">Check the vault on Memory map</WidgetLink>}
          />
        </WidgetGrid>
      ) : (
        <div className="flex flex-col gap-4 lg:gap-6">
          {business.length > 0 && (
            <WidgetGrid>
              {business.map((g) => {
                const Icon = ICON.business;
                const steps = now ? stepsFor("business", goals, now) : [];
                return (
                  <Widget
                    key={g.title}
                    icon={Icon}
                    title={g.title}
                    badge="Shared with Mehroz"
                    span={4}
                    data-goal="business"
                    action={
                      <WidgetLink to="/business" arrow>
                        Open the business brief
                      </WidgetLink>
                    }
                  >
                    {g.detail && <p className="mb-5 text-base text-muted-foreground">{g.detail}</p>}
                    <div className="grid grid-cols-1 items-center gap-6 md:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
                      <RevenueRing model={model} saveTarget={saveTarget} />
                      <div className="grid grid-cols-3 gap-4 rounded-2xl bg-inset p-4">
                        <CalmFigure label="Clients" value={model.clients.length ? model.clients.length : model.crmClients} hint="wiki + catalogue" />
                        <CalmFigure label="Open leads" value={model.pipeline?.open ?? null} hint="CRM" />
                        <CalmFigure label="Proposals" value={model.pipeline?.proposals ?? null} hint="CRM" />
                      </div>
                    </div>
                    {steps.length > 0 && <Steps steps={steps} />}
                  </Widget>
                );
              })}
            </WidgetGrid>
          )}
          {others.length > 0 && (
            <WidgetGrid className={others.length === 3 ? "xl:grid-cols-3" : others.length === 2 ? "xl:grid-cols-2" : undefined}>
              {others.map((g) => {
                const theme = themeOfWikiGoal(g);
                const Icon = theme ? ICON[theme] : Heart;
                const steps = now ? stepsFor(theme, goals, now) : [];
                return (
                  <Widget
                    key={g.title}
                    icon={Icon}
                    title={theme ? THEME_TITLE[theme] : "Goal"}
                    line="Shared with Mehroz · held as a goal, not measured here"
                    data-goal={theme ?? "other"}
                  >
                    <p className="text-xl font-semibold leading-snug tracking-[-0.01em] text-foreground">{g.title}</p>
                    {g.detail && <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{g.detail}</p>}
                    {steps.length > 0 && <Steps steps={steps} />}
                  </Widget>
                );
              })}
            </WidgetGrid>
          )}
          <p className="text-sm text-muted-foreground">
            From the M&U wiki ({wiki.goals[0].source.page.split("/").pop()}, updated {wiki.goals[0].source.updated ? fmtProse(wiki.goals[0].source.updated) : "date not stated"}).
          </p>
        </div>
      )}
    </section>
  );
}

function Steps({ steps }: { steps: ProgressGoal[] }) {
  return (
    <div className="mt-4 border-t border-border pt-4">
      <p className="mb-2 text-sm font-medium text-foreground">Your current {steps.length === 1 ? "step" : "steps"}</p>
      <ul className="space-y-1.5">
        {steps.map((s) => (
          <li key={s.id} className="flex flex-wrap items-baseline gap-2 text-sm leading-relaxed text-muted-foreground">
            <Pill tone="brand">{HORIZON_LABEL[s.horizon]}</Pill>
            <span className="min-w-0 flex-1 text-foreground">{s.title}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}