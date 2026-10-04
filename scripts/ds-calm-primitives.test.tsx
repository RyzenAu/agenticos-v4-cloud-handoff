// D1 (29 Sep 2026): the calm, rounded primitives in src/components/ds (ProgressRing, Disclosure, InfoTip, SummaryTile, Tabs, NextStep,
// ChecklistRow, VerdictCard, AttentionCard). Server markup for structure and honesty; a linkedom
// client render for the disclosure's keyboard/click behaviour.
import { afterEach, describe, expect, test } from "bun:test";
import React, { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { AttentionCard, ChecklistRow, Disclosure, InfoTip, NextStep, ProgressRing, SummaryTile, TabPanel, Tabs, VerdictCard } from "../src/components/ds";

const html = (el: React.ReactElement) => renderToStaticMarkup(el);

describe("ProgressRing", () => {
  test("names the count in words and draws the arc for the part that's done", () => {
    const out = html(<ProgressRing value={1} max={7} label="1 of 7 requirements met" />);
    expect(out).toContain('role="img"');
    expect(out).toContain('aria-label="1 of 7 requirements met"');
    expect(out).toContain('data-ring-value="1"');
    expect(out.match(/<circle/g)).toHaveLength(2); // track + arc
    expect(out).toContain('stroke-linecap="round"');
    expect(out).toContain("stroke-brand"); // progress is the accent, not a state colour
    expect(out).toContain("motion-reduce:transition-none");
    expect(out).toMatch(/>1<span[^>]*>\/7</);
  });
  test("zero draws only the track; unknown shows a dash, never a fabricated 0", () => {
    const zero = html(<ProgressRing value={0} max={5} label="0 of 5 gates passed" />);
    expect(zero.match(/<circle/g)).toHaveLength(1);
    expect(zero).toMatch(/>0<span/);
    const unknown = html(<ProgressRing value={null} max={5} label="Gates unknown" />);
    expect(unknown).toContain('data-ring-value="unknown"');
    expect(unknown).toContain("—");
    expect(unknown).not.toMatch(/>0<span/);
  });
  test("a full ring can take a state tone", () => {
    expect(html(<ProgressRing value={5} max={5} tone="success" label="5 of 5" />)).toContain("stroke-success");
  });
});

describe("Disclosure (server markup)", () => {
  test("collapsed by default: a real button with aria-expanded/aria-controls, panel inert but in the DOM", () => {
    const out = html(<Disclosure id="t" summary="Requirements" meta="1 of 7 met"><p>Hidden but true</p></Disclosure>);
    expect(out).toContain('<button type="button" id="t-trigger" aria-expanded="false" aria-controls="t-panel"');
    expect(out).toContain('id="t-panel" inert=""');
    expect(out).not.toContain('role="region"'); // review F8: panels are not landmarks
    expect(out).toContain("Hidden but true"); // folded, never removed
    expect(out).toContain("grid-rows-[0fr]");
    expect(out).toContain("motion-reduce:transition-none");
  });
  test("defaultOpen renders expanded and focusable", () => {
    const out = html(<Disclosure id="o" defaultOpen summary="Open"><a href="#x">Link</a></Disclosure>);
    expect(out).toContain('aria-expanded="true"');
    expect(out).not.toContain("inert");
    expect(out).toContain("grid-rows-[1fr]");
  });
  test("controls go beside the trigger, never inside it (no nested buttons)", () => {
    const out = html(<Disclosure id="a" summary="Gate" aside={<button type="button">Sign off</button>}>x</Disclosure>);
    const trigger = out.slice(out.indexOf('id="a-trigger"'), out.indexOf("</button>"));
    expect(trigger).not.toContain("Sign off");
    expect(out).toContain(">Sign off</button>");
  });
});

let root: Root | undefined;
const restore: Array<() => void> = [];
function setGlobal(name: string, value: unknown) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  restore.push(() => (previous ? Object.defineProperty(globalThis, name, previous) : Reflect.deleteProperty(globalThis, name)));
}
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  while (restore.length) restore.pop()!();
});

