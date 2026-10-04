// Fixed regression fixtures for scripts/leads/discovery.ts, protecting the real lead-classification
// failure cases found on 25-26 Sep 2026 (see scripts/leads/evals/README.md). Every test here is
// offline: no network calls, everything the code would fetch is served from a recorded fixture in
// ./fixtures via an injected `fetch`. Run with: bun test scripts/leads/evals
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discoverWebsiteDetailed, duckDuckGoAnswered, isAggregatorOrDirectory, looksLikeStubOrChallenge,
  NOT_A_WEBSITE, pageMatchesBusiness, SEARXNG_URL,
} from "../discovery";

const FIXTURES = join(import.meta.dir, "fixtures");
function fixture(name: string): string {
  return readFileSync(join(FIXTURES, name), "utf8");
}

/** Every search backend, every domain guess, and every page fetch failing/rejecting by default —
 *  a test overrides only the specific route(s) its case needs, and never falls through to the
 *  real network (`request` in DiscoveryDeps replaces global fetch everywhere in the cascade). */
function fakeFetch(routes: Record<string, string | { status: number; body?: string } | Error>) {
  return (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    for (const [pattern, hit] of Object.entries(routes)) {
      if (!url.includes(pattern)) continue;
      if (hit instanceof Error) throw hit;
      if (typeof hit === "string") {
        const r = new Response(hit, { status: 200, headers: { "Content-Type": "text/html" } });
        Object.defineProperty(r, "url", { value: url });
        return r;
      }
      const r = new Response(hit.body ?? "", { status: hit.status });
      Object.defineProperty(r, "url", { value: url });
      return r;
    }
    if (url.endsWith("/robots.txt")) return new Response("User-agent: *\n", { status: 200 });
    return new Response("not found", { status: 404 }); // every unlisted domain guess/fetch: a clean miss, not a network error
  }) as typeof fetch;
}

// A no-op hermesSearch: most tests below override it explicitly so a run never touches the real
// warm-Hermes gateway or reads %LOCALAPPDATA%\hermes\.env (hard rule: never read .env values).
const noHermes = async () => null;

describe("eval: SearXNG down + DuckDuckGo bot wall never reads as a confirmed absence", () => {
  test("both search backends failing to answer -> unverifiable, never 'none'", async () => {
    const request = fakeFetch({
      [SEARXNG_URL]: new Error("ECONNREFUSED"), // SearXNG not running
      "html.duckduckgo.com/html": fixture("duckduckgo-captcha.html"), // DuckDuckGo's bot challenge page
    });
    // This case needs the real hermesWebsiteSearch (not an override) so discoverWebsiteDetailed's
    // "did any built-in backend actually answer" telemetry sees all three real methods and takes
    // the "no backend answered" branch — but never reading a real Hermes credential: HERMES_HOME
    // is pointed at a scratch directory with no .env in it, so hermesApiKey() reads nothing and
    // returns "" (the same as an unconfigured machine), and hermesWebsiteSearch short-circuits to
    // null without ever calling `request`.
    const previousHermesHome = process.env.HERMES_HOME;
    process.env.HERMES_HOME = join(tmpdir(), "agenticos-eval-no-hermes-configured");
    let outcome;
    try {
      outcome = await discoverWebsiteDetailed(
        { name: "Example Dental Group", suburb: "Blacktown", vertical: "dental" },
        { request },
      );
    } finally {
      if (previousHermesHome === undefined) delete process.env.HERMES_HOME;
      else process.env.HERMES_HOME = previousHermesHome;
    }
    expect(outcome.kind).toBe("unverifiable");
    if (outcome.kind === "unverifiable") expect(outcome.reason).toMatch(/no web search backend answered/i);
  });

  test("duckDuckGoAnswered is false for the bot-wall page, not merely 'no results'", () => {
    expect(duckDuckGoAnswered(fixture("duckduckgo-captcha.html"))).toBe(false);
    expect(duckDuckGoAnswered('<a class="result__a" href="https://x.com.au/">X</a>')).toBe(true);
    expect(duckDuckGoAnswered("<div>No results found.</div>")).toBe(true); // a genuine zero-result answer IS an answer
  });
});

describe("eval: a real site behind a 202 JS stub is unverifiable, not rejected", () => {
  test("beyond32dental.com.au answering 202 with a tiny JS shell -> unverifiable", async () => {
    const stub = fixture("beyond32dental-stub.html");
    expect(stub.length).toBeLessThan(600); // recorded size, ~535 bytes
    const request = fakeFetch({
      "beyond32dental.com.au": { status: 202, body: stub },
    });
    const outcome = await discoverWebsiteDetailed(
      { name: "Beyond 32 Dental", suburb: "Blacktown", vertical: "dental" },
      {
        request, hermesSearch: noHermes,
        guessSearch: async () => null,
        searxngSearch: async () => null,
        hints: ["https://beyond32dental.com.au/"], // e.g. phone-finder already turned this candidate up
      },
    );
    expect(outcome.kind).toBe("unverifiable");
    if (outcome.kind === "unverifiable") expect(outcome.url).toContain("beyond32dental.com.au");
  });
});

