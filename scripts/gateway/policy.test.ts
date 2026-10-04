import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nonCanonicalTarget } from "../identity/gate";
import { ROUTES, routeClass } from "../identity/routes";
import { CONSOLE_ONLY, OWNER_PRIVATE_ROUTES } from "../identity/server-role";
import { NonceCache, signAssertion, verifyAssertion } from "./assertion";
import { AuditLog, readAudit } from "./audit";
import { LIMITS } from "./config";
import { CAPABILITIES, decide, hasDevQuery, HUB_RULES, isPagePath, METHODS, NEVER, nonCanonical, OPERATE_SET, permitted } from "./policy";
import { RateLimiter } from "./ratelimit";
import { DOT_EVENT_TOPICS, dotEventAllowed, dotSnapshot } from "./events";
import { loadUi, UI_EXCLUDED_PREFIXES, writeUiManifest } from "./ui";
import { ControlFile, effectiveCapabilities, hashCode, SessionFile } from "./store";

const ALL = [...CAPABILITIES];
const tmp = () => mkdtempSync(join(tmpdir(), "gw-unit-"));

describe("capability table: built from the hub's real route classes, default deny", () => {
  test("every hub rule names a route the hub classes 'shared' for each of its methods", () => {
    for (const rule of HUB_RULES) {
      const sample = rule.pattern.replace(/\/\*\*$/, "/x").replace(/\*/g, "abc");
      for (const m of rule.methods) expect([rule.pattern, m, routeClass(sample, m)]).toEqual([rule.pattern, m, "shared"]);
      // The bare route (for a "/**" rule) too.
      if (rule.pattern.endsWith("/**")) for (const m of rule.methods) expect(routeClass(rule.pattern.slice(0, -3), m)).toBe("shared");
    }
  });

  test("with EVERY capability granted, each classified route and method is allowed only where a rule lists it", () => {
    const allowed: string[] = [];
    for (const route of Object.keys(ROUTES))
      for (const method of METHODS) {
        const d = decide(method, route);
        if (!d.ok) continue;
        allowed.push(`${method} ${route}`);
        // Never a local-owner or self route, whatever the capability.
        expect([method, route, routeClass(route, method)]).toEqual([method, route, "shared"]);
      }
    expect(allowed.sort()).toEqual(
      // The bare /__gateway is no longer a rule (Dot's hub routes are listed one by one, and /__gateway/admin never is); the raw /__jobs log is never forwarded (review B1).
      ["GET /__agents", "HEAD /__agents", "GET /__app_version", "HEAD /__app_version", "GET /__events", "HEAD /__events", "GET /__health", "HEAD /__health", "GET /__version", "HEAD /__version"].sort(),
    );
    expect(permitted("GET", "/__jobs", ["view"]).ok).toBe(false);
    expect(permitted("GET", "/__jobs", ["view", "ops.read"]).ok).toBe(false);
  });

  test("coding reads are exact: jobs, one job, its events, repos and artefacts are open to view; accounts and the bare tree never are", () => {
    for (const p of ["/__operator/coding/jobs", "/__operator/coding/jobs/0b0e6a52-6c2e-4d0e-9f43-0a3a5a1d2c11", "/__operator/coding/jobs/0b0e6a52-6c2e-4d0e-9f43-0a3a5a1d2c11/events", "/__operator/coding/repos", "/__operator/coding/artefacts/0b0e6a52/report.md"])
      expect([p, permitted("GET", p, ["view"]).ok]).toEqual([p, true]);
    for (const p of ["/__operator/coding/accounts", "/__operator/coding/accounts?refresh=1", "/__operator/coding", "/__operator/coding/focus", "/__operator/coding/anything/else"])
      expect([p, permitted("GET", p, ALL).ok]).toEqual([p, false]);
  });

  test("console-only, owner-private, identity and account routes are denied for every method and every capability", () => {
    for (const route of [...Object.keys(CONSOLE_ONLY), ...Object.keys(OWNER_PRIVATE_ROUTES), "/__devices", "/__devices/me", "/__devices/pair/redeem", "/__away", "/__token", "/__memory", "/__approvals", "/__finance_manual", "/__receptionist", "/__live-data", "/__commands", "/__lead-sites", "/__design_publish"])
      for (const method of METHODS) expect([method, route, permitted(method, route, ALL).ok]).toEqual([method, route, false]);
  });

  test("the NEVER list stays denied with every capability granted", () => {
    for (const n of NEVER) expect([n.method, n.path, permitted(n.method, n.path, ALL).ok, permitted(n.method, n.path, ALL, true).ok]).toEqual([n.method, n.path, false, false]);
  });

  test("unknown routes, other methods, and case, dot, slash and encoded variants are denied", () => {
    for (const p of ["/__brand_new", "/__operator", "/__operator/state", "/__operator/leadsx", "/__EVENTS", "/__Events", "/__events.json", "/__events/", "/__events/other", "/__workspace/..", "/__workspace/.hidden", "/__workspace/a%2fb"])
      for (const m of ["GET", "POST"]) expect([m, p, permitted(m, p, ALL).ok]).toEqual([m, p, false]);
    for (const m of ["POST", "PUT", "PATCH", "DELETE"]) expect(permitted(m, "/__gateway/crm/activity/a/b", ALL).ok).toBe(false);
    for (const m of ["PUT", "PATCH"]) expect(permitted(m, "/__gateway/crm/activity", ALL).ok).toBe(false);
    for (const m of ["OPTIONS", "TRACE", "CONNECT", "PROPFIND"]) expect(decide(m, "/__events").ok).toBe(false);
    expect(decide("POST", "/").ok).toBe(false);
    expect(decide("POST", "/src/main.tsx").ok).toBe(false);
  });

  test("view is read-only: no rule gives `view` a mutating method", () => {
    for (const rule of HUB_RULES.filter((r) => r.capability === "view")) expect(rule.methods.every((m) => m === "GET" || m === "HEAD")).toBe(true);
    for (const rule of HUB_RULES) for (const m of rule.methods) if (m !== "GET" && m !== "HEAD") expect(rule.capability).not.toBe("view");
  });

  test("each write needs exactly its own capability", () => {
    const only = (cap: string) => ["view", cap];
    expect(permitted("POST", "/__gateway/crm/activity", ["view"]).ok).toBe(false);
    expect(permitted("POST", "/__gateway/crm/activity", only("coding.start")).ok).toBe(false);
    expect(permitted("POST", "/__gateway/crm/activity", only("crm.write")).ok).toBe(true);
    expect(permitted("DELETE", "/__gateway/crm/activity/gwact_0123456789abcdef", only("crm.write")).ok).toBe(true);
    // The founders' own coding and computers write routes are never the gateway's (Dot's are under /__gateway, below).
    for (const p of ["/__operator/coding/jobs", "/__operator/coding/shape", "/__operator/coding/jobs/0b0e6a52-6c2e-4d0e-9f43-0a3a5a1d2c11/cancel", "/__operator/coding/jobs/0b0e6a52-6c2e-4d0e-9f43-0a3a5a1d2c11/supersede", "/__operator/coding/jobs/0b0e6a52-6c2e-4d0e-9f43-0a3a5a1d2c11/apply", "/__computers/bot-1/takeover", "/__computers/bot-1/input"])
      expect([p, permitted("POST", p, ALL).ok]).toEqual([p, false]);
    const id = "0b0e6a52-6c2e-4d0e-9f43-0a3a5a1d2c11";
    const each: Array<[string, string, string]> = [
      ["POST", "/__gateway/crm/read", "crm.read"],
      ["POST", "/__gateway/crm/ops", "crm.write"],
      ["GET", "/__gateway/files/roots", "files.read"],
      ["GET", "/__gateway/files/list", "files.read"],
      ["GET", "/__gateway/files/read", "files.read"],
      ["POST", "/__gateway/files/write", "files.write"],
      ["POST", "/__gateway/tasks", "tasks.run"],
      ["GET", "/__gateway/jobs", "tasks.run"],
      ["GET", `/__gateway/jobs/${id}`, "tasks.run"],
      ["POST", `/__gateway/jobs/${id}/stop`, "tasks.run"],
      ["POST", "/__gateway/memory/recall", "memory.read"],
      ["POST", "/__gateway/memory/remember", "memory.write"],
      ["POST", "/__gateway/coding/draft", "coding.start"],
      ["POST", `/__gateway/coding/jobs/${id}/start`, "coding.start"],
      ["POST", `/__gateway/coding/jobs/${id}/resume`, "coding.start"],
      ["POST", `/__gateway/coding/jobs/${id}/tests/rerun`, "coding.start"],
      ["POST", `/__gateway/coding/jobs/${id}/cancel`, "coding.start"],
      ["GET", "/__gateway/bots", "bots.operate"],
      ["GET", "/__gateway/bots/research", "bots.operate"],
      ["GET", "/__gateway/bots/research/screenshot", "bots.operate"],
      ["POST", "/__gateway/bots/research/jobs", "bots.operate"],
      ["POST", "/__gateway/bots/research/takeover", "bots.operate"],
      ["POST", "/__gateway/bots/research/lease/renew", "bots.operate"],
      ["POST", "/__gateway/bots/research/return", "bots.operate"],
      ["POST", "/__gateway/bots/research/input", "bots.operate"],
      ["POST", "/__gateway/bots/research/terminal", "bots.terminal"],
      ["GET", "/__gateway/bots/research/terminal/abc123def/events", "bots.terminal"],
      ["POST", "/__gateway/bots/research/terminal/abc123def/input", "bots.terminal"],
      ["POST", "/__gateway/bots/research/terminal/abc123def/close", "bots.terminal"],
      ["GET", "/__gateway/diagnostics/jobs", "ops.read"],
      ["GET", "/__gateway/diagnostics", "ops.read"],
      ["GET", "/__gateway/diagnostics/releases", "ops.read"],
      ["GET", "/__gateway/diagnostics/actions", "ops.read"],
      ["GET", "/__gateway/finance/summary", "finance.read"],
      ["GET", "/__gateway/finance/transactions", "finance.read"],
      ["GET", "/__gateway/finance/receivables", "finance.read"],
      ["GET", "/__gateway/finance/stripe", "finance.read"],
      ["POST", "/__gateway/finance/categorise", "finance.write"],
      ["GET", "/__gateway/mail/mailboxes", "mail.read"],
      ["GET", "/__gateway/mail/threads", "mail.read"],
      ["GET", "/__gateway/mail/thread", "mail.read"],
      ["POST", "/__gateway/mail/drafts", "mail.draft"],
      ["POST", "/__gateway/release", "release.request"],
      ["GET", "/__gateway/release", "release.request"],
      ["GET", "/__gateway/release/rel-20261004T120000-abcdef", "release.request"],
      ["POST", "/__gateway/release/rel-20261004T120000-abcdef/cancel", "release.request"],
    ];
    for (const [method, path, cap] of each) {
      // Exactly its own capability: `view` alone is refused, every OTHER capability together is refused, its own is enough.
      expect([method, path, permitted(method, path, ["view"]).ok]).toEqual([method, path, false]);
      expect([method, path, permitted(method, path, ALL.filter((c) => c !== cap)).ok]).toEqual([method, path, false]);
      expect([method, path, permitted(method, path, only(cap)).ok]).toEqual([method, path, true]);
    }
    // bots.operate never opens the terminal, and the operating set leaves it out.
    expect(OPERATE_SET.includes("bots.terminal")).toBe(false);
    expect(permitted("POST", "/__gateway/bots/research/terminal", ["view", ...OPERATE_SET]).ok).toBe(false);
    // The founders' identity listing and revocation are never the gateway's, and nothing matches a bare or unknown /__gateway path.
    for (const [method, path] of [["GET", "/__gateway/admin/access"], ["POST", "/__gateway/admin/identities/0123456789abcdef/revoke"], ["GET", "/__gateway"], ["GET", "/__gateway/anything"], ["GET", "/__gateway/files"], ["POST", `/__gateway/coding/jobs/${id}/apply`], ["DELETE", "/__gateway/files/write"], ["POST", "/__gateway/bots/research/action"], ["POST", "/__gateway/bots"]])
      expect([method, path, permitted(method, path, ALL).ok]).toEqual([method, path, false]);
  });

  test("no WebSocket rule exists: every upgrade is denied, with every capability", () => {
    expect(HUB_RULES.filter((r) => r.kind === "ws")).toEqual([]);
    for (const p of ["/__computers/bot-1/vnc", "/", "/__events", "/src/main.tsx", "/__computers/bot-1/viewer", "/__gateway/me"]) expect([p, permitted("GET", p, ALL, true).ok]).toEqual([p, false]);
    for (const p of ["/__computers", "/__computers/bot-1/screenshot", "/__computers/bot-1/vnc"]) expect([p, permitted("GET", p, ALL).ok]).toEqual([p, false]);
  });

  test("Workspace: exactly the pipeline, websites and groups panels; mail, call, enquiry, today and needs-you panels are denied", () => {
    for (const p of ["/__workspace/pipeline", "/__workspace/websites", "/__workspace/groups"]) expect([p, permitted("GET", p, ["view"]).ok]).toEqual([p, true]);
    for (const p of ["/__workspace", "/__workspace/", "/__workspace/email", "/__workspace/receptionist", "/__workspace/enquiries", "/__workspace/call-queue", "/__workspace/today", "/__workspace/needs-you", "/__workspace/pipeline/x", "/__workspace/Pipeline", "/__workspace/x"])
      for (const m of METHODS) expect([m, p, permitted(m, p, ALL).ok]).toEqual([m, p, false]);
    for (const p of ["/__workspace/pipeline", "/__workspace/websites", "/__workspace/groups"]) for (const m of ["POST", "PUT", "PATCH", "DELETE"]) expect(permitted(m, p, ALL).ok).toBe(false);
    // The rule list names every Workspace route it allows; there is no wildcard under /__workspace.
    expect(HUB_RULES.filter((r) => r.pattern.startsWith("/__workspace")).map((r) => r.pattern).sort()).toEqual(["/__workspace/groups", "/__workspace/pipeline", "/__workspace/websites"]);
  });
});

