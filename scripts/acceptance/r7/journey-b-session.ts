#!/usr/bin/env bun
/**
 * Round 7 acceptance, journey B (local form): pair a fresh browser, open an existing bot conversation, reload and keep the session.
 *
 * On a synthetic pc-role hub at this PC the "pairing" of a fresh browser is the confirm-code flow (docs/IDENTITY-ROUTES.md S1): a new browser is
 * PENDING; the owner's confirmed browser makes a one-time code in Settings → Profile; a person types it into the new browser's Profile. The code is
 * read off the owner's screen by this script and typed into the other browser; it is never printed or saved. The Tailscale form of pairing
 * (/pair/tailnet, /pair/redeem) needs a real tailnet login and is an owner-run row (B-prod) in ACCEPTANCE-R7.md.
 *
 *   bun scripts/acceptance/r7/journey-b-session.ts [--hub http://127.0.0.1:8128] [--bot research]
 */
import { api, arg, closeAll, expect, flat, HUB, me, record, session, shot, SIZES, until, writeResults } from "./lib";

const ROW = "B session";

/**
 * The confirm-code controls live in System › Devices and people (src/components/shell/pages/system-page.tsx "system-devices"), although the page
 * copy says "Profile" and the sidebar's "signed in · profile" link opens Settings → Personal profile (finding H-04).
 */
async function openDevices(page: import("playwright-core").Page) {
  await page.goto(`${HUB}/system`, { waitUntil: "domcontentloaded" });
  // It sits inside a closed <details> ("Plan usage, devices & runtime"): open that first, as a person would.
  const more = page.locator("main details", { has: page.locator('[data-deck-item="system-devices"]') }).locator("summary").first();
  await more.waitFor({ timeout: 30_000 }).catch(() => undefined);
  if (await more.count()) {
    const isOpen = await more.evaluate((s) => (s.parentElement as HTMLDetailsElement).open);
    if (!isOpen) await more.click();
  }
  const open =page.locator('[data-deck-item="system-devices"]').getByRole("button", { name: /Devices and people$/ });
  await open.waitFor({ state: "attached", timeout: 30_000 }).catch(async (e) => {
    await shot(page, "b-devices-missing");
    throw new Error(`System › Devices and people not found on ${page.url()} (${(await me(page)).actor}): ${String(e).slice(0, 80)}`);
  });
  await page.waitForTimeout(1500);
  await open.scrollIntoViewIfNeeded();
  if ((await open.getAttribute("aria-expanded")) !== "true") await open.click();
  await page.getByRole("heading", { name: /Confirm (this browser|a new browser at this PC)/ }).waitFor({ timeout: 30_000 });
}
let BOT = arg("bot", "research");
const ASK = `acceptance check ${Date.now().toString(36)}: list two public sources about Canberra`;