describe("eval: SearXNG's top hit, when it genuinely is the business's site, is accepted", () => {
  test("haberfielddentists.com.au for 'Haberfield Dental Practice' -> found", async () => {
    const request = fakeFetch({
      [`${SEARXNG_URL}/search`]: { status: 200, body: JSON.stringify({ results: [{ url: "https://haberfielddentists.com.au/" }] }) },
      "haberfielddentists.com.au": fixture("haberfield-dental.html"),
    });
    const outcome = await discoverWebsiteDetailed(
      { name: "Haberfield Dental Practice", suburb: "Haberfield", vertical: "dental" },
      // guessSearch stubbed out so this case isolates the SearXNG path specifically — a domain
      // guess landing on the same real site first is a different (also covered) success path.
      { request, hermesSearch: noHermes, guessSearch: async () => null },
    );
    expect(outcome.kind).toBe("found");
    if (outcome.kind === "found") {
      expect(outcome.site.url).toContain("haberfielddentists.com.au");
      expect(outcome.site.source).toBe("searxng");
    }
  });
});

describe("eval: a lead with no address/suburb on file is never confirmed as having no website", () => {
  test("no suburb, no postcode, no phone, no address, every method empty -> 'none' from discovery,", async () => {
    // discoverWebsiteDetailed itself is allowed to conclude "none" once every method genuinely
    // came back empty — the guard this protects is downstream (issues.ts's scoreIssues): "none"
    // must still only ever become an audit_pending pitch, never a confirmed no-website pitch sent
    // to a call script. See issues.eval.test.ts for that half of the guarantee.
    const request = fakeFetch({});
    const outcome = await discoverWebsiteDetailed(
      { name: "Maven Dental Group", suburb: "", vertical: "dental" },
      {
        request, hermesSearch: noHermes,
        duckduckgoSearch: async () => null, // no suburb to search with -> nothing found
        searxngSearch: async () => null,
        guessSearch: async () => null,
      },
    );
    expect(outcome.kind).toBe("none");
  });

  test("missing suburb still lets a real match through — the check isn't blocked outright by an empty suburb", async () => {
    const html = `<!doctype html><html><body><h1>Maven Dental Group</h1><p>Your family dentist. Call for an appointment.</p></body></html>`;
    const request = fakeFetch({ "mavendentalgroup.com.au": { status: 200, body: html } });
    const outcome = await discoverWebsiteDetailed(
      { name: "Maven Dental Group", suburb: "", vertical: "dental" },
      { request, hermesSearch: noHermes, duckduckgoSearch: async () => null, searxngSearch: async () => null },
    );
    expect(outcome.kind).toBe("found");
  });
});

describe("eval: an overseas namesake is rejected, not accepted on a shared suburb name", () => {
  test("beverlyhillsdentalclinic.com (Beverly Hills, CA) for 'Beverly Hills Dental' (Beverly Hills NSW 2209)", async () => {
    const html = fixture("beverly-hills-us.html");
    // The suburb name alone ("beverly hills") is on the page — the postcode isn't, and that's
    // what must sink it now (26 Sep 2026 fix to pageMatchesBusiness).
    expect(pageMatchesBusiness(html, "Beverly Hills Dental", "Beverly Hills", "dental", { postcode: "2209" })).toBe(false);

    const request = fakeFetch({ "beverlyhillsdentalclinic.com": { status: 200, body: html } });
    const outcome = await discoverWebsiteDetailed(
      { name: "Beverly Hills Dental", suburb: "Beverly Hills", postcode: "2209", vertical: "dental" },
      {
        request, hermesSearch: noHermes,
        guessSearch: async () => null,
        searxngSearch: async () => null,
        hints: ["https://beverlyhillsdentalclinic.com/"],
      },
    );
    expect(outcome.kind).not.toBe("found");
  });

  test("the same suburb+postcode both present on the real AU page still matches", () => {
    const html = `<html><body><h1>Beverly Hills Dental</h1><p>Your local dentist in Beverly Hills NSW 2209.</p></body></html>`;
    expect(pageMatchesBusiness(html, "Beverly Hills Dental", "Beverly Hills", "dental", { postcode: "2209" })).toBe(true);
  });
});

describe("eval: directory/aggregator hosts are never accepted as the business's own site", () => {
  const HOSTS = [
    "healthengine.com.au", "healthdirect.com.au", "findglocal.com", "dentist.com.au", "localdentists.au", "wheree.com",
  ];

  test("every host is in NOT_A_WEBSITE (filtered out of search results before any content check)", () => {
    for (const host of HOSTS) expect(NOT_A_WEBSITE.test(host)).toBe(true);
  });

  test("every host is treated as an aggregator/directory even for a hint/Hermes candidate (isAggregatorOrDirectory)", () => {
    for (const host of HOSTS) {
      expect(isAggregatorOrDirectory(`https://${host}/practice/example-dental-group`, "Example Dental Group")).toBe(true);
    }
  });

  test("a directory hit end-to-end via discoverWebsiteDetailed's hint path -> rejected, not found", async () => {
    const html = `<html><body><h1>Example Dental Group</h1><p>Book online. Blacktown NSW.</p></body></html>`;
    for (const host of HOSTS) {
      const request = fakeFetch({ [host]: { status: 200, body: html } });
      const outcome = await discoverWebsiteDetailed(
        { name: "Example Dental Group", suburb: "Blacktown", vertical: "dental" },
        {
          request, hermesSearch: noHermes, guessSearch: async () => null, searxngSearch: async () => null,
          hints: [`https://${host}/practice/example-dental-group`],
        },
      );
      expect(outcome.kind).not.toBe("found");
    }
  });
});

describe("eval: looksLikeStubOrChallenge catches the recorded 202 stub", () => {
  test("the beyond32dental stub reads as too thin to judge", () => {
    expect(looksLikeStubOrChallenge(fixture("beyond32dental-stub.html"))).toBe(true);
  });
  test("the haberfield real page does not", () => {
    expect(looksLikeStubOrChallenge(fixture("haberfield-dental.html"))).toBe(false);
  });
});
