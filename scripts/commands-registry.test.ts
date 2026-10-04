// The ONE command registry (src/lib/commands): typed and spoken commands resolve through the same
// function to the same action; device actions carry the Jarvis entry request and need a target preview;
// ambiguity asks; "that call" comes from page context and is never invented.
import { afterEach, describe, expect, test } from "bun:test";
import { buildCommandIndex, packageMarginAnswer, parseCommandText, planCommand, resolveCommand, searchCommands, staticEntries } from "../src/lib/commands/registry";
import { publishPageContext, readPageContext, resetPageContext, setActivePage } from "../src/lib/page-context";
import { DESTINATIONS, drilldownHref } from "../src/components/shell/destinations";
import { getReceptionistPackage, RECEPTIONIST_PACKAGES } from "../src/lib/receptionist-packages";
import { marginAnswer } from "./jev-margin";

const apps = { state: "live" as const, items: [{ name: "PowerPoint" }, { name: "Word" }, { name: "Excel" }, { name: "Notepad" }, { name: "Google Chrome" }, { name: "Spotify" }] };
const index = buildCommandIndex({ apps, projects: { state: "live", items: [{ id: "c-users-nebula-pc-source-repos-muv-demo-dental", name: "muv-demo-dental" }] } });

afterEach(() => resetPageContext());

describe("parseCommandText", () => {
  test("strips the wake word, politeness and the verb; keeps the device", () => {
    expect(parseCommandText("Hey Jarvis, could you open PowerPoint here please")).toEqual({ verb: "open", object: "powerpoint", spokenTarget: "here" });
    expect(parseCommandText("launch spotify on my laptop")).toEqual({ verb: "launch", object: "spotify", spokenTarget: "on my laptop" });
    expect(parseCommandText("show the Professional margin")).toEqual({ verb: "show", object: "professional margin" });
  });
  test("deictic words are marked for page context", () => {
    expect(parseCommandText("open that call").deictic).toEqual({ noun: "call" });
    expect(parseCommandText("open this").deictic).toEqual({ noun: null });
  });
});

describe("the three starter commands, typed and spoken, resolve to the same action", () => {
  const cases: Array<[string, string, (a: unknown) => void]> = [
    ["open the receptionist's flagged calls", "section:receptionist/flagged-calls", (a) => expect(a).toEqual({ type: "navigate", to: "/receptionist", focus: "rx-flagged-calls" })],
    ["show the Professional margin", "answer:margin/receptionist-professional", (a) => expect(a).toEqual({ type: "navigate", to: "/operations", search: { package: "receptionist-professional" }, focus: "economics-workbench" })],
    ["open PowerPoint here", "app:PowerPoint", (a) => expect(a).toEqual({ type: "device", op: "open_app", subject: "PowerPoint", utterance: "open PowerPoint" })],
  ];
  for (const [text, id, check] of cases) {
    test(text, () => {
      const typed = resolveCommand(text, index, { channel: "typed" });
      const spoken = resolveCommand(`Jarvis, ${text.toLowerCase()} please`, index, { channel: "voice" });
      expect(typed.status).toBe("resolved");
      expect(spoken.status).toBe("resolved");
      if (typed.status !== "resolved" || spoken.status !== "resolved") return;
      expect(typed.entry.id).toBe(id);
      expect(spoken.entry.id).toBe(id);
      check(typed.entry.action);
      expect(planCommand(typed.entry, typed.parsed)).toEqual(planCommand(spoken.entry, spoken.parsed));
    });
  }

  test("a named device is passed through for resolveTarget to check", () => {
    const r = resolveCommand("open PowerPoint on my laptop", index);
    if (r.status !== "resolved") throw new Error(r.status);
    expect(planCommand(r.entry, r.parsed)).toMatchObject({ request: { utterance: "open PowerPoint", spokenTarget: "on my laptop" } });
  });
  test("a device plan carries the Jarvis entry body, the spoken target, and needs a target preview first", () => {
    const r = resolveCommand("open PowerPoint here", index);
    if (r.status !== "resolved") throw new Error(r.status);
    expect(planCommand(r.entry, r.parsed, { personId: "usman" })).toEqual({
      kind: "device",
      entryId: "app:PowerPoint",
      request: { utterance: "open PowerPoint", personId: "usman" },
      needsTargetPreview: true,
    });
  });

  test("the Professional margin answer shows the same numbers as the Jarvis margin answer (one source)", () => {
    const pkg = getReceptionistPackage("receptionist-professional");
    const ours = packageMarginAnswer(pkg);
    const jarvis = marginAnswer({ pkg, scenario: "base", clients: 5 });
    const pct = (bps: number | null) => (bps === null ? "not computable" : `${(bps / 100).toFixed(1)}%`);
    expect(ours.headline).toContain(pct(jarvis.numbers.contributionMarginBps as number | null));
    expect(ours.headline).toContain(pct(jarvis.numbers.operatingMarginBps as number | null));
    expect(ours.state).toBe("simulated");
    expect(ours.caveat).toMatch(/^Estimate/);
    expect(ours.figures[0].value).toContain("A$1,099");
  });
});

