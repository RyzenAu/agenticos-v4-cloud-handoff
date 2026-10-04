#!/usr/bin/env bun
/**
 * R12 UI structure pass: seed a REALISTIC SYNTHETIC state for Home, Jarvis and Departments on a synthetic hub that is already running
 * (made by `bun scripts/acceptance/r7/hub.ts seed` + `start`). Everything here is invented: no real client, person or vault content.
 *
 *   bun scripts/r12-ui-seed.ts [port] [data dir]     (defaults 8150, D:\AgenticOS-r12-data\ui)
 *
 * What it adds (the Research department is the fully populated one):
 *   - CRM: three synthetic companies (one with a very long name), each with a deal, so jobs can carry CRM subjects
 *   - bots: "Outreach" (Sales/CRM) and "Designer" (Design/Websites) beside the seeded Research and Builder
 *   - Research jobs in every state the UI must tell apart: finished with a saved result (x2), running, waiting for a yes, failed, queued
 *   - a Designer job about the same client record as a finished Research job (the Research -> Design hand-off the page derives)
 *   - an Outreach draft with a saved result
 *   - the Jarvis thread: the request, the hand-offs and their progress/results
 *
 * Jobs, saved results and thread entries are written straight into the synthetic data folder's own stores (the hub reads them from disk);
 * a running or waiting job stays that way because nothing on a synthetic hub runs it. Restarting the hub turns them into "outcome unknown"
 * (the hub's restart recovery), so seed a fresh folder for a new run rather than restarting.
 */
import { join } from "node:path";
import { existsSync } from "node:fs";
import { JobService } from "./jobs/service";
import { createArtifactStore } from "./computers/artifacts";
import { conversationStore } from "./conversations";

const port = Number(process.argv[2] ?? 8150);
const data = process.argv[3] ?? "D:\\AgenticOS-r12-data\\ui";
if (port === 8081 || port < 8120 || port > 8199) throw new Error("synthetic hub ports only (8120-8199)");
if (!/AgenticOS-r\d+-data/i.test(data) || /\.operator-data|mu-hub|production/i.test(data) || !existsSync(join(data, ".gate-seed.json"))) throw new Error(`Refusing ${data}: not a synthetic seeded data folder.`);
process.env.MU_DATA_DIR = data; // every store below reads its folder from this

const base = `http://127.0.0.1:${port}`;
const token = ((await (await fetch(`${base}/__token`)).json()) as { token: string }).token;
const H = { "content-type": "application/json", "x-claude-os-token": token };
const crm = async (name: string, input: unknown) => {
  const r = (await (await fetch(`${base}/__crm/ops`, { method: "POST", headers: H, body: JSON.stringify({ name, input }) })).json()) as { ok: boolean; data?: { id: string }; error?: string };
  if (!r.ok) throw new Error(`crm ${name}: ${String(r.error).slice(0, 120)}`);
  return r.data!;
};

// ---- CRM records the work is about
const COMPANIES = [
  { name: "Synthetic Orchard Hills Family Dental and Orthodontic Specialists Pty Ltd", deal: "Website rebuild and booking flow", service: "website" },
  { name: "Synthetic Blacktown Conveyancing and Property Law Group", deal: "Receptionist rollout", service: "receptionist" },
  { name: "Synthetic Penrith Plumbing and Gas", deal: "Website and local search", service: "website" },
] as const;
const refs: { company: string; deal: string; name: string }[] = [];
for (const [i, c] of COMPANIES.entries()) {
  const co = await crm("crm.company.create", { name: c.name, emails: [`hello${i}@example.test`], notes: "synthetic (r12 seed)" });
  const d = await crm("crm.deal.create", { companyId: co.id, title: `${c.deal} for ${c.name.replace("Synthetic ", "")}`.slice(0, 120), service: c.service, gstTreatment: "exclusive", commercialBasis: "pending" });
  refs.push({ company: `crm:company:${co.id}`, deal: `crm:deal:${d.id}`, name: c.name.replace("Synthetic ", "") });
}

