import { resultLinkProps } from "@/lib/dot-gateway";
import { useRef, useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, ArrowUpRight, Building2, Check, FileText, Plus } from "lucide-react";
import {
  Button,
  Disclosure,
  EmptyState,
  Notice,
  Section,
  Surface,
  Tabs,
  TabPanel,
  StatusLabel,
  type StatusState,
} from "@/components/ds";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type {
  Activity,
  Company,
  CrmSnapshot,
  Deal,
  Document,
  Project,
} from "../../../scripts/crm/types";
import { artifactHref } from "@/lib/crm-links";
import { crmErrorMessage, crmOperation, getCrmRecord, type CrmReceipt } from "@/lib/crm-client";
import { fmtDateTime, fmtDay } from "@/lib/format";
import { plural } from "@/lib/plural";
import { fetchJob, JOB_STATE_LABEL } from "@/lib/job-events";
import { Field, Modal, NativeSelect, ExternalLink, ownerName, SaveActions } from "./controls";
import {
  isOpenTask,
  pricingPending,
  localDateTime,
  dateTimeValue,
  sentence,
  stageForDeal,
  taskOrder,
  type CrmTab,
} from "./selectors";
import { TaskRows, money, type WorkspaceActions } from "./workspace-views";
import { ActivityEditor, DocumentVersionEditor } from "./record-editor";
import { CrmFinancePanel } from "./finance-panel";
import { WorkflowJourney } from "./workflow-journey";

