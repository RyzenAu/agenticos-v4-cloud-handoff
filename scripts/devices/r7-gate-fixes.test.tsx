import { afterAll, beforeAll, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { claudeDisplay, hermesPageState, toolNextStep, toolView } from "../../src/lib/tool-status";
import { providerView, isTechnicalText, type ProviderStatus } from "../../src/components/shell/system-facts";
import { notSaved } from "../../src/components/operator/jarvis-settings-check";
import { claudeVerdict } from "../../src/lib/claude-code-status";
import { ConnectionsPanel } from "../../src/components/business/connections-panel";

/** R7 gate fixes M1, M2, m1, m10, m11: what the owner reads, pinned as words. */
const saved: Record<string, PropertyDescriptor | undefined> = {};
const realFetch = globalThis.fetch;
beforeAll(() => {
  const { window, document } = parseHTML("<html><body></body></html>");
  for (const [k, v] of Object.entries({ window, document, IS_REACT_ACT_ENVIRONMENT: true })) {
    saved[k] = Object.getOwnPropertyDescriptor(globalThis, k);
    Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  }
});
afterAll(() => {
  globalThis.fetch = realFetch;
  for (const [k, d] of Object.entries(saved)) (d ? Object.defineProperty(globalThis, k, d) : delete (globalThis as Record<string, unknown>)[k]);
});

const hermesRow: ProviderStatus[] = [{ id: "hermes", ready: true, installed: true, detail: "installed" }];

test("M1: Hermes running shows the running headline and the tabs, even though the tool check can only say 'Installed · not verified'", () => {
  const view = toolView(hermesRow, "hermes");
  const page = hermesPageState({ status: { installed: true, needsSetup: false, defaultModel: "gpt-6-sol" }, isLoading: false, view, placeholder: "Checking…" });
  expect(page.headline).toBe("Running gpt-6-sol. Ask it anything, or see what it knows about you.");
  expect(page.headline).not.toMatch(/check again/i);
  expect(page.showTabs).toBe(true);
  expect(page.showInstall).toBe(false);
  expect(page.tone).toBe("success");
});

test("M1: when the tool check and the live Hermes read disagree, exactly one of the install card and the tabs shows", () => {
  for (const view of [null, toolView(hermesRow, "hermes"), toolView([{ id: "hermes", ready: false, installed: false, detail: "" }], "hermes")]) {
    for (const installed of [true, false]) {
      const page = hermesPageState({ status: { installed }, isLoading: false, view, placeholder: "Not checked yet" });
      expect(page.showTabs !== page.showInstall, `view=${view?.label} installed=${installed}`).toBe(true);
    }
  }
  const noRead = hermesPageState({ status: undefined, isLoading: false, view: toolView(hermesRow, "hermes"), placeholder: "x" });
  expect(noRead.showInstall).toBe(true);
});

const maxAccount = (slot: string, state: "connected" | "signed-out", limitReached = false) => ({
  accountSlot: slot,
  installed: true,
  cliVersion: "2.1",
  connection: { state, reason: state === "signed-out" ? "signed out" : null, subscription: "max", checkedAt: null },
  allowance: { limitReached, windows: [] },
});
const verdictFor = (accts: unknown[]) => claudeVerdict({ accounts: accts } as never, false);
const signedOut = toolView([{ id: "claude", ready: false, installed: true, detail: "Claude Code is signed out. Sign in with /login." }], "claude");
const ready = toolView([{ id: "claude", ready: true, installed: true, detail: "ok" }], "claude");

test("M2: a Claude plan limit overrides a green 'Ready · signed in'", () => {
  const verdict = verdictFor([maxAccount("claude:max", "connected", true)]);
  const shown = claudeDisplay({ view: ready, verdict, anyUsable: false, placeholder: "Checking…" });
  expect(shown.tone).toBe("warn");
  expect(shown.state).not.toMatch(/Ready/);
  expect(shown.state).toMatch(/limit/i);
});

test("M2: every account at its limit is a warning too", () => {
  const verdict = verdictFor([maxAccount("claude:max", "connected", true), maxAccount("claude:max-2", "connected", true)]);
  const shown = claudeDisplay({ view: ready, verdict, anyUsable: false, placeholder: "" });
  expect(shown.tone).toBe("warn");
  expect(shown.state).toMatch(/limit/i);
});

test("M2: default signed out but claude:max-2 connected is not 'Sign-in needed'", () => {
  const verdict = verdictFor([maxAccount("claude:max", "signed-out"), maxAccount("claude:max-2", "connected")]);
  const shown = claudeDisplay({ view: signedOut, verdict, anyUsable: true, placeholder: "" });
  expect(shown.state).not.toBe("Sign-in needed");
  expect(shown.tone).toBe("success");
  // With nothing usable the shared word still stands.
  expect(claudeDisplay({ view: signedOut, verdict, anyUsable: false, placeholder: "" }).state).toBe("Sign-in needed");
});

test("m1: 'Nothing was saved.' only follows a refusal; other failures say it may have saved", () => {
  expect(notSaved("Keep it to 20 people")).toBe("Keep it to 20 people. Nothing was saved.");
  expect(notSaved("Refused", 400)).toBe("Refused. Nothing was saved.");
  expect(notSaved("Refused", 422)).toContain("Nothing was saved.");
  for (const status of [0, 500, 502, 504]) {
    const text = notSaved("Request failed", status);
    expect(text).toBe("Request failed. This may not have been saved. Reload to check.");
    expect(text).not.toContain("Nothing was saved");
  }
});

test("m10: next-step lines never send a person to run the hub-only check; they say when it was last checked", () => {
  const states = [signedOut, ready, toolView([{ id: "hermes", ready: false, installed: true, detail: "" }], "hermes"), toolView([{ id: "claude", ready: false, installed: false, detail: "Install" }], "claude"), null];
  for (const v of states) {
    const line = toolNextStep(v?.state === "setup" ? "claude" : "hermes", v, "2026-10-03T04:15:00.000Z");
    expect(line, v?.label).not.toMatch(/check again|System|Check now/i);
    expect(isTechnicalText(line)).toBe(false);
    if (v && v.state !== "verified") expect(line).toMatch(/hub PC/);
  }
  expect(toolNextStep("hermes", toolView(hermesRow, "hermes"), "2026-10-03T04:15:00.000Z")).toMatch(/last checked/);
  expect(providerView(hermesRow[0]!).state).toBe("installed");
});

async function renderPanel(mercury: "error" | "unavailable") {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
    if (url.includes("/business/native-connections")) return mercury === "error" ? json({ error: "down" }, 500) : json({ mercury: { available: false } });
    if (url.includes("stripe/status")) return json({ configured: false, keyStatus: { present: false, ok: false, message: null } });
    if (url.includes("/business/integrations")) return json({ integrations: [] });
    if (url.includes("token")) return json({ token: "t" });
    return json({ snapshots: [], finances: null });
  }) as typeof fetch;
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => root.render(createElement(QueryClientProvider, { client: qc }, createElement(ConnectionsPanel))));
  await act(async () => void (await new Promise((r) => setTimeout(r, 80))));
  const out = { text: host.textContent ?? "", rows: [...host.querySelectorAll(".biz-provider-row")].map((r) => r.getAttribute("aria-label")) };
  await act(async () => root.unmount());
  host.remove();
  return out;
}

test("m11: when the Mercury check fails, its row stays, after Stripe, with Recheck", async () => {
  const { text, rows } = await renderPanel("error");
  expect(rows.indexOf("Stripe")).toBeGreaterThanOrEqual(0);
  expect(rows.indexOf("Mercury")).toBeGreaterThan(rows.indexOf("Stripe"));
  expect(text).toContain("Codex access couldn’t be checked");
  expect(text).toContain("Recheck");
});

test("m11: when Mercury is simply unavailable and nothing is saved, the row stays hidden", async () => {
  const { rows } = await renderPanel("unavailable");
  expect(rows).not.toContain("Mercury");
});