describe("the event stream's topic allow-list for Dot", () => {
  test("coding job events only; memory and trigger jobs, approvals, computers, leases, devices, agent and Jarvis events are not Dot's", () => {
    expect(dotEventAllowed({ topic: "job", tag: "coding" })).toBe(true);
    for (const e of [{ topic: "job", tag: "memory" }, { topic: "job", tag: "trigger" }, { topic: "job" }, { topic: "approval" }, { topic: "computer" }, { topic: "lease" }, { topic: "device" }, { topic: "agent" }, { topic: "jarvis" }, { topic: "thread" }, { topic: "approval", tag: "coding" }])
      expect([e, dotEventAllowed(e)]).toEqual([e, false]);
    expect(DOT_EVENT_TOPICS).toEqual(["job"]);
    expect(dotSnapshot({ jobs: [{ id: 1, kind: "coding" }, { id: 2, kind: "memory" }, { id: 3, kind: "trigger" }, { id: 4 }], jobsHead: 9, approvals: [{ id: "a" }], computers: [{ name: "b" }], devices: [{ id: "d" }], extra: "x" })).toEqual({ jobs: [{ id: 1, kind: "coding" }], jobsHead: 9, approvals: [], computers: [], devices: [] });
    expect(dotSnapshot(null)).toEqual({ jobs: [], approvals: [], computers: [], devices: [] });
  });
});

