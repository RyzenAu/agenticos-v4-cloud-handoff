// Bot-computer workflows (programme r6): builder, website audit, business preparation, and the research completeness check, with the saved
// results (artifacts) they return.
//
// SYNTHETIC here: the computer is the harness's in-process companion running the REAL Linux executors (including the git workspace, real git) over a
// fake browser that "renders" by reading the HTML it is given. The hub, job service, control lease, wire (with its 16 KB reply cap), artifact store and
// routes are the real ones. The real-host runs are in docs/programme-20261001/BOT-WORKFLOWS-R6.md.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLinuxExecutors, type BrowserBackend } from "../../companion/linux/executors-linux";
import { BASE_FILES, checkCss, checkHtml } from "../../companion/linux/build-workspace";
import { artifactPage, createArtifactStore, headersFor, renderMarkdown } from "./artifacts";
import { planSteps, planWorkflow } from "./jarvis";
import { buildReports, requestedItems, requiredSources, ruleCoverage, runResearch, type CallResult, type Fact, type ResearchIO, type Source } from "./research";
import { threadDeliver } from "./research-wiring";
import { startComputersHub, type ComputersHub } from "./test-harness";
import { FIXTURE_PAGES } from "./workflows/audit-fixture";
import { buildFindings, pickJourney, resolveTarget, type Analysis, type PageRead } from "./workflows/audit";
import { buildTable, checkFigures, fitLines, readInfo, SYNTHETIC_INFO } from "./workflows/bizprep";
import { changeSummary, templateFor, validateComponent } from "./workflows/builder";
import { csvCell } from "./workflows/common";
import { validateWorkflowStep } from "./workflows";

setDefaultTimeout(60_000);
const JOB = "11111111-2222-4333-8444-555555555555";
const OTHER_JOB = "aaaaaaaa-2222-4333-8444-555555555555";

// ------------------------------------------------------------------------------------------------------------- artifacts
describe("saved results (artifacts)", () => {
  const dirs: string[] = [];
  const store = () => {
    const d = mkdtempSync(join(tmpdir(), "artifacts-"));
    dirs.push(d);
    return createArtifactStore(d);
  };
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const input = (over: Record<string, unknown> = {}) => ({ jobId: JOB, personId: "usman", kind: "audit" as const, title: "Audit", summary: "s", host: "synthetic", computer: "research", outcome: "complete", main: "audit.md", files: [{ name: "audit.md", data: "# Audit\n\n- one" }, { name: "shot-a.jpg", data: new Uint8Array([0xff, 0xd8, 1, 2, 3]) }], ...over });

  test("one artifact per job: a second save returns the first; only its owner can open it; files are served with a sandbox", () => {
    const s = store();
    const first = s.save(input());
    expect(first).toMatchObject({ ok: true, created: true });
    const again = s.save(input({ title: "Different", files: [{ name: "audit.md", data: "changed" }] }));
    expect(again).toMatchObject({ ok: true, created: false });
    expect(s.get(JOB, "usman")!.title).toBe("Audit");
    expect(s.file(JOB, "usman", "audit.md")!.data.toString()).toBe("# Audit\n\n- one");
    // someone else's result is not theirs: not by id, not in a list, not by file
    expect(s.get(JOB, "mehroz")).toBeNull();
    expect(s.list("mehroz")).toEqual([]);
    expect(s.file(JOB, "mehroz", "audit.md")).toBeNull();
    expect(s.list("usman").map((m) => m.id)).toEqual([JOB]);
    // not a job id, a path out of the folder, and a file that is not in the artifact
    expect(s.get("../../etc", "usman")).toBeNull();
    expect(s.file(JOB, "usman", "../meta.json")).toBeNull();
    expect(s.file(JOB, "usman", "nope.md")).toBeNull();
    expect(headersFor("text/html; charset=utf-8")["Content-Security-Policy"]).toMatch(/sandbox allow-scripts; default-src 'none'/);
    expect(headersFor("text/html; charset=utf-8")["Content-Security-Policy"]).not.toMatch(/connect-src|http/);
    expect(headersFor("text/markdown")["X-Content-Type-Options"]).toBe("nosniff");
  });

  test("an artifact is refused when it is not usable: no files, bad names, a missing main file, a non-job id", () => {
    const s = store();
    expect(s.save(input({ files: [] }))).toMatchObject({ ok: false });
    expect(s.save(input({ files: [{ name: "../x.md", data: "x" }], main: "../x.md" }))).toMatchObject({ ok: false });
    expect(s.save(input({ main: "missing.md" }))).toMatchObject({ ok: false });
    expect(s.save(input({ jobId: "not-a-job" }))).toMatchObject({ ok: false });
    expect(s.save(input({ files: [{ name: "meta.json", data: "{}" }], main: "meta.json" }))).toMatchObject({ ok: false });
    expect(s.list("usman")).toEqual([]); // nothing half-saved
  });

  test("the page renders the markdown safely: escaped HTML, own images only, http links only", () => {
    const own = new Set(["shot-a.jpg", "audit.md"]);
    const html = renderMarkdown("# T <script>alert(1)</script>\n\n| a | b |\n| --- | --- |\n| **x** | `y` |\n\n- item [ok](https://example.com) [bad](javascript:alert(1))\n\n![pic](shot-a.jpg) ![evil](https://evil.example/x.png)\n\n```\n<b>code</b>\n```", own, (n) => `/f/${n}`);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("<table>");
    expect(html).toContain('<img src="/f/shot-a.jpg"');
    expect(html).not.toContain("evil.example/x.png");
    expect(html).toContain('href="https://example.com"');
    expect(html).not.toContain("javascript:");
    expect(html).toContain("&lt;b&gt;code&lt;/b&gt;");
    expect(renderMarkdown("*Fix first: a visitor is blocked.* and **bold** and 2*3*4", own, (n) => n)).toBe("<p><em>Fix first: a visitor is blocked.</em> and <strong>bold</strong> and 2*3*4</p>");
    const meta = { id: JOB, personId: "usman", kind: "audit" as const, title: "T <b>", summary: "S", host: "h", computer: "research", createdAt: "2026-10-02T01:02:03Z", main: "audit.md", outcome: "complete", files: [{ name: "audit.md", bytes: 5, mime: "text/markdown" }] };
    const page = artifactPage(meta, "# Hi", "/__computers/artifacts/" + JOB);
    expect(page).toContain("&lt;b&gt;");
    expect(page).toContain("prefers-color-scheme:dark");
    expect(page).toContain('name="viewport"');
  });
});

