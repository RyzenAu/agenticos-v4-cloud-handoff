// @ts-ignore: the browser tsconfig has no bun types (bun test supplies this module).
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DataTable, Details, PageHeader, STATUS_LOOK, StatusLabel, Toolbar, type StatusState } from "./index";

describe("R11 shared system v1", () => {
  test("every status state has its own word, and only failed is red", () => {
    const states = Object.keys(STATUS_LOOK) as StatusState[];
    const reds = states.filter((s) => STATUS_LOOK[s].ink.includes("danger"));
    expect(reds).toEqual(["failed"]);
    // unsent, pending, failed and verified never share a look
    const looks = (["unsent", "pending", "failed", "verified"] as const).map((s) => `${STATUS_LOOK[s].icon.displayName ?? STATUS_LOOK[s].icon.name}|${STATUS_LOOK[s].ink}`);
    expect(new Set(looks).size).toBe(4);
    const html = renderToStaticMarkup(<StatusLabel state="unsent" />);
    expect(html).toContain('data-status="unsent"');
    expect(html).toContain("Not sent");
    expect(renderToStaticMarkup(<StatusLabel state="verified" label="Done and verified" />)).toContain("Done and verified");
  });

  test("PageHeader puts the primary action last", () => {
    const html = renderToStaticMarkup(<PageHeader title="Coding" actions={<button>Quiet</button>} primaryAction={<button>Assign work</button>} />);
    expect(html.indexOf("Quiet")).toBeLessThan(html.indexOf("Assign work"));
  });

  test("Details is folded by default and keeps its facts in the DOM", () => {
    const html = renderToStaticMarkup(<Details items={[{ label: "Request", value: "req-123", mono: true }]} />);
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("req-123");
    expect(html).toContain("inert");
  });

  test("Toolbar shows how many advanced filters are active", () => {
    const html = renderToStaticMarkup(<Toolbar search={{ value: "", onChange: () => {} }} advanced={<span>x</span>} advancedActive={2} />);
    expect(html).toContain("Advanced filters");
    expect(html).toMatch(/>2</);
  });

  test("DataTable renders the empty state instead of an empty table", () => {
    const html = renderToStaticMarkup(<DataTable columns={[{ key: "a", header: "A", cell: (r: { a: string }) => r.a }]} rows={[]} rowKey={(r) => r.a} empty={<p>Nothing yet</p>} />);
    expect(html).toBe("<p>Nothing yet</p>");
    const full = renderToStaticMarkup(<DataTable columns={[{ key: "a", header: "A", cell: (r: { a: string }) => r.a }]} rows={[{ a: "one" }]} rowKey={(r) => r.a} />);
    expect(full).toContain("<table");
    expect(full).toContain("one");
  });
});
