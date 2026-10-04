// Websites → "Make a site" (W-F, 29 Sep 2026). Who it's for, the vertical, the skills and a line of brief
// become one coding request (src/lib/site-maker.ts), which opens Track 3's coding DRAFT. The draft shows
// the plan, repo and agents and waits for "Start it" on the Coding page: nothing here starts an agent,
// deploys, publishes or touches DNS. "Ask Jarvis" sends the equivalent phrase to Jarvis in text mode,
// which opens the same draft (src/lib/commands/site-maker.ts).
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  ArrowRight,
  Check,
  ChevronDown,
  Loader2,
  MessageSquareText,
  Search,
  Sparkles,
  X,
} from "lucide-react";
import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { Button, Disclosure, ProgressRing, Segmented } from "@/components/ds";
import { codingClient } from "@/lib/coding-client";
import { leadsApi } from "@/lib/leads";
import {
  buildSiteRequest,
  jarvisPhrase,
  PRESET_SKILLS,
  SITE_BRIEF_MAX,
  SITE_REQUEST_MAX,
  SITE_SKILLS,
  SITE_VERTICALS,
  SKILL_GROUPS,
  verticalOf,
  type SiteTarget,
  type SiteVertical,
} from "@/lib/site-maker";
import type { OurSite } from "@/lib/websites";
import { cn } from "@/lib/utils";

type Who = "lead" | "site" | "brief";

function Step({
  n,
  done,
  title,
  hint,
  children,
}: {
  n: number;
  done: boolean;
  title: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <li className="flex gap-4">
      <span
        aria-hidden="true"
        className={cn(
          "mt-0.5 grid size-8 shrink-0 place-items-center rounded-full border text-sm font-semibold tabular-nums transition-colors",
          done
            ? "border-brand bg-brand text-brand-foreground"
            : "border-border-strong text-muted-foreground",
        )}
      >
        {done ? <Check className="size-4" /> : n}
      </span>
      <div className="min-w-0 flex-1 pb-8">
        <h3 className="text-base font-semibold leading-snug">{title}</h3>
        {hint && <p className="mt-0.5 text-sm text-muted-foreground">{hint}</p>}
        <div className="mt-3">{children}</div>
      </div>
    </li>
  );
}

