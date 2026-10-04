// "M&U at a glance": the top of the Business brief, built from the owner's own data (see
// src/lib/business-facts.ts for every source). Calm and glanceable: the revenue ring against the
// monthly target, the real clients, the pipeline and today, with where each number came from
// folded away. Where a number isn't available, the card says where it would come from and the one
// step to get it; nothing is estimated or sampled here.
import { Link } from "@tanstack/react-router";
import { ArrowRight, CalendarDays, Handshake, PhoneCall, Target, Users } from "lucide-react";
import { ProgressRing, Skeleton } from "@/components/ds";
import { CalmCard, CalmFigure, CalmSection, Pill, type CalmTone } from "@/components/calm/calm";
import { useWorkspacePanel } from "@/components/workspace/api";
import { useBusinessWorkspace } from "@/lib/business-workspace";
import { useOperator } from "@/lib/operator";
import { audWhole, deriveBrief, dollarsShort, useBusinessFactQueries, type BriefModel, type FactSource, type FactState } from "@/lib/business-facts";
import { useState } from "react";
import { MarkBusiness } from "./mark-business";
import { fmtDateTime } from "@/lib/format";

/** Every source the brief reads, combined into one model. Shared by the Business brief and Goals. */
export function useBriefModel(): { model: BriefModel; loading: boolean; saveTarget: ((monthly: number) => Promise<unknown>) | null } {
  const facts = useBusinessFactQueries();
  const pipeline = useWorkspacePanel("pipeline");
  const receptionist = useWorkspacePanel("receptionist");
  const { state, isLoading: stateLoading } = useOperator() as ReturnType<typeof useOperator> & { isLoading?: boolean };
  const workspace = useBusinessWorkspace();
  const profileTarget = workspace.data?.profile?.revenueTargetMonthly ?? null;
  const model = deriveBrief({
    ...facts,
    pipeline: { data: pipeline.data, error: pipeline.error ? String((pipeline.error as Error).message ?? pipeline.error) : null, loading: pipeline.isLoading },
    receptionist: { data: receptionist.data, error: receptionist.error ? String((receptionist.error as Error).message ?? receptionist.error) : null, loading: receptionist.isLoading },
    events: stateLoading ? null : (state?.events ?? []),
    profileTarget: typeof profileTarget === "number" ? profileTarget : null,
    now: Date.now(),
  });
  const loading = !!(facts.wiki.loading && facts.nabThisMonth.loading);
  const saveTarget = workspace.data ? (monthly: number) => workspace.saveProfile({ revenueTargetMonthly: monthly } as never) : null;
  return { model, loading, saveTarget };
}

const STATE_WORD: Record<FactState, string> = { live: "Live", stale: "Stale", failed: "Couldn't read", "setup-required": "Setup required", loading: "Checking" };
const STATE_TONE: Record<FactState, CalmTone> = { live: "success", stale: "warn", failed: "danger", "setup-required": "neutral", loading: "neutral" };

function dateLabel(iso: string) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : fmtDateTime(d, { weekday: true, timeZone: "Australia/Sydney" });
}

