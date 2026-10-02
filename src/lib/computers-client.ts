// Computers: the machines agents work on. Shared agent computers come from the hub's computers API
// (GET /__computers, scripts/computers/routes.ts, docs/programme-20261001/COMPUTERS-ARCHITECTURE.md section 10);
// personal PCs come from the device registry (GET /__devices/devices) and are listed separately. This client
// never invents a row: when the API isn't there the answer is { status: "unavailable" } and the page says so.
import type { ComputerView } from "../../scripts/computers/types";
import type { DeviceRow } from "./use-devices";

export type { ComputerView };
export type ComputerState = ComputerView["state"];
export type ComputerAction = "preview" | "take-control" | "request-control" | "return" | "stop" | "start";

export type ComputersRead = { status: "ok"; computers: ComputerView[] } | { status: "unavailable"; reason: string };

/** A personal PC as the page lists it: only what the registry reports. */
export type PersonalPc = { id: string; name: string; owner: string | null; state: ComputerState | null; capabilities: string[] | null };

export const STATE_WORD: Record<ComputerState, string> = {
  starting: "Starting",
  online: "Online",
  busy: "Busy",
  asleep: "Asleep",
  offline: "Offline",
  failed: "Failed",
};

export async function readComputers(): Promise<ComputersRead> {
  let r: Response;
  try {
    r = await fetch("/__computers", { cache: "no-store" });
  } catch {
    return { status: "unavailable", reason: "The computers service couldn't be reached." };
  }
  const type = r.headers.get("content-type") ?? "";
  // A dev server that doesn't know the route answers with its HTML shell: that is "not there", not "empty".
  if (r.status === 404 || r.status === 501 || !type.includes("json")) return { status: "unavailable", reason: "Shared agent computers aren't available on this hub." };
  if (r.status === 401 || r.status === 403) return { status: "unavailable", reason: "Sign in as a founder to see the shared computers." };
  if (!r.ok) return { status: "unavailable", reason: `The computers service answered ${r.status}.` };
  const body = (await r.json().catch(() => null)) as { computers?: unknown[] } | null;
  if (!body || !Array.isArray(body.computers)) return { status: "unavailable", reason: "The computers service sent something this page can't read." };
  return { status: "ok", computers: body.computers.filter((c): c is ComputerView => !!c && typeof (c as ComputerView).name === "string") };
}

export function personalFromDevice(d: DeviceRow): PersonalPc {
  const state: ComputerState | null = d.online === false ? "offline" : d.online === true ? (d.busy ? "busy" : "online") : null;
  return { id: d.id, name: d.mine ? "This PC" : d.label || d.id, owner: d.owner ?? null, state, capabilities: d.capabilities ?? null };
}

/** Pure: who holds the controls, in words. `me` is the signed-in person's id. */
export function controllerText(c: Pick<ComputerView, "controller" | "takeoverPending" | "paused">, me: string | null, nameOf: (id: string) => string = (id) => id): string {
  const k = c.controller.kind;
  if (c.takeoverPending) return `${nameOf(c.takeoverPending.by)} is taking over; the agent pauses at its next safe step`;
  if (k === "agent") return `Agent${c.controller.who ? ` ${c.controller.who}` : ""}`;
  if (k === "person") return c.controller.who && c.controller.who === me ? "You" : nameOf(c.controller.who ?? "someone");
  return "Nobody";
}

/**
 * Which buttons the state allows, for this person.
 * Preview needs a desktop or a snapshot; control follows the lease: idle = Take control, an agent holding it =
 * Request control (it pauses at a safe step), you holding it = Return to agent, someone else holding it = nothing.
 */
export function viewActions(c: ComputerView, me: string | null): ComputerAction[] {
  const up = c.state === "online" || c.state === "busy";
  const out: ComputerAction[] = [];
  if (up) out.push("preview");
  const k = c.controller.kind;
  if (up && !c.takeoverPending) {
    if (k === null) out.push("take-control");
    else if (k === "agent") out.push("request-control");
  }
  if (up && k === "person" && c.controller.who === me) out.push("return");
  if (c.state === "offline" || c.state === "asleep" || c.state === "failed") out.push("start");
  if (c.state !== "offline" && c.state !== "failed") out.push("stop");
  return out;
}