// ------------------------------------------------------------------------------------------------------------- research: what was asked for
describe("research completeness: every asked-for item is checked against the cited facts", () => {
  test("the request is split into the things it asks for, by rule", () => {
    expect(requestedItems("Compare what two reliable sources say about Canberra: when it was founded and named, and what its population is.")).toEqual(["when it was founded and named", "what its population is"]);
    expect(requestedItems("Find the opening hours, phone number and address of Bondi Dental")).toEqual(["the opening hours", "phone number", "address of Bondi Dental"]);
    expect(requestedItems("summarise the licence classes for home building in NSW")).toHaveLength(1);
    expect(requestedItems("research Smith and Jones Dental")).toHaveLength(1); // one name, not two items
  });

  test("an instruction about method is not an item, and a goal that asks for N sources is checked for N sources", () => {
    // the goal exactly as a spoken "use the research computer to research: ..." reaches the job: two colons, and "compare" is method
    expect(requestedItems("research: Compare what two reliable sources say about Canberra: when it was founded and named, and what its population is.")).toEqual(["when it was founded and named", "what its population is"]);
    expect(requestedItems("find the licence classes; cite two sources")).toHaveLength(1);
    expect(requiredSources("Compare what two reliable sources say about Canberra")).toBe(2);
    expect(requiredSources("find three official websites about X")).toBe(3);
    expect(requiredSources("summarise the licence classes")).toBe(0);
  });

  test("a numeric item is covered only by a fact that carries a number; a topic mention is not an answer", () => {
    const f = (claim: string): Fact => ({ claim, quote: claim, source: 1, by: "model" });
    const items = ["when it was founded and named", "what its population is"];
    const cov = ruleCoverage(items, [f("Canberra was formally named on 12 March 1913 as Australia's capital."), f("Canberra's population growth is a planning priority for the ACT government.")]);
    expect(cov.map((c) => c.covered)).toEqual([true, false]);
    const cov2 = ruleCoverage(items, [f("Canberra was formally named on 12 March 1913."), f("Canberra's population is nearly 400,000 people.")]);
    expect(cov2.map((c) => c.covered)).toEqual([true, true]);
  });

  test("the report says plainly what was not found, in the answer and the uncertainties, and the concise report keeps those lines", () => {
    const sources: Source[] = [{ n: 1, url: "https://example.gov.au/x", title: "Page", host: "example.gov.au", primary: true, chunks: 1, facts: 1, complete: false }];
    const facts: Fact[] = [{ claim: "Canberra was named on 12 March 1913.", quote: "named on 12 March 1913", source: 1, by: "model" }];
    const items = [{ item: "when it was founded and named", covered: true, facts: [1] }, { item: "what its population is", covered: false, facts: [] }];
    const r = buildReports({ goal: "x", summary: null, facts: [...facts, ...Array.from({ length: 8 }, (_, i) => ({ claim: `Long fact ${i} ${"y".repeat(200)}`, quote: "q", source: 1, by: "model" as const }))], sources, uncertainties: [], items });
    expect(r.concise).toContain("Not found: what its population is");
    expect(r.full).toContain("NOT FOUND: what its population is");
    expect(r.full).toContain("Found: when it was founded and named");
    expect(r.concise.length).toBeLessThanOrEqual(1790);
  });

  // a fake web
  const PAGES: Record<string, { title: string; text: string }> = {
    "https://www.nca.gov.au/history": { title: "History of Canberra | NCA", text: "Canberra was founded in 1913 when the capital was formally named on 12 March 1913 by Lady Denman. Canberra is the planned capital of Australia." },
    "https://www.abs.gov.au/canberra": { title: "Canberra population | ABS", text: "The estimated resident population of Canberra was 456,000 people in June 2023, according to the Australian Bureau of Statistics." },
    "https://www.example.com/blog": { title: "Canberra blog", text: "Canberra has lovely autumn colours and many cafes worth a visit in the city centre." },
  };
  function web(search: (q: string) => { title: string; url: string; snippet: string }[]) {
    const calls: string[] = [];
    let cur = "";
    const queries: string[] = [];
    const call = async (executor: string, args: Record<string, unknown>): Promise<CallResult> => {
      calls.push(executor);
      if (executor === "browser.navigate") {
        const p = PAGES[String(args.url)];
        if (!p) return { kind: "failed", said: "didn't open" };
        cur = String(args.url);
        return { kind: "ok", ok: true, said: "Opened", verified: true, data: { title: p.title, url: cur, tabId: "t" } };
      }
      if (executor === "page.text") {
        const p = PAGES[cur];
        return { kind: "ok", ok: true, said: "Read", verified: true, data: { title: p.title, url: cur, total: p.text.length, offset: 0, text: p.text.slice(0, Number(args.limit)), links: [] } };
      }
      return { kind: "ok", ok: true, said: "Wrote", verified: true };
    };
    const steps: string[] = [];
    const delivered: { text: string; meta: unknown }[] = [];
    const artifacts: unknown[] = [];
    const io: ResearchIO = {
      signal: new AbortController().signal, call, step: (s) => void steps.push(s.intent), boundary: async () => "go", ask: null, delegate: null, retryDelayMs: 0,
      search: async (q) => (queries.push(q), search(q)),
      deliver: async (text, meta) => (delivered.push({ text, meta }), { delivered: true, where: "your conversation" }),
      artifact: (a) => (artifacts.push(a), { saved: true, title: "Research: x" }),
    };
    return { io, calls, steps, delivered, queries, artifacts };
  }
  const goal = "Compare what two reliable sources say about Canberra: when it was founded and named, and what its population is.";
  const nca = { title: "History of Canberra | NCA", url: "https://www.nca.gov.au/history", snippet: "Canberra founded named history" };
  const abs = { title: "Canberra population | ABS", url: "https://www.abs.gov.au/canberra", snippet: "Canberra population estimated resident" };
  const blog = { title: "Canberra blog", url: "https://www.example.com/blog", snippet: "Canberra" };

  test("the population is never found: the run is PARTIAL, says 'Not found', and is never called complete (the R5 defect)", async () => {
    const w = web(() => [nca, blog]);
    const r = await runResearch({ goal, io: w.io, limits: { maxPages: 3 } });
    expect(r.ok).toBe(true);
    expect(r.outcome).toBe("partial");
    expect(r.note).toMatch(/Not found: .*population/);
    expect(r.report!.concise).toContain("Not found: what its population is");
    // every item, including the third one the goal's "two reliable sources" adds (only one page gave cited facts)
    expect(r.items!.map((i) => i.covered)).toEqual([true, false, false]);
    expect(w.steps.join("\n")).toMatch(/not yet covered: what its population is/);
    expect((w.delivered[0].meta as { artifact: string }).artifact).toBe("Research: x");
    expect(w.artifacts).toHaveLength(1);
  });

  test("the goal asks for two sources and only one page gave cited facts: partial, and the report says the second source was not found", async () => {
    const w = web(() => [nca]);
    const r = await runResearch({ goal: "Compare what two reliable sources say about Canberra: when it was founded and named", io: w.io, limits: { maxPages: 3 } });
    expect(r.outcome).toBe("partial");
    expect(r.report!.concise).toContain("Not found: 2 separate sources, as asked (1 gave cited facts)");
  });

  test("a model that will not accept a related figure as the answer still shows it beside the 'Not found', and never counts it as found (the real Canberra run)", async () => {
    const w = web(() => [nca, abs]);
    const ok = (text: string) => ({ text, model: "m", inputTokens: 1, outputTokens: 1, costUsd: 0 });
    w.io.delegate = async (req) => {
      if (req.label === "items") return ok('{"items":["when it was founded and named","what its population is"]}');
      if (req.label === "extract" && /NCA/.test(req.user)) return ok('{"relevant":true,"facts":[{"claim":"Canberra was formally named on 12 March 1913","quote":"capital was formally named on 12 March 1913"}],"complete":false}');
      if (req.label === "extract" && /ABS/.test(req.user)) return ok('{"relevant":true,"facts":[{"claim":"The estimated resident population of the ACT was 456,000 in June 2023","quote":"estimated resident population of Canberra was 456,000 people in June 2023"}],"complete":false}');
      if (req.label === "coverage") return ok('{"items":[{"item":"a","facts":[1]},{"item":"b","facts":[]}]}'); // the ACT is not Canberra: the model will not call it the answer
      return null;
    };
    const r = await runResearch({ goal: "what happened in Canberra: when it was founded and named, and what its population is", io: w.io });
    expect(r.outcome).toBe("partial");
    expect(r.items!.map((i) => i.covered)).toEqual([true, false]);
    expect(r.items![1].closest).toEqual([2]);
    expect(r.report!.full).toContain("NOT FOUND: what its population is");
    expect(r.report!.full).toMatch(/Not found: what its population is\.[^\n]*Closest match, not the answer asked for: The estimated resident population of the ACT was 456,000/);
  });

  test("one item that is not on the web does not stop the other from being looked for: the run ends PARTIAL with the findable item cited and the other 'Not found'", async () => {
    PAGES["https://australian.museum/visit"] = { title: "Visit | Australian Museum", text: "The Australian Museum is open daily from 9.30 am to 5 pm, except Christmas Day. Entry to the permanent galleries is free." };
    const w = web((q) => (/museum/i.test(q) ? [{ title: "Visit | Australian Museum", url: "https://australian.museum/visit", snippet: "opening hours" }] : [{ title: "Pigeon facts", url: "https://www.example.com/blog", snippet: "pigeons" }]));
    const r = await runResearch({ goal: "Find the exact number of pigeons that landed on the Sydney Harbour Bridge on 14 March 2019, and the Australian Museum's opening hours.", io: w.io, limits: { maxPages: 4 } });
    expect(r.outcome).toBe("partial");
    expect(r.items!.map((i) => i.covered)).toEqual([false, true]);
    expect(r.report!.concise).toContain("Not found: the exact number of pigeons");
    expect(r.report!.concise).toMatch(/9\.30 am to 5 pm/);
    expect(w.queries.some((q) => /Australian Museum/i.test(q))).toBe(true);
  });

  test("a missing item triggers a targeted search, and once a page answers it the run is COMPLETE", async () => {
    const w = web((q) => (/population/i.test(q) ? [abs] : [nca]));
    const r = await runResearch({ goal, io: w.io });
    expect(r.outcome).toBe("complete");
    expect(r.items!.every((i) => i.covered)).toBe(true);
    expect(w.queries.some((q) => /Canberra.*population/i.test(q))).toBe(true);
    expect(r.report!.concise).not.toContain("Not found");
  });
});

