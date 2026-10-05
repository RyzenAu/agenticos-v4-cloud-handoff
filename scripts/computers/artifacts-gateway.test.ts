// "Open saved result" for Dot (5 Oct): through the gateway (tasks.run), the computers route serves Dot its OWN results and agent-bot
// results, with the founders' CSP and sandboxing; the page's links open in place for Dot.
// The routes' real artifact handler over a real artifact store; the caller is what the hub's gate marks a gateway request as.
import { afterAll, describe, expect, test } from "bun:test";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createArtifactStore } from "./artifacts";
import { createComputersRoutes } from "./routes";
import { decide } from "../gateway/policy";

const root = mkdtempSync(join(tmpdir(), "artifacts-gateway-"));
const store = createArtifactStore(join(root, "artifacts"));
const DOT_JOB = "11111111-2222-4333-8444-000000000001";
const BOT_JOB = "11111111-2222-4333-8444-000000000002";
const FOUNDER_JOB = "11111111-2222-4333-8444-000000000003";
const save = (jobId: string, personId: string, title: string) =>
  expect(store.save({ jobId, personId, kind: "research", title, summary: "s", host: "synthetic", computer: "research", outcome: "complete", main: "report.md", files: [{ name: "report.md", data: `# ${title}\n\nSee [the notes](notes.md) and [a source](https://example.com/x).` }, { name: "notes.md", data: "notes" }, { name: "page.html", data: "<h1>made</h1>" }] }).ok).toBe(true);
save(DOT_JOB, "dot", "Dot's research");
save(BOT_JOB, "usman", "Research bot's result");
save(FOUNDER_JOB, "usman", "Usman's own result");

const who: { principal: Record<string, unknown> | null } = { principal: null };
const routes = createComputersRoutes({
  devices: { identify: (_req: IncomingMessage) => ({ loopbackSocket: true, local: false, tailnet: null, principal: null, verified: who.principal }) } as never,
  computers: {} as never,
  artifacts: store,
  root,
  isBotResult: (id) => id === BOT_JOB,
});
const server: Server = createServer((req, res) => void routes.handle(req, res));
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  try { rmSync(root, { recursive: true, force: true }); } catch { /* reclaimed by the OS */ }
});
const asDot = () => (who.principal = { personId: "dot", via: "gateway", actor: "process", capabilities: ["view", "tasks.run"] });

describe("Dot opens saved results through the gateway", () => {
  test("the gateway lets the result page and its files through under tasks.run only; never the list", () => {
    expect(decide("GET", `/__computers/artifacts/${DOT_JOB}`)).toMatchObject({ ok: true, capability: "tasks.run" });
    expect(decide("GET", `/__computers/artifacts/${DOT_JOB}/f/report.md`)).toMatchObject({ ok: true, capability: "tasks.run" });
    expect(decide("GET", "/__computers/artifacts").ok).toBe(false);
    expect(decide("POST", `/__computers/artifacts/${DOT_JOB}`).ok).toBe(false);
  });

  test("Dot's own result and an agent bot's result open, with the founders' CSP; links stay in the same tab", async () => {
    asDot();
    for (const [id, title] of [[DOT_JOB, "Dot&#39;s research"], [BOT_JOB, "Research bot&#39;s result"]] as const) {
      const page = await fetch(`${base}/__computers/artifacts/${id}`);
      expect(page.status).toBe(200);
      expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");
      const html = await page.text();
      expect(html.includes(title) || html.includes(title.replace("&#39;", "'"))).toBe(true);
      expect(html).not.toContain('target="_blank"');
      expect(html).toContain(`href="/__computers/artifacts/${id}/f/notes.md"`);
      const file = await fetch(`${base}/__computers/artifacts/${id}/f/page.html`);
      expect(file.status).toBe(200);
      expect(file.headers.get("content-security-policy")).toContain("sandbox");
    }
  });

  test("Dot opens a founder's own result too (business work, owner's instruction 5 Oct); paths can't escape; the list is not Dot's", async () => {
    asDot();
    for (const p of [`/artifacts/${FOUNDER_JOB}`, `/artifacts/${FOUNDER_JOB}/f/report.md`]) {
      const r = await fetch(`${base}/__computers${p}`);
      expect([p, r.status]).toEqual([p, 200]);
    }
    expect((await fetch(`${base}/__computers/artifacts/${DOT_JOB}/f/..%2Fmeta.json`)).status).toBe(404);
    expect((await fetch(`${base}/__computers/artifacts`)).status).not.toBe(200);
  });

  test("anyone else still goes through the founders' checks (no gateway mark: refused here)", async () => {
    who.principal = { personId: "dot", via: "tailnet-person", actor: "process" };
    expect((await fetch(`${base}/__computers/artifacts/${DOT_JOB}`)).status).toBe(403);
    who.principal = null;
    expect((await fetch(`${base}/__computers/artifacts/${BOT_JOB}`)).status).toBe(403);
  });
});
