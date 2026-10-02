// Track 8 (UI truth): the Memory vault page says what state memory is really in (audit F2 MEM-5,
// MEM-6, MEM-7, MEM-11). A synthetic in-process MemoryClient; no fetch, no network, no real store.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import { MemoryVault } from "../../src/components/memory/memory-vault";
import { approvalTarget, type MemoryClient, type MemoryItemDetail, type MemoryRow, type PendingApproval, type StatusView } from "../../src/components/memory/client";

const saved: Record<string, PropertyDescriptor | undefined> = {};
beforeAll(() => {
  const { window, document } = parseHTML("<html><body></body></html>");
  for (const [k, v] of Object.entries({ window, document, IS_REACT_ACT_ENVIRONMENT: true })) {
    saved[k] = Object.getOwnPropertyDescriptor(globalThis, k);
    Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  }
});
afterAll(() => {
  for (const [k, d] of Object.entries(saved)) (d ? Object.defineProperty(globalThis, k, d) : delete (globalThis as Record<string, unknown>)[k]);
});

const AT = "2026-09-28T01:00:00.000Z";
function statusOf(patch: { mode?: "on" | "read" | "off"; hindsight_enabled?: boolean; hindsight?: StatusView["hindsight"]; last_scan_at?: string | null; pending?: number; pending_approvals?: number } = {}): StatusView {
  const mode = patch.mode ?? "on";
  return {
    principal: { name: "Usman", via: "local" },
    settings: { mode, retired: [], writer: null, writes: mode === "on", hindsight_enabled: patch.hindsight_enabled ?? true, hindsight_url: null, bank: "syn", api_key: "missing", reason: null },
    hindsight: patch.hindsight ?? "ok",
    last_scan_at: patch.last_scan_at === undefined ? AT : patch.last_scan_at,
    last_drain_at: null,
    last_success_at: null,
    pending: patch.pending ?? 0,
    pending_ops: [],
    errors: [],
    counts: { notes: 3, docs: 10, memories: 2, indexed: 0, excluded: 0, tombstones: 0 },
    skipped: [],
    recent: [],
    models: {},
    pending_approvals: patch.pending_approvals ?? 0,
    as_of: AT,
  } as unknown as StatusView;
}
const NOTE: MemoryRow = {
  id: "n-synthetic-terms",
  kind: "note",
  title: "Synthetic proposal terms",
  text: "Synthetic proposals are valid for 21 days.",
  bucket: "business",
  source: { kind: "vault", path: "wiki/topics/business/proposal-terms.md", note_id: "n-synthetic-terms", link: "[[proposal-terms]]", uri: "obsidian://open" },
  version: 1,
  version_hash: "0123456789abcdef",
  date: AT,
  actor: null,
  status: "current",
  indexed: "confirmed",
  destination_label: "Vault note",
};

function fakeClient(opts: { status: StatusView; rows?: MemoryRow[]; approvals?: PendingApproval[] }) {
  const calls: string[] = [];
  let excluded = false;
  const detail = (): MemoryItemDetail => ({ row: { ...NOTE, status: excluded ? "excluded" : "current", indexed: excluded ? "not-indexed" : "confirmed" }, history: [], forget: ["unindex", "full"] });
  const client: MemoryClient = {
    synthetic: true,
    status: async () => opts.status,
    items: async () => opts.rows ?? [],
    item: async (id) => (calls.push(`item:${id}`), id === NOTE.id ? detail() : null),
    recall: async () => ({ ok: true, query: "", facts: [], facts_used: [], spoken: "", hindsight: "ok", suppressed: 0 }),
    remember: async () => ({ ok: false, code: "invalid", message: "not used" }),
    saveToVault: async () => ({ ok: false, code: "invalid", message: "not used" }),
    correct: async () => ({ ok: false, code: "invalid", message: "not used" }),
    forget: async (input) => {
      calls.push(`forget:${input.kind}:${input.target}`);
      excluded = true;
      return { ok: true, kind: "unindex", removed: { vault: null, hindsight_docs: [], memories: [], local_index: [NOTE.id] }, hindsight: "confirmed", message: `Removed "${NOTE.title}" from the index. Re-include in index to undo.`, limits: [] };
    },
    grant: async () => ({ ok: false, reason: "not used" }),
    reindex: async (target) => {
      calls.push(`reindex:${target}`);
      excluded = false;
      return { ok: true, message: "Re-included in the index.", indexed: "confirmed" };
    },
    releaseHeld: async () => ({ ok: false, code: "nothing-held", message: "not used" }),
    sync: async () => ({ ok: true, status: opts.status }),
    factsUsed: async () => ({ facts: [], missing: [] }),
    approvals: async () => (calls.push("approvals"), opts.approvals ?? []),
  };
  return { client, calls };
}

