// Fixture reads for tests and for building the Setup tab before the hub's routes are wired. Shapes are the real
// services' types, so a change there breaks these at typecheck. Never imported by the shipped page.
import type { CodingAccount } from "@/lib/coding-client";
import type { ComputerView } from "@/lib/computers-client";
import type { MemoryPool, RouterLite, RoutineRow, SetupSources } from "./sources";

export const NOW = Date.parse("2026-10-02T02:00:00Z");

export function computer(name: string, over: Partial<ComputerView> = {}): ComputerView {
  return {
    name,
    id: `dev-${name}`,
    label: name[0]!.toUpperCase() + name.slice(1),
    kind: "cloud-computer",
    owner: "shared",
    adapter: "wsl",
    state: "online",
    desired: "running",
    desktop: true,
    browser: true,
    capabilities: ["browser"],
    assigned: null,
    controller: { kind: null, who: null, jobId: null, expiresAt: null, epoch: null },
    takeoverPending: null,
    paused: null,
    lastJob: null,
    resource: null,
    lastSeen: NOW,
    failure: null,
    recoveries: 0,
    createdBy: "usman" as ComputerView["createdBy"],
    createdAt: NOW,
    viewer: { snapshot: true, vnc: true },
    ...over,
  };
}

/** A screen the hub says is failing (the viewer's layer is down), for a computer that is otherwise online. */
export const SCREEN_DOWN: NonNullable<ComputerView["screen"]> = { applicable: true, ok: false, checking: false, layer: "vnc", reason: "The screen server (VNC) isn't running, so the live view can't connect.", next: "restart-display", nextLabel: "Restart the display", at: NOW, lastFrameAt: null, lastShotAt: null, retry: { used: 0, max: 3, nextAt: null } };
export const SCREEN_OK: NonNullable<ComputerView["screen"]> = { ...SCREEN_DOWN, ok: true, layer: null, reason: null, next: null, nextLabel: null, lastFrameAt: NOW };

export const claudeAccount = (slot: string, label: string, over: Partial<Extract<CodingAccount, { provider?: string }>> = {}): CodingAccount =>
  ({
    accountSlot: slot,
    provider: "anthropic",
    label,
    plan: "claude-max-20x",
    installed: true,
    cliVersion: "2.1.280",
    connection: { state: "connected", reason: null, subscription: "max", checkedAt: "2026-10-02T01:55:00Z" },
    allowance: { windows: [{ label: "Weekly", usedPercent: 41, resetsAt: "2026-10-06T23:00:00Z" }], limitReached: false },
    models: ["claude-opus-5-5", "claude-sonnet-5-5"],
    modelsVerified: ["claude-sonnet-5-5"],
    ...over,
  }) as CodingAccount;

export const ACCOUNTS: CodingAccount[] = [
  claudeAccount("claude:max", "Claude Max 1", { allowance: { windows: [{ label: "Weekly", usedPercent: 100, resetsAt: "2026-10-06T23:00:00Z" }], limitReached: true } }),
  claudeAccount("claude:max-2", "Claude Max 2"),
  claudeAccount("claude:max-3", "Claude Max 3", { connection: { state: "signed-out", reason: "needs sign-in", subscription: null, checkedAt: null } }),
  { accountSlot: "codex:a", installed: true, cliVersion: "0.154", plan: "ChatGPT Pro", creditsAllowed: false, home: "x", reading: { peakPercent: 12, resetsAt: null }, models: ["gpt-6-astra"] },
];

export const ROUTER: RouterLite = {
  healthAt: "2026-10-02T01:00:00Z",
  models: [
    { id: "groq/gpt-oss-120b", provider: "groq", route: "free", verifiedFree: true, status: "verified", health: { state: "ok", until: null, detail: null } },
    { id: "cline/mimo-v2.6-flash", provider: "cline", route: "free", verifiedFree: true, status: "verified", health: { state: "limited", until: "2026-10-02T06:00:00Z", detail: null } },
    { id: "codex/gpt-6-sol", provider: "codex", route: "subscription", verifiedFree: false, status: "verified", health: { state: "ok", until: null, detail: null } },
    { id: "openrouter/deepseek-v4-pro", provider: "openrouter", route: "metered", verifiedFree: false, status: "configured", health: null },
    { id: "gemini/flash", provider: "gemini", route: "free", verifiedFree: false, status: "not-configured", health: null },
  ],
};

export const ROUTINES: RoutineRow[] = [
  { id: "daily-leads", name: "Morning lead check", kind: "routine", source: "schedule", state: "active", schedule: { kind: "daily", at: "08:30", tz: "Australia/Sydney" }, nextRunAt: "2026-10-03T08:30:00+10:00" },
  { id: "hourly-inbox", name: "Inbox sweep", kind: "routine", source: "schedule", state: "paused", schedule: { kind: "interval", everyMinutes: 60 }, nextRunAt: null },
  { id: "on-reply", name: "Reply received", kind: "event", source: "gmail", state: "active", nextRunAt: null },
];

export const SKILLS = [
  { name: "seo", description: "Audit a page's search basics." },
  { name: "copywriting", description: "Write or rewrite page copy." },
  { name: "webapp-testing" },
];

export const MEMORY_ON: MemoryPool = { mode: "on", hindsightEnabled: true, reason: null, pending: 0, lastSuccessAt: "2026-10-02T01:30:00Z" };
export const MEMORY_OFF: MemoryPool = { mode: "off", hindsightEnabled: false, reason: "HINDSIGHT_URL is off", pending: null, lastSuccessAt: null };

export function fixtureSources(over: Partial<SetupSources> = {}): SetupSources {
  return {
    computers: async () => ({ status: "ok", computers: [computer("research"), computer("builder", { state: "busy", assigned: { agent: "Builder", jobId: "j1", by: "usman" as ComputerView["createdBy"], title: "Fix the footer" } })] }),
    accounts: async () => ({ status: "ok", accounts: ACCOUNTS }),
    router: async () => ({ status: "ok", router: ROUTER }),
    skills: async () => ({ status: "ok", skills: SKILLS }),
    routines: async () => ({ status: "ok", routines: ROUTINES }),
    memory: async () => ({ status: "ok", memory: MEMORY_ON }),
    ...over,
  };
}
