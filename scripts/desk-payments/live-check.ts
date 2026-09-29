// SYNTHETIC live check for desk payments: the REAL agent-browser hands against a SEPARATE, HEADLESS Chrome on a spare CDP port
// with its own throwaway profile, on a FAKE bill page served from this process on 127.0.0.1. No real bank, card, site or
// payment; never the owner's Jarvis Chrome (9222), his profile or his windows; stopped when it ends.
//
//   bun --bun scripts/desk-payments/live-check.ts            (CDP port 9334, page port 9335, profile D:\agent-scratch\p1\chrome-desk)
//
// It checks what the CDP stub can't: that agent-browser's real snapshot, eval, get-attr and click work with the page reader,
// and that ONE Confirm makes exactly ONE press on the page (counted by the page's own server), with a receipt line each way.
// Nothing is printed from the environment.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { agentBrowserExe, createAgentBrowserHands, minimalEnv, spawnRunner } from "../j2/agent-browser";
import type { PaymentReceipt } from "../away-mode/store";
import { createDeskPayments } from "./service";

const CDP = 9334;
const WEB = 9335;
const CHROME = ["C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe"].find(existsSync);
const exe = agentBrowserExe();
if (!CHROME || !exe) throw new Error(`Needs Chrome (${!!CHROME}) and agent-browser (${!!exe}).`);
const PROFILE = "D:\\agent-scratch\\p1\\chrome-desk";
const SESSION = "p1deskcheck";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The fake bill page. `state.amount` is what it shows; the Pay button tells the server (so presses are counted there).
const state = { amount: "120.00", pressed: 0, paid: false };
const page = () => `<!doctype html><html><head><meta charset="utf-8"><title>Pay your bill - Origin Energy</title></head><body>
${state.paid ? `<h1>Payment successful</h1><p>Thank you for your payment of A$${state.amount} to Origin Energy</p><p>Receipt number: OE-88231907</p>` : `<h1>Pay your bill</h1>
<p>Paying: Origin Energy</p><p>Account 4471 2210</p><p>Total A$${state.amount}</p><p>Paying with card ending 4242</p>
<button id="pay" onclick="fetch('/pressed').then(()=>location.reload())">Pay A$${state.amount}</button> <button id="cancel">Cancel</button>`}
</body></html>`;
const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (url.pathname === "/pressed") {
    state.pressed++;
    state.paid = true;
    res.end("ok");
    return;
  }
  if (url.pathname === "/set") {
    state.amount = url.searchParams.get("amount") ?? state.amount;
    state.paid = url.searchParams.get("paid") === "1";
    res.end("ok");
    return;
  }
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(page());
});
await new Promise<void>((r) => server.listen(WEB, "127.0.0.1", () => r()));

mkdirSync(PROFILE, { recursive: true });
// Localhost is a secure browser context for Web Crypto; no public biller host is opened.
const chrome = spawn(CHROME, [`--remote-debugging-port=${CDP}`, `--user-data-dir=${PROFILE}`, "--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--disable-background-networking", "--no-proxy-server", "about:blank"], { stdio: "ignore", windowsHide: true, env: minimalEnv() });
async function stop() {
  spawnSync(exe!, ["--session", SESSION, "close"], { timeout: 15_000 });
  if (chrome.pid) spawnSync("taskkill", ["/PID", String(chrome.pid), "/T", "/F"], { timeout: 15_000 });
  server.close();
  await sleep(500);
  try {
    rmSync(PROFILE, { recursive: true, force: true });
  } catch { /* a locked scratch profile file is harmless */ }
}
const results: Array<{ step: string; ok: boolean; detail: string }> = [];
const check = (step: string, ok: boolean, detail: string) => {
  results.push({ step, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${step}: ${detail}`);
};
try {
  let up = false;
  for (let i = 0; i < 40 && !up; i++) {
    try {
      up = (await fetch(`http://127.0.0.1:${CDP}/json/version`)).ok;
    } catch { /* not yet */ }
    if (!up) await sleep(250);
  }
  if (!up) throw new Error("The spare headless Chrome didn't come up.");
  const hands = createAgentBrowserHands({ run: spawnRunner(exe), port: CDP, session: SESSION });
  const receipts: PaymentReceipt[] = [];
  const svc = createDeskPayments({ hands: async () => hands, receipts: { write: (e) => (receipts.push(e), true) }, awayOn: () => false, settleMs: 300, afterPressMs: 800 });
  const DESK = { desk: { ok: true } as const, source: "voice" as const };
  const open = async () => {
    // The fake bill page is local to the scratch browser; no public biller site is touched.
    const o = await hands.openDesk(`http://localhost:${WEB}/pay`, "this-tab");
    await sleep(700);
    return o;
  };
  check("open the fake bill page", (await open()).ok, `${(await hands.active())?.url ?? "no tab"}`);

  svc.heard("pay this");
  const asked = await svc.request("pay this", DESK);
  check("request → ONE pending payment, nothing pressed", asked.ok && state.pressed === 0 && svc.status({ desk: DESK.desk }).pending.length === 1, asked.said);
  const id = asked.pending?.id ?? "";
  const done = await svc.confirm(id, { how: "card-click" }, DESK);
  check("Confirm → ONE press, on the page's own count", done.ok && state.pressed === 1, `${done.said} (page presses: ${state.pressed})`);
  check("receipts: one before the press, one after", receipts.map((r) => r.outcome).join(",") === "pressing,confirmed", receipts.map((r) => r.outcome).join(","));
  const again = await svc.confirm(id, { how: "card-click" }, DESK);
  check("a second Confirm presses nothing", !again.ok && state.pressed === 1, `${again.said} (page presses: ${state.pressed})`);

  // A changed amount between the card and the press stops it.
  state.paid = false;
  state.amount = "120.00";
  await hands.reload();
  await sleep(700);
  svc.heard("pay this");
  const second = await svc.request("pay this", DESK);
  check("a second payment gets its own card", second.ok, second.said);
  await fetch(`http://127.0.0.1:${WEB}/set?amount=130.00&paid=0`);
  await hands.reload();
  await sleep(700);
  const stopped = await svc.confirm(second.pending?.id ?? "", { how: "card-click" }, DESK);
  check("the amount changed after the card → stopped, nothing pressed", !stopped.ok && /amount is now A\$130\.00, not A\$120\.00/.test(stopped.said) && state.pressed === 1, `${stopped.said} (page presses: ${state.pressed})`);
  check("the stop is receipted", receipts.at(-1)?.outcome === "stopped", receipts.map((r) => r.outcome).join(","));

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed (scratch Chrome ${CDP}, fake page ${WEB}; nothing real was paid).`);
  if (failed.length) process.exitCode = 1;
} catch (error) {
  console.log(`ERROR ${(error as Error).message}`);
  process.exitCode = 1;
} finally {
  await stop();
}
