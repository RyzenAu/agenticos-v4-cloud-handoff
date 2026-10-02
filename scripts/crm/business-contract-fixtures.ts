/** Disposable acceptance fixtures. No runtime singletons, sockets, processes or provider calls. */
import { Database } from "bun:sqlite";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { crmRefString, type CrmRef } from "../../src/lib/crm-ref";
import { createArtifactStore } from "../computers/artifacts";
import { createComputersRoutes, type ComputersRoutesOptions } from "../computers/routes";
import type { Principal } from "../identity/principal";
import { JobService } from "../jobs/service";
import { openCrm } from "../leads/crm";
import { CrmAutomations } from "./automation";
import { createCrmOperations } from "./ops";
import { CrmStore } from "./store";

export const CONTRACT_AT = "2026-10-02T09:00:00.000Z";
export const founders: Record<"usman" | "mehroz", Principal> = {
  usman: {
    personId: "usman",
    via: "paired-session",
    actor: "human",
    displayName: "Usman",
    sessionId: "synthetic-contract-session-usman",
  },
  mehroz: {
    personId: "mehroz",
    via: "paired-session",
    actor: "human",
    displayName: "Mehroz",
    sessionId: "synthetic-contract-session-mehroz",
  },
};

export function seedLegacyContract(db: Database) {
  db.exec(`
    INSERT INTO leads(id,place_id,vertical,source,attribution,name,phone,website,website_check,owner,status,next_at,created_at)
      VALUES(7,'osm:node/7','dental','osm','Synthetic directory','Original clinic','0291112222',
        'https://old.example.test','found','usman','proposal','2026-10-05T09:00:00.000Z','2026-09-01T09:00:00.000Z');
    INSERT INTO leads(id,place_id,vertical,source,name,excluded,excluded_reason,merged_into,status,created_at)
      VALUES(9,'osm:node/9','dental','osm','Duplicate clinic',1,'duplicate of #7',7,'lost','2026-09-01T09:00:00.000Z');
    INSERT INTO lead_deals(lead_id,setup_cents,monthly_cents,probability,expected_close,contact_pref)
      VALUES(7,220000,11000,0.6,'2026-10-15','Email only');
    INSERT INTO activities(id,lead_id,at,kind,outcome,note,by)
      VALUES(21,7,'2026-09-02T09:00:00.000Z','call','interested','Qualified by the founder','usman'),
            (22,7,'2026-09-03T09:00:00.000Z','meeting','proposal','Agreed five-page scope','mehroz');
    INSERT INTO activity_events(event_id,activity_id,lead_id) VALUES('synthetic:legacy:meeting',22,7);
    INSERT INTO kickoffs(lead_id,scope,checklist,by)
      VALUES(7,'Five approved pages','{"assets":["Logo"],"access":["DNS approval"],"milestones":[{"name":"Build","state":"partial","note":"Started"}]}','usman');
  `);
}

export function legacyRows(db: Database) {
  return Object.fromEntries(
    ["leads", "activities", "activity_events", "lead_deals", "kickoffs", "optouts"].map((table) => [
      table,
      db.query(`SELECT * FROM ${table} ORDER BY rowid`).all(),
    ]),
  );
}

/** Only the owning-Jobs integration reader is fake. CRM operations and durable Jobs are real.
 * This map intentionally does NOT assert production subjects persistence/filtering exists.
 */
export class BusinessContractFixture {
  readonly dir: string;
  readonly owningJobs = new Map<string, { agent: string; subjects: string[] }>();
  legacyBeforeMigration?: ReturnType<typeof legacyRows>;
  db!: Database;
  store!: CrmStore;
  jobs!: JobService;
  automations!: CrmAutomations;
  ops!: ReturnType<typeof createCrmOperations>;
  artifacts!: ReturnType<typeof createArtifactStore>;
  private closed = true;

  constructor(options: { legacy?: boolean; dir?: string } = {}) {
    this.dir = options.dir ?? mkdtempSync(join(tmpdir(), "crm-business-contract-"));
    mkdirSync(this.dir, { recursive: true });
    this.open(options.legacy === true);
  }

