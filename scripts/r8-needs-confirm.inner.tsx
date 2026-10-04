// Round 8 (E), coordinator item: a read refused with 403 "needs-human-session" (an unconfirmed browser) says so once and calmly, instead
// of a generic failure, a retry loop or a wrong state ("Install Hermes"). The server rule is untouched: these tests only feed the page the
// gate's real answer (scripts/identity/gate.ts) and read what it shows.
import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

mock.module("@tanstack/react-router", () => ({
  Link: ({ children, to, hash, search: _s, activeProps: _a, inactiveProps: _i, preload: _p, ...rest }: Record<string, unknown> & { children?: unknown; to?: string; hash?: string }) =>
    createElement("a", { href: `${to ?? ""}${hash ? `#${hash}` : ""}`, ...rest }, children as never),
  useNavigate: () => () => undefined,
}));

const { isNeedsConfirm, throwIfNeedsConfirm, NeedsConfirmError, NEEDS_CONFIRM_LINE } = await import("../src/lib/needs-confirm");
const { OperatorRequestError } = await import("../src/lib/operator");
const { CrmRequestError, crmOperation } = await import("../src/lib/crm-client");
const { unconfirmedFrom } = await import("../src/components/shell/signed-in");
const { hermesPageState } = await import("../src/lib/tool-status");

/** The gate's own refusal (scripts/identity/gate.ts, SERVER_NEEDS_SESSION). */
const GATE_BODY = {
  error: "That runs on the server and needs a confirmed browser session: pair this browser first (System › Devices and people), then try again.",
  route: "/__x",
  reason: "needs-human-session",
};
const gate403 = () => new Response(JSON.stringify(GATE_BODY), { status: 403, headers: { "content-type": "application/json" } });

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

async function render(el: ReturnType<typeof createElement>) {
  const client = new QueryClient({ defaultOptions: { queries: { retryDelay: 1 } } });
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(createElement(QueryClientProvider, { client }, el));
  });
  for (let i = 0; i < 8; i++)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 15));
    });
  return { host, text: () => host.textContent ?? "", unmount: () => act(async () => root.unmount()) };
}

test("the gate's 403 is recognised from every client's error, and nothing else is", async () => {
  expect(isNeedsConfirm(new OperatorRequestError(GATE_BODY.error, 403, "needs-human-session"))).toBe(true);
  expect(isNeedsConfirm(new OperatorRequestError(GATE_BODY.error, 403))).toBe(true); // by its words
  expect(isNeedsConfirm(new CrmRequestError(GATE_BODY.error, 403))).toBe(true);
  expect(isNeedsConfirm(new NeedsConfirmError())).toBe(true);
  expect(isNeedsConfirm(new OperatorRequestError("Lead not found.", 404))).toBe(false);
  expect(isNeedsConfirm(new OperatorRequestError("Companions talk to /__devices/companion only.", 403))).toBe(false);
  // The server's console-only refusal (reason console-only) is a different answer: confirming the browser would not help.
  expect(isNeedsConfirm(new OperatorRequestError("That changes the server's own keys, configuration or software, so it can only be done at the server itself.", 403, "console-only"))).toBe(false);
  expect(isNeedsConfirm(new Error("status 500"))).toBe(false);
  expect(isNeedsConfirm(null)).toBe(false);
  await expect(throwIfNeedsConfirm(gate403())).rejects.toBeInstanceOf(NeedsConfirmError);
  const other = new Response("{}", { status: 403 });
  expect(await throwIfNeedsConfirm(other)).toBe(other);
});

test("a bare tailnet login counts as unconfirmed, a confirmed person and the hub owner do not", () => {
  expect(unconfirmedFrom({ principal: { via: "tailnet-person", actor: "process" } })).toBe(true);
  expect(unconfirmedFrom({ hubSession: { pending: true }, principal: { via: "loopback-owner", actor: "process" } })).toBe(true);
  expect(unconfirmedFrom({ principal: { via: "paired-session", actor: "human" } })).toBe(false);
  expect(unconfirmedFrom({ principal: { via: "loopback-owner", actor: "human" } })).toBe(false);
  expect(unconfirmedFrom(null)).toBe(false);
});

test("Hermes: a refused read shows neither the install card nor the tabs nor a status word", () => {
  const page = hermesPageState({ status: undefined, isLoading: false, view: null, placeholder: "Not checked yet", needsConfirm: true });
  expect(page.showNeedsConfirm).toBe(true);
  expect(page.showInstall).toBe(false);
  expect(page.showTabs).toBe(false);
  expect(page.statusWord).toBe("");
  expect(page.headline).not.toMatch(/one command|install/i);
  expect(hermesPageState({ status: undefined, isLoading: false, view: null, placeholder: "x" }).showNeedsConfirm).toBe(false);
});

