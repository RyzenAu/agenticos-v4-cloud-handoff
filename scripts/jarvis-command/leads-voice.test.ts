import { expect, test } from "bun:test";
import { runLeadAction, type LeadsApiLike } from "./leads";

type Row = {
  id: number;
  name: string;
  status: string;
  excluded: boolean;
  vertical: string;
  area: string;
  phone: string;
  emails: string[];
  source: string;
  owner: string;
  pitch: string;
};
const row = (id: number, name: string, extra: Partial<Row> = {}): Row => ({
  id,
  name,
  status: "new",
  excluded: false,
  vertical: "dental",
  area: "Parramatta",
  phone: "",
  emails: [],
  source: "manual",
  owner: "",
  pitch: "website",
  ...extra,
});

/** A fake Leads service with the real one's two relevant behaviours: the palette search is a plain phrase LIKE, and /leads/log ignores a repeated `event`. */
function rig(rows: Row[]) {
  const logs: { lead: number; outcome: string; event?: string }[] = [];
  const seen = new Set<string>();
  const api: LeadsApiLike = {
    async handle(path, method, body: any, params) {
      if (path === "/leads/list")
        return {
          leads: rows.filter((r) => !params.get("status") || r.status === params.get("status")),
        };
      if (path === "/leads/search") {
        const q = (params.get("q") ?? "").toLowerCase();
        return {
          hits: rows
            .filter((r) => r.name.toLowerCase().includes(q))
            .map((r) => ({ group: "leads", leadId: r.id, title: r.name })),
        };
      }
      if (path === "/leads/log" && method === "POST") {
        if (body.event && seen.has(body.event)) return { duplicate: true };
        if (body.event) seen.add(body.event);
        logs.push({ lead: body.lead, outcome: body.outcome, event: body.event });
        rows.find((r) => r.id === body.lead)!.status = body.outcome;
        return { duplicate: false };
      }
      throw new Error(`unexpected ${method} ${path}`);
    },
  };
  return { api, logs };
}
const usman = { personId: "usman" as const };

test("a misheard word order or a missing accent still finds the lead through the Leads search", async () => {
  const { api, logs } = rig([
    row(1, "Synthetic Dental Studio"),
    row(2, "Café Orthodontics", { area: "Penrith" }),
  ]);
  const a = await runLeadAction(
    api,
    { action: "log", lead: "dental synthetic", outcome: "no_answer" },
    usman,
  );
  expect(a).toMatchObject({ ok: true, verified: true });
  expect(a.said).toContain("Synthetic Dental Studio");
  const b = await runLeadAction(
    api,
    { action: "status", lead: "cafe orthodontics", outcome: "interested" },
    usman,
  );
  expect(b).toMatchObject({ ok: true });
  expect(logs.map((l) => l.lead)).toEqual([1, 2]);
});

test("several matches ask which one, and nothing is written", async () => {
  const { api, logs } = rig([row(1, "Synthetic Dental North"), row(2, "Synthetic Dental South")]);
  const r = await runLeadAction(
    api,
    { action: "log", lead: "synthetic dental", outcome: "voicemail" },
    usman,
  );
  expect(r.ok).toBe(false);
  expect(r.said).toMatch(/Which one\?/);
  expect(logs).toHaveLength(0);
  // The exact (folded) name wins over a longer one that contains it.
  const { api: api2, logs: logs2 } = rig([
    row(1, "Synthetic Dental"),
    row(2, "Synthetic Dental South"),
  ]);
  expect(
    (
      await runLeadAction(
        api2,
        { action: "log", lead: "synthetic  DENTAL", outcome: "voicemail" },
        usman,
      )
    ).ok,
  ).toBe(true);
  expect(logs2.map((l) => l.lead)).toEqual([1]);
});

test("the event key is the command's event id, else its job id: a double submit logs once, a genuine second redial logs again, whatever the clock says", async () => {
  const action = { action: "log" as const, lead: "Synthetic Dental Studio", outcome: "no_answer" };
  // The command service answers a repeat of the same words with the SAME job, so both calls carry one job id, even across a minute boundary.
  const { api, logs } = rig([row(1, "Synthetic Dental Studio")]);
  const first = await runLeadAction(api, action, usman, { jobId: "job-1" });
  await new Promise((r) => setTimeout(r, 5));
  const second = await runLeadAction(api, action, usman, { jobId: "job-1" });
  expect(first.ok && second.ok).toBe(true);
  expect(logs.map((l) => l.event)).toEqual(["jarvis:job:job-1"]);
  // Two genuine redials (two commands, two jobs) in the same minute are two logs.
  await runLeadAction(api, action, usman, { jobId: "job-2" });
  expect(logs.map((l) => l.event)).toEqual(["jarvis:job:job-1", "jarvis:job:job-2"]);
  // A client-minted event id for the utterance wins: a replay of it is the same event and a new utterance is a new one.
  const { api: api2, logs: logs2 } = rig([row(1, "Synthetic Dental Studio")]);
  await runLeadAction(api2, action, usman, { eventId: "evt-aaaaaa", jobId: "job-1" });
  await runLeadAction(api2, action, usman, { eventId: "evt-aaaaaa", jobId: "job-9" });
  await runLeadAction(api2, action, usman, { eventId: "evt-bbbbbb", jobId: "job-9" });
  expect(logs2.map((l) => l.event)).toEqual(["jarvis:evt-aaaaaa", "jarvis:evt-bbbbbb"]);
});