const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 10))));
async function mount(client: MemoryClient) {
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  await act(async () => root.render(createElement(MemoryVault, { client })));
  await settle();
  const text = () => host.textContent ?? "";
  const button = (label: string | RegExp) =>
    [...host.querySelectorAll("button")].find((b) => (typeof label === "string" ? b.textContent?.trim() === label : label.test(b.textContent ?? ""))) as HTMLButtonElement | undefined;
  const click = async (label: string | RegExp) => {
    const b = button(label);
    if (!b) throw new Error(`no button ${label}`);
    await act(async () => b.click());
    await settle();
  };
  return { host, text, button, click, done: () => act(async () => root.unmount()) };
}

test("V4.4 detail loading: a late earlier response never replaces the selected memory", async () => {
  const second = { ...NOTE, id: "second", title: "Second synthetic note" };
  const { client } = fakeClient({ status: statusOf(), rows: [NOTE, second] });
  const resolve = new Map<string, (value: MemoryItemDetail) => void>();
  client.item = (id) => new Promise((done) => resolve.set(id, done));
  const r = await mount(client);
  try {
    await r.click(new RegExp(NOTE.title));
    expect(r.text()).toContain("Loading memory");
    await r.click(/Second synthetic note/);
    await act(async () => resolve.get(second.id)!({ row: second, history: [], forget: [] }));
    await act(async () => resolve.get(NOTE.id)!({ row: NOTE, history: [], forget: [] }));
    const detail = r.host.querySelector('[aria-label="Item detail"]');
    expect(detail?.textContent).toContain("Second synthetic note");
    expect(detail?.textContent).not.toContain(NOTE.title);
  } finally { await r.done(); }
});

test("V4.4 detail failure: network errors are not presented as forgotten records", async () => {
  const { client } = fakeClient({ status: statusOf(), rows: [NOTE] });
  client.item = async () => { throw new Error("Synthetic offline"); };
  const r = await mount(client);
  try {
    await r.click(new RegExp(NOTE.title));
    expect(r.text()).toContain("Couldn't load this memory");
    expect(r.text()).not.toContain("It may have been forgotten");
  } finally { await r.done(); }
});

describe("MEM-5: with Hindsight off the queue isn't shown as 'Pending … Indexed 0 of N'", () => {
  test("off: 'Not sent (Hindsight off)' and the local index count; on: Pending and Indexed as before", async () => {
    const off = await mount(fakeClient({ status: statusOf({ hindsight_enabled: false, hindsight: "disabled", pending: 10 }) }).client);
    expect(off.text()).toContain("Not sent (Hindsight off)");
    expect(off.text()).toContain("In the local index");
    expect(off.text()).not.toContain("Indexed0 of 10");
    expect(off.text()).not.toMatch(/Pending\s*10/);
    await off.done();
    const on = await mount(fakeClient({ status: statusOf({ pending: 2 }) }).client);
    expect(on.text()).toMatch(/Pending\s*2/);
    expect(on.text()).toMatch(/Indexed\s*0 of 10/);
    await on.done();
  });
});