// ---- two more bots, so the Sales and Design departments have an agent each
for (const b of [
  { id: "outreach", name: "Outreach", purpose: "Drafts first-contact emails and call notes for new leads. It never sends anything itself.", instructions: "Draft only. Keep to the approved prices. Say what you could not confirm." },
  { id: "designer", name: "Designer", purpose: "Turns a research brief into a homepage concept and a preview for review.", instructions: "Work from the research brief. Show the concept as a preview; never publish." },
]) {
  const r = await fetch(`${base}/__agents/bots`, { method: "POST", headers: H, body: JSON.stringify(b) });
  if (r.status !== 201 && r.status !== 409) throw new Error(`bot ${b.id}: HTTP ${r.status} ${(await r.text()).slice(0, 160)}`);
}

// ---- jobs, saved results and the Jarvis thread, written into the synthetic folder's own stores
let clock = Date.now() - 6 * 3600_000;
const at = (minsFromStart: number) => (clock = Date.now() - 6 * 3600_000 + minsFromStart * 60_000);
const jobs = new JobService({ path: join(data, "jobs.sqlite"), snapshotMs: 0, now: () => clock });
const artifacts = createArtifactStore(join(data, "computers", "artifacts"));
const conversations = conversationStore(data);
const thread = conversations.ensureThread({ personId: "usman" })!;
const principal = { personId: "usman", via: "loopback-owner", actor: "human", displayName: "Usman" } as never;
const short = (id: string) => id.slice(0, 8);
const iso = () => new Date(clock).toISOString();
const entry = (jobId: string, key: string, state: string, text: string) => conversations.appendEntry(thread.id, { key: `${jobId}:${key}`, jobId, state, text, at: iso() });

type Step = { intent: string; outcome?: "ok" | "failed" | "note" };
function job(o: { bot: string; device: string; title: string; subjects?: string[]; start: number; steps: Step[]; end: "succeeded" | "failed" | "running" | "awaiting-approval" | "queued"; note?: string; result?: { kind: "research" | "bizprep"; title: string; summary: string; md: string; outcome: "complete" | "partial"; computer: string } }) {
  at(o.start);
  const j = jobs.create({ kind: "control", principal, targetDeviceId: o.device, title: o.title, bot: o.bot, subjects: o.subjects });
  conversations.linkJob(thread.id, { jobId: j.id, kind: "job", title: o.title, state: o.end, at: iso() });
  entry(j.id, "started", "started", `Started: ${o.title} (job ${short(j.id)}).`);
  if (o.end === "queued") return j;
  jobs.begin(j.id);
  o.steps.forEach((s, i) => {
    at(o.start + 4 + i * 6);
    jobs.step(j.id, { intent: s.intent, executor: o.result?.kind ?? "research", ms: 900, outcome: s.outcome ?? "ok" });
    entry(j.id, `step:${i + 1}`, "progress", `Step ${i + 1} of ${o.steps.length}: ${s.intent}`);
  });
  at(o.start + 6 + o.steps.length * 6);
  if (o.end === "running") return j;
  if (o.end === "awaiting-approval") {
    jobs.finish(j.id, "awaiting-approval", o.note);
    entry(j.id, "awaiting-approval", "awaiting-approval", `Waiting for you: ${o.note ?? "it needs your yes to go on"} (job ${short(j.id)})`);
    return j;
  }
  if (o.result) {
    artifacts.save({ jobId: j.id, personId: "usman", kind: o.result.kind, title: o.result.title, summary: o.result.summary, host: "synthetic (r12 seed)", computer: o.result.computer, outcome: o.result.outcome, main: "report.md", files: [{ name: "report.md", data: o.result.md }] });
    entry(j.id, "report:1", "report", `${o.result.summary}\nSaved result: ${o.result.title}\n(job ${short(j.id)})`);
  }
  jobs.finish(j.id, o.end, o.note);
  entry(j.id, o.end, o.end, o.end === "succeeded" ? `Finished: ${o.title}. ${o.note ?? ""} (job ${short(j.id)})` : `Failed: ${o.title}. ${o.note ?? ""} (job ${short(j.id)})`);
  return j;
}

