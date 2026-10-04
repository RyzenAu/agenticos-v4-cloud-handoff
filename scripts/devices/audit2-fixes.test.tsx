import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import { MemoryVault } from "../../src/components/memory/memory-vault";
import type { MemoryClient, StatusView } from "../../src/components/memory/client";
import { promptForDisplay } from "../../src/components/hermes-mission-control";
import { providerView, toolRowText, isTechnicalText, type ProviderStatus } from "../../src/components/shell/system-facts";
import { toolNextStep, toolPlaceholder, toolTone, toolView } from "../../src/lib/tool-status";
import { jarvisSettingsProblem, notSaved } from "../../src/components/operator/jarvis-settings-check";
import { isUnconfirmed, memoryWords } from "../../src/components/profile/profile-panel";
import { readJarvisSettings, writeJarvisSettings } from "../jarvis-settings";

/**
 * R7 audit 2 fixes (items 4, 5, 6, 7, 11, 12, 14): regression tests. The page text is what the owner reads, so each test pins words, not internals.
 */
const src = (rel: string) => readFileSync(join(import.meta.dir, "..", "..", rel), "utf8");

// ── 4 and 5: ONE status per tool, from one source ───────────────────────────────────────────────────
const STATUSES: ProviderStatus[] = [
  { id: "claude", ready: false, installed: true, detail: "Claude Code is signed out. Sign in with /login." },
  { id: "hermes", ready: false, installed: true, detail: "installed" },
  { id: "codex", ready: true, detail: "ok" },
];

test("4/5: every page words a tool through the same view, and an unverified Claude Code is never 'Ready'", () => {
  const claude = toolView(STATUSES, "claude")!;
  expect(claude.label).toBe("Sign-in needed");
  expect(claude.label).toBe(providerView(STATUSES[0]!).label); // System's own wording
  expect(toolTone(claude)).toBe("warn");
  expect(toolView(STATUSES, "hermes")!.label).toBe("Installed · not verified");
  expect(toolView(STATUSES, "codex")!.label).toBe("Ready · signed in");
  expect(toolTone(toolView(STATUSES, "codex"))).toBe("success");
  expect(toolView(STATUSES, "openclaw")).toBeNull(); // no row, no guess
  expect(toolPlaceholder({ isPending: true, isError: false })).toBe("Checking…");
  expect(toolPlaceholder({ isPending: false, isError: true })).toBe("Check unavailable");
  expect(toolPlaceholder({ isPending: false, isError: false })).toBe("Not checked yet");
  for (const line of [toolNextStep("claude", claude), toolNextStep("hermes", toolView(STATUSES, "hermes")), toolNextStep("claude", null)]) expect(isTechnicalText(line)).toBe(false);
});

test("4/5: the Claude Code, Hermes and Settings pages read that one source and no longer carry their own wording", () => {
  const claudePage = src("src/routes/agents.claude-code.tsx");
  const hermesPage = src("src/routes/-pages/hermes.tsx");
  const settings = src("src/components/operator/workspace-onboarding.tsx");
  for (const [name, text] of [["claude-code", claudePage], ["hermes", hermesPage], ["settings", settings]] as const) {
    expect(text, name).toContain("toolView(");
    expect(text, name).toContain("tool-status");
  }
  expect(claudePage).not.toContain('v.tone === "ok" ? "Ready"');
  expect(hermesPage).not.toContain("Not installed yet");
  expect(hermesPage).not.toContain("Installed and configured");
  expect(settings).not.toContain("Configured for chat");
  expect(settings).not.toContain("Installed · not connected");
  // System already used providerView; the shared read uses its query key so there is one request.
  expect(src("src/lib/tool-status.ts")).toContain('queryKey: ["system", "models"]');
});