describe("Disclosure (client)", () => {
  test("click toggles open/closed; inert and aria-expanded follow; onOpenChange reports", async () => {
    const { window } = parseHTML("<html><body><main></main></body></html>");
    setGlobal("window", window);
    setGlobal("document", window.document);
    setGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const seen: boolean[] = [];
    const container = window.document.querySelector("main")!;
    root = createRoot(container);
    await act(async () => root!.render(<Disclosure id="c" summary="Details" onOpenChange={(v) => seen.push(v)}><button type="button">Inner</button></Disclosure>));
    const trigger = container.querySelector("#c-trigger")!;
    const panel = container.querySelector("#c-panel")!;
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(panel.hasAttribute("inert")).toBe(true);
    await act(async () => { trigger.dispatchEvent(new window.Event("click", { bubbles: true })); });
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(panel.hasAttribute("inert")).toBe(false);
    expect(panel.getAttribute("aria-hidden")).toBeNull();
    await act(async () => { trigger.dispatchEvent(new window.Event("click", { bubbles: true })); });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(panel.hasAttribute("inert")).toBe(true);
    expect(seen).toEqual([true, false]);
    // A native <button>: Enter and Space activate it in every browser, no custom key handling needed.
    expect(trigger.tagName).toBe("BUTTON");
    expect(trigger.getAttribute("type")).toBe("button");
  });
});

describe("ChecklistRow", () => {
  const row = (status: "met" | "not-met" | "unknown" | "info") => html(<ul><ChecklistRow status={status} label="Eval report passing" detail="No eval report on file" /></ul>);
  test("state is a word as well as an icon; not met is a calm open circle, not a red pill", () => {
    const notMet = row("not-met");
    expect(notMet).toContain(">Not met<");
    expect(notMet).toContain("lucide-circle ");
    expect(notMet).not.toMatch(/danger/);
    expect(notMet).toContain("No eval report on file");
    expect(row("met")).toContain(">Met<");
    expect(row("met")).toContain("text-success");
  });
  test("unknown is never shown as met", () => {
    const unknown = row("unknown");
    expect(unknown).toContain(">Unknown<");
    expect(unknown).not.toContain(">Met<");
    expect(unknown).toContain("lucide-circle-dashed");
    expect(row("info")).toContain(">Info<");
  });
  test("passes data attributes through", () => {
    expect(html(<ul><ChecklistRow status="met" label="x" data-sell-check="retests" /></ul>)).toContain('data-sell-check="retests"');
  });
});

describe("VerdictCard", () => {
  test("one danger mark for a bad verdict; neutral card, rounded, no side stripe", () => {
    const out = html(<VerdictCard tone="bad" titleId="v" title="Not safe to sell" why="6 of 7 requirements to sell aren't met yet." facts={["0 of 5 gates passed"]} primary={<a href="#x">Follow up 2 flagged calls</a>} ring={<ProgressRing value={1} max={7} label="1 of 7" />} />);
    expect(out).toContain('data-tone="bad"');
    expect(out).toContain('aria-labelledby="v"');
    expect(out).toContain('<h2 id="v"');
    expect(out).toContain("rounded-2xl");
    expect(out).not.toContain("border-l-");
    expect(out.match(/danger/g)).toHaveLength(2); // bg-danger-soft text-danger on the one round mark
    expect(out).toContain("0 of 5 gates passed");
    expect(out).toContain("Follow up 2 flagged calls");
  });
  test("ok and neutral verdicts carry no danger", () => {
    expect(html(<VerdictCard tone="ok" title="Safe to sell" />)).not.toMatch(/danger/);
    expect(html(<VerdictCard tone="neutral" title="Sell status unknown" />)).not.toMatch(/danger|success/);
  });
});

describe("AttentionCard", () => {
  const card = (severity: "urgent" | "attention" | "waiting") =>
    html(<ul><AttentionCard severity={severity} title="Caller may expect a booking that wasn't made" meta="Tue 2:07 pm · ••• 615" details={<span>False booking</span>} actions={<button type="button">Mark followed up</button>} /></ul>);
  test("a single severity mark; danger only when urgent", () => {
    expect(card("urgent")).toContain(">Urgent<");
    expect(card("urgent")).toContain("bg-danger");
    expect(card("attention")).toContain(">Follow up<");
    expect(card("attention")).not.toMatch(/danger/);
    expect(card("waiting")).not.toMatch(/danger|warn/);
  });
  test("labels sit in collapsed details; the summary line and actions stay visible", () => {
    const out = card("attention");
    expect(out).toContain("Caller may expect a booking that wasn&#x27;t made");
    expect(out).toContain('aria-expanded="false"');
    expect(out.indexOf("False booking")).toBeGreaterThan(out.indexOf('inert=""'));
    expect(out).toContain(">Mark followed up</button>");
    expect(out).toContain("rounded-2xl");
  });
});