describe("MEM-6: unscanned and unreachable don't read as empty or connected", () => {
  test("before the first scan the list says the index isn't built (with Sync now), not 'Nothing saved'", async () => {
    const r = await mount(fakeClient({ status: statusOf({ mode: "off", hindsight_enabled: false, hindsight: "disabled", last_scan_at: null }) }).client);
    expect(r.text()).toContain("The index isn't built yet");
    expect(r.text()).toContain("Never: index not built yet");
    expect(r.text()).not.toContain("Nothing saved about that");
    expect(r.text()).not.toContain("Nothing here yet");
    expect(r.button(/Sync now/)).toBeDefined();
    await r.done();
  });
  test("read mode with Hindsight unreachable: 'Hindsight unreachable', recall from the local index only", async () => {
    const r = await mount(fakeClient({ status: statusOf({ mode: "read", hindsight: "unavailable" }) }).client);
    expect(r.text()).toContain("Hindsight unreachable");
    expect(r.text()).toContain("Recall uses the local index only: Hindsight is unreachable right now.");
    expect(r.text()).not.toContain("Recall still works from the local index and Hindsight");
    await r.done();
  });
});

describe("MEM-7: pending approvals are listed where the voice reply sends you", () => {
  const approval = (patch: Partial<PendingApproval>): PendingApproval => ({
    id: "apr-synthetic-1",
    action: "memory.forget",
    target: `full:${NOTE.id}`,
    summary: 'Forget "Synthetic proposal terms" everywhere.',
    requested_by: "Usman",
    requested_actor: "human",
    requested_at: AT,
    expires_at: "2026-09-28T01:10:00.000Z",
    granted_at: null,
    ...patch,
  });
  test("a person's request has Review (opens the item, where Approve lives); a program's needs a spoken yes", async () => {
    const { client, calls } = fakeClient({
      status: statusOf({ pending_approvals: 2 }),
      approvals: [approval({}), approval({ id: "apr-synthetic-2", target: "memory:mem-synthetic", summary: 'Delete Hindsight memory "Synthetic".', requested_by: "Claude Code", requested_actor: "process" })],
    });
    const r = await mount(client);
    expect(calls).toContain("approvals");
    expect(r.text()).toContain("Waiting for approval");
    expect(r.text()).toContain('Forget "Synthetic proposal terms" everywhere.');
    expect(r.text()).toContain("Needs your spoken yes to Jarvis");
    // Read only: listing never grants anything.
    expect(calls.some((c) => c.startsWith("grant"))).toBe(false);
    await r.click("Review");
    expect(calls).toContain(`item:${NOTE.id}`);
    expect(r.text()).toContain("Forget everywhere…");
    await r.done();
  });
  test("no pending approvals: the section isn't shown; granted ones aren't listed as waiting", async () => {
    const r = await mount(fakeClient({ status: statusOf(), approvals: [approval({ granted_at: AT })] }).client);
    expect(r.text()).not.toContain("Waiting for approval");
    await r.done();
  });
  test("approval targets parse to the item to open", () => {
    expect(approvalTarget("memory:mem-abc")).toEqual({ kind: "memory", id: "mem-abc", heading: null });
    expect(approvalTarget("full:n-1#Pricing")).toEqual({ kind: "full", id: "n-1", heading: "Pricing" });
    expect(approvalTarget("vanished:3")).toBeNull();
  });
});

describe("MEM-11: Remove from index shows the result and how to undo it", () => {
  test("the item stays open marked 'Removed from index', with a notice and a working Undo", async () => {
    const { client, calls } = fakeClient({ status: statusOf(), rows: [NOTE] });
    const r = await mount(client);
    await r.click(/Synthetic proposal terms/);
    await r.click(/Remove from index/);
    expect(calls).toContain(`forget:unindex:${NOTE.id}`);
    expect(r.text()).toContain(`Removed "${NOTE.title}" from the index.`);
    // The detail is still open on the same item, now excluded, with the way back.
    expect(r.host.querySelector('[aria-label="Item detail"]')?.textContent).toContain("Removed from index");
    expect(r.button(/Re-include in index/)).toBeDefined();
    await r.click("Undo");
    expect(calls).toContain(`reindex:${NOTE.id}`);
    expect(r.text()).toContain("Re-included in the index.");
    await r.done();
  });
});
