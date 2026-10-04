// Preview-only (bun --preload): makes the hub's "wsl-local" computers adapter a SYNTHETIC in-process host, so the rendered check of the research loop
// (scripts/jarvis-command/research-loop-preview.ts) runs a real research job on a real hub with no WSL, no browser and no network. NOT product code:
// it is only ever loaded by that script, which starts the hub with `--preload` and `--configLoader native` (so this patches the very module the hub uses).
//
// SYNTHETIC computer: pairs a real CompanionWorker (the same one every computer runs) with a one-time code, over HTTP to the hub, and gives it
// four executors backed by a fake web: echo, browser.navigate, page.text, file.write. page.text is slow on purpose so progress can be watched.
import { CommandLedger } from "../../companion/ledger";
import type { Executor } from "../../companion/executors";
import { CompanionWorker } from "../../companion/worker";
import { WslLocalAdapter } from "../computers/wsl-local";

const PAGE = [
  "Home building licences. You need a licence to do residential building work in NSW over the value of $5,000 including GST in labour and materials.",
  "Contractor licence: allows you to contract with a homeowner and to do or supervise the work listed on the licence, such as carpentry or bricklaying.",
  "Qualified supervisor certificate: allows you to supervise or do work for a company that holds a contractor licence.",
  "Endorsed contractor licence: for a person who holds a trade qualification for specialist work like plumbing.",
  "Owner builder permit: needed for owner builders doing work over $10,000.",
].join("\n");
const TITLE = "Home building licences | NSW Fair Trading";
const SLOW_MS = Number(process.env.PREVIEW_PAGE_MS) || 2500;
const hubUrl = () => `http://127.0.0.1:${process.env.PREVIEW_HUB_PORT}`;

const workers = new Map<string, CompanionWorker>();
const tokens = new Map<string, { token: string; deviceId: string }>();
const ledgers = new Map<string, CommandLedger>();
const saved: { name: string; text: string }[] = [];
(globalThis as { __previewSaved?: unknown }).__previewSaved = saved;

const executors = (): Record<string, Executor> => {
  let current = "";
  return {
    echo: async () => ({ ok: true, said: "Echoed.", verified: true }),
    "browser.navigate": async (a: any) => {
      current = String(a.url);
      return { ok: true, said: `Opened: "${TITLE}"`, verified: true, data: { title: TITLE, url: current, tabId: "tab-1" } };
    },
    "page.text": async (a: any) => {
      await new Promise((r) => setTimeout(r, SLOW_MS));
      const off = Number(a.offset) || 0;
      return { ok: true, said: "Read", verified: true, data: { title: TITLE, url: current, total: PAGE.length, offset: off, text: PAGE.slice(off, off + Number(a.limit)), links: [] } };
    },
    "file.write": async (a: any) => {
      saved.push({ name: String(a.name), text: String(a.text) });
      return { ok: true, said: `Wrote ${a.name} and read it back.`, verified: true };
    },
  };
};

async function launch(name: string) {
  const t = tokens.get(name)!;
  const worker = new CompanionWorker({ hubUrl: hubUrl(), token: t.token, deviceId: t.deviceId, owner: "shared", executors: executors(), ledger: ledgers.get(name), heartbeatMs: 500, pollWaitMs: 800, interactive: async () => true, log: () => undefined }).start();
  workers.set(name, worker);
  await worker.waitOnline(5_000);
}

const P = WslLocalAdapter.prototype as unknown as Record<string, unknown>;
P.check = async () => ({ ok: true, host: "synthetic", present: ["node"], missing: [], installCommand: null, notes: ["SYNTHETIC computer for the research-loop rendered check"] });
P.hubUrl = async () => hubUrl();
P.provision = async (spec: { name: string; hubUrl: string; pairingCode: string; label: string; display: string }) => {
  const res = await fetch(`${spec.hubUrl}/__devices/companion/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: spec.pairingCode, label: spec.label }) });
  const json: any = await res.json();
  if (res.status !== 200) throw new Error(`pairing refused: ${json.error}`);
  tokens.set(spec.name, { token: json.token, deviceId: json.deviceId });
  ledgers.set(spec.name, new CommandLedger());
  await launch(spec.name);
  return { handle: { name: spec.name, display: spec.display }, desktop: false };
};
const alive = (name: string) => {
  const w = workers.get(name);
  return !!w && w.state !== "stopped" && w.state !== "unpaired";
};
P.start = async (h: { name: string }) => void (alive(h.name) || (await launch(h.name)));
P.stop = async (h: { name: string }) => void (await workers.get(h.name)?.stop());
P.suspend = P.stop;
P.resume = async (h: { name: string }) => launch(h.name);
P.recover = async (h: { name: string }) => {
  await workers.get(h.name)?.stop().catch(() => undefined);
  await launch(h.name);
};
P.destroy = P.stop;
P.probe = async (h: { name: string }) => ({ hostUp: true, companionAlive: alive(h.name), displayAlive: null, vncAlive: false, browserAlive: false, resource: { rssMb: 120, cpuPct: 2, procs: 3, sampledAt: Date.now() }, at: Date.now() });
P.snapshot = async () => null;
P.openVnc = async () => null;
P.installBundle = async () => undefined; // the synthetic computer runs the companion in this process; there is no host to copy a bundle to