describe("the UI manifest", () => {
  const bundle = () => {
    const dir = tmp();
    mkdirSync(join(dir, "assets"));
    mkdirSync(join(dir, "mu-creative-20261001", "films"), { recursive: true });
    writeFileSync(join(dir, "_shell.html"), "<!doctype html>shell");
    writeFileSync(join(dir, "assets", "a.js"), "export const a = 1;");
    writeFileSync(join(dir, "assets", "a.js.map"), "{}");
    writeFileSync(join(dir, ".secret"), "x");
    writeFileSync(join(dir, "mu-creative-20261001", "brief.md"), "unapproved");
    writeFileSync(join(dir, "mu-creative-20261001", "films", "cut.mp4"), "unapproved");
    return dir;
  };

  test("lists files with hashes; leaves out maps, dot files and the excluded folders (the unapproved creative material by default)", () => {
    const dir = bundle();
    try {
      expect(UI_EXCLUDED_PREFIXES).toContain("/mu-creative-20261001");
      const m = writeUiManifest(dir);
      expect(Object.keys(m.files).sort()).toEqual(["/_shell.html", "/assets/a.js"]);
      expect(m.files["/assets/a.js"].sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(loadUi(dir).files.has("/assets/a.js")).toBe(true);
      // The exclusion list is a parameter: with none, the folder would be listed.
      expect(Object.keys(writeUiManifest(dir, null, ["/"], []).files)).toContain("/mu-creative-20261001/brief.md");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("refuses to load when a file's content, size or presence differs from the manifest, or a listed path is unsafe", () => {
    const dir = bundle();
    try {
      writeUiManifest(dir);
      // Same size, different bytes: only the hash can tell.
      writeFileSync(join(dir, "assets", "a.js"), "export const a = 2;");
      expect(() => loadUi(dir)).toThrow(/does not match/);
      writeFileSync(join(dir, "assets", "a.js"), "export const a = 1; // longer");
      expect(() => loadUi(dir)).toThrow(/does not match/);
      rmSync(join(dir, "assets", "a.js"));
      expect(() => loadUi(dir)).toThrow(/missing/);
      writeFileSync(join(dir, "assets", "a.js"), "export const a = 1;");
      expect(loadUi(dir).files.size).toBe(2);
      const manifestFile = join(dir, "gateway-ui-manifest.json");
      const original = readFileSync(manifestFile, "utf8");
      for (const bad of ["/../outside.js", "/assets/../../x", "/.secret", "/assets/a.js.map", "/assets/a.js::$DATA", "/a%2fb"]) {
        const m = JSON.parse(original);
        m.files[bad] = m.files["/assets/a.js"];
        writeFileSync(manifestFile, JSON.stringify(m));
        expect(() => loadUi(dir)).toThrow();
      }
      const noHash = JSON.parse(original);
      delete noHash.files["/assets/a.js"].sha256;
      writeFileSync(manifestFile, JSON.stringify(noHash));
      expect(() => loadUi(dir)).toThrow(/no hash/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("refuses a symlink or a junction: a listed file that is a link, or one reached through a linked folder", () => {
    const dir = bundle();
    const outside = tmp();
    try {
      writeFileSync(join(outside, "b.js"), "export const a = 1;");
      writeUiManifest(dir);
      // A junction in place of the assets folder, pointing at a folder outside the bundle with a same-content file.
      rmSync(join(dir, "assets"), { recursive: true });
      mkdirSync(join(outside, "assets"));
      writeFileSync(join(outside, "assets", "a.js"), "export const a = 1;");
      symlinkSync(join(outside, "assets"), join(dir, "assets"), "junction");
      expect(() => loadUi(dir)).toThrow(/through a link|plain file/);
      // And the manifest writer never lists what is behind a link.
      expect(Object.keys(writeUiManifest(dir).files)).toEqual(["/_shell.html"]);
    } finally {
      rmSync(join(dir, "assets"), { force: true });
      rmSync(dir, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("the app's own paths: never the hub's", () => {
  test("no non-/__ path is ever a hub rule: the UI is the gateway's own (built bundle), so the hub never sees one", () => {
    for (const p of ["/", "/leads", "/src/main.tsx", "/@vite/client", "/@id/x", "/node_modules/.vite/deps/react.js", "/favicon.svg", "/assets/index.js"])
      for (const m of METHODS) for (const up of [false, true]) expect([m, p, up, decide(m, p, up).ok]).toEqual([m, p, up, false]);
  });

  test("page paths get the shell; files, dev-server and checkout folders, dots and odd characters do not", () => {
    const pages = ["/", "/leads", "/leads/", "/memory", "/memory/vault", "/skills", "/agents/workspace/research", "/coding/0b0e6a52-6c2e-4d0e-9f43-0a3a5a1d2c11", "/settings"];
    const notPages = ["/favicon.svg", "/_shell.html", "/src", "/src/main.tsx", "/scripts/x", "/node_modules/.cache", "/@vite/client", "/@id/x", "/@fs/C/x", "/gw", "/gw/enrol", "/assets/x", "/docs/HANDOFF", "/deploy/x", "/public/x", "/dist/client", "/.env", "/.operator-data", "/a.b", "/x//y", "/~x", "/_serverFn/abc", "/a b", "/%41"];
    for (const p of pages) expect([p, isPagePath(p)]).toEqual([p, true]);
    for (const p of notPages) expect([p, isPagePath(p)]).toEqual([p, false]);
  });

  test("Vite's transform queries are recognised wherever they sit", () => {
    for (const q of ["?raw", "?url", "?import", "?inline", "?worker", "?sharedworker", "?import&raw", "?x=1&raw", "?raw=1", "?t=123", "?v=abc", "?html-proxy&index=0.js", "?direct"]) expect([q, hasDevQuery(q)]).toEqual([q, true]);
    for (const q of ["", "?", "?q=raw", "?eventId=a:b", "?last=abc:12", "?rawness=1"]) expect([q, hasDevQuery(q)]).toEqual([q, false]);
  });

  test("the strict target rule refuses everything the hub gate does, and Windows' own tricks on top", () => {
    const gateRefuses = ["//evil.example/", "/a/../b", "/a/./b", "/a//b", "/a\\b", "/a%2fb", "/a%2Eb", "/a%5cb", "/a%25b", "/a%00b", "http://evil.example/x", "*"];
    for (const t of gateRefuses) {
      expect([t, nonCanonicalTarget(t) === null]).toEqual([t, false]);
      expect([t, nonCanonical(t) === null]).toEqual([t, false]);
    }
    const windows = [
      "/src/data/live-data.json::$DATA", "/src/data/live-data.json:stream", "/memory/notes.md::$DATA", "/notes/PRIVATE::$DATA", "/__workspace::$DATA",
      "/__events:x", "/C:/Windows/win.ini", "/src/data/live-data.json.", "/src/data/live-data.json. ", "/a /b", "/a%20/b", "/x.json%20", "/x.json%2E",
      "/a%3a$DATA", "/a%3A", "/a\u0000b", "/a?x=%00", "/a?x=\u0000", "/a%0ab", "/a%7f", "/a%ZZ",
    ];
    for (const t of windows) expect([t, nonCanonical(t) === null]).toEqual([t, false]);
    for (const t of ["/", "/leads", "/assets/index-CsMaAxGO.js", "/__events?last=abc123:12", "/__gateway/crm/activity?eventId=dot-gateway-test:1", "/__operator/leads/list?q=a%20b"]) expect([t, nonCanonical(t)]).toEqual([t, null]);
  });
});

describe("assertions", () => {
  const key = "k".repeat(43);
  const base = { method: "POST", target: "/__gateway/crm/activity?x=1", sessionId: "ab".repeat(12), caps: ["view", "crm.write"] };

  test("a signed assertion verifies once, for its own method and target", () => {
    const nonces = new NonceCache();
    const a = signAssertion(key, base);
    const ok = verifyAssertion(key, a, { method: "POST", target: base.target, nonces });
    expect(ok.ok && ok.claims.sub).toBe("dot");
    expect(verifyAssertion(key, a, { method: "POST", target: base.target, nonces })).toEqual({ ok: false, reason: "replay" });
  });

  test("an upgrade's assertion is not an ordinary request's, and the reverse", () => {
    const up = signAssertion(key, { ...base, method: "GET", target: "/__computers/bot-1/vnc", upgrade: true });
    expect(verifyAssertion(key, up, { method: "GET", target: "/__computers/bot-1/vnc" })).toEqual({ ok: false, reason: "kind" });
    expect(verifyAssertion(key, up, { method: "GET", target: "/__computers/bot-1/vnc", upgrade: true }).ok).toBe(true);
    const plain = signAssertion(key, { ...base, method: "GET", target: "/__computers/bot-1/vnc" });
    expect(verifyAssertion(key, plain, { method: "GET", target: "/__computers/bot-1/vnc", upgrade: true })).toEqual({ ok: false, reason: "kind" });
  });

  test("wrong key, tampering, another method or target, and an old timestamp are all refused", () => {
    const a = signAssertion(key, base);
    expect(verifyAssertion("x".repeat(43), a, { method: "POST", target: base.target })).toEqual({ ok: false, reason: "signature" });
    expect(verifyAssertion(key, a, { method: "DELETE", target: base.target })).toEqual({ ok: false, reason: "method" });
    expect(verifyAssertion(key, a, { method: "POST", target: "/__gateway/crm/activity" })).toEqual({ ok: false, reason: "target" });
    const [v, payload, sig] = a.split(".");
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, "base64url").toString()), caps: ["view", "crm.write", "bots.operate"] })).toString("base64url");
    expect(verifyAssertion(key, `${v}.${forged}.${sig}`, { method: "POST", target: base.target })).toEqual({ ok: false, reason: "signature" });
    const old = signAssertion(key, { ...base, now: Date.now() - LIMITS.assertionSkewMs - 1000 });
    expect(verifyAssertion(key, old, { method: "POST", target: base.target })).toEqual({ ok: false, reason: "expired" });
    for (const junk of ["", "v1.a.b", "dot", undefined, 7, "v2." + payload + "." + sig]) expect(verifyAssertion(key, junk, { method: "POST", target: base.target }).ok).toBe(false);
  });
});

describe("sessions, codes and grants", () => {
  test("a code is single use and expires; nothing is stored in the clear", () => {
    const dir = tmp();
    try {
      const control = new ControlFile(dir);
      const t0 = 1_800_000_000_000;
      const { code } = control.mintCode({ by: "usman", minutes: 5, now: t0 });
      expect(control.read().codes[0].hash).toBe(hashCode(code.toLowerCase().replace(/-/g, " ")));
      expect(JSON.stringify(control.read())).not.toContain(code);
      const sessions = new SessionFile(dir);
      expect(sessions.redeem("WRONG-CODE", control.read(), ["view"], t0 + 1000)).toBeNull();
      const first = sessions.redeem(code, control.read(), ["view"], t0 + 1000);
      expect(first).not.toBeNull();
      expect(sessions.redeem(code, control.read(), ["view"], t0 + 2000)).toBeNull();
      // A second gateway process (a restart) still knows the code is spent.
      expect(new SessionFile(dir).redeem(code, control.read(), ["view"], t0 + 3000)).toBeNull();
      const late = control.mintCode({ by: "usman", minutes: 5, now: t0 });
      expect(sessions.redeem(late.code, control.read(), ["view"], t0 + 5 * 60_000 + 1)).toBeNull();
      const disk = JSON.stringify(new SessionFile(dir).list());
      expect(disk).not.toContain(first!.token);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("idle and absolute expiry, revocation, and a rotation's short grace", () => {
    const dir = tmp();
    try {
      const control = new ControlFile(dir);
      const t0 = 1_800_000_000_000;
      const mint = () => sessions.redeem(control.mintCode({ by: "mehroz", idleMinutes: 10, sessionMinutes: 60, now: t0 }).code, control.read(), ["view"], t0)!;
      const sessions = new SessionFile(dir);
      const a = mint();
      expect(sessions.verify(a.token, control.read(), t0 + 9 * 60_000).ok).toBe(true);
      // Idle: ten quiet minutes after the last request.
      expect(sessions.verify(a.token, control.read(), t0 + 9 * 60_000 + 10 * 60_000)).toEqual({ ok: false, reason: "idle" });
      expect(sessions.verify(a.token, control.read(), t0 + 9 * 60_000 + 10 * 60_000 + 1)).toEqual({ ok: false, reason: "ended" });
      // Absolute: kept busy, it still ends at the hour.
      const b = mint();
      for (let m = 5; m < 60; m += 5) expect(sessions.verify(b.token, control.read(), t0 + m * 60_000).ok).toBe(true);
      expect(sessions.verify(b.token, control.read(), t0 + 60 * 60_000)).toEqual({ ok: false, reason: "expired" });
      // Revocation by id, and it survives a restart.
      const c = mint();
      control.revokeSession(c.session.id);
      expect(sessions.verify(c.token, control.read(), t0 + 1000)).toEqual({ ok: false, reason: "revoked" });
      expect(new SessionFile(dir).verify(c.token, control.read(), t0 + 2000)).toEqual({ ok: false, reason: "revoked" });
      // Rotation: the new value works; the old one only inside the grace.
      const d = mint();
      const next = sessions.rotate(d.session, ["view", "crm.write"], t0 + 1000);
      expect(sessions.verify(next, control.read(), t0 + 2000)).toMatchObject({ ok: true, viaPrevious: false });
      expect(sessions.verify(d.token, control.read(), t0 + 1000 + LIMITS.rotationGraceMs - 1)).toMatchObject({ ok: true, viaPrevious: true });
      expect(sessions.verify(d.token, control.read(), t0 + 1000 + LIMITS.rotationGraceMs + 1)).toEqual({ ok: false, reason: "unknown" });
      // Revoke everything: sessions and unused codes.
      const unused = control.mintCode({ by: "usman", now: t0 + 3000 });
      control.revokeAllSessions(t0 + 4000);
      expect(sessions.verify(next, control.read(), t0 + 5000)).toEqual({ ok: false, reason: "revoked" });
      expect(sessions.redeem(unused.code, control.read(), ["view"], t0 + 5000)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("grants always expire, only grantable capabilities can be granted, and view is every session's", () => {
    const dir = tmp();
    try {
      const control = new ControlFile(dir);
      const t0 = 1_800_000_000_000;
      expect(effectiveCapabilities(control.read(), t0).caps).toEqual(["view"]);
      control.grant({ capability: "crm.write", by: "usman", hours: 2, now: t0 });
      expect(effectiveCapabilities(control.read(), t0 + 1000)).toEqual({ caps: ["crm.write", "view"], grantedBy: { "crm.write": "usman" } });
      expect(effectiveCapabilities(control.read(), t0 + 2 * 3_600_000).caps).toEqual(["view"]);
      expect(() => control.grant({ capability: "view", by: "usman" })).toThrow();
      expect(() => control.grant({ capability: "owner" as never, by: "usman" })).toThrow();
      // A hand-edited control file cannot invent a capability.
      const c = control.read();
      c.grants.push({ capability: "desktop.control" as never, by: "x", at: t0, expiresAt: t0 + 9e9 });
      expect(effectiveCapabilities(c, t0).caps).not.toContain("desktop.control");
      control.grant({ capability: "bots.operate", by: "mehroz", now: t0 });
      control.revokeGrant("bots.operate");
      expect(effectiveCapabilities(control.read(), t0 + 1).caps).not.toContain("bots.operate");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("wrong codes burn every unused code after the per-code limit, from any address, across a restart; nothing locks the gateway", () => {
    const dir = tmp();
    try {
      const control = new ControlFile(dir);
      const sessions = new SessionFile(dir);
      const t0 = 1_800_000_000_000;
      const early = control.mintCode({ by: "usman", minutes: 60, now: t0 });
      for (let i = 0; i < LIMITS.enrolFailuresPerCode - 1; i++) expect(sessions.enrolFailed(control.read(), t0 + i).burned).toEqual([]);
      // A code made now has seen none of those guesses.
      const late = control.mintCode({ by: "usman", minutes: 60, now: t0 + 100 });
      const last = sessions.enrolFailed(control.read(), t0 + 200);
      expect(last.burned).toEqual([control.read().codes.find((c) => c.hash === hashCode(early.code))!.id]);
      expect(last.recent).toBe(LIMITS.enrolFailuresPerCode);
      expect(sessions.redeem(early.code, control.read(), ["view"], t0 + 300)).toBeNull();
      expect(new SessionFile(dir).redeem(early.code, control.read(), ["view"], t0 + 300)).toBeNull();
      // The newer code still works: no global lock.
      expect(sessions.redeem(late.code, control.read(), ["view"], t0 + 300)).not.toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("rate limiter and audit", () => {
  test("a key over its limit is told how long to wait; another key is unaffected", () => {
    const r = new RateLimiter();
    for (let i = 0; i < 5; i++) expect(r.hit("a", 5, 60_000, 1000)).toBe(0);
    expect(r.hit("a", 5, 60_000, 1000)).toBe(60);
    expect(r.hit("b", 5, 60_000, 1000)).toBe(0);
    expect(r.hit("a", 5, 60_000, 62_000)).toBe(0);
  });

  test("an audit line holds only the closed field list; anything else passed in is dropped", () => {
    const dir = tmp();
    try {
      const log = new AuditLog(dir, () => Date.UTC(2026, 9, 2, 1, 2, 3));
      log.write({ event: "request", person: "dot", session: "abc123", ip: "203.0.113.9", method: "POST", route: "/__gateway/crm/activity", capability: "crm.write", status: 200, outcome: "allowed", recordIds: ["gwact_1"], delegatedBy: "usman", cookie: "SECRET-COOKIE", body: "SECRET-BODY", headers: { authorization: "SECRET" } } as never);
      const [entry] = readAudit(dir);
      expect(entry).toEqual({ at: "2026-10-02T01:02:03.000Z", event: "request", person: "dot", session: "abc123", ip: "203.0.113.9", method: "POST", route: "/__gateway/crm/activity", capability: "crm.write", status: 200, outcome: "allowed", recordIds: ["gwact_1"], delegatedBy: "usman" });
      for (let i = 0; i < 400; i++) log.write({ event: "request", person: null, session: null, ip: "198.51.100.1", outcome: "denied", reason: "session-none" });
      expect(readAudit(dir).length).toBe(1 + 121);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