  private open(legacy = false) {
    this.db = openCrm(join(this.dir, "crm.sqlite"));
    if (legacy) {
      seedLegacyContract(this.db);
      this.legacyBeforeMigration = legacyRows(this.db);
    }
    this.store = new CrmStore(this.db, { now: () => CONTRACT_AT });
    this.jobs = new JobService({
      path: join(this.dir, "jobs.sqlite"),
      now: () => Date.parse(CONTRACT_AT),
      snapshotMs: 0,
    });
    this.artifacts = createArtifactStore(join(this.dir, "artifacts"), () =>
      Date.parse(CONTRACT_AT),
    );
    this.automations = new CrmAutomations({
      store: this.store,
      jobs: this.jobs,
      now: () => CONTRACT_AT,
    });
    this.ops = createCrmOperations({
      store: this.store,
      automations: this.automations,
      now: () => CONTRACT_AT,
      verifyAgent: (by, principal, ref) => {
        const known = this.owningJobs.get(by.jobId);
        const job = this.jobs.get(by.jobId);
        return (
          !!known &&
          known.agent === by.agent &&
          known.subjects.includes(crmRefString(ref)) &&
          job?.principal.personId === principal.personId &&
          job.state === "succeeded"
        );
      },
    });
    this.closed = false;
  }

  submitResearch(ref: CrmRef, principal = founders.usman) {
    const job = this.jobs.create({
      kind: "command",
      principal,
      targetDeviceId: "synthetic-computer",
      title: "Synthetic research result",
    });
    this.owningJobs.set(job.id, { agent: "Research", subjects: [crmRefString(ref)] });
    return job;
  }

  async completeResearch(
    jobId: string,
    content = "# Synthetic research\nVerified fixture result.",
  ) {
    const job = this.jobs.get(jobId);
    if (!job || !this.owningJobs.has(jobId)) throw new Error("Unknown synthetic research request");
    await this.jobs.run(jobId, async (ctx) => {
      const saved = this.artifacts.save({
        jobId,
        personId: job.principal.personId,
        kind: "research",
        title: "Synthetic research",
        summary: "Fixture output only",
        host: "synthetic",
        computer: "synthetic-computer",
        outcome: "complete",
        main: "report.md",
        files: [{ name: "report.md", data: content }],
      });
      if (!saved.ok) throw new Error(saved.reason);
      ctx.step({ intent: "Save fixture report", executor: "synthetic", ms: 0, outcome: "ok" });
      return { ok: true, note: "Synthetic result saved" };
    });
    return `artifact:${jobId}/report.md`;
  }

  close() {
    if (this.closed) return;
    this.jobs.close();
    this.store.close();
    this.db.close();
    this.closed = true;
  }
  reopen() {
    this.close();
    this.open();
  }
  dispose() {
    this.close();
    rmSync(this.dir, { recursive: true, force: true });
  }

  backup(destination: string) {
    mkdirSync(destination, { recursive: true });
    this.db.query("VACUUM INTO ?").run(join(destination, "crm.sqlite"));
    const jobsCopy = new Database(join(this.dir, "jobs.sqlite"), { readonly: true });
    try {
      jobsCopy.query("VACUUM INTO ?").run(join(destination, "jobs.sqlite"));
    } finally {
      jobsCopy.close();
    }
    cpSync(join(this.dir, "artifacts"), join(destination, "artifacts"), { recursive: true });
  }

  async openArtifact(href: string, principal: Principal | null = founders.usman) {
    // Artifact GET only: the existing route runs its identity gate and real ArtifactStore lookup.
    const routes = createComputersRoutes({
      artifacts: this.artifacts,
      devices: {
        identify: () => ({
          loopbackSocket: true,
          local: true,
          tailnet: false,
          principal: principal ? { personId: principal.personId } : null,
          verified: principal,
        }),
      } as unknown as ComputersRoutesOptions["devices"],
      computers: {} as ComputersRoutesOptions["computers"],
    });
    return invokeHandler(routes.handle, { url: href });
  }
}

/** A stream and response capture exercise the real HTTP handlers without binding a socket. */
export async function invokeHandler(
  handle: (req: IncomingMessage, res: ServerResponse, next: () => void) => unknown,
  input: { url: string; method?: string; body?: unknown; headers?: Record<string, string> },
) {
  const text = input.body === undefined ? "" : JSON.stringify(input.body);
  const req = Object.assign(Readable.from(text ? [Buffer.from(text)] : []), {
    url: input.url,
    method: input.method ?? "GET",
    headers: { host: "localhost", "content-type": "application/json", ...input.headers },
    socket: { remoteAddress: "127.0.0.1" },
  }) as unknown as IncomingMessage;
  const output = { status: 200, text: "", headers: {} as Record<string, string> };
  const res = {
    statusCode: 200,
    headersSent: false,
    writableEnded: false,
    setHeader(name: string, value: unknown) {
      output.headers[name.toLowerCase()] = String(value);
    },
    end(data?: string | Uint8Array) {
      output.status = this.statusCode;
      output.text = data === undefined ? "" : Buffer.from(data).toString("utf8");
      this.headersSent = true;
      this.writableEnded = true;
    },
  };
  await handle(req, res as unknown as ServerResponse, () => {
    res.statusCode = 404;
    res.end("Not found");
  });
  return output;
}