function Pill({
  pressed,
  onClick,
  children,
  title,
  role = "button",
}: {
  pressed: boolean;
  onClick: () => void;
  children: ReactNode;
  title?: string;
  role?: "button" | "radio";
}) {
  return (
    <button
      type="button"
      role={role === "radio" ? "radio" : undefined}
      aria-pressed={role === "button" ? pressed : undefined}
      aria-checked={role === "radio" ? pressed : undefined}
      title={title}
      onClick={onClick}
      className={cn(
        "ds-interactive inline-flex min-h-9 items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-sm transition-colors",
        pressed
          ? "border-brand bg-brand-soft text-foreground"
          : "border-border bg-inset text-muted-foreground hover:border-border-strong hover:text-foreground",
      )}
    >
      {pressed && <Check className="size-3.5 text-brand" aria-hidden="true" />}
      {children}
    </button>
  );
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

type PickedLead = { leadId: number; name: string; detail: string };

function LeadPicker({
  picked,
  onPick,
}: {
  picked: PickedLead | null;
  onPick: (lead: PickedLead | null) => void;
}) {
  const [q, setQ] = useState("");
  const query = useDebounced(q.trim(), 250);
  const inputId = useId();
  const hits = useQuery({
    queryKey: ["site-maker-leads", query],
    queryFn: () => leadsApi.search(query),
    enabled: query.length >= 2 && !picked,
    retry: false,
    staleTime: 30_000,
  });
  if (picked)
    return (
      <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-border bg-inset px-4 py-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-base font-medium">{picked.name}</p>
          <p className="truncate text-sm text-muted-foreground">
            Lead #{picked.leadId}
            {picked.detail ? ` · ${picked.detail}` : ""}
          </p>
        </div>
        <Button size="sm" variant="ghost" onClick={() => onPick(null)}>
          <X /> Change
        </Button>
      </div>
    );
  const list = (hits.data?.hits ?? [])
    .filter((h) => h.group === "leads" || h.group === "clients")
    .slice(0, 6);
  return (
    <div>
      <label htmlFor={inputId} className="sr-only">
        Search the CRM for a lead
      </label>
      <div className="flex h-11 items-center gap-2 rounded-full border border-input bg-background px-4 focus-within:ring-2 focus-within:ring-ring">
        <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <input
          id={inputId}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search leads by name or suburb"
          autoComplete="off"
          spellCheck={false}
          className="min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-muted-foreground"
        />
        {hits.isFetching && (
          <Loader2 className="size-4 animate-spin text-muted-foreground" aria-hidden="true" />
        )}
      </div>
      <div aria-live="polite" className="mt-2">
        {query.length >= 2 && hits.error ? (
          <p className="text-sm text-muted-foreground">
            Couldn't search the CRM: {(hits.error as Error).message}
          </p>
        ) : query.length >= 2 && hits.data && !list.length ? (
          <p className="text-sm text-muted-foreground">
            No lead matches “{query}”. Try another name, or use “Just a brief”.
          </p>
        ) : list.length ? (
          <ul className="flex flex-col gap-1.5">
            {list.map((h) => (
              <li key={`${h.group}-${h.leadId}`}>
                <button
                  type="button"
                  onClick={() => onPick({ leadId: h.leadId, name: h.title, detail: h.detail })}
                  className="ds-interactive flex w-full items-center justify-between gap-3 rounded-xl border border-border bg-card px-4 py-2.5 text-left hover:border-border-strong hover:bg-surface-raised"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">{h.title}</span>
                    <span className="block truncate text-sm text-muted-foreground">{h.detail}</span>
                  </span>
                  <ArrowRight
                    className="size-4 shrink-0 text-muted-foreground"
                    aria-hidden="true"
                  />
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">
            Type two or more letters. Only the name, suburb and their current site go into the
            brief, never phone or email.
          </p>
        )}
      </div>
    </div>
  );
}

/** Repo line for the summary: is it set up for coding jobs? Honest when the registry can't be read. */
function RepoState({ repo, why }: { repo: string; why: string }) {
  const repos = useQuery({
    queryKey: ["coding-repos"],
    queryFn: () => codingClient.repos(),
    retry: false,
    staleTime: 60_000,
  });
  const registered = repos.data?.repos.some((r) => r.id === repo) ?? null;
  return (
    <div>
      <p className="font-mono text-sm">{repo}</p>
      <p className="mt-0.5 text-sm text-muted-foreground">{why}.</p>
      <p className="mt-1.5 inline-flex items-center gap-1.5 text-sm">
        {repos.isLoading ? (
          <span className="text-muted-foreground">Checking the coding registry…</span>
        ) : repos.error ? (
          <span className="text-muted-foreground">
            Coding registry not checked: {(repos.error as Error).message}
          </span>
        ) : registered ? (
          <>
            <span className="size-2 rounded-full bg-success" aria-hidden="true" /> Set up for coding
            jobs
          </>
        ) : (
          <>
            <span className="size-2 rounded-full bg-warn" aria-hidden="true" /> Not in the coding
            registry yet: the draft will ask which repo
          </>
        )}
      </p>
    </div>
  );
}

export function MakeSite({ sites }: { sites: readonly OurSite[] }) {
  const navigate = useNavigate();
  const [who, setWho] = useState<Who>("lead");
  const [lead, setLead] = useState<PickedLead | null>(null);
  const [siteId, setSiteId] = useState<string | null>(null);
  const [vertical, setVertical] = useState<SiteVertical | null>(null);
  const [other, setOther] = useState("");
  const [skills, setSkills] = useState<string[]>([...PRESET_SKILLS]);
  const [brief, setBrief] = useState("");
  const [showSkills, setShowSkills] = useState(false);
  const briefId = useId();
  const otherId = useId();

  // A picked lead's vertical, suburb and current site (never its phone or email).
  const detail = useQuery({
    queryKey: ["site-maker-lead", lead?.leadId],
    queryFn: () => leadsApi.detail(lead!.leadId),
    enabled: who === "lead" && !!lead,
    retry: false,
    staleTime: 60_000,
  });
  const site = sites.find((s) => s.id === siteId) ?? null;

  // The vertical follows what was picked until he chooses one himself.
  const [verticalTouched, setVerticalTouched] = useState(false);
  useEffect(() => {
    if (verticalTouched) return;
    const v =
      who === "lead"
        ? (verticalOf(detail.data?.lead.vertical ?? null) ?? verticalOf(lead?.name))
        : who === "site"
          ? verticalOf(site?.vertical ?? null)
          : null;
    setVertical(v);
  }, [who, detail.data, lead, site, verticalTouched]);

  const leadArea = detail.data?.lead.area ?? null;
  const leadWebsite = detail.data?.lead.website || null;
  const target = useMemo<SiteTarget | null>(
    () =>
      who === "lead"
        ? lead
          ? {
              kind: "lead",
              leadId: lead.leadId,
              name: lead.name,
              area: leadArea,
              website: leadWebsite,
            }
          : null
        : who === "site"
          ? site
            ? {
                kind: "site",
                siteId: site.id,
                name: site.name,
                repo: site.repo.path ? site.repo.path.split(/[\\/]/).pop() || site.id : site.id,
                url: site.url,
                client: site.kind === "client",
              }
            : null
          : { kind: "brief" },
    [who, lead, site, leadArea, leadWebsite],
  );

  const built = useMemo(
    () =>
      target && vertical
        ? buildSiteRequest({ target, vertical, otherVertical: other, brief, skills })
        : null,
    [target, vertical, other, brief, skills],
  );
  const paid = SITE_SKILLS.filter((s) => s.paid && skills.includes(s.id));
  const hasBrief = brief.trim().length > 0;
  // Who, vertical and skills are needed; the brief too when there's nothing else to go on.
  const done = [
    !!target && (who !== "brief" || hasBrief),
    !!vertical && (vertical !== "other" || other.trim().length > 0),
    skills.length > 0,
    hasBrief,
  ];
  const needed = who === "brief" ? 4 : 3;
  const set = done.slice(0, needed).filter(Boolean).length;
  const ready = !!built?.ok && set === needed;
  const phrase = target && vertical ? jarvisPhrase(target, vertical, other) : null;

  const toggle = (id: string) =>
    setSkills((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  return (
    <section id="make-site" aria-labelledby="make-site-title" className="col-span-full min-w-0">
      <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
        <div className="border-b border-border px-5 py-4 sm:px-7">
          <h2 id="make-site-title" className="sr-only">
            Make a site
          </h2>
          <p className="max-w-[62ch] text-base text-muted-foreground">
            You get a coding draft to check first. Nothing starts until you press Start on the Coding page.
          </p>
        </div>

        <div className="grid grid-cols-[minmax(0,1fr)] gap-0 lg:grid-cols-[minmax(0,1fr)_380px]">
          <ol className="px-5 pt-6 sm:px-7">
            <Step
              n={1}
              done={done[0]}
              title="Who it's for"
            >
              <Segmented
                ariaLabel="Who the site is for"
                value={who}
                onChange={(v) => {
                  setWho(v);
                  setVerticalTouched(false);
                }}
                options={[
                  { value: "lead", label: "A lead" },
                  { value: "site", label: "One of our sites" },
                  { value: "brief", label: "Just a brief" },
                ]}
              />
              <div className="mt-4">
                {who === "lead" && (
                  <LeadPicker
                    picked={lead}
                    onPick={(l) => {
                      setLead(l);
                      setVerticalTouched(false);
                    }}
                  />
                )}
                {who === "site" &&
                  (sites.length ? (
                    <div role="radiogroup" aria-label="Our sites" className="flex flex-wrap gap-2">
                      {sites.map((s) => (
                        <Pill
                          key={s.id}
                          role="radio"
                          pressed={siteId === s.id}
                          onClick={() => {
                            setSiteId(s.id);
                            setVerticalTouched(false);
                          }}
                        >
                          {s.name}
                          <span className="text-sm text-muted-foreground">
                            {s.kind === "client" ? "client" : "flagship"}
                          </span>
                        </Pill>
                      ))}
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      The site catalogue hasn't loaded yet.
                    </p>
                  ))}
                {who === "brief" && (
                  <p className="text-sm text-muted-foreground">Write the brief in step 4.</p>
                )}
              </div>
            </Step>

            <Step
              n={2}
              done={done[1]}
              title="Vertical"
              hint={vertical && !verticalTouched && who !== "brief" ? "Filled in from what you picked." : undefined}
            >
              <div role="radiogroup" aria-label="Vertical" className="flex flex-wrap gap-2">
                {SITE_VERTICALS.map((v) => (
                  <Pill
                    key={v.id}
                    role="radio"
                    pressed={vertical === v.id}
                    onClick={() => {
                      setVertical(v.id);
                      setVerticalTouched(true);
                    }}
                  >
                    {v.label}
                  </Pill>
                ))}
              </div>
              {vertical === "other" && (
                <div className="mt-3 max-w-sm">
                  <label htmlFor={otherId} className="text-sm font-medium">
                    Kind of business
                  </label>
                  <input
                    id={otherId}
                    value={other}
                    maxLength={40}
                    onChange={(e) => setOther(e.target.value)}
                    placeholder="physio clinic"
                    className="mt-1.5 h-10 w-full rounded-xl border border-input bg-background px-3 text-base outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  />
                </div>
              )}
            </Step>

            <Step
              n={3}
              done={done[2]}
              title="Skills"
              hint={`${skills.length} chosen`}
            >
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" variant="outline" onClick={() => setSkills([...PRESET_SKILLS])}>
                  Top-tier set
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setShowSkills((s) => !s)}
                  aria-expanded={showSkills}
                  aria-controls="make-site-skills"
                >
                  {showSkills ? "Hide skills" : "Choose skills"}{" "}
                  <ChevronDown className={cn("transition-transform", showSkills && "rotate-180")} />
                </Button>
              </div>
              {!showSkills && (
                <p className="mt-3 text-sm text-muted-foreground">
                  {SITE_SKILLS.filter((s) => skills.includes(s.id))
                    .map((s) => s.label)
                    .join(" · ") || "None chosen"}
                </p>
              )}
              {showSkills && (
                <div id="make-site-skills" className="mt-4 flex flex-col gap-5">
                  {SKILL_GROUPS.map((g) => (
                    <div key={g.id}>
                      <p className="text-sm font-medium">{g.label}</p>
                      <p className="text-sm text-muted-foreground">{g.note}</p>
                      <div className="mt-2 flex flex-wrap gap-2">
                        {SITE_SKILLS.filter((s) => s.group === g.id).map((s) => (
                          <Pill
                            key={s.id}
                            pressed={skills.includes(s.id)}
                            onClick={() => toggle(s.id)}
                            title={s.does}
                          >
                            {s.label}
                            {s.paid && <span className="text-sm text-warn">paid</span>}
                          </Pill>
                        ))}
                      </div>
                      <ul className="mt-2 grid gap-x-6 gap-y-1 text-sm text-muted-foreground sm:grid-cols-2">
                        {SITE_SKILLS.filter((s) => s.group === g.id).map((s) => (
                          <li key={s.id}>
                            <span className="font-mono">{s.id}</span>: {s.does}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              )}
            </Step>

            <Step
              n={4}
              done={done[3]}
              title={who === "brief" ? "Brief" : "Brief (optional)"}
            >
              <label htmlFor={briefId} className="sr-only">
                Brief
              </label>
              <textarea
                id={briefId}
                value={brief}
                onChange={(e) => setBrief(e.target.value)}
                rows={3}
                placeholder="Calm and premium. Same-week appointments front and centre. No stock photos of people."
                className="w-full rounded-2xl border border-input bg-background px-4 py-3 text-base outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
              <p
                className={cn(
                  "mt-1 text-right text-sm tabular-nums",
                  brief.trim().length > SITE_BRIEF_MAX ? "text-danger" : "text-muted-foreground",
                )}
              >
                {brief.trim().length} / {SITE_BRIEF_MAX}
              </p>
            </Step>
          </ol>

          <aside
            aria-label="Your draft"
            className="border-t border-border bg-inset/60 px-5 py-6 sm:px-7 lg:border-l lg:border-t-0"
          >
            <div className="flex items-center gap-3">
              <ProgressRing
                value={set}
                max={needed}
                size="md"
                label={`${set} of ${needed} steps set`}
              />
              <div>
                <p className="text-base font-semibold">{ready ? "Ready to draft" : "Your draft"}</p>
                <p className="text-sm text-muted-foreground">
                  {ready
                    ? "Check it on the Coding page, then Start."
                    : `${needed - set} step${needed - set === 1 ? "" : "s"} to go`}
                </p>
              </div>
            </div>

            <dl className="mt-6 flex flex-col gap-4 text-sm">
              <div>
                <dt className="text-muted-foreground">For</dt>
                <dd className="mt-0.5 text-base">
                  {target?.kind === "lead" || target?.kind === "site"
                    ? target.name
                    : who === "brief"
                      ? "A brief"
                      : "—"}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Repo</dt>
                <dd className="mt-0.5">
                  {built ? (
                    <RepoState repo={built.repo.repo} why={built.repo.why} />
                  ) : (
                    <span className="text-base">
                      —{" "}
                      <span className="text-sm text-muted-foreground">
                        (set who and the vertical)
                      </span>
                    </span>
                  )}
                </dd>
              </div>
              {paid.length > 0 && (
                <div className="rounded-xl border border-warn/40 bg-warn-soft px-3 py-2 text-sm">
                  {paid.map((s) => s.label).join(" and ")} use{paid.length === 1 ? "s" : ""} a paid
                  provider. The request says it may run only after you approve the exact spend.
                </div>
              )}
            </dl>

            {built && !built.ok && (
              <p role="alert" className="mt-4 text-sm text-danger">
                {built.reason}
              </p>
            )}

            <div className="mt-6 flex flex-col gap-2">
              <Button
                variant="accent"
                size="lg"
                className="w-full rounded-full px-5"
                disabled={!ready}
                onClick={() =>
                  built?.ok &&
                  void navigate({
                    to: "/coding" as never,
                    search: { request: built.request } as never,
                  })
                }
              >
                Create coding draft <ArrowRight />
              </Button>
              <Button
                variant="outline"
                className="w-full rounded-full"
                disabled={!phrase || !ready}
                onClick={() =>
                  phrase &&
                  window.dispatchEvent(
                    new CustomEvent("operator:voice-text", { detail: { request: phrase } }),
                  )
                }
              >
                <MessageSquareText /> Ask Jarvis instead
              </Button>
              {phrase && (
                <p className="text-center text-sm text-muted-foreground">Or say: “{phrase}”</p>
              )}
            </div>

            {built && (
              <Disclosure
                className="mt-6 rounded-xl border border-border bg-card"
                summary={<span className="font-medium">See the exact request</span>}
                meta={
                  <span className="tabular-nums">
                    {built.length} / {SITE_REQUEST_MAX}
                  </span>
                }
              >
                <p
                  className="whitespace-pre-wrap break-words text-sm leading-relaxed text-muted-foreground"
                  data-testid="site-request"
                >
                  {built.request}
                </p>
                <p className="mt-2 text-sm text-muted-foreground">
                  Opens the Coding page (<span className="font-mono">/coding</span>) with this
                  request as a draft.
                </p>
              </Disclosure>
            )}

            <p className="mt-6 text-sm leading-relaxed text-muted-foreground">
              Nothing deploys, publishes or changes DNS from here. Lead previews still go live only
              from the lead's drawer, one founder click at a time.
            </p>
          </aside>
        </div>
      </div>
    </section>
  );
}
