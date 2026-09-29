import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanMounts } from "./mount-scan";
import { ROUTES, routeClass, routeRule } from "./routes";

// REVIEW-B1 B1-2: every mutating (and every other) /__* route is classified; a new mount that isn't
// fails here until someone decides shared-business, local-owner or self, and documents it.
const ROOT = join(import.meta.dir, "..", "..");
const mounts = scanMounts(ROOT);
const docs = readFileSync(join(ROOT, "docs", "IDENTITY-ROUTES.md"), "utf8");

describe("route classification", () => {
  test("the scan finds the app's mounts (sanity)", () => {
    for (const p of ["/__operator", "/__claude_chat", "/__hermes_chat", "/__memory", "/__motion", "/__design_higgsfield_account", "/__dev_restart"])
      expect(mounts.has(p)).toBe(true);
    expect(mounts.size).toBeGreaterThan(100);
  });

  test("every mounted /__* route is in the code table", () => {
    const unclassified = [...mounts.keys()].filter((p) => !(p in ROUTES));
    expect(unclassified).toEqual([]);
  });

  test("every mounted /__* route is in docs/IDENTITY-ROUTES.md with its class", () => {
    const missing = [...mounts.keys()].filter((p) => {
      const rule = ROUTES[p];
      const row = docs.split("\n").find((l) => l.startsWith(`| \`${p}\` |`));
      return !row || !rule || !row.includes(rule.read === rule.write ? rule.read : `${rule.read} (read) / ${rule.write} (write)`);
    });
    expect(missing).toEqual([]);
  });

  test("the table has no stale entries (a route from an unmerged branch says which)", () => {
    expect(Object.keys(ROUTES).filter((k) => !mounts.has(k) && !ROUTES[k].expectedFrom && !(ROUTES[k].within && mounts.has(ROUTES[k].within!)))).toEqual([]);
  });

  test("a middleware that matches its paths with a regex literal is found (B2's /__jobs, /__approvals)", () => {
    const dir = mkdtempSync(join(tmpdir(), "mount-scan-"));
    try {
      mkdirSync(join(dir, "scripts", "jobs"), { recursive: true });
      mkdirSync(join(dir, "src", "motion", "server"), { recursive: true });
      writeFileSync(join(dir, "vite.config.ts"), "");
      writeFileSync(
        join(dir, "scripts", "jobs", "plugin.ts"),
        [String.raw`if (!/^\/__(jobs|approvals)(\/|$)/.test(url.pathname)) return next();`, String.raw`if (/^\/__widgets(\/|$)/.test(p)) return;`].join("\n"),
      );
      expect([...scanMounts(dir).keys()].sort()).toEqual(["/__approvals", "/__jobs", "/__widgets"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("C1: every /__operator/agent-jobs path is the hub owner's, reads included; the rest of /__operator stays shared", () => {
    for (const p of ["/__operator/agent-jobs", "/__operator/agent-jobs/status", "/__operator/agent-jobs/check", "/__operator/agent-jobs/respond", "/__operator/agent-jobs/cancel"])
      for (const m of ["GET", "POST"]) expect([p, m, routeClass(p, m)]).toEqual([p, m, "local-owner"]);
    expect(routeClass("/__operator/agent-jobsx", "GET")).toBe("shared"); // not the agent-jobs route (connect boundary)
    expect(routeClass("/__operator/leads/goal", "POST")).toBe("shared");
  });

  test("B2's job history and approvals are shared at the gate; B2 decides each write", () => {
    for (const p of ["/__jobs", "/__jobs/events", "/__jobs/abc", "/__approvals", "/__approvals/abc"]) expect(routeClass(p, "GET")).toBe("shared");
    for (const p of ["/__jobs/abc/cancel", "/__jobs/abc/release", "/__approvals/abc/card", "/__approvals/abc/decide", "/__approvals/abc/cancel"])
      expect(routeClass(p, "POST")).toBe("shared");
  });

  test("deny by default: an unknown path, or a new _variant of a family, is local-owner", () => {
    for (const p of ["/__brand_new", "/__claude_chat2", "/__claude_x", "/__hermes_anything", "/__design_new_writer", "/__operatorx"])
      for (const m of ["GET", "POST"]) expect([p, m, routeClass(p, m)]).toEqual([p, m, "local-owner"]);
    expect(routeRule("/__brand_new").key).toBeNull();
  });

  test("the review's executor, approval and hub-config routes are local-owner for every method (B1-1, B1-2)", () => {
    const hub = [
      "/__claude_chat", "/__claude_attach", "/__claude_abort", "/__claude_abort_all", "/__claude_file", "/__claude_session", "/__claude_chats",
      "/__hermes_chat", "/__hermes_missions/optimize", "/__trigger_dream", "/__permission_decision", "/__question_answer", "/__mcp_approvals",
      "/__start_voice", "/__design_set_key", "/__design_remove_key", "/__design_higgsfield_account/disconnect", "/__hermes_cmd",
      "/__hermes_moa_save", "/__hermes_effort", "/__ccr_pin_routes", "/__hermes_pantheon/install", "/__hermes_pantheon/create",
      "/__hermes_pantheon/some-persona", "/__set_dream_engine", "/__graphify_ingest", "/__chat_title", "/__hermes_documents",
      "/__memory_note", "/__hermes_memory",
    ];
    for (const p of hub) for (const m of ["POST", "PUT", "DELETE"]) expect([p, m, routeClass(p, m)]).toEqual([p, m, "local-owner"]);
    for (const p of ["/__claude_chat", "/__claude_session", "/__memory_note", "/__hermes_memory"]) expect(routeClass(p, "GET")).toBe("local-owner");
  });

  test("shared business routes stay shared", () => {
    for (const p of ["/__operator/leads/goal", "/__receptionist/dashboard", "/__workspace", "/__memory/save", "/__finance_manual/import"])
      for (const m of ["GET", "POST"]) expect([p, m, routeClass(p, m)]).toEqual([p, m, "shared"]);
    // Case and dot variants resolve like connect mounts them.
    expect(routeClass("/__CLAUDE_CHAT", "POST")).toBe("local-owner");
    expect(routeClass("/__claude.json", "GET")).toBe("local-owner");
  });
});

test("Stage E: System > Models is a shared read; the model probe is the hub owner's only", () => {
  expect(routeClass("/__operator/model-router", "GET")).toBe("shared");
  expect(routeClass("/__operator/model-router", "POST")).toBe("local-owner");
  expect(routeClass("/__operator/model-router/probe", "POST")).toBe("local-owner");
  expect(routeClass("/__operator/model-router/probe", "GET")).toBe("local-owner");
});
