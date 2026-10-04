import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_JOBS_DRAFTED, AGENT_JOBS_HUMAN_ONLY, agentJobsRoute, agentTaskDraft, isAgentJobsPath, relayed, REMOTE_AGENT_JOBS_REFUSAL } from "./agent-jobs-route";
import { tailnetPerson } from "./remote-access";

// C1 (a): the route matrix. Every /agent-jobs* path × {loopback owner, tailnet person}.
const ROUTES: Array<[string, string, string]> = [
  ["GET", "/agent-jobs", "list"],
  ["GET", "/agent-jobs/status", "status"],
  ["POST", "/agent-jobs", "create"],
  ["POST", "/agent-jobs/check", "create"],
  ["POST", "/agent-jobs/respond", "respond"],
  ["POST", "/agent-jobs/cancel", "cancel"],
];

function fakeService() {
  const calls: string[] = [];
  const service = {
    list: () => (calls.push("list"), { jobs: [] }),
    status: async () => (calls.push("status"), { agents: [] }),
    create: (_body: unknown, check?: boolean) => (calls.push(check ? "create:check" : "create"), { job: { id: "job" } }),
    respond: () => (calls.push("respond"), { job: { id: "job" } }),
    cancel: () => (calls.push("cancel"), { job: { id: "job" } }),
  } as any;
  return { service, calls };
}

async function call(method: string, path: string, remote: boolean, options: { human?: boolean; body?: unknown } = {}) {
  const { service, calls } = fakeService();
  const replies: Array<{ value: any; status: number }> = [];
  const handled = await agentJobsRoute({ path, method, body: options.body ?? { requestId: "x" }, remote, service, human: options.human ?? true, send: (value, status = 200) => replies.push({ value, status }) });
  return { handled, calls, replies };
}
const TASK = { requestId: "0f5e2c1a-7b7d-4d2e-9f00-5b6f1d2c3a4b", prompt: "fix the login bug in the dental site", targets: ["codex", "claude"] };

describe("agent-jobs routes: remote callers are refused on every path", () => {
  for (const [method, path, action] of ROUTES) {
    test(`tailnet ${method} ${path} → 403 and the service is never touched`, async () => {
      const { handled, calls, replies } = await call(method, path, true);
      expect(handled).toBe(true);
      expect(calls).toEqual([]);
      expect(replies).toEqual([{ value: { error: REMOTE_AGENT_JOBS_REFUSAL }, status: 403 }]);
    });
    if (method === "POST" && path === "/agent-jobs") continue; // T3c: a task only drafts (below)
    test(`loopback, signed-in person: ${method} ${path} → ${action}`, async () => {
      const { handled, calls, replies } = await call(method, path, false);
      expect(handled).toBe(true);
      expect(calls).toEqual([path === "/agent-jobs/check" ? "create:check" : action]);
      expect(replies).toHaveLength(1);
      expect(replies[0].status).toBe(method === "POST" && action === "create" ? 202 : 200);
    });
  }
  test("review B1 repro: a relayed request claiming Host: localhost is remote → 403, nothing created", async () => {
    // The real tailnet check says "not a tailnet person" for this Host, so remote=false reaches the route.
    const tailnet = tailnetPerson({ headers: { host: "localhost:8443", "tailscale-user-login": "stranger@example.com" }, socket: { remoteAddress: "127.0.0.1" } } as any, mkdtempSync(join(tmpdir(), "relay-")), "usman-pc.example.ts.net");
    expect(tailnet).toBeFalsy();
    const relays = [
      { "tailscale-user-login": "stranger@example.com" }, { "x-forwarded-for": "100.64.0.9" }, { "x-forwarded-host": "localhost" },
      { forwarded: "for=100.64.0.9" }, { via: "1.1 proxy" }, { "x-real-ip": "100.64.0.9" }, { "Tailscale-User-Name": "x" },
    ];
    for (const extra of relays) {
      const { service, calls } = fakeService();
      const replies: Array<{ value: any; status: number }> = [];
      const handled = await agentJobsRoute({ path: "/agent-jobs", method: "POST", body: {}, remote: !!tailnet, headers: { host: "localhost:8443", ...extra }, service, send: (value, status = 200) => replies.push({ value, status }) });
      expect(handled).toBe(true);
      expect(calls).toEqual([]);
      expect(replies[0].status).toBe(403);
    }
    // A plain loopback request with only ordinary headers is still the local owner.
    expect(relayed({ host: "localhost:8081", origin: "http://localhost:8081", "content-type": "application/json", "x-claude-os-token": "t" })).toBe(false);
  });
  test("unknown or future agent-jobs sub-paths are also refused remotely", async () => {
    for (const [method, path] of [["GET", "/agent-jobs/anything"], ["POST", "/agent-jobs/start-os"], ["DELETE", "/agent-jobs"]]) {
      const { handled, calls, replies } = await call(method, path, true);
      expect(handled).toBe(true);
      expect(calls).toEqual([]);
      expect(replies[0].status).toBe(403);
    }
  });
  test("locally, an unknown sub-path falls through (404 elsewhere) and other routes are not claimed", async () => {
    expect((await call("GET", "/agent-jobs/anything", false)).handled).toBe(false);
    for (const path of ["/agent-jobsx", "/agents", "/away", "/", "/agent"]) {
      expect(isAgentJobsPath(path)).toBe(false);
      const { handled, replies } = await call("GET", path, true);
      expect(handled).toBe(false);
      expect(replies).toEqual([]);
    }
  });
});

