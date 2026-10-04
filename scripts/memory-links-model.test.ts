// W-D (29 Sep 2026): the Memory map's "How your memory connects" says only what the OS reported.
import { describe, expect, test } from "bun:test";
import { describeLinks } from "../src/components/memory/links-model";

const ok = <T,>(data: T) => ({ data, error: null, loading: false });
const failed = { data: null, error: "status 500", loading: false };
const status = (over: Record<string, unknown> = {}) =>
  ok({
    settings: { mode: "on", writes: true, hindsight_enabled: true, hindsight_url: "http://127.0.0.1:8878", bank: "mu-shared", api_key: "missing", reason: null, retired: [] },
    hindsight: "ok",
    last_scan_at: "2026-09-29T03:00:00Z",
    last_drain_at: null,
    last_success_at: "2026-09-29T03:00:00Z",
    pending: 2,
    pending_ops: [],
    errors: [],
    counts: { notes: 148, docs: 150, memories: 2, indexed: 146, excluded: 0, tombstones: 0 },
    skipped: [],
    recent: [],
    models: {},
    as_of: "2026-09-29T03:00:00Z",
    held: null,
    ...over,
  } as never);
const links = (hermes: Record<string, unknown>) => ok({ hermes, agent_calls: { count: 3, last_at: "2026-09-29T03:10:00Z", last_tool: "recall", since: "2026-09-29T02:00:00Z" }, as_of: "" } as never);
const installed = ok({ installed: true, configured: true, needsSetup: false });

