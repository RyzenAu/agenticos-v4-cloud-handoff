// L1 (29 Sep 2026): the shared widget grid (WidgetGrid, Widget, WidgetList, WidgetRow, PageFoot).
import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Phone } from "lucide-react";
import { PageFoot, Widget, WidgetGrid, WidgetList, WidgetRow } from "../src/components/ds";

const html = (el: React.ReactElement) => renderToStaticMarkup(el);

describe("WidgetGrid", () => {
  test("fills the width: 1 column on a phone, 2 at ≥768 (md), 4 at ≥1280 (xl), even gutters, stretched rows", () => {
    const out = html(<WidgetGrid><div /></WidgetGrid>);
    expect(out).toContain("data-widget-grid");
    expect(out).toContain("grid-cols-1");
    expect(out).toContain("md:grid-cols-2");
    expect(out).toContain("xl:grid-cols-4");
    expect(out).toContain("w-full");
    expect(out).toContain("items-stretch");
    expect(out).toMatch(/gap-4 [^"]*lg:gap-6/);
    expect(out).not.toMatch(/max-w-/); // no narrow centred column
  });
  test("mobile={2} puts small widgets two-up at phone width", () => {
    const out = html(<WidgetGrid mobile={2}><div /></WidgetGrid>);
    expect(out).toContain("grid-cols-2");
    expect(out).not.toContain(" grid-cols-1");
  });
});

describe("Widget", () => {
  test("icon + title, one big value, one short line, one action; equal height via h-full", () => {
    const out = html(<Widget id="calls" icon={Phone} title="Calls to make" value={3} line="2 are warm" action={<button type="button">Start calling</button>} />);
    expect(out).toMatch(/^<section id="calls" aria-labelledby="calls-title" data-widget="" data-span="1"/);
    expect(out).toContain('<h2 id="calls-title"');
    expect(out).toContain(">Calls to make</h2>");
    expect(out).toContain("lucide-phone");
    expect(out).toMatch(/data-widget-value=""[^>]*text-3xl[^>]*>3</);
    expect(out).toContain(">2 are warm</p>");
    expect(out).toContain(">Start calling</button>");
    expect(out).toContain("h-full");
    expect(out).toContain("rounded-2xl");
    expect(out.indexOf("Start calling")).toBeGreaterThan(out.indexOf("2 are warm")); // action sits at the foot
  });
  test("null value is honest: a dash, muted, never a fabricated 0", () => {
    const out = html(<Widget title="Revenue" value={null} line="Not connected" />);
    expect(out).toContain('data-widget-value="unknown"');
    expect(out).toContain(">—</p>");
    expect(out).not.toMatch(/>0</);
    expect(out).toContain("text-muted-foreground");
  });
  test("zero is a real value and still shown", () => {
    expect(html(<Widget title="Urgent" value={0} />)).toMatch(/data-widget-value=""[^>]*>0</);
  });
  test("tone colours only the value; children replace the value for a content widget", () => {
    expect(html(<Widget title="Verdict" value="Not safe" tone="danger" />)).toMatch(/text-danger[^>]*>Not safe</);
    const content = html(<Widget title="Script"><p>Hi, it's Usman</p></Widget>);
    expect(content).not.toContain("data-widget-value");
    expect(content).toContain("Hi, it&#x27;s Usman");
  });
  test("span widens on tablet and desktop and fills the row on a phone", () => {
    expect(html(<Widget title="a" span={2} />)).toContain("col-span-full md:col-span-2");
    expect(html(<Widget title="a" span={3} />)).toContain("col-span-full xl:col-span-3");
    expect(html(<Widget title="a" span={4} />)).toContain("col-span-full");
    expect(html(<Widget title="a" />)).not.toContain("col-span");
  });
  test("badge is a short word pill; data attributes and h3 pass through", () => {
    const out = html(<Widget title="Gmail" badge="Not connected" headingLevel={3} data-source="gmail" />);
    expect(out).toContain(">Not connected</span>");
    expect(out).toContain('data-source="gmail"');
    expect(out).toContain("<h3 ");
  });
});

describe("WidgetList", () => {
  test("spans 2 by default and renders rows as a list", () => {
    const out = html(
      <WidgetList title="To answer" action={<a href="/inbox">Open inbox</a>}>
        <WidgetRow title="Jane" meta="Asked about pricing" aside={<button type="button">Reply</button>} data-row="1" />
        <WidgetRow title="Sam" />
      </WidgetList>,
    );
    expect(out).toContain('data-span="2"');
    expect(out).toContain("md:col-span-2");
    expect(out).toContain('<ul role="list"');
    expect(out.match(/<li /g)).toHaveLength(2);
    expect(out).toContain('data-row="1"');
    expect(out).toContain(">Reply</button>");
    expect(out).toContain(">Open inbox</a>");
  });
  test("empty says so plainly instead of an empty box", () => {
    const out = html(<WidgetList title="To answer" empty="Nothing waiting for a reply." />);
    expect(out).toContain("data-widget-empty");
    expect(out).toContain("Nothing waiting for a reply.");
    expect(out).not.toContain("<ul");
  });
});

describe("PageFoot", () => {
  test("one small line for freshness and sources", () => {
    const out = html(<PageFoot>Updated 2 min ago · Source: Gmail</PageFoot>);
    expect(out).toMatch(/^<footer data-page-foot=""[^>]*text-xs/);
    expect(out).toContain("Updated 2 min ago · Source: Gmail");
  });
});