// ------------------------------------------------------------------------------------------------------------- the pure parts of the workflows
describe("website audit: authorised targets, findings, journeys", () => {
  test("only the exact configured hosts or the local fixture are audited; Brooke's site, other hosts, http, credentials and a bad fixture are refused", () => {
    expect(resolveTarget({ url: "https://dental-care-plus.muventures.com.au/" })).toMatchObject({ ok: true, target: { kind: "site" } });
    expect(resolveTarget({ fixture: "demo-clinic" })).toMatchObject({ ok: true, target: { kind: "fixture" } });
    for (const url of ["https://example.com", "https://muventures.com.au", "http://dental-care-plus.muventures.com.au", "https://user:pw@dental-care-plus.muventures.com.au", "https://brooke.muventures.com.au", "https://evil.dental-care-plus.muventures.com.au", "nonsense"]) expect(resolveTarget({ url })).toMatchObject({ ok: false });
    expect(resolveTarget({ fixture: "other" })).toMatchObject({ ok: false });
    expect(resolveTarget({ url: "https://brooke.muventures.com.au" }, ["brooke.muventures.com.au"])).toMatchObject({ ok: false }); // even if someone lists it
    expect(validateWorkflowStep("audit", { url: "https://example.com" })).toMatchObject({ ok: false });
  });

  const base: Analysis = { ok: true, title: "T", lang: "en", viewportMeta: "width=device-width", url: "https://x/", viewport: { w: 390, h: 844 }, scrollWidth: 390, overflowX: 0, pageHeight: 900, h1: 1, headings: [], links: [], linksWithoutName: 0, tel: false, controls: 4, smallTargets: 0, smallTargetSamples: [], controlsWithoutName: 0, images: 1, imagesNoAlt: 0, imagesBroken: 0, brokenImageSamples: [], smallestText: 16, smallTextElements: 0, textElements: 10, forms: 0, fields: 0, fieldsNoLabel: 0, cta: [{ text: "Book now", top: 100, aboveFold: true }], ctaAboveFold: true, hasNav: true };
  const read = (page: string, device: "desktop" | "phone", a: Partial<Analysis>): PageRead => ({ page, device, width: device === "phone" ? 390 : 1280, analysis: { ...base, ...a }, shot: `shot-${page}-${device}.jpg` });

  test("findings are prioritised: broken links and a sideways-scrolling phone page come first; a healthy page has none", () => {
    expect(buildFindings([read("home", "desktop", {}), read("home", "phone", {})], [])).toEqual([]);
    const f = buildFindings(
      [read("home", "desktop", { imagesNoAlt: 2 }), read("home", "phone", { overflowX: 710, scrollWidth: 1100, viewportMeta: "", viewport: { w: 980, h: 1000 }, smallTargets: 5, controls: 6, smallTargetSamples: ["Services (40x12)"], smallTextElements: 5, smallestText: 10, imagesNoAlt: 2 }), read("contact", "phone", { fields: 3, fieldsNoLabel: 3, forms: 1 })],
      [{ from: "home", text: "Book a visit", target: "book.html", status: 404, ok: false, note: "no such file" }, { from: "home", text: "Services", target: "services.html", status: 200, ok: true, note: "file is there" }],
    );
    expect(f.map((x) => x.priority)).toEqual([...f.map((x) => x.priority)].sort());
    const p1 = f.filter((x) => x.priority === 1).map((x) => x.title);
    expect(p1).toEqual(expect.arrayContaining([expect.stringMatching(/wider than a phone/), expect.stringMatching(/No mobile viewport/), expect.stringMatching(/Broken link: "Book a visit"/)]));
    expect(f.find((x) => /Tap targets/.test(x.title))!.priority).toBe(2);
    expect(f.find((x) => /no label/.test(x.title))!.evidence).toMatch(/not filled or submitted/);
    // the same alt-text problem on both devices is ONE finding, naming both
    const alt = f.filter((x) => /no alt text/.test(x.title) && x.page === "home");
    expect(alt).toHaveLength(1);
    expect(alt[0].device).toBe("desktop and phone");
    expect(f.find((x) => /Broken link/.test(x.title))!.evidence).toMatch(/HTTP 404/);
  });

  test("the journey is the home page's own same-site links, key pages first, no duplicates, never the page itself", () => {
    const l = (text: string, href: string, sameSite = true) => ({ text, href, w: 50, h: 20, top: 10, sameSite });
    const j = pickJourney([l("Home", "https://x/"), l("Blog", "https://x/blog"), l("Contact", "https://x/contact"), l("Contact again", "https://x/contact#form"), l("Out", "https://other/", false), l("Book a visit", "https://x/book")], "https://x/");
    expect(j.open.map((x) => x.text)).toEqual(["Contact", "Book a visit"]);
    expect(j.check.map((x) => x.href)).toEqual(["https://x/contact", "https://x/book", "https://x/blog"]);
  });
});