describe("InfoTip", () => {
  test("a labelled round (i); the note is in the DOM but hidden until opened", () => {
    const out = html(<InfoTip label="Sources">Source: synthetic feed</InfoTip>);
    expect(out).toContain('aria-label="Sources"');
    expect(out).toContain('aria-expanded="false"');
    expect(out).toMatch(/role="note" hidden=""[^>]*>Source: synthetic feed/);
    expect(out).toContain("rounded-full");
  });
  test("click opens, Escape closes and returns focus to the button", async () => {
    const { window } = parseHTML("<html><body><main></main></body></html>");
    setGlobal("window", window);
    setGlobal("document", window.document);
    setGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = window.document.querySelector("main")!;
    root = createRoot(container);
    await act(async () => root!.render(<InfoTip label="Sources">Note</InfoTip>));
    const button = container.querySelector("button")!;
    const note = container.querySelector('[role="note"]')!;
    await act(async () => { button.dispatchEvent(new window.Event("click", { bubbles: true })); });
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(note.hasAttribute("hidden")).toBe(false);
    let focused = false;
    button.focus = () => { focused = true; };
    await act(async () => { window.document.dispatchEvent(Object.assign(new window.Event("keydown"), { key: "Escape" })); });
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(note.hasAttribute("hidden")).toBe(true);
    expect(focused).toBe(true);
  });
});

describe("SummaryTile", () => {
  test("a button with a short label, a big value, one line and an optional ring", () => {
    const out = html(<SummaryTile label="Flagged" value={2} sub="1 urgent" subTone="danger" controls="rx-panel-calls" data-tile="flagged" visual={<ProgressRing value={0} max={5} label="0 of 5" />} />);
    expect(out).toMatch(/^<button type="button" aria-controls="rx-panel-calls"/);
    expect(out).toContain('data-tile="flagged"');
    expect(out).toContain("text-3xl"); // 36px value, 44px from lg
    expect(out).toContain("lg:text-[2.75rem]");
    expect(out).toContain(">1 urgent<");
    expect(out).toContain("text-danger");
    expect(out).toContain("rounded-2xl");
    expect(html(<SummaryTile label="Calls today" value={3} sub="2 answered" />)).not.toMatch(/danger|warn/);
  });
});

describe("NextStep", () => {
  test("one sentence and one action", () => {
    const out = html(<NextStep action={<button type="button">Open flagged calls</button>}>Follow up 2 flagged calls</NextStep>);
    expect(out).toContain("Follow up 2 flagged calls");
    expect(out).toContain('<span class="sr-only">Next step: </span>');
    expect(out.match(/<button/g)).toHaveLength(1);
  });
});

describe("Tabs", () => {
  const tabs = [{ id: "overview", label: "Overview" }, { id: "calls", label: "Calls", count: 2 }, { id: "golive", label: "Go-live", count: 0 }] as const;
  test("ARIA tablist with roving tabindex; panels stay in the DOM but hidden", () => {
    const out = html(<><Tabs tabs={[...tabs]} value="calls" onChange={() => {}} idBase="t" label="Sections" /><TabPanel idBase="t" id="overview" active={false}>Overview body</TabPanel><TabPanel idBase="t" id="calls" active>Calls body</TabPanel></>);
    expect(out).toContain('role="tablist" aria-label="Sections"');
    expect(out).toContain('id="t-tab-calls" aria-selected="true" aria-controls="t-panel-calls" tabindex="0"');
    expect(out).toContain('id="t-tab-overview" aria-selected="false" aria-controls="t-panel-overview" tabindex="-1"');
    expect(out).toContain(">2</span>"); // a count chip
    expect(out).not.toMatch(/Go-live<span/); // a zero count is not shown
    expect(out).toMatch(/id="t-panel-overview" aria-labelledby="t-tab-overview" hidden=""[^>]*>Overview body/);
    expect(out).toContain("overflow-x-auto"); // only the tab row scrolls on a phone
  });
  test("arrow keys, Home and End move the selection", async () => {
    const { window } = parseHTML("<html><body><main></main></body></html>");
    setGlobal("window", window);
    setGlobal("document", window.document);
    setGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = window.document.querySelector("main")!;
    root = createRoot(container);
    const picked: string[] = [];
    const Harness = () => {
      const [v, setV] = React.useState<string>("overview");
      return <Tabs tabs={[...tabs]} value={v} onChange={(id) => { picked.push(id); setV(id); }} idBase="k" label="Sections" />;
    };
    await act(async () => root!.render(<Harness />));
    const key = async (id: string, k: string) => act(async () => {
      container.querySelector(`#k-tab-${id}`)!.dispatchEvent(Object.assign(new window.Event("keydown", { bubbles: true }), { key: k }));
    });
    await key("overview", "ArrowRight");
    await key("calls", "End");
    await key("golive", "ArrowRight"); // wraps
    await key("overview", "ArrowLeft"); // wraps back
    await key("golive", "Home");
    expect(picked).toEqual(["calls", "golive", "overview", "golive", "overview"]);
    expect(container.querySelector("#k-tab-overview")!.getAttribute("aria-selected")).toBe("true");
  });
});
