import { describe, expect, test } from "bun:test";
import type { Runner } from "../site-draft/qa";
import { browserFetchAudit, browserOverflowCheck } from "./browser-audit";

function fakeRunner(responses: Record<string, { stdout: string; ok: boolean }>): { runner: Runner; calls: string[][] } {
  const calls: string[][] = [];
  const runner: Runner = async (args) => {
    calls.push(args);
    const key = args.slice(-2).join(" ") || args.at(-1) || "";
    for (const [pattern, response] of Object.entries(responses)) if (key.includes(pattern) || args.includes(pattern)) return response;
    return { stdout: "", ok: false };
  };
  return { runner, calls };
}

describe("browser-audit: real-browser retry for a site plain fetch couldn't load", () => {
  test("builds a reachable SiteAudit from the rendered page when the browser succeeds", async () => {
    const html = `<html><head><meta name="viewport" content="width=device-width"></head><body>
      <a href="mailto:reception@bkperiodontics.com.au">Email</a> Book online now. © 2025</body></html>`;
    const { runner, calls } = fakeRunner({
      open: { stdout: "", ok: true },
      "html html": { stdout: html, ok: true },
      url: { stdout: "https://bkperiodontics.com.au/", ok: true },
      close: { stdout: "", ok: true },
    });
    const result = await browserFetchAudit("https://bkperiodontics.com.au/", { runner });
    expect(result).not.toBeNull();
    expect(result!.reachable).toBe(true);
    expect(result!.finalUrl).toBe("https://bkperiodontics.com.au/");
    expect(result!.mobileViewport).toBe(true);
    expect(result!.onlineBooking).toBe(true);
    expect(result!.emails).toEqual(["reception@bkperiodontics.com.au"]);
    // Opens, reads html + url, and always closes its own session — never leaves a browser running.
    expect(calls.some((c) => c.includes("open"))).toBe(true);
    expect(calls.some((c) => c.includes("close"))).toBe(true);
  });

  test("returns null when the browser can't open the page either — never fabricates reachability", async () => {
    const { runner } = fakeRunner({ open: { stdout: "", ok: false }, close: { stdout: "", ok: true } });
    const result = await browserFetchAudit("https://genuinely-down.example/", { runner });
    expect(result).toBeNull();
  });

  test("returns null (and still closes) when the page opens but html can't be read", async () => {
    const { runner, calls } = fakeRunner({ open: { stdout: "", ok: true }, "html html": { stdout: "", ok: false }, close: { stdout: "", ok: true } });
    const result = await browserFetchAudit("https://example.com/", { runner });
    expect(result).toBeNull();
    expect(calls.some((c) => c.includes("close"))).toBe(true);
  });

  test("closes its session even when the runner throws", async () => {
    const calls: string[][] = [];
    const runner: Runner = async (args) => {
      calls.push(args);
      if (args.includes("open")) throw new Error("boom");
      return { stdout: "", ok: true };
    };
    const result = await browserFetchAudit("https://example.com/", { runner });
    expect(result).toBeNull();
    expect(calls.some((c) => c.includes("close"))).toBe(true);
  });

  test("gives each call its own session so retries for different leads never share browser state", async () => {
    const sessions = new Set<string>();
    const runner: Runner = async (args) => {
      const idx = args.indexOf("--session");
      if (idx >= 0) sessions.add(args[idx + 1]);
      if (args.includes("open")) return { stdout: "", ok: true };
      if (args.includes("html")) return { stdout: "<html><body>hi</body></html>", ok: true };
      if (args.includes("url")) return { stdout: "https://example.com/", ok: true };
      return { stdout: "", ok: true };
    };
    await browserFetchAudit("https://example.com/", { runner });
    await browserFetchAudit("https://example.org/", { runner });
    expect(sessions.size).toBe(2);
  });

  test("sets a 390px mobile viewport before the first real navigation", async () => {
    const calls: string[][] = [];
    const runner: Runner = async (args) => {
      calls.push(args);
      if (args.includes("open")) return { stdout: "", ok: true };
      if (args.includes("html")) return { stdout: "<html><body>hi</body></html>", ok: true };
      if (args.includes("url")) return { stdout: "https://example.com/", ok: true };
      return { stdout: "false", ok: true };
    };
    await browserFetchAudit("https://example.com/", { runner });
    const viewportCallIdx = calls.findIndex((c) => c.includes("viewport"));
    const navigateOpenIdx = calls.findIndex((c) => c.includes("open") && c.includes("https://example.com/"));
    expect(viewportCallIdx).toBeGreaterThanOrEqual(0);
    expect(calls[viewportCallIdx]).toEqual(expect.arrayContaining(["set", "viewport", "390", "844"]));
    expect(viewportCallIdx).toBeLessThan(navigateOpenIdx); // staged before navigating, not after
  });

  test("measures real horizontal overflow at 390px and reports it as overflowAt390", async () => {
    const runner: Runner = async (args) => {
      if (args.includes("open")) return { stdout: "", ok: true };
      if (args.includes("html")) return { stdout: "<html><body>hi</body></html>", ok: true };
      if (args.includes("url")) return { stdout: "https://cramped-site.example/", ok: true };
      if (args.includes("eval")) return { stdout: "true", ok: true };
      return { stdout: "", ok: true };
    };
    const result = await browserFetchAudit("https://cramped-site.example/", { runner });
    expect(result!.overflowAt390).toBe(true);
  });

  test("overflowAt390 is null, never a guessed false, when the measurement itself fails", async () => {
    const runner: Runner = async (args) => {
      if (args.includes("open")) return { stdout: "", ok: true };
      if (args.includes("html")) return { stdout: "<html><body>hi</body></html>", ok: true };
      if (args.includes("url")) return { stdout: "https://example.com/", ok: true };
      if (args.includes("eval")) return { stdout: "", ok: false };
      return { stdout: "", ok: true };
    };
    const result = await browserFetchAudit("https://example.com/", { runner });
    expect(result!.overflowAt390).toBeNull();
  });
});

