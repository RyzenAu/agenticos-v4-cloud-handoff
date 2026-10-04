import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifySearxngBody, isSearchUnavailable, SearchUnavailable, searxngQuery, unavailableSentence } from "./searxng";
import { searxngSearch } from "../computers/research-wiring";
import { runResearch, type ResearchIO } from "../computers/research";
import { discoverWebsiteDetailed, SEARXNG_URL } from "../leads/discovery";
import { searxngResults, SEARCH_ENGINES } from "../leads/phone-finder";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const refused = (names: string[]) => names.map((n) => [n, "too many requests"]);

describe("search client: unavailable is never no results", () => {
  test("classification: hits, a genuine empty answer, and every kind of outage", () => {
    expect(classifySearxngBody({ results: [{ url: "https://a.example/", title: "A", content: "x" }], unresponsive_engines: [] }).status).toBe("results");
    expect(classifySearxngBody({ results: [], unresponsive_engines: [] }).status).toBe("no_results");
    // zero hits and ANY engine refusing is an outage: nothing proves another engine really answered
    expect(classifySearxngBody({ results: [], unresponsive_engines: refused(["brave"]) }, 3)).toMatchObject({ status: "unavailable", kind: "engines_refused" });
    // an instance with ONE engine, and with TWO engines (the old fixed threshold of three missed these)
    expect(classifySearxngBody({ results: [], unresponsive_engines: refused(["duckduckgo"]) })).toMatchObject({ status: "unavailable" });
    expect(classifySearxngBody({ results: [], unresponsive_engines: refused(["duckduckgo", "brave"]) })).toMatchObject({ status: "unavailable" });
    // a named engine that is disabled never appears in the list; the one that is present and refused still decides
    expect(classifySearxngBody({ results: [], unresponsive_engines: refused(["brave"]) }, 2)).toMatchObject({ status: "unavailable" });
    // hits win even when an engine refused
    expect(classifySearxngBody({ results: [{ url: "https://a.example/", title: "A", content: "" }], unresponsive_engines: refused(["brave"]) }).status).toBe("results");
    // not a results page at all
    expect(classifySearxngBody(null)).toMatchObject({ status: "unavailable", kind: "bad_json" });
    expect(classifySearxngBody({} as never)).toMatchObject({ status: "unavailable", kind: "bad_json" });
  });

  test("connection refused, a timeout, an HTTP error and a non-JSON body are all 'unavailable' with a reason", async () => {
    const down = await searxngQuery("q", { request: (async () => { throw new TypeError("connect ECONNREFUSED"); }) as unknown as typeof fetch });
    expect(down).toMatchObject({ status: "unavailable", kind: "down" });
    const slow = await searxngQuery("q", { timeoutMs: 20, request: ((_u: string, init: RequestInit) => new Promise((_r, rej) => init.signal!.addEventListener("abort", () => rej(init.signal!.reason)))) as unknown as typeof fetch });
    expect(slow).toMatchObject({ status: "unavailable", kind: "timeout" });
    expect(await searxngQuery("q", { request: (async () => new Response("boom", { status: 502 })) as unknown as typeof fetch })).toMatchObject({ status: "unavailable", kind: "http", reason: "SearXNG answered HTTP 502" });
    expect(await searxngQuery("q", { request: (async () => new Response("<html>login</html>")) as unknown as typeof fetch })).toMatchObject({ status: "unavailable", kind: "bad_json" });
  });

  test("a caller's own abort (a stopped job) stays an abort, not an outage", async () => {
    const stop = new AbortController();
    const promise = searxngQuery("q", { signal: stop.signal, request: ((_u: string, init: RequestInit) => new Promise((_r, rej) => init.signal!.addEventListener("abort", () => rej(init.signal!.reason)))) as unknown as typeof fetch });
    stop.abort(new Error("stopped"));
    await expect(promise).rejects.toThrow("stopped");
  });

  test("the sentence people read never says 'no results'", () => {
    const text = unavailableSentence("SearXNG is not running or not reachable");
    expect(text).toContain("unavailable");
    expect(text).toContain("could not look");
    expect(text).not.toMatch(/no results found/i);
    expect(isSearchUnavailable(new SearchUnavailable("x"))).toBe(true);
    expect(isSearchUnavailable(Object.assign(new Error("x"), { name: "SearchUnavailable" }))).toBe(true);
    expect(isSearchUnavailable(new Error("x"))).toBe(false);
  });
});