describe("business preparation: every figure is computed and checked", () => {
  test("the table has ex-GST, GST and inc-GST per option, and the figures recompute", () => {
    const t = buildTable(SYNTHETIC_INFO);
    expect(t.figures).toEqual([{ name: "Starter", exGst: 69_000, gst: 6_900, incGst: 75_900 }, { name: "Standard", exGst: 109_000, gst: 10_900, incGst: 119_900 }, { name: "Plus", exGst: 199_000, gst: 19_900, incGst: 218_900 }]);
    expect(t.markdown).toContain("$690");
    expect(t.markdown).toContain("$1,199");
    expect(checkFigures(`${t.markdown}\n${fitLines(SYNTHETIC_INFO).join("\n")}`, SYNTHETIC_INFO)).toEqual([]);
  });

  test("a figure that does not follow from the information, or a missing one, is caught", () => {
    const t = buildTable(SYNTHETIC_INFO);
    expect(checkFigures(`${t.markdown}\nSave $500 today`, SYNTHETIC_INFO)[0]).toMatch(/\$500 is not a figure/);
    expect(checkFigures(t.markdown.replace("$1,199", "$1,299"), SYNTHETIC_INFO).join("\n")).toMatch(/\$1,199 is missing|\$1,299 is not/);
  });

  test("supplied information is validated and bounded; a spreadsheet formula in a cell is defused", () => {
    expect(readInfo({ options: [{ name: "A", priceCents: 100, features: { x: "1" } }] })).toBeNull(); // one option is not a comparison
    expect(readInfo({ options: [{ name: "A", priceCents: 1.5 }, { name: "B", priceCents: 2 }] })).toBeNull();
    expect(readInfo({ options: [{ name: "A", priceCents: 100 }, { name: "B", priceCents: 200 }] })!.options).toHaveLength(2);
    expect(csvCell("=HYPERLINK(\"http://x\")")).toBe("\"'=HYPERLINK(\"\"http://x\"\")\"");
    expect(csvCell("a,b")).toBe('"a,b"');
  });
});

