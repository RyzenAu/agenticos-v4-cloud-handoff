/**
 * The OS as Dot opens it through the gateway (docs/gateway/DOT-UI-ROUTES.md). ONLY in the gateway's own UI bundle
 * (`__MU_GATEWAY_UI__`, set by vite.config.ts when MU_GATEWAY_SPA_BUILD=1): the founders' app never runs any of this.
 *
 * The pages fetch their data from founder routes. In Dot's browser this module:
 *   - sends the reads Dot may make to the gateway's filtered adapters with the SAME response shape (/__gateway/ui/...): the
 *     CRM snapshot and records, business finance, the redacted job log, the shared bot computers;
 *   - answers requests for founders-only data at once, without asking the server, in the server's usual refusal shape
 *     `{ error }` with "Not available to Dot: <why>", so each panel shows its existing error state with that reason, and the
 *     page's notice (DotGatewayNotice) lists them. The gateway would refuse these anyway; this only avoids the noise.
 * Everything not listed goes to the gateway unchanged (and the gateway's own allow-list decides).
 */

import { GATEWAY_CRM_READS } from "../../scripts/gateway/crm-policy";

declare const __MU_GATEWAY_UI__: boolean;
export const isDotGatewayUi = (): boolean => typeof __MU_GATEWAY_UI__ !== "undefined" && __MU_GATEWAY_UI__ === true;
/** A saved-result link's target: a new tab for the founders; in place for Dot, whose browser blocks new tabs. */
export const resultLinkProps = (): { target?: "_blank"; rel: string } => (isDotGatewayUi() ? { rel: "noreferrer" } : { target: "_blank", rel: "noopener noreferrer" });

