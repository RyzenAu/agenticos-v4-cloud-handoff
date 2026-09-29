import { expect, test } from "bun:test";
import { backgroundJobsDisabled, previewAllowsMutation, previewGuard } from "./preview-guard";

test("memory app sync remains workspace-local in isolated previews", () => {
  expect(previewAllowsMutation("/__operator/memory/apps/codex")).toBe(true);
  expect(previewAllowsMutation("/__operator/memory/apps/claude/sync")).toBe(true);
  expect(previewAllowsMutation("/__operator/memory/apps/chatgpt/import")).toBe(true);
  expect(previewAllowsMutation("/__operator/memory/apps/codex/execute")).toBe(false);
  expect(previewAllowsMutation("/__operator/memory/apps/unknown/sync")).toBe(false);
});
test("preview workspaces can save local work without changing installed agents", () => {
  for (const p of [
    "/__website-os/connect",
    "/__operator/memory",
    "/__operator/memory/a-note",
    "/__operator/brain/sources",
    "/__operator/calendar",
    "/__operator/inbox",
    "/__operator/connections/sync",
  ])
    expect(previewAllowsMutation(p)).toBe(true);
  for (const p of [
    "/__hermes_chat",
    "/__hermes_moa_save",
    "/__dream",
    "/__operator/models/local",
    "/__operator/memory/../../settings",
    "/__operator/connections/send",
  ])
    expect(previewAllowsMutation(p)).toBe(false);
});
test("previews may edit their own CRM copy's deal fields, never find/log/deploy", () => {
  for (const p of ["/__operator/leads/deal", "/__operator/leads/move", "/__operator/leads/rules"]) expect(previewAllowsMutation(p)).toBe(true);
  for (const p of ["/__operator/leads/find", "/__operator/leads/log", "/__operator/leads/won", "/__operator/leads/deal/x", "/__lead-sites/deploy"]) expect(previewAllowsMutation(p)).toBe(false);
});

test("AGENTIC_OS_NO_BACKGROUND=1 makes a quiet copy that refuses every mutating /__* request", () => {
  expect(backgroundJobsDisabled({ AGENTIC_OS_NO_BACKGROUND: "1" } as NodeJS.ProcessEnv)).toBe(true);
  expect(backgroundJobsDisabled({} as NodeJS.ProcessEnv)).toBe(false);
  const previous = process.env.AGENTIC_OS_NO_BACKGROUND;
  process.env.AGENTIC_OS_NO_BACKGROUND = "1";
  try {
    const uses: Array<(req: any, res: any, next: () => void) => void> = [];
    (previewGuard() as any).configureServer({ middlewares: { use: (fn: any) => uses.push(fn) } });
    const run = (method: string, url: string) => {
      const res: any = { statusCode: 200, setHeader() {}, end() { res.ended = true; } };
      let passed = false;
      uses[0]({ method, url }, res, () => (passed = true));
      return passed ? "next" : res.statusCode;
    };
    expect(run("POST", "/__hermes_chat")).toBe(409);
    expect(run("POST", "/__operator/inbox")).toBe(409);
    expect(run("DELETE", "/__operator/memory/x")).toBe(409);
    expect(run("GET", "/__operator/state")).toBe("next");
    expect(run("POST", "/business")).toBe("next");
  } finally {
    if (previous === undefined) delete process.env.AGENTIC_OS_NO_BACKGROUND;
    else process.env.AGENTIC_OS_NO_BACKGROUND = previous;
  }
});
