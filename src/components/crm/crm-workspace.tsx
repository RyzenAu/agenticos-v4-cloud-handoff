import { useMemo, useRef, useState } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Plus, RefreshCw } from "lucide-react";
import {
  Button,
  EmptyState,
  Notice,
  PageHeader,
  PageSkeleton,
  Tabs,
  TabPanel,
} from "@/components/ds";
import { usePageContext } from "@/components/shell/page-context";
import type { CrmRef, Pipeline } from "../../../scripts/crm/types";
import {
  CRM_QUERY_KEY,
  crmErrorMessage,
  crmOperation,
  useCrmSnapshot,
  type CrmReceipt,
  type CrmOperationName,
  type CrmOperationInputMap,
} from "@/lib/crm-client";
import { crmRefString, parseCrmRef } from "@/lib/crm-ref";
import { crmHref } from "@/lib/crm-links";
import { fmtDateTime } from "@/lib/format";
import { CompanyWorkspace } from "./company-workspace";
import { DirectoryView } from "./directory";
import { PipelineEditor, RecordEditor, type EditorTarget } from "./record-editor";
import { TodayView, PipelineView, type WorkspaceActions } from "./workspace-views";
import {
  companyForRef,
  validateCrmSearch,
  type CrmSearch,
  type CrmTab,
  type CrmView,
} from "./selectors";