describe("honest fallbacks", () => {
  test("app index unavailable: pages and projects still resolve; an app command says why it can't", () => {
    const noApps = buildCommandIndex({ apps: { state: "setup-required", reason: "The installed-app index is kept for Usman's PC only.", items: [] } });
    expect(resolveCommand("open the receptionist's flagged calls", noApps).status).toBe("resolved");
    const r = resolveCommand("open PowerPoint here", noApps);
    expect(r.status).toBe("unresolved");
    if (r.status === "unresolved") {
      expect(r.reason).toContain("Usman's PC only");
      expect(r.unavailable.map((s) => s.id)).toContain("apps");
    }
  });
  test("a source never read is unknown, never live with zero entries", () => {
    const bare = buildCommandIndex();
    for (const s of bare.sources.filter((s) => s.id !== "static")) expect(s.state).toBe("unknown");
  });
});

describe("ambiguity asks instead of guessing", () => {
  test("two different actions close together → ambiguous with a question", () => {
    const two = buildCommandIndex({ sites: { state: "live", items: [{ id: "a", name: "Marden Rowe", url: "https://a.example", kind: "flagship" }, { id: "b", name: "Marden Rowe", url: "https://b.example", kind: "client" }] } });
    const r = resolveCommand("open marden rowe", two);
    expect(r.status).toBe("ambiguous");
    if (r.status === "ambiguous") expect(r.ask).toMatch(/^Did you mean/);
  });
  test("'show the margin' names no package → the margins page, never a package it wasn't told", () => {
    for (const channel of ["typed", "voice"] as const) {
      const r = resolveCommand("show the margin", index, { channel });
      expect(r.status).toBe("resolved");
      if (r.status === "resolved") expect(r.entry.id).toBe("page:/operations");
    }
  });
  test("speech-to-text word splits still match ('power point')", () => {
    const r = resolveCommand("open power point here", index, { channel: "voice" });
    expect(r.status === "resolved" && r.entry.id).toBe("app:PowerPoint");
  });
  test("voice needs a stronger match than typing", () => {
    const weak = buildCommandIndex({ apps: { state: "live", items: [{ name: "Snipping Tool" }] } });
    // "snipping" alone is a fair typed match; spoken, a one-word partial is asked about.
    const typed = resolveCommand("snip", weak, { channel: "typed" });
    const spoken = resolveCommand("snip", weak, { channel: "voice" });
    expect(typed.status).toBe("resolved");
    expect(spoken.status).not.toBe("resolved");
  });
});

describe("page context references", () => {
  test("no provider → unknown, never a guess", () => {
    const r = resolveCommand("open that call", index, { context: readPageContext() });
    expect(r.status).toBe("unresolved");
  });
  test("several visible calls and none focused → ask which", () => {
    setActivePage({ path: "/receptionist", destination: "receptionist", title: "Receptionist" });
    publishPageContext("rx", { visible: [
      { kind: "call", id: "c1", label: "Call 11:02 am", to: "/receptionist" },
      { kind: "call", id: "c2", label: "Call 11:40 am", to: "/receptionist" },
    ] });
    const r = resolveCommand("open that call", index, { context: readPageContext() });
    expect(r.status).toBe("ambiguous");
    if (r.status === "ambiguous") expect(r.ask).toContain("2 calls");
  });
  test("one focused call → that call", () => {
    setActivePage({ path: "/receptionist", destination: "receptionist", title: "Receptionist" });
    publishPageContext("rx", { focused: { kind: "call", id: "c2", label: "Call 11:40 am", to: "/receptionist", search: { call: "c2" } }, visible: [{ kind: "call", id: "c1", label: "Call 11:02 am" }] });
    const r = resolveCommand("open that call", index, { context: readPageContext() });
    expect(r.status).toBe("resolved");
    if (r.status === "resolved") expect(r.entry.action).toEqual({ type: "navigate", to: "/receptionist", search: { call: "c2" } });
  });
});

describe("coverage", () => {
  test("every destination and drilldown is an entry", () => {
    const ids = new Set(staticEntries().map((e) => e.id));
    for (const d of DESTINATIONS) {
      expect(ids.has(`page:${d.to}`)).toBe(true);
      for (const dd of d.drilldowns) expect(ids.has(`page:${drilldownHref(dd)}`)).toBe(true);
    }
  });
  test("every package has a margin answer", () => {
    for (const p of RECEPTIONIST_PACKAGES) expect(staticEntries().some((e) => e.id === `answer:margin/${p.id}`)).toBe(true);
  });
  test("empty text lists pages; search ranks exact names first", () => {
    expect(searchCommands("", index).every((s) => s.entry.kind === "page")).toBe(true);
    expect(searchCommands("finance", index)[0].entry.id).toBe("page:/finance");
    expect(searchCommands("powerpnt", index)[0].entry.id).toBe("app:PowerPoint");
  });
});
