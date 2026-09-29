import { docTitle } from "@/components/shell/destinations";
import { createFileRoute, Link } from "@tanstack/react-router";
// W-E: the System pages share the calm reading scale (src/components/shell/calm.css).
import { CalmPage } from "@/components/shell/calm";
import { skills as sampleSkills, skillCategories } from "@/lib/mock-data";
import { useState } from "react";
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid } from "recharts";
import {
  Search,
  Code2,
  Eye,
  Brain,
  Video,
  Palette,
  Cog,
  BarChart3,
  Clock,
  DollarSign,
  RotateCcw,
  ChevronRight,
  Wand2,
} from "lucide-react";
import { useTimeSaved, runsIn, formatHours, type Period } from "@/lib/time-saved";
import { useLiveData } from "@/lib/use-live-data";
import { useWorkspaceProfile } from "@/lib/workspace-profile";
import { timeSavedValue, formatValue } from "@/lib/value-metrics";
import { categoryUsage, lastUsedText, loadPercent } from "@/lib/skills-facts";
import {
  Badge,
  Button,
  PageFoot,
  PageHeader,
  Segmented,
  Widget,
  WidgetEmpty,
  WidgetGrid,
  WidgetList,
  WidgetRow,
} from "@/components/ds";

// Each category grid starts collapsed to this many cards — on the mobile
// single-column layout an unpaginated list of every skill in every category
// ran to ~21,000px (audit P3). Matches the "Show top 4 / Show all N" pattern
// already used for Mission Control's skill grid (dashboard.tsx).
const CATEGORY_PREVIEW_COUNT = 4;

let ld: any = {};
let isDemoData = true;

// Build skill rows from liveData.skills.active. The aggregator emits each
// `/<command>` it parsed out of the user's Claude history, with use-counts
// and last-used timestamps. We map those into the same shape the existing
// skill cards expect.
type SkillRow = (typeof sampleSkills)[number];

function inferCategory(name: string): (typeof skillCategories)[number] {
  const n = name.toLowerCase();
  if (n.includes("research") || n.includes("recall") || n.includes("brief")) return "Research";
  if (n.includes("review") || n.includes("audit")) return "Review";
  if (n.includes("memory") || n.includes("wrap") || n.includes("recall")) return "Memory";
  if (n.includes("video") || n.includes("script") || n.includes("intro") || n.includes("title"))
    return "Video";
  if (n.includes("page") || n.includes("design")) return "Design";
  if (n.includes("organize") || n.includes("indexer") || n.includes("automation"))
    return "Automation";
  if (n.includes("report") || n.includes("cost") || n.includes("snapshot")) return "Reporting";
  return "Coding";
}

function buildSkillsFromLive(): SkillRow[] {
  const live = ld?.skills?.active;
  if (!Array.isArray(live)) return [];
  return live.map((s: any): SkillRow => {
    const uses7d = Number(s?.uses7d) || 0;
    const total = Number(s?.totalUses) || 0;
    const uses = uses7d > 0 ? uses7d : total;
    const status: SkillRow["status"] =
      Number(s?.uses7d) > 0 ? "active" : uses > 0 ? "stale" : "unused";
    return {
      name: String(s?.name ?? "/skill"),
      category: inferCategory(String(s?.name ?? "")),
      scope: "global",
      workspace: null,
      lastUsed: String(s?.lastUsed ?? "—"),
      status,
      inputs: [],
      outputs: [],
      uses,
      // Score is heuristic until the aggregator emits one — bias by recency.
      score: status === "active" ? 80 : status === "stale" ? 55 : 30,
    };
  });
}

// skills list is now computed inside SkillsPage()
let skills: SkillRow[] = [];
let hasAnySkills = false;

// Re-implement totals() locally so it sums over `skills` (which is now the
// live list when not in demo mode) instead of the static sampleSkills import.
// The dollar conversion itself goes through the shared timeSavedValue() (see
// src/lib/value-metrics.ts) so the rate and its "assumed" label match every
// other page — this used to compute its own dollars from a page-local rate.
function liveTotals(
  minutesFor: (name: string) => number,
  rate: import("@/lib/workspace-profile").HourlyRate,
  period: Period,
) {
  let mins = 0;
  for (const s of skills) {
    mins += minutesFor(s.name) * runsIn(s.uses, period);
  }
  return timeSavedValue(mins, rate);
}

