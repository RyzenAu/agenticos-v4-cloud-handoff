// A plain Jarvis command never carries CRM subjects: a question asked on a CRM page must not become a CRM activity. Subjects belong to bot/agent jobs.
import { afterEach, expect, test } from "bun:test";
import type { CommandBody } from "./contracts";
import { mehroz, rig as rigWith } from "./r3-rig";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

test("a command sent from a CRM page, with explicit subjects, leaves a job with no CRM subject", async () => {
  const r = rigWith({}, cleanups);
  const body = {
    utterance: "open example.com",
    source: "typed",
    subjects: ["crm:deal:d1"],
    pageContext: {
      version: 1,
      page: { path: "/crm", destination: "work", title: "CRM" },
      selection: { kind: "client", id: "c1", label: "Synthetic Co", to: "/crm", search: { ref: "crm:company:c1" } },
      focused: null,
      visible: [],
      sources: [],
      job: null,
      providers: [],
      at: Date.now(),
    },
  } as unknown as CommandBody;
  const events: unknown[] = [];
  await r.service.run({ principal: mehroz, body }, (e) => void events.push(e));
  const jobs = r.jobs.list();
  expect(jobs.length).toBeGreaterThan(0);
  for (const job of jobs) expect(r.jobs.get(job.id)!.subjects).toBeUndefined();
});