async function main() {
  // ---- The owner's confirmed browser: an existing bot conversation
  const owner = await session(SIZES[0]);
  const o = owner.page;
  const who = await me(o);
  if (!expect(ROW, "the owner's browser is a confirmed session (actor human)", who.actor === "human", who)) return;
  await o.goto(`${HUB}/agents/workspace/${BOT}`, { waitUntil: "domcontentloaded" });
  const box = o.locator("form[aria-label^='Ask '] textarea");
  await box.waitFor({ timeout: 30_000 });
  // Round 8: since the audit-1 fixes a bot with no usable computer (and no coding) has its box OFF, with the reason as its placeholder. On a
  // host-less synthetic hub that is Research. That honest state is checked here, and the conversation journey continues with a bot that can take a
  // request on this hub (Builder: it codes, so it needs no computer) instead of failing on a box that is meant to be off.
  if (await box.isDisabled()) {
    const said = (await box.getAttribute("placeholder")) ?? "";
    expect(ROW, `${BOT} has no usable computer on this hub: its box is off and says why`, /No computer: choose one in Setup/.test(said), { bot: BOT, placeholder: said });
    BOT = arg("fallback-bot", "builder");
    await o.goto(`${HUB}/agents/workspace/${BOT}`, { waitUntil: "domcontentloaded" });
    await box.waitFor({ timeout: 30_000 });
  }
  const t0 = (await api(o, "GET", `/__agents/bots/${BOT}/thread`)).json;
  await box.fill(ASK);
  await o.getByRole("button", { name: /^Send/ }).click();
  const landed = await until("an entry for the request", async () => {
    const t = (await api(o, "GET", `/__agents/bots/${BOT}/thread`)).json;
    return (t?.entries?.length ?? 0) > (t0?.entries?.length ?? 0) ? t : null;
  }, 45_000);
  const entries = landed?.entries ?? [];
  const lastText = flat(entries.map((e: { text?: string }) => e.text ?? "").join(" | ")).slice(-400);
  expect(ROW, "a typed request lands in the bot's own conversation (stored, read back through /__agents)", !!landed, { conversationId: landed?.conversationId ?? t0?.conversationId, entriesBefore: t0?.entries?.length ?? null, entriesAfter: entries.length, last: lastText });
  await shot(o, "b-1-owner-conversation");
  await o.reload({ waitUntil: "domcontentloaded" });
  await box.waitFor({ timeout: 30_000 });
  await o.waitForTimeout(2500);
  const shownAfterReload = flat(await o.locator("main").innerText());
  const t1 = (await api(o, "GET", `/__agents/bots/${BOT}/thread`)).json;
  expect(ROW, "after reload: still confirmed, same conversation id, the request is on screen", (await me(o)).actor === "human" && t1?.conversationId === landed?.conversationId && shownAfterReload.includes(ASK.slice(0, 40)), { conversationId: t1?.conversationId, onScreen: shownAfterReload.includes(ASK.slice(0, 40)) });

  // ---- A fresh browser is pending: no conversation, a plain sentence why
  const fresh = await session(SIZES[0], { fresh: true });
  const f = fresh.page;
  const w0 = await me(f);
  const refused = await api(f, "GET", `/__agents/bots/${BOT}/thread`);
  await f.goto(`${HUB}/agents/workspace/${BOT}`, { waitUntil: "domcontentloaded" });
  await f.waitForTimeout(4000);
  const freshText = flat(await f.locator("main").innerText());
  const role = (await api(o, "GET", "/__health")).json?.hubRole ?? "unknown";
  if (role === "pc") {
    // pc role: a pending browser at the hub PC is "the owner at the hub" (isAtHub), so the thread opens for it by design (finding H-03).
    expect(ROW, "a fresh browser is pending (actor process) until confirmed", w0.actor !== "human" && w0.pending === true, { me: w0 });
    record(ROW, "pc role: the pending browser can already read the bot conversation (owner at the hub; finding H-03)", "PASS", { threadStatus: refused.status, onScreen: freshText.includes(ASK.slice(0, 40)) });
  } else {
    expect(ROW, `a fresh browser (${role} role) is pending: the thread is refused (403) and the page says how to confirm, without showing the conversation`, w0.actor !== "human" && refused.status === 403 && !freshText.includes(ASK.slice(0, 40)) && /confirm|paired|sign-in|sign in/i.test(freshText), { me: w0, threadStatus: refused.status, error: refused.json?.error, pageSays: (freshText.match(/[^.]*(confirm|paired|sign-in)[^.]*\./i) ?? [""])[0] });
  }
  await shot(f, "b-2-fresh-pending");

  // ---- The pairing banner (candidate, finding H-04): every page says this browser is not confirmed and links straight to the open panel
  const banner = f.getByRole("status").filter({ hasText: "This browser isn't confirmed yet" });
  const bannerShown = await banner.first().isVisible().catch(() => false);
  const ownerBanner = await o.getByRole("status").filter({ hasText: "This browser isn't confirmed yet" }).count();
  if (bannerShown) {
    await banner.first().getByRole("link", { name: "Confirm this browser" }).click();
    const reached = await f.getByRole("heading", { name: /Confirm this browser/ }).waitFor({ timeout: 20_000 }).then(() => true).catch(() => false);
    expect(ROW, "pending browser: a banner says it is not confirmed; its link opens System › Devices and people with the code field visible (no hidden section to find); the confirmed browser shows no banner", reached && ownerBanner === 0 && /\/system/.test(f.url()), { url: f.url().replace(HUB, ""), reached, ownerBanner });
    await shot(f, "b-2b-pairing-banner-target");
  } else expect(ROW, "pending browser: a banner says it is not confirmed (H-04)", false, { bannerShown, ownerBanner });

  // ---- A wrong code is refused
  await openDevices(f);
  const codeBox = f.getByLabel("Confirm code");
  await codeBox.waitFor({ timeout: 30_000 });
  await codeBox.fill("AAAA-AAAA");
  await f.getByRole("button", { name: "Confirm this browser" }).click();
  await f.waitForTimeout(2000);
  const wrongSays = flat(await f.locator('[role="alert"], [role="status"]').allInnerTexts().then((x) => x.join(" | ")));
  expect(ROW, "a wrong code is refused, the browser stays pending, and the message points to System › Devices and people (not \"Profile\")", (await me(f)).actor !== "human" && /System › Devices and people/.test(wrongSays) && !/in Profile/.test(wrongSays), { me: await me(f), says: wrongSays.slice(0, 240) });

  // ---- The owner makes a code on screen; a person types it into the fresh browser
  await openDevices(o);
  await o.getByRole("button", { name: /Make a confirm code|Make another code/ }).click();
  const codeEl = o.locator("p.font-mono[aria-live=polite]");
  await codeEl.waitFor({ timeout: 15_000 });
  const code = flat(await codeEl.textContent()); // never printed
  await codeBox.fill(code);
  await f.getByRole("button", { name: "Confirm this browser" }).click();
  const confirmed = await until("confirmed", async () => ((await me(f)).actor === "human" ? true : null), 15_000);
  expect(ROW, "the code from the owner's screen confirms the fresh browser (actor human)", !!confirmed, { me: await me(f) });

  await f.reload({ waitUntil: "domcontentloaded" });
  await f.waitForTimeout(2500);
  expect(ROW, "after confirming, the pairing banner is gone (reload)", (await f.getByRole("status").filter({ hasText: "This browser isn't confirmed yet" }).count()) === 0, {});
  // ---- Reload and reopen keep the session; the same conversation opens
  await f.reload({ waitUntil: "domcontentloaded" });
  await f.goto(`${HUB}/agents/workspace/${BOT}`, { waitUntil: "domcontentloaded" });
  await f.locator("form[aria-label^='Ask '] textarea").waitFor({ timeout: 30_000 });
  await f.waitForTimeout(2500);
  const t2 = (await api(f, "GET", `/__agents/bots/${BOT}/thread`)).json;
  const freshNow = flat(await f.locator("main").innerText());
  expect(ROW, "after reload the paired browser is still confirmed and opens the same conversation with the earlier request", (await me(f)).actor === "human" && t2?.conversationId === landed?.conversationId && freshNow.includes(ASK.slice(0, 40)), { conversationId: t2?.conversationId, onScreen: freshNow.includes(ASK.slice(0, 40)) });
  await shot(f, "b-3-paired-conversation");
  // A new page in the same browser (reopen) also keeps it
  const f2 = await fresh.ctx.newPage();
  await f2.goto(`${HUB}/agents/workspace/${BOT}`, { waitUntil: "domcontentloaded" });
  expect(ROW, "reopen (a new tab of the paired browser) is still confirmed", (await me(f2)).actor === "human", await me(f2));

  // ---- The code works once
  const third = await session(SIZES[0], { fresh: true });
  await openDevices(third.page);
  await third.page.getByLabel("Confirm code").fill(code);
  await third.page.getByRole("button", { name: "Confirm this browser" }).click();
  await third.page.waitForTimeout(2000);
  expect(ROW, "the same code does not confirm a second browser (single use)", (await me(third.page)).actor !== "human", await me(third.page));

  // ---- 390 layout of the conversation on the paired browser
  await f.setViewportSize({ width: 390, height: 844 });
  await f.reload({ waitUntil: "domcontentloaded" });
  await f.waitForTimeout(3000);
  const overflow = await f.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
  expect(ROW, "the conversation at 390: no horizontal overflow, composer visible", !overflow && (await f.locator("form[aria-label^='Ask '] textarea").isVisible()), { overflow });
  await shot(f, "b-4-paired-390");
  record(ROW, "Tailscale pairing (/pair/tailnet, /pair/redeem) and the desktop WebView", "OUT OF SCOPE", "needs a real tailnet login or the Tauri shell: owner-run rows B-prod and A");
}

try {
  await main();
} catch (e) {
  record(ROW, "journey ran to the end", "FAIL", { error: String(e).slice(0, 400) });
} finally {
  writeResults("journey-b-session");
  await closeAll();
}
