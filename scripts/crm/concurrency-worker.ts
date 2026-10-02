// Disposable-process test helper; never starts a server or contacts a provider.
import { existsSync, writeFileSync } from "node:fs";
import { Database } from "bun:sqlite";
import { CrmStore } from "./store";
import { CrmAutomations } from "./automation";
import { JobService } from "../jobs/service";
import { join, dirname } from "node:path";
const [mode, file, barrier, id] = process.argv.slice(2);
if (!mode || !file || !barrier)
  throw new Error("This helper requires explicit disposable test paths.");
writeFileSync(`${barrier}.${process.pid}.ready`, "ready");
while (!existsSync(barrier)) await Bun.sleep(5);
const db = new Database(file);
db.exec("PRAGMA busy_timeout=10000");
try {
  const store = new CrmStore(db);
  const by = { personId: "usman" as const };
  const jobs =
    mode === "automation"
      ? new JobService({ path: join(dirname(file), "jobs.sqlite") })
      : undefined;
  const result =
    mode === "automation"
      ? new CrmAutomations({ store, jobs }).accept(
          {
            eventId: "synthetic:concurrent-enquiry",
            trigger: "enquiry.received",
            at: "2026-10-02T08:00:00Z",
            payload: {
              companyName: "Synthetic concurrently enquired company",
              contactName: "Example Person",
              email: "concurrent@example.test",
              provider: "synthetic-form",
              providerEventId: "same-message",
            },
          },
          { personId: "usman", via: "paired-session", actor: "human", displayName: "Usman" },
        )
      : mode === "migration"
        ? store.snapshot().companies.length
        : mode === "activity"
          ? store.addActivity(
              {
                ref: { kind: "company", id },
                eventId: "synthetic:concurrent-retry",
                kind: "note",
                title: "One durable synthetic event",
                note: "Exact repeated payload",
              },
              by,
            ).id
          : store.updateCompany(id, { notes: "Concurrent founder edit" }, 1, by).version;
  console.log(JSON.stringify({ ok: true, result }));
  jobs?.close();
} catch (e) {
  console.log(
    JSON.stringify({ ok: false, code: (e as { code?: string }).code, error: (e as Error).message }),
  );
} finally {
  db.close();
}
