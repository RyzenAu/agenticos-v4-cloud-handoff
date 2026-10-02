import { honestWebsiteText, websiteVerification } from "@/lib/call-queue";
// Dense, sortable table of every lead with its deal row: company, contact, stage (days in stage,
// stuck flag), value, source, evidenced issues, last contact and next follow-up. Read-only apart
// from tel: links; a row opens the lead drawer.
import { useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown, MessageSquareText } from "lucide-react";
import { Badge, Button, Surface, fmtDate, fmtRelative } from "@/components/ds";
import { cn } from "@/lib/utils";
import {
  aud,
  siteHost,
  STAGE_LABEL,
  STAGES,
  suburbOf,
  VERTICAL_LABEL,
  type BoardLead,
  type Vertical,
} from "@/lib/leads";

type SortKey = "company" | "contact" | "stage" | "value" | "source" | "issues" | "last" | "next";
const COLUMNS: { key: SortKey; label: string; className?: string }[] = [
  { key: "company", label: "Company" },
  { key: "contact", label: "Contact" },
  { key: "stage", label: "Stage" },
  { key: "value", label: "1st-year value", className: "text-right" },
  { key: "source", label: "Source" },
  { key: "issues", label: "Issues" },
  { key: "last", label: "Last contact" },
  { key: "next", label: "Next follow-up" },
];
const PAGE = 100;

function sortValue(l: BoardLead, key: SortKey): string | number {
  switch (key) {
    case "company":
      return (l.name || "~").toLowerCase();
    case "contact":
      return (l.phone ? 2 : 0) + (l.emailOk && l.emails.length ? 1 : 0);
    // Stage order first, then longest-waiting first within a stage (stuck floats up).
    case "stage":
      return (
        STAGES.indexOf(l.deal.stage) * 10_000 +
        (l.deal.stuck ? 5_000 : 0) +
        Math.min(l.deal.daysInStage ?? 0, 4_999)
      );
    case "value":
      return l.deal.economics.weightedCents;
    case "source":
      return `${l.source ?? ""}${l.websiteSource ?? ""}`;
    case "issues":
      return l.deal.issues.reduce((s, i) => s + i.severity, 0);
    case "last":
      return l.lastContactAt ? Date.parse(l.lastContactAt) : 0;
    case "next":
      return l.nextAt ? -Date.parse(l.nextAt) : -Infinity;
  }
}

export function sourceLabel(l: Pick<BoardLead, "source" | "websiteSource">): string {
  const base = l.source === "osm" ? "OSM" : l.source === "google" ? "Google" : l.source || "—";
  return l.websiteSource?.startsWith("discovered") ? `${base} + site` : base;
}