export function CrmWorkspace() {
  const rawSearch = useSearch({ strict: false }) as Record<string, unknown>,
    search = validateCrmSearch(rawSearch),
    view = search.view ?? "today",
    tab = search.tab ?? "overview";
  const navigate = useNavigate(),
    queryClient = useQueryClient(),
    query = useCrmSnapshot(),
    snapshot = query.data;
  const selectedRef = search.ref ? parseCrmRef(search.ref) : null,
    company = snapshot ? companyForRef(snapshot, selectedRef) : undefined;
  const [editor, setEditor] = useState<EditorTarget | null>(null),
    [pipelineEditor, setPipelineEditor] = useState<Pipeline | null>(null),
    [receipt, setReceipt] = useState<CrmReceipt | null>(null),
    [error, setError] = useState<string | null>(null),
    [busy, setBusy] = useState(false);
  const running = useRef(false);
  function route(patch: Partial<CrmSearch>, replace = false) {
    void navigate({
      to: "/crm",
      search: (previous: CrmSearch) => ({ ...previous, ...patch }),
      replace,
    } as never);
  }
  function open(ref: CrmRef, nextTab?: CrmTab) {
    route({
      ref: crmRefString(ref),
      tab:
        nextTab ??
        (ref.kind === "deal" ? "deals" : ref.kind === "project" ? "delivery" : "overview"),
    });
    setReceipt(null);
    setError(null);
  }
  function saved(next: CrmReceipt) {
    setReceipt(next);
    setError(null);
    setEditor(null);
    setPipelineEditor(null);
    void queryClient.invalidateQueries({ queryKey: CRM_QUERY_KEY });
  }
  async function run<N extends CrmOperationName>(name: N, input: CrmOperationInputMap[N]) {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError(null);
    try {
      saved(await crmOperation(name, input));
    } catch (error) {
      setError(crmErrorMessage(error));
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  const actions: WorkspaceActions = { edit: setEditor, open, run, busy };
  usePageContext("crm-workspace", {
    crm:
      company && selectedRef
        ? selectedRef.kind === "company" || selectedRef.kind === "lead"
          ? { kind: "company", id: company.id }
          : selectedRef
        : null,
    selection: company
      ? {
          kind: "client",
          id: company.id,
          label: company.name,
          to: "/crm",
          search: { ref: crmRefString({ kind: "company", id: company.id }), tab },
          source: "Authoritative CRM",
        }
      : null,
    visible: [], // Directory filters are local; do not claim hidden records are on screen.
    sources: [
      {
        id: "crm",
        label: "Shared CRM",
        state: query.isError ? "failed" : snapshot ? "live" : "unknown",
        source: "/__crm/snapshot",
        lastSuccess: snapshot?.generatedAt ?? null,
        reason: query.isError ? "CRM refresh failed; existing data may be stale." : undefined,
      },
    ],
  });
  if (query.isPending) return <PageSkeleton label="Loading shared CRM" rows={5} />;
  if (!snapshot)
    return (
      <>
        <PageHeader
          title="CRM"
          description="The shared workspace for prospects, clients and delivery"
        />
        <Notice
          tone="danger"
          title="CRM could not load"
          action={
            <Button variant="outline" onClick={() => void query.refetch()}>
              Try again
            </Button>
          }
        >
          {crmErrorMessage(query.error)} No sample or guessed records are shown.
        </Notice>
      </>
    );
  return (
    <div className="min-w-0" data-testid="crm-workspace">
      {selectedRef && (
        <Button
          className="mb-4 -ml-3"
          variant="ghost"
          onClick={() => route({ ref: undefined, tab: undefined })}
        >
          <ArrowLeft className="size-4" />
          Back to {view}
        </Button>
      )}
      <PageHeader
        title={company?.name ?? "CRM"}
        description={
          company
            ? undefined
            : "Prospects, client commitments and delivery, in one shared workspace"
        }
        meta={
          <>
            <span>
              {company
                ? `${company.timezone} · Shared with both founders`
                : fmtDateTime(snapshot.generatedAt, { timeZone: "Australia/Sydney" })}
            </span>
            <span>{query.isFetching ? "Refreshing…" : "Saved CRM records"}</span>
          </>
        }
        actions={
          <>
            <Button
              variant="outline"
              onClick={() => void query.refetch()}
              disabled={query.isFetching}
              aria-label="Refresh CRM"
            >
              <RefreshCw className="size-4" />
              Refresh
            </Button>
            {company ? (
              <Button
                variant="accent"
                onClick={() => setEditor({ kind: "task", companyId: company.id })}
              >
                <Plus className="size-4" />
                Add task
              </Button>
            ) : (
              <Button variant="accent" onClick={() => setEditor({ kind: "company" })}>
                <Plus className="size-4" />
                Add company
              </Button>
            )}
          </>
        }
      />
      {query.isError && (
        <Notice
          tone="warn"
          className="mb-5"
          title="Showing the last loaded records"
          action={
            <Button variant="outline" onClick={() => void query.refetch()}>
              Retry refresh
            </Button>
          }
        >
          The latest CRM refresh failed. Open forms have been kept; check the connection before
          saving.
        </Notice>
      )}
      {error && (
        <Notice
          tone="danger"
          className="mb-5"
          title="Change not confirmed"
          action={
            <Button variant="outline" onClick={() => void query.refetch()}>
              Refresh records
            </Button>
          }
        >
          {error}
        </Notice>
      )}
      {receipt && (
        <Notice
          tone="success"
          className="mb-5"
          title={receipt.text}
          action={
            <Button variant="ghost" size="sm" onClick={() => setReceipt(null)}>
              Dismiss
            </Button>
          }
        >
          {receipt.href && (
            <a href={receipt.href} className="underline underline-offset-4">
              Open saved record ↗
            </a>
          )}
        </Notice>
      )}
      <div hidden={!!selectedRef}>
        <Tabs
          idBase="crm-view"
          label="CRM workspace"
          value={view}
          className="mb-8"
          onChange={(next) => route({ view: next, ref: undefined, tab: undefined })}
          tabs={[
            { id: "today", label: "Today" },
            { id: "pipeline", label: "Pipeline" },
            { id: "companies", label: "Companies" },
            { id: "contacts", label: "Contacts" },
          ]}
        />
        <TabPanel idBase="crm-view" id="today" active={view === "today"}>
          <TodayView snapshot={snapshot} actions={actions} />
        </TabPanel>
        <TabPanel idBase="crm-view" id="pipeline" active={view === "pipeline"}>
          <PipelineView snapshot={snapshot} actions={actions} configure={setPipelineEditor} />
        </TabPanel>
        <TabPanel idBase="crm-view" id="companies" active={view === "companies"}>
          <DirectoryView kind="companies" snapshot={snapshot} actions={actions} onSaved={saved} />
        </TabPanel>
        <TabPanel idBase="crm-view" id="contacts" active={view === "contacts"}>
          <DirectoryView kind="contacts" snapshot={snapshot} actions={actions} onSaved={saved} />
        </TabPanel>
      </div>
      {selectedRef &&
        (company ? (
          <CompanyWorkspace
            key={company.id}
            company={company}
            snapshot={snapshot}
            selectedId={selectedRef.id}
            tab={tab}
            setTab={(next) => route({ tab: next }, true)}
            actions={actions}
            onSaved={saved}
          />
        ) : (
          <EmptyState
            title="This record is not available"
            body="It may have been merged or the link may be out of date. Refresh, or return to the company list to find it."
            action={
              <Button
                variant="outline"
                onClick={() => route({ ref: undefined, tab: undefined, view: "companies" })}
              >
                Open companies
              </Button>
            }
          />
        ))}
      {editor && (
        <RecordEditor
          key={`${editor.kind}:${editor.record?.id ?? "new"}`}
          target={editor}
          snapshot={snapshot}
          onClose={() => setEditor(null)}
          onSaved={saved}
        />
      )}
      {pipelineEditor && (
        <PipelineEditor
          pipeline={pipelineEditor}
          onClose={() => setPipelineEditor(null)}
          onSaved={saved}
        />
      )}
      <footer className="mt-12 border-t border-border pt-5 text-xs text-muted-foreground">
        CRM is authoritative for current business records. Memory and research provide context.
        Receptionist development remains on hold.
      </footer>
    </div>
  );
}
