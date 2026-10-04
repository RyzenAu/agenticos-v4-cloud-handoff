// @ts-ignore: the browser tsconfig has no bun types (bun test supplies this module).
import { describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { parseHTML } from "linkedom";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { computerSummary } from "@/lib/agent-workspace";
import { computerOptions } from "./setup/setup-model";
import { SCREEN_DOWN, SCREEN_OK, computer } from "./setup/setup-fixtures";
import { AssignForm } from "./workspace-parts";

const dom = (el: ReactElement) => {
  const { document } = parseHTML(`<!doctype html><html><body>${renderToStaticMarkup(<QueryClientProvider client={new QueryClient()}>{el}</QueryClientProvider>).replace(/<!-- -->/g, "")}</body></html>`);
  return { document, text: document.body.textContent ?? "" };
};
const up = (over = {}) => computer("research", { state: "online", ...over } as never);

describe("an online computer whose screen is failing is not 'ready for work'", () => {
  test("the summary says what is wrong; a working or unreported screen is still ready", () => {
    const down = computerSummary(up({ screen: SCREEN_DOWN }), "usman");
    expect(down.headline).toContain("online, but its screen isn't ready");
    expect(down.headline).not.toContain("ready for work");
    expect(down.tone).toBe("warn");
    expect(computerSummary(up({ screen: SCREEN_OK }), "usman").headline).toContain("ready for work");
    expect(computerSummary(up(), "usman").headline).toContain("ready for work"); // an older hub reports no screen truth: nothing is claimed
    expect(computerSummary(up({ screen: { ...SCREEN_DOWN, checking: true } }), "usman").headline).toContain("ready for work"); // no proof yet is not a failure
  });
});

describe("work is not offered while the screen is down", () => {
  const form = (c: ReturnType<typeof up>) => dom(<AssignForm c={c} me="usman" nameOf={(i) => i} onDone={() => {}} />);
  test("Start is disabled and the reason is the screen; the state words never say plain Online", () => {
    const r = form(up({ screen: SCREEN_DOWN }));
    expect(r.document.querySelector('button[type="submit"]')!.hasAttribute("disabled")).toBe(true);
    expect(r.text).toContain("Its screen isn't ready, so nothing would run.");
    expect(r.document.querySelector('[data-testid="assign-target"]')!.textContent).toContain("Online, screen unavailable");
    expect(r.document.querySelector('[data-testid="assign-target"]')!.textContent).not.toMatch(/· Online ·/);
  });
  test("with a good screen the form works as before (the button waits only for a title)", () => {
    const r = form(up({ screen: SCREEN_OK }));
    expect(r.text).not.toContain("so nothing would run");
    expect(r.document.querySelector('[data-testid="assign-target"]')!.textContent).toContain("· Online ·");
  });
});

describe("Setup's computer list uses the same words", () => {
  test("an online computer with a failing screen is labelled so", () => {
    const read = { status: "ok" as const, computers: [up({ screen: SCREEN_DOWN })] };
    const labels = computerOptions(read as never, null).options.map((o) => o.label);
    expect(labels.some((l) => l.includes("online, screen unavailable"))).toBe(true);
    expect(labels.some((l) => l.endsWith("(online)"))).toBe(false);
  });
});