/** GET requests the gateway answers through a filtered adapter, in the founder route's shape. */
export const DOT_UI_REMAP: ReadonlyArray<{ test: RegExp; to: (path: string) => string }> = [
  { test: /^\/__crm\/(snapshot|record|finance)$/, to: (p) => p.replace(/^\/__crm\//, "/__gateway/ui/crm/") },
  { test: /^\/__finance_manual\/(summary|status|transactions)$/, to: (p) => p.replace(/^\/__finance_manual\//, "/__gateway/ui/finance/") },
  { test: /^\/__jobs(\/events|\/[0-9a-f-]{36})?$/i, to: (p) => p.replace(/^\/__jobs/, "/__gateway/ui/jobs") },
  { test: /^\/__computers$/, to: () => "/__gateway/ui/computers" },
  // The Jarvis page: Dot's OWN thread (the thread head and the conversations list are both answered by one adapter, one fixed thread).
  { test: /^\/__operator\/(screen\/command\/thread|conversations)$/, to: () => "/__gateway/ui/jarvis/thread" },
];

/** POSTs the page makes that go to Dot's own routes instead (the same body; the adapter answers in the page's reply shape). */
export const DOT_UI_POST_REMAP: ReadonlyArray<{ test: RegExp; to: string }> = [
  // Stop on the Jarvis page ({ jobId } -> { outcome, state }), for Dot's own jobs only.
  { test: /^\/__operator\/screen\/command\/cancel$/, to: "/__gateway/ui/jarvis/stop" },
];

/** Founder-route reads the gateway's own allow-list opens as they are (policy.ts names the capability). Checked first. */
export const DOT_UI_PASS: ReadonlyArray<RegExp> = [/^\/__operator\/business\/finance\/stripe\/(status|summary)$/];

/**
 * The CRM page's operations (POST /__crm/ops { name, input }) go to Dot's own CRM API, which takes the same body and answers
 * with the same receipt: reads to /__gateway/crm/read (crm.read), everything else to /__gateway/crm/ops (crm.write), where
 * the founders' operations are refused with their reason.
 */
export function dotCrmOp(body: unknown): string {
  let name = "";
  try {
    name = String((JSON.parse(typeof body === "string" ? body : "{}") as { name?: unknown }).name ?? "");
  } catch {
    name = "";
  }
  return GATEWAY_CRM_READS.includes(name) ? "/__gateway/crm/read" : "/__gateway/crm/ops";
}

/** Founders-only data: refused at once, with the reason the page shows. Order matters: the first match wins. */
export const DOT_NOT_AVAILABLE: ReadonlyArray<{ test: RegExp; reason: string }> = [
  { test: /^\/__devices(\/|$)/, reason: "devices and sign-ins are the founders' own" },
  { test: /^\/__approvals(\/|$)/, reason: "approvals and decisions are the founders'" },
  { test: /^\/__operator\/(profile|away|private-advisor)(\/|$)/, reason: "a founder's own profile, away mode and advisor" },
  { test: /^\/__operator\/(jarvis|conversations|screen)(\/|$)/, reason: "a founder's own Jarvis and conversations" },
  { test: /^\/__operator\/state(\/|$)/, reason: "the founders' own workspace state (their mail, saved notes and Jarvis); Dot reads authorised mailboxes and shared memory through its own APIs" },
  { test: /^\/__operator\/calendar(\/|$)/, reason: "the founders' calendars" },
  { test: /^\/__operator\/business(\/|$)/, reason: "the founders' business brief (built from their mail and approvals); Dot reads business finance and records" },
  { test: /^\/__operator\/(connections|setup|native-connections)(\/|$)/, reason: "accounts, credentials and mailbox connections" },
  { test: /^\/__operator\/coding\/(accounts|focus)(\/|$)/, reason: "coding accounts hold sign-ins; the focus is a founder's own" },
  { test: /^\/__operator\/(memory|quick-actions|search|agent-jobs|models|inbox|mail-archive)(\/|$)/, reason: "the founders' vault, mail, files and own agent chats" },
  { test: /^\/__(claude_models|hermes_models|ai_usage)(\/|$)/, reason: "model accounts and usage are the founders'" },
  { test: /^\/__design_/, reason: "the design studio is the founders' (not granted)" },
  { test: /^\/__workspace(\/(needs-you|today|email|receptionist|enquiries|call-queue))?$/, reason: "approvals, mail, calls and enquiries are the founders'" },
  { test: /^\/__receptionist(\/|$)/, reason: "receptionist call data (the launch is on hold)" },
  { test: /^\/__(lead-sites|websites)(\/|$)/, reason: "publishing and hosting accounts are the founders'" },
  { test: /^\/__memory(\/|$)/, reason: "the raw memory vault; Dot recalls through its own memory API" },
  { test: /^\/__finance_manual(\/|$)/, reason: "the founders' ledger tools (personal rows, imports, vendor rules)" },
  { test: /^\/__crm(\/|$)/, reason: "this CRM action from the page; Dot changes records through its own CRM API" },
  { test: /^\/__computers(\/|$)/, reason: "the live viewer and computer controls; Dot uses its own bots API" },
  { test: /^\/__jobs(\/|$)/, reason: "starting, stopping or releasing a job from the page; Dot starts work through its own tasks API" },
  { test: /^\/__dev_restart(\/|$)/, reason: "the hub's console" },
  { test: /^\/__journeys(\/|$)/, reason: "the founders' department journeys" },
];

export const NOT_AVAILABLE_PREFIX = "Not available to Dot";
/** The reasons refused on the current page (DotGatewayNotice shows them). */
const refusedHere = new Map<string, Set<string>>();
export const dotRefusals = (page: string): string[] => [...(refusedHere.get(page) ?? [])];
export const DOT_REFUSAL_EVENT = "dot-gateway-refusal";

/** What happens to one request in Dot's browser: sent on, sent to an adapter, or answered as not available. */
export function dotRoute(method: string, pathname: string, body?: unknown): { kind: "pass" } | { kind: "remap"; path: string } | { kind: "refuse"; reason: string } {
  if (!pathname.startsWith("/__") || pathname.startsWith("/__gateway/") || pathname === "/__token") return { kind: "pass" };
  if (DOT_UI_PASS.some((p) => p.test(pathname))) return { kind: "pass" };
  if (method === "POST" && pathname === "/__crm/ops") return { kind: "remap", path: dotCrmOp(body) };
  if (method === "POST") for (const r of DOT_UI_POST_REMAP) if (r.test.test(pathname)) return { kind: "remap", path: r.to };
  if (method === "GET" || method === "HEAD") for (const r of DOT_UI_REMAP) if (r.test.test(pathname)) return { kind: "remap", path: r.to(pathname) };
  for (const n of DOT_NOT_AVAILABLE) if (n.test.test(pathname)) return { kind: "refuse", reason: n.reason };
  return { kind: "pass" };
}

let installed = false;
/** Wrap fetch once, in the gateway's UI bundle only. */
export function installDotGatewayGuard() {
  if (installed || typeof window === "undefined" || !isDotGatewayUi()) return;
  installed = true;
  const original = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? (typeof input === "object" && !(input instanceof URL) ? input.method : "GET")).toUpperCase();
    let url: URL;
    try {
      url = new URL(raw, window.location.href);
    } catch {
      return original(input, init);
    }
    if (url.origin !== window.location.origin) return original(input, init);
    const route = dotRoute(method, url.pathname, init?.body);
    if (route.kind === "remap") return original(`${route.path}${url.search}`, { ...init, method });
    if (route.kind === "refuse") {
      const page = window.location.pathname;
      const set = refusedHere.get(page) ?? new Set<string>();
      set.add(route.reason);
      refusedHere.set(page, set);
      window.dispatchEvent(new CustomEvent(DOT_REFUSAL_EVENT, { detail: { page, method, path: url.pathname, reason: route.reason } }));
      return Promise.resolve(new Response(JSON.stringify({ ok: false, error: `${NOT_AVAILABLE_PREFIX}: ${route.reason}.`, notAvailableToDot: true }), { status: 403, headers: { "Content-Type": "application/json" } }));
    }
    return original(input, init);
  };
}