describe("builder: component validation, templates, checks", () => {
  test("a component is only its own files, small, with no remote loads or network calls", () => {
    const ok = { name: "hours", files: [{ path: "components/hours.html", content: "<p>x</p>" }, { path: "components/hours.css", content: ".a{}" }] };
    expect(validateComponent(ok)).toBeNull();
    expect(validateComponent({ ...ok, name: "../x" })).toMatch(/plain lowercase name/);
    expect(validateComponent({ name: "hours", files: [{ path: "components/other.html", content: "<p>x</p>" }] })).toMatch(/is not components\/hours/);
    expect(validateComponent({ name: "hours", files: [{ path: "components/hours.html", content: '<script src="https://cdn.example/x.js"></script>' }] })).toMatch(/another address/);
    expect(validateComponent({ name: "hours", files: [{ path: "components/hours.html", content: "<p>x</p>" }, { path: "components/hours.css", content: "@import url(https://x/y.css);" }] })).toMatch(/another address/);
    expect(validateComponent({ name: "hours", files: [{ path: "components/hours.html", content: "<p>x</p>" }, { path: "components/hours.js", content: "fetch('/x')" }] })).toMatch(/network, navigation or dynamic/);
    expect(validateComponent({ name: "hours", files: [{ path: "components/hours.css", content: ".a{}" }] })).toMatch(/needs an .html/);
    expect(validateComponent({ name: "hours", files: [{ path: "components/hours.html", content: "x".repeat(20_000) }] })).toMatch(/larger than/);
  });

  test("the fixed templates (no model) are valid, and an UPDATE request changes the existing pricing card", () => {
    for (const brief of ["add opening hours", "add a testimonial", "add a notice banner about parking", "update the pricing card"]) {
      const c = templateFor(brief);
      expect(validateComponent(c)).toBeNull();
      expect(checkHtml("x.html", c.files.find((f) => f.path.endsWith(".html"))!.content).filter((x) => !x.ok)).toEqual([]);
      expect(checkCss("x.css", c.files.find((f) => f.path.endsWith(".css"))!.content).filter((x) => !x.ok)).toEqual([]);
    }
    const upd = templateFor("update the pricing card");
    expect(upd.name).toBe("pricing-card");
    expect(upd.files.map((f) => f.path)).toEqual(["components/pricing-card.html", "components/pricing-card.css"]);
    expect(upd.files[0].content).not.toBe(BASE_FILES["components/pricing-card.html"]);
  });

  test("the HTML and CSS checks catch real defects", () => {
    const bad = (html: string) => checkHtml("c.html", html).filter((c) => !c.ok).map((c) => c.name.replace("c.html: ", ""));
    expect(bad("<div><p>x</div>")).toContain("tags balanced");
    expect(bad('<img src="a.png">')).toContain("images have alt text");
    expect(bad('<script src="https://cdn.example.com/x.js"></script>')).toContain("nothing loaded from elsewhere");
    expect(bad('<a href="https://example.com">fine</a>')).toEqual([]);
    expect(bad('<button onclick="x()">b</button>')).toContain("no inline handlers or javascript: links");
    expect(checkCss("c.css", ".a { color: red;").some((c) => !c.ok)).toBe(true);
    expect(checkCss("c.css", '.a { background: url("https://x/y.png"); }').some((c) => !c.ok)).toBe(true);
  });

  test("the change summary is readable: what was added or changed, and the size", () => {
    const s = changeSummary({ component: templateFor("add opening hours"), names: ["A\tcomponents/opening-hours.html", "M\tcomponents/pricing-card.css"], stat: " 2 files changed, 20 insertions(+), 1 deletion(-)" });
    expect(s).toContain("- added `components/opening-hours.html`");
    expect(s).toContain("- changed `components/pricing-card.css`");
    expect(s).toContain("2 files changed, 20 insertions(+), 1 deletion(-)");
  });
});

describe("voice routing of the workflows", () => {
  test("audit, build and prepare phrases plan the right step; research and open-a-page stay as they were", () => {
    expect(planWorkflow("audit https://dental-care-plus.muventures.com.au")).toEqual({ executor: "audit", args: { url: "https://dental-care-plus.muventures.com.au" } });
    expect(planWorkflow("audit the demo clinic fixture")).toEqual({ executor: "audit", args: { fixture: "demo-clinic" } });
    expect(planWorkflow("please audit the website https://dental-care-plus.muventures.com.au.")).toMatchObject({ executor: "audit" });
    expect(planWorkflow("build an opening hours component for the clinic site")!.executor).toBe("builder");
    expect(planWorkflow("update the pricing card to show GST")!.executor).toBe("builder");
    expect(planWorkflow("prepare a comparison table of three website packages")).toMatchObject({ executor: "bizprep", args: { kind: "comparison" } });
    expect(planWorkflow("draft a proposal for a small clinic website")).toMatchObject({ executor: "bizprep", args: { kind: "proposal" } });
    expect(planWorkflow("research the licence classes for home building in NSW")).toBeNull();
    expect(planWorkflow("find the contact page of example.com and open it")).toBeNull();
    expect(planSteps("audit the demo clinic fixture", true, true, true)[0].executor).toBe("audit");
    expect(planSteps("audit the demo clinic fixture", true, true, false)[0].executor).not.toBe("audit"); // only where the hub keeps saved results
    expect(planSteps("go to example.com and check the title is Example Domain", true, true, true)[0].executor).toBe("screen.goal");
  });
});