export type ActionResult = { ok: boolean; message: string };

async function token(): Promise<string> {
  const t = await fetch("/__token").then((r) => (r.ok ? r.json() : null)).catch(() => null);
  return typeof t?.token === "string" ? t.token : "";
}

async function post(path: string, body: unknown): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
  try {
    const r = await fetch(`/__computers${path}`, { method: "POST", headers: { "Content-Type": "application/json", "x-claude-os-token": await token() }, body: JSON.stringify(body ?? {}) });
    return { ok: r.ok, status: r.status, data: (await r.json().catch(() => ({}))) as Record<string, unknown> };
  } catch {
    return { ok: false, status: 0, data: {} };
  }
}

const failure = (r: { status: number; data: Record<string, unknown> }): ActionResult => ({ ok: false, message: typeof r.data.error === "string" ? r.data.error : r.status === 0 ? "The computers service couldn't be reached." : `That didn't work (${r.status}).` });

/** Runs one control action against the hub and says what state it left the computer in. */
export async function computerAction(name: string, action: Exclude<ComputerAction, "preview">): Promise<ActionResult> {
  const n = encodeURIComponent(name);
  if (action === "take-control" || action === "request-control") {
    const r = await post(`/${n}/takeover`, {});
    if (!r.ok) return failure(r);
    return r.data.state === "pending" ? { ok: true, message: "Asked. The agent pauses at its next safe step, then the controls are yours." } : { ok: true, message: "You have the controls. Return them when you're done." };
  }
  if (action === "return") {
    const r = await post(`/${n}/return`, {});
    if (!r.ok) return failure(r);
    return { ok: true, message: r.data.resumed ? "Returned. The agent carries on where it paused." : "Returned. No agent job was waiting." };
  }
  // Stop is only sent after the person confirmed it on the page, so it overrides a running job or a held lease:
  // the hub cancels the agent's job (no replay) and drops the lease before stopping the computer.
  const r = await post(`/${n}/action`, action === "start" ? { action: "start" } : { action: "stop", force: true });
  return r.ok ? { ok: true, message: action === "start" ? "Starting." : "Stopped. Any job it was running was cancelled." } : failure(r);
}

/** Keeps a held lease alive while a viewer is open (the hub wants one every 20 to 30 s). */
export async function renewLease(name: string): Promise<boolean> {
  return (await post(`/${encodeURIComponent(name)}/lease/renew`, {})).ok;
}

export const NO_SCREEN = "No screen on this computer yet (desktop packages not installed).";

/** The newest JPEG snapshot, as an object URL, or a plain reason when there is none. */
export async function readSnapshot(name: string): Promise<{ url: string } | { reason: string }> {
  try {
    const r = await fetch(`/__computers/${encodeURIComponent(name)}/screenshot?t=${Date.now()}`, { cache: "no-store" });
    if (r.status === 404) return { reason: NO_SCREEN };
    if (r.status === 401 || r.status === 403) return { reason: "Only a signed-in person can look at a computer's screen." };
    if (!r.ok) return { reason: `The screen couldn't be read (${r.status}).` };
    return { url: URL.createObjectURL(await r.blob()) };
  } catch {
    return { reason: "The computers service couldn't be reached." };
  }
}

// ---------------------------------------------------------------- adding a shared computer
// Provisioning is human-only on the hub (a confirmed browser session or paired device), so this page is the only place to do it.

/** The server's rule for a computer's name (scripts/computers/service.ts validComputerName). */
export const COMPUTER_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;

export type HostCheckView = { ok: boolean; host: string; present: string[]; missing: string[]; installCommand: string | null; notes: string[] };
export type HostEntry = { kind: string; check: HostCheckView };
export type HostsRead = { status: "ok"; hosts: HostEntry[] } | { status: "unavailable"; reason: string };

