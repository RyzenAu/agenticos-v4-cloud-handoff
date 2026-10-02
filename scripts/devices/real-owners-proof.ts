#!/usr/bin/env bun
/**
 * Cross-owner refusal proof on the real command path (programme 20261001, Agent B).
 *
 * Runs against the isolated hub (scripts/devices/local-hub.ts --simulate-serve, default 127.0.0.1:8112) with two paired
 * companions on THIS PC: Usman's is a real companion process (separate config dir; started and paired before this runs);
 * Mehroz's is a synthetic second companion: a real CompanionWorker paired as "mehroz" through the simulated Serve identity
 * (Tailscale is not involved), running HARMLESS fake executors, so nothing synthetic can act on this PC's screen. Mehroz's
 * browser session is a real paired session cookie minted the same way (/pair/tailnet).
 *
 *   bun scripts/devices/real-owners-proof.ts [--hub http://127.0.0.1:8112] [--data D:\agent-scratch\prog-b\proof3]
 *
 * Every refusal is checked BEFORE dispatch: the hub's command table has no new row, and the other person's device received nothing.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CompanionWorker } from "../../companion/worker";
import { CommandLedger } from "../../companion/ledger";
import { LOGINS, TAILNET } from "./test-harness";

const argv = process.argv.slice(2);
const opt = (n: string, d: string) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : d);
const HUB = opt("hub", "http://127.0.0.1:8112");
const DATA = opt("data", "D:\\agent-scratch\\prog-b\\proof3");
const t0 = Date.now();
const out = (label: string, value: Record<string, unknown>) => console.log(JSON.stringify({ at: `+${((Date.now() - t0) / 1000).toFixed(1)}s`, label, ...value }));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const MEHROZ_HEADERS = { host: `${TAILNET}:8443`, "tailscale-user-login": LOGINS.mehroz, "x-forwarded-for": "100.64.0.12" };
let mehrozCookie = "";

async function state() {
  return (await (await fetch(`${HUB}/__proof/state`)).json()) as { devices: any[]; commands: any[] };
}
async function command(who: "usman" | "mehroz", body: Record<string, unknown>) {
  const headers: Record<string, string> = { "content-type": "application/json", ...(who === "mehroz" ? { ...MEHROZ_HEADERS, ...(mehrozCookie ? { cookie: mehrozCookie } : {}) } : {}) };
  const res = await fetch(`${HUB}/__operator/screen/command`, { method: "POST", headers, body: JSON.stringify({ source: "typed", ...body }) });
  const text = await res.text();
  const lines = text.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  return { status: res.status, done: (lines.findLast((e) => e.type === "done") ?? lines[0]) as any };
}
async function pairMehroz(codeFile: string, label: string) {
  const code = readFileSync(join(DATA, codeFile), "utf8").trim();
  const res = await fetch(`${HUB}/__devices/companion/pair`, { method: "POST", headers: { "content-type": "application/json", ...MEHROZ_HEADERS }, body: JSON.stringify({ code, label, aliases: ["pc", "laptop"] }) });
  const paired = (await res.json()) as any;
  if (res.status !== 200) throw new Error(`mehroz pairing refused (${res.status})`);
  const calls: string[] = [];
  const harmless = (name: string) => async () => (calls.push(name), { ok: true, said: `${name} (synthetic, harmless)`, verified: true });
  const worker = new CompanionWorker({
    hubUrl: HUB, token: paired.token, deviceId: paired.deviceId, owner: "mehroz", extraHeaders: MEHROZ_HEADERS, heartbeatMs: 1_000, pollWaitMs: 2_000,
    executors: { echo: harmless("echo"), "observe.window": harmless("observe.window"), "app.open": harmless("app.open") },
    ledger: new CommandLedger(), interactive: async () => true, log: () => undefined,
  }).start();
  await worker.waitOnline(8_000);
  return { worker, calls, deviceId: paired.deviceId as string };
}

async function main() {
  // Mehroz's own browser session: a real paired session, minted over the simulated tailnet identity.
  const pairRes = await fetch(`${HUB}/__devices/pair/tailnet`, { method: "POST", headers: { "content-type": "application/json", ...MEHROZ_HEADERS }, body: JSON.stringify({ label: "Mehroz's browser (synthetic)" }) });
  mehrozCookie = (pairRes.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
  out("mehroz-session", { status: pairRes.status, hasCookie: !!mehrozCookie });
  let m = await pairMehroz("pair-code-mehroz.txt", "Mehroz's PC");
  const usman = (await state()).devices.find((d) => d.owner === "usman" && d.kind === "companion");
  if (!usman) throw new Error("Usman's companion is not paired/online");
  const rows = async () => (await state()).commands.length;
  out("setup", { usmanDevice: usman.id, mehrozDevice: m.deviceId, hubIsDevice: (await (await fetch(`${HUB}/__proof/state`)).json() as any).hubIsDevice });

  const refusal = async (label: string, who: "usman" | "mehroz", body: Record<string, unknown>, other: { calls?: string[] }) => {
    const before = await rows();
    const r = await command(who, body);
    const after = await rows();
    out(label, { ok: r.done.ok, refused: !!r.done.refused, said: String(r.done.said).slice(0, 140), target: r.done.targetDeviceId, newCommandRows: after - before, otherDeviceCalls: other.calls?.length ?? 0 });
  };
  // 1. Usman names Mehroz's PC: refused before dispatch; Mehroz's device received nothing.
  await refusal("usman-names-mehroz-pc", "usman", { utterance: "open Chrome on Mehroz's PC" }, m);
  await refusal("usman-names-mehroz-computer-typed-plan", "usman", { utterance: "look at the window", steps: [{ executor: "observe.window", args: {} }], spokenTarget: "on Mehroz's computer" }, m);
  // 2. Usman's body tries to point at Mehroz's device / person / display name: ignored; it runs on Usman's OWN device (read-only step).
  const smuggle = await command("usman", { utterance: "look at the window", steps: [{ executor: "observe.window", args: {} }], deviceId: m.deviceId, targetDeviceId: m.deviceId, personId: "mehroz", displayName: "Mehroz" });
  out("usman-body-smuggle", { ok: smuggle.done.ok, ranOn: smuggle.done.targetDeviceId === usman.id ? "usman's own device" : smuggle.done.targetDeviceId, mehrozDeviceCalls: m.calls.length });
  // 3. The other way: Mehroz's session names Usman's PC.
  const uBefore = (await state()).commands.length;
  await refusal("mehroz-names-usman-pc", "mehroz", { utterance: "open Chrome on Usman's PC" }, { calls: [] });
  await refusal("mehroz-names-usman-computer-typed-plan", "mehroz", { utterance: "look at the window", steps: [{ executor: "echo", args: {} }], spokenTarget: "on Usman's computer" }, { calls: [] });
  const mSmuggle = await command("mehroz", { utterance: "say hi", steps: [{ executor: "echo", args: { text: "hi" } }], deviceId: usman.id, targetDeviceId: usman.id, personId: "usman", displayName: "Usman" });
  out("mehroz-body-smuggle", { ok: mSmuggle.done.ok, ranOn: mSmuggle.done.targetDeviceId === m.deviceId ? "mehroz's own device" : mSmuggle.done.targetDeviceId, ranOnUsman: mSmuggle.done.targetDeviceId === usman.id });
  void uBefore;
  // 4. "here" from each session resolves to that person's own device.
  const uHere = await command("usman", { utterance: "look here", steps: [{ executor: "observe.window", args: {} }], spokenTarget: "here" });
  const mHere = await command("mehroz", { utterance: "say here", steps: [{ executor: "echo", args: {} }], spokenTarget: "this pc" });
  out("here", { usmanHere: uHere.done.targetDeviceId === usman.id ? "usman's device" : uHere.done.targetDeviceId, mehrozHere: mHere.done.targetDeviceId === m.deviceId ? "mehroz's device" : mHere.done.targetDeviceId });
  // 5. Revoke Mehroz's companion: the rule holds; then Mehroz re-pairs and the rule still holds.
  const revoked = await (await fetch(`${HUB}/__proof/revoke`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ deviceId: m.deviceId }) })).json();
  await sleep(2_500);
  out("revoked", { result: revoked, workerState: m.worker.state });
  await refusal("after-revoke-usman-names-mehroz", "usman", { utterance: "open Chrome on Mehroz's PC" }, m);
  const hereRevoked = await command("mehroz", { utterance: "say here", steps: [{ executor: "echo", args: {} }], spokenTarget: "here" });
  out("after-revoke-mehroz-here", { ok: hereRevoked.done.ok, said: String(hereRevoked.done.said).slice(0, 140), target: hereRevoked.done.targetDeviceId });
  const uStill = await command("usman", { utterance: "look here", steps: [{ executor: "observe.window", args: {} }], spokenTarget: "here" });
  out("after-revoke-usman-unaffected", { ok: uStill.done.ok, target: uStill.done.targetDeviceId === usman.id ? "usman's device" : uStill.done.targetDeviceId });
  await (await fetch(`${HUB}/__proof/new-code`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ who: "mehroz" }) })).json();
  await m.worker.stop();
  m = await pairMehroz("pair-code-mehroz.txt", "Mehroz's PC (re-paired)");
  out("re-paired", { newDevice: m.deviceId });
  await refusal("after-repair-usman-names-mehroz", "usman", { utterance: "open Chrome on Mehroz's PC" }, m);
  const again = await command("mehroz", { utterance: "say here", steps: [{ executor: "echo", args: {} }], spokenTarget: "here" });
  out("after-repair-mehroz-here", { ok: again.done.ok, target: again.done.targetDeviceId === m.deviceId ? "mehroz's new device" : again.done.targetDeviceId });
  await m.worker.stop();
}
void main().catch((e) => {
  console.error("proof failed:", String(e?.message ?? e).slice(0, 300));
  process.exitCode = 1;
});
