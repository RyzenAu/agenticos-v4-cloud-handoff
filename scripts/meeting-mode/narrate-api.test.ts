import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { skillDraftsRoute } from "./narrate-api";
import { saveDraft } from "./narrate-store";
import type { SkillDraftContent } from "./narrate";

const tmp = () => mkdtempSync(join(tmpdir(), "narrate-api-"));
const CONTENT: SkillDraftContent = {
  name: "prepare-a-lead-call",
  title: "Prepare a lead call",
  summary: "Pull up the lead, check for recent info, call them, log the outcome.",
  steps: ["Open the CRM and pull up the lead", "Call them", "Log the outcome"],
  tools: ["CRM"],
  decisionPoints: [],
};

function call(root: string, method: string, path: string, body?: any, remote: { name: string } | null = null) {
  let result: { value: unknown; status: number } | null = null;
  const handled = skillDraftsRoute(
    { root, path, method, body, remote, send: (value, status = 200) => { result = { value, status }; } },
    { claudeSkillsDir: join(root, "claude-skills"), hermesSkillsDir: join(root, "hermes-skills") },
  );
  return { handled, result: () => result };
}

describe("skillDraftsRoute", () => {
  test("an unrelated path is not handled", async () => {
    const root = tmp();
    const { handled } = call(root, "GET", "/business");
    expect(await handled).toBe(false);
  });

  test("GET /skill-drafts lists what's saved", async () => {
    const root = tmp();
    saveDraft(join(root, ".operator-data"), CONTENT, "topic", "transcript");
    const { handled, result } = call(root, "GET", "/skill-drafts");
    expect(await handled).toBe(true);
    expect((result()!.value as any).drafts).toHaveLength(1);
  });

  test("a remote (Tailscale) viewer is refused entirely", async () => {
    const root = tmp();
    const { result } = call(root, "GET", "/skill-drafts", undefined, { name: "Mehroz" });
    await new Promise((r) => setTimeout(r, 0));
    expect(result()!.status).toBe(403);
  });

  test("approve installs the SKILL.md and marks the draft approved", async () => {
    const root = tmp();
    const draft = saveDraft(join(root, ".operator-data"), CONTENT, "topic", "transcript");
    const { result } = call(root, "POST", `/skill-drafts/${draft.id}/approve`);
    await new Promise((r) => setTimeout(r, 0));
    const body = result()!.value as any;
    expect(body.draft.status).toBe("approved");
    expect(existsSync(join(root, "claude-skills", "prepare-a-lead-call", "SKILL.md"))).toBe(true);
    expect(readFileSync(join(root, "hermes-skills", "prepare-a-lead-call", "SKILL.md"), "utf-8")).toContain("name: prepare-a-lead-call");
  });

  test("edit updates fields on a pending draft", async () => {
    const root = tmp();
    const draft = saveDraft(join(root, ".operator-data"), CONTENT, "topic", "transcript");
    const { result } = call(root, "POST", `/skill-drafts/${draft.id}/edit`, { title: "Revised title" });
    await new Promise((r) => setTimeout(r, 0));
    expect((result()!.value as any).draft.title).toBe("Revised title");
  });

  test("discard marks it, DELETE removes it entirely", async () => {
    const root = tmp();
    const operatorData = join(root, ".operator-data");
    const draft = saveDraft(operatorData, CONTENT, "topic", "transcript");
    const discard = call(root, "POST", `/skill-drafts/${draft.id}/discard`);
    await discard.handled;
    expect((discard.result()!.value as any).draft.status).toBe("discarded");
    const del = call(root, "DELETE", `/skill-drafts/${draft.id}`);
    await del.handled;
    expect((del.result()!.value as any).ok).toBe(true);
    expect(existsSync(join(operatorData, "skill-drafts", `${draft.id}.json`))).toBe(false);
  });

  test("a bad action on a real draft is a clean 404, not a crash", async () => {
    const root = tmp();
    const draft = saveDraft(join(root, ".operator-data"), CONTENT, "topic", "transcript");
    const { result } = call(root, "POST", `/skill-drafts/${draft.id}/nope`);
    await new Promise((r) => setTimeout(r, 0));
    expect(result()!.status).toBe(404);
  });

  test("approving a draft that doesn't exist fails with a clear message, not a crash", async () => {
    const root = tmp();
    const { result } = call(root, "POST", "/skill-drafts/nope/approve");
    await new Promise((r) => setTimeout(r, 0));
    expect(result()!.status).toBe(400);
    expect((result()!.value as any).error).toMatch(/doesn't exist/);
  });
});