// ------------------------------------------------------------------------------------------------------------- the real Linux executors, in-process
/** A browser that "renders" by reading the HTML it is given: enough for the audit's read to find what is really in the fixture. */
function fakeBrowser(workdir: string) {
  const tabs = new Map<string, { url: string; title: string; html: string }>();
  let last = "";
  let width = 1280;
  let seq = 0;
  const bytes = () => {
    const b = new Uint8Array(20_000);
    for (let i = 0; i < b.length; i++) b[i] = (i * 31 + seq) % 251;
    b[0] = 0xff;
    b[1] = 0xd8;
    return b;
  };
  const titleOf = (html: string) => /<title>([^<]*)<\/title>/i.exec(html)?.[1] ?? "";
  const analyse = (html: string, url: string): Analysis => {
    const vp = /<meta name="viewport" content="([^"]*)"/i.exec(html)?.[1] ?? "";
    const phone = width <= 500;
    const fixedWide = /\.banner\{width:1100px/.test(html);
    const layoutW = phone && !vp ? 980 : width;
    const links = [...html.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>([^<]*)<\/a>/gi)].map((m, i) => ({ text: m[2].trim(), href: new URL(m[1], url).href, w: 60, h: /font-size:10px/.test(html) ? 12 : 44, top: 40 + i * 30, sameSite: true }));
    const imgs = [...html.matchAll(/<img\b[^>]*>/gi)].map((m) => m[0]);
    const fields = [...html.matchAll(/<(?:input|textarea)\b[^>]*>/gi)].filter((m) => !/type="(?:submit|hidden)"/.test(m[0]));
    const small = links.filter((l) => l.h < 32).length;
    return {
      ok: true, title: titleOf(html), lang: /<html lang="([^"]*)"/.exec(html)?.[1] ?? "", viewportMeta: vp, url, viewport: { w: layoutW, h: 844 }, scrollWidth: fixedWide ? 1100 : layoutW, overflowX: fixedWide && phone ? 1100 - layoutW : 0, pageHeight: 1500, h1: (html.match(/<h1\b/g) ?? []).length, headings: [],
      links, linksWithoutName: 0, tel: false, controls: links.length + fields.length, smallTargets: phone ? small : 0, smallTargetSamples: links.filter((l) => l.h < 32).slice(0, 3).map((l) => `${l.text} (${l.w}x${l.h})`), controlsWithoutName: 0,
      images: imgs.length, imagesNoAlt: imgs.filter((t) => !/\balt=/.test(t)).length, imagesBroken: 0, brokenImageSamples: [], smallestText: /font-size:10px/.test(html) ? 10 : 16, smallTextElements: /font-size:10px/.test(html) ? 3 : 0, textElements: 10,
      forms: (html.match(/<form\b/g) ?? []).length, fields: fields.length, fieldsNoLabel: fields.filter((m) => !/aria-label|id=/.test(m[0])).length,
      cta: links.filter((l) => /book|contact/i.test(l.text)).map((l) => ({ text: l.text, top: l.top, aboveFold: l.top < 844 })), ctaAboveFold: links.some((l) => /book|contact/i.test(l.text) && l.top < 844), hasNav: /<nav\b/.test(html),
    };
  };
  const backend = {
    available: () => true,
    alive: async () => true,
    ensure: async () => undefined,
    async open(url: string) {
      const id = `tab-${++seq}`;
      tabs.set(id, { url, title: "Opened page", html: "" });
      last = id;
      return id;
    },
    async openFile(url: string) {
      const id = `tab-${++seq}`;
      const path = decodeURIComponent(url.replace(/^file:\/\/\/?/, "")).replace(/^([A-Za-z]:)/, "$1");
      const file = existsSync(path) ? path : `/${path}`;
      const html = readFileSync(file, "utf8");
      tabs.set(id, { url: `file:///${file.replace(/\\/g, "/").replace(/^\//, "")}`, title: titleOf(html), html });
      last = id;
      return id;
    },
    async read(tabId?: string) {
      const id = tabId ?? last;
      const t = tabs.get(id);
      return t ? { title: t.title, url: t.url, ready: "complete", tabId: id } : null;
    },
    async frame() {
      seq++;
      return bytes();
    },
    async setViewport(w: number) {
      width = w;
    },
    async clearViewport() {
      width = 1280;
    },
    async evalJson(_script: string, tabId?: string) {
      const t = tabs.get(tabId ?? last)!;
      return JSON.stringify(analyse(t.html, t.url));
    },
    async blank() {},
    async click() {},
    async type() {},
    async key() {},
  };
  return backend as unknown as BrowserBackend;
}