describe("describeLinks", () => {
  test("shows Hindsight's real state and index counts", () => {
    const m = describeLinks(status(), links({ checked: true, configured: true, port_matches: true, served_tools: 4, withheld_tools: 0, missing_tools: 0, missing_names: [] }), installed);
    expect(m.nodes.hindsight).toMatchObject({ state: "Connected", tone: "ok" });
    expect(m.hindsight).toMatchObject({ indexed: 146, docs: 150, memories: 2, pending: 2, bank: "mu-shared" });
    expect(m.headline).toContain("146 of 150 documents indexed");
    expect(m.edges.find((e) => e.from === "os")?.state).toBe("live");
  });
  test("an unreachable Hindsight is a warning, not connected", () => {
    const m = describeLinks(status({ hindsight: "unavailable" }), links({ checked: true, configured: true, port_matches: true, served_tools: 4, withheld_tools: 0, missing_tools: 0, missing_names: [] }), installed);
    expect(m.nodes.hindsight).toMatchObject({ state: "Down", tone: "warn" });
    expect(m.edges.find((e) => e.from === "os")?.state).toBe("broken");
  });
  test("L2: the health probe says Connected or Down; 'Not checked yet' only before its first answer", () => {
    const hermes = links({ checked: true, configured: true, port_matches: true, served_tools: 4, withheld_tools: 0, missing_tools: 0, missing_names: [] });
    expect(describeLinks(status({ hindsight: "unknown", hindsight_health: "not-checked" }), hermes, installed).nodes.hindsight.state).toBe("Not checked yet");
    expect(describeLinks(status({ hindsight: "ok", hindsight_health: "connected" }), hermes, installed).nodes.hindsight).toMatchObject({ state: "Connected", tone: "ok" });
    expect(describeLinks(status({ hindsight: "writes-off", hindsight_health: "connected" }), hermes, installed).nodes.hindsight).toMatchObject({ state: "Connected, read only", tone: "ok" });
    expect(describeLinks(status({ hindsight: "unavailable", hindsight_health: "down" }), hermes, installed).nodes.hindsight).toMatchObject({ state: "Down", tone: "warn" });
    // A fresh recall that worked outranks nothing: a down probe after it still says Down.
    expect(describeLinks(status({ hindsight: "ok", hindsight_health: "down" }), hermes, installed).nodes.hindsight).toMatchObject({ state: "Down", tone: "warn" });
  });
  test("status that couldn't be read is 'Not checked', never a zero or 'off'", () => {
    const m = describeLinks(failed, failed, failed);
    for (const id of ["vault", "os", "hindsight", "hermes"] as const) expect(m.nodes[id].state).toBe("Not checked");
    expect(m.hindsight.indexed).toBeNull();
    expect(m.edges.every((e) => e.state === "unknown")).toBe(true);
  });
  test("Hermes: connected, points elsewhere, not connected, not installed, not checked", () => {
    const at = (h: Record<string, unknown>, hs = installed) => describeLinks(status(), links(h), hs).nodes.hermes;
    expect(at({ checked: true, configured: true, port_matches: true, served_tools: 4, withheld_tools: 0, missing_tools: 0, missing_names: [] })).toMatchObject({ state: "Connected", tone: "ok" });
    expect(at({ checked: true, configured: true, port_matches: false, served_tools: 4, withheld_tools: 0, missing_tools: 0, missing_names: [] })).toMatchObject({ state: "Points elsewhere", tone: "warn" });
    expect(at({ checked: true, configured: false, port_matches: null, served_tools: 4, withheld_tools: 0, missing_tools: 0, missing_names: [] })).toMatchObject({ state: "Not connected", tone: "warn" });
    expect(at({ checked: true, configured: true, port_matches: true, served_tools: 4, withheld_tools: 0, missing_tools: 0, missing_names: [] }, ok({ installed: false }))).toMatchObject({ state: "Not installed" });
    expect(at({ checked: false, configured: null, port_matches: null, reason: "no-config" })).toMatchObject({ state: "Not checked", tone: "neutral" });
  });
  test("a real gap is a warning that names the tool; withheld admin tools are not a fault", () => {
    const gap = describeLinks(status(), links({ checked: true, configured: true, port_matches: true, served_tools: 4, withheld_tools: 0, missing_tools: 3, missing_names: ["kb_search", "kb_graph"] }), installed);
    expect(gap.nodes.hermes).toMatchObject({ state: "Connected, 3 tools missing", tone: "warn" });
    expect(gap.nodes.hermes.detail).toContain("kb_search, kb_graph and 1 more that this memory endpoint doesn't have");
    expect(gap.nodes.hermes.detail).not.toContain("remember, save_to_vault");
    expect(gap.edges.find((e) => e.from === "hermes")?.state).toBe("live");
    expect(gap.hermes).toMatchObject({ lastTool: "recall", calls: 3 });
    const one = describeLinks(status(), links({ checked: true, configured: true, port_matches: true, served_tools: 4, withheld_tools: 2, missing_tools: 1, missing_names: ["kb_search"] }), installed).nodes.hermes;
    expect(one.state).toBe("Connected, 1 tool missing");
    expect(one.detail).toContain("kb_search that this memory endpoint doesn't have, so that call will fail.");
    expect(one.detail).toContain("2 admin tools deliberately not offered.");
  });
  test("L7: every tool served or deliberately withheld is plain 'Connected', saying how many admin tools are not offered", () => {
    const served = describeLinks(status(), links({ checked: true, configured: true, port_matches: true, served_tools: 18, withheld_tools: 0, missing_tools: 0, missing_names: [] }), installed).nodes.hermes;
    expect(served).toMatchObject({ state: "Connected", tone: "ok" });
    expect(served.detail).not.toContain("admin");
    const withheld = describeLinks(status(), links({ checked: true, configured: true, port_matches: true, served_tools: 18, withheld_tools: 3, missing_tools: 0, missing_names: [] }), installed);
    expect(withheld.nodes.hermes).toMatchObject({ state: "Connected", tone: "ok" });
    expect(withheld.nodes.hermes.detail).toContain("3 admin tools deliberately not offered.");
    expect(withheld.nodes.hermes.detail).not.toMatch(/fail|missing/);
    expect(withheld.headline).toContain("Hermes is connected.");
    const one = describeLinks(status(), links({ checked: true, configured: true, port_matches: true, served_tools: 18, withheld_tools: 1, missing_tools: 0, missing_names: [] }), installed).nodes.hermes;
    expect(one.detail).toContain("1 admin tool deliberately not offered.");
  });
});