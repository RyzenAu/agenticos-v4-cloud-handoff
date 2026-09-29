import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Inbox } from "lucide-react";
import { Badge, PageFoot, Widget, WidgetEmpty, WidgetGrid, WidgetList, WidgetRow } from "../src/components/ds";
import { VerdictCard } from "../src/components/ds/verdict-card";

// L10 (29 Sep 2026): hydration errors, chip walls.

/** True when any <p> in the markup contains a block element (the invalid nesting React reports on hydrate). */
function blockInsideParagraph(html: string): boolean {
  const doc = html.replace(/<p\b[^>]*>/g, "\u0001").replace(/<\/p>/g, "\u0002");
  let depth = 0;
  for (let i = 0; i < doc.length; i++) {
    const c = doc[i];
    if (c === "\u0001") depth++;
    else if (c === "\u0002") depth = Math.max(0, depth - 1);
    else if (depth > 0 && /^<(?:div|p|ul|ol|section|table)\b/.test(doc.slice(i, i + 9))) return true;
  }
  return false;
}

test("hydration: an empty WidgetList holding a WidgetEmpty node is not a block inside a <p>", () => {
  const html = renderToStaticMarkup(
    <WidgetGrid aria-label="t">
      <WidgetList icon={Inbox} title="Handed-off tasks" empty={<WidgetEmpty title="No hand-offs yet" body="Tasks Jarvis hands off show here." />} />
    </WidgetGrid>,
  );
  expect(html).toContain("No hand-offs yet");
  expect(blockInsideParagraph(html)).toBe(false);
});

test("hydration: a plain-string empty state stays a single <p>, and a fragment empty state is a <div>", () => {
  const text = renderToStaticMarkup(<WidgetGrid aria-label="t"><WidgetList icon={Inbox} title="A" empty="Nothing here right now." /></WidgetGrid>);
  expect(text).toContain('<p data-widget-empty="" class="mt-5 text-sm text-muted-foreground">Nothing here right now.</p>');
  const frag = renderToStaticMarkup(
    <WidgetGrid aria-label="t">
      <WidgetList icon={Inbox} title="B" empty={<><span className="block">No conversations flagged here.</span><span className="mt-1 block">Drafts show here.</span></>} />
    </WidgetGrid>,
  );
  expect(frag).toContain("No conversations flagged here.");
  expect(blockInsideParagraph(frag)).toBe(false);
});

test("hydration guard: the two pages that logged it have no <p> holding a WidgetEmpty", () => {
  const html = renderToStaticMarkup(
    <WidgetGrid aria-label="Claude Code">
      <Widget title="One" value={1} line="x" />
      <WidgetList title="What it's doing" span={4} badge={0} empty={<WidgetEmpty title="Nothing yet" body="Describe what to build." />} />
    </WidgetGrid>,
  );
  expect(blockInsideParagraph(html)).toBe(false);
});

test("chips: a neutral or accent Badge is plain text, only a real state is a pill", () => {
  const neutral = renderToStaticMarkup(<Badge tone="neutral">Receptionist</Badge>);
  expect(neutral).toContain('data-badge="plain"');
  expect(neutral).not.toContain("rounded-full");
  expect(neutral).not.toContain("bg-inset");
  const accent = renderToStaticMarkup(<Badge tone="accent">Featured</Badge>);
  expect(accent).toContain('data-badge="plain"');
  for (const tone of ["success", "warn", "danger", "info"] as const) {
    const html = renderToStaticMarkup(<Badge tone={tone}>State</Badge>);
    expect(html).toContain('data-badge="state"');
    expect(html).toContain("rounded-full");
  }
});

test("chips: a widget's count is plain text beside the title, not a pill", () => {
  const html = renderToStaticMarkup(<WidgetGrid aria-label="t"><Widget title="Decisions" badge={7} value={7} line="x" /></WidgetGrid>);
  expect(html).toContain('data-widget-count=""');
  expect(html).not.toMatch(/data-widget-count[^>]*rounded-full/);
  expect(html).not.toContain("bg-inset px-2.5");
});

test("chips: the verdict card's facts are a plain line, and its tally is not a ring", () => {
  const html = renderToStaticMarkup(
    <VerdictCard tone="bad" title="Not safe to sell" why="6 of 7 requirements not met." facts={["Draft v0", "2 flagged calls"]} ring={<p data-requirements-tally="">1/7</p>} />,
  );
  expect(html).toContain("Draft v0");
  expect(html).not.toMatch(/<li[^>]*rounded-full/);
  expect(html).not.toContain("<svg circle");
  expect(html).toContain("1/7");
});

test("the page foot carries one small line (12px or larger), never a chip", () => {
  const html = renderToStaticMarkup(<PageFoot title="Sources: a and b">Stale: last read 3 h ago</PageFoot>);
  expect(html).toContain("data-page-foot");
  expect(html).toContain("text-xs");
  expect(html).not.toContain("rounded-full");
});

test("row meta reads as text", () => {
  const html = renderToStaticMarkup(<ul><WidgetRow title="Make the 5 retest calls" meta="Receptionist" /></ul>);
  expect(html).not.toContain("rounded-full");
});
