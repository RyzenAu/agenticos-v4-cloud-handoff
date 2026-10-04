// P1 polish (REVIEW-T1 R2 low items + item 7): hollow payloads say Unknown, an offline site check isn't
// "7 down", the Command scene's Escape returns focus to what opened it, and "still" stops the last loops.
// Synthetic only: pure helpers, static render, linkedom and the CSS source.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { SignalTile } from "../src/components/shell/page-parts";
import { sitesCheckOffline, todayFacts, todayTiles } from "../src/components/shell/today-facts";
import { providersHollow } from "../src/components/shell/system-facts";
import { catalogueHollow } from "../src/components/shell/models-facts";
import { sceneOpener, sceneReturnTarget } from "../src/components/shell/command-scene/focus-return";

const NOW = Date.parse("2026-09-29T02:00:00Z");
const ok = <T,>(data: T) => ({ data: { ok: true as const, data, updatedAt: new Date(NOW - 60_000).toISOString(), ms: 12 } });
const site = (id: string, over: Record<string, unknown> = {}) => ({ id, name: `Site ${id}`, url: `https://${id}.example`, kind: "client", expectNoindex: null, status: 200, ok: true, ms: 120, noindex: false, finalUrl: null, tone: "ok", note: null, ...over });
const unreachable = (id: string) => site(id, { status: null, ok: false, ms: 20, tone: "bad", note: "Unreachable: getaddrinfo ENOTFOUND" });
const panel = (sites: unknown[]) => ok({ checkedAt: new Date(NOW - 60_000).toISOString(), sites, local: [], localNotRunning: [] } as never);
const sitesTile = (websites: ReturnType<typeof panel>) => todayTiles({ websites }, todayFacts({ websites }), NOW).find((t) => t.key === "websites")!;

describe("Today 'Sites up': nothing checked, or an offline check, is Unknown (not Live)", () => {
  test("0 of 0 is Unknown with no number", () => {
    const t = sitesTile(panel([]));
    expect(t).toMatchObject({ state: "unknown", value: null, hint: "No sites checked yet" });
    expect(t.tone).toBeUndefined();
  });
  test("no site answered at all (the check is offline): Unknown, one 'couldn't check' line, no '7 down'", () => {
    const websites = panel(["a", "b", "c", "d", "e", "f", "g"].map(unreachable));
    const t = sitesTile(websites);
    expect(t.state).toBe("unknown");
    expect(t.value).toBeNull();
    expect(t.hint).toContain("couldn't reach the network");
    expect(t.hint).not.toContain("down");
    const ex = todayFacts({ websites }).exceptions;
    expect(ex.filter((e) => e.id.startsWith("site-"))).toEqual([]);
    expect(ex.find((e) => e.id === "sites-offline")).toMatchObject({ tone: "warn", to: "/websites" });
    const html = renderToStaticMarkup(createElement(SignalTile, { label: t.label, value: t.value, state: t.state, tone: t.tone, hint: t.hint }));
    expect(html).toContain("Unknown");
    expect(html).not.toContain("Live");
    expect(html).not.toContain("0 of 7");
  });
  test("real outages still read as down: any site that answered makes the check itself online", () => {
    const websites = panel([site("a"), unreachable("b"), site("c", { status: 503, ok: false, tone: "bad" })]);
    const t = sitesTile(websites);
    expect(t).toMatchObject({ state: "ok", value: "1 of 3", tone: "danger", hint: "2 down" });
    expect(todayFacts({ websites }).exceptions.map((e) => e.id)).toEqual(["site-b", "site-c"]);
    // A single unreachable site is a real "down", not an offline check.
    expect(sitesCheckOffline([{ ok: false, status: null }])).toBe(false);
    expect(sitesCheckOffline([{ ok: false, status: null }, { ok: false, status: 502 }])).toBe(false);
    expect(sitesCheckOffline([{ ok: false, status: null }, { ok: false, status: null }])).toBe(true);
  });
});

describe("hollow System and Models payloads are Unknown, not 'Live' zeros", () => {
  test("System 'Model providers verified 0 of 7 · 0 models' reads nothing", () => {
    expect(providersHollow({ verified: 0, unverified: 7, failed: 0, setup: 0, unknown: 0, total: 7 }, 0)).toBe(true);
    expect(providersHollow({ verified: 0, unverified: 0, failed: 0, setup: 0, unknown: 0, total: 0 }, 12)).toBe(true);
    // A failure, a verified provider or listed models are real facts and stay Live.
    expect(providersHollow({ verified: 0, unverified: 0, failed: 7, setup: 0, unknown: 0, total: 7 }, 0)).toBe(false);
    expect(providersHollow({ verified: 3, unverified: 4, failed: 0, setup: 0, unknown: 0, total: 7 }, 0)).toBe(false);
    expect(providersHollow({ verified: 0, unverified: 7, failed: 0, setup: 0, unknown: 0, total: 7 }, 40)).toBe(false);
    expect(providersHollow(null, 0)).toBe(false);
  });
  test("Models '0 / 0 / 0' reads nothing; a real zero in one route beside others stays a zero", () => {
    expect(catalogueHollow({ free: 0, freeUnverified: 0, subscription: 0, metered: 0 })).toBe(true);
    expect(catalogueHollow({ free: 0, freeUnverified: 2, subscription: 0, metered: 0 })).toBe(false);
    expect(catalogueHollow({ free: 0, freeUnverified: 0, subscription: 4, metered: 0 })).toBe(false);
  });
  test("the pages wire the hollow state into the tile state and hide the numbers", () => {
    const sys = readFileSync(join(import.meta.dir, "../src/components/shell/pages/system-page.tsx"), "utf8");
    // T8c adds its own "unchecked" condition to the same tile; either way an empty provider list reads Unknown.
    expect(sys).toMatch(/providersEmpty(?: \|\| check\.phase === "unchecked")? \? "unknown"/);
    expect(sys).toContain("providers && !providersEmpty ?");
    const models = readFileSync(join(import.meta.dir, "../src/components/shell/pages/models-page.tsx"), "utf8");
    expect(models).toContain('hollow ? ("unknown" as const)');
    for (const k of ["free", "subscription", "metered"]) expect(models).toContain(`value={router.data && !hollow ? summary.${k} : null}`);
  });
});

