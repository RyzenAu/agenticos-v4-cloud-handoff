// @ts-ignore: the browser tsconfig has no bun types (bun test supplies this module).
import { describe, expect, test } from "bun:test";
import { GATEWAY_CRM_FOUNDER_ONLY } from "../../scripts/gateway/crm-policy";
import { decide } from "../../scripts/gateway/policy";
import { dotCrmOp, dotRoute, DOT_NOT_AVAILABLE, isDotGatewayUi } from "./dot-gateway";

describe("Dot's browser: remap to the filtered adapters, answer founders-only routes as not available, pass the rest", () => {
  test("never active outside the gateway's own UI bundle", () => {
    expect(isDotGatewayUi()).toBe(false);
  });

  test("reads Dot may make go to /__gateway/ui adapters, each a policy rule naming one capability", () => {
    const cases: Array<[string, string, string]> = [
      ["/__crm/snapshot", "/__gateway/ui/crm/snapshot", "crm.read"],
      ["/__crm/record", "/__gateway/ui/crm/record", "crm.read"],
      ["/__crm/finance", "/__gateway/ui/crm/finance", "finance.read"],
      ["/__finance_manual/summary", "/__gateway/ui/finance/summary", "finance.read"],
      ["/__finance_manual/status", "/__gateway/ui/finance/status", "finance.read"],
      ["/__finance_manual/transactions", "/__gateway/ui/finance/transactions", "finance.read"],
      ["/__jobs", "/__gateway/ui/jobs", "ops.read"],
      ["/__jobs/events", "/__gateway/ui/jobs/events", "ops.read"],
      ["/__jobs/11111111-1111-4111-8111-111111111111", "/__gateway/ui/jobs/11111111-1111-4111-8111-111111111111", "ops.read"],
      ["/__computers", "/__gateway/ui/computers", "bots.operate"],
    ];
    for (const [from, to, capability] of cases) {
      expect([from, dotRoute("GET", from)]).toEqual([from, { kind: "remap", path: to }]);
      const d = decide("GET", to);
      expect([to, d.ok && d.capability]).toEqual([to, capability]);
    }
    // The founder routes themselves stay closed to the gateway.
    for (const p of ["/__crm/snapshot", "/__finance_manual/summary", "/__jobs", "/__computers"]) expect([p, decide("GET", p).ok]).toEqual([p, false]);
  });

  test("CRM operations go to Dot's own CRM API by name; the founders' operations reach /ops, where they are refused with a reason", () => {
    expect(dotRoute("POST", "/__crm/ops", JSON.stringify({ name: "crm.views.list", input: {} }))).toEqual({ kind: "remap", path: "/__gateway/crm/read" });
    expect(dotRoute("POST", "/__crm/ops", JSON.stringify({ name: "crm.company.update", input: {} }))).toEqual({ kind: "remap", path: "/__gateway/crm/ops" });
    for (const name of GATEWAY_CRM_FOUNDER_ONLY) expect(dotCrmOp(JSON.stringify({ name }))).toBe("/__gateway/crm/ops");
    expect(dotCrmOp("not json")).toBe("/__gateway/crm/ops");
  });

  test("founders-only data is refused in the page with its reason; writes never remap to a read adapter", () => {
    const refused: Array<[string, string]> = [
      ["GET", "/__operator/state"],
      ["GET", "/__devices/me"],
      ["GET", "/__approvals/list"],
      ["GET", "/__operator/native-connections"],
      ["GET", "/__workspace/needs-you"],
      ["POST", "/__jobs/11111111-1111-4111-8111-111111111111/cancel"],
      ["POST", "/__crm/record"],
      ["POST", "/__jobs"],
      ["GET", "/__finance_manual/audit"],
      ["GET", "/__computers/bot-1/view"],
      ["GET", "/__operator/business/brief"],
    ];
    for (const [method, path] of refused) expect([method, path, dotRoute(method, path).kind]).toEqual([method, path, "refuse"]);
    for (const n of DOT_NOT_AVAILABLE) expect(n.reason.length).toBeGreaterThan(10);
  });

  test("the Jarvis page reads Dot's own thread and stops Dot's own jobs; nothing else of Jarvis opens", () => {
    expect(dotRoute("GET", "/__operator/screen/command/thread")).toEqual({ kind: "remap", path: "/__gateway/ui/jarvis/thread" });
    expect(dotRoute("GET", "/__operator/conversations")).toEqual({ kind: "remap", path: "/__gateway/ui/jarvis/thread" });
    expect(dotRoute("POST", "/__operator/screen/command/cancel")).toEqual({ kind: "remap", path: "/__gateway/ui/jarvis/stop" });
    for (const [m, to, cap] of [["GET", "/__gateway/ui/jarvis/thread", "tasks.run"], ["POST", "/__gateway/ui/jarvis/stop", "tasks.run"]] as const) {
      const d = decide(m, to);
      expect([to, d.ok && d.capability]).toEqual([to, cap]);
    }
    for (const [m, p] of [["POST", "/__operator/conversations"], ["GET", "/__operator/conversations/6b989ce7-c9d8-4e36-8e19-30a0f104b329"], ["POST", "/__operator/screen/command"], ["POST", "/__operator/screen/command/thread/say"], ["GET", "/__operator/jarvis/status"], ["GET", "/__devices/me"], ["GET", "/__claude_models"], ["GET", "/__journeys"]] as const)
      expect([m, p, dotRoute(m, p).kind]).toEqual([m, p, "refuse"]);
  });

  test("routes the gateway decides itself pass through unchanged", () => {
    for (const p of ["/__gateway/me", "/__token", "/__events", "/__operator/leads/list", "/__operator/business/finance/stripe/status", "/__operator/coding/jobs", "/assets/x.js"])
      expect([p, dotRoute("GET", p).kind]).toEqual([p, "pass"]);
  });
});
