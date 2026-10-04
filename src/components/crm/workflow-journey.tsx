import type { Company, CrmSnapshot, Deal, Project } from "../../../scripts/crm/types";
import { Button, DataList, DataRow, Disclosure, Surface } from "@/components/ds";
import { Check, Circle } from "lucide-react";
import { companyLabel, stageForDeal, isOpenTask } from "./selectors";
import type { EditorTarget } from "./record-editor";
import type { WorkspaceActions } from "./workspace-views";

export type JourneyStep = {
  id: string;
  label: string;
  recorded: boolean;
  detail: string;
  edit?: EditorTarget;
  tab?: "overview" | "timeline" | "deals" | "delivery";
};
/** Presence of a CRM record is evidence of recording only, never payment, sending or agent completion. */
export function companyJourney(snapshot: CrmSnapshot, company: Company, selectedId?: string) {
  const deals = snapshot.deals.filter((d) => d.companyId === company.id);
  const selectedProject = snapshot.projects.find(
    (p) => p.companyId === company.id && p.id === selectedId,
  );
  const deal =
    deals.find((d) => d.id === selectedId || d.id === selectedProject?.dealId) ??
    deals.find((d) => stageForDeal(snapshot, d)?.category === "open") ??
    deals.find((d) => stageForDeal(snapshot, d)?.category === "won");
  const project =
    selectedProject ??
    snapshot.projects.find(
      (p) => p.companyId === company.id && (deal ? p.dealId === deal.id : true),
    );
  const contacts = snapshot.contacts.filter((c) => c.companyId === company.id);
  const proposal =
    deal && snapshot.documents.find((d) => d.dealId === deal.id && d.kind === "proposal");
  const tasks = snapshot.tasks.filter((t) => project && t.projectId === project.id);
  const next =
    deal?.nextAction ||
    snapshot.tasks.find(
      (t) => t.companyId === company.id && (!deal || t.dealId === deal.id) && isOpenTask(t),
    )?.title;
  const results = snapshot.documents.filter(
    (d) =>
      (project
        ? d.projectId === project.id
        : deal
          ? d.dealId === deal.id
          : d.companyId === company.id) &&
      (d.kind === "deliverable" || d.versions.some((v) => v.artifact)) &&
      (d.externalUrl || d.versions.some((v) => v.artifact)),
  );
  const activities = snapshot.activities.filter(
    (a) =>
      a.artifact &&
      (project
        ? a.ref.kind === "project" && a.ref.id === project.id
        : deal
          ? a.ref.kind === "deal" && a.ref.id === deal.id
          : a.companyId === company.id),
  );
  const sourceRecorded =
    company.source.kind === "enquiry" ||
    company.legacyLeadId !== null ||
    !!company.source.reference;
  const steps: JourneyStep[] = [
    {
      id: "source",
      label: "Lead / enquiry",
      recorded: sourceRecorded,
      detail: sourceRecorded
        ? `${company.source.kind} source recorded`
        : "Manual company record; no linked lead or enquiry",
      tab: "overview",
    },
    {
      id: "contact",
      label: "Company + contact",
      recorded: contacts.length > 0,
      detail: contacts.length
        ? `${contacts.length} contact${contacts.length === 1 ? "" : "s"} recorded`
        : "Add the person you are working with",
      edit: { kind: "contact", companyId: company.id },
      tab: "overview",
    },
    {
      id: "deal",
      label: "Deal",
      recorded: !!deal,
      detail: deal?.title || "Create an opportunity with scope and ownership",
      edit: { kind: "deal", companyId: company.id },
      tab: "deals",
    },
    {
      id: "next",
      label: "Next action",
      recorded: !!next,
      detail: next || "Choose a clear next step and due date",
      edit: deal ? { kind: "deal", record: deal } : { kind: "task", companyId: company.id },
      tab: "deals",
    },
    {
      id: "proposal",
      label: "Proposal draft",
      recorded: !!proposal,
      detail: proposal
        ? `${proposal.title} · ${proposal.status}`
        : "Draft from the deal’s recorded pricing",
      tab: "deals",
    },
    {
      id: "project",
      label: "Project",
      recorded: !!project,
      detail: project?.name || "Add a delivery project after agreement",
      edit: { kind: "project", companyId: company.id, dealId: deal?.id },
      tab: "delivery",
    },
    {
      id: "task",
      label: "Delivery task",
      recorded: tasks.length > 0,
      detail: tasks.length
        ? `${tasks.length} task${tasks.length === 1 ? "" : "s"} recorded`
        : "Assign a concrete delivery commitment",
      edit: { kind: "task", companyId: company.id, dealId: deal?.id, projectId: project?.id },
      tab: "delivery",
    },
    {
      id: "result",
      label: "Linked result",
      recorded: results.length + activities.length > 0,
      detail:
        results.length + activities.length
          ? "Saved result reference recorded; review its contents"
          : "Link the saved delivery result for review",
      edit: {
        kind: "document",
        companyId: company.id,
        dealId: deal?.id,
        projectId: project?.id,
        documentKind: "deliverable",
      },
      tab: "delivery",
    },
  ];
  return { steps, deal, project };
}
export function WorkflowJourney({
  company,
  snapshot,
  selectedId,
  actions,
}: {
  company: Company;
  snapshot: CrmSnapshot;
  selectedId?: string;
  actions: WorkspaceActions;
}) {
  const { steps, deal, project } = companyJourney(snapshot, company, selectedId);
  return (
    <Disclosure
      summary="From enquiry to linked delivery result"
      className="mb-6 rounded-2xl border border-border"
      meta={`${steps.filter((x) => x.recorded).length} of ${steps.length} recorded`}
    >
      <p className="mb-4 text-[13px] text-muted-foreground">
        Recorded steps for {project?.name || deal?.title || companyLabel(company)}. Drafts, task
        ticks and linked files require review; they do not confirm payment or agent completion.
      </p>
      <ol className="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {steps.map((step, index) => (
          <li key={step.id} className="min-w-0 rounded-xl border border-border p-3">
            <div className="flex items-center gap-2 text-sm font-medium">
              {step.recorded ? (
                <Check className="size-4 shrink-0 text-success" aria-hidden="true" />
              ) : (
                <Circle className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              )}
              <span>
                {index + 1}. {step.label}
              </span>
            </div>
            <p className="mt-2 break-words text-[13px] text-muted-foreground">{step.detail}</p>
            <Button
              variant="ghost"
              size="sm"
              className="mt-2"
              disabled={
                actions.busy ||
                (step.id === "task" && !project) ||
                (step.id === "proposal" && !deal)
              }
              onClick={() => {
                if (step.id === "proposal" && !step.recorded && deal)
                  void actions.run("crm.proposal.draft", {
                    dealId: deal.id,
                    expectedVersion: deal.version,
                  });
                else if (!step.recorded && step.edit) actions.edit(step.edit);
                else
                  actions.open(
                    {
                      kind:
                        project && step.tab === "delivery"
                          ? "project"
                          : deal && step.tab === "deals"
                            ? "deal"
                            : "company",
                      id:
                        project && step.tab === "delivery"
                          ? project.id
                          : deal && step.tab === "deals"
                            ? deal.id
                            : company.id,
                    },
                    step.tab,
                  );
              }}
            >
              {step.recorded
                ? "Review"
                : step.id === "source"
                  ? "Review source"
                  : step.id === "proposal"
                    ? "Draft proposal"
                    : step.id === "result"
                      ? "Link result"
                      : "Add next step"}
            </Button>
          </li>
        ))}
      </ol>
    </Disclosure>
  );
}
export type BusinessAction = {
  company: Company;
  title: string;
  detail: string;
  edit?: EditorTarget;
  deal?: Deal;
  project?: Project;
  kind: "contact" | "deal" | "next" | "proposal" | "project" | "task" | "result";
};
export function nextBusinessActions(snapshot: CrmSnapshot, owner = ""): BusinessAction[] {
  // Partition once so a large dashboard does not repeatedly scan every record.
  const grouped = new Map<string, CrmSnapshot>();
  for (const company of snapshot.companies)
    grouped.set(company.id, {
      ...snapshot,
      companies: [company],
      contacts: [],
      deals: [],
      projects: [],
      documents: [],
      tasks: [],
      activities: [],
    });
  for (const row of snapshot.contacts) grouped.get(row.companyId)?.contacts.push(row);
  for (const row of snapshot.deals) grouped.get(row.companyId)?.deals.push(row);
  for (const row of snapshot.projects) grouped.get(row.companyId)?.projects.push(row);
  for (const row of snapshot.documents) grouped.get(row.companyId)?.documents.push(row);
  for (const row of snapshot.tasks) grouped.get(row.companyId)?.tasks.push(row);
  for (const row of snapshot.activities) grouped.get(row.companyId)?.activities.push(row);
  return snapshot.companies
    .filter((c) => !c.mergedInto && !c.excluded && c.status !== "inactive")
    .flatMap((company) => {
      const { steps, deal, project } = companyJourney(grouped.get(company.id)!, company);
      if (owner && (project?.owner || deal?.owner || company.owner) !== owner) return [];
      const missing = steps.find((step) => step.id !== "source" && !step.recorded);
      if (!missing) return [];
      // A proposal is a deliberate next step once the opportunity has progressed.
      if (
        missing.id === "proposal" &&
        deal &&
        !["meeting", "proposal", "negotiation", "won"].includes(deal.stageId)
      )
        return [];
      // A proposal draft alone does not establish agreement or permission to deliver.
      if (missing.id === "project" && deal && stageForDeal(snapshot, deal)?.category !== "won")
        return [];
      return [
        {
          company,
          title: missing.detail,
          detail: `${companyLabel(company)}${deal ? ` · ${deal.title}` : ""}`,
          edit: missing.edit,
          deal,
          project,
          kind: missing.id as BusinessAction["kind"],
        },
      ];
    });
}
export function BusinessNextActions({
  snapshot,
  actions,
  owner,
}: {
  snapshot: CrmSnapshot;
  actions: WorkspaceActions;
  owner: string;
}) {
  const next = nextBusinessActions(snapshot, owner);
  return (
    <section className="mb-8" aria-label="Move the business forward">
      <h2 className="mb-3 text-base font-semibold">
        Move the business forward {next.length > 0 && <span className="font-normal text-muted-foreground">{Math.min(next.length, 8)}</span>}
      </h2>
      {next.length ? (
        <DataList label="Next steps">
          {next.slice(0, 8).map((item) => {
            // R12 rollout: the row itself opens the missing step (its editor, or the company); only drafting a proposal, which
            // creates a record, keeps its own quiet button beside the row.
            const openStep = () => (item.edit ? actions.edit(item.edit) : actions.open({ kind: "company", id: item.company.id }));
            return (
              <DataRow
                key={item.company.id}
                title={item.detail}
                meta={item.title}
                onClick={item.kind === "proposal" ? () => actions.open({ kind: "company", id: item.company.id }) : openStep}
                trailing={
                  item.kind === "proposal" && item.deal ? (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={actions.busy}
                      onClick={() => void actions.run("crm.proposal.draft", { dealId: item.deal!.id, expectedVersion: item.deal!.version })}
                    >
                      Draft proposal
                    </Button>
                  ) : undefined
                }
              />
            );
          })}
        </DataList>
      ) : (
        <p className="mt-4 text-sm text-muted-foreground">
          {snapshot.companies.length
            ? "No missing next step found in the recorded journey. Review due tasks and deal actions below."
            : "Add a company or import your lead list to start a client journey."}
        </p>
      )}
    </section>
  );
}