describe("research: search down ends as 'could not search', search empty ends as 'found nothing'", () => {
  const ioWith = (search: ResearchIO["search"]): { io: ResearchIO; steps: string[] } => {
    const steps: string[] = [];
    return {
      steps,
      io: {
        signal: new AbortController().signal,
        call: async () => ({ kind: "failed", said: "no page should be opened" }),
        step: (s) => void steps.push(`${s.outcome}|${s.intent}`),
        boundary: async () => "go",
        search,
        ask: null,
        delegate: null,
        deliver: async () => ({ delivered: true, where: "test" }),
      },
    };
  };

  test("search throwing SearchUnavailable: one honest failed result, flagged, no more queries, nothing opened", async () => {
    let searches = 0;
    const t = ioWith(async () => {
      searches++;
      throw new SearchUnavailable("SearXNG is not running or not reachable", "down");
    });
    const r = await runResearch({ goal: "find the official NSW Fair Trading page on home building licences", io: t.io });
    expect(r.outcome).toBe("failed");
    expect(r.searchUnavailable).toBe(true);
    expect(r.note).toContain("Web search is unavailable");
    expect(r.note).toContain("not the same as finding nothing");
    expect(r.note).not.toMatch(/found nothing usable/);
    expect(searches).toBe(1); // it did not keep hammering a dead search
    expect(r.metrics.pagesOpened).toBe(0);
    expect(t.steps.some((s) => s.startsWith("failed|") && s.includes("search is unavailable"))).toBe(true);
  });

  test("search answering with zero results: 'nothing usable', not flagged as unavailable", async () => {
    const t = ioWith(async () => []);
    const r = await runResearch({ goal: "find the official NSW Fair Trading page on home building licences", io: t.io });
    expect(r.outcome).toBe("failed");
    expect(r.searchUnavailable).toBeUndefined();
    expect(r.note).not.toContain("unavailable");
  });

  test("the hub's search function turns SearXNG states into [] (empty answer) or a thrown SearchUnavailable", async () => {
    const down = searxngSearch({ request: (async () => { throw new TypeError("ECONNREFUSED"); }) as unknown as typeof fetch });
    await expect(down("licences", new AbortController().signal)).rejects.toMatchObject({ name: "SearchUnavailable", kind: "down" });
    const empty = searxngSearch({ request: (async () => json({ results: [], unresponsive_engines: [] })) as unknown as typeof fetch });
    expect(await empty("licences", new AbortController().signal)).toEqual([]);
    const refusedAll = searxngSearch({ request: (async () => json({ results: [], unresponsive_engines: refused(["a", "b", "c"]) })) as unknown as typeof fetch });
    await expect(refusedAll("licences", new AbortController().signal)).rejects.toMatchObject({ kind: "engines_refused" });
  });
});

