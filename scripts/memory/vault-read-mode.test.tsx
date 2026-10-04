// R7 review m2/m3: the Vault page reads plainly. Server strings that name settings or folders sit behind "Technical detail",
// and a read-only copy says it reads the vault (saving happens on the writer) instead of "switched off... nothing to sync".
import { afterAll, beforeAll, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import { MemoryVault } from "../../src/components/memory/memory-vault";
import type { MemoryClient, StatusView } from "../../src/components/memory/client";

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
const WRITER = "A copy writes only with its own synthetic vault AND store (MU_WIKI_ROOT and MEMORY_STATE_DIR both set).";
const REASON = "HINDSIGHT_URL is off (vault and local index only)";
function status(mode: "on" | "read" | "off", lastScan: string | null = AT): StatusView {
  return {
    principal: { name: "Usman", via: "local" },
    settings: { mode, retired: [], writer: mode === "read" ? WRITER : null, writes: mode === "on", hindsight_enabled: false, hindsight_url: null, bank: "syn", api_key: "missing", reason: REASON },
    hindsight: "disabled",
    last_scan_at: lastScan,
    last_drain_at: null,
    last_success_at: null,
    pending: 0,
    pending_ops: [],
    errors: [],
    counts: { notes: 0, docs: 0, memories: 0, indexed: 0, excluded: 0, tombstones: 0 },
    skipped: [],
    recent: [],
    models: {},
    pending_approvals: 0,
    as_of: AT,
  } as unknown as StatusView;
}

async function render(s: StatusView) {
  const client = { synthetic: true, status: async () => s, items: async () => [], approvals: async () => [], sync: async () => ({ ok: true, status: s }) } as unknown as MemoryClient;
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  await act(async () => root.render(createElement(MemoryVault, { client })));
  await act(async () => void (await new Promise((r) => setTimeout(r, 10))));
  return { host, done: () => act(async () => root.unmount()) };
}
/** Everything a person reads: the page's text with the closed "Technical detail" sections taken out. */
function visible(host: HTMLElement): string {
  const clone = host.cloneNode(true) as HTMLElement;
  clone.querySelectorAll("details").forEach((d) => d.remove());
  return clone.textContent ?? "";
}

test("read mode: the page says this hub reads the vault, and never 'switched off' or 'nothing to sync'", async () => {
  const r = await render(status("read"));
  try {
    const text = visible(r.host);
    expect(text).toContain("This hub reads the shared vault");
    expect(text).not.toMatch(/switched off|nothing to sync/);
  } finally { await r.done(); }
});

test("read mode before the first scan does not claim there is nothing to show", async () => {
  const r = await render(status("read", null));
  try {
    const text = visible(r.host);
    expect(text).toContain("still scanning it in the background");
    expect(text).not.toMatch(/nothing to show yet|switched off/);
  } finally { await r.done(); }
});

test("setting names, env names and folder rules appear only inside a collapsed Technical detail", async () => {
  const r = await render(status("read"));
  try {
    const text = visible(r.host);
    expect(text).not.toMatch(/MU_WIKI_ROOT|MEMORY_STATE_DIR|HINDSIGHT_URL|AND store/);
    expect(text).toContain("only the main AgenticOS writes shared memory");
    expect(text).toContain("Hindsight isn't connected on this hub");
    const details = [...r.host.querySelectorAll("details")];
    expect(details.length).toBeGreaterThanOrEqual(2);
    expect(details.every((d) => !d.hasAttribute("open") && d.querySelector("summary")?.textContent === "Technical detail")).toBe(true);
    expect(details.map((d) => d.textContent).join(" ")).toContain("MU_WIKI_ROOT");
  } finally { await r.done(); }
});
