import { describe, expect, test } from "bun:test";
import { crawl4aiAudit, crawl4aiAvailable, crawl4aiFetch, type RunResult } from "./crawl4ai";

const REAL_PAGE_JSON = JSON.stringify({
  html: `<html><head><meta name="viewport" content="width=device-width"></head><body><h1>St Clair Dental</h1>
    <p>Book online now.</p><footer>© 2025 St Clair Dental</footer>
    <a href="mailto:reception@stclairdental.com.au">Email</a></body></html>`,
  markdown: { raw_markdown: "# St Clair Dental" },
  status_code: 200,
  redirected_url: "https://stclairdental.com.au/",
  success: true,
});

const CHALLENGE_JSON = JSON.stringify({
  html: `<html><body class="cf-browser-verification">Checking your browser before accessing this
    site. Ray ID: 8a1b2c3d4e5f6789</body></html>`,
  markdown: { raw_markdown: "" },
  status_code: 503,
  redirected_url: "https://example.com.au/",
  success: true,
});

describe("crawl4ai: availability — degrades gracefully when the exe isn't there", () => {
  test("crawl4aiAvailable is false when exists() says so, without ever calling run()", () => {
    expect(crawl4aiAvailable({ exists: () => false })).toBe(false);
  });

  test("crawl4aiFetch returns null (never throws) when the exe isn't present, and never invokes run()", async () => {
    let runCalled = false;
    const result = await crawl4aiFetch("https://example.com.au/", {
      exists: () => false,
      run: async () => {
        runCalled = true;
        return { code: 0, stdout: "{}", stderr: "" };
      },
    });
    expect(result).toBeNull();
    expect(runCalled).toBe(false);
  });
});

describe("crawl4ai: parses the real crwl.exe -o all JSON shape", () => {
  test("crawl4aiFetch returns html/markdown/statusCode/finalUrl from a successful run", async () => {
    const result = await crawl4aiFetch("https://stclairdental.com.au/", {
      exists: () => true,
      run: async () => ({ code: 0, stdout: REAL_PAGE_JSON, stderr: "" }),
    });
    expect(result).not.toBeNull();
    expect(result!.statusCode).toBe(200);
    expect(result!.finalUrl).toBe("https://stclairdental.com.au/");
    expect(result!.html).toContain("St Clair Dental");
    expect(result!.markdown).toBe("# St Clair Dental");
  });

  test("crawl4aiAudit builds a full, reachable SiteAudit from real rendered content — same facts a plain fetch would extract", async () => {
    const audit = await crawl4aiAudit("https://stclairdental.com.au/", {
      exists: () => true,
      run: async () => ({ code: 0, stdout: REAL_PAGE_JSON, stderr: "" }),
    });
    expect(audit).not.toBeNull();
    expect(audit!.reachable).toBe(true);
    expect(audit!.challengePage).toBe(false);
    expect(audit!.mobileViewport).toBe(true);
    expect(audit!.copyrightYear).toBe(2025);
    expect(audit!.emails).toContain("reception@stclairdental.com.au");
  });

  test("crawl4aiAudit never scores a rendered challenge page as a real site — challengePage: true, audit_pending shape", async () => {
    const audit = await crawl4aiAudit("https://example.com.au/", {
      exists: () => true,
      run: async () => ({ code: 0, stdout: CHALLENGE_JSON, stderr: "" }),
    });
    expect(audit).not.toBeNull();
    expect(audit!.challengePage).toBe(true);
    expect(audit!.reachable).toBe(false);
    expect(audit!.error).toBe("bot-protected");
    // Never grade the interstitial's own (lack of) content as if it were the real page.
    expect(audit!.mobileViewport).toBe(false);
    expect(audit!.copyrightYear).toBeNull();
  });

  test("malformed/non-JSON stdout is treated as a failed run, not a crash", async () => {
    const result = await crawl4aiFetch("https://example.com.au/", {
      exists: () => true,
      run: async () => ({ code: 0, stdout: "not json at all", stderr: "" }),
    });
    expect(result).toBeNull();
  });
});

describe("crawl4ai: the timeout path", () => {
  test("a non-zero exit code (execFile's own signal for a killed/timed-out process) returns null, never throws", async () => {
    const result = await crawl4aiFetch("https://slow-site.example.au/", {
      exists: () => true,
      run: async (): Promise<RunResult> => ({ code: 1, stdout: "", stderr: "" }), // execFile reports a SIGKILL'd process this way
    });
    expect(result).toBeNull();
  });

  test("a run() that itself throws (e.g. the timeout rejecting) is caught, not propagated", async () => {
    const result = await crawl4aiFetch("https://slow-site.example.au/", {
      exists: () => true,
      run: async () => {
        throw new Error("ETIMEDOUT");
      },
    });
    expect(result).toBeNull();
    // crawl4aiAudit built on top of a timed-out fetch degrades the same way — null, not a crash.
    const audit = await crawl4aiAudit("https://slow-site.example.au/", {
      exists: () => true,
      run: async () => {
        throw new Error("ETIMEDOUT");
      },
    });
    expect(audit).toBeNull();
  });

  test("the configured timeoutMs is actually passed through to run()", async () => {
    let seenTimeout = 0;
    await crawl4aiFetch("https://example.com.au/", {
      exists: () => true,
      timeoutMs: 12_345,
      run: async (_bin, _args, opts) => {
        seenTimeout = opts.timeoutMs;
        return { code: 0, stdout: REAL_PAGE_JSON, stderr: "" };
      },
    });
    expect(seenTimeout).toBe(12_345);
  });
});

describe("crawl4ai: concurrency cap (~2)", () => {
  test("never runs more than 2 crawls at once, even when 5 are requested together", async () => {
    let active = 0;
    let maxActive = 0;
    const run = async (): Promise<RunResult> => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active--;
      return { code: 0, stdout: REAL_PAGE_JSON, stderr: "" };
    };
    const deps = { exists: () => true, run };
    await Promise.all(Array.from({ length: 5 }, (_, i) => crawl4aiFetch(`https://example${i}.com.au/`, deps)));
    expect(maxActive).toBeLessThanOrEqual(2);
    expect(maxActive).toBeGreaterThan(0);
  });
});