/** The revenue ring against the monthly target, with its honest empty state. */
export function RevenueRing({ model, compact = false, saveTarget }: { model: BriefModel; compact?: boolean; saveTarget?: ((monthly: number) => Promise<unknown>) | null }) {
  const r = model.revenue;
  const [saving, setSaving] = useState<"idle" | "saving" | "saved" | string>("idle");
  const pct = r.ratio === null ? null : Math.round(r.ratio * 100);
  return (
    <div className="flex flex-col items-center gap-5 sm:flex-row sm:items-center">
      <ProgressRing
        value={pct}
        max={100}
        size="lg"
        label={
          pct === null
            ? `Revenue towards ${r.targetText ?? "the monthly target"}: unknown`
            : `${pct}% of ${r.targetText ?? "the monthly target"} this month`
        }
        center={
          <span className="ds-num text-xl font-semibold leading-none text-foreground">
            {pct === null ? "—" : `${pct}%`}
          </span>
        }
      />
      <div className="min-w-0 text-center sm:text-left">
        <p className="text-sm text-muted-foreground">Revenue this month</p>
        <p className="ds-num mt-1 text-2xl font-semibold tracking-[-0.02em] text-foreground">
          {r.thisMonthCents === null ? "—" : audWhole(r.thisMonthCents)}
          {r.target && <span className="text-base font-normal text-muted-foreground"> of {dollarsShort(r.target)}/month</span>}
        </p>
        {r.thisMonthCents !== null ? (
          <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
            {r.basis}
            {r.unreviewedCents ? ` · plus ${audWhole(r.unreviewedCents)} cash in not yet marked business or personal` : ""}
            {r.unreviewedCents ? <MarkBusiness /> : null}
            {!compact && r.lastMonthCents !== null ? ` · last month ${audWhole(r.lastMonthCents)}` : ""}
          </p>
        ) : r.empty ? (
          <p className="mt-1 max-w-[46ch] text-sm leading-relaxed text-muted-foreground">
            {r.empty.why}{" "}
            <Link to={r.empty.to as never} className="font-medium text-foreground underline underline-offset-4">
              {r.empty.step}
            </Link>
            .
          </p>
        ) : (
          <Skeleton className="mt-2 h-4 w-48" />
        )}
        {!r.target && <p className="mt-1 text-sm text-muted-foreground">No monthly target saved or found in the wiki.</p>}
        {r.targetSource === "wiki" && saveTarget && r.target && (
          <p className="mt-2 text-xs text-muted-foreground">
            Target {r.targetText} from your M&U wiki.{" "}
            <button
              type="button"
              className="font-medium text-foreground underline underline-offset-4 disabled:opacity-60"
              disabled={saving === "saving"}
              onClick={async () => {
                setSaving("saving");
                try {
                  await saveTarget(r.target!);
                  setSaving("saved");
                } catch (e) {
                  setSaving((e as Error).message || "Couldn't save");
                }
              }}
            >
              {saving === "saving" ? "Saving…" : "Save it as your profile target"}
            </button>
            {saving !== "idle" && saving !== "saving" && saving !== "saved" && <span className="ml-1 text-danger">{saving}</span>}
          </p>
        )}
      </div>
    </div>
  );
}

