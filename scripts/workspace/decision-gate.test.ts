import { expect, test } from "bun:test";
import { DECISION_NEEDS_SESSION, decisionAllowed } from "../operator-plugin";

// Round 7 audit 2 (B1): the banner tells an unconfirmed browser it "can't approve anything", but POST /workspace/decision accepted its Decline.
// An owner decision is a person's: only a confirmed human session records one.
test("only a confirmed human session records an owner decision; a pending browser, a bare login, a program, a routine and the gateway are refused", () => {
  const p = (via: string, actor: string) => ({ personId: "usman", via, actor }) as never;
  expect(decisionAllowed(p("paired-session", "human"))).toBe(true);
  expect(decisionAllowed(p("loopback-owner", "human"))).toBe(true);
  expect(decisionAllowed(p("loopback-owner", "process"))).toBe(false); // a browser at the hub PC still waiting to be confirmed, or a local program
  expect(decisionAllowed(p("tailnet-person", "process"))).toBe(false); // a bare Tailscale login
  expect(decisionAllowed(p("routine", "process"))).toBe(false);
  expect(decisionAllowed(p("gateway", "process"))).toBe(false);
  expect(decisionAllowed(p("companion", "process"))).toBe(false);
  expect(decisionAllowed(null)).toBe(false);
  expect(DECISION_NEEDS_SESSION).toMatch(/Confirm this browser/);
  expect(DECISION_NEEDS_SESSION).not.toMatch(/MU_|scripts\//);
});

// The helper alone would not catch the route losing its check: the POST handler must refuse before it saves.
test("the decision route checks the session before it saves", async () => {
  const src = await Bun.file(new URL("../operator-plugin.ts", import.meta.url)).text();
  const start = src.indexOf('path === "/workspace/decision" && method === "POST"');
  expect(start).toBeGreaterThan(-1);
  const block = src.slice(start, src.indexOf("saveDecision(root", start) + 20);
  const gate = block.indexOf('if (!decisionAllowed(principal)) return send({ error: DECISION_NEEDS_SESSION, reason: "needs-human-session" }, 403);');
  expect(gate).toBeGreaterThan(-1);
  expect(gate).toBeLessThan(block.indexOf("saveDecision(root"));
});
