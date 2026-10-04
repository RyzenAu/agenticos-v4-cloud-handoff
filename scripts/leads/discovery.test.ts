import { describe, expect, test } from "bun:test";
import {
  duckDuckGoAnswered, looksLikeStubOrChallenge,
  candidateSlugs, discoverWebsite, discoverWebsiteDetailed, duckduckgoWebsiteSearch, extractDuckDuckGoResults,
  guessWebsite, hermesWebsiteSearch, isAggregatorOrDirectory, localityFromAddress, pageMatchesBusiness,
  searxngWebsiteSearch, SEARXNG_URL, type DiscoveredWebsite,
} from "./discovery";

describe("discovery: candidate slugs", () => {
  test("keeps the full name and a version stripped of generic industry words", () => {
    expect(candidateSlugs("St Clair Dental")).toEqual(["stclairdental", "stclair"]);
    expect(candidateSlugs("Wish Real Estate")).toEqual(["wishrealestate", "wishreal", "wish"]);
    expect(candidateSlugs("Mannah Lawyers")).toEqual(["mannahlawyers", "mannah"]);
  });

  test("also tries stripping trailing generic words one at a time — a real domain often keeps one industry word", () => {
    // Live case, 24 Sep 2026: "Marayong Dental Clinic" is marayongdental.com.au, not
    // marayong.com.au (fully stripped) or marayongdentalclinic.com.au (the full name).
    expect(candidateSlugs("Marayong Dental Clinic")).toEqual(["marayongdentalclinic", "marayongdental", "marayong"]);
  });
});

describe("discovery: page verification", () => {
  test("true only when the page mentions both a significant name word and the suburb", () => {
    const html = "<html><body><h1>St Clair Dental</h1><p>Your local dentist in St Clair, NSW.</p></body></html>";
    expect(pageMatchesBusiness(html, "St Clair Dental", "St Clair")).toBe(true);
    expect(pageMatchesBusiness(html, "St Clair Dental", "Mount Druitt")).toBe(false);
    expect(pageMatchesBusiness("<html><body>Some other clinic in Penrith.</body></html>", "St Clair Dental", "St Clair")).toBe(false);
  });
});

