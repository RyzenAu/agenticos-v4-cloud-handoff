import { useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { Building2, Download, Plus, Upload, Users } from "lucide-react";
import { Button, DataTable, Disclosure, EmptyState, Notice, StatusLabel, Surface, Toolbar, type Column } from "@/components/ds";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { Company, Contact, CrmSnapshot } from "../../../scripts/crm/types";
import type { CsvPreview, CsvResolution } from "../../../scripts/crm/csv";
import { crmErrorMessage, crmOperation, downloadCsv, type CrmReceipt } from "@/lib/crm-client";
import { Field, Modal, NativeSelect, ownerName } from "./controls";
import {
  EMPTY_FILTERS,
  companyLabel,
  filterCompanies,
  matchesSearch,
  type DirectoryFilters,
} from "./selectors";
import type { WorkspaceActions } from "./workspace-views";
import { isNeedsConfirm, retryUnlessNeedsConfirm } from "@/lib/needs-confirm";
import { NeedsConfirmNote } from "@/components/shell/needs-confirm-note";
type SavedView = {
  id: string;
  name: string;
  kind: string;
  filters: Partial<DirectoryFilters>;
  version: number;
};
type Duplicate = { a: Company; b: Company; reasons: string[] };
export function DirectoryView({
  kind,
  snapshot,
  actions,
  onSaved,
}: {
  kind: "companies" | "contacts";
  snapshot: CrmSnapshot;
  actions: WorkspaceActions;
  onSaved: (receipt: CrmReceipt) => void;
}) {
  const [filters, setFilters] = useState<DirectoryFilters>({ ...EMPTY_FILTERS }),
    [dialog, setDialog] = useState<"import" | "duplicates" | "save" | null>(null),
    [error, setError] = useState<string | null>(null),
    [exporting, setExporting] = useState(false),
    [page, setPage] = useState(0);
  const saved = useQuery({
    queryKey: ["crm", "views"],
    queryFn: async () => (await crmOperation<SavedView[]>("crm.views.list", {})).data ?? [],
    retry: (failures, error) => retryUnlessNeedsConfirm(failures, error, 3),
  });
  const set = (patch: Partial<DirectoryFilters>) => {
    setFilters((f) => ({ ...f, ...patch }));
    setPage(0);
  };
  const companies = filterCompanies(snapshot, filters);
  const contacts = snapshot.contacts
    .filter(
      (c) =>
        (!filters.owner || c.owner === filters.owner) &&
        (!filters.restriction ||
          (filters.restriction === "restricted"
            ? c.doNotContact ||
              c.restrictions.length > 0 ||
              snapshot.companies.some(
                (company) =>
                  company.id === c.companyId && (company.doNotContact || company.excluded),
              )
            : !c.doNotContact &&
              !c.restrictions.length &&
              !snapshot.companies.some(
                (company) =>
                  company.id === c.companyId && (company.doNotContact || company.excluded),
              ))) &&
        matchesSearch(
          [
            c.name,
            c.role,
            c.email,
            c.phone,
            snapshot.companies.find((company) => company.id === c.companyId)?.name,
          ],
          filters.search,
        ),
    )
    .sort((a, b) => a.name.localeCompare(b.name, "en-AU"));
  const count = kind === "companies" ? companies.length : contacts.length,
    pageSize = 30,
    offset = Math.min(page * pageSize, Math.max(0, Math.floor((count - 1) / pageSize) * pageSize));
  async function exportRecords() {
    setExporting(true);
    setError(null);
    try {
      const receipt = await crmOperation<{ csv: string; filename: string; count: number }>(
        "crm.csv.export",
        { kind },
      );
      if (!receipt.data) throw new Error("The export response did not contain a file.");
      downloadCsv(receipt.data.csv, receipt.data.filename);
    } catch (e) {
      setError(crmErrorMessage(e));
    } finally {
      setExporting(false);
    }
  }
  const active = [filters.owner, filters.status, filters.restriction].filter(Boolean).length;
  const filtered = Object.values(filters).some(Boolean);
  const savedOptions = saved.data?.filter((v) => v.kind === kind) ?? [];
  const companyName = (id: string) => snapshot.companies.find((c) => c.id === id)?.name || "Company unavailable";
  // R12 rollout: ONE toolbar (search, the filters folded behind "Advanced filters", the count, quiet actions), then ONE compact
  // table. The name opens the record; Edit opens the record's editor drawer.
  const companyColumns: Column<Company>[] = [
    {
      key: "name",
      header: "Company",
      cell: (company) => (
        <>
          <button className="ds-interactive rounded text-left font-medium text-foreground hover:underline" onClick={() => actions.open({ kind: "company", id: company.id })}>
            {companyLabel(company, { short: true })}
          </button>
          <span className="mt-0.5 block text-xs text-muted-foreground">
            {[company.industry, company.locality].filter(Boolean).join(" · ") || "Industry and locality not recorded"}
          </span>
        </>
      ),
    },
    {
      key: "contact",
      header: "Primary contact",
      hideBelow: "md",
      cell: (company) => {
        const primary = snapshot.contacts.find((c) => c.companyId === company.id && c.primary);
        return (
          <>
            <span className="block">{primary?.name || <span className="text-muted-foreground">No primary contact</span>}</span>
            <span className="block break-all text-xs text-muted-foreground">{primary?.email || company.emails[0] || company.phone || "Contact details not recorded"}</span>
          </>
        );
      },
    },
    {
      key: "status",
      header: "Relationship",
      width: "11rem",
      cell: (company) =>
        company.doNotContact || company.excluded ? (
          <StatusLabel state="blocked" size="sm" bare label={company.doNotContact ? "Do not contact" : "Excluded"} />
        ) : (
          <span className="capitalize">{company.status}</span>
        ),
    },
    { key: "owner", header: "Owner", width: "8rem", hideBelow: "lg", cell: (company) => ownerName(company.owner) },
    {
      key: "deals",
      header: "Deals",
      width: "5rem",
      align: "right",
      hideBelow: "lg",
      cell: (company) => snapshot.deals.filter((d) => d.companyId === company.id).length,
    },
    {
      key: "edit",
      header: <span className="sr-only">Edit</span>,
      width: "5rem",
      align: "right",
      cell: (company) => (
        <Button variant="ghost" size="sm" aria-label={`Edit ${companyLabel(company, { short: true })}`} onClick={() => actions.edit({ kind: "company", record: company })}>
          Edit
        </Button>
      ),
    },
  ];
  const contactColumns: Column<Contact>[] = [
    {
      key: "name",
      header: "Contact",
      cell: (contact) => (
        <>
          <button className="ds-interactive rounded text-left font-medium text-foreground hover:underline" onClick={() => actions.open({ kind: "contact", id: contact.id })}>
            {contact.name}
          </button>
          <span className="mt-0.5 block text-xs text-muted-foreground">
            {contact.role || "Role not recorded"}
            {contact.primary ? " · Primary contact" : ""}
          </span>
        </>
      ),
    },
    {
      key: "company",
      header: "Company",
      hideBelow: "md",
      cell: (contact) => (
        <button className="ds-interactive rounded text-left hover:underline" onClick={() => actions.open({ kind: "company", id: contact.companyId })}>
          {companyName(contact.companyId)}
        </button>
      ),
    },
    {
      key: "reach",
      header: "Email / phone",
      cell: (contact) => (
        <>
          <span className="block break-all">{contact.email || <span className="text-muted-foreground">No email recorded</span>}</span>
          <span className="block text-xs text-muted-foreground">{contact.phone || "No phone recorded"}</span>
          {(contact.doNotContact || contact.restrictions.length > 0) && (
            <span className="mt-1 block">
              <StatusLabel state="blocked" size="sm" bare label={contact.doNotContact ? "Do not contact" : contact.restrictions.join(" · ")} />
            </span>
          )}
        </>
      ),
    },
    {
      key: "edit",
      header: <span className="sr-only">Edit</span>,
      width: "5rem",
      align: "right",
      cell: (contact) => (
        <Button variant="ghost" size="sm" aria-label={`Edit ${contact.name}`} onClick={() => actions.edit({ kind: "contact", record: contact })}>
          Edit
        </Button>
      ),
    },
  ];
  const pager = count > pageSize && (
    <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
      <span className="ds-num text-xs text-muted-foreground">
        Showing {offset + 1}–{Math.min(offset + pageSize, count)} of {count}
      </span>
      <div className="flex gap-2">
        <Button variant="ghost" size="sm" disabled={offset === 0} onClick={() => setPage(Math.max(0, page - 1))}>
          Previous
        </Button>
        <Button variant="ghost" size="sm" disabled={offset + pageSize >= count} onClick={() => setPage(page + 1)}>
          Next
        </Button>
      </div>
    </div>
  );
  return (
    <>
      <Toolbar
        label={`${kind === "companies" ? "Company" : "Contact"} filters`}
        search={{
          value: filters.search,
          onChange: (v) => set({ search: v }),
          placeholder: kind === "companies" ? "Name, phone, email or company ID" : "Name, role, phone or email",
          label: `Search ${kind}`,
        }}
        advanced={
          <>
            <NativeSelect className="w-auto" aria-label="Filter by owner" value={filters.owner} onChange={(e) => set({ owner: e.target.value })}>
              <option value="">Both founders</option>
              <option value="usman">Usman</option>
              <option value="mehroz">Mehroz</option>
            </NativeSelect>
            {kind === "companies" && (
              <NativeSelect className="w-auto" aria-label="Filter company relationship" value={filters.status} onChange={(e) => set({ status: e.target.value })}>
                <option value="">All relationships</option>
                <option value="prospect">Prospects</option>
                <option value="client">Clients</option>
                <option value="inactive">Inactive</option>
              </NativeSelect>
            )}
            <NativeSelect className="w-auto" aria-label="Filter contact restrictions" value={filters.restriction} onChange={(e) => set({ restriction: e.target.value })}>
              <option value="">All contact permissions</option>
              <option value="restricted">Restricted / excluded</option>
              <option value="contactable">No recorded restrictions</option>
            </NativeSelect>
            <NativeSelect
              className="w-auto max-w-full"
              aria-label={kind === "companies" ? "Saved companies view" : "Saved contacts view"}
              value=""
              onChange={(e) => {
                const view = saved.data?.find((v) => v.id === e.target.value);
                if (view) {
                  setFilters({ ...EMPTY_FILTERS, ...view.filters });
                  setPage(0);
                }
              }}
            >
              <option value="">Saved views</option>
              {savedOptions.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </NativeSelect>
            <Button variant="ghost" size="sm" onClick={() => setDialog("save")}>
              Save this view
            </Button>
          </>
        }
        advancedActive={active}
        onClearAdvanced={() => set({ owner: "", status: "", restriction: "" })}
        summary={
          <span className="ds-num">
            {count} {kind}
            {filters.search ? " match" : ""}
          </span>
        }
        actions={
          <>
            {filtered && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setFilters({ ...EMPTY_FILTERS });
                  setPage(0);
                }}
              >
                Clear filters
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={() => setDialog("import")}>
              <Upload className="size-4" />
              Import CSV
            </Button>
            <Button variant="outline" size="sm" onClick={() => void exportRecords()} disabled={exporting}>
              <Download className="size-4" />
              {exporting ? "Preparing…" : "Export all"}
            </Button>
            {kind === "companies" && (
              <Button variant="ghost" size="sm" onClick={() => setDialog("duplicates")}>
                Review duplicates
              </Button>
            )}
            {/* The page header owns Add company; on Contacts the header has no primary action and this is it. */}
            {kind === "contacts" && (
              <Button variant="accent" size="sm" onClick={() => actions.edit({ kind: "contact" })}>
                <Plus className="size-4" />
                Add contact
              </Button>
            )}
          </>
        }
      />
      {saved.isError && isNeedsConfirm(saved.error) && <NeedsConfirmNote className="mb-3" unlessBanner />}
      {saved.isError && !isNeedsConfirm(saved.error) && (
        <p className="mb-3 text-sm text-warn">
          Saved views could not load.{" "}
          <button className="underline" onClick={() => void saved.refetch()}>
            Try again
          </button>
        </p>
      )}
      {error && (
        <Notice tone="danger" className="mb-5">
          {error}
        </Notice>
      )}
      {!count ? (
        <EmptyState
          icon={kind === "companies" ? Building2 : Users}
          title={filtered ? "No matching records" : `No ${kind} yet`}
          body={
            filtered
              ? "Try a shorter search or clear a filter. Existing records have not changed."
              : `Add your first ${kind === "companies" ? "company" : "contact"} manually, or preview a founder-supplied CSV.`
          }
        />
      ) : kind === "companies" ? (
        <>
          <DataTable caption="Companies" columns={companyColumns} rows={companies.slice(offset, offset + pageSize)} rowKey={(c) => c.id} data-testid="crm-directory" />
          {pager}
        </>
      ) : (
        <>
          <DataTable caption="Contacts" columns={contactColumns} rows={contacts.slice(offset, offset + pageSize)} rowKey={(c) => c.id} data-testid="crm-directory" />
          {pager}
        </>
      )}
      {dialog === "import" && (
        <CsvImport
          kind={kind}
          onClose={() => setDialog(null)}
          onSaved={(receipt) => {
            setDialog(null);
            onSaved(receipt);
          }}
        />
      )}
      {dialog === "duplicates" && (
        <DuplicateReview actions={actions} onClose={() => setDialog(null)} onSaved={onSaved} />
      )}
      {dialog === "save" && (
        <SaveView
          kind={kind}
          filters={filters}
          onClose={() => setDialog(null)}
          onSaved={(receipt) => {
            setDialog(null);
            void saved.refetch();
            onSaved(receipt);
          }}
        />
      )}
    </>
  );
}
function SaveView({
  kind,
  filters,
  onClose,
  onSaved,
}: {
  kind: "companies" | "contacts";
  filters: DirectoryFilters;
  onClose: () => void;
  onSaved: (receipt: CrmReceipt) => void;
}) {
  const [name, setName] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onSaved(
        await crmOperation("crm.views.save", {
          name,
          kind,
          filters: Object.fromEntries(Object.entries(filters).filter(([, v]) => v)),
        }),
      );
    } catch (e) {
      setError(crmErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Save this view"
      description="Both founders can reopen this set of search and filter choices."
      onClose={onClose}
      busy={busy}
    >
      <form className="space-y-5" onSubmit={submit}>
        {error && <Notice tone="danger">{error}</Notice>}
        <Field label="View name">
          <Input required value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <div className="flex justify-end gap-2">
          <Button variant="outline" type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="accent" disabled={busy}>
            {busy ? "Saving…" : "Save view"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
export function CsvImport({
  kind,
  onClose,
  onSaved,
}: {
  kind: "companies" | "contacts";
  onClose: () => void;
  onSaved: (receipt: CrmReceipt) => void;
}) {
  const [csv, setCsv] = useState(""),
    [preview, setPreview] = useState<CsvPreview | null>(null),
    [decisions, setDecisions] = useState<Record<number, string>>({}),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null),
    [page, setPage] = useState(0);
  async function inspect() {
    setBusy(true);
    setError(null);
    try {
      const receipt = await crmOperation<CsvPreview>("crm.csv.preview", { csv, kind });
      if (!receipt.data) throw new Error("Preview was not returned.");
      setPreview(receipt.data);
      setDecisions(
        Object.fromEntries(
          receipt.data.rows.map((row) => [
            row.row,
            row.errors.length ? "skip" : row.conflicts.length ? "" : "create",
          ]),
        ),
      );
      setPage(0);
    } catch (e) {
      setError(crmErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function commit() {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      const resolutions: CsvResolution[] = preview.rows.map((row) => {
        const selected = decisions[row.row];
        if (selected.startsWith("update:")) {
          const match = row.conflicts.find((c) => c.id === selected.slice(7));
          if (!match) throw new Error("Choose a current matching record for each update.");
          return {
            row: row.row,
            action: "update",
            recordId: match.id,
            expectedVersion: match.version,
          };
        }
        return { row: row.row, action: selected as "create" | "skip" };
      });
      onSaved(await crmOperation("crm.csv.commit", { previewId: preview.id, resolutions }));
    } catch (e) {
      setError(crmErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={`Import ${kind}`}
      description="Preview and choose conflict resolutions before any business record changes."
      onClose={onClose}
      busy={busy}
    >
      <div className="space-y-5">
        {error && (
          <Notice tone="danger" title="Import needs attention">
            {error}
          </Notice>
        )}
        <p className="text-sm text-muted-foreground">
          Use founder-supplied records only. Do not import transient Google Places fields into
          permanent CRM storage. Maximum 2 MiB and 5,000 rows. Existing opt-outs are retained.
        </p>
        {!preview ? (
          <>
            <Field label="Choose a CSV file">
              <Input
                type="file"
                accept=".csv,text/csv"
                disabled={busy}
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  if (file.size > 2 * 1024 * 1024) {
                    setError("Choose a CSV smaller than 2 MiB.");
                    return;
                  }
                  try {
                    setCsv(await file.text());
                    setError(null);
                  } catch {
                    setError("Could not read that file. Try selecting it again.");
                  }
                }}
              />
            </Field>
            <Field
              label="CSV content"
              hint={
                kind === "companies"
                  ? "Headers: name,industry,website,locality,timezone,email,phone,owner,tags,notes,optedOut"
                  : "Headers: companyId,name,role,email,phone,primary,preferences,optedOut,owner"
              }
            >
              <Textarea
                rows={9}
                value={csv}
                onChange={(e) => setCsv(e.target.value)}
                placeholder={
                  kind === "companies" ? "name,industry,email,owner" : "companyId,name,role,email"
                }
                className="font-mono"
              />
            </Field>
            <Button variant="accent" disabled={busy || !csv.trim()} onClick={() => void inspect()}>
              {busy ? "Validating…" : "Preview and validate"}
            </Button>
          </>
        ) : (
          <>
            <div className="flex flex-wrap gap-4 text-sm">
              <span>{preview.rows.length} rows</span>
              <span>{preview.invalid} invalid</span>
              <span>{preview.conflicts} with possible matches</span>
            </div>
            <div className="max-h-[45dvh] overflow-auto rounded-xl border border-border">
              <table className="w-full min-w-[500px] text-left text-sm">
                <thead className="bg-inset">
                  <tr>
                    <th className="p-3 font-medium">Record</th>
                    <th className="p-3 font-medium">Validation / conflicts</th>
                    <th className="p-3 font-medium">Decision</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {preview.rows.slice(page * 25, (page + 1) * 25).map((row) => (
                    <tr key={row.row}>
                      <td className="p-3 align-top">
                        <p className="font-medium">{row.values.name || `Row ${row.row}`}</p>
                        {row.values.name && (
                          <p className="text-[13px] text-muted-foreground">Row {row.row}</p>
                        )}
                        <p className="break-all text-[13px] text-muted-foreground">
                          {row.values.email || row.values.phone || row.values.locality}
                        </p>
                      </td>
                      <td className="p-3 align-top">
                        <p className={row.errors.length ? "text-warn" : "text-muted-foreground"}>
                          {row.errors.join("; ") ||
                            row.conflicts.map((c) => `${c.label}: ${c.reason}`).join("; ") ||
                            "Ready to create"}
                        </p>
                      </td>
                      <td className="p-3 align-top">
                        <NativeSelect
                          aria-label={`Import decision for row ${row.row}`}
                          value={decisions[row.row] ?? ""}
                          onChange={(e) =>
                            setDecisions((d) => ({ ...d, [row.row]: e.target.value }))
                          }
                        >
                          <option value="">Choose action</option>
                          <option value="skip">Skip</option>
                          {!row.errors.length && <option value="create">Create new record</option>}
                          {!row.errors.length &&
                            row.conflicts
                              .filter((c) => c.version > 0)
                              .map((c) => (
                                <option value={`update:${c.id}`} key={c.id}>
                                  Update {c.label}
                                </option>
                              ))}
                        </NativeSelect>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {preview.rows.length > 25 && (
              <div className="flex items-center justify-between text-sm">
                <Button variant="ghost" disabled={page === 0} onClick={() => setPage(page - 1)}>
                  Previous
                </Button>
                <span>
                  Page {page + 1} of {Math.ceil(preview.rows.length / 25)}
                </span>
                <Button
                  variant="ghost"
                  disabled={(page + 1) * 25 >= preview.rows.length}
                  onClick={() => setPage(page + 1)}
                >
                  Next
                </Button>
              </div>
            )}
            <p className="text-sm text-muted-foreground">
              Review matching records before updating. If a record changes while this preview is
              open, the import stops with a conflict.
            </p>
            <div className="flex flex-wrap justify-between gap-2">
              <Button variant="outline" disabled={busy} onClick={() => setPreview(null)}>
                Edit CSV
              </Button>
              <Button
                variant="accent"
                disabled={busy || preview.rows.some((r) => !decisions[r.row])}
                onClick={() => void commit()}
              >
                {busy ? "Importing…" : "Import reviewed rows"}
              </Button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
function DuplicateReview({
  actions,
  onClose,
  onSaved,
}: {
  actions: WorkspaceActions;
  onClose: () => void;
  onSaved: (receipt: CrmReceipt) => void;
}) {
  const query = useQuery({
    queryKey: ["crm", "duplicates"],
    queryFn: async () => (await crmOperation<Duplicate[]>("crm.duplicates.list", {})).data ?? [],
  });
  const [selection, setSelection] = useState<Duplicate | null>(null),
    [keep, setKeep] = useState(""),
    [confirmed, setConfirmed] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  async function merge() {
    if (!selection || !confirmed) return;
    setBusy(true);
    setError(null);
    const survivor = keep === selection.a.id ? selection.a : selection.b,
      source = keep === selection.a.id ? selection.b : selection.a;
    try {
      const receipt = await crmOperation("crm.duplicates.merge", {
        keepId: survivor.id,
        mergeId: source.id,
        expectedKeepVersion: survivor.version,
        expectedMergeVersion: source.version,
      });
      onSaved(receipt);
      setSelection(null);
      setConfirmed(false);
      void query.refetch();
    } catch (e) {
      setError(crmErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Review possible duplicates"
      description="Matches are suggestions. Compare the records before choosing which company to keep."
      onClose={onClose}
      busy={busy}
    >
      <div className="space-y-4">
        {error && <Notice tone="danger">{error}</Notice>}
        {query.isPending ? (
          <p role="status" className="text-sm">
            Checking shared company records…
          </p>
        ) : query.isError ? (
          <Notice
            tone="danger"
            action={
              <Button variant="outline" onClick={() => void query.refetch()}>
                Retry
              </Button>
            }
          >
            Could not load duplicate candidates.
          </Notice>
        ) : !query.data?.length ? (
          <EmptyState
            variant="row"
            title="No likely duplicates found"
            body="Matching checks compare company name and locality, email and phone."
          />
        ) : (
          query.data.map((pair) => (
            <div key={`${pair.a.id}:${pair.b.id}`} className="rounded-xl border border-border p-4">
              <p className="font-medium">
                {companyLabel(pair.a)} / {companyLabel(pair.b)}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">{pair.reasons.join(" · ")}</p>
              <Button
                className="mt-2"
                variant="outline"
                onClick={() => {
                  setSelection(pair);
                  setKeep(pair.a.id);
                  setConfirmed(false);
                }}
              >
                Compare records
              </Button>
            </div>
          ))
        )}
        {selection && (
          <Surface variant="inset" padding="sm">
            <h3 className="text-base font-medium">Choose the surviving company</h3>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              {[selection.a, selection.b].map((company) => (
                <label key={company.id} className="flex items-start gap-3 text-sm">
                  <input
                    className="mt-1 size-4 shrink-0"
                    type="radio"
                    name="surviving-company"
                    value={company.id}
                    checked={keep === company.id}
                    onChange={() => {
                      setKeep(company.id);
                      setConfirmed(false);
                    }}
                  />
                  <span className="min-w-0">
                    <span className="font-medium">{companyLabel(company)}</span>
                    <span className="mt-1 block text-muted-foreground">
                      {company.locality || "No locality"}
                    </span>
                    <span className="block break-all text-muted-foreground">
                      {company.phone || "No phone"}
                      <br />
                      {company.emails.join(", ") || "No email"}
                    </span>
                    <span className="mt-2 block text-[13px] text-muted-foreground">
                      {ownerName(company.owner)} · Version {company.version}
                      {company.doNotContact ? " · Do not contact" : ""}
                    </span>
                  </span>
                </label>
              ))}
            </div>
            <p className="mt-4 text-sm text-muted-foreground">
              Linked records and history move to the survivor. The source is retained as a merged
              record. Restrictions are preserved.
            </p>
            <label className="mt-4 flex items-start gap-3 text-sm">
              <input
                type="checkbox"
                className="mt-1 size-4"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
              />
              I checked both records and they represent the same company
            </label>
            <Button
              className="mt-4"
              variant="accent"
              disabled={!confirmed || busy}
              onClick={() => void merge()}
            >
              {busy ? "Merging…" : "Merge reviewed companies"}
            </Button>
          </Surface>
        )}
      </div>
    </Modal>
  );
}