let hub: ComputersHub | undefined;
const workdirs: string[] = [];
afterEach(async () => {
  await hub?.close();
  hub = undefined;
  for (const d of workdirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function workflowHub(options: { delegate?: ComputersHub["computers"] extends never ? never : null } = {}) {
  void options;
  const delivered: { jobId: string; text: string; artifact: string | null }[] = [];
  const dirs = new Map<string, string>();
  const conversations = { entries: [] as { jobId: string; key: string; text: string }[] };
  hub = await startComputersHub({
    artifacts: true,
    workflows: { delegate: null, allowedAuditHosts: ["dental-care-plus.muventures.com.au"], hostLabel: () => "synthetic in-process computer" },
    research: {
      search: null,
      delegate: null,
      deliver: async (i) => {
        delivered.push({ jobId: i.jobId, text: i.report, artifact: i.artifact ?? null });
        conversations.entries.push({ jobId: i.jobId, key: `${i.jobId}:report:1`, text: i.report });
        return { delivered: true, where: "your conversation" };
      },
    },
  });
  hub.host.executorsFor = (name) => {
    let dir = dirs.get(name);
    if (!dir) {
      dir = mkdtempSync(join(tmpdir(), `wf-${name}-`));
      workdirs.push(dir);
      dirs.set(name, dir);
    }
    return createLinuxExecutors({ name, workdir: dir, browser: fakeBrowser(dir), resolve: async () => ["93.184.216.34"] });
  };
  expect((await hub.api("usman", "POST", "/", { name: "builder" })).status).toBe(200);
  await hub.waitFor("online", () => hub!.computers.view("builder").state === "online");
  return { hub, delivered, dirs, conversations };
}
const finished = async (h: ComputersHub, jobId: string) => h.waitFor("the job to end", () => (["succeeded", "failed", "cancelled", "unknown", "interrupted"].includes(h.computers.jobView(jobId)?.state ?? "") ? h.computers.jobView(jobId) : null), 50_000);

describe("the workflows as real jobs on a computer (real executors, real wire, real git)", () => {
  test("business preparation: a verified comparison, saved on the computer and as an artifact that opens from the hub, returned once", async () => {
    const { hub: h, delivered, dirs } = await workflowHub();
    const r = await h.api("usman", "POST", "/builder/jobs", { agent: "t", title: "comparison", steps: [{ executor: "bizprep", args: { kind: "comparison", brief: "compare three synthetic website packages" } }] });
    expect(r.status).toBe(200);
    const job = await finished(h, r.json.jobId);
    expect(job.state).toBe("succeeded");
    const meta = h.artifacts!.get(r.json.jobId, "usman")!;
    expect(meta).toMatchObject({ kind: "bizprep", outcome: "complete", main: "comparison.md", host: "synthetic in-process computer" });
    expect(meta.files.map((f) => f.name).sort()).toEqual(["comparison.csv", "comparison.md", "data.json"]);
    const md = h.artifacts!.file(r.json.jobId, "usman", "comparison.md")!.data.toString();
    expect(md).toContain("Synthetic information, for practice");
    expect(md).toContain("$1,199");
    // also written into the computer's own folder
    expect(readdirSync(dirs.get("builder")!).some((f) => /^comparison-.*\.md$/.test(f))).toBe(true);
    // exactly one result delivered, and it says the saved result opens
    expect(delivered).toHaveLength(1);
    expect(delivered[0].artifact).toBe(meta.title);
    // the page opens from the OS route, for its owner only
    const page = await h.api("usman", "GET", `/artifacts/${r.json.jobId}`);
    expect(page.status).toBe(200);
    expect(Buffer.from(page.bytes!).toString()).toContain("Comparison: Starter / Standard / Plus");
    expect((await h.api("mehroz", "GET", `/artifacts/${r.json.jobId}`)).status).toBe(404);
    expect((await h.api("usman", "GET", "/artifacts")).json.artifacts.map((a: { id: string }) => a.id)).toEqual([r.json.jobId]);
    expect((await h.api("mehroz", "GET", "/artifacts")).json.artifacts).toEqual([]);
  });

  test("website audit of the local fixture: finds the planted problems with evidence and brings the screenshots back (through the 16 KB reply cap)", async () => {
    const { hub: h, delivered } = await workflowHub();
    const r = await h.api("usman", "POST", "/builder/jobs", { agent: "t", title: "audit", steps: [{ executor: "audit", args: { fixture: "demo-clinic" } }] });
    expect(r.status).toBe(200);
    const job = await finished(h, r.json.jobId);
    expect(job.state).toBe("succeeded");
    const meta = h.artifacts!.get(r.json.jobId, "usman")!;
    expect(meta).toMatchObject({ kind: "audit", outcome: "complete" });
    const md = h.artifacts!.file(r.json.jobId, "usman", "audit.md")!.data.toString();
    expect(md).toMatch(/P1: Broken link: "Book a visit"/);
    expect(md).toMatch(/P1: The page is wider than a phone screen/);
    expect(md).toMatch(/P1: No mobile viewport setting/);
    expect(md).toMatch(/Tap targets are too small/);
    expect(md).toMatch(/no alt text/);
    expect(md).toMatch(/form fields? (?:has|have) no label/);
    expect(md).toContain("Nothing was clicked");
    expect(md).toContain("Not checked");
    const shots = meta.files.filter((f) => f.name.endsWith(".jpg"));
    expect(shots.map((s) => s.name)).toEqual(expect.arrayContaining(["shot-home-desktop.jpg", "shot-home-phone.jpg"]));
    for (const s of shots) {
      const got = h.artifacts!.file(r.json.jobId, "usman", s.name)!.data;
      expect(got.length).toBe(20_000); // all 3 pieces came back, joined, and the checksum matched
      expect(got[0]).toBe(0xff);
    }
    expect(md).toContain("![home on phone](shot-home-phone.jpg)");
    // the contact page was opened and read at phone width too (the unlabelled form)
    expect(md).toMatch(/contact/);
    expect(delivered).toHaveLength(1);
    expect(delivered[0].text).toContain("Read-only");
    // the job log has ONE summary line per file pulled, not one per piece
    const steps = h.jobs.get(r.json.jobId)!.steps.filter((s) => /read shot-home-phone\.jpg back/.test(s.intent));
    expect(steps).toHaveLength(1);
    expect(h.jobs.get(r.json.jobId)!.steps.filter((s) => /file\.chunk|read shot-home-phone\.jpg from/.test(s.intent))).toHaveLength(0);
  });

  test("website audit of a site that is not authorised is refused before any computer is touched", async () => {
    const { hub: h } = await workflowHub();
    const before = h.jobs.list({ limit: 20 }).length;
    for (const url of ["https://example.com", "https://brooke.muventures.com.au", "http://dental-care-plus.muventures.com.au"]) {
      const r = await h.api("usman", "POST", "/builder/jobs", { agent: "t", steps: [{ executor: "audit", args: { url } }] });
      expect(r.status).toBeGreaterThanOrEqual(400);
      expect(r.json.error).toMatch(/Nothing was opened/);
    }
    expect(h.jobs.list({ limit: 20 }).length).toBe(before);
  });

  test("builder: an isolated worktree, a committed component, checks run by the computer, a diff, a preview with screenshots; the base site is untouched", async () => {
    const { hub: h, delivered, dirs } = await workflowHub();
    const r = await h.api("usman", "POST", "/builder/jobs", { agent: "t", title: "build", steps: [{ executor: "builder", args: { brief: "add an opening hours component" } }] });
    expect(r.status).toBe(200);
    const job = await finished(h, r.json.jobId);
    expect(job.state).toBe("succeeded");
    const meta = h.artifacts!.get(r.json.jobId, "usman")!;
    expect(meta).toMatchObject({ kind: "builder", outcome: "complete", main: "builder.md" });
    const names = meta.files.map((f) => f.name);
    expect(names).toEqual(expect.arrayContaining(["builder.md", "preview.html", "change.diff", "checks.json", "component-opening-hours.html", "component-opening-hours.css", "shot-preview-desktop.jpg", "shot-preview-phone.jpg"]));
    const md = h.artifacts!.file(r.json.jobId, "usman", "builder.md")!.data.toString();
    expect(md).toContain("worktree on branch `job/");
    expect(md).toMatch(/nothing was merged, pushed or deployed/);
    expect(md).toMatch(/\d+ of \d+ checks passed/);
    expect(md).toContain("- added `components/opening-hours.html`");
    const diff = h.artifacts!.file(r.json.jobId, "usman", "change.diff")!.data.toString();
    expect(diff).toContain("+++ b/components/opening-hours.html");
    expect(h.artifacts!.file(r.json.jobId, "usman", "preview.html")!.data.toString()).toContain("Opening hours");
    const checks = JSON.parse(h.artifacts!.file(r.json.jobId, "usman", "checks.json")!.data.toString());
    expect(checks.checks.every((c: { ok: boolean }) => c.ok)).toBe(true);
    // on the computer: the branch exists in its own worktree, and main still has only the base files
    const wd = dirs.get("builder")!;
    expect(readdirSync(wd).some((f) => f.startsWith("wt-"))).toBe(true);
    const { execFileSync } = await import("node:child_process");
    const main = execFileSync("git", ["-C", join(wd, "repo"), "ls-tree", "-r", "--name-only", "main"], { encoding: "utf8" }).split("\n").filter(Boolean).sort();
    expect(main).toEqual(["README.md", "components/pricing-card.css", "components/pricing-card.html", "index.html"]);
    expect(delivered).toHaveLength(1);
    expect(delivered[0].artifact).toBe(meta.title);
  });

  test("builder: a component whose checks fail is reported as PARTIAL with the failing check, never as complete", async () => {
    const { hub: h } = await workflowHub();
    // a brief the template can't make bad, so make the model bad: a delegate that returns an unbalanced component is rejected by validation up front
    const r = await h.api("usman", "POST", "/builder/jobs", { agent: "t", steps: [{ executor: "builder", args: { brief: "" } }] });
    expect(r.status).toBe(400);
    expect(r.json.error).toMatch(/needs a brief/);
  });

  test("two workflows on two computers at once do not cross: each result is its own, in its own job's artifact", async () => {
    const { hub: h, dirs } = await workflowHub();
    expect((await h.api("usman", "POST", "/", { name: "research" })).status).toBe(200);
    await h.waitFor("online", () => h.computers.view("research").state === "online");
    const a = await h.api("usman", "POST", "/builder/jobs", { agent: "t", steps: [{ executor: "builder", args: { brief: "add a testimonial component" } }] });
    const b = await h.api("usman", "POST", "/research/jobs", { agent: "t", steps: [{ executor: "audit", args: { fixture: "demo-clinic" } }] });
    const [ja, jb] = await Promise.all([finished(h, a.json.jobId), finished(h, b.json.jobId)]);
    expect([ja.state, jb.state]).toEqual(["succeeded", "succeeded"]);
    expect(h.artifacts!.get(a.json.jobId, "usman")!.kind).toBe("builder");
    expect(h.artifacts!.get(b.json.jobId, "usman")!.kind).toBe("audit");
    expect(readdirSync(dirs.get("builder")!).some((f) => f.startsWith("shot-home"))).toBe(false); // the audit's files are on the other computer
    expect(readdirSync(dirs.get("research")!).some((f) => f.startsWith("wt-") || f === "repo")).toBe(false);
  });

  test("a stopped workflow produces no artifact and no result entry, and nothing runs afterwards", async () => {
    const { hub: h, delivered } = await workflowHub();
    const r = await h.api("usman", "POST", "/builder/jobs", { agent: "t", steps: [{ executor: "audit", args: { fixture: "demo-clinic" } }] });
    await h.waitFor("the audit to start", () => (h.jobs.get(r.json.jobId)?.steps.length ?? 0) >= 2);
    await h.api("usman", "POST", `/jobs/${r.json.jobId}/cancel`, {});
    const job = await finished(h, r.json.jobId);
    expect(job.state).toBe("cancelled");
    const stepsAtEnd = h.jobs.get(r.json.jobId)!.steps.length;
    await new Promise((res) => setTimeout(res, 500));
    expect(h.jobs.get(r.json.jobId)!.steps.length).toBe(stepsAtEnd);
    expect(h.artifacts!.get(r.json.jobId, "usman")).toBeNull();
    expect(delivered).toHaveLength(0);
  });
});

describe("delivery text", () => {
  test("a build or a draft is not labelled web-sourced; research and an audit of a public site are; the saved result line appears only when the hub kept it", async () => {
    const entries: { text: string }[] = [];
    const store = { list: () => [{ id: "c1", thread: "jarvis", jobs: [{ jobId: JOB, startedAt: "2026-10-02T00:00:00Z" }] }], get: () => ({ id: "c1", personId: "usman" }), appendEntry: (_id: string, e: { text: string }) => (entries.push(e), e) } as never;
    const deliver = threadDeliver(store);
    await deliver({ jobId: JOB, by: "usman", title: "t", report: "Builder: X", web: false, artifact: "Builder: X", label: "Builder" });
    await deliver({ jobId: OTHER_JOB, by: "usman", title: "t", report: "r", artifact: null });
    expect(entries[0].text).not.toMatch(/Web-sourced/);
    expect(entries[0].text).toContain("Saved result: Builder: X");
    expect(entries[0].text).toContain("(job 11111111)");
  });
});