describe("Command scene: Escape returns focus to what opened it", () => {
  const page = () =>
    parseHTML(
      `<html><body><header><button class="cp-trigger">Go to…</button></header><main><button data-command-scene-trigger="">Command scene</button><button id="other">Other</button></main><div role="dialog" data-state="open" class="cp-dialog"><input id="palette-input"></div></body></html>`,
    ).document;
  test("the opener is remembered; <body> and a closing palette are not", () => {
    const doc = page();
    const btn = doc.querySelector("#other")!;
    expect(sceneOpener(btn)).toBe(btn as never);
    expect(sceneOpener(doc.body)).toBeNull();
    expect(sceneOpener(doc.querySelector("#palette-input"))).toBeNull();
    expect(sceneOpener(null)).toBeNull();
  });
  test("focus goes back to the opener, else the page's scene button, else the palette trigger", () => {
    const doc = page();
    const other = doc.querySelector("#other") as unknown as HTMLElement;
    expect(sceneReturnTarget(other, doc as never)).toBe(other);
    expect(sceneReturnTarget(null, doc as never)).toBe(doc.querySelector("[data-command-scene-trigger]") as never);
    other.remove();
    expect(sceneReturnTarget(other, doc as never)).toBe(doc.querySelector("[data-command-scene-trigger]") as never);
    doc.querySelector("[data-command-scene-trigger]")!.remove();
    expect(sceneReturnTarget(null, doc as never)).toBe(doc.querySelector(".cp-trigger") as never);
  });
  test("the scene uses it on close, and the host captures the opener on every way in", () => {
    const dir = join(import.meta.dir, "../src/components/shell/command-scene");
    const scene = readFileSync(join(dir, "command-scene.tsx"), "utf8");
    expect(scene).toContain("onCloseAutoFocus");
    expect(scene).toContain("returnFocus?.()");
    const host = readFileSync(join(dir, "host.tsx"), "utf8");
    expect(host.match(/opener\.current = sceneOpener\(document\.activeElement\)/g)).toHaveLength(2);
    expect(host).toContain("data-command-scene-trigger");
    // The always-loaded host stays light: the scene itself is still lazy.
    expect(host).toContain('lazy(() => import("./command-scene"))');
    expect(host).not.toContain("scene-status");
  });
});

describe("item 7: 'still' stops the last Memory loop and the Jarvis level bars", () => {
  const css = (f: string) => readFileSync(join(import.meta.dir, "../src/components", f), "utf8");
  const stillBlock = () => {
    const src = css("shell/experience.css");
    const start = src.indexOf('html:not([data-motion="ambient"]) :is(');
    return src.slice(start, src.indexOf("animation-play-state: paused !important", start));
  };
  test("every infinite Memory brand loop is in the still list", () => {
    const mem = css("operator/memory-connections.css");
    const exp = css("shell/experience.css");
    const block = stillBlock();
    const pseudo = exp.slice(exp.indexOf("animation-play-state: paused !important") - 400, exp.indexOf("animation-play-state: paused !important"));
    const loops: string[] = [];
    for (const m of mem.matchAll(/([^{}]+)\{[^{}]*animation:[^;{}]*infinite[^{}]*\}/g))
      for (const sel of m[1].split(",").map((x) => x.trim()).filter((x) => x.startsWith(".mc-source-brand.is-circle"))) loops.push(sel);
    expect(loops.length).toBeGreaterThanOrEqual(4);
    for (const sel of loops) {
      const pe = /::(?:before|after)$/.test(sel);
      // A pseudo-element loop is paused through its host in the ::before/::after list after the main list.
      const listed = pe ? pseudo.includes(sel.replace(/::(?:before|after)$/, "")) : block.includes(sel);
      expect({ sel, listed }).toEqual({ sel, listed: true });
    }
    expect(block).toContain(".mc-source-brand.is-circle .mc-skill-layer-2");
  });
  test("the listening level bars hold a steady row in 'still' (no loop), and still differ from idle", () => {
    const shell = css("shell/shell.css");
    const rule = /html:not\(\[data-motion="ambient"\]\) \.is-listening \.sh-jarvis-signal i \{([^}]*)\}/.exec(shell);
    expect(rule).not.toBeNull();
    expect(rule![1]).toContain("animation: none");
    expect(rule![1]).toContain("transform: scaleY(0.9)");
  });
});
