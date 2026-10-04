/**
 * R12 UI: browser-side FIXTURES for the screenshot and interaction scripts (never the hub's data). Synthetic only.
 *
 *  - journeyFixture: one synthetic "lead-to-proposal" journey in the shape R12-DEPARTMENTS-CONTRACT.md asks the backend for
 *    (GET /__journeys). The route doesn't exist on the hub yet (Dot's LEAD-JOURNEY-20261004 task), so the browser is given it; its
 *    steps point at the REAL seeded jobs (scripts/r12-ui-seed.ts), so every link in it opens something that exists.
 *  - computerFixture: two clearly-synthetic shared computers and a drawn desktop, so the computer pane has something to show
 *    (a synthetic hub has no computer host). Copied from scripts/acceptance/r11/ui-core-shots.ts.
 */
import type { Page } from "playwright-core";

type JobRow = { id: string; title: string; state: string; bot?: string | null; subjects?: string[]; createdAt: string; updatedAt: string };

export async function hubToken(base: string): Promise<string> {
  return ((await (await fetch(`${base}/__token`)).json()) as { token: string }).token;
}

export async function journeyFixture(base: string) {
  const token = await hubToken(base);
  const H = { "x-claude-os-token": token };
  const jobs = ((await (await fetch(`${base}/__jobs?limit=100`, { headers: H })).json()) as { jobs: JobRow[] }).jobs;
  const head = (await (await fetch(`${base}/__operator/screen/command/thread?after=999999999`, { headers: H })).json().catch(() => ({}))) as { conversationId?: string };
  const research = jobs.find((j) => j.bot === "research" && /nearest competitors/.test(j.title));
  const concept = jobs.find((j) => j.bot === "designer" && /Homepage concept/.test(j.title));
  if (!research || !concept) throw new Error("Seed first: bun scripts/r12-ui-seed.ts");
  const subjects = research.subjects ?? [];
  const t = (iso: string) => Date.parse(iso);
  const name = research.title.replace(/^Research: nearest competitors for /, "");
  const journey = {
    id: "journey-synthetic-0001",
    kind: "lead-to-proposal",
    title: `Lead to proposal: ${name}`,
    conversationId: head.conversationId ?? null,
    requestedBy: "usman",
    subjects,
    state: "running",
    createdAt: t(research.createdAt) - 60_000,
    updatedAt: t(concept.updatedAt),
    steps: [
      {
        id: "research", index: 0, title: "Research the business",
        owner: { department: "research", agent: "research" }, from: { department: "jarvis", agent: null },
        inputs: [{ label: "CRM record", ref: subjects[0] ?? null }], expectedOutput: "A sourced report: competitors, booking, gaps",
        dependsOn: [], state: "completed", acknowledgedAt: t(research.createdAt), startedAt: t(research.createdAt), jobId: research.id,
        completion: { at: t(research.updatedAt), jobId: research.id, summary: "Three competitors compared; Saturday hours are the clearest gap.", outputs: [{ label: "Competitor comparison", href: `/__computers/artifacts/${research.id}` }] },
        failure: null, waitingFor: null,
      },
      {
        id: "concept", index: 1, title: "Make a homepage concept",
        owner: { department: "design", agent: "designer" }, from: { department: "research", agent: "research" },
        inputs: [{ label: "Research report", ref: `step:research` }, { label: "CRM record", ref: subjects[0] ?? null }], expectedOutput: "A concept preview linked to the CRM record",
        dependsOn: ["research"], state: "running", acknowledgedAt: t(concept.createdAt), startedAt: t(concept.createdAt), jobId: concept.id,
        completion: null, failure: null, waitingFor: null,
      },
      {
        id: "proposal", index: 2, title: "Draft the proposal",
        owner: { department: "sales", agent: "outreach" }, from: { department: "design", agent: "designer" },
        inputs: [{ label: "Concept preview", ref: "step:concept" }, { label: "Deal", ref: subjects[1] ?? null }], expectedOutput: "A draft proposal on the deal. Nothing is sent",
        dependsOn: ["concept"], state: "queued", acknowledgedAt: null, startedAt: null, jobId: null, completion: null, failure: null, waitingFor: null,
      },
      {
        id: "report", index: 3, title: "Report back in this conversation",
        owner: { department: "jarvis", agent: null }, from: { department: "sales", agent: "outreach" },
        inputs: [{ label: "Report, concept and draft", ref: "step:proposal" }], expectedOutput: "One message with every link",
        dependsOn: ["proposal"], state: "queued", acknowledgedAt: null, startedAt: null, jobId: null, completion: null, failure: null, waitingFor: null,
      },
    ],
  };
  return { journey, list: { journeys: [journey] } };
}

/** Serve the journey fixture for GET /__journeys and /__journeys/<id>. */
export async function routeJourneys(page: Page, fx: Awaited<ReturnType<typeof journeyFixture>>) {
  await page.route(/\/__journeys(\?|$)/, (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(fx.list) }));
  await page.route(/\/__journeys\/[^/?]+/, (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ journey: fx.journey }) }));
}

const fixtureComputer = (name: string, label: string, over: Record<string, unknown> = {}) => ({ name, id: `fx-${name}`, label, kind: "cloud-computer", owner: "shared", adapter: "wsl", state: "online", desired: "running", desktop: true, capabilities: ["browser"], assigned: null, controller: { kind: null, who: null, jobId: null, expiresAt: null, epoch: null }, takeoverPending: null, paused: null, resource: null, lastSeen: Date.now(), failure: null, recoveries: 0, createdBy: "usman", createdAt: Date.now(), viewer: { snapshot: true, vnc: false }, ...over });
const DESKTOP_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="800"><rect width="1280" height="800" fill="#20242b"/><rect x="0" y="0" width="1280" height="44" fill="#2d323b"/><circle cx="26" cy="22" r="7" fill="#c7a35a"/><rect x="60" y="12" width="520" height="20" rx="10" fill="#3a404b"/><rect x="80" y="100" width="760" height="36" rx="6" fill="#3a404b"/><rect x="80" y="160" width="1120" height="14" rx="4" fill="#343a44"/><rect x="80" y="190" width="980" height="14" rx="4" fill="#343a44"/><rect x="80" y="280" width="540" height="300" rx="10" fill="#2a2f38"/><rect x="660" y="280" width="540" height="300" rx="10" fill="#2a2f38"/><text x="640" y="700" fill="#8b93a1" font-family="sans-serif" font-size="26" text-anchor="middle">Synthetic desktop (screenshot fixture)</text></svg>`;

export async function computerFixture(page: Page) {
  await page.route(/\/__computers$/, async (r) => {
    const res = await r.fetch().catch(() => null);
    const body = res ? await res.json().catch(() => ({})) : {};
    await r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...body, computers: [fixtureComputer("research", "Research computer (synthetic)"), fixtureComputer("builder", "Builder computer (synthetic)")] }) });
  });
  await page.route(/\/__computers\/[^/]+\/screenshot/, (r) => r.fulfill({ status: 200, contentType: "image/svg+xml", body: DESKTOP_SVG }));
}
