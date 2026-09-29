import { describe, expect, test } from "bun:test";
import { enrichWebsite } from "./enrich";

const robotsOk = (url: string) => String(url).endsWith("/robots.txt");

describe("enrich: Crawl4AI fallback orchestration (25 Sep 2026)", () => {
  test("off by default — a weak/near-empty plain-fetch read is never sent to Crawl4AI unless explicitly turned on", async () => {
    const request = (async (url: string) => {
      if (robotsOk(String(url))) return new Response("User-agent: *\n");
      // An SPA shell: loads fine (200), but nothing a real business page would have.
      return new Response(`<html><head><script src="/app.js"></script></head><body><div id="root"></div></body></html>`);
    }) as typeof fetch;
    // crawl4ai left at its default (false) — the 4th param isn't passed at all.
    const result = await enrichWebsite("https://spa-shell.example.au/", request, false);
    // Stays exactly the weak plain-fetch read — no render fallback ran to fill it in.
    expect(result.audit.reachable).toBe(true);
    expect(result.audit.mobileViewport).toBe(false);
    expect(result.emails).toHaveLength(0);
  });

  test("a weak/near-empty read triggers the Crawl4AI fallback when it's turned on, and the rendered result replaces the audit", async () => {
    const request = (async (url: string) => {
      if (robotsOk(String(url))) return new Response("User-agent: *\n");
      return new Response(`<html><head><script src="/app.js"></script></head><body><div id="root"></div></body></html>`);
    }) as typeof fetch;
    let crawl4aiCalledWith: string | null = null;
    const result = await enrichWebsite("https://spa-shell.example.au/", request, false, {
      exists: () => true,
      run: async (_bin, args) => {
        crawl4aiCalledWith = args[0];
        return {
          code: 0,
          stdout: JSON.stringify({
            html: `<html><head><meta name="viewport" content="width=device-width"></head><body><h1>Real Content</h1>
              <p>Book online now.</p><a href="mailto:info@spa-shell.example.au">Email</a></body></html>`,
            markdown: { raw_markdown: "" },
            status_code: 200,
            redirected_url: "https://spa-shell.example.au/",
            success: true,
          }),
          stderr: "",
        };
      },
    });
    expect(crawl4aiCalledWith).toBe("https://spa-shell.example.au/");
    expect(result.audit.mobileViewport).toBe(true); // came from the rendered content, not the empty shell
    expect(result.audit.onlineBooking).toBe(true);
    expect(result.emails.map((e) => e.value)).toContain("info@spa-shell.example.au");
  });

  test("a real, content-rich plain-fetch read never triggers Crawl4AI, even when it's turned on", async () => {
    const request = (async (url: string) => {
      if (robotsOk(String(url))) return new Response("User-agent: *\n");
      return new Response(`<html><head><meta name="viewport" content="width=device-width"></head><body>
        <h1>Real Dental</h1><p>Book online now.</p><footer>© 2025 Real Dental</footer>
        <a href="mailto:info@real-dental.example.au">Email</a></body></html>`);
    }) as typeof fetch;
    let crawl4aiCalled = false;
    await enrichWebsite("https://real-dental.example.au/", request, false, {
      exists: () => {
        crawl4aiCalled = true; // even the availability check should never be reached
        return true;
      },
      run: async () => ({ code: 0, stdout: "{}", stderr: "" }),
    });
    expect(crawl4aiCalled).toBe(false);
  });

  test("a confirmed challenge page ends up challengePage:true even after the fallback attempt fails too", async () => {
    const request = (async (url: string) => {
      if (robotsOk(String(url))) return new Response("User-agent: *\n");
      return new Response(
        `<html><body class="cf-browser-verification">Checking your browser before accessing this site. Ray ID: 8a1b2c3d4e5f6789</body></html>`,
        { status: 503 },
      );
    }) as typeof fetch;
    const result = await enrichWebsite("https://walled.example.au/", request, false, { exists: () => false });
    expect(result.audit.challengePage).toBe(true);
    expect(result.audit.reachable).toBe(false);
  });
});