describe("discovery: DuckDuckGo results", () => {
  test("decodes the uddg redirect and drops directory/social results", () => {
    const html = `
      <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fstclairdental.com.au%2F&amp;rut=1">St Clair Dental</a>
      <a class="result__a" href="https://www.facebook.com/stclairdental/">Facebook</a>
      <a class="result__a" href="https://www.truelocal.com.au/business/st-clair-dental">True Local</a>
    `;
    expect(extractDuckDuckGoResults(html)).toEqual(["https://stclairdental.com.au/"]);
  });

  test("respects robots.txt (fails closed on Disallow) and never fetches the results page", async () => {
    const calls: string[] = [];
    const request = (async (url: string) => {
      calls.push(String(url));
      if (String(url).endsWith("/robots.txt")) return new Response("User-agent: *\nDisallow: /html/\n");
      return new Response("should never be reached", { status: 200 });
    }) as typeof fetch;
    const result = await duckduckgoWebsiteSearch({ name: "St Clair Dental", suburb: "St Clair", vertical: "dental" }, request);
    expect(result).toBeNull();
    expect(calls).toEqual(["https://html.duckduckgo.com/robots.txt"]);
  });

  test("skips a result on a domain that isn't plausibly theirs, even past the directory blocklist", async () => {
    // A directory page *about* a business mentions its name and suburb too, so content alone
    // can't tell a listing (cybo.com, findglocal.com, australia247.info) from the real site —
    // this is the exact false-positive the 24 Sep rescan hit for three real-estate/legal leads.
    const html = `
      <a class="result__a" href="https://www.cybo.com/AU-biz/anz-real-estate-consultants">ANZ Real Estate Consultants</a>
      <a class="result__a" href="https://australia247.info/some-listing">Directory</a>
      <a class="result__a" href="https://anzrealestateconsultants.com.au/">ANZ Real Estate Consultants — official site</a>
    `;
    const request = (async (url: string) => {
      if (String(url).endsWith("/robots.txt")) return new Response("User-agent: *\n");
      return new Response(html, { headers: { "Content-Type": "text/html" } });
    }) as typeof fetch;
    const result = await duckduckgoWebsiteSearch({ name: "ANZ Real Estate Consultants", suburb: "Blacktown", vertical: "real-estate" }, request);
    expect(result).toMatchObject({ url: "https://anzrealestateconsultants.com.au/" });
  });

  test("the hostname-match check catches an unrelated domain the blocklist doesn't name", async () => {
    const html = `
      <a class="result__a" href="https://some-unrelated-blog.example/best-agents-2026">Best Agents 2026</a>
      <a class="result__a" href="https://mariebaranco.com.au/">Marie Baran & Co</a>
    `;
    const request = (async (url: string) => {
      if (String(url).endsWith("/robots.txt")) return new Response("User-agent: *\n");
      return new Response(html, { headers: { "Content-Type": "text/html" } });
    }) as typeof fetch;
    const result = await duckduckgoWebsiteSearch({ name: "Marie Baran & Co Real Estate", suburb: "Blacktown", vertical: "real-estate" }, request);
    expect(result).toMatchObject({ url: "https://mariebaranco.com.au/" });
  });

  test("returns null when every organic result is a directory/unrelated domain", async () => {
    const html = `
      <a class="result__a" href="https://www.cybo.com/AU-biz/marie-baran-co">Marie Baran & Co</a>
      <a class="result__a" href="https://australia247.info/">Australia 247</a>
    `;
    const request = (async (url: string) => {
      if (String(url).endsWith("/robots.txt")) return new Response("User-agent: *\n");
      return new Response(html, { headers: { "Content-Type": "text/html" } });
    }) as typeof fetch;
    const result = await duckduckgoWebsiteSearch({ name: "Marie Baran & Co Real Estate", suburb: "Blacktown", vertical: "real-estate" }, request);
    expect(result).toBeNull();
  });

  test("returns the first non-directory organic result with a moderate confidence", async () => {
    const html = `<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fstclairdental.com.au%2F">St Clair Dental</a>`;
    const request = (async (url: string) => {
      if (String(url).endsWith("/robots.txt")) return new Response("User-agent: *\n");
      return new Response(html, { headers: { "Content-Type": "text/html" } });
    }) as typeof fetch;
    const result = await duckduckgoWebsiteSearch({ name: "St Clair Dental", suburb: "St Clair", vertical: "dental" }, request);
    expect(result).toMatchObject({ url: "https://stclairdental.com.au/", source: "duckduckgo" });
    expect(result!.confidence).toBeGreaterThanOrEqual(0.5);
  });
});