export function CompanyWorkspace({
  company,
  snapshot,
  tab,
  setTab,
  actions,
  onSaved,
  selectedId,
}: {
  company: Company;
  snapshot: CrmSnapshot;
  tab: CrmTab;
  setTab: (tab: CrmTab) => void;
  actions: WorkspaceActions;
  onSaved: (receipt: CrmReceipt) => void;
  selectedId?: string;
}) {
  const contacts = snapshot.contacts
    .filter((c) => c.companyId === company.id)
    .sort((a, b) => Number(b.primary) - Number(a.primary) || a.name.localeCompare(b.name, "en-AU"));
  const deals = snapshot.deals.filter((d) => d.companyId === company.id),
    projects = snapshot.projects.filter((p) => p.companyId === company.id),
    documents = snapshot.documents.filter((d) => d.companyId === company.id),
    tasks = snapshot.tasks.filter((t) => t.companyId === company.id).sort(taskOrder),
    activities = snapshot.activities
      .filter((a) => a.companyId === company.id)
      .sort((a, b) => b.at.localeCompare(a.at));
  const [activityOpen, setActivityOpen] = useState(false),
    [versionDoc, setVersionDoc] = useState<Document | null>(null),
    [milestoneProject, setMilestoneProject] = useState<Project | null>(null);
  return (
    <>
      {(company.doNotContact || company.excluded) && (
        <Notice
          tone="warn"
          className="mb-5"
          title={company.doNotContact ? "Do not contact" : "Excluded from prospecting"}
        >
          {company.excludedReason ||
            "This restriction applies to the company. Review individual contact preferences before any communication."}
        </Notice>
      )}
      <Surface className="mb-6">
        <div className="grid min-w-0 gap-6 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
          <div>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold">Contact details</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  {[company.locality, company.industry].filter(Boolean).join(" · ") ||
                    "Company details not recorded"}
                </p>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => actions.edit({ kind: "company", record: company })}
              >
                Edit company
              </Button>
            </div>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <div>
                <p className="text-[13px] text-muted-foreground">Phone</p>
                <p className="mt-1 text-sm break-all">{company.phone || "Not recorded"}</p>
              </div>
              <div>
                <p className="text-[13px] text-muted-foreground">Email</p>
                <p className="mt-1 text-sm break-all">
                  {company.emails.join(", ") || "Not recorded"}
                </p>
              </div>
              <div>
                <p className="text-[13px] text-muted-foreground">Website</p>
                <div className="mt-1">
                  {company.website ? (
                    <ExternalLink href={company.website}>
                      {company.website.replace(/^https?:\/\//, "")}
                    </ExternalLink>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      {company.websiteCheck === "none-verified"
                        ? "Verified no website"
                        : company.websiteCheck === "check-failed"
                          ? "Website check failed"
                          : company.websiteCheck === "search-unavailable"
                            ? "Website search unavailable"
                            : "Not checked"}
                    </p>
                  )}
                </div>
              </div>
              <div>
                <p className="text-[13px] text-muted-foreground">Responsible founder</p>
                <p className="mt-1 text-sm">
                  {ownerName(company.owner)} · {company.status}
                </p>
              </div>
            </div>
          </div>
          <div className="min-w-0 lg:border-l lg:border-border lg:pl-6">
            <div className="mb-4 flex items-center justify-between gap-3">
              <h2 className="text-lg font-semibold">Next actions</h2>
            </div>
            {tasks.filter(isOpenTask).length ? (
              <TaskRows
                tasks={tasks.filter(isOpenTask).slice(0, 3)}
                snapshot={snapshot}
                actions={actions}
                compact
              />
            ) : (
              <p className="text-sm text-muted-foreground">
                No open tasks. Record the next follow-up, promise or delivery commitment.
              </p>
            )}
            {deals
              .filter(
                (deal) => deal.nextAction && stageForDeal(snapshot, deal)?.category === "open",
              )
              .slice(0, 2)
              .map((deal) => (
                <div key={deal.id} className="mt-4 border-t border-border pt-3">
                  <button
                    className="ds-interactive rounded text-left text-sm font-medium hover:underline"
                    onClick={() => actions.edit({ kind: "deal", record: deal })}
                  >
                    {deal.nextAction}
                  </button>
                  <p className="mt-1 text-[13px] text-muted-foreground">
                    {deal.title} · {fmtDay(deal.nextActionDue, { timeZone: company.timezone })} ·{" "}
                    {ownerName(deal.owner)}
                  </p>
                </div>
              ))}
          </div>
        </div>
      </Surface>
      <WorkflowJourney
        company={company}
        snapshot={snapshot}
        selectedId={selectedId}
        actions={actions}
      />
      <Tabs
        idBase="crm-company"
        label="Company workspace"
        className="mb-6"
        value={tab}
        onChange={setTab}
        tabs={[
          { id: "overview", label: "Overview" },
          { id: "timeline", label: "Timeline" },
          { id: "deals", label: "Deals", count: deals.length },
          { id: "delivery", label: "Delivery", count: projects.length },
        ]}
      />
      <TabPanel idBase="crm-company" id="overview" active={tab === "overview"}>
        <div className="grid min-w-0 gap-8 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
          <div className="min-w-0">
            <Section
              title="People"
              actions={
                <Button
                  variant="outline"
                  onClick={() => actions.edit({ kind: "contact", companyId: company.id })}
                >
                  <Plus className="size-4" />
                  Add contact
                </Button>
              }
            >
              {contacts.length ? (
                <Surface padding="none">
                  <ul className="divide-y divide-border">
                    {contacts.map((contact) => (
                      <li
                        id={`crm-contact-${contact.id}`}
                        key={contact.id}
                        className={`p-5 ${selectedId === contact.id ? "bg-surface-raised" : ""}`}
                      >
                        <div className="flex min-w-0 items-start justify-between gap-3">
                          <div className="min-w-0">
                            <h3 className="text-base font-medium">{contact.name}</h3>
                            <p className="mt-1 text-sm text-muted-foreground">
                              {contact.role || "Role not recorded"}
                              {contact.primary ? " · Primary contact" : ""}
                            </p>
                            <p className="mt-3 break-all text-sm">
                              {[contact.email, contact.phone].filter(Boolean).join(" · ") ||
                                "No contact details recorded"}
                            </p>
                            {contact.preferences && (
                              <p className="mt-2 text-sm text-muted-foreground">
                                {contact.preferences}
                              </p>
                            )}
                            {(contact.doNotContact || contact.restrictions.length > 0) && (
                              <p className="mt-2 text-sm text-warn">
                                {[
                                  contact.doNotContact ? "Do not contact" : "",
                                  ...contact.restrictions,
                                ]
                                  .filter(Boolean)
                                  .join(" · ")}
                              </p>
                            )}
                          </div>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => actions.edit({ kind: "contact", record: contact })}
                          >
                            Edit
                          </Button>
                        </div>
                      </li>
                    ))}
                  </ul>
                </Surface>
              ) : (
                <EmptyState
                  variant="row"
                  title="No contacts yet"
                  body="Add each person separately and choose a primary contact."
                />
              )}
            </Section>
            <Section title="Tasks and promises">
              {tasks.length ? (
                <Surface>
                  <TaskRows tasks={tasks} snapshot={snapshot} actions={actions} />
                </Surface>
              ) : (
                <EmptyState
                  variant="row"
                  title="No commitments recorded"
                  body="Tasks say what must happen next. The timeline records what already happened."
                />
              )}
            </Section>
            <Section title="Internal notes">
              {company.notes ? (
                <Surface>
                  <p className="whitespace-pre-wrap text-sm">{company.notes}</p>
                </Surface>
              ) : (
                <EmptyState
                  variant="row"
                  title="No internal notes"
                  action={
                    <Button
                      variant="ghost"
                      onClick={() =>
                        actions.edit({ kind: "company", record: company, focus: "notes" })
                      }
                    >
                      Add notes
                    </Button>
                  }
                />
              )}
            </Section>
          </div>
          <div className="min-w-0">
            <Section
              title="Documents"
              actions={
                <Button
                  variant="outline"
                  onClick={() => actions.edit({ kind: "document", companyId: company.id })}
                >
                  Add document
                </Button>
              }
            >
              <Documents
                panel="overview"
                documents={documents}
                actions={actions}
                newVersion={setVersionDoc}
              />
            </Section>
            <CrmFinancePanel companyId={company.id} />
            <Section title="Connected work">
              <Surface padding="sm">
                <div className="space-y-4">
                  <div>
                    <a
                      className="ds-interactive rounded text-sm font-medium underline underline-offset-4"
                      href="/inbox"
                    >
                      Open Inbox ↗
                    </a>
                    <p className="mt-1 text-[13px] text-muted-foreground">
                      Direct email access requires a configured mailbox and its own permissions. CRM
                      does not verify a sending connection.
                    </p>
                  </div>
                  <div>
                    <a
                      className="ds-interactive rounded text-sm font-medium underline underline-offset-4"
                      href="/calendar"
                    >
                      Open Calendar ↗
                    </a>
                    <p className="mt-1 text-[13px] text-muted-foreground">
                      Meeting invitations require a writable calendar and review. Link an existing
                      meeting in the timeline.
                    </p>
                  </div>
                  <div>
                    <a
                      className="ds-interactive rounded text-sm font-medium underline underline-offset-4"
                      href="/finance"
                    >
                      Open Finance ↗
                    </a>
                    <p className="mt-1 text-[13px] text-muted-foreground">
                      Finance owns invoices and payment status. No payment is inferred from a won
                      deal.
                    </p>
                  </div>
                </div>
              </Surface>
            </Section>
            <Disclosure
              summary="Research, provenance and technical evidence"
              className="rounded-2xl border border-border"
              meta={`Version ${company.version}`}
            >
              <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-3 text-sm">
                <dt className="text-muted-foreground">Source</dt>
                <dd className="break-words">
                  {company.source.kind}
                  {company.source.reference ? ` · ${company.source.reference}` : ""}
                </dd>
                <dt className="text-muted-foreground">Attribution</dt>
                <dd>{company.source.attribution || "Not recorded"}</dd>
                <dt className="text-muted-foreground">Website check</dt>
                <dd>
                  {sentence(company.websiteCheck)}
                  {company.websiteCheckedAt ? ` · ${fmtDateTime(company.websiteCheckedAt)}` : ""}
                </dd>
                <dt className="text-muted-foreground">Time zone</dt>
                <dd>{company.timezone}</dd>
                <dt className="text-muted-foreground">Last updated</dt>
                <dd>{fmtDateTime(company.updatedAt)}</dd>
                <dt className="text-muted-foreground">Record ID</dt>
                <dd className="break-all font-mono text-[13px]">{company.id}</dd>
                {company.legacyLeadId != null && (
                  <>
                    <dt className="text-muted-foreground">Original lead</dt>
                    <dd>
                      <a className="underline" href={`/leads?lead=${company.legacyLeadId}`}>
                        Lead {company.legacyLeadId} ↗
                      </a>
                    </dd>
                  </>
                )}
              </dl>
              {Object.keys(company.fieldSources).length > 0 && (
                <div className="mt-4 border-t border-border pt-3">
                  <h3 className="mb-2 text-sm font-medium">Field provenance</h3>
                  {Object.entries(company.fieldSources).map(([field, source]) => (
                    <p key={field} className="break-words text-[13px] text-muted-foreground">
                      {field}: {source}
                    </p>
                  ))}
                </div>
              )}
            </Disclosure>
          </div>
        </div>
      </TabPanel>
      <TabPanel idBase="crm-company" id="timeline" active={tab === "timeline"}>
        <Section
          title="Timeline"
          description="Recorded events, call outcomes, linked threads and saved agent results"
          actions={
            <Button variant="accent" onClick={() => setActivityOpen(true)}>
              <Plus className="size-4" />
              Log activity
            </Button>
          }
        >
          {activities.length ? (
            <Surface>
              <ol className="divide-y divide-border">
                {activities.map((activity) => (
                  <ActivityRow key={activity.id} activity={activity} timezone={company.timezone} />
                ))}
              </ol>
            </Surface>
          ) : (
            <EmptyState
              icon={FileText}
              title="No activity recorded"
              body="Log a call outcome, note, meeting or linked email thread. Retried events use stable IDs to avoid duplicate history."
            />
          )}
        </Section>
      </TabPanel>
      <TabPanel idBase="crm-company" id="deals" active={tab === "deals"}>
        <Section
          title="Opportunities"
          actions={
            <Button
              variant="accent"
              onClick={() => actions.edit({ kind: "deal", companyId: company.id })}
            >
              <Plus className="size-4" />
              Add deal
            </Button>
          }
        >
          {deals.length ? (
            <div className="space-y-5">
              {deals.map((deal) => (
                <DealDetails
                  key={deal.id}
                  deal={deal}
                  snapshot={snapshot}
                  actions={actions}
                  selected={selectedId === deal.id}
                />
              ))}
            </div>
          ) : (
            <EmptyState
              title="No deals yet"
              body="Create an opportunity with its own scope, owner, contacts and next action."
            />
          )}
        </Section>
        <Section title="Proposals and agreements">
          <Documents
            panel="deals"
            documents={documents.filter((d) => d.dealId)}
            actions={actions}
            newVersion={setVersionDoc}
          />
        </Section>
      </TabPanel>
      <TabPanel idBase="crm-company" id="delivery" active={tab === "delivery"}>
        <Section
          title="Client delivery"
          description="Sales stages and delivery progress are tracked separately"
          actions={
            <Button
              variant="accent"
              onClick={() => actions.edit({ kind: "project", companyId: company.id })}
            >
              <Plus className="size-4" />
              Add project
            </Button>
          }
        >
          {projects.length ? (
            <div className="space-y-6">
              {projects.map((project) => (
                <ProjectDetails
                  key={project.id}
                  project={project}
                  snapshot={snapshot}
                  actions={actions}
                  milestone={() => setMilestoneProject(project)}
                  selected={selectedId === project.id}
                />
              ))}
            </div>
          ) : (
            <EmptyState
              title="No delivery project yet"
              body="Onboarding can be created once a deal is won, or you can add an existing client project."
            />
          )}
        </Section>
        <Section title="Delivery documents">
          <Documents
            panel="delivery"
            documents={documents.filter(
              (d) => d.projectId || d.kind === "deliverable" || d.kind === "brief",
            )}
            actions={actions}
            newVersion={setVersionDoc}
          />
        </Section>
      </TabPanel>
      {activityOpen && (
        <ActivityEditor
          company={company}
          onClose={() => setActivityOpen(false)}
          onSaved={(receipt) => {
            setActivityOpen(false);
            onSaved(receipt);
          }}
        />
      )}
      {versionDoc && (
        <DocumentVersionEditor
          document={versionDoc}
          onClose={() => setVersionDoc(null)}
          onSaved={(receipt) => {
            setVersionDoc(null);
            onSaved(receipt);
          }}
        />
      )}
      {milestoneProject && (
        <MilestoneEditor
          withheld={!!snapshot.privateTextWithheld}
          project={milestoneProject}
          onClose={() => setMilestoneProject(null)}
          onSaved={(receipt) => {
            setMilestoneProject(null);
            onSaved(receipt);
          }}
        />
      )}
    </>
  );
}
/** R11: unsent, failed and received are told apart by icon and colour (the shared StatusLabel), not by a grey word. */
function CommunicationStatus({ state }: { state: string }) {
  const map: Record<string, { state: StatusState; label: string }> = {
    drafted: { state: "draft", label: "Drafted, not sent" },
    sent: { state: "sent", label: "Sent" },
    received: { state: "done", label: "Received" },
    failed: { state: "failed", label: "Failed to send" },
  };
  const m = map[state] ?? { state: "unknown" as StatusState, label: sentence(state) };
  return <StatusLabel state={m.state} label={m.label} size="sm" />;
}
/** Proposal and agreement states: a draft is hollow, issued is sent, accepted is done, superseded is quiet. */
function DocumentStatus({ status }: { status: string }) {
  const map: Record<string, { state: StatusState; label: string }> = {
    draft: { state: "draft", label: "Draft, not sent" },
    issued: { state: "sent", label: "Issued" },
    accepted: { state: "verified", label: "Accepted" },
    superseded: { state: "stopped", label: "Superseded" },
  };
  const m = map[status] ?? { state: "unknown" as StatusState, label: sentence(status) };
  return <StatusLabel state={m.state} label={m.label} size="sm" />;
}
function ActivityRow({ activity, timezone }: { activity: Activity; timezone: string }) {
  const by =
    "personId" in activity.by
      ? ownerName(activity.by.personId)
      : "agent" in activity.by
        ? activity.by.agent
        : activity.by.legacy;
  const artifact = activity.artifact ? artifactHref(activity.artifact) : null;
  return (
    <li className="py-5 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-medium">{activity.title}</h3>
          <p className="mt-1 text-[13px] text-muted-foreground">
            {sentence(activity.kind)} · {by} · {fmtDateTime(activity.at, { timeZone: timezone })}
          </p>
        </div>
        {activity.communicationState && <CommunicationStatus state={activity.communicationState} />}
      </div>
      {activity.note && (
        <p className="mt-3 max-w-[75ch] whitespace-pre-wrap text-sm text-muted-foreground">
          {activity.note}
        </p>
      )}
      {activity.outcome && <p className="mt-2 text-sm">Outcome: {activity.outcome}</p>}
      <div className="mt-3 flex flex-wrap gap-4">
        {activity.externalUrl && (
          <ExternalLink href={activity.externalUrl}>Open linked thread or meeting</ExternalLink>
        )}
        {artifact && (
          <a
            className="ds-interactive rounded text-sm underline underline-offset-4"
            href={artifact}
            {...resultLinkProps()}
          >
            Open saved result ↗
          </a>
        )}
      </div>
      {"jobId" in activity.by && (
        <Disclosure summary="Agent work details" className="mt-3">
          <AgentWork jobId={activity.by.jobId} />
        </Disclosure>
      )}
    </li>
  );
}
function AgentWork({ jobId }: { jobId: string }) {
  const query = useQuery({
    queryKey: ["crm", "linked-job", jobId],
    queryFn: () => fetchJob(jobId),
    staleTime: 10_000,
  });
  if (query.isPending) return <p className="text-sm text-muted-foreground">Loading linked job…</p>;
  if (!query.data)
    return (
      <p className="text-sm text-muted-foreground">
        The linked job is not available from the current Jobs service. The saved activity and result
        reference remain available.
      </p>
    );
  const job = query.data,
    receipt = job.receipts.at(-1),
    step = job.steps.at(-1);
  return (
    <div className="space-y-2 text-sm">
      <p className="font-medium">{job.title}</p>
      <p>
        {JOB_STATE_LABEL[job.state] ?? job.state}
        {step ? ` · ${step.intent}` : ""}
      </p>
      <p className="text-muted-foreground">
        Model: {receipt?.model || "Not reported"} · Provider: {receipt?.provider || "Not reported"}{" "}
        · Account: not reported
      </p>
      {job.note && (
        <p
          className={
            job.state === "failed" || job.state === "awaiting-approval"
              ? "text-warn"
              : "text-muted-foreground"
          }
        >
          {job.note}
        </p>
      )}
      <p className="text-[13px] text-muted-foreground">
        {job.steps.length} recorded steps · Updated {fmtDateTime(job.updatedAt)}
      </p>
      <a
        href={job.kind === "coding" ? `/coding/${encodeURIComponent(job.id)}` : "/work"}
        className="ds-interactive inline-block rounded underline underline-offset-4"
      >
        Open {job.kind === "coding" ? "coding job" : "Work"} ↗
      </a>
    </div>
  );
}
function Documents({
  panel,
  documents,
  actions,
  newVersion,
}: {
  panel: "overview" | "deals" | "delivery";
  documents: Document[];
  actions: WorkspaceActions;
  newVersion: (document: Document) => void;
}) {
  if (!documents.length)
    return (
      <EmptyState
        variant="row"
        title="No documents recorded"
        body="Keep versions and link existing documents or saved agent results."
      />
    );
  return (
    <Surface padding="sm">
      <div className="divide-y divide-border">
        {documents.map((document) => (
          <div
            key={document.id}
            id={`crm-document-${panel}-${document.id}`}
            className="py-3 first:pt-0 last:pb-0"
          >
            <div className="flex items-start justify-between gap-2">
              <div>
                <h3 className="text-sm font-medium">{document.title}</h3>
                <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-muted-foreground">
                  <DocumentStatus status={document.status} />
                  <span>Version {document.currentVersion} · {sentence(document.kind)}</span>
                </p>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => actions.edit({ kind: "document", record: document })}
              >
                Edit
              </Button>
            </div>
            {document.externalUrl && (
              <div className="mt-3">
                <ExternalLink href={document.externalUrl}>Open document</ExternalLink>
              </div>
            )}
            <DocumentVersions document={document} newVersion={newVersion} />
          </div>
        ))}
      </div>
    </Surface>
  );
}
export function DocumentVersions({
  document,
  newVersion,
}: {
  document: Document;
  newVersion: (document: Document) => void;
}) {
  const [open, setOpen] = useState(false);
  const deferred = document.versions.some((version) => version.contentDeferred);
  const query = useQuery({
    queryKey: ["crm", "document-content", document.id, document.version],
    queryFn: async ({ signal }) => {
      const receipt = await getCrmRecord<Document>({ kind: "document", id: document.id }, signal);
      if ((receipt as { privateTextWithheld?: string }).privateTextWithheld)
        throw new Error("Confirm this browser to read and edit this.");
      if (!receipt.data || receipt.data.versions.some((version) => version.contentDeferred))
        throw new Error("Full document content was not returned. Refresh and try again.");
      return receipt.data;
    },
    enabled: open && deferred,
    staleTime: 15_000,
    retry: false,
  });
  const full = deferred ? query.data : document;
  return (
    <Disclosure
      className="mt-2"
      summary="Versions and content"
      meta={String(document.versions.length)}
      open={open}
      onOpenChange={setOpen}
    >
      {deferred && query.isError && (
        <Notice
          tone="warn"
          title={full ? "Showing previously loaded content" : "Document content could not load"}
          action={
            <Button variant="outline" onClick={() => void query.refetch()}>
              Retry content
            </Button>
          }
        >
          {crmErrorMessage(query.error)}
        </Notice>
      )}
      {open && !full && query.isPending && (
        <p role="status" className="text-sm text-muted-foreground">
          Loading saved document content…
        </p>
      )}
      {full && (
        <div className="space-y-4">
          {(full.attachments?.length ?? 0) > 0 && (
            <ul aria-label="Private files" className="space-y-1 text-sm">
              {full.attachments!.map((file) => (
                <li key={file.id}>
                  <a
                    className="ds-interactive rounded underline"
                    href={`/__crm/file?id=${encodeURIComponent(file.id)}`}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {file.name}
                  </a>{" "}
                  <span className="text-[13px] text-muted-foreground">
                    private file · {Math.max(1, Math.round(file.bytes / 1024))} KB
                  </span>
                </li>
              ))}
            </ul>
          )}
          {[...full.versions].reverse().map((version) => {
            const href = version.artifact ? artifactHref(version.artifact) : null;
            return (
              <article key={version.id}>
                <p className="text-[13px] text-muted-foreground">
                  Version {version.number} · {fmtDateTime(version.createdAt)}
                </p>
                {version.pricing && (
                  <p className="ds-num mt-2 text-sm">
                    {money(version.pricing.oneOffCents)} + {money(version.pricing.recurringCents)} /
                    month · GST {version.pricing.gstTreatment} · Deal version{" "}
                    {version.pricing.dealVersion ?? "unknown"}
                  </p>
                )}
                {version.content && (
                  <pre className="mt-2 max-h-80 overflow-y-auto whitespace-pre-wrap break-words font-sans text-sm">
                    {version.content}
                  </pre>
                )}
                {href && (
                  <a
                    className="ds-interactive mt-2 inline-block rounded text-sm underline"
                    href={href}
                    {...resultLinkProps()}
                  >
                    Open version result ↗
                  </a>
                )}
              </article>
            );
          })}
          <Button variant="outline" onClick={() => newVersion(full)}>
            Add version
          </Button>
        </div>
      )}
    </Disclosure>
  );
}
function DealDetails({
  deal,
  snapshot,
  actions,
  selected,
}: {
  deal: Deal;
  snapshot: CrmSnapshot;
  actions: WorkspaceActions;
  selected: boolean;
}) {
  const stage = stageForDeal(snapshot, deal);
  return (
    <Surface id={`crm-deal-${deal.id}`} className={selected ? "ring-1 ring-border-strong" : ""}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h3 className="text-lg font-semibold">{deal.title}</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            {stage?.name || deal.stageId} · {ownerName(deal.owner)} ·{" "}
            {deal.service || "Service not recorded"}
          </p>
        </div>
        <Button variant="outline" onClick={() => actions.edit({ kind: "deal", record: deal })}>
          Edit deal
        </Button>
      </div>
      <dl className="mt-5 grid gap-5 sm:grid-cols-3">
        <div>
          <dt className="text-[13px] text-muted-foreground">One-off / monthly recurring</dt>
          <dd className="ds-num mt-1 text-base font-medium">
            {pricingPending(deal)
              ? "Pricing pending"
              : `${money(deal.oneOffCents)} / ${money(deal.recurringCents)}`}
          </dd>
          <dd className="mt-1 text-[13px] text-muted-foreground">
            {pricingPending(deal)
              ? "No approved price yet. Nothing here is a quote."
              : `GST ${deal.gstTreatment} · ${sentence(deal.commercialBasis)}`}
          </dd>
        </div>
        <div>
          <dt className="text-[13px] text-muted-foreground">Expected close</dt>
          <dd className="mt-1 text-sm">{fmtDay(deal.expectedClose)}</dd>
        </div>
        <div>
          <dt className="text-[13px] text-muted-foreground">Next action</dt>
          <dd className="mt-1 text-sm">{deal.nextAction || "Not set"}</dd>
          <dd className="mt-1 text-[13px] text-muted-foreground">{fmtDateTime(deal.nextActionDue)}</dd>
        </div>
      </dl>
      {deal.scope && <p className="mt-5 whitespace-pre-wrap text-sm">{deal.scope}</p>}
      {deal.contactIds.length > 0 && (
        <p className="mt-4 text-sm text-muted-foreground">
          Contacts:{" "}
          {deal.contactIds
            .map((id) => snapshot.contacts.find((c) => c.id === id)?.name || "Contact unavailable")
            .join(", ")}
        </p>
      )}
      {deal.closeReason && <p className="mt-3 text-sm">Outcome: {deal.closeReason}</p>}
      <div className="mt-5 flex flex-wrap gap-2">
        <Button
          variant="outline"
          disabled={actions.busy}
          onClick={() =>
            void actions.run("crm.proposal.draft", {
              dealId: deal.id,
              expectedVersion: deal.version,
            })
          }
        >
          Draft proposal
        </Button>
        <Button
          variant="ghost"
          onClick={() => actions.edit({ kind: "task", companyId: deal.companyId, dealId: deal.id })}
        >
          Add follow-up
        </Button>
        {stage?.category === "won" && !snapshot.projects.some((p) => p.dealId === deal.id) && (
          <Button
            variant="ghost"
            onClick={() =>
              actions.edit({ kind: "project", companyId: deal.companyId, dealId: deal.id })
            }
          >
            Add onboarding project
          </Button>
        )}
      </div>
      {stage?.category === "won" && (
        <p className="mt-3 text-[13px] text-muted-foreground">
          Won business is not payment received. Check invoices in Finance.
        </p>
      )}
      <Disclosure
        className="mt-4"
        summary="Stage history"
        meta={plural(deal.stageHistory.length, "change")}
      >
        <ol className="space-y-3">
          {deal.stageHistory.map((entry, index) => (
            <li key={`${entry.at}:${index}`} className="text-sm">
              {entry.stageName} · {fmtDateTime(entry.at)}
              {entry.reason && <span className="block text-muted-foreground">{entry.reason}</span>}
            </li>
          ))}
        </ol>
      </Disclosure>
    </Surface>
  );
}
function ProjectDetails({
  project,
  snapshot,
  actions,
  milestone,
  selected,
}: {
  project: Project;
  snapshot: CrmSnapshot;
  actions: WorkspaceActions;
  milestone: () => void;
  selected: boolean;
}) {
  const tasks = snapshot.tasks.filter((t) => t.projectId === project.id).sort(taskOrder);
  return (
    <Surface
      id={`crm-project-${project.id}`}
      className={selected ? "ring-1 ring-border-strong" : ""}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold">{project.name}</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            {sentence(project.status)} · {ownerName(project.owner)}
          </p>
        </div>
        <Button
          variant="outline"
          onClick={() => actions.edit({ kind: "project", record: project })}
        >
          Edit project
        </Button>
      </div>
      {project.scope && <p className="mt-4 whitespace-pre-wrap text-sm">{project.scope}</p>}
      <div className="mt-4 flex flex-wrap gap-5 text-sm text-muted-foreground">
        <span>Launch: {fmtDay(project.launchAt)}</span>
        <span>Renewal: {fmtDay(project.renewalAt)}</span>
      </div>
      {project.previewUrls.length > 0 && (
        <div className="mt-5 flex flex-wrap gap-4">
          {project.previewUrls.map((url, index) => (
            <ExternalLink key={url} href={url}>
              Preview {index + 1}
            </ExternalLink>
          ))}
        </div>
      )}
      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <div>
          <div className="mb-3 flex items-center justify-between gap-2">
            <h4 className="text-base font-medium">Milestones</h4>
            <Button variant="ghost" size="sm" onClick={milestone}>
              Edit milestones
            </Button>
          </div>
          {project.milestones.length ? (
            <ul className="divide-y divide-border">
              {project.milestones.map((m) => (
                <li key={m.id} className="flex items-start gap-3 py-3">
                  <span className="mt-0.5 text-muted-foreground">
                    {m.status === "done" ? (
                      <Check className="size-5 text-success" />
                    ) : (
                      <span className="inline-block size-4 rounded-full border border-border-strong" />
                    )}
                  </span>
                  <div>
                    <p className="text-sm font-medium">{m.name}</p>
                    <p className="mt-1 text-[13px] text-muted-foreground">
                      {sentence(m.status)} · {fmtDay(m.dueAt)}
                    </p>
                    {m.note && <p className="mt-1 text-sm text-muted-foreground">{m.note}</p>}
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">No milestones defined</p>
          )}
        </div>
        <div className="space-y-4">
          {(
            [
              ["Content requests", project.contentRequests],
              ["Access requests", project.accessRequests],
              ["Revision requests", project.revisionRequests],
              ["Deliverables", project.deliverables],
            ] as [string, string[]][]
          ).map(([title, items]) => (
            <Disclosure
              key={title}
              summary={title}
              meta={String(items.length)}
              defaultOpen={items.length > 0}
            >
              <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
                {items.length ? (
                  items.map((item, index) => <li key={index}>{item}</li>)
                ) : (
                  <li>None recorded</li>
                )}
              </ul>
            </Disclosure>
          ))}
        </div>
      </div>
      <div className="mt-6 flex flex-wrap gap-2">
        <Button
          variant="outline"
          onClick={() =>
            actions.edit({
              kind: "document",
              companyId: project.companyId,
              projectId: project.id,
              dealId: project.dealId ?? undefined,
              documentKind: "deliverable",
            })
          }
        >
          Link delivery result
        </Button>
        {project.dealId && (
          <Button
            variant="ghost"
            onClick={() => actions.open({ kind: "deal", id: project.dealId! }, "deals")}
          >
            Review linked deal
          </Button>
        )}
      </div>
      <div className="mt-6 border-t border-border pt-5">
        <div className="mb-4 flex items-center justify-between gap-2">
          <h4 className="text-base font-medium">Assigned delivery tasks</h4>
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              actions.edit({
                kind: "task",
                companyId: project.companyId,
                projectId: project.id,
                dealId: project.dealId ?? undefined,
              })
            }
          >
            Add task
          </Button>
        </div>
        {tasks.length ? (
          <TaskRows tasks={tasks} snapshot={snapshot} actions={actions} compact />
        ) : (
          <p className="text-sm text-muted-foreground">No delivery tasks assigned yet</p>
        )}
      </div>
    </Surface>
  );
}
export function MilestoneEditor({
  project,
  withheld = false,
  onClose,
  onSaved,
}: {
  project: Project;
  /** Private text is hidden from this browser: saving the milestones would replace real notes with blanks, so editing is closed. */
  withheld?: boolean;
  onClose: () => void;
  onSaved: (receipt: CrmReceipt) => void;
}) {
  const [baseProject] = useState(project);
  project = baseProject;
  const [milestones, setMilestones] = useState(() => project.milestones.map((m) => ({ ...m }))),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  const running = useRef(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError(null);
    try {
      onSaved(
        await crmOperation("crm.project.update", {
          id: project.id,
          expectedVersion: project.version,
          patch: { milestones },
        }),
      );
    } catch (e) {
      setError(crmErrorMessage(e));
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Edit delivery milestones"
      description={`Milestones for ${project.name}. Completion is recorded with a timestamp.`}
      busy={busy}
      onClose={onClose}
    >
      {withheld ? (
        <Notice tone="info" title="Private text is hidden">
          Confirm this browser to read and edit this.
        </Notice>
      ) : (
        <form className="space-y-5" onSubmit={submit}>
          {error && <Notice tone="danger">{error}</Notice>}
          {milestones.map((milestone, index) => (
            <fieldset
              className="grid gap-3 rounded-xl border border-border p-4 sm:grid-cols-2"
              key={milestone.id}
            >
              <legend className="px-1 text-[13px] text-muted-foreground">Milestone {index + 1}</legend>
              <Field label="Name" wide>
                <Input
                  required
                  value={milestone.name}
                  onChange={(e) =>
                    setMilestones((ms) =>
                      ms.map((m, i) => (i === index ? { ...m, name: e.target.value } : m)),
                    )
                  }
                />
              </Field>
              <Field label="Status">
                <NativeSelect
                  value={milestone.status}
                  onChange={(e) =>
                    setMilestones((ms) =>
                      ms.map((m, i) =>
                        i === index
                          ? {
                              ...m,
                              status: e.target.value as typeof milestone.status,
                              completedAt:
                                e.target.value === "done"
                                  ? (m.completedAt ?? new Date().toISOString())
                                  : null,
                            }
                          : m,
                      ),
                    )
                  }
                >
                  <option value="pending">Pending</option>
                  <option value="in-progress">In progress</option>
                  <option value="done">Done</option>
                </NativeSelect>
              </Field>
              <Field label="Due date and time">
                <Input
                  type="datetime-local"
                  value={localDateTime(milestone.dueAt)}
                  onChange={(e) =>
                    setMilestones((ms) =>
                      ms.map((m, i) =>
                        i === index ? { ...m, dueAt: dateTimeValue(e.target.value) } : m,
                      ),
                    )
                  }
                />
              </Field>
              <Field label="Note" wide>
                <Textarea
                  value={milestone.note}
                  onChange={(e) =>
                    setMilestones((ms) =>
                      ms.map((m, i) => (i === index ? { ...m, note: e.target.value } : m)),
                    )
                  }
                />
              </Field>
            </fieldset>
          ))}
          <Button
            type="button"
            variant="outline"
            onClick={() =>
              setMilestones((ms) => [
                ...ms,
                {
                  id: crypto.randomUUID(),
                  name: "",
                  status: "pending",
                  dueAt: null,
                  completedAt: null,
                  note: "",
                },
              ])
            }
          >
            Add milestone
          </Button>
          <SaveActions busy={busy} onClose={onClose} />
        </form>
      )}
    </Modal>
  );
}
