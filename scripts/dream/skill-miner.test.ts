import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { awayModeDigest, claudeCodeFirstPromptsDigest, crmActivityDigest, groupRepeats, jarvisConversationsDigest, jarvisEventsDigest, skillMiningDigest } from "./skill-miner";

const tmp = () => mkdtempSync(join(tmpdir(), "skill-miner-"));
const DAY = 86_400_000;
const NOW = Date.parse("2026-09-25T00:00:00Z");

describe("groupRepeats", () => {
  test("groups near-identical short phrases and drops singletons", () => {
    const items = [
      { text: "Find the dentist's Google review count", at: "2026-09-01T00:00:00Z" },
      { text: "find the dentist's google review count", at: "2026-09-10T00:00:00Z" },
      { text: "Find the dentist's Google review count!", at: "2026-09-20T00:00:00Z" },
      { text: "Book a flight to Perth", at: "2026-09-05T00:00:00Z" },
    ];
    const groups = groupRepeats(items, 3);
    expect(groups.length).toBe(1);
    expect(groups[0].count).toBe(3);
    expect(groups[0].firstAt).toBe("2026-09-01T00:00:00Z");
    expect(groups[0].lastAt).toBe("2026-09-20T00:00:00Z");
  });

  test("below the minimum count is dropped", () => {
    expect(groupRepeats([{ text: "one-off task", at: "2026-09-01T00:00:00Z" }], 3)).toEqual([]);
  });
});

describe("jarvisConversationsDigest", () => {
  test("missing file is a note, not an error", () => {
    expect(jarvisConversationsDigest(join(tmp(), "conversations.json"), NOW - 30 * DAY)).toBe("no conversations.json yet");
  });

  test("only counts user turns from conversations updated inside the window, scrubbed", () => {
    const dir = tmp();
    const file = join(dir, "conversations.json");
    writeFileSync(
      file,
      JSON.stringify([
        {
          id: "a", updatedAt: new Date(NOW - 5 * DAY).toISOString(),
          messages: [
            { role: "user", text: "email me usman@example.com the report" },
            { role: "oracle", text: "done" },
            { role: "user", text: "email me usman@example.com the report" },
          ],
        },
        { id: "b", updatedAt: new Date(NOW - 40 * DAY).toISOString(), messages: [{ role: "user", text: "too old to count" }] },
      ]),
    );
    const digest: any = jarvisConversationsDigest(file, NOW - 30 * DAY);
    expect(digest.messagesSeen).toBe(2);
    expect(JSON.stringify(digest)).not.toContain("usman@example.com");
    expect(JSON.stringify(digest)).toContain("[email]");
  });
});

describe("jarvisEventsDigest", () => {
  test("counts recent events by source", () => {
    const dir = tmp();
    const file = join(dir, "jarvis-events.json");
    writeFileSync(
      file,
      JSON.stringify({
        events: [
          { source: "lead-watch", text: "new lead", createdAt: new Date(NOW - 2 * DAY).toISOString() },
          { source: "lead-watch", text: "new lead", createdAt: new Date(NOW - 3 * DAY).toISOString() },
          { source: "old", text: "stale", createdAt: new Date(NOW - 60 * DAY).toISOString() },
        ],
      }),
    );
    const digest: any = jarvisEventsDigest(file, NOW - 30 * DAY);
    expect(digest.total).toBe(2);
    expect(digest.bySource["lead-watch"]).toBe(2);
  });
});

describe("claudeCodeFirstPromptsDigest", () => {
  test("reads only the first non-sidechain user message per session file", () => {
    const dir = tmp();
    const projectDir = join(dir, "proj-a");
    mkdirSync(projectDir, { recursive: true });
    const lines = [
      JSON.stringify({ type: "queue-operation" }),
      JSON.stringify({ type: "user", isSidechain: true, message: { role: "user", content: "sub-agent noise" } }),
      JSON.stringify({ type: "user", isSidechain: false, message: { role: "user", content: "review the dental site's pricing page" } }),
      JSON.stringify({ type: "user", isSidechain: false, message: { role: "user", content: "a later message, ignored" } }),
    ];
    writeFileSync(join(projectDir, "s1.jsonl"), lines.join("\n"));
    const digest: any = claudeCodeFirstPromptsDigest(dir, NOW - 30 * DAY);
    expect(digest.sessions).toBe(1);
    const sample = JSON.stringify(digest);
    expect(sample).toContain("review the dental site");
    expect(sample).not.toContain("sub-agent noise");
    expect(sample).not.toContain("a later message");
  });
});

describe("crmActivityDigest", () => {
  test("missing db is a note, not a thrown error", () => {
    expect(crmActivityDigest(join(tmp(), "crm.sqlite"), NOW - 30 * DAY)).toBe("no crm.sqlite yet");
  });
});

describe("awayModeDigest", () => {
  test("counts recent tasks by route and status, scrubbed", () => {
    const dir = tmp();
    mkdirSync(join(dir, "away-mode"), { recursive: true });
    writeFileSync(
      join(dir, "away-mode", "state.json"),
      JSON.stringify({
        tasks: [
          { text: "zip the reports folder", route: "file", status: "done", createdAt: new Date(NOW - 1 * DAY).toISOString() },
          { text: "zip the reports folder", route: "file", status: "done", createdAt: new Date(NOW - 2 * DAY).toISOString() },
          { text: "zip the reports folder", route: "file", status: "done", createdAt: new Date(NOW - 3 * DAY).toISOString() },
          { text: "too old", route: "cli", status: "done", createdAt: new Date(NOW - 90 * DAY).toISOString() },
        ],
      }),
    );
    const digest: any = awayModeDigest(dir, NOW - 30 * DAY);
    expect(digest.total).toBe(3);
    expect(digest.byRoute.file).toBe(3);
    expect(digest.repeatedTasks.length).toBe(1);
    expect(digest.repeatedTasks[0].count).toBe(3);
  });
});

describe("skillMiningDigest", () => {
  test("assembles all six sources without throwing when nothing exists", () => {
    const dir = tmp();
    const digest: any = skillMiningDigest({ operatorData: join(dir, ".operator-data"), claudeProjects: join(dir, "claude-projects"), hermesHome: join(dir, "hermes"), now: NOW });
    expect(digest.windowDays).toBe(30);
    expect(digest.jarvisConversations).toBe("no conversations.json yet");
    expect(digest.hermesSessions).toMatch(/no Hermes state\.db/);
  });
});