test("4: the mission prompt is folded behind 'Show the prompt' and never shows a hub address or file path", () => {
  const raw = "Post to curl -sS -X POST http://localhost:8081/__hermes_missions/create and watch ~/.hermes/missions.json. If it fails say: Dashboard endpoint not live at localhost:8081/__hermes_missions/create. Also localhost:5173.";
  const shown = promptForDisplay(raw);
  expect(shown).not.toMatch(/localhost|8081|__hermes|\.hermes|missions\.json/);
  const control = src("src/components/hermes-mission-control.tsx");
  expect(control).toContain("useState(false)"); // folded by default
  expect(control).toContain("Show the prompt");
  expect(control).toContain("Copy prompt"); // copying still gives the real text
  expect(control).not.toContain('label="Watching ~/.hermes/missions.json"');
});

// ── 6: Vault wording, one Sync control ────────────────────────────────────────────────────────────
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

function offStatus(lastScan: string | null): StatusView {
  return {
    principal: { name: "Usman", via: "local" },
    settings: { mode: "off", retired: [], writer: null, writes: false, hindsight_enabled: false, hindsight_url: null, bank: "syn", api_key: "missing", reason: "MU_MEMORY_WRITES is off" },
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
    as_of: "2026-10-03T01:00:00.000Z",
  } as unknown as StatusView;
}

for (const lastScan of [null, "2026-10-03T01:00:00.000Z"]) {
  test(`6: with saving off (${lastScan ? "index built" : "index not built"}) the vault says so in plain words and offers ONE Sync control, disabled with the reason`, async () => {
    const calls: string[] = [];
    const client = {
      synthetic: true,
      status: async () => offStatus(lastScan),
      items: async () => [],
      item: async () => null,
      sync: async () => (calls.push("sync"), { ok: true as const, status: offStatus(lastScan) }),
    } as unknown as MemoryClient;
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    await act(async () => root.render(createElement(MemoryVault, { client })));
    await act(async () => void (await new Promise((r) => setTimeout(r, 20))));
    const text = host.textContent ?? "";
    expect(text).not.toContain("MU_MEMORY_WRITES");
    expect(text).not.toContain("until acceptance");
    expect(text).not.toContain("Memory switch");
    expect(text).toContain("Saving to shared memory is switched off on this hub");
    const syncs = [...host.querySelectorAll("button")].filter((b) => /Sync now/.test(b.textContent ?? ""));
    expect(syncs).toHaveLength(1);
    expect((syncs[0] as HTMLButtonElement).disabled).toBe(true);
    expect(syncs[0]!.getAttribute("title")).toContain("switched off");
    await act(async () => (syncs[0] as HTMLButtonElement).click());
    expect(calls).toEqual([]); // a disabled control sends nothing
    await act(async () => root.unmount());
  });
}