describe("browser-audit: standalone 390px overflow check (for a site whose plain fetch already succeeded)", () => {
  test("returns true/false when measured", async () => {
    const runner: Runner = async (args) => {
      if (args.includes("open")) return { stdout: "", ok: true };
      if (args.includes("eval")) return { stdout: "false", ok: true };
      return { stdout: "", ok: true };
    };
    expect(await browserOverflowCheck("https://fine-site.example/", { runner })).toBe(false);
  });

  test("returns null (never a guess) when the browser can't open the page", async () => {
    const runner: Runner = async (args) => {
      if (args.includes("open") && args.includes("https://down.example/")) return { stdout: "", ok: false };
      return { stdout: "", ok: true };
    };
    expect(await browserOverflowCheck("https://down.example/", { runner })).toBeNull();
  });

  test("always closes its session, even when the eval itself fails", async () => {
    const calls: string[][] = [];
    const runner: Runner = async (args) => {
      calls.push(args);
      if (args.includes("open")) return { stdout: "", ok: true };
      if (args.includes("eval")) return { stdout: "", ok: false };
      return { stdout: "", ok: true };
    };
    const result = await browserOverflowCheck("https://example.com/", { runner });
    expect(result).toBeNull();
    expect(calls.some((c) => c.includes("close"))).toBe(true);
  });

  test("refuses to measure overflow on an error page (defense in depth)", async () => {
    const runner: Runner = async (args) => {
      if (args.includes("open")) return { stdout: "", ok: true };
      if (args.includes("html")) return { stdout: "<html><body>502 Bad Gateway</body></html>", ok: true };
      return { stdout: "", ok: true };
    };
    expect(await browserOverflowCheck("https://down.example/", { runner })).toBeNull();
  });
});

describe("browser-audit: the Emu Plains error-page trap (25 Sep 2026 owner correction)", () => {
  test("never grades a 502 page as 'not mobile-friendly' — finds a working common-path page instead", async () => {
    const opened: string[] = [];
    const runner: Runner = async (args) => {
      if (args.includes("open") && args[args.indexOf("open") + 1]?.startsWith("http")) opened.push(args[args.indexOf("open") + 1]);
      if (args.includes("open")) return { stdout: "", ok: true };
      if (args.includes("html")) {
        const last = opened.at(-1) ?? "";
        if (last.includes("/about")) {
          return { stdout: `<html><head><meta name="viewport" content="width=device-width"></head><body>About Cramped Dental. Book online now.</body></html>`, ok: true };
        }
        return { stdout: "<html><head><title>502 Bad Gateway</title></head><body><center>502 Bad Gateway</center><hr><center>nginx/1.18.0</center></body></html>", ok: true };
      }
      if (args.includes("url")) return { stdout: "https://cramped-dental.example/about", ok: true };
      if (args.includes("eval")) return { stdout: "false", ok: true };
      return { stdout: "", ok: true };
    };
    const result = await browserFetchAudit("https://cramped-dental.example/", { runner });
    expect(result).not.toBeNull();
    expect(result!.mobileViewport).toBe(true); // measured from /about, not the 502 page
    expect(result!.homepageError).not.toBeNull();
    expect(opened.some((u) => u.includes("/about"))).toBe(true);
  });

  test("reports 'homepage down' (reachable:false, broken:true) when every common path is also an error page", async () => {
    const runner: Runner = async (args) => {
      if (args.includes("open")) return { stdout: "", ok: true };
      if (args.includes("html")) return { stdout: "<html><body>503 Service Unavailable</body></html>", ok: true };
      return { stdout: "", ok: true };
    };
    const result = await browserFetchAudit("https://totally-down.example/", { runner });
    expect(result).not.toBeNull();
    expect(result!.reachable).toBe(false);
    expect(result!.broken).toBe(true);
    expect(result!.homepageBroken).toBe(true);
  });
});
