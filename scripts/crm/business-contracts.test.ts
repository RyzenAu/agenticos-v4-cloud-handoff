/** Thirteen explicit business contracts, entirely disposable and provider-free.
 * Run this file directly; it does not start the server, browser or full release suite.
 * Owning-Jobs subjects are supplied by a trusted FAKE reader; the missing shared integration
 * has a separate TODO below and must not be represented as a production pass.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { artifactHref, crmHref } from "../../src/lib/crm-links";
import { crmRefString, parseCrmRef, resolveLegacyLead, type CrmRef } from "../../src/lib/crm-ref";
import { pageTokenFor, type Principal } from "../identity/principal";
import { upsertLead } from "../leads/crm";
import { CrmAutomations } from "./automation";
import {
  BusinessContractFixture,
  CONTRACT_AT,
  founders,
  invokeHandler,
  legacyRows,
} from "./business-contract-fixtures";
import { migrateCrm, synchroniseLegacy } from "./migrations";
import { type CrmReceipt } from "./ops";
import { createCrmMiddleware } from "./plugin";
import type { Activity, Company, Contact, Deal, Document, Project, Task } from "./types";

const fixtures: BusinessContractFixture[] = [];
const fixture = (legacy = false) => {
  const f = new BusinessContractFixture({ legacy });
  fixtures.push(f);
  return f;
};
afterEach(() => {
  for (const f of fixtures.splice(0).reverse()) f.dispose();
});
function ok<T>(r: CrmReceipt): T {
  expect(r.ok, r.text).toBe(true);
  return r.data as T;
}
function account(f: BusinessContractFixture) {
  const company = ok<Company>(
    f.ops.run("crm.company.create", { name: "Synthetic contract account" }, founders.usman),
  );
  const deal = ok<Deal>(
    f.ops.run(
      "crm.deal.create",
      {
        companyId: company.id,
        title: "Synthetic five-page website",
        service: "website",
        scope: "Five approved pages",
        oneOffCents: 220000,
        recurringCents: 11000,
        gstTreatment: "inclusive",
        commercialBasis: "agreed",
      },
      founders.usman,
    ),
  );
  return { company, deal, ref: { kind: "deal", id: deal.id } as CrmRef };
}
function resultInput(ref: CrmRef, jobId: string, artifact: string, eventId = `${jobId}:result`) {
  return {
    ref,
    eventId,
    kind: "agent-result",
    title: "Synthetic research complete",
    artifact,
    by: { agent: "Research", jobId },
  };
}
function recordFromHref(f: BusinessContractFixture, href: string) {
  const url = new URL(href, "http://localhost");
  const ref =
    url.pathname === "/leads"
      ? { kind: "lead" as const, id: url.searchParams.get("lead")! }
      : parseCrmRef(url.searchParams.get("ref") ?? "");
  expect(ref).not.toBeNull();
  return f.ops.run("crm.record.get", { ref }, founders.usman);
}

describe("disposable business contracts", () => {
  test("01 legacy migration preserves stable IDs, history, relationships and old links", () => {
    const f = fixture(true);
    const originals = f.legacyBeforeMigration!;
    expect(originals).toBeDefined();
    expect(f.store.resolveLegacyLead(7)).toEqual({ kind: "company", id: "legacy-company-7" });
    expect(f.store.resolveLegacyLead(9)).toEqual({ kind: "company", id: "legacy-company-7" });
    const oldHref = crmHref({ kind: "lead", id: "7" });
    expect(oldHref).toBe("/leads?lead=7");
    expect(ok<Company>(recordFromHref(f, oldHref)).id).toBe("legacy-company-7");
    const mapped = resolveLegacyLead(7, (id) => f.store.resolveLegacyLead(id));
    expect(ok<Company>(recordFromHref(f, crmHref(mapped))).id).toBe("legacy-company-7");
    const deal = f.store.getDeal("legacy-deal-7")!;
    expect(deal.companyId).toBe("legacy-company-7");
    expect(deal.stageHistory.map((entry) => entry.stageId)).toEqual(["qualified", "proposal"]);
    expect(deal.stageHistory.map((entry) => entry.at)).toEqual([
      "2026-09-02T09:00:00.000Z",
      "2026-09-03T09:00:00.000Z",
    ]);
    expect(f.store.getTask("legacy-followup-7")).toMatchObject({
      companyId: mapped.id,
      dealId: deal.id,
    });
    expect(f.store.getProject("legacy-project-7")).toMatchObject({
      companyId: mapped.id,
      dealId: deal.id,
      scope: "Five approved pages",
    });
    const history = f.store
      .snapshot()
      .activities.filter((a) => a.kind === "call" || a.kind === "meeting");
    expect(history.map((a) => a.note).sort()).toEqual([
      "Agreed five-page scope",
      "Qualified by the founder",
    ]);
    expect(history.every((a) => a.companyId === mapped.id)).toBe(true);
    expect(legacyRows(f.db)).toEqual(originals);
    expect(f.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  test("02 repeated migration and store restarts create no duplicate entities or history", () => {
    const f = fixture(true);
    const before = f.store.snapshot();
    const originals = legacyRows(f.db);
    for (let i = 0; i < 3; i++) {
      expect(migrateCrm(f.db, CONTRACT_AT).applied).toBe(false);
      synchroniseLegacy(f.db, CONTRACT_AT);
      f.reopen();
    }
    expect(f.store.snapshot()).toEqual(before);
    expect(legacyRows(f.db)).toEqual(originals);
    expect(f.db.query("SELECT COUNT(*) AS count FROM crm_schema_migrations").get()).toEqual({
      count: 1,
    });
  });

  test("03 verified founder corrections survive a later directory reimport", () => {
    const f = fixture(true);
    const before = f.store.getCompany("legacy-company-7")!;
    const correction = {
      name: "Founder corrected clinic",
      phone: "0293334444",
      website: "https://verified.example.test",
      address: "Synthetic corrected address",
      emails: ["verified@example.test"],
      notes: "Keep this scope note",
    };
    ok<Company>(
      f.ops.run(
        "crm.company.update",
        { id: before.id, expectedVersion: before.version, patch: correction },
        founders.mehroz,
      ),
    );
    upsertLead(f.db, {
      placeId: "osm:node/7",
      source: "osm",
      attribution: "Synthetic directory refresh",
      vertical: "dental",
      area: "Sydney",
      name: "Stale directory name",
      phone: "0295556666",
      website: "https://stale.example.test",
      address: "Stale address",
      emails: ["stale@example.test"],
      mapsUrl: "",
      rating: null,
      reviews: null,
      emailOk: false,
      score: 0,
      pitch: "website",
      reasons: [],
      googleAt: null,
      fieldSources: { name: "osm", phone: "osm", address: "osm", website: "osm", emails: "osm" },
    });
    f.reopen();
    expect(f.store.getCompany(before.id)).toMatchObject(correction);
    expect(f.store.getCompany(before.id)?.fieldSources).toMatchObject({
      name: "manual",
      phone: "manual",
      website: "manual",
      address: "manual",
      emails: "manual",
    });
    expect(f.store.getDeal("legacy-deal-7")?.oneOffCents).toBe(220000);
  });

  test("04 conflicting founder edits fail without overwriting the accepted record or audit", () => {
    const f = fixture();
    const { company } = account(f);
    const accepted = ok<Company>(
      f.ops.run(
        "crm.company.update",
        {
          id: company.id,
          expectedVersion: company.version,
          patch: { notes: "Accepted by Mehroz" },
        },
        founders.mehroz,
      ),
    );
    const committed = f.store.snapshot();
    const stale = f.ops.run(
      "crm.company.update",
      {
        id: company.id,
        expectedVersion: company.version,
        patch: { notes: "Stale Usman edit" },
      },
      founders.usman,
    );
    expect(stale).toMatchObject({ ok: false, code: "conflict" });
    expect(f.store.snapshot()).toEqual(committed);
    expect(f.store.getCompany(company.id)).toMatchObject({
      version: accepted.version,
      notes: "Accepted by Mehroz",
    });
  });

  test("05 a Won deal creates exactly one linked delivery project across replay and reopen", () => {
    const f = fixture();
    const { company, deal, ref } = account(f);
    const won = ok<Deal>(
      f.ops.run(
        "crm.deal.move",
        { id: deal.id, stageId: "won", expectedVersion: deal.version },
        founders.usman,
      ),
    );
    const project = f.store.snapshot().projects[0];
    expect(project).toMatchObject({
      companyId: company.id,
      dealId: deal.id,
      status: "onboarding",
      scope: deal.scope,
    });
    f.reopen();
    expect(
      f.automations.accept(
        { eventId: "synthetic:win:replay", trigger: "deal.won", at: CONTRACT_AT, ref, payload: {} },
        founders.usman,
      ).duplicate,
    ).toBe(true);
    expect(
      f.ops.run(
        "crm.project.create",
        { companyId: company.id, dealId: deal.id, name: "Accidental second project" },
        founders.mehroz,
      ),
    ).toMatchObject({ ok: false, code: "conflict" });
    expect(f.store.snapshot().projects.map((p) => p.id)).toEqual([project.id]);
    expect(f.store.snapshot().tasks.filter((task) => task.projectId === project.id)).toHaveLength(
      1,
    );
    expect(f.store.getDeal(deal.id)?.version).toBe(won.version);
    expect(f.store.snapshot().documents.filter((d) => d.kind === "invoice-reference")).toHaveLength(
      0,
    );
  });

  test("06 the trusted fake Jobs subject reader links the correct record and rejects another target", async () => {
    const f = fixture();
    const { ref } = account(f);
    const other = account(f).ref;
    const job = f.submitResearch(ref);
    const artifact = await f.completeResearch(job.id);
    const accepted = f.ops.run(
      "crm.activity.add",
      resultInput(ref, job.id, artifact),
      founders.usman,
    );
    const activity = ok<Activity>(accepted);
    expect(activity.ref).toEqual(ref);
    expect(activity.by).toEqual({ agent: "Research", jobId: job.id });
    expect(f.jobs.get(job.id)?.state).toBe("succeeded");
    expect(ok<Deal>(recordFromHref(f, accepted.href)).id).toBe(ref.id);
    expect(
      f.ops.run(
        "crm.activity.add",
        resultInput(other, job.id, artifact, `${job.id}:wrong-target`),
        founders.usman,
      ),
    ).toMatchObject({ ok: false, code: "restricted" });
    expect(f.store.snapshot().activities.filter((a) => "agent" in a.by)).toHaveLength(1);
  });

  test("07 duplicate completion events persist exactly one activity even after restart", async () => {
    const f = fixture();
    const { ref } = account(f);
    const job = f.submitResearch(ref);
    const artifact = await f.completeResearch(job.id);
    const input = resultInput(ref, job.id, artifact);
    const first = f.ops.run("crm.activity.add", input, founders.usman);
    ok<Activity>(first);
    f.reopen();
    const second = f.ops.run("crm.activity.add", input, founders.usman);
    ok<Activity>(second);
    expect(second.activityId).toBe(first.activityId);
    expect(second.href).toBe(first.href);
    expect(f.store.snapshot().activities.filter((a) => a.eventId === input.eventId)).toHaveLength(
      1,
    );
    expect(
      f.ops.run(
        "crm.activity.add",
        { ...input, title: "Different result under same event ID" },
        founders.usman,
      ),
    ).toMatchObject({ ok: false, code: "idempotency-conflict" });
  });

  test("08 out-of-order old job completions cannot regress terminal Jobs or founder CRM state", async () => {
    const f = fixture();
    const { ref, deal } = account(f);
    const older = f.submitResearch(ref);
    const newer = f.submitResearch(ref);
    const newerArtifact = await f.completeResearch(newer.id, "# Newer result");
    ok<Activity>(
      f.ops.run(
        "crm.activity.add",
        { ...resultInput(ref, newer.id, newerArtifact), at: "2026-10-02T09:05:00.000Z" },
        founders.usman,
      ),
    );
    const advanced = ok<Deal>(
      f.ops.run(
        "crm.deal.move",
        { id: deal.id, expectedVersion: deal.version, stageId: "proposal" },
        founders.mehroz,
      ),
    );
    const olderArtifact = await f.completeResearch(older.id, "# Delayed older result");
    ok<Activity>(
      f.ops.run(
        "crm.activity.add",
        { ...resultInput(ref, older.id, olderArtifact), at: "2026-10-02T09:01:00.000Z" },
        founders.usman,
      ),
    );
    expect(f.jobs.finish(newer.id, "failed", "Delayed stale failure")).toBe(false);
    expect(f.jobs.begin(newer.id)).toBe(false);
    expect(f.jobs.get(newer.id)?.state).toBe("succeeded");
    expect(f.store.getDeal(deal.id)).toEqual(advanced);
    expect(
      f.ops.run(
        "crm.deal.move",
        { id: deal.id, expectedVersion: deal.version, stageId: "qualified" },
        founders.usman,
      ),
    ).toMatchObject({ ok: false, code: "conflict" });
    expect(f.store.snapshot().activities.filter((a) => a.kind === "agent-result")).toHaveLength(2);
  });

  test("09 saved result links resolve the intended record, artifact page and exact file", async () => {
    const f = fixture();
    const { ref } = account(f);
    const job = f.submitResearch(ref);
    const content = `# Contract result\nThis result belongs to ${crmRefString(ref)}.\n`;
    const artifact = await f.completeResearch(job.id, content);
    const saved = f.ops.run("crm.activity.add", resultInput(ref, job.id, artifact), founders.usman);
    ok<Activity>(saved);
    expect(ok<Deal>(recordFromHref(f, saved.href)).id).toBe(ref.id);
    expect(new URL(saved.href, "http://localhost").searchParams.get("tab")).toBe("timeline");
    const file = await f.openArtifact(artifactHref(artifact)!);
    expect(file.status).toBe(200);
    expect(file.text).toBe(content);
    const page = await f.openArtifact(artifactHref(`artifact:${job.id}`)!);
    expect(page.status).toBe(200);
    expect(page.text).toContain(ref.id);
    expect((await f.openArtifact(artifactHref(artifact)!, founders.mehroz)).status).toBe(404);
    expect((await f.openArtifact(artifactHref(artifact)!, null)).status).toBe(401);
    expect(artifactHref(`artifact:${job.id}/../secret`)).toBeNull();
  });

  test("10 unauthorised HTTP mutations are denied before the real store is opened or changed", async () => {
    const f = fixture();
    const before = f.store.snapshot();
    const token = "synthetic-contract-page-token";
    let principal: Principal | null = null;
    let opens = 0;
    const middleware = createCrmMiddleware({
      root: f.dir,
      token,
      role: () => "server",
      readOnly: () => false,
      principal: () => principal,
      service: () => {
        opens++;
        return {
          snapshot: () => f.store.snapshot(),
          resolveLegacyLead: (id) => f.store.resolveLegacyLead(id),
          operations: f.ops,
        };
      },
    });
    const body = { name: "crm.company.create", input: { name: "Unauthorised fixture" } };
    const post = (headers: Record<string, string> = {}) =>
      invokeHandler(middleware.handle, { url: "/__crm/ops", method: "POST", body, headers });
    expect((await post()).status).toBe(401);
    principal = { ...founders.usman, via: "companion", actor: "process" };
    expect((await post()).status).toBe(403);
    principal = founders.mehroz;
    expect((await post({ "x-claude-os-token": pageTokenFor(founders.usman, token) })).status).toBe(
      403,
    );
    expect(
      (
        await post({
          "x-claude-os-token": pageTokenFor(founders.mehroz, token),
          origin: "https://foreign.example.test",
        })
      ).status,
    ).toBe(403);
    principal = {
      personId: "mehroz",
      via: "tailnet-person",
      actor: "process",
      displayName: "Mehroz",
    };
    expect((await post({ "x-claude-os-token": pageTokenFor(principal, token) })).status).toBe(403);
    expect(opens).toBe(0);
    expect(f.store.snapshot()).toEqual(before);
    principal = founders.mehroz;
    expect((await post({ "x-claude-os-token": pageTokenFor(principal, token) })).status).toBe(200);
    expect(opens).toBe(1);
    expect(f.store.snapshot().companies).toHaveLength(1);
  });

  test("11 founder attribution and verified agent attribution stay distinct and cannot be spoofed", async () => {
    const f = fixture();
    const { ref } = account(f);
    const note = {
      ref,
      eventId: "synthetic:founder-note",
      kind: "note",
      title: "Founder scope correction",
    };
    const human = ok<Activity>(f.ops.run("crm.activity.add", note, founders.mehroz));
    expect(human.by).toEqual({ personId: "mehroz" });
    expect(
      f.ops.run(
        "crm.activity.add",
        { ...note, eventId: "synthetic:spoof-founder", by: { personId: "usman" } },
        founders.mehroz,
      ),
    ).toMatchObject({ ok: false, code: "restricted" });
    const job = f.submitResearch(ref);
    const pendingInput = resultInput(ref, job.id, `artifact:${job.id}/report.md`);
    expect(f.ops.run("crm.activity.add", pendingInput, founders.usman)).toMatchObject({
      ok: false,
      code: "restricted",
    });
    const artifact = await f.completeResearch(job.id);
    const agent = ok<Activity>(
      f.ops.run("crm.activity.add", resultInput(ref, job.id, artifact), founders.usman),
    );
    expect(agent.by).toEqual({ agent: "Research", jobId: job.id });
    expect(
      f.ops.run(
        "crm.activity.add",
        resultInput(ref, job.id, artifact, "synthetic:wrong-owner"),
        founders.mehroz,
      ),
    ).toMatchObject({ ok: false, code: "restricted" });
    expect(
      f.ops.run(
        "crm.activity.add",
        {
          ...pendingInput,
          eventId: "synthetic:wrong-agent",
          by: { agent: "Unregistered agent", jobId: job.id },
        },
        founders.usman,
      ),
    ).toMatchObject({ ok: false, code: "restricted" });
    expect(JSON.stringify(f.store.snapshot())).not.toContain("synthetic-contract-session");
  });

  test("12 service interruption rolls back partial work, recovers once, and preserves committed results", () => {
    const f = fixture();
    const enquiry = {
      eventId: "synthetic:recover:enquiry",
      trigger: "enquiry.received" as const,
      at: CONTRACT_AT,
      payload: {
        companyName: "Recovered synthetic enquiry",
        contactName: "Alex Example",
        provider: "synthetic-form",
        providerEventId: "recover-1",
      },
    };
    const createTask = f.store.createTask.bind(f.store);
    f.store.createTask = () => {
      throw new Error("Synthetic storage interruption");
    };
    const failed = f.automations.accept(enquiry, founders.usman);
    expect(failed.ok).toBe(false);
    expect(f.store.snapshot().companies).toHaveLength(0);
    expect(f.store.snapshot().contacts).toHaveLength(0);
    expect(f.store.snapshot().activities).toHaveLength(0);
    expect(f.jobs.get(failed.jobId!)?.state).toBe("failed");
    f.store.createTask = createTask;
    f.reopen();
    const recovered = f.automations.accept(enquiry, founders.usman);
    expect(recovered.ok, recovered.text).toBe(true);
    expect(recovered.jobId).not.toBe(failed.jobId);
    expect(f.automations.accept(enquiry, founders.usman).duplicate).toBe(true);
    expect(f.store.snapshot().companies).toHaveLength(1);
    expect(f.store.snapshot().contacts).toHaveLength(1);
    expect(f.store.snapshot().tasks).toHaveLength(1);
    const company = f.store.snapshot().companies[0];
    const meeting = {
      eventId: "synthetic:recover:ack",
      trigger: "meeting.completed" as const,
      at: CONTRACT_AT,
      ref: { kind: "company" as const, id: company.id },
      payload: { nextAction: "Confirm the saved scope" },
    };
    const finish = f.jobs.finish.bind(f.jobs);
    f.jobs.finish = () => {
      throw new Error("Synthetic lost acknowledgement");
    };
    const committed = f.automations.accept(meeting, founders.usman);
    expect(committed.ok).toBe(true);
    f.jobs.finish = finish;
    f.reopen();
    f.jobs.recover();
    expect(
      new CrmAutomations({ store: f.store, jobs: f.jobs }).accept(meeting, founders.usman)
        .duplicate,
    ).toBe(true);
    expect(f.store.snapshot().tasks).toHaveLength(2);
    expect(f.jobs.get(committed.jobId!)?.state).toBe("unknown");
    expect(f.jobs.begin(committed.jobId!)).toBe(false);
  });

  test("13 a consistent backup restores CRM relationships, versions, Jobs identity and saved results", async () => {
    const f = fixture(true);
    const { company, deal, ref } = account(f);
    const contact = ok<Contact>(
      f.ops.run(
        "crm.contact.add",
        { companyId: company.id, name: "Alex Example" },
        founders.mehroz,
      ),
    );
    ok<Deal>(
      f.ops.run(
        "crm.deal.update",
        { id: deal.id, expectedVersion: deal.version, patch: { contactIds: [contact.id] } },
        founders.usman,
      ),
    );
    const currentDeal = f.store.getDeal(deal.id)!;
    ok<Deal>(
      f.ops.run(
        "crm.deal.move",
        { id: deal.id, expectedVersion: currentDeal.version, stageId: "won" },
        founders.usman,
      ),
    );
    const project = f.store.snapshot().projects.find((p) => p.dealId === deal.id)!;
    const task = ok<Task>(
      f.ops.run(
        "crm.task.create",
        {
          companyId: company.id,
          dealId: deal.id,
          projectId: project.id,
          contactId: contact.id,
          title: "Confirm launch",
          kind: "promise",
        },
        founders.mehroz,
      ),
    );
    const job = f.submitResearch(ref);
    const artifact = await f.completeResearch(
      job.id,
      "# Restored synthetic deliverable\nAll links preserved.",
    );
    const activity = ok<Activity>(
      f.ops.run("crm.activity.add", resultInput(ref, job.id, artifact), founders.usman),
    );
    const document = ok<Document>(
      f.ops.run(
        "crm.document.create",
        {
          companyId: company.id,
          dealId: deal.id,
          projectId: project.id,
          title: "Saved delivery result",
          kind: "deliverable",
          artifact,
        },
        founders.usman,
      ),
    );
    const before = f.store.snapshot();
    const jobBefore = f.jobs.get(job.id);
    const originalRows = legacyRows(f.db);
    const destination = join(f.dir, "verified-backup");
    f.backup(destination);
    ok<Project>(
      f.ops.run(
        "crm.project.update",
        { id: project.id, expectedVersion: project.version, patch: { status: "completed" } },
        founders.mehroz,
      ),
    );
    const restored = new BusinessContractFixture({ dir: destination });
    fixtures.push(restored);
    expect(restored.store.snapshot()).toEqual(before);
    expect(legacyRows(restored.db)).toEqual(originalRows);
    expect(restored.jobs.get(job.id)).toEqual(jobBefore);
    expect(restored.store.getTask(task.id)).toMatchObject({
      companyId: company.id,
      dealId: deal.id,
      projectId: project.id,
      contactId: contact.id,
    });
    expect(restored.store.getDocument(document.id)?.versions[0].artifact).toBe(artifact);
    expect(restored.store.snapshot().activities.find((a) => a.id === activity.id)?.by).toEqual({
      agent: "Research",
      jobId: job.id,
    });
    expect(restored.store.resolveLegacyLead(7)).toEqual({
      kind: "company",
      id: "legacy-company-7",
    });
    expect(restored.db.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    expect(restored.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    const backedUpJobs = new Database(join(destination, "jobs.sqlite"), { readonly: true });
    try {
      expect(backedUpJobs.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    } finally {
      backedUpJobs.close();
    }
    const opened = await restored.openArtifact(artifactHref(artifact)!);
    expect(opened.status).toBe(200);
    expect(opened.text).toContain("All links preserved.");
  });
});

test.todo(
  "Claude-owned live integration: persist subjects on existing Jobs and filter GET /__jobs?subject=crm:deal:<id>; fake-reader contracts above do not establish this",
  () => {
    const f = fixture();
    const { ref } = account(f);
    const input = {
      kind: "command" as const,
      principal: founders.usman,
      targetDeviceId: "synthetic-computer",
      title: "Real subjects integration probe",
      subjects: [crmRefString(ref)],
    };
    // The extra contract field is deliberately passed to the real service, never its fake reader.
    const job = f.jobs.create(input);
    const restored = f.jobs.get(job.id) as typeof job & { subjects?: string[] };
    expect(restored.subjects).toEqual(input.subjects);
    const unrelated = { ...input, subjects: ["crm:company:unrelated"] };
    f.jobs.create(unrelated);
    const filter = { subject: crmRefString(ref), limit: 50 };
    expect(f.jobs.list(filter).map((item) => item.id)).toEqual([job.id]);
  },
);