const [dental, conveyancing, plumbing] = refs;
conversations.appendMessage(thread.id, { key: "r12-seed-ask-1", role: "user", text: `Research the three nearest competitors for ${dental.name} and pass what you find to Design for a homepage concept.` });
const competitors = job({
  bot: "research", device: "research", start: 10, end: "succeeded", subjects: [dental.company, dental.deal],
  title: `Research: nearest competitors for ${dental.name}`,
  steps: [{ intent: "Searched public listings for family dental clinics within 8 km" }, { intent: "Read three competitor homepages and their booking pages" }, { intent: "Compared prices shown, booking steps and opening hours" }],
  note: "Saved result: competitor comparison.",
  result: { kind: "research", computer: "research", outcome: "complete", title: "Competitor comparison: Orchard Hills family dental (synthetic)", summary: "Three synthetic competitors compared. Two take bookings online in under a minute; none shows prices. Opening hours on Saturday are the clearest gap.", md: "# Competitor comparison (synthetic)\n\n| Clinic | Online booking | Prices shown | Saturday |\n|---|---|---|---|\n| Synthetic Ridge Dental | Yes, 3 steps | No | 8-12 |\n| Synthetic Creekside Smiles | Yes, 5 steps | No | Closed |\n| Synthetic Hills Dental Care | Phone only | No | 9-1 |\n\n**What to use in the concept:** a one-step booking button above the fold and the Saturday hours stated plainly.\n\nSources: synthetic fixture pages only." },
});
conversations.appendMessage(thread.id, { key: "r12-seed-reply-1", role: "oracle", text: "Research finished the competitor comparison. I've asked Design for a homepage concept based on it." });
job({
  bot: "designer", device: "designer", start: 40, end: "running", subjects: [dental.company, dental.deal],
  title: `Homepage concept for ${dental.name}`,
  steps: [{ intent: "Read the competitor comparison from Research" }, { intent: "Drafted the hero: one-step booking and Saturday hours" }],
});
job({
  bot: "research", device: "research", start: 70, end: "succeeded", subjects: [conveyancing.company],
  title: "Research: conveyancing fee ranges in Western Sydney (synthetic sources)",
  steps: [{ intent: "Collected fee tables from five synthetic firm pages" }, { intent: "Normalised fixed fees and disbursements" }],
  note: "Saved result: fee range table.",
  result: { kind: "research", computer: "research", outcome: "partial", title: "Fee ranges: Western Sydney conveyancing (synthetic)", summary: "Fixed fees ranged from $890 to $1,450 across five synthetic firms. Disbursements were listed by only two, so the totals are partial.", md: "# Fee ranges (synthetic)\n\n- Fixed fee: $890 to $1,450\n- Disbursements listed: 2 of 5\n\n**Partial:** totals can't be compared until disbursements are known." },
});
job({
  bot: "research", device: "research", start: 120, end: "awaiting-approval", subjects: [conveyancing.company, conveyancing.deal],
  title: `Research: check the paid directory listing for ${conveyancing.name}`,
  steps: [{ intent: "Found the directory page that lists the firm" }],
  note: "the directory asks for a sign-in before it shows the listing. Approve to open it read-only, or skip it",
});
job({
  bot: "research", device: "research", start: 150, end: "failed", subjects: [],
  title: "Research: summarise public reviews for Synthetic Castle Hill Smiles",
  steps: [{ intent: "Searched for the review pages", outcome: "failed" }],
  note: "The web search service didn't answer, so no reviews were read. Nothing was saved.",
});
job({
  bot: "research", device: "research", start: 300, end: "running", subjects: [plumbing.company, plumbing.deal],
  title: `Research: local search terms people use for ${plumbing.name}`,
  steps: [{ intent: "Listed the suburbs the business serves" }, { intent: "Collecting the search phrases shown for each suburb" }],
});
job({
  bot: "research", device: "research", start: 330, end: "queued", subjects: [],
  title: "Research: shortlist three headset suppliers for the receptionist trial",
  steps: [],
});
job({
  bot: "outreach", device: "outreach", start: 200, end: "succeeded", subjects: [plumbing.company, plumbing.deal],
  title: `Draft a first-contact email for ${plumbing.name}`,
  steps: [{ intent: "Read the lead's public details and the approved prices" }, { intent: "Drafted the email and two call notes" }],
  note: "Saved result: draft email. Nothing was sent.",
  result: { kind: "bizprep", computer: "outreach", outcome: "complete", title: "Draft email: Penrith Plumbing and Gas (synthetic)", summary: "A short first-contact email offering a website review, plus two call notes. Draft only: nothing was sent.", md: "# Draft email (synthetic)\n\nHi there, we build fast websites for local trades...\n\n_Draft only. Nothing was sent._" },
});
jobs.close();
console.log(JSON.stringify({ seeded: true, crm: refs.length, bots: 2, competitorsJob: competitors.id }));