function ClientList({ model }: { model: BriefModel }) {
  if (!model.clients.length)
    return (
      <p className="text-sm leading-relaxed text-muted-foreground">
        No clients recorded yet. They come from the wiki's Clients page (wiki/topics/business/clients.md) and client sites in the{" "}
        <Link to="/websites" className="font-medium text-foreground underline underline-offset-4">
          Websites
        </Link>{" "}
        catalogue.
      </p>
    );
  return (
    <ul className="calm-rows">
      {model.clients.map((c) => {
        const d = c.deal;
        const facts = [
          d?.totalAud ? `A$${d.totalAud.toLocaleString("en-AU")} total` : null,
          d?.depositAud ? `A$${d.depositAud.toLocaleString("en-AU")} deposit${d.depositPaidOn ? ` paid ${d.depositPaidOn}` : ""}` : null,
          d?.balanceAud ? `A$${d.balanceAud.toLocaleString("en-AU")} due at launch` : null,
          d?.carePlanMonthlyAud ? `care plan $${d.carePlanMonthlyAud}/month` : null,
        ].filter(Boolean);
        const launch = c.site?.launchTarget ?? d?.targetLaunch ?? null;
        return (
          <li key={c.name} className="calm-row items-start">
            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-center gap-2">
                <span className="calm-row-title">{c.name}</span>
                {c.summary && <Pill tone="brand">{c.summary}</Pill>}
              </span>
              {facts.length > 0 && <span className="calm-row-detail">{facts.join(" · ")}</span>}
              <span className="calm-row-detail">
                {[
                  launch ? `Launch target ${launch.replace(/^~/, "")}` : null,
                  c.site?.checklist ? `build checklist ${c.site.checklist.done} of ${c.site.checklist.total}${c.site.checklist.next ? ` · next: ${c.site.checklist.next}` : ""}` : null,
                  c.site?.status ? c.site.status : null,
                ]
                  .filter(Boolean)
                  .join(" · ") || null}
              </span>
              <span className="mt-1 block text-xs text-muted-foreground">Source: {c.source}</span>
            </span>
            {c.site && (
              <a href={c.site.url} target="_blank" rel="noreferrer" className="shrink-0 text-sm font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
                Site
              </a>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export function SourceList({ sources }: { sources: FactSource[] }) {
  return (
    <ul className="calm-rows">
      {sources.map((s) => (
        <li key={s.id} className="calm-row items-start">
          <span className="min-w-0 flex-1">
            <span className="calm-row-title">{s.label}</span>
            <span className="calm-row-detail">{s.detail}</span>
            {s.fix && (
              <Link to={s.fix.to as never} className="mt-1 inline-block text-sm font-medium text-foreground underline underline-offset-4">
                {s.fix.label}
              </Link>
            )}
          </span>
          <Pill tone={STATE_TONE[s.state]}>{STATE_WORD[s.state]}</Pill>
        </li>
      ))}
    </ul>
  );
}

/** The top of the Business brief: the owner's own numbers, calm and glanceable. */
export function MuBrief() {
  const { model, saveTarget } = useBriefModel();
  const p = model.pipeline;
  return (
    <section className="mb-10" aria-labelledby="mu-brief-title">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <h2 id="mu-brief-title" className="text-xl font-semibold tracking-[-0.01em]">
          M&U at a glance
        </h2>
        <Link to="/business" search={{ view: "progress" } as never} className="inline-flex items-center gap-1 text-sm font-medium text-muted-foreground hover:text-foreground">
          Goals <ArrowRight className="h-4 w-4" aria-hidden="true" />
        </Link>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
        <CalmCard tone="brand" aria-label="Revenue towards the monthly target">
          <div className="mb-4 flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <Target className="h-4 w-4" aria-hidden="true" /> Towards {model.revenue.targetText ?? "your monthly target"}
          </div>
          <RevenueRing model={model} saveTarget={saveTarget} />
          {model.position && (
            <p className="mt-5 border-t border-border pt-4 text-sm leading-relaxed text-muted-foreground">
              <span className="font-medium text-foreground">Where M&U stands: </span>
              {model.position.text.split(/(?<=\.)\s/)[0]} <span className="text-xs">(wiki, {model.position.source.split("/").pop()})</span>
            </p>
          )}
        </CalmCard>

        <div className="grid grid-cols-2 gap-4">
          <CalmCard aria-label="Clients">
            <CalmFigure
              label={
                <span className="inline-flex items-center gap-1.5">
                  <Handshake className="h-4 w-4" aria-hidden="true" /> Clients
                </span>
              }
              value={model.clients.length ? String(model.clients.length) : model.crmClients}
              hint={[
                model.clients.some((c) => c.deal?.depositAud) ? `${model.clients.filter((c) => c.deal?.depositAud).length} paid a deposit` : null,
                model.owed ? `${audWhole(model.owed.cents)} due from clients` : null,
                model.crmClients !== null ? `${model.crmClients} won in the CRM` : null,
              ].filter(Boolean).join(" · ") || "From the wiki, websites catalogue and CRM"}
            />
          </CalmCard>
          {/* Open leads and the Receptionist are the Pipeline and Receptionist tiles of the Home page above: one tile each, not two. */}
          <CalmCard aria-label="Today's calendar">
            <CalmFigure
              label={
                <span className="inline-flex items-center gap-1.5">
                  <CalendarDays className="h-4 w-4" aria-hidden="true" /> Today
                </span>
              }
              value={model.calendar ? `${model.calendar.today} ${model.calendar.today === 1 ? "event" : "events"}` : null}
              hint={model.calendar?.next ? `Next: ${model.calendar.next.title}${model.calendar.next.allDay ? " (all day)" : ` · ${dateLabel(model.calendar.next.start)}`}` : model.calendar ? "Nothing else today" : "Reading the calendar…"}
            />
          </CalmCard>
        </div>
      </div>

      <div className="mt-4">
        <CalmSection title="Clients" summary={model.clients.length ? model.clients.map((c) => c.name).join(", ") : "None recorded yet"} icon={Handshake} persistKey="mu-brief-clients" headingLevel={3}>
          <ClientList model={model} />
          {model.sentence && <p className="mt-4 text-sm text-muted-foreground">CRM today: {model.sentence}</p>}
        </CalmSection>
      </div>
    </section>
  );
}

/** The brief's sources, for the ONE "Where these numbers come from" fold at the foot of Home. */
export function BriefSources() {
  const { model } = useBriefModel();
  return <SourceList sources={model.sources} />;
}
