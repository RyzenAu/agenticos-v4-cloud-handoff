import { describe, expect, test } from "bun:test";
import { auditSite, statusPhrase } from "./site-audit";

const noSleep = () => Promise.resolve();

const ERROR_PAGE_HTML = "<html><head><title>502 Bad Gateway</title></head><body><center>502 Bad Gateway</center><hr><center>nginx/1.18.0</center></body></html>";
const REAL_PAGE = (title: string) =>
  `<html><head><meta name="viewport" content="width=device-width"></head><body><h1>${title}</h1><p>Book online now.</p><footer>© 2025 Emu Plains Dentist Care</footer><a href="mailto:info@emuplainsfamilydental.com.au">Email</a></body></html>`;

describe("site-audit: the Emu Plains error-page trap (25 Sep 2026 owner correction)", () => {
  test("a 502 homepage never gets graded directly — a working inner page (found via sitemap.xml) is graded instead", async () => {
    const requested: string[] = [];
    const request = (async (url: string) => {
      requested.push(String(url));
      const href = String(url);
      if (href === "https://emuplainsfamilydental.com.au/") return new Response(ERROR_PAGE_HTML, { status: 502 });
      if (href.endsWith("/sitemap.xml")) {
        return new Response(
          `<?xml version="1.0"?><urlset><url><loc>https://emuplainsfamilydental.com.au/</loc></url><url><loc>https://emuplainsfamilydental.com.au/about-us/</loc></url><url><loc>https://emuplainsfamilydental.com.au/contact-us/</loc></url></urlset>`,
          { headers: { "Content-Type": "application/xml" } },
        );
      }
      if (href.includes("/about-us/")) return new Response(REAL_PAGE("About Emu Plains Dentist Care"));
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const audit = await auditSite("https://emuplainsfamilydental.com.au/", request, noSleep);
    expect(audit.reachable).toBe(true);
    // Graded from the real inner page, not the 502 page — mobileViewport true, real copyright, real email.
    expect(audit.mobileViewport).toBe(true);
    expect(audit.copyrightYear).toBe(2025);
    expect(audit.emails).toContain("info@emuplainsfamilydental.com.au");
    expect(audit.auditedUrl).toContain("about-us");
    expect(audit.homepageError).toBe("502 Bad Gateway");
    // The homepage is checked twice (sleep is mocked to resolve instantly, but the retry still
    // runs) — it 502s both times in this test, so it's confirmed broken, precisely recorded,
    // even though a real content page was found and graded instead.
    expect(audit.homepageBroken).toBe(true);
    expect(requested.filter((r) => r === "https://emuplainsfamilydental.com.au/")).toHaveLength(2);
  });

  test("falls back to common paths when there's no sitemap", async () => {
    const request = (async (url: string) => {
      const href = String(url);
      if (href === "https://example.com.au/") return new Response(ERROR_PAGE_HTML, { status: 503 });
      if (href.endsWith("/sitemap.xml")) return new Response("not found", { status: 404 });
      if (href.endsWith("/about") || href.endsWith("/about-us")) return new Response("not found", { status: 404 });
      if (href.endsWith("/contact")) return new Response(REAL_PAGE("Contact Us"));
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const audit = await auditSite("https://example.com.au/", request, noSleep);
    expect(audit.reachable).toBe(true);
    expect(audit.auditedUrl).toContain("/contact");
  });

  test("a persistent 5xx (confirmed on retry) with no working inner page is 'broken', not a fabricated mobile-friendliness verdict", async () => {
    const request = (async () => new Response(ERROR_PAGE_HTML, { status: 502 })) as typeof fetch;
    const audit = await auditSite("https://totally-down.example.au/", request, noSleep);
    expect(audit.reachable).toBe(false);
    expect(audit.broken).toBe(true);
    expect(audit.homepageBroken).toBe(true);
    expect(audit.homepageError).toBe("502 Bad Gateway");
    expect(audit.mobileViewport).toBe(false); // never measured, never claimed either way
  });

  test("a 5xx that recovers on the ~60s retry (a blip) is not homepageBroken", async () => {
    let calls = 0;
    const request = (async (url: string) => {
      const href = String(url);
      if (href === "https://blip.example.au/") {
        calls++;
        return calls === 1 ? new Response(ERROR_PAGE_HTML, { status: 500 }) : new Response(REAL_PAGE("Blip Example"));
      }
      if (href.endsWith("/sitemap.xml")) return new Response("not found", { status: 404 });
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const audit = await auditSite("https://blip.example.au/", request, noSleep);
    // The retry succeeded, so this wasn't a confirmed-broken homepage — but the code still falls
    // through to the inner-page search rather than re-grading the now-working homepage directly
    // (a deliberate simplification — see site-audit.ts's own comment on this).
    expect(audit.homepageBroken).toBe(false);
  });

  test("a 4xx homepage (e.g. a WAF block) also gets the inner-page fallback, with no 60s wait", async () => {
    const request = (async (url: string) => {
      const href = String(url);
      if (href === "https://blocked.example.au/") return new Response("Forbidden", { status: 403 });
      if (href.endsWith("/sitemap.xml")) return new Response("not found", { status: 404 });
      if (href.endsWith("/about")) return new Response(REAL_PAGE("About Blocked Example"));
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
    // A sleep stub that throws if called — a 4xx must never trigger the 60s retry wait.
    const sleepShouldNotBeCalled = () => {
      throw new Error("should not sleep for a 4xx");
    };
    const audit = await auditSite("https://blocked.example.au/", request, sleepShouldNotBeCalled);
    expect(audit.reachable).toBe(true);
    expect(audit.homepageError).toBe("403 Forbidden");
    expect(audit.homepageBroken).toBe(false); // never confirmed persistent — 4xx isn't retried
  });

  test("statusPhrase reads precisely, e.g. for the verdict text", () => {
    expect(statusPhrase(502)).toBe("502 Bad Gateway");
    expect(statusPhrase(503)).toBe("503 Service Unavailable");
  });
});

describe("site-audit: a bot-protection challenge page is never graded as the real site (25 Sep 2026, Crawl4AI fallback)", () => {
  const CLOUDFLARE_CHALLENGE =
    `<html><body class="cf-browser-verification">Checking your browser before accessing example.com.au. ` +
    `This process is automatic. Ray ID: 8a1b2c3d4e5f6789</body></html>`;

  test("a 200 OK challenge page (a WAF that serves its interstitial rather than refusing outright) never gets its content graded", async () => {
    const request = (async () => new Response(CLOUDFLARE_CHALLENGE, { status: 200 })) as typeof fetch;
    const audit = await auditSite("https://example.com.au/", request, noSleep);
    expect(audit.challengePage).toBe(true);
    expect(audit.reachable).toBe(false);
    expect(audit.error).toBe("bot-protected");
    // Never a fabricated finding off the interstitial's own missing viewport meta/content.
    expect(audit.mobileViewport).toBe(false);
    expect(audit.copyrightYear).toBeNull();
  });

  test("a 503 challenge page never enters the 'confirmed broken homepage' path (never scored as a down/broken site)", async () => {
    const request = (async () => new Response(CLOUDFLARE_CHALLENGE, { status: 503 })) as typeof fetch;
    const audit = await auditSite("https://example.com.au/", request, () => {
      throw new Error("must never sleep/retry a challenge page as if it were a real 5xx");
    });
    expect(audit.challengePage).toBe(true);
    expect(audit.broken).toBe(false);
    expect(audit.homepageBroken).toBe(false);
  });

  test("a challenge page found via the inner-page fallback (WAF blocks every path on the host) is rejected, not graded", async () => {
    const request = (async (url: string) => {
      const href = String(url);
      if (href === "https://waf-wide.example.au/") return new Response("Forbidden", { status: 403 });
      if (href.endsWith("/sitemap.xml")) return new Response("not found", { status: 404 });
      // The inner page itself resolves (200) but the WAF still serves its interstitial there too —
      // findInnerPage must reject it on content, not just on status.
      if (href.endsWith("/about")) return new Response(CLOUDFLARE_CHALLENGE, { status: 200 });
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
    const audit = await auditSite("https://waf-wide.example.au/", request, noSleep);
    // No usable page was ever found — the WAF's interstitial doesn't count as one.
    expect(audit.reachable).toBe(false);
    expect(audit.auditedUrl).toBe("");
  });
});