// ── 7: no dead ends, no vendor promotion ───────────────────────────────────────────────────────────
test("7: Stripe and YouTube say where keys really go; Mercury shows only when it is actually used", () => {
  const panel = src("src/components/business/connections-panel.tsx");
  const stripe = src("src/components/business/stripe-finance-panel.tsx");
  for (const [name, text] of [["connections", panel], ["stripe panel", stripe]] as const) {
    expect(text, name).not.toContain("Add a restricted Stripe key (rk_…) to connect");
    expect(text, name).not.toContain("Add a YouTube API key in Settings");
  }
  expect(panel).toContain("Keys are added on the hub PC, not in this app");
  expect(panel).toContain("The YouTube key is added on the hub PC, not in this app");
  expect(stripe).toContain("add it on the hub PC");
  // The Mercury row shows with Codex access or a snapshot, or when its check failed or has not answered (so Recheck stays reachable); the Money list opens with Stripe.
  expect(panel).toMatch(/\(native\.data\?\.mercury\.available \|\| workspace\.data\?\.finances \|\| native\.isError \|\| native\.isPending\) && \(\s*<div className="biz-provider-row" aria-label="Mercury">/);
  expect(panel.indexOf('aria-label="Stripe"')).toBeLessThan(panel.indexOf('aria-label="Mercury"')); // Stripe first, Mercury after
  // The server's own messages no longer send people to a config file either.
  expect(src("scripts/business-integrations.ts")).not.toContain("~/.config/agentic-os.env before choosing");
  expect(src("scripts/operator-plugin.ts")).not.toContain("Add a restricted Stripe key (rk_…) to ~/.config/agentic-os.env");
});

// ── 11: no configuration names outside Technical detail ────────────────────────────────────────────
const AUDIT_ROWS = [
  { status: "setup-required", ownerAction: "launcher or browser.cdp_url missing", evidence: "claude-os skill missing" },
  { status: "setup-required", ownerAction: "add TYPESAFE_API_KEY to ~/.config/agentic-os.env" },
  { status: "setup-required", evidence: "OBSIDIAN_VAULT_PATH not set", ownerAction: "Set PINECONE_API_KEY" },
  { status: "setup-required", evidence: "no cron job named morning-brief", ownerAction: "Recreate the morning-brief job (see docs/FILM-JARVIS.md)" },
  { status: "setup-required", evidence: "OpenClaw gateway down", ownerAction: "Decide whether to keep the OpenClaw pilot (see handover); if yes, start its gateway and pair a device" },
  { status: "broken", evidence: "exit 1: /__jobs refused", ownerAction: undefined },
];

test("11: a tool row's visible words contain no variable, path, doc or CDP names; the originals sit in Technical detail", () => {
  for (const row of AUDIT_ROWS) {
    const t = toolRowText(row);
    const visible = t.plain.join(" ");
    expect(visible, JSON.stringify(row)).not.toMatch(/[A-Z][A-Z0-9]*_[A-Z0-9_]{2,}|~\/|docs\/|\.env|\.md\b|cdp|browser\.|\/__|handover|cron job/i);
    expect(t.plain.length).toBeGreaterThan(0);
    const technical = t.technical.join(" ");
    for (const raw of [row.ownerAction, row.evidence].filter((x): x is string => !!x && isTechnicalText(x))) expect(technical).toContain(raw);
  }
  expect(toolRowText(AUDIT_ROWS[1]!).plain).toEqual(["Needs its key added on the hub PC."]);
  expect(toolRowText(AUDIT_ROWS[5]!).plain).toEqual(["Its last check failed."]);
  // Plain sentences pass through untouched.
  expect(toolRowText({ status: "setup-required", ownerAction: "Install the OpenClaw app on the phone" }).plain).toEqual(["Install the OpenClaw app on the phone"]);
  // The page renders Technical detail and nothing else from the raw fields.
  const page = src("src/components/shell/pages/system-page.tsx");
  expect(page).toContain("Technical detail");
  expect(page).not.toMatch(/\{c\.ownerAction\}|\{c\.evidence\}/);
});

// ── 12: Devices and people, for an unconfirmed browser ─────────────────────────────────────────────
test("12: an unconfirmed browser is told what it can really do, in words, and no page called Profile is mentioned", () => {
  const me = { principal: { personId: "mehroz", via: "tailnet-person", actor: "process", displayName: "Mehroz" }, waitingSession: null, hubSession: null } as never;
  expect(isUnconfirmed(me)).toBe(true);
  expect(isUnconfirmed({ principal: { actor: "human" }, waitingSession: null, hubSession: { pending: true } } as never)).toBe(true);
  expect(isUnconfirmed({ principal: { actor: "human" }, waitingSession: null, hubSession: null } as never)).toBe(false);
  expect(memoryWords({ people: [{ id: "usman", name: "Usman" }, { id: "mehroz", name: "Mehroz" }], permissions: { memory: ["shared", "usman", "mehroz"] } } as never)).toBe("shared memory, Usman's memory, Mehroz's memory");
  const panel = src("src/components/profile/profile-panel.tsx");
  expect(panel).not.toMatch(/Open Profile|Profile →|that browser's Profile|in Profile on/);
  expect(panel).toContain("System › Devices and people");
  expect(panel).toContain("Read-only shared workspace. This browser can't approve or change anything until it is confirmed.");
});

// ── 14: Settings › Jarvis, all or nothing ──────────────────────────────────────────────────────────
test("14: the page says what is wrong before sending, and a refused save changes nothing on the server", () => {
  const owner = { name: "Usman", role: "owner" };
  expect(jarvisSettingsProblem("Evening.", [owner])).toBeNull();
  expect(jarvisSettingsProblem("Evening.", [])).toBe("Add at least one person, with the role owner.");
  expect(jarvisSettingsProblem("", [owner])).toContain("greeting");
  expect(jarvisSettingsProblem("Hi", [{ name: "Mehroz", role: "co-founder" }])).toContain("role owner");
  expect(jarvisSettingsProblem("Hi", [owner, { name: "usman", role: "x" }])).toBe("Two people have the same name.");
  expect(jarvisSettingsProblem("Hi", [{ name: " ", role: "owner" }])).toBe("Person 1 needs a name.");
  expect(notSaved("Keep it to 20 people")).toBe("Keep it to 20 people. Nothing was saved.");
  expect(notSaved("Two people have the same name.")).toBe("Two people have the same name. Nothing was saved.");
  const comp = src("src/components/operator/jarvis-settings.tsx");
  expect(comp).toContain("jarvisSettingsProblem(greeting, people)");
  expect(comp).toContain("notSaved(");

  // Server: a valid greeting sent together with an empty people list is refused AND not half-saved.
  const root = mkdtempSync(join(tmpdir(), "jarvis-atomic-"));
  try {
    mkdirSync(join(root, ".operator-data"));
    writeFileSync(join(root, ".operator-data", "people.json"), JSON.stringify({ people: [{ name: "Usman", role: "owner" }] }));
    const before = readJarvisSettings(root).greeting;
    expect(() => writeJarvisSettings(root, { greeting: "A brand new greeting", people: [] })).toThrow("Add at least one person");
    expect(readJarvisSettings(root).greeting).toBe(before);
    expect(readJarvisSettings(root).people).toHaveLength(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── 11 (P11): the usage page shows labels, never variable names or the credentials file ───────────────
test("11/P11: AI usage prints a plain key label and no variable name or credentials path", async () => {
  const { keyLabel } = await import("../../src/components/ai-usage/key-label");
  const row = (provider: string, keyName: string) => ({ provider, keyName });
  expect(keyLabel(row("OpenRouter", "OPENROUTER_API_KEY"))).toBe("OpenRouter key");
  expect(keyLabel(row("OpenRouter", "OPENROUTER_API_KEY_ALT"))).toBe("OpenRouter key (second account)");
  expect(keyLabel(row("Twilio", "TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN"))).toBe("Twilio account");
  expect(keyLabel(row("TypeSafe (Jev)", "TYPESAFE_API_KEY, TYPESAFE_ORG_ID"))).toBe("TypeSafe keys");
  expect(keyLabel(row("ElevenLabs", "ELEVENLABS_API_KEY"))).toBe("ElevenLabs key");
  expect(keyLabel(row("Higgsfield", "Signed in (OAuth, Design page)"))).toBe("Signed in");
  expect(keyLabel(row("Local", "per-call receipts"))).toBe("Counted from this app's own receipts");
  for (const [p, k] of [["Pinecone", "PINECONE_API_KEY"], ["Groq", "GROQ_API_KEY"], ["Retell AI", "RETELL_API_KEY"], ["TokenHarbour", "TOKENHARBOUR_API_KEY"], ["X", "~/.claude/.credentials.json"]]) expect(keyLabel(row(p!, k!))).not.toMatch(/[A-Z][A-Z0-9]*_[A-Z0-9_]+|~|credentials/);
  const page = src("src/components/ai-usage/ai-usage-page.tsx");
  expect(page).toContain("keyLabel(r)");
  expect(page).not.toContain("{r.keyName}");
  expect(src("scripts/ai-usage/sources.ts")).not.toContain('"No Claude Code sign-in found in ~/.claude/.credentials.json"');
});