test("Hermes: the status read stops after one 403 (no retry loop, no poll)", async () => {
  let calls = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).includes("/__hermes_status")) {
      calls++;
      return gate403();
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  const { useHermesStatus } = await import("../src/routes/-pages/hermes");
  const seen: unknown[] = [];
  const Probe = () => {
    seen.push(useHermesStatus().error);
    return null;
  };
  const r = await render(createElement(Probe));
  expect(calls).toBe(1);
  expect(isNeedsConfirm(seen.at(-1))).toBe(true);
  await r.unmount();
});

test("Agent questions: the refused read says to confirm the browser, with no Retry button", async () => {
  globalThis.fetch = (async () => gate403()) as typeof fetch;
  const { AgentQuestionsPanel } = await import("../src/components/operator/agent-jobs-panel");
  const r = await render(createElement(AgentQuestionsPanel));
  expect(r.text()).toContain(NEEDS_CONFIRM_LINE);
  expect(r.text()).not.toMatch(/couldn.t be loaded|Retry/);
  expect(r.host.querySelector("a")?.getAttribute("href")).toBe("/system#system-devices");
  await r.unmount();
});

test("CRM: the operation transport turns the gate's 403 into the recognised error, and the saved-views line follows it", async () => {
  globalThis.fetch = (async (input: RequestInfo | URL) =>
    String(input).includes("/__token") ? new Response(JSON.stringify({ token: "t" }), { status: 200 }) : gate403()) as typeof fetch;
  const err = await crmOperation("crm.views.list", {}).catch((e) => e);
  expect(isNeedsConfirm(err)).toBe(true);
  const src = readFileSync(join(import.meta.dir, "../src/components/crm/directory.tsx"), "utf8");
  expect(src).toContain("saved.isError && isNeedsConfirm(saved.error) && <NeedsConfirmNote");
  expect(src).toContain("saved.isError && !isNeedsConfirm(saved.error)");
});

test("Work: the owner-approval buttons follow the unconfirmed flag (disabled with the reason shown)", () => {
  const src = readFileSync(join(import.meta.dir, "../src/components/workspace/decision-row.tsx"), "utf8");
  expect(src).toContain("useBrowserPending()");
  expect(src).toContain("isNeedsConfirm(e) ?");
  expect(src).toContain("disabled={busy || pending}");
  expect(src).toContain("Confirm this browser first");
  expect(readFileSync(join(import.meta.dir, "../src/components/shell/signed-in.ts"), "utf8")).toContain("pending: unconfirmedFrom(me)");
});

test("CRM: an unconfirmed browser gets one message, not the shell banner plus the private-text notice", async () => {
  const me = (principal: unknown, hubSession?: unknown) =>
    (async (input: RequestInfo | URL) =>
      String(input).includes("/__devices/me")
        ? new Response(JSON.stringify({ authorised: true, principal, hubSession }), { status: 200, headers: { "content-type": "application/json" } })
        : new Response("{}", { status: 404 })) as typeof fetch;
  const { PrivateTextNotice } = await import("../src/components/crm/private-text-notice");
  const { NeedsConfirmNote } = await import("../src/components/shell/needs-confirm-note");
  // Pending browser: the shell banner is showing, so the CRM notice and the quiet note say nothing.
  globalThis.fetch = me({ personId: "usman", via: "loopback-owner", actor: "process", displayName: "Usman" }, { pending: true });
  let r = await render(createElement("div", null, createElement(PrivateTextNotice, { withheld: true }), createElement(NeedsConfirmNote, { unlessBanner: true })));
  expect(r.text()).not.toMatch(/Private text is hidden|isn't confirmed/);
  await r.unmount();
  // A bare tailnet login is covered by the banner as well.
  globalThis.fetch = me({ personId: "mehroz", via: "tailnet-person", actor: "process", displayName: "Mehroz" });
  r = await render(createElement(PrivateTextNotice, { withheld: true }));
  expect(r.text()).not.toContain("Private text is hidden");
  await r.unmount();
  // No banner (for example a program at the hub): the CRM notice is the one message.
  globalThis.fetch = me({ personId: "usman", via: "loopback-owner", actor: "process", displayName: "Usman" });
  r = await render(createElement(PrivateTextNotice, { withheld: true }));
  expect(r.text()).toContain("Private text is hidden");
  await r.unmount();
  // Nothing withheld: no notice either way.
  r = await render(createElement(PrivateTextNotice, { withheld: false }));
  expect(r.text()).not.toContain("Private text is hidden");
  await r.unmount();
});