export function LeadsTable({
  leads,
  onOpen,
  ordered = false,
  orderKey,
}: {
  leads: BoardLead[];
  onOpen: (id: number) => void;
  ordered?: boolean;
  orderKey?: string;
}) {
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 } | null>(
    ordered ? null : { key: "stage", dir: -1 },
  );
  useEffect(() => {
    if (ordered) setSort(null);
    setLimit(PAGE);
  }, [ordered, orderKey]);
  const [limit, setLimit] = useState(PAGE);
  const sorted = useMemo(() => {
    const out = [...leads];
    if (!sort) return out;
    out.sort((a, b) => {
      const x = sortValue(a, sort.key),
        y = sortValue(b, sort.key);
      return (x < y ? -1 : x > y ? 1 : 0) * sort.dir || b.score - a.score;
    });
    return out;
  }, [leads, sort]);
  const now = Date.now();
  const toggle = (key: SortKey) =>
    setSort((s) =>
      s?.key === key
        ? { key, dir: s.dir === 1 ? -1 : 1 }
        : { key, dir: key === "company" ? 1 : -1 },
    );

  return (
    <>
      <MobileRows leads={sorted.slice(0, limit)} onOpen={onOpen} now={now} />
      <Surface padding="none" className="hidden overflow-hidden md:block">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1180px] text-[13px]" aria-label="Leads table">
            <thead>
              <tr className="border-b border-border text-left">
                {COLUMNS.map((c) => {
                  const on = sort?.key === c.key;
                  const Icon = on ? (sort?.dir === 1 ? ArrowUp : ArrowDown) : ArrowUpDown;
                  return (
                    <th
                      key={c.key}
                      scope="col"
                      aria-sort={on ? (sort?.dir === 1 ? "ascending" : "descending") : "none"}
                      className={cn("px-3 py-2", c.className)}
                    >
                      <button
                        type="button"
                        onClick={() => toggle(c.key)}
                        className={cn(
                          "ds-interactive ds-label inline-flex items-center gap-1 rounded font-medium hover:text-foreground",
                          on ? "text-foreground" : "text-muted-foreground",
                        )}
                      >
                        {c.label}
                        <Icon className="size-3" aria-hidden="true" />
                      </button>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {sorted.slice(0, limit).map((l) => {
                const d = l.deal;
                const email = l.emailOk ? l.emails[0] : undefined;
                const overdue = !!l.nextAt && Date.parse(l.nextAt) < now && !d.closed;
                return (
                  // The row stays a table row for screen readers; the keyboard route in is a real
                  // button on the company name (audit F1-30). A mouse click anywhere still opens it.
                  <tr
                    key={l.id}
                    className={cn(
                      "cursor-pointer border-b border-border align-top last:border-0 hover:bg-surface-raised focus-within:bg-surface-raised",
                      (l.excluded || d.closed) && "opacity-60",
                    )}
                    onClick={() => onOpen(l.id)}
                  >
                    <td className="max-w-[260px] px-3 py-2">
                      <button
                        type="button"
                        aria-label={`Open ${l.name || "lead"}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          onOpen(l.id);
                        }}
                        className="ds-interactive block max-w-full rounded text-left font-medium text-foreground underline-offset-2 [overflow-wrap:anywhere] hover:underline"
                      >
                        {l.name || "(name not on file)"}
                      </button>
                      <div className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
                        {[
                          suburbOf(l.area),
                          VERTICAL_LABEL[l.vertical as Vertical] ?? l.vertical,
                          l.website ? siteHost(l.website) : websiteVerification(l),
                        ].join(" · ")}
                      </div>
                    </td>
                    <td
                      className="max-w-[190px] px-3 py-2 text-xs"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {l.phone ? (
                        <a
                          href={`tel:${l.phone.replace(/[^\d+]/g, "")}`}
                          className="ds-num block whitespace-nowrap text-foreground underline-offset-2 hover:underline"
                        >
                          {l.phone}
                        </a>
                      ) : (
                        <span className="block text-muted-foreground">No phone</span>
                      )}
                      {email && (
                        <span
                          className="block text-muted-foreground [overflow-wrap:anywhere]"
                          title={email}
                        >
                          {email}
                        </span>
                      )}
                      {d.contactPref && (
                        <span
                          className="mt-0.5 flex items-center gap-1 text-foreground"
                          title={d.contactPref}
                        >
                          <MessageSquareText className="size-3 shrink-0" aria-hidden="true" />
                          <span className="min-w-0 [overflow-wrap:anywhere]">{d.contactPref}</span>
                        </span>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2">
                      <div className="flex items-center gap-1.5">
                        <Badge
                          tone={
                            d.closed
                              ? "danger"
                              : d.stuck
                                ? "warn"
                                : STAGES.indexOf(d.stage) >= STAGES.indexOf("won")
                                  ? "success"
                                  : STAGES.indexOf(d.stage) >= STAGES.indexOf("contacted")
                                    ? "accent"
                                    : "neutral"
                          }
                        >
                          {d.closed
                            ? `Closed · ${l.status.replace(/_/g, " ")}`
                            : STAGE_LABEL[d.stage]}
                        </Badge>
                      </div>
                      <div
                        className={cn(
                          "ds-num mt-0.5 text-xs",
                          d.stuck ? "font-medium text-warn" : "text-muted-foreground",
                        )}
                        title={d.stuck ? d.stuck.action : d.evidence}
                      >
                        {d.daysInStage === null
                          ? "—"
                          : `${d.daysInStage} d${d.daysInferred ? "+" : ""}`}
                        {d.stuck ? ` · stuck (limit ${d.stuck.thresholdDays})` : ""}
                      </div>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-right">
                      <div className="ds-num font-medium text-foreground">
                        {aud(d.economics.valueCents)}
                      </div>
                      <div className="ds-num text-xs text-muted-foreground">
                        {Math.round(d.economics.probability * 100)}% ·{" "}
                        {aud(d.economics.weightedCents)}
                      </div>
                    </td>
                    <td
                      className="whitespace-nowrap px-3 py-2 text-xs text-muted-foreground"
                      title={
                        l.source === "osm"
                          ? "OpenStreetMap (© OpenStreetMap contributors)"
                          : l.source
                      }
                    >
                      {sourceLabel(l)}
                    </td>
                    <td className="max-w-[300px] px-3 py-2">
                      {d.issues.length ? (
                        // L10 (29 Sep 2026): the top finding as plain text with a count, not a pill per finding.
                        <p
                          className="max-w-[260px] text-xs leading-snug text-foreground"
                          title={d.issues.map((i) => honestWebsiteText(i.finding, l)).join("\n")}
                        >
                          <span className="line-clamp-2 [overflow-wrap:anywhere]">
                            {honestWebsiteText(d.issues[0].finding, l)}
                          </span>
                          {d.issues.length > 1 && (
                            <span className="text-muted-foreground">
                              {" "}
                              · +{d.issues.length - 1} more
                            </span>
                          )}
                        </p>
                      ) : (
                        <span className="text-xs text-muted-foreground">Not checked</span>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-xs text-muted-foreground">
                      {l.lastContactAt ? fmtRelative(l.lastContactAt) : "Never"}
                    </td>
                    <td
                      className={cn(
                        "whitespace-nowrap px-3 py-2 text-xs",
                        overdue ? "font-medium text-danger" : "text-foreground",
                      )}
                    >
                      {l.nextAt ? (
                        `${fmtDate(l.nextAt)}${overdue ? " · overdue" : ""}`
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {sorted.length > limit && (
          <div className="flex items-center justify-between gap-2 border-t border-border px-3 py-2 text-xs text-muted-foreground">
            <span>
              Showing {limit} of {sorted.length}
            </span>
            <Button variant="ghost" size="xs" onClick={() => setLimit((n) => n + PAGE * 2)}>
              Show more
            </Button>
          </div>
        )}
      </Surface>
      {sorted.length > limit && (
        <Button
          variant="outline"
          size="sm"
          className="mt-2 w-full md:hidden"
          onClick={() => setLimit((n) => n + PAGE * 2)}
        >
          Show more ({sorted.length - limit} left)
        </Button>
      )}
    </>
  );
}

/** Phones: one row per lead with what's needed to triage — stage and age, value, next step. */
function MobileRows({
  leads,
  onOpen,
  now,
}: {
  leads: BoardLead[];
  onOpen: (id: number) => void;
  now: number;
}) {
  return (
    <ul
      className="flex flex-col divide-y divide-border rounded-xl border border-border bg-card md:hidden"
      aria-label="Leads"
    >
      {leads.map((l) => {
        const d = l.deal;
        const overdue = !!l.nextAt && Date.parse(l.nextAt) < now && !d.closed;
        return (
          <li key={l.id}>
            <button
              type="button"
              onClick={() => onOpen(l.id)}
              className={cn(
                "ds-interactive flex w-full flex-col gap-1 px-3 py-2.5 text-left",
                (l.excluded || d.closed) && "opacity-60",
              )}
            >
              <span className="flex items-baseline justify-between gap-2">
                <span className="min-w-0 text-sm font-medium text-foreground [overflow-wrap:anywhere]">
                  {l.name || "(name not on file)"}
                </span>
                <span className="ds-num shrink-0 text-xs font-medium text-foreground">
                  {aud(d.economics.valueCents)}
                </span>
              </span>
              <span className="flex flex-wrap items-center gap-1.5 text-xs">
                <Badge tone={d.closed ? "danger" : d.stuck ? "warn" : "neutral"}>
                  {d.closed ? "Closed" : STAGE_LABEL[d.stage]}
                </Badge>
                <span
                  className={cn(
                    "ds-num",
                    d.stuck ? "font-medium text-warn" : "text-muted-foreground",
                  )}
                >
                  {d.daysInStage === null ? "" : `${d.daysInStage} d`}
                  {d.stuck ? ` · stuck (limit ${d.stuck.thresholdDays})` : ""}
                </span>
                {l.nextAt && (
                  <span
                    className={cn(overdue ? "font-medium text-danger" : "text-muted-foreground")}
                  >
                    · next {fmtDate(l.nextAt)}
                    {overdue ? " (overdue)" : ""}
                  </span>
                )}
              </span>
              <span className="line-clamp-2 text-xs text-muted-foreground [overflow-wrap:anywhere]">
                {d.stuck ? d.stuck.action : d.nextAction}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