export const Route = createFileRoute("/skills")({
  head: () => ({
    meta: [
      { title: docTitle("/skills") },
      {
        name: "description",
        content: "Visual map of every Claude Code skill, grouped by category and ranked by usage.",
      },
    ],
  }),
  component: SkillsPage,
});

const ACCENT = "var(--success)";

const categoryIcons: Record<string, any> = {
  Research: Search,
  Coding: Code2,
  Review: Eye,
  Memory: Brain,
  Video: Video,
  Design: Palette,
  Automation: Cog,
  Reporting: BarChart3,
};

function SkillsPage() {
  ld = useLiveData();
  isDemoData = ld?.isExample === true;
  skills = buildSkillsFromLive();
  hasAnySkills = skills.length > 0;
  const [filter, setFilter] = useState<string>("all");

  const filtered = filter === "all" ? skills : skills.filter((s) => s.category === filter);
  const totalUses = skills.reduce((a, s) => a + s.uses, 0);

  const [expandedCats, setExpandedCats] = useState<Set<string>>(new Set());
  const toggleCat = (cat: string) =>
    setExpandedCats((current) => {
      const next = new Set(current);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });

  const [period, setPeriod] = useState<Period>("week");
  const { minutesFor, setMinutesFor, resetAll } = useTimeSaved();
  // The hourly rate is the one shared figure from src/lib/value-metrics.ts /
  // workspace-profile.ts (Settings → Profile) — not a page-local override —
  // so this page always agrees with Mission Control and Share on $/hour.
  const profile = useWorkspaceProfile();
  const rate = profile.rate;
  const [rateDraft, setRateDraft] = useState<string>("");
  const t = liveTotals(minutesFor, rate, period);

  // Computed from the current list on every render. These were useMemo(..., []) and
  // useMemo(..., [minutesFor, rate, period]), so they froze on the empty list taken before the
  // live data arrived and the chart never drew a bar (audit F3-03).
  const byCategory = categoryUsage(skills, skillCategories);
  const topSavers = skills
    .map((s) => {
      const mins = minutesFor(s.name) * runsIn(s.uses, period);
      return { name: s.name, category: s.category, mins, ...timeSavedValue(mins, rate) };
    })
    .sort((a, b) => b.mins - a.mins)
    .slice(0, 6);
  // With no hourly rate set there is no honest dollar figure: show hours only (audit F3-23).
  const showMoney = !rate.assumed;

  return (
    <CalmPage>
      <PageHeader
        title="Skills"
        description={
          hasAnySkills
            ? `${skills.length} skills, ${totalUses.toLocaleString()} uses. ${formatHours(t.minutes)} saved this ${period}.`
            : "Your Claude Code skills, ranked by use."
        }
        className="mb-6"
        meta={
          isDemoData ? (
            <Badge tone="warn" title="Sample data shipped with the app. Run `bun run scripts/aggregate.ts` to populate with your real ~/.claude/ activity.">
              Demo data
            </Badge>
          ) : undefined
        }
      />

      {!hasAnySkills && (
        <WidgetGrid>
          <Widget span={4} icon={Wand2} title="No skills detected yet">
            <WidgetEmpty
              title="Nothing to rank yet"
              body={
                <>
                  Run any <code className="text-foreground/80">/&lt;command&gt;</code> in Claude Code (e.g.{" "}
                  <code className="text-foreground/80">/recall</code>, <code className="text-foreground/80">/wrap-up</code>) and re-run{" "}
                  <code className="text-foreground/80">bun run scripts/aggregate.ts</code> to start tracking.
                </>
              }
            />
          </Widget>
        </WidgetGrid>
      )}

      {hasAnySkills && (
        <>
          <WidgetGrid className="mb-6 lg:mb-8" aria-label="Time saved and totals">
            {/* Time saved: the page's one big number, with the period and hourly rate beside it. */}
            <Widget
              span={2}
              icon={Clock}
              title="Time saved"
              action={
                <>
                  <Segmented
                    ariaLabel="Period"
                    value={period}
                    onChange={setPeriod}
                    options={[
                      { value: "day", label: "Day" },
                      { value: "week", label: "Week" },
                      { value: "month", label: "Month" },
                    ]}
                  />
                  <div className="flex items-center gap-2 rounded-full border border-border bg-background py-1 pl-3 pr-1">
                    <DollarSign className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                    <input
                      type="number"
                      min={0}
                      value={rateDraft !== "" ? rateDraft : showMoney ? rate.rate : ""}
                      placeholder="Not set"
                      onChange={(e) => setRateDraft(e.target.value)}
                      onBlur={() => {
                        const n = Number(rateDraft);
                        if (rateDraft !== "" && Number.isFinite(n) && n > 0) {
                          void profile.save({ hourlyRate: n });
                        }
                        setRateDraft("");
                      }}
                      title="This is your one hourly rate (Settings → Profile) — it updates every page that shows a $ value saved."
                      className="w-20 bg-transparent text-sm font-semibold tabular-nums outline-none"
                      aria-label="Hourly rate"
                    />
                    <span className="pr-2 text-sm text-muted-foreground">/ hour</span>
                    <button
                      type="button"
                      onClick={resetAll}
                      title="Reset your per-skill minute estimates (the hourly rate lives in Settings → Profile)"
                      aria-label="Reset minute estimates"
                      className="rounded-full p-2 text-muted-foreground hover:bg-accent hover:text-foreground"
                    >
                      <RotateCcw className="h-4 w-4" />
                    </button>
                  </div>
                </>
              }
            >
              <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                <span className="ds-num text-4xl font-semibold leading-none tracking-tight text-foreground">{formatHours(t.minutes)}</span>
                {showMoney && <span className="ds-num text-2xl font-semibold text-success">{formatValue(t.amount, t.currency)}</span>}
              </div>
              <p className="mt-3 text-sm text-muted-foreground" data-testid="skills-time-saved-note">
                {showMoney ? (
                  <>Estimated human hours Claude removed this {period}, {rate.label}.</>
                ) : (
                  <>
                    Estimated human hours Claude removed this {period}. No dollar value: your hourly rate isn't set. Enter it here or in{" "}
                    <Link to="/settings" className="underline underline-offset-2 hover:text-foreground">
                      Settings
                    </Link>
                    .
                  </>
                )}
              </p>
            </Widget>
            <Widget icon={Wand2} title="Skills" value={skills.length} line={`${skillCategories.filter((c) => skills.some((s) => s.category === c)).length} categories`} />
            <Widget icon={BarChart3} title="Uses" value={totalUses.toLocaleString()} line="all recorded invocations" />

            <Widget span={2} icon={BarChart3} title="Where the work happens">
              <div className="-mx-2 h-80 lg:h-[26rem]">
                <ResponsiveContainer>
                  <BarChart data={byCategory} margin={{ left: 0, top: 5, right: 8, bottom: 24 }}>
                    <CartesianGrid stroke="var(--border)" strokeDasharray="2 4" vertical={false} />
                    <XAxis dataKey="name" stroke="var(--muted-foreground)" fontSize={13} tickLine={false} axisLine={false} />
                    <YAxis stroke="var(--muted-foreground)" fontSize={13} tickLine={false} axisLine={false} width={40} />
                    <Tooltip
                      cursor={{ fill: "var(--accent)" }}
                      contentStyle={{
                        background: "var(--popover)",
                        border: "1px solid var(--border)",
                        borderRadius: 8,
                        fontSize: 13,
                      }}
                    />
                    <Bar dataKey="uses" fill={ACCENT} radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </Widget>
            <WidgetList span={2} icon={Clock} title="Top time savers" badge={period}>
              {topSavers.map((s) => (
                <WidgetRow
                  key={s.name}
                  title={s.name}
                  meta={showMoney ? `${formatValue(s.amount, s.currency)} · ${s.category}` : s.category}
                  aside={<span className="ds-num text-sm font-semibold text-success">{formatHours(s.mins)}</span>}
                />
              ))}
            </WidgetList>
          </WidgetGrid>

          {/* Filter */}
          <div className="mb-6 flex flex-wrap gap-2" role="group" aria-label="Category">
            <FilterChip label="All" active={filter === "all"} onClick={() => setFilter("all")} />
            {skillCategories.map((c) => (
              <FilterChip key={c} label={c} active={filter === c} onClick={() => setFilter(c)} />
            ))}
          </div>

          {/* Grouped skill widgets: each category starts at one row of four. */}
          <div className="space-y-8">
            {skillCategories.map((cat) => {
              const items = filtered.filter((s) => s.category === cat);
              if (items.length === 0) return null;
              const Icon = categoryIcons[cat];
              const maxUses = Math.max(...items.map((s) => s.uses));
              const isExpanded = expandedCats.has(cat);
              const visibleItems = isExpanded ? items : items.slice(0, CATEGORY_PREVIEW_COUNT);

              return (
                <section key={cat} aria-label={cat}>
                  <div className="mb-4 flex items-center gap-3">
                    <h2 className="text-lg font-semibold tracking-tight">{cat}</h2>
                    <div className="h-px flex-1 bg-border" />
                    <span className="ds-num text-sm text-muted-foreground">
                      {items.length} skills · {items.reduce((a, s) => a + s.uses, 0)} uses
                    </span>
                    {items.length > CATEGORY_PREVIEW_COUNT && (
                      <Button variant="outline" size="sm" onClick={() => toggleCat(cat)}>
                        {isExpanded ? "Show top 4" : `Show all ${items.length}`}
                      </Button>
                    )}
                  </div>

                  <WidgetGrid>
                    {visibleItems.map((s) => {
                      const load = loadPercent(s.uses, maxUses);
                      const tier = levelFor(s.score);
                      return (
                        <Widget
                          key={s.name}
                          icon={Icon}
                          title={<span title={`${tier.label} · score ${s.score}`}>{s.name}</span>}
                          badge={s.status === "active" ? undefined : s.status}
                          headingLevel={3}
                          value={s.uses}
                          line={lastUsedText(s.lastUsed)}
                        >
                          <p className="ds-num text-sm text-muted-foreground">
                            {tier.label} · score {s.score} · load {load}%
                          </p>
                          <div className="mt-3 flex items-center gap-2 rounded-xl border border-border bg-inset px-3 py-2">
                            <Clock className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                            <span className="text-sm text-muted-foreground">Saves</span>
                            <input
                              type="number"
                              min={0}
                              value={minutesFor(s.name)}
                              onChange={(e) => setMinutesFor(s.name, Number(e.target.value))}
                              className="w-12 bg-transparent text-right text-sm font-semibold tabular-nums outline-none"
                              aria-label={`${s.name} minutes saved per run`}
                            />
                            <span className="text-sm text-muted-foreground">min/run</span>
                          </div>
                          <p className="mt-2 text-sm font-semibold tabular-nums text-success">
                            {formatHours(minutesFor(s.name) * runsIn(s.uses, period))}
                            <span className="font-normal text-muted-foreground"> saved / {period}</span>
                          </p>
                          {(s.inputs.length > 0 || s.outputs.length > 0) && (
                            <div className="mt-3 flex flex-wrap items-center gap-1.5">
                              {s.inputs.map((i) => (
                                <span key={i} className="rounded-full border border-border bg-inset px-2 py-0.5 font-mono text-sm text-muted-foreground">
                                  in:{i}
                                </span>
                              ))}
                              {s.outputs.map((o) => (
                                <span key={o} className="rounded-full border border-border bg-inset px-2 py-0.5 font-mono text-sm text-muted-foreground">
                                  out:{o}
                                </span>
                              ))}
                            </div>
                          )}
                        </Widget>
                      );
                    })}
                  </WidgetGrid>
                </section>
              );
            })}
          </div>
          <PageFoot>
            Skills come from your Claude Code history (bun run scripts/aggregate.ts). Minutes per run are your own estimates; the hourly rate is set in{" "}
            <Link to="/settings" className="underline underline-offset-2 hover:text-foreground">
              Settings
            </Link>
            .
          </PageFoot>
        </>
      )}
    </CalmPage>
  );
}

function FilterChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`ds-interactive h-10 rounded-full border px-4 text-sm font-medium transition-colors ${
        active
          ? "bg-brand-soft text-foreground border-brand/50"
          : "bg-card text-muted-foreground border-border hover:text-foreground"
      }`}
    >
      {label}
    </button>
  );
}

// Map a numeric score to an emoji-tagged level. Sentence-case label only —
// no per-card colour tint (docs/DESIGN-SYSTEM.md rule 1); the badge above
// carries the neutral chip, the emoji carries the rest.
function levelFor(score: number): { emoji: string; label: string } {
  if (score >= 90) return { emoji: "👑", label: "Legendary" };
  if (score >= 80) return { emoji: "🚀", label: "Expert" };
  if (score >= 70) return { emoji: "🔥", label: "Skilled" };
  if (score >= 60) return { emoji: "✨", label: "Solid" };
  if (score >= 40) return { emoji: "🌱", label: "Learning" };
  return { emoji: "💤", label: "Dormant" };
}