describe("T3c: the old agent-jobs door can't start Codex or Claude", () => {
  test("a task POST never starts anything, for a person or a program: it answers with the coding draft", async () => {
    for (const human of [true, false]) {
      const { handled, calls, replies } = await call("POST", "/agent-jobs", false, { human, body: TASK });
      expect(handled).toBe(true);
      expect(calls).toEqual([]);
      expect(replies).toHaveLength(1);
      expect(replies[0].status).toBe(202);
      expect(replies[0].value).toMatchObject({ started: false, message: AGENT_JOBS_DRAFTED });
      expect(replies[0].value.draft.path).toStartWith("/coding?request=");
      expect(replies[0].value.draft.request).toBe("fix the login bug in the dental site. Codex builds, Claude reviews.");
    }
  });
  test("a page-token program (no signed-in session) can't run the check, answer an agent or stop one", async () => {
    for (const path of ["/agent-jobs/check", "/agent-jobs/respond", "/agent-jobs/cancel"]) {
      const { handled, calls, replies } = await call("POST", path, false, { human: false, body: { requestId: TASK.requestId, targets: ["codex"] } });
      expect(handled).toBe(true);
      expect(calls).toEqual([]);
      expect(replies).toEqual([{ value: { error: AGENT_JOBS_HUMAN_ONLY }, status: 403 }]);
    }
    // Reads stay open to the local owner's programs (the list and connection status).
    expect((await call("GET", "/agent-jobs", false, { human: false })).calls).toEqual(["list"]);
  });
  test("the draft keeps the old request checks", () => {
    expect(agentTaskDraft({ ...TASK, requestId: "x" })).toMatchObject({ ok: false });
    expect(agentTaskDraft({ ...TASK, targets: ["gpt"] })).toMatchObject({ ok: false });
    expect(agentTaskDraft({ ...TASK, extra: 1 })).toMatchObject({ ok: false });
    expect(agentTaskDraft({ ...TASK, prompt: "" })).toMatchObject({ ok: false });
    expect(agentTaskDraft({ ...TASK, workflow: "deploy" })).toMatchObject({ ok: false });
    const os = agentTaskDraft({ ...TASK, targets: ["codex"], workflow: "improve-os", prompt: "fix the calls page" });
    expect(os.ok && os.request).toBe("fix the calls page in AgenticOS. Codex builds.");
  });
});

describe("R3: the Tasks form → Coding round trip keeps the task", () => {
  test("the draft request keeps the whole task for the shaper, and a task too long for a draft is refused, not cut", async () => {
    const { objectiveFrom } = await import("./coding/shaper");
    for (const prompt of ["Make the tasks panel button label match the page title", "update README.md in AgenticOS"]) {
      const d = agentTaskDraft({ ...TASK, prompt, targets: ["codex"] });
      expect(d.ok).toBe(true);
      if (d.ok) expect(objectiveFrom(d.request)).toBe(prompt);
    }
    const long = agentTaskDraft({ ...TASK, prompt: "fix the calls page ".repeat(80) });
    expect(long).toMatchObject({ ok: false });
    expect(!long.ok && long.error).toContain("over 960 characters");
    expect(!long.ok && long.error).toContain("Nothing was cut");
  });
});

describe("R4: a task longer than a draft takes is refused where it's typed, never cut", () => {
  test("the Tasks box has no maxLength and shows the refusal; the message names the limit that applies", async () => {
    const { readFileSync } = await import("node:fs");
    const panel = readFileSync(new URL("../src/components/operator/agent-jobs-panel.tsx", import.meta.url), "utf8");
    expect(panel).not.toMatch(/maxLength=\{CODING/);
    expect(panel).toContain('role="alert"');
    expect(panel).toMatch(/prompt\.trim\(\)\.length > CODING_TASK_MAX/);
    const { CODING_TASK_MAX, codingTooLong, CODING_REQUEST_MAX } = await import("../src/lib/commands/coding");
    expect(CODING_TASK_MAX).toBe(960);
    expect(codingTooLong()).toContain("over 960 characters");
    expect(codingTooLong(CODING_REQUEST_MAX)).toContain("over 1,000 characters");
    // A direct /coding?request= link isn't cut to 1,000 any more; the page refuses it with the reason.
    const route = readFileSync(new URL("../src/routes/coding.index.tsx", import.meta.url), "utf8");
    expect(route).not.toContain("slice(0, 1000)");
  });
});