describe("discovery: SearXNG (self-hosted meta-search, 25 Sep 2026)", () => {
  test("returns the first hostname-matching result from its JSON API", async () => {
    const request = (async (url: string) => {
      expect(String(url)).toStartWith(SEARXNG_URL);
      expect(String(url)).toContain("format=json");
      return new Response(
        JSON.stringify({ results: [{ url: "https://www.facebook.com/stclairdental" }, { url: "https://stclairdental.com.au/" }] }),
        { headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;
    const result = await searxngWebsiteSearch({ name: "St Clair Dental", suburb: "St Clair", vertical: "dental" }, request);
    expect(result).toMatchObject({ url: "https://stclairdental.com.au/", source: "searxng" });
    expect(result!.confidence).toBeGreaterThanOrEqual(0.6);
  });

  test("rejects a directory/social result even if it's the only one, same NOT_A_WEBSITE list as DuckDuckGo", async () => {
    const body = JSON.stringify({ results: [{ url: "https://www.truelocal.com.au/business/st-clair-dental" }] });
    const request = (async () => new Response(body, { headers: { "Content-Type": "application/json" } })) as typeof fetch;
    const result = await searxngWebsiteSearch({ name: "St Clair Dental", suburb: "St Clair", vertical: "dental" }, request);
    expect(result).toBeNull();
  });

  test("returns null (never throws) when SearXNG isn't running — the caller falls back to DuckDuckGo", async () => {
    const request = (async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:18888");
    }) as typeof fetch;
    const result = await searxngWebsiteSearch({ name: "St Clair Dental", suburb: "St Clair", vertical: "dental" }, request);
    expect(result).toBeNull();
  });
});

describe("discovery: Hermes/Codex JSON search", () => {
  test("returns null when Hermes isn't configured (no key) — never a real network call", async () => {
    const request = (async () => {
      throw new Error("should not be called");
    }) as typeof fetch;
    const result = await hermesWebsiteSearch({ name: "St Clair Dental", suburb: "St Clair", vertical: "dental" }, request);
    expect(result).toBeNull();
  });
});

describe("discovery: domain guess, verified against the page", () => {
  test("accepts a guessed domain only once the page mentions the business and suburb", async () => {
    const request = (async (url: string) => {
      const href = String(url);
      if (href.endsWith("/robots.txt")) return new Response("User-agent: *\n");
      if (href === "https://stclairdental.com.au/") {
        return new Response("<html><body>St Clair Dental — your local dentist in St Clair.</body></html>", { headers: { "Content-Type": "text/html" } });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
    const result = await guessWebsite({ name: "St Clair Dental", suburb: "St Clair", vertical: "dental" }, request);
    expect(result).toMatchObject({ url: "https://stclairdental.com.au/", source: "guess", confidence: 0.4 });
  });

  test("rejects a domain that resolves but is clearly a different, unrelated business", async () => {
    const request = (async (url: string) => {
      const href = String(url);
      if (href.endsWith("/robots.txt")) return new Response("User-agent: *\n");
      return new Response("<html><body>Parking available. Nothing dental here.</body></html>", { headers: { "Content-Type": "text/html" } });
    }) as typeof fetch;
    const result = await guessWebsite({ name: "St Clair Dental", suburb: "St Clair", vertical: "dental" }, request);
    expect(result).toBeNull();
  });
});

describe("discovery: orchestration order", () => {
  // Every candidate that isn't already a verified guess gets one content-verification fetch, so
  // these tests supply a `request` whose default response matches the business — see the
  // dedicated "confidently wrong" test below for the case where it doesn't.
  const matchingPage = (name: string, suburb: string) =>
    (async () => new Response(`<html><body>${name} — ${suburb}</body></html>`, { headers: { "Content-Type": "text/html" } })) as typeof fetch;

  test("tries a domain guess, then the search step (DuckDuckGo here), then Hermes last, stopping at the first confident hit", async () => {
    // 25 Sep 2026 owner direction: cheapest/self-contained first, Hermes (shared ChatGPT Pro
    // quota) last.
    const calls: string[] = [];
    const guessSearch = async (): Promise<DiscoveredWebsite | null> => {
      calls.push("guess");
      return null;
    };
    const duckduckgoSearch = async (): Promise<DiscoveredWebsite | null> => {
      calls.push("duckduckgo");
      return { url: "https://stclairdental.com.au/", source: "duckduckgo", confidence: 0.6, checkedAt: new Date().toISOString() };
    };
    const hermesSearch = async (): Promise<DiscoveredWebsite | null> => {
      calls.push("hermes");
      return null;
    };
    const result = await discoverWebsite(
      { name: "St Clair Dental", suburb: "St Clair", vertical: "dental" },
      { hermesSearch, duckduckgoSearch, guessSearch, request: matchingPage("St Clair Dental", "St Clair") },
    );
    expect(result).toMatchObject({ url: "https://stclairdental.com.au/", source: "duckduckgo" });
    expect(calls).toEqual(["guess", "duckduckgo"]); // Hermes never runs once the search step is confident and verified
  });

  test("a low-confidence Hermes result is still returned if nothing better shows up — it's the last resort", async () => {
    const low: DiscoveredWebsite = { url: "https://wrong-guess.example/", source: "hermes", confidence: 0.2, checkedAt: new Date().toISOString() };
    const result = await discoverWebsite(
      { name: "St Clair Dental", suburb: "St Clair", vertical: "dental" },
      { hermesSearch: async () => low, duckduckgoSearch: async () => null, guessSearch: async () => null, request: matchingPage("St Clair Dental", "St Clair") },
    );
    // Hermes is the last method now, so its own (low) confidence is accepted rather than
    // discarded — the earlier design's "must clear the threshold" only applied to non-final steps.
    expect(result).toMatchObject({ url: "https://wrong-guess.example/", source: "hermes" });
  });

  test("a low-confidence non-final result (the search step) does NOT stop the chain — Hermes still gets a turn", async () => {
    const lowSearch: DiscoveredWebsite = { url: "https://maybe.example/", source: "duckduckgo", confidence: 0.2, checkedAt: new Date().toISOString() };
    const result = await discoverWebsite(
      { name: "St Clair Dental", suburb: "St Clair", vertical: "dental" },
      { guessSearch: async () => null, duckduckgoSearch: async () => lowSearch, hermesSearch: async () => null, request: matchingPage("St Clair Dental", "St Clair") },
    );
    expect(result).toBeNull(); // below threshold, not the final method — never returned
  });

  test("returns null (never throws) when every method fails outright", async () => {
    const result = await discoverWebsite(
      { name: "St Clair Dental", suburb: "St Clair", vertical: "dental" },
      {
        hermesSearch: async () => { throw new Error("boom"); },
        duckduckgoSearch: async () => { throw new Error("boom"); },
        guessSearch: async () => { throw new Error("boom"); },
      },
    );
    expect(result).toBeNull();
  });

  test("rejects a confidently-wrong hit whose page loads fine but is a different business — the wealthre.com.au bug", async () => {
    // Live 24 Sep 2026: Hermes returned "wealthre.com.au" (title "Wealth Real Estate") at 0.97
    // confidence for "ANZ Real Estate Consultants". The page loads fine (2xx) but never mentions
    // ANZ or the suburb, so it must be rejected rather than fed into scoring/drafts as their site.
    const wrongPage = (async () => new Response("<html><head><title>Wealth Real Estate</title></head><body>Sydney's boutique agency.</body></html>", { headers: { "Content-Type": "text/html" } })) as typeof fetch;
    const result = await discoverWebsite(
      { name: "ANZ Real Estate Consultants", suburb: "Blacktown", vertical: "real-estate" },
      { hermesSearch: async () => ({ url: "https://wealthre.com.au/", source: "hermes", confidence: 0.97, checkedAt: new Date().toISOString() }), duckduckgoSearch: async () => null, guessSearch: async () => null, request: wrongPage },
    );
    expect(result).toBeNull();
  });

  test("rejects a same-name, same-suburb page that's actually a different organisation entirely — the ANZ Bank branch bug", async () => {
    // Live 24 Sep 2026: "ANZ Real Estate Consultants" (Blacktown) discovered an ANZ Bank branch
    // locator page for a Blacktown branch — it genuinely mentions "ANZ" and "Blacktown", so plain
    // name+suburb matching passed it. It never reads as a real-estate business, so the vertical
    // keyword check must catch what name+suburb alone can't.
    const bankBranchPage = (async () =>
      new Response("<html><body>ANZ Blacktown branch, 65 Main Street. Opening hours, ATM, home loans.</body></html>", { headers: { "Content-Type": "text/html" } })
    ) as typeof fetch;
    const result = await discoverWebsite(
      { name: "ANZ Real Estate Consultants", suburb: "Blacktown", vertical: "real-estate" },
      {
        hermesSearch: async () => ({ url: "https://anz.banklocationmaps.com/en/branch/339393-anz-branch", source: "hermes", confidence: 0.97, checkedAt: new Date().toISOString() }),
        duckduckgoSearch: async () => null,
        guessSearch: async () => null,
        request: bankBranchPage,
      },
    );
    expect(result).toBeNull();
  });

  test("25 Sep 2026 bugfix: a candidate whose verification fetch is blocked/errors is reported unverifiable, never silently accepted", async () => {
    // Live cases this replaced a real bug: wheree.com and australianplanet.com both return a
    // Cloudflare challenge page to a plain fetch, and the old code treated "blocked" as
    // "inconclusive, keep it" — i.e. accepted the candidate as the business's confirmed website
    // without ever actually checking it.
    const blocked = (async () => new Response("Forbidden", { status: 403 })) as typeof fetch;
    const deps = {
      hermesSearch: async () => ({ url: "https://bkperiodontics.com.au/", source: "hermes" as const, confidence: 0.9, checkedAt: new Date().toISOString() }),
      duckduckgoSearch: async () => null, guessSearch: async () => null, request: blocked,
    };
    const outcome = await discoverWebsiteDetailed({ name: "Dr Beth Kang Periodontics", suburb: "Penrith", vertical: "dental" }, deps);
    expect(outcome).toMatchObject({ kind: "unverifiable", url: "https://bkperiodontics.com.au/" });
    // discoverWebsite (the thin wrapper osm.ts and older callers use) never claims a confirmed
    // website for an unverifiable candidate either — it reports the same as "none".
    expect(await discoverWebsite({ name: "Dr Beth Kang Periodontics", suburb: "Penrith", vertical: "dental" }, deps)).toBeNull();
  });
});

describe("discovery: localityFromAddress — 25 Sep 2026 bugfix", () => {
  // The bug: rescan.ts/reaudit.ts were deriving "suburb" from `lead.area`, the broad hunt-region
  // label ("Greater Sydney" for 800 of 963 leads on file) rather than the lead's own address —
  // silently failing pageMatchesBusiness's suburb check almost every time, regardless of whether
  // the candidate site was actually correct.
  test("parses the suburb and postcode out of a normal street address", () => {
    expect(localityFromAddress("162 Bennett Road, St Clair NSW 2759")).toEqual({ suburb: "St Clair", postcode: "2759" });
    expect(localityFromAddress("11-13 Chester Hill Road, Chester Hill NSW 2162")).toEqual({ suburb: "Chester Hill", postcode: "2162" });
  });

  test("falls back to a bare postcode when OSM only tagged that, not a suburb name", () => {
    expect(localityFromAddress("8 Shaw Street, 2207")).toEqual({ suburb: "", postcode: "2207" });
  });

  test("returns empty rather than the region label for a street-only or blank address", () => {
    expect(localityFromAddress("Bourke Street")).toEqual({ suburb: "", postcode: "" });
    expect(localityFromAddress("")).toEqual({ suburb: "", postcode: "" });
  });

  test("never returns the broad region label some callers used to pass in by mistake", () => {
    expect(localityFromAddress("Greater Sydney").suburb).not.toBe("Greater Sydney");
  });
});

describe("discovery: pageMatchesBusiness falls back to postcode/phone/street when suburb is unknown", () => {
  const html = "<html><body>Dentist On Bourke — 123 Bourke Street. Call (02) 9319 7309. Cosmetic and family dentistry.</body></html>";

  test("matches via street when no suburb/postcode is known (lead #163's real data: address is just \"Bourke Street\")", () => {
    expect(pageMatchesBusiness(html, "Dentist On Bourke", "", "dental", { address: "Bourke Street" })).toBe(true);
  });

  test("matches via phone when no suburb/postcode/street is known", () => {
    expect(pageMatchesBusiness(html, "Dentist On Bourke", "", "dental", { phone: "+61 2 9319 7309" })).toBe(true);
  });

  test("rejects when a postcode IS known but doesn't appear on the page — no longer a free pass", () => {
    expect(pageMatchesBusiness(html, "Dentist On Bourke", "", "dental", { postcode: "2000" })).toBe(false);
  });

  test("falls back to name+vertical only when literally nothing else is known (lead #173: blank address, blank phone)", () => {
    const noGaps = "<html><body>No Gaps Dental — your local family dentist.</body></html>";
    expect(pageMatchesBusiness(noGaps, "No Gaps Dental", "", "dental")).toBe(true);
  });
});

describe("discovery: isAggregatorOrDirectory — 25 Sep 2026 bugfix", () => {
  // Live cases from the site re-audit: these three all got waved through as "their own site"
  // under the old verifyCandidate, purely because they were bot-walled/loaded content that
  // happened to mention the business — not because anyone confirmed they were the business's own
  // domain rather than a third-party directory or franchise micro-site host.
  test("rejects known franchise micro-site and directory-aggregator hosts outright", () => {
    expect(isAggregatorOrDirectory("https://no-gaps-dental-epping.wheree.com/", "No Gaps Dental")).toBe(true);
    expect(isAggregatorOrDirectory("https://www.australianplanet.com/ian-dinnerville-real-estate-hornsby-area-hornsby-nsw-F1B0AC30E13", "Ian Dinnerville Real Estate")).toBe(true);
    expect(isAggregatorOrDirectory("https://legallink.info/en/lawfirms/all-ashfield-legal", "All Ashfield Legal")).toBe(true);
  });

  test("does not reject a business's own matching domain", () => {
    expect(isAggregatorOrDirectory("https://www.nogapsdental.com/", "No Gaps Dental")).toBe(false);
    expect(isAggregatorOrDirectory("https://dentistonbourke.com.au/contact/", "Dentist On Bourke")).toBe(false);
  });
});

describe("discovery: regression fixtures — leads #163, #173, #512, #933 (no network)", () => {
  const noOtherMethods = { duckduckgoSearch: async () => null, guessSearch: async () => null, hermesSearch: async () => null };

  test("#163 Dentist On Bourke — phone-finder hint is confirmed via street-name corroboration (no suburb on file)", async () => {
    const html = "<html><body>Dentist On Bourke, 123 Bourke Street. General and cosmetic dental care.</body></html>";
    const request = (async () => new Response(html, { headers: { "Content-Type": "text/html" } })) as typeof fetch;
    const outcome = await discoverWebsiteDetailed(
      { name: "Dentist On Bourke", suburb: "", vertical: "dental", phone: "+61 2 9319 7309", address: "Bourke Street" },
      { ...noOtherMethods, request, hints: ["https://dentistonbourke.com.au/contact/"] },
    );
    expect(outcome).toMatchObject({ kind: "found", site: { url: "https://dentistonbourke.com.au/contact/", source: "phone_finder" } });
  });

  test("#173 No Gaps Dental — confirmed on name+vertical alone (blank address AND blank phone — nothing else to corroborate with)", async () => {
    const html = "<html><body>No Gaps Dental — your local family dentist, no gap payments.</body></html>";
    const request = (async () => new Response(html, { headers: { "Content-Type": "text/html" } })) as typeof fetch;
    const outcome = await discoverWebsiteDetailed(
      { name: "No Gaps Dental", suburb: "", vertical: "dental", phone: "", address: "" },
      { ...noOtherMethods, request, hints: ["https://www.nogapsdental.com/"] },
    );
    expect(outcome).toMatchObject({ kind: "found", site: { url: "https://www.nogapsdental.com/" } });
  });

  test("#512 All Ashfield Legal — a legallink.info hint is rejected as a directory, never accepted as their own site", async () => {
    const request = (async () => new Response("should never be fetched", { status: 200 })) as typeof fetch;
    const outcome = await discoverWebsiteDetailed(
      { name: "All Ashfield Legal", suburb: "", vertical: "legal", phone: "+61 2 8328 0247", address: "" },
      { ...noOtherMethods, request, hints: ["https://legallink.info/en/lawfirms/all-ashfield-legal"] },
    );
    expect(outcome).toEqual({ kind: "none" });
  });

  test("#933 Ian Dinnerville Real Estate — an australianplanet.com hint is rejected as a directory, never accepted as their own site", async () => {
    const request = (async () => new Response("should never be fetched", { status: 200 })) as typeof fetch;
    const outcome = await discoverWebsiteDetailed(
      {
        name: "Ian Dinnerville Real Estate", suburb: "Hornsby", postcode: "2077", vertical: "real-estate",
        phone: "+61 2 9476 2277", address: "270 Pacific Highway, Hornsby NSW 2077",
      },
      { ...noOtherMethods, request, hints: ["https://www.australianplanet.com/ian-dinnerville-real-estate-hornsby-area-hornsby-nsw-F1B0AC30E13"] },
    );
    expect(outcome).toEqual({ kind: "none" });
  });
});

// 25 Sep 2026, second bugfix — the wide "--all-website" sweep's own precision check (hand-checked
// ~15 leads, came in well under 90%) found these specific failures. Fixtures below pin each one.
describe("discovery: candidate slugs also try vertical synonyms — recall fix for #347", () => {
  test("combines the name's stripped core with each dental/legal/real-estate synonym", () => {
    // Live case: "Haberfield Dental Practice" is haberfielddentists.com.au — the guess cascade
    // never tried "dentists" before, only the name's own wording ("dental"/"practice").
    expect(candidateSlugs("Haberfield Dental Practice", "dental")).toContain("haberfielddentists");
    expect(candidateSlugs("Haberfield Dental Practice", "dental")).toContain("haberfielddentist");
    expect(candidateSlugs("Mannah Lawyers", "legal")).toContain("mannahsolicitors");
    expect(candidateSlugs("Wish Real Estate", "real-estate")).toContain("wishrealty");
  });

  test("no vertical passed keeps the exact old behaviour (no synonym slugs)", () => {
    expect(candidateSlugs("St Clair Dental")).toEqual(["stclairdental", "stclair"]);
  });
});

describe("discovery: pageMatchesBusiness requires a majority of name words, not just one — bugfix for #680", () => {
  test("#680 Best Real Estate: bestweb.com only matches 'best', not 'real'/'estate' — rejected", () => {
    // Real content fetched 25 Sep 2026: an unrelated domain-investment portfolio site that happens
    // to contain both "best" (its own brand) and "listing" (its own vertical-keyword false
    // positive) — the old code accepted this on the single word "best" alone.
    const html = "<html><body>BestWeb | Premium Digital Asset Investment. Since 1998, BestWeb owns a curated portfolio listing of rare domains.</body></html>";
    expect(pageMatchesBusiness(html, "Best Real Estate", "", "real-estate")).toBe(false);
  });

  test("a 2-of-3 or better match still passes (no regression for a normal multi-word name)", () => {
    const html = "<html><body>Cronulla Real Estate — your local Cronulla real estate agent.</body></html>";
    expect(pageMatchesBusiness(html, "Cronulla Real Estate", "Cronulla", "real-estate")).toBe(true);
  });
});

describe("discovery: pageMatchesBusiness rejects a page for a plainly different business — #310", () => {
  test("#310 'Dentistry': a stale/reassigned domain now serving a different, unrelated practice", () => {
    // Live case: dentistry.net.au/team now 404s, and the domain's own 404 page identifies as
    // "Spit Road Dental" — a different business entirely, not a rewording of "Dentistry".
    const html = "<html><head><title>Page not found | Spit Road Dental</title></head><body>Sorry, we couldn't find that page. Spit Road Dental, Mosman.</body></html>";
    expect(pageMatchesBusiness(html, "Dentistry", "", "dental")).toBe(false);
  });
});

describe("discovery: isAggregatorOrDirectory catches an association/finder domain — bugfix for #264", () => {
  test("#264 Orthodontics Sydney Wide: an industry association's per-practice finder page", () => {
    // Live case: the old host-overlap bypass was fooled because "orthodontics" coincidentally
    // appears in both the business's own descriptive name and the association's domain.
    expect(isAggregatorOrDirectory(
      "https://finder.orthodonticsaustralia.org.au/practice/Orthodontics_Sydney_Wide_-_Parramatta+319",
      "Orthodontics Sydney Wide",
    )).toBe(true);
  });

  test("a generic '/find-a-...' or '/finder/' path is a directory shape regardless of host", () => {
    expect(isAggregatorOrDirectory("https://example.com/find-a-dentist/some-clinic", "Some Clinic")).toBe(true);
    expect(isAggregatorOrDirectory("https://example.com/finder/some-clinic", "Some Clinic")).toBe(true);
  });
});

describe("discovery: franchise brands with no suburb on file can't be disambiguated — bugfix for #622, #770", () => {
  const noOtherMethods = { duckduckgoSearch: async () => null, guessSearch: async () => null, hermesSearch: async () => null };
  const shouldNeverFetch = (async () => new Response("should never be fetched", { status: 200 })) as typeof fetch;

  test("#622 Stone Real Estate: address has only a postcode, no suburb name — audit_pending, not a name-only match", async () => {
    const outcome = await discoverWebsiteDetailed(
      { name: "Stone Real Estate", suburb: "", postcode: "2070", vertical: "real-estate", phone: "", address: "Pacific Highway, 2070" },
      { ...noOtherMethods, request: shouldNeverFetch, hints: ["https://www.stonerealestate.com.au/about-us/"] },
    );
    expect(outcome).toMatchObject({ kind: "unverifiable", url: "" });
    expect((outcome as { reason?: string }).reason).toMatch(/franchise/i);
  });

  test("#770 First National: no address at all — audit_pending, never the generic corporate homepage", async () => {
    const outcome = await discoverWebsiteDetailed(
      { name: "First National", suburb: "", vertical: "real-estate", phone: "", address: "" },
      { ...noOtherMethods, request: shouldNeverFetch },
    );
    expect(outcome).toEqual({ kind: "unverifiable", url: "", checkedAt: expect.any(String), reason: expect.stringMatching(/franchise/i) });
  });

  test("a franchise brand WITH a real suburb on file is still verified normally (no regression for #808 Laing+Simmons Campsie)", async () => {
    const html = "<html><body>Real Estate Agents & Property Managers Laing+Simmons Campsie — 323 Beamish Street, Campsie.</body></html>";
    const request = (async () => new Response(html, { headers: { "Content-Type": "text/html" } })) as typeof fetch;
    const outcome = await discoverWebsiteDetailed(
      { name: "Laing Simmons Campsie", suburb: "Campsie", vertical: "real-estate", phone: "", address: "323 Beamish Street, Campsie NSW 2194" },
      { ...noOtherMethods, request, hints: ["https://lsre.com.au/campsie/"] },
    );
    expect(outcome).toMatchObject({ kind: "found", site: { url: "https://lsre.com.au/campsie/" } });
  });

  test("a name that merely contains a franchise word as part of another word isn't flagged (word-boundary check)", async () => {
    const html = "<html><body>Stonebridge Realty — your local Blacktown agent.</body></html>";
    const request = (async () => new Response(html, { headers: { "Content-Type": "text/html" } })) as typeof fetch;
    // No phone/address on file either — "nothing to corroborate with" is a separate, pre-existing
    // fallback (name+vertical alone); the point here is only that "stonebridge" doesn't trip the
    // franchise short-circuit the way "stone" would.
    const outcome = await discoverWebsiteDetailed(
      { name: "Stonebridge Realty", suburb: "", vertical: "real-estate", phone: "", address: "" },
      { ...noOtherMethods, request, hints: ["https://stonebridgerealty.com.au/"] },
    );
    expect(outcome).toMatchObject({ kind: "found" });
  });
});

describe("discovery: regression fixtures — leads #680, #264, #310, #622, #770, #347 end to end (no network)", () => {
  const noOtherMethods = { duckduckgoSearch: async () => null, hermesSearch: async () => null };

  test("#347 Haberfield Dental Practice — guess cascade finds it via the 'dentists' synonym, no hint needed", async () => {
    const html = "<html><head><title>Contact Us | Haberfield Dental Practice</title></head><body>Haberfield Dental Practice, 102 Ramsay Street, Haberfield.</body></html>";
    const request = (async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith("/robots.txt")) return new Response("User-agent: *\n");
      if (url === "https://haberfielddentists.com.au/") return new Response(html, { headers: { "Content-Type": "text/html" } });
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
    const outcome = await discoverWebsiteDetailed(
      { name: "Haberfield Dental Practice", suburb: "Haberfield", vertical: "dental", phone: "", address: "102 Ramsay Street, Haberfield NSW 2045" },
      { ...noOtherMethods, request },
    );
    expect(outcome).toMatchObject({ kind: "found", site: { url: "https://haberfielddentists.com.au/", source: "guess" } });
  });
});

describe("search-backend health (25 Sep 2026 false 'no website' fix)", () => {
  test("DuckDuckGo's bot CAPTCHA page is not an answer", () => {
    expect(duckDuckGoAnswered("<p>Unfortunately, bots use DuckDuckGo too.</p><form id=\"challenge-form\"></form>")).toBe(false);
    expect(duckDuckGoAnswered('<a class="result__a" href="https://x.com.au/">X</a>')).toBe(true);
    expect(duckDuckGoAnswered('<div class="no-results">No results found</div>')).toBe(true);
  });

  test("when no search backend answers, an empty cascade is unverifiable, not 'none'", async () => {
    const down = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    const outcome = await discoverWebsiteDetailed(
      { name: "Haberfield Dental Practice", suburb: "Haberfield", vertical: "dental" } as any,
      { request: down, guessSearch: async () => null },
    );
    expect(outcome.kind).toBe("unverifiable");
  });
});

describe("stub/challenge pages are unverifiable, not a rejection", () => {
  test("a 535-byte JS stub is a stub", () => {
    expect(looksLikeStubOrChallenge("<html><head><script>location.reload()</script></head><body></body></html>")).toBe(true);
  });
  test("a real page is not a stub", () => {
    expect(looksLikeStubOrChallenge(`<html><body><h1>Haberfield Dental Practice</h1><p>${"Family dentistry in Haberfield since 1922. ".repeat(10)}</p></body></html>`)).toBe(false);
  });
});
