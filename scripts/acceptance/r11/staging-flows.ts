#!/usr/bin/env bun
/**
 * Round 11 release check: the Jarvis send / Stop flows through the ACTUAL UI on an isolated staging hub (server role, synthetic data, port 8191).
 * The owner's browser is a real headless Chromium with its own confirmed hub session and the hub's local-owner proof (read here, never printed),
 * exactly as scripts/jobs/journey-r10-loops.ts drives a server-role hub. Steps are done in the page as a person does them (type, Send); the hub's
 * own APIs are only READ, to count jobs and messages. Screenshots go to docs/programme-20261001/evidence/r11-staging/<flow>/.
 *
 *   bun scripts/acceptance/r11/staging-flows.ts --hub http://127.0.0.1:8191 --data D:\AgenticOS-r11-data\rel [--only send,overlay]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Page, Request } from "playwright-core";
import { localOwnerHeaders } from "../../identity/local-owner-token";
import { api, arg, closeAll, DATA, HUB, me, session, sleep, until } from "../r7/lib";

const EVIDENCE = resolve(import.meta.dir, "..", "..", "..", "docs", "programme-20261001", "evidence", "r11-staging");
const only = arg("only") ? arg("only").split(",") : ["send", "overlay"];
const results: { flow: string; status: "PASS" | "FAIL"; observed: unknown }[] = [];

async function owner(opts: { delayOverlayMs?: number } = {}): Promise<{ page: Page; commandPosts: Request[]; turnPosts: Request[] }> {
  const s = await session();
  const proof = localOwnerHeaders(undefined, { ...process.env, MU_DATA_DIR: DATA, MU_LOCAL_OWNER_TOKEN_FILE: "" });
  if (!proof["X-MU-Local-Owner"]) throw new Error("No local-owner token file: is the hub running in the server role on this data?");
  await s.ctx.setExtraHTTPHeaders(proof);
  const page = s.page;
  if (opts.delayOverlayMs) {
    // The companion overlay (floating oracle + voice companion) arrives late: its chunk is held back, as on a slow link.
    await page.route(/floating-oracle|voice-companion/, async (route) => {
      await sleep(opts.delayOverlayMs!);
      await route.continue();
    });
  }
  const commandPosts: Request[] = [];
  const turnPosts: Request[] = [];
  const says: string[] = [];
  page.on("response", async (r) => {
    if (/thread\/say$/.test(r.url())) says.push(`${r.status()} ${(r.request().postData() ?? "").slice(0, 80)}`);
  });
  (page as unknown as { says: string[] }).says = says;
  page.on("request", (r) => {
    if (r.method() !== "POST") return;
    if (/\/__operator\/screen\/command$/.test(r.url())) commandPosts.push(r);
    if (/\/__operator\/voice\/free\/turn$/.test(r.url())) turnPosts.push(r);
  });
  return { page, commandPosts, turnPosts };
}

const threadMessages = async (p: Page) => {
  const head = (await api(p, "GET", "/__operator/screen/command/thread?after=999999999")).json as { conversationId?: string } | null;
  const all = ((await api(p, "GET", "/__operator/conversations")).json?.conversations ?? []) as { id: string; messages?: { role: string; text: string; via?: string }[] }[];
  return all.find((c) => c.id === head?.conversationId)?.messages ?? [];
};

async function shot(p: Page, flow: string, name: string) {
  const dir = join(EVIDENCE, flow);
  mkdirSync(dir, { recursive: true });
  await p.screenshot({ path: join(dir, `${name}.png`), fullPage: false });
  return join("docs/programme-20261001/evidence/r11-staging", flow, `${name}.png`);
}

/** Type into the /jarvis composer and press Send, as a person does, as soon as the box takes typing. */
async function typeAndSend(p: Page, words: string) {
  const box = p.locator("#assistant-request");
  await box.waitFor({ state: "visible", timeout: 60_000 });
  await box.fill(words, { timeout: 30_000 }); // waits until it is editable (read-only before hydration)
  const typedAt = Date.now();
  await p.getByRole("button", { name: "Send request" }).click({ timeout: 30_000 });
  return typedAt;
}

async function flowSend(flow: "send" | "overlay") {
  const words = `what time is it (${flow} ${Date.now().toString(36)})`;
  const { page, commandPosts, turnPosts } = await owner(flow === "overlay" ? { delayOverlayMs: 6000 } : {});
  const who = await me(page);
  const before = (await threadMessages(page)).filter((m) => m.text === words).length;
  const t0 = Date.now();
  await page.goto(`${HUB}/jarvis`, { waitUntil: "domcontentloaded" });
  const typedAt = await typeAndSend(page, words);
  const shots = [await shot(page, flow, "1-sent")];
  const replied = await until("the reply in the thread", async () => {
    const msgs = await threadMessages(page);
    const i = msgs.findIndex((m) => m.role === "user" && m.text === words);
    return i >= 0 && msgs.slice(i + 1).some((m) => m.role === "oracle") ? msgs : null;
  }, 60_000, 500);
  await sleep(1500);
  shots.push(await shot(page, flow, "2-replied"));
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByText(words).first().waitFor({ timeout: 30_000 }).catch(() => undefined);
  shots.push(await shot(page, flow, "3-after-reload"));
  const msgs = await threadMessages(page);
  const userCopies = msgs.filter((m) => m.role === "user" && m.text === words).length - before;
  const turnBodies = turnPosts.map((r) => r.postDataJSON() as { messages?: { role: string; content: string }[] }).filter((b) => b.messages?.[0]?.content === words && b.messages.length === 1);
  const boxLeft = await page.locator("#assistant-request").inputValue().catch(() => "?");
  const ok = who.actor === "human" && !!replied && userCopies === 1 && turnBodies.length === 1 && commandPosts.length <= 1;
  results.push({ flow, status: ok ? "PASS" : "FAIL", observed: { who, msFromLoadToTyped: typedAt - t0, savedUserMessages: userCopies, firstHopTurns: turnBodies.length, commandPosts: commandPosts.length, commandEventIds: commandPosts.map((r) => (r.postDataJSON() as { eventId?: string }).eventId), requestIds: [...new Set(((page as unknown as { says: string[] }).says).map((x) => /"requestId":"([^"]+)"/.exec(x)?.[1]))], reply: replied ? replied.at(-1)?.text?.slice(0, 120) : null, says: (page as unknown as { says: string[] }).says, tail: msgs.slice(-4).map((m) => `${m.role}|${(m.via ?? "").slice(0, 20)}|${m.text.slice(0, 60)}`), boxAfterReload: boxLeft, shots } });
  await closeAll();
}

try {
  if (only.includes("send")) await flowSend("send");
  if (only.includes("overlay")) await flowSend("overlay");
} finally {
  await closeAll();
  mkdirSync(EVIDENCE, { recursive: true });
  writeFileSync(join(EVIDENCE, "results-flows-1-2.json"), JSON.stringify({ hub: HUB, ranAt: new Date().toISOString(), results }, null, 2));
  for (const r of results) console.log(`${r.status} ${r.flow} ${JSON.stringify(r.observed)}`);
}
