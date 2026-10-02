import { useId, useMemo, type ReactNode, type Dispatch, type SetStateAction } from "react";
import { Search, SlidersHorizontal, X } from "lucide-react";
import { Button, Disclosure } from "@/components/ds";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  pitchFilterOptions,
  STATUSES,
  statusLabel,
  STAGES,
  STAGE_LABEL,
  VERTICALS,
  VERTICAL_LABEL,
  type BoardLead,
} from "@/lib/leads";
import {
  DEFAULT_LEAD_FILTERS,
  WEBSITE_FILTER_OPTIONS,
  OWNER_FILTER_OPTIONS,
  CONTACT_FILTER_OPTIONS,
  CREATED_FILTER_OPTIONS,
  FOLLOWUP_FILTER_OPTIONS,
  LEAD_SORT_OPTIONS,
  leadFilterOptions,
  type LeadFilters,
} from "@/lib/lead-search";

type Option = { value: string; label: string };

function leadFilterCount(filters: LeadFilters): number {
  return Object.entries(filters).filter(
    ([key, value]) => key !== "sort" && value !== DEFAULT_LEAD_FILTERS[key as keyof LeadFilters],
  ).length;
}

/** Filters describe saved records, never imply that an empty URL proves a business has no site. */
export function LeadFilterBar({
  filters,
  setFilters,
  leads,
  shortcuts,
}: {
  filters: LeadFilters;
  setFilters: Dispatch<SetStateAction<LeadFilters>>;
  leads: BoardLead[];
  shortcuts?: ReactNode;
}) {
  const set = <K extends keyof LeadFilters>(key: K, value: LeadFilters[K]) =>
    setFilters((f) => ({ ...f, [key]: value }));
  const options = useMemo(() => leadFilterOptions(leads), [leads]);
  const active = leadFilterCount(filters);
  const more = active - Number(!!filters.q);
  const fields: { key: keyof LeadFilters; label: string; all: string; options: Option[] }[] = [
    {
      key: "website",
      label: "Website presence",
      all: "Any website status",
      options: WEBSITE_FILTER_OPTIONS,
    },
    {
      key: "vertical",
      label: "Industry",
      all: "All verticals",
      options: VERTICALS.map((v) => ({ value: v, label: VERTICAL_LABEL[v] })),
    },
    { key: "area", label: "Area", all: "All areas", options: options.areas },
    {
      key: "stage",
      label: "Pipeline stage",
      all: "All stages",
      options: STAGES.map((v) => ({ value: v, label: STAGE_LABEL[v] })),
    },
    {
      key: "status",
      label: "Contact status",
      all: "All statuses",
      options: STATUSES.map((v) => ({ value: v, label: statusLabel(v) })),
    },
    { key: "owner", label: "Assigned to", all: "All owners", options: OWNER_FILTER_OPTIONS },
    {
      key: "contact",
      label: "Contact details",
      all: "Any contact details",
      options: CONTACT_FILTER_OPTIONS,
    },
    { key: "pitch", label: "Offer / readiness", all: "All pitches", options: pitchFilterOptions() },
    { key: "source", label: "Source", all: "All sources", options: options.sources },
    { key: "created", label: "Added", all: "Any time", options: CREATED_FILTER_OPTIONS },
    { key: "followup", label: "Follow-up", all: "Any follow-up", options: FOLLOWUP_FILTER_OPTIONS },
  ];
  return (
    <div className="mb-5 rounded-2xl border border-border bg-card p-3 sm:p-4">
      {shortcuts && <div className="mb-4">{shortcuts}</div>}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="min-w-0 flex-1">
          <label htmlFor="lead-workspace-search" className="mb-1.5 block text-sm font-medium">
            Search your leads
          </label>
          <div className="relative">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              id="lead-workspace-search"
              value={filters.q}
              onChange={(e) => set("q", e.target.value)}
              placeholder="Business, suburb, phone, email or #ID"
              maxLength={200}
              className="h-11 pl-10 pr-10 text-sm"
              aria-describedby="lead-search-help"
            />
            {filters.q && (
              <button
                type="button"
                className="ds-interactive absolute right-0 top-0 grid h-11 w-10 place-items-center rounded-lg text-muted-foreground hover:text-foreground"
                onClick={() => set("q", "")}
                aria-label="Clear search"
              >
                <X className="size-4" />
              </button>
            )}
          </div>
        </div>
        <FilterSelect
          label="Sort by"
          value={filters.sort}
          onChange={(v) => set("sort", v as LeadFilters["sort"])}
          options={LEAD_SORT_OPTIONS}
          className="sm:w-48"
        />
      </div>
      <p id="lead-search-help" className="sr-only">
        Search saved records across fields. All words must match; phone formatting doesn’t matter.
        Use Find leads to discover new businesses.
      </p>
      <div className="-mx-2 mt-2">
        <Disclosure
          summary={<span className="font-medium">Filters</span>}
          icon={<SlidersHorizontal className="size-4" />}
          meta={more ? `${more} active` : "Narrow your list"}
          defaultOpen={more > 0}
        >
          <div className="grid gap-6 lg:grid-cols-3">
            {[
              { title: "Business", keys: ["vertical", "area", "source"] },
              { title: "Website & contact", keys: ["website", "contact", "pitch"] },
              {
                title: "Pipeline & timing",
                keys: ["stage", "status", "owner", "created", "followup"],
              },
            ].map((group) => (
              <fieldset key={group.title} className="min-w-0">
                <legend className="mb-3 text-sm font-medium text-foreground">{group.title}</legend>
                <div className="grid gap-3 min-[420px]:grid-cols-2 lg:grid-cols-1">
                  {fields
                    .filter((field) => group.keys.includes(field.key))
                    .map((field) => (
                      <FilterSelect
                        key={field.key}
                        label={field.label}
                        all={field.all}
                        value={String(filters[field.key])}
                        onChange={(v) => set(field.key, v as never)}
                        options={field.options}
                      />
                    ))}
                </div>
              </fieldset>
            ))}
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-3 border-t border-border pt-3">
            <div className="flex min-h-10 items-center gap-2">
              <Switch
                id="verified-only"
                checked={filters.verifiedOnly}
                onCheckedChange={(v) => set("verifiedOnly", v)}
              />
              <Label htmlFor="verified-only" className="text-sm font-normal">
                With verified issue evidence
              </Label>
            </div>
            <div className="flex min-h-10 items-center gap-2">
              <Switch
                id="show-excluded"
                checked={filters.showExcluded}
                onCheckedChange={(v) => set("showExcluded", v)}
              />
              <Label htmlFor="show-excluded" className="text-sm font-normal">
                Include excluded leads
              </Label>
            </div>
          </div>
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
            Recorded confirmation is required for “No website, verified”. Missing URLs and social
            profiles stay separate. Email on file does not mean permission to contact.
          </p>
        </Disclosure>
      </div>
      {active > 0 && (
        <div
          className="mt-2 flex flex-wrap items-center gap-2 border-t border-border pt-3"
          aria-label="Active lead filters"
        >
          {filters.q && <FilterChip label={`Search: ${filters.q}`} onClear={() => set("q", "")} />}
          {fields
            .filter(({ key }) => !!filters[key])
            .map(({ key, label, options }) => (
              <FilterChip
                key={key}
                label={`${label}: ${options.find((o) => o.value === filters[key])?.label ?? filters[key]}`}
                onClear={() => set(key, "" as never)}
              />
            ))}
          {filters.verifiedOnly && (
            <FilterChip
              label="Verified issue evidence"
              onClear={() => set("verifiedOnly", false)}
            />
          )}
          {filters.showExcluded && (
            <FilterChip label="Excluded included" onClear={() => set("showExcluded", false)} />
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setFilters({ ...DEFAULT_LEAD_FILTERS, sort: filters.sort })}
          >
            Clear all
          </Button>
        </div>
      )}
    </div>
  );
}

function FilterChip({ label, onClear }: { label: string; onClear: () => void }) {
  return (
    <button
      type="button"
      onClick={onClear}
      aria-label={`Remove filter: ${label}`}
      className="ds-interactive inline-flex max-w-full items-center gap-2 rounded-lg border border-border bg-inset px-2.5 py-1.5 text-left text-xs text-foreground"
    >
      <span className="min-w-0 break-words">{label}</span>
      <X className="size-3 shrink-0" aria-hidden="true" />
    </button>
  );
}

function FilterSelect({
  label,
  all,
  value,
  onChange,
  options,
  className = "",
}: {
  label: string;
  all?: string;
  value: string;
  onChange: (v: string) => void;
  options: readonly Option[];
  className?: string;
}) {
  const id = useId();
  return (
    <div className={`min-w-0 ${className}`}>
      <label htmlFor={id} className="mb-1.5 block text-xs font-medium text-muted-foreground">
        {label}
      </label>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="ds-interactive h-11 w-full min-w-0 rounded-lg border border-input bg-background px-3 pr-7 text-sm text-foreground"
      >
        {all && <option value="">{all}</option>}
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}