describe("lead discovery and the phone finder: the same three answers", () => {
  const request = (routes: { searxng: () => Response | Promise<Response>; ddg: string }) =>
    (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.startsWith(SEARXNG_URL)) return routes.searxng();
      if (url.includes("html.duckduckgo.com")) return new Response(routes.ddg, { status: 200, headers: { "Content-Type": "text/html" } });
      if (url.endsWith("/robots.txt")) return new Response("User-agent: *\n");
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

  async function discover(req: typeof fetch) {
    const previous = process.env.HERMES_HOME;
    process.env.HERMES_HOME = join(tmpdir(), "agenticos-r6-no-hermes-configured"); // no credentials are read: nothing is there
    try {
      return await discoverWebsiteDetailed({ name: "Zzyzx Example Dental", suburb: "Blacktown", vertical: "dental" }, { request: req });
    } finally {
      if (previous === undefined) delete process.env.HERMES_HOME;
      else process.env.HERMES_HOME = previous;
    }
  }

  test("SearXNG down and DuckDuckGo walled: 'could not search' with the reason, never 'no website'", async () => {
    const outcome = await discover(request({ searxng: () => { throw new TypeError("ECONNREFUSED"); }, ddg: "<html>bots use DuckDuckGo too</html>" }));
    expect(outcome.kind).toBe("unverifiable");
    if (outcome.kind === "unverifiable") {
      expect(outcome.reason).toContain("SearXNG: SearXNG is not running or not reachable");
      expect(outcome.reason).toContain("not \"no website\"");
    }
  });

  test("SearXNG up but every engine refusing is also 'could not search'", async () => {
    const outcome = await discover(request({ searxng: () => json({ results: [], unresponsive_engines: refused(["google", "brave", "duckduckgo"]) }), ddg: "<html>bots use DuckDuckGo too</html>" }));
    expect(outcome.kind).toBe("unverifiable");
  });

  test("a one-engine or two-engine instance that refuses is 'could not search', never a verified 'none'", async () => {
    for (const engines of [["duckduckgo"], ["duckduckgo", "brave"]]) {
      const outcome = await discover(request({ searxng: () => json({ results: [], unresponsive_engines: refused(engines) }), ddg: "<html>bots use DuckDuckGo too</html>" }));
      expect(outcome.kind).toBe("unverifiable");
    }
  });

  test("SearXNG answering with a genuine empty page: a confirmed 'none'", async () => {
    const outcome = await discover(request({ searxng: () => json({ results: [], unresponsive_engines: [] }), ddg: "<div>No results found.</div>" }));
    expect(outcome.kind).toBe("none");
  });

  test("three distinct outcomes through discovery: search unavailable, verified no website, and a found site whose check failed", async () => {
    const down = await discover(request({ searxng: () => { throw new TypeError("ECONNREFUSED"); }, ddg: "<html>bots use DuckDuckGo too</html>" }));
    const none = await discover(request({ searxng: () => json({ results: [], unresponsive_engines: [] }), ddg: "<div>No results found.</div>" }));
    // a candidate exists (a hint) but every attempt to check it fails: unknown, with the URL, and NOT blamed on search
    const failedCheck = await (async () => {
      const previous = process.env.HERMES_HOME;
      process.env.HERMES_HOME = join(tmpdir(), "agenticos-r6-no-hermes-configured");
      try {
        const req = (async (input: string | URL | Request) => (String(input).includes("zzyzx-example.com.au") ? new Response("<script>x</script>", { status: 202 }) : request({ searxng: () => json({ results: [] }), ddg: "<div>No results found.</div>" })(input))) as unknown as typeof fetch;
        return await discoverWebsiteDetailed({ name: "Zzyzx Example Dental", suburb: "Blacktown", vertical: "dental" }, { request: req, hints: ["https://zzyzx-example.com.au/"] });
      } finally {
        if (previous === undefined) delete process.env.HERMES_HOME;
        else process.env.HERMES_HOME = previous;
      }
    })();
    expect(down).toMatchObject({ kind: "unverifiable", url: "" });
    expect((down as { reason?: string }).reason).toContain("Search was unavailable");
    expect(none).toEqual({ kind: "none" });
    expect(failedCheck.kind).toBe("unverifiable");
    expect((failedCheck as { url: string }).url).toContain("zzyzx-example.com.au");
    expect((failedCheck as { reason?: string }).reason ?? "").not.toContain("Search was unavailable");
    expect(new Set([down.kind + ((down as { url: string }).url ? ":url" : ":nourl"), none.kind, failedCheck.kind + ":url"]).size).toBe(3);
  }, 60_000);

  test("phone finder search: an outage throws SearchUnavailable (the batch backs off); an empty answer returns []", async () => {
    await expect(searxngResults("q", (async () => new Response("down", { status: 503 })) as unknown as typeof fetch)).rejects.toBeInstanceOf(SearchUnavailable);
    await expect(searxngResults("q", (async () => json({ results: [], unresponsive_engines: refused(SEARCH_ENGINES.split(",")) })) as unknown as typeof fetch)).rejects.toMatchObject({ kind: "engines_refused" });
  }, 40_000);
});