export async function readHosts(): Promise<HostsRead> {
  try {
    const r = await fetch("/__computers/host", { cache: "no-store" });
    if (!(r.headers.get("content-type") ?? "").includes("json") || !r.ok) return { status: "unavailable", reason: r.status === 403 || r.status === 401 ? "Sign in as a founder to see the hosts." : "The hosts couldn't be read." };
    const body = (await r.json().catch(() => null)) as { adapters?: HostEntry[] } | null;
    if (!body || !Array.isArray(body.adapters)) return { status: "unavailable", reason: "The hosts couldn't be read." };
    return { status: "ok", hosts: body.adapters.filter((a) => a && typeof a.kind === "string" && a.check) };
  } catch {
    return { status: "unavailable", reason: "The computers service couldn't be reached." };
  }
}

/** Plain words for a host: this PC's WSL, or the name the host reports (e.g. "Ryzen-PC"). */
export function hostLabel(h: HostEntry): string {
  if (h.kind === "wsl-local") return "This PC (WSL)";
  // A host that never answered has no name of its own: its technical key ("vps-ssh") is not a name a person would use.
  if (h.kind === "vps-ssh") return h.check.host && h.check.host !== h.kind ? h.check.host : "Linux host over SSH";
  return h.check.host && h.check.host !== h.kind ? h.check.host : h.kind;
}

/** A host that can't be chosen says what is missing instead. Null = selectable. */
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
export function hostProblem(h: HostEntry): string | null {
  if (h.check.ok) return null;
  const notes = h.check.notes.map(oneLine).filter(Boolean);
  // A host that did not answer has not been asked what it has: say it is unreachable, and say nothing about missing packages.
  // A host key that is unknown or changed is not "no answer": it is a refusal to connect, said as one.
  const identity = notes.find((n) => /identity changed or is unknown/i.test(n));
  if (identity) return identity;
  const silent = notes.find((n) => /did not answer/i.test(n));
  if (silent) return `The host didn't answer: ${oneLine(silent.replace(/^the host did not answer:?\s*/i, "")) || "no reply"}`.replace(/\.*$/, ".");
  const parts = [h.check.missing.length ? `missing ${h.check.missing.join(", ")}` : "", ...notes].filter(Boolean);
  return parts.length ? parts.join("; ") : "it didn't answer";
}

/** What a usable host has, in plain words (null when there is nothing to say). */
export function hostReadiness(h: HostEntry): string | null {
  return h.check.ok && h.check.present.length ? `Ready: ${h.check.present.join(", ")}` : null;
}

/** Pure: why this name can't be used, or null. */
export function nameProblem(name: string, existing: string[]): string | null {
  if (!name) return "Give it a name.";
  if (!COMPUTER_NAME.test(name)) return "Use 1 to 32 lowercase letters, digits or hyphens, starting with a letter or digit.";
  if (existing.includes(name)) return `A computer called "${name}" already exists.`;
  return null;
}

/** Pure: the one-click Research and Builder suggestion, when a remote host is available and neither exists. */
export function suggestPair(hosts: HostEntry[], existing: string[]): HostEntry | null {
  if (existing.includes("research") || existing.includes("builder")) return null;
  // The SSH host (Ryzen-PC) is preferred; with none ready, this PC's own WSL gets the same one-click pair.
  return hosts.find((h) => h.kind === "vps-ssh" && h.check.ok) ?? hosts.find((h) => h.check.ok) ?? null;
}

export type ProvisionResult = { ok: true; name: string } | { ok: false; name: string; message: string };

/** Creates one computer. The server's own refusal text is returned as it was said (the human-only refusal included). */
export async function provisionComputer(input: { name: string; adapter: string; label?: string }): Promise<ProvisionResult> {
  const r = await post("", { name: input.name, adapter: input.adapter, ...(input.label?.trim() ? { label: input.label.trim() } : {}) });
  if (r.ok) return { ok: true, name: input.name };
  return { ok: false, name: input.name, message: failure(r).message };
}

/** Creates computers one after another and stops at the first refusal, saying which one and what was made before it. */
export async function provisionSequence(items: { name: string; adapter: string; label?: string }[]): Promise<{ ok: boolean; made: string[]; message: string }> {
  const made: string[] = [];
  for (const it of items) {
    const r = await provisionComputer(it);
    if (!r.ok) return { ok: false, made, message: `${it.name}: ${r.message}${made.length ? ` (${made.join(", ")} was already created.)` : ""}` };
    made.push(it.name);
  }
  return { ok: true, made, message: `Created ${made.join(" and ")}.` };
}
