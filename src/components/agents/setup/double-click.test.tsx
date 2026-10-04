// @ts-ignore: the browser tsconfig has no bun types (bun test supplies this module).
import { describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createFakeAgentBots, seedBots, type BotView } from "@/lib/agent-bots";
import { ManageSection } from "./manage-section";
import { createNewBotController, EMPTY_DRAFT } from "./new-bot";
import { createSetupController, type ManageState } from "./setup-controller";

const NOW = 1_759_500_000_000;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const posts = (fake: ReturnType<typeof createFakeAgentBots>) => fake.calls.filter((x) => x.method === "POST");

async function ready(id = "research") {
  const fake = createFakeAgentBots({ now: () => NOW });
  const c = createSetupController({ botId: id, client: fake.client, now: () => 1000 });
  await c.load();
  return { fake, c };
}

describe("a fast hub and two clicks 30 ms apart", () => {
  test("Duplicate makes one copy, not two (the second click lands after the first copy exists)", async () => {
    const { fake, c } = await ready();
    const first = c.duplicate();
    await wait(30);
    const second = c.duplicate();
    const [a, b] = await Promise.all([first, second]);
    expect(a).not.toBeNull();
    expect(b).toBeNull();
    expect(posts(fake).length).toBe(1);
    expect((await fake.client.list()).kind === "ok" && (await fake.client.list() as { bots: BotView[] }).bots.filter((x) => x.name.startsWith("Research copy")).length).toBe(1);
  });

  test("dismissing the notice is the deliberate way to make another copy", async () => {
    const { fake, c } = await ready();
    await c.duplicate();
    c.dismissDuplicated();
    expect(await c.duplicate()).not.toBeNull();
    expect(posts(fake).length).toBe(2);
  });

  test("the Duplicate button is disabled while the copy's notice is up, and says how to make another", () => {
    const idle: ManageState = { confirming: null, busy: null, blocked: null, error: null, duplicated: null };
    const bot = seedBots()[0]! as BotView;
    const html = (manage: ManageState) => {
      const { document } = parseHTML(`<!doctype html><html><body>${renderToStaticMarkup(
        <ManageSection bot={bot} manage={manage} locked={false} status={{ saving: false, savedAt: null, error: null }} onDuplicate={() => {}} onAskArchive={() => {}} onCancel={() => {}} onArchive={() => {}} onUnarchive={() => {}} onOpen={() => {}} onDismissCopy={() => {}} />,
      ).replace(/<!-- -->/g, "")}</body></html>`);
      return document;
    };
    const dup = (d: Document) => [...d.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Duplicate")!;
    expect(dup(html(idle)).hasAttribute("disabled")).toBe(false);
    const after = html({ ...idle, duplicated: { ...bot, id: "research-copy", name: "Research copy" } });
    expect(dup(after).hasAttribute("disabled")).toBe(true);
    expect(after.body.textContent).toContain("Dismiss the notice below to make another copy.");
  });

  test("Archive asks the hub once; a second confirm after it landed asks nothing", async () => {
    const fake = createFakeAgentBots({ now: () => NOW });
    const c = createSetupController({ botId: "builder", client: fake.client, now: () => 1000 });
    await c.load();
    const first = c.archive();
    await wait(30);
    const second = c.archive();
    expect(await first).toBe(true);
    expect(await second).toBe(false);
    expect(posts(fake).length).toBe(1);
  });

  test("Create makes one bot: the second click, in flight or after, makes nothing", async () => {
    const fake = createFakeAgentBots({ now: () => NOW });
    const c = createNewBotController({ client: fake.client });
    c.setField("name", "Scout");
    c.setField("purpose", "Checks a prospect's public website.");
    const first = c.submit();
    await wait(30);
    const second = c.submit();
    const [a, b] = await Promise.all([first, second]);
    expect(a).not.toBeNull();
    expect(b).toBeNull();
    expect(posts(fake).length).toBe(1);
    c.reset();
    expect(c.getState().draft).toEqual(EMPTY_DRAFT);
  });
});
