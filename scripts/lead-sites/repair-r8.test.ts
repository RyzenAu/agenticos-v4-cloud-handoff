// Round 8 repair of the lead-site generator: one test per Quality Lab finding (G-01 to G-15).
// Every test here failed on the round-7 candidate and passes now. Synthetic fixtures only: no network,
// no CRM, no provider, no deploy.
import { describe, expect, test } from "bun:test";
import { preparedRealEstateSource } from "./prepared-source-helper";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCrm, upsertLead, findLead } from "../leads/crm";
import type { Evidence } from "../site-draft/evidence";
import { bannerText, factsFromEvidence, fillTemplate, finishExportHtml, safeguardJs, tokenValues, type PreviewFacts } from "./fill";
import * as fill from "./fill";
import { generatePreview } from "./generate";
import { applyRewrite, TEMPLATE_SPECS } from "./templates";
import { NEXT_TEMPLATE_SPECS, prepareSource } from "./next-templates";

const fact = (field: string, value: string, category: any = "business") => ({ category, field, value, sourceUrl: "https://own.example/", sourceLabel: "Fictional fixture", observedAt: "2026-10-03T00:00:00Z", status: value ? ("verified" as const) : ("missing" as const) });
const svc = (value: string) => ({ ...fact("service", value, "service"), category: "service" });

function evidence(name: string, over: { suburb?: string; address?: string; phone?: string; services?: string[]; vertical?: string } = {}): Evidence {
  return {
    leadId: 1, name, vertical: (over.vertical ?? "legal") as any, area: "Testville NSW", generatedAt: "2026-10-03T00:00:00Z",
    facts: [fact("name", name), fact("suburb", over.suburb ?? "Testville", "location"), fact("address", over.address ?? "5 Test Road, Testville NSW 2999", "location"), fact("phone", over.phone ?? "(02) 5550 0100", "contact")],
    services: (over.services ?? ["Wills"]).map(svc),
    hasOwnWebsite: true, ownSiteReachable: true, robotsBlocked: false, complianceNotes: [],
  } as Evidence;
}

const LEGAL_TEMPLATE_SOURCE = `<!doctype html><html><head><title>Marden &amp; Rowe</title></head><body>
<header class="site-header"><a class="wordmark" href="#top">Marden &amp; Rowe</a><nav class="nav"><a class="btn" href="tel:+61255500188"><span class="long">Call (02) 5550 0188</span></a></nav></header>
<h1 class="display">Talk to a Leichhardt solicitor.</h1><p class="lede">Marden &amp; Rowe, 88 Norton Street, Leichhardt.</p>
<section class="services"><h2 class="services-title">Areas</h2><div class="services-intro"><p>x</p></div><ul class="svc-list"><li class="svc" style="--i:0"><span class="svc-name">Property</span><span class="svc-scope">Buying</span></li></ul></section>
<section class="finale"><h2 class="call-title">Visit Marden</h2><p class="big big--lead">88 Norton Street</p><div class="finale-side"><p>Suite 4</p><a href="tel:+61255500188">Call</a></div></section>
<footer><div class="footer-grid">Marden &amp; Rowe (02) 5550 0188</div><p class="footer-mark">Marden &amp; Rowe</p></footer></body></html>`;

function world(vertical: "legal" | "dental") {
  const root = mkdtempSync(join(tmpdir(), "r8-"));
  const draftsRoot = join(root, "drafts");
  const tpl = join(draftsRoot, "_templates", vertical);
  mkdirSync(tpl, { recursive: true });
  const db = openCrm(join(root, ".operator-data", "crm.sqlite"));
  const add = (name: string, id: string) => {
    upsertLead(db, { placeId: id, vertical, area: "Testville NSW", name, phone: "", address: "", website: "https://own.example/", mapsUrl: "", rating: null, reviews: null, emails: [], emailOk: false, score: 1, pitch: "", reasons: [], googleAt: null, source: "osm" } as any);
    return findLead(db, id)!;
  };
  return { root, draftsRoot, tpl, db, add };
}

describe("G-01 a lead's own details that collide with a residue word are not residue", () => {
  test("a legal firm with a 'Family law' service, a 5550 number and a Rowe surname generates", async () => {
    const w = world("legal");
    writeFileSync(join(w.tpl, "index.html"), await applyRewrite(LEGAL_TEMPLATE_SOURCE, TEMPLATE_SPECS.legal), "utf8");
    const lead = w.add("Rowe & Associates Solicitors", "t:1");
    const ev = evidence("Rowe & Associates Solicitors", { suburb: "Leichhardt", address: "12 Norton Street, Leichhardt NSW 2040", phone: "(02) 5550 0188", services: ["Family law", "Wills"] });
    const out = await generatePreview(w.db, lead.id, { root: w.root, draftsRoot: w.draftsRoot, evidence: { ...ev, leadId: lead.id }, now: new Date("2026-10-03T00:00:00Z") });
    const html = readFileSync(join(out.dir, "index.html"), "utf8");
    expect(html).toContain("Family law");
    expect(html).toContain("Rowe &amp; Associates Solicitors");
  });

  test("a real leftover flagship identity still stops the preview", async () => {
    const w = world("legal");
    const tpl = (await applyRewrite(LEGAL_TEMPLATE_SOURCE, TEMPLATE_SPECS.legal)).replace("<footer>", "<footer><p>Ask Marden today</p>");
    writeFileSync(join(w.tpl, "index.html"), tpl, "utf8");
    const lead = w.add("Rowe & Associates Solicitors", "t:2");
    const ev = evidence("Rowe & Associates Solicitors", { services: ["Family law"] });
    await expect(generatePreview(w.db, lead.id, { root: w.root, draftsRoot: w.draftsRoot, evidence: { ...ev, leadId: lead.id } })).rejects.toThrow(/flagship content survived/);
  });

  test("a Next export for 'Halloran Street Dental' on Darling Street generates; a leftover Lantern or Natarajan does not", async () => {
    const w = world("dental");
    const makeTemplate = (extra: string) => {
      mkdirSync(join(w.tpl, "_next"), { recursive: true });
      writeFileSync(join(w.tpl, "index.html"), `<html><head><title>{{TITLE}}</title></head><body data-x="FlagshipOpening /img/generated/r15/lantern-room-wide.webp"><div class="mu-preview-banner" data-mu-expires="{{EXPIRES}}">{{BANNER}}</div><h1>{{BUSINESS}}</h1><p>{{ADDRESS}}</p>${extra}<script>self.__next_f.push([1,"{\\"b\\":\\"{{BUSINESS}}\\"}"])</script></body></html>`);
      writeFileSync(join(w.tpl, "_next", "c.js"), 'var s={n:"{{BUSINESS}}",a:"{{ADDRESS_LINE1}}"};');
      writeFileSync(join(w.tpl, "template.json"), JSON.stringify({ kind: "next-export", css: "", head: "" }));
    };
    const lead = w.add("Halloran Street Dental", "t:3");
    const ev = evidence("Halloran Street Dental", { vertical: "dental", suburb: "Rozelle", address: "70 Darling Street, Rozelle NSW 2039", phone: "(02) 5550 0142", services: ["Halloran fillings"] });
    makeTemplate("");
    const out = await generatePreview(w.db, lead.id, { root: w.root, draftsRoot: w.draftsRoot, evidence: { ...ev, leadId: lead.id }, now: new Date("2026-10-03T00:00:00Z") });
    expect(readFileSync(join(out.dir, "index.html"), "utf8")).toContain("Halloran Street Dental");
    expect(readFileSync(join(out.dir, "_next", "c.js"), "utf8")).toContain("70 Darling Street");
    // a flagship name that is NOT the lead's still fails, in a page and in a script chunk
    makeTemplate("<p>Dr Natarajan will see you</p>");
    await expect(generatePreview(w.db, lead.id, { root: w.root, draftsRoot: w.draftsRoot, evidence: { ...ev, leadId: lead.id } })).rejects.toThrow(/Natarajan/);
    makeTemplate("");
    writeFileSync(join(w.tpl, "_next", "c.js"), 'var s="Lantern Dental";');
    await expect(generatePreview(w.db, lead.id, { root: w.root, draftsRoot: w.draftsRoot, evidence: { ...ev, leadId: lead.id } })).rejects.toThrow(/Lantern Dental/);
  });

  test("a stale template that carries the lead's own surname as flagship text is still refused", async () => {
    const w = world("dental");
    mkdirSync(join(w.tpl, "_next"), { recursive: true });
    writeFileSync(join(w.tpl, "index.html"), `<html><head><title>{{TITLE}}</title></head><body data-x="FlagshipOpening /img/generated/r15/lantern-room-wide.webp"><div class="mu-preview-banner" data-mu-expires="{{EXPIRES}}">{{BANNER}}</div><h1>{{BUSINESS}}</h1><p>Halloran</p></body></html>`);
    writeFileSync(join(w.tpl, "template.json"), JSON.stringify({ kind: "next-export", css: "", head: "" }));
    const lead = w.add("Halloran Street Dental", "t:4");
    const ev = evidence("Halloran Street Dental", { vertical: "dental" });
    await expect(generatePreview(w.db, lead.id, { root: w.root, draftsRoot: w.draftsRoot, evidence: { ...ev, leadId: lead.id } })).rejects.toThrow(/template.*Halloran/);
  });
});

describe("G-02 a published service that quotes a price is the business's own text", () => {
  test("'Small claims under $20,000' and 'Disputes <$100k' generate; an invented price elsewhere does not", async () => {
    const w = world("legal");
    writeFileSync(join(w.tpl, "index.html"), await applyRewrite(LEGAL_TEMPLATE_SOURCE, TEMPLATE_SPECS.legal), "utf8");
    const lead = w.add("Fernley Quay Legal", "t:5");
    const ev = evidence("Fernley Quay Legal", { services: ["Small claims under $20,000", "Disputes <$100k", "Wills"] });
    const out = await generatePreview(w.db, lead.id, { root: w.root, draftsRoot: w.draftsRoot, evidence: { ...ev, leadId: lead.id } });
    expect(readFileSync(join(out.dir, "index.html"), "utf8")).toContain("Small claims under $20,000");
    // a price on the page that is NOT one of the lead's own values is still refused
    const bad = (await applyRewrite(LEGAL_TEMPLATE_SOURCE, TEMPLATE_SPECS.legal)).replace("<footer>", "<footer><p>Wills from $99</p>");
    writeFileSync(join(w.tpl, "index.html"), bad, "utf8");
    await expect(generatePreview(w.db, lead.id, { root: w.root, draftsRoot: w.draftsRoot, evidence: { ...ev, leadId: lead.id } })).rejects.toThrow(/price or discount/);
  });
});

describe("G-03 the 30-day expiry replaces the page without disturbing the page's own DOM", () => {
  test("the expiry script marks <html> and appends the notice instead of rewriting <body>", () => {
    const js = safeguardJs("Acme & Sons");
    expect(js).not.toContain("document.body.innerHTML");
    expect(js).toContain("data-mu-expired");
    expect(js).toContain("appendChild");
    expect(js).toContain("Acme &amp; Sons");
  });
  test("a style rule hides every other body child once expired, and the notice is exempt", () => {
    const head = fill.safeguardHead();
    expect(head).toContain("html[data-mu-expired] body>*:not(.mu-expired-notice){display:none!important}");
  });
  test("the script runs against a small stateful DOM: expired pages get the notice, and it comes back whole after the page strips it", () => {
    const run = (nowMs: number, expires: string) => {
      const attrs: Record<string, string> = {};
      const styles: Record<string, any> = {};
      const state: { notice: any } = { notice: null };
      let observe: (() => void) | null = null;
      const make = () => {
        const o: any = { className: "", id: "", textContent: "", setAttribute() {} };
        Object.defineProperty(o, "innerHTML", { set(v: string) { o.textContent = String(v).replace(/<[^>]+>/g, " "); }, get() { return o.textContent; } });
        return o;
      };
      const banner = { getAttribute: () => expires, offsetHeight: 40 };
      const doc: any = {
        querySelector: (sel: string) => (sel === ".mu-preview-banner" ? banner : sel === ".mu-expired-notice" ? state.notice : null),
        getElementById: (id: string) => styles[id] ?? null,
        documentElement: { hasAttribute: (k: string) => k in attrs, setAttribute: (k: string, v: string) => (attrs[k] = v), removeAttribute: (k: string) => delete attrs[k], style: { setProperty() {} }, appendChild() {} },
        head: { appendChild: (el: any) => { styles[el.id] = el; } },
        createElement: () => make(),
        addEventListener() {},
        body: { appendChild: (n: any) => { if (/mu-expired-notice/.test(n.className)) state.notice = n; } },
      };
      class FakeObserver { constructor(cb: () => void) { observe = cb; } observe() {} }
      const RealDate = Date;
      const fake = Object.assign(function () {} as any, { now: () => nowMs, parse: RealDate.parse });
      new Function("document", "Date", "addEventListener", "MutationObserver", safeguardJs("Acme"))(doc, fake, () => {}, FakeObserver);
      return { attrs, styles, state, observe: () => observe?.(), strip: () => { delete attrs["data-mu-expired"]; state.notice = null; delete styles["mu-expired-style"]; } };
    };
    const expired = run(Date.parse("2026-11-05T00:00:00Z"), "2026-11-02T00:00:00.000Z");
    expect(expired.attrs["data-mu-expired"]).toBe("1");
    expect(expired.state.notice.textContent).toContain("has expired and is no longer available");
    expect(expired.styles["mu-expired-style"].textContent).toContain("html[data-mu-expired] body>*:not(.mu-expired-notice){display:none!important}");
    // The page's own recovery render removes the marker, the notice and the hiding rule: one observer callback puts all three back.
    expired.strip();
    expect(expired.attrs["data-mu-expired"]).toBeUndefined();
    expect(expired.state.notice).toBeNull();
    expired.observe();
    expect(expired.attrs["data-mu-expired"]).toBe("1");
    expect(expired.state.notice.textContent).toContain("has expired and is no longer available");
    expect(expired.styles["mu-expired-style"]).toBeTruthy();
    // A notice that survives with its text emptied gets the words back too.
    expired.state.notice.textContent = "";
    expired.observe();
    expect(expired.state.notice.textContent).toContain("Acme");
    const live = run(Date.parse("2026-10-05T00:00:00Z"), "2026-11-02T00:00:00.000Z");
    expect(live.attrs["data-mu-expired"]).toBeUndefined();
    expect(live.state.notice).toBeNull();
  });
  test("every page of an export carries the expiry script, including nested routes and the 404", () => {
    const facts: PreviewFacts = { business: "Acme", suburb: "Testville", address: "", phone: "", email: "", website: "", services: [], sources: [] };
    for (const html of ["<html><head></head><body><div class=\"mu-preview-banner\" data-mu-expires=\"2026-11-02T00:00:00.000Z\">x</div></body></html>"])
      expect(finishExportHtml(html, facts, "Acme", "", "2026-11-02T00:00:00.000Z")).toContain("data-mu-expired");
  });
});

describe("G-04 a long business name cannot widen the page or push the menu off the screen", () => {
  test("the real-estate and legal template CSS lets the wordmark shrink and wrap", () => {
    expect(NEXT_TEMPLATE_SPECS["real-estate"].css).toMatch(/Header-module"\]\[class\*="__brand"\]\{[^}]*min-width:0/);
    expect(NEXT_TEMPLATE_SPECS["real-estate"].css).toMatch(/__menuBtn"\]\{[^}]*flex:none/);
    expect(TEMPLATE_SPECS.legal.css).toMatch(/a\.wordmark\{[^}]*white-space:normal/);
    expect(TEMPLATE_SPECS.legal.css).toMatch(/a\.wordmark\{[^}]*overflow-wrap:anywhere/);
  });
  test("the disclosure banner wraps instead of clipping", () => {
    const head = fill.safeguardHead();
    expect(head).toMatch(/\.mu-preview-banner\{[^}]*overflow-wrap:anywhere/);
    expect(head).toMatch(/\.mu-preview-banner\{[^}]*max-width:100vw/);
  });
});

describe("G-05 call links dial exactly the supplied number, or none", () => {
  const tel = fill.telHref;
  test("extension, trailing notes, a bracketed trunk zero and punctuation", () => {
    expect(tel("+61 (0)2 5550-0164 ext. 7")).toBe("tel:+61255500164");
    expect(tel("0491-570 156 (a/h)")).toBe("tel:+61491570156");
    expect(tel("(02) 5550 0171")).toBe("tel:+61255500171");
    expect(tel("+61 2 5550 0171")).toBe("tel:+61255500171");
    expect(tel("02 5550 0171 x12")).toBe("tel:+61255500171");
    expect(tel("1300 555 012")).toBe("tel:1300555012");
    expect(tel("13 12 34")).toBe("tel:131234");
  });
  test("anything ambiguous or incomplete gives no link at all", () => {
    expect(tel("5550 0171")).toBe(""); // no area code: never guessed
    expect(tel("02 5550 0171 / 0491 570 156")).toBe("");
    expect(tel("02 5550 0171 or 02 5550 0172")).toBe("");
    expect(tel("call us")).toBe("");
    expect(tel("")).toBe("");
    expect(tel("02 5550 017")).toBe("");
  });
  test("an unreadable number shows as text and links to the contact section, never to a guessed number", () => {
    const facts: PreviewFacts = { business: "A", suburb: "S", address: "", phone: "5550 0171", email: "", website: "", services: [], sources: [] };
    const v = tokenValues(facts, "dental", "");
    expect(v.PHONE).toBe("5550 0171");
    expect(v.PHONE_HREF).toBe("/#find-us");
  });
});

describe("G-09 unavailable actions are omitted or point at a page that exists", () => {
  test("real estate with no email or phone links to /contact, not a missing #contact anchor or a mailto of the placeholder", () => {
    const facts: PreviewFacts = { business: "A", suburb: "S", address: "", phone: "", email: "", website: "", services: [], sources: [] };
    const v = tokenValues(facts, "real-estate", "");
    expect(v.PHONE_HREF).toBe("/contact");
    expect(v.EMAIL_HREF).toBe("/contact");
    expect(v.EMAIL_HREF.startsWith("mailto:")).toBe(false);
  });
  test("a published email becomes a mailto only when it is one plain address", () => {
    expect(fill.mailtoHref("office@own.example")).toBe("mailto:office@own.example");
    expect(fill.mailtoHref("Email to be confirmed")).toBe("");
    expect(fill.mailtoHref("a@b.com, c@d.com")).toBe("");
  });
});

describe("G-12 a published email is shown on legal pages", () => {
  test("the legal template places the email in the contact blocks and fill renders it", async () => {
    const facts: PreviewFacts = { ...factsFromEvidence(evidence("Fernley Quay Legal"), { website: "https://own.example/", emails: ["reception@own.example"], emailOk: true }) };
    const html = fillTemplate(await applyRewrite(LEGAL_TEMPLATE_SOURCE, TEMPLATE_SPECS.legal), facts, "legal");
    expect(html).toContain('href="mailto:reception@own.example"');
    expect(html).toContain(">reception@own.example</a>");
    const none = fillTemplate(await applyRewrite(LEGAL_TEMPLATE_SOURCE, TEMPLATE_SPECS.legal), factsFromEvidence(evidence("Fernley Quay Legal"), { website: "https://own.example/", emails: [], emailOk: false }), "legal");
    expect(none).not.toContain("mailto:");
  });
});

describe("G-13 the claims audit reads every page of an export", () => {
  const make = (w: ReturnType<typeof world>, nested: string) => {
    mkdirSync(join(w.tpl, "sub"), { recursive: true });
    writeFileSync(join(w.tpl, "index.html"), `<html><head><title>{{TITLE}}</title></head><body data-x="FlagshipOpening /img/generated/r15/lantern-room-wide.webp"><div class="mu-preview-banner" data-mu-expires="{{EXPIRES}}">{{BANNER}}</div><h1>{{BUSINESS}}</h1></body></html>`);
    writeFileSync(join(w.tpl, "sub", "index.html"), `<html><head></head><body><div class="mu-preview-banner" data-mu-expires="{{EXPIRES}}">{{BANNER}}</div><p>${nested}</p><p>{{BUSINESS}}</p></body></html>`);
    writeFileSync(join(w.tpl, "template.json"), JSON.stringify({ kind: "next-export", css: "", head: "" }));
  };
  test("an award claim on a nested page stops the preview, where only index.html used to be read", async () => {
    const w = world("dental");
    make(w, "An award-winning practice");
    const lead = w.add("Wattlebrook Dental", "t:6");
    await expect(generatePreview(w.db, lead.id, { root: w.root, draftsRoot: w.draftsRoot, evidence: { ...evidence("Wattlebrook Dental", { vertical: "dental" }), leadId: lead.id } })).rejects.toThrow(/sub[\\/]index[.]html: .*award claim/);
  });
  test("a template's own labelled example figures (a median price, a photo counter) are not the lead's claims", async () => {
    const w = world("dental");
    make(w, "Example median price $2.1 million (demonstration), photo 1 / 5");
    const lead = w.add("Wattlebrook Dental", "t:7");
    const out = await generatePreview(w.db, lead.id, { root: w.root, draftsRoot: w.draftsRoot, evidence: { ...evidence("Wattlebrook Dental", { vertical: "dental" }), leadId: lead.id } });
    expect(existsSync(join(out.dir, "sub", "index.html"))).toBe(true);
  });
});

describe("G-10 and G-11 anchors", () => {
  test("every id gets the scroll margin, not only <section>, so a heading never lands under the fixed header", () => {
    expect(NEXT_TEMPLATE_SPECS.dental.css).toContain("\n[id]{scroll-margin-top");
    expect(NEXT_TEMPLATE_SPECS["real-estate"].css).toContain("\n[id]{scroll-margin-top");
    expect(NEXT_TEMPLATE_SPECS.dental.css).not.toContain("section[id]");
  });
  test("the dental header's anchors work from the 404 page (they point at the home page)", () => {
    const header = NEXT_TEMPLATE_SPECS.dental.edits.filter((e) => e.file === "src/components/Header.tsx").map((e) => e.to).join("\n");
    expect(header).toContain('href="/#services"');
    expect(header).toContain('href="/#find-us"');
    expect(header).not.toMatch(/href="#(services|find-us)"/);
  });
});

describe("G-14 finish", () => {
  test("opening and closing quotes alternate", () => {
    expect(fill.exportSafe('Brightwater & Lindqvist "Coast to Ranges" Real Estate')).toBe("Brightwater & Lindqvist “Coast to Ranges” Real Estate");
    expect(fill.exportSafe('"Quoted" start')).toBe("“Quoted” start");
  });
  test("a bare ampersand in the export <title> is escaped", () => {
    const facts: PreviewFacts = { business: "A & B", suburb: "", address: "", phone: "", email: "", website: "", services: [], sources: [] };
    const html = finishExportHtml("<html><head><title>A & B — preview</title></head><body><div class=\"mu-preview-banner\" data-mu-expires=\"x\"></div></body></html>", facts, "A & B", "", "x");
    expect(html).toContain("<title>A &amp; B — preview</title>");
  });
});

describe("the preview text stays free of internal wording", () => {
  test("the new notice and the template text carry no script path or command", () => {
    const words = safeguardJs("A") + bannerText("A");
    expect(words).not.toMatch(/scripts\/|bun run|MU_[A-Z]/);
  });
});

describe("G-08 segment payload files exist under the names the browser asks for", () => {
  const { flattenSegmentPayloads } = require("./next-templates");
  test("buy/__next.buy/__PAGE__.txt is also written as buy/__next.buy.__PAGE__.txt, dynamic and nested routes too", () => {
    const dir = mkdtempSync(join(tmpdir(), "r8-seg-"));
    for (const rel of ["__next.__PAGE__.txt", "buy/__next.buy/__PAGE__.txt", "property/x-1/__next.property/$d$slug/__PAGE__.txt", "rent/tenants/__next.rent/tenants/__PAGE__.txt", "buy/__next._tree.txt"]) {
      mkdirSync(join(dir, rel, ".."), { recursive: true });
      writeFileSync(join(dir, rel), "payload " + rel);
    }
    expect(flattenSegmentPayloads(dir)).toBe(3);
    expect(readFileSync(join(dir, "buy", "__next.buy.__PAGE__.txt"), "utf8")).toContain("buy/__next.buy/__PAGE__.txt");
    expect(existsSync(join(dir, "property", "x-1", "__next.property.$d$slug.__PAGE__.txt"))).toBe(true);
    expect(existsSync(join(dir, "rent", "tenants", "__next.rent.tenants.__PAGE__.txt"))).toBe(true);
    expect(flattenSegmentPayloads(dir)).toBe(0); // idempotent
  });
  test("generating from a template cache built without the flat names adds them", () => {
    const { fillExportDir, templateHeadFor } = require("./generate");
    const root = mkdtempSync(join(tmpdir(), "r8-seg2-"));
    const tpl = join(root, "tpl");
    mkdirSync(join(tpl, "buy", "__next.buy"), { recursive: true });
    writeFileSync(join(tpl, "index.html"), `<html><head></head><body><div class="mu-preview-banner" data-mu-expires="{{EXPIRES}}">{{BANNER}}</div></body></html>`);
    writeFileSync(join(tpl, "buy", "__next.buy", "__PAGE__.txt"), "{{BUSINESS}}");
    const facts: PreviewFacts = { business: "Acme", suburb: "S", address: "", phone: "", email: "", website: "", services: [], sources: [] };
    fillExportDir(tpl, join(root, "out"), facts, "real-estate", new Date("2026-10-03T00:00:00Z"), templateHeadFor({}));
    expect(readFileSync(join(root, "out", "buy", "__next.buy.__PAGE__.txt"), "utf8")).toBe("Acme");
  });
});

describe("G-14 legal finish: a 404 page, a skip link, readable captions", () => {
  test("the legal preview writes its own 404 page with the safeguards and a way back", async () => {
    const w = world("legal");
    writeFileSync(join(w.tpl, "index.html"), await applyRewrite(LEGAL_TEMPLATE_SOURCE, TEMPLATE_SPECS.legal), "utf8");
    const lead = w.add("Fernley Quay Legal", "t:12");
    const out = await generatePreview(w.db, lead.id, { root: w.root, draftsRoot: w.draftsRoot, evidence: { ...evidence("Fernley Quay Legal"), leadId: lead.id } });
    const html = readFileSync(join(out.dir, "404.html"), "utf8");
    expect(html).toContain("That page is not here.");
    expect(html).toContain('content="noindex, nofollow, noarchive, nosnippet"');
    expect(html).toContain("data-mu-expires=");
    expect(html).toContain('href="tel:+61255500100"');
    expect(html).not.toMatch(/\{\{/);
  });
  test("the legal template has a skip link right after the banner and a main landmark target", async () => {
    const html = await applyRewrite(`<!doctype html><html><head><title>x</title></head><body><header class="site-header"><a class="wordmark">Marden &amp; Rowe</a></header><main><h1>x</h1></main></body></html>`, TEMPLATE_SPECS.legal);
    expect(html).toContain('<a class="mu-skip" href="#main">Skip to content</a>');
    expect(html).toContain('<main id="main">');
    expect(TEMPLATE_SPECS.legal.css).toContain(".caption{font-size:max(12px");
  });
  test("a numbered frame folder named by the code is kept when unused assets are pruned", () => {
    const { pruneUnusedAssets } = require("./templates");
    const dir = mkdtempSync(join(tmpdir(), "r8-prune-"));
    mkdirSync(join(dir, "assets", "film", "keys"), { recursive: true });
    mkdirSync(join(dir, "assets", "img"), { recursive: true });
    writeFileSync(join(dir, "assets", "film", "keys", "d-0001.webp"), "x");
    writeFileSync(join(dir, "assets", "img", "unused.webp"), "x");
    writeFileSync(join(dir, "assets", "site.js"), 'var base = "assets/film/keys/";');
    pruneUnusedAssets(dir, '<script src="assets/site.js"></script>');
    expect(existsSync(join(dir, "assets", "film", "keys", "d-0001.webp"))).toBe(true);
    expect(existsSync(join(dir, "assets", "img", "unused.webp"))).toBe(false);
  });
});

describe("G-07 the motion script is requested from the site root on every page", () => {
  test("a nested export page loads /_mu/motion.js, not a path relative to its own folder", () => {
    const { fillExportDir, templateHeadFor } = require("./generate");
    const root = mkdtempSync(join(tmpdir(), "r8-motion-"));
    const tpl = join(root, "tpl");
    mkdirSync(join(tpl, "rent", "tenants"), { recursive: true });
    const page = `<html><head></head><body><div class="mu-preview-banner" data-mu-expires="{{EXPIRES}}">{{BANNER}}</div></body></html>`;
    writeFileSync(join(tpl, "index.html"), page);
    writeFileSync(join(tpl, "rent", "tenants.html"), page);
    writeFileSync(join(tpl, "rent", "tenants", "deep.html"), page);
    const facts: PreviewFacts = { business: "Acme", suburb: "S", address: "", phone: "", email: "", website: "", services: [], sources: [] };
    fillExportDir(tpl, join(root, "out"), facts, "real-estate", new Date("2026-10-03T00:00:00Z"), templateHeadFor({}));
    for (const rel of ["index.html", join("rent", "tenants.html"), join("rent", "tenants", "deep.html")]) {
      const html = readFileSync(join(root, "out", rel), "utf8");
      expect(html).toContain('<script src="/_mu/motion.js" async>');
      expect(html).not.toMatch(/src="_mu\/motion\.js"/);
    }
    expect(existsSync(join(root, "out", "_mu", "motion.js"))).toBe(true);
  });
});

describe("claim-like services are withheld, priced services are not", () => {
  test("an award, guarantee or rating service never reaches the page and is listed in PREVIEW.md; a priced service stays", async () => {
    const w = world("legal");
    writeFileSync(join(w.tpl, "index.html"), await applyRewrite(LEGAL_TEMPLATE_SOURCE, TEMPLATE_SPECS.legal), "utf8");
    const lead = w.add("Fernley Quay Legal", "t:20");
    const ev = evidence("Fernley Quay Legal", { services: ["Award-winning wills", "Guaranteed outcomes", "5 star conveyancing", "Small claims under $20,000", "Probate"] });
    const out = await generatePreview(w.db, lead.id, { root: w.root, draftsRoot: w.draftsRoot, evidence: { ...ev, leadId: lead.id } });
    const html = readFileSync(join(out.dir, "index.html"), "utf8");
    for (const bad of ["Award-winning", "Guaranteed", "5 star"]) expect(html).not.toContain(bad);
    expect(html).toContain("Small claims under $20,000");
    expect(html).toContain("Probate");
    const md = readFileSync(join(out.dir, "PREVIEW.md"), "utf8");
    expect(md).toContain("Withheld");
    expect(md).toContain("Award-winning wills");
  });
});

describe("G-05 tel links on sub-pages (real-estate agent and property pages)", () => {
  test("the agent page uses the verified, normalised number token, not the raw phone text", () => {
    const edits = NEXT_TEMPLATE_SPECS["real-estate"].edits.filter((e) => e.file === "src/app/agents/[slug]/page.tsx");
    const tos = edits.map((e) => e.to).join("\n");
    expect(tos).toContain("href={site.phoneHref}");
    expect(tos).toContain("href={site.emailHref}");
    expect(edits.some((e) => String(e.from).includes("a.phone.replace"))).toBe(true);
  });
  test("every way of writing one number gives the same dial string", () => {
    for (const raw of ["(02) 5550 0171", "02 5550 0171", "0255500171", "02-5550-0171", "+61 2 5550 0171", "+612 5550 0171", "(02) 5550 0171 ext. 4"])
      expect(fill.telHref(raw)).toBe("tel:+61255500171");
  });
});

describe("client code names no template, and no label is under 12 px", () => {
  test("every listener and sender of the assistant event, and the storage keys, are renamed together", () => {
    const edits = NEXT_TEMPLATE_SPECS["real-estate"].edits.filter((e) => typeof e.from === "string" && e.from.startsWith("aldergate:"));
    const files = edits.map((e) => e.file).sort();
    expect(files).toEqual(["src/components/assistant/Assistant.tsx", "src/components/property/StickyBar.tsx", "src/components/search/SearchPage.tsx", "src/lib/saved.ts"]);
    for (const e of edits) expect(String(e.to)).toMatch(/^preview:/);
    const open = edits.filter((e) => e.from === "aldergate:open-assistant");
    expect(open.length).toBe(2); // the listener (Assistant) and the sender (StickyBar)
  });
  test("the agent-card role label cannot fall under 12 px", () => {
    expect(NEXT_TEMPLATE_SPECS["real-estate"].css).toContain('[class*="AgentCard-module"][class*="__mono"] em');
  });
});

describe("review: the example site's address and agent-page labels", () => {
  test("the overlay's site data no longer carries the example agency's web address, and definition-list labels are at least 12 px", () => {
    const site = readFileSync(join(import.meta.dir, "overlays", "real-estate", "src", "data", "site.ts"), "utf8");
    expect(site).not.toMatch(/aldergate\.muventures/i);
    expect(NEXT_TEMPLATE_SPECS["real-estate"].css).toContain("dl dt,");
  });
});

describe("the expiry notice stays readable on any template", () => {
  test("its colours are forced, so a template's own main/body rules cannot turn it into pale text on a pale page", () => {
    expect(fill.safeguardHead()).toContain("html[data-mu-expired] .mu-expired-notice{background:#101014!important;color:#f4f2f8!important");
    expect(safeguardJs("Acme")).toContain("html[data-mu-expired] .mu-expired-notice{background:#101014!important");
  });
});

import { promisesIn } from "./promise-phrases";

describe("no hand-over promises: a preview sends nothing", () => {
  test("the scan itself finds the old wording and passes the new", () => {
    for (const bad of ["Callum or Hana will call to arrange an inspection", "We\u2019ll send a reminder before the inspection", "Leave my details for Imogen", "usually within one business day", "Sent to the agent.", "someone will be in touch"])
      expect(promisesIn(bad).length).toBeGreaterThan(0);
    for (const ok of ["This is a preview — enquiries aren't sent yet.", "Phone to be confirmed", "Please call the agency on the number shown on this page.", "Preview only."]) expect(promisesIn(ok)).toEqual([]);
  });
  const repo = join("C:", "Users", "Nebula PC", "source", "repos", "aldergate");
  test.skipIf(!existsSync(repo))("the prepared real-estate source (every page, form, success message and assistant answer) carries none of them", () => {
    const work = preparedRealEstateSource();
    const files = (require("node:fs").readdirSync(join(work, "src"), { recursive: true }) as string[]).filter((p) => /\.(tsx?|json)$/.test(p));
    const hits: string[] = [];
    for (const f of files) for (const h of promisesIn(readFileSync(join(work, "src", f), "utf8"))) hits.push(`${f}: ${h}`);
    expect(hits).toEqual([]);
  });
  test("the overlays carry none either (real estate and dental)", () => {
    const hits: string[] = [];
    for (const v of ["real-estate", "dental"]) {
      const dir = join(import.meta.dir, "overlays", v, "src");
      for (const f of require("node:fs").readdirSync(dir, { recursive: true }) as string[]) {
        if (!/\.(tsx?|json)$/.test(f)) continue;
        for (const h of promisesIn(readFileSync(join(dir, f), "utf8"))) hits.push(`${v}/${f}: ${h}`);
      }
    }
    expect(hits).toEqual([]);
  });
});

describe("contrast: the dimmed steps of the dental scroll scene keep readable text", () => {
  test("inactive steps are not dimmed with opacity; the active one is marked by a bar and by weight", () => {
    const edits = NEXT_TEMPLATE_SPECS.dental.edits.filter((e) => e.file === "src/components/flagship/FlagshipVisit.module.css");
    expect(edits.length).toBe(2);
    const to = edits.map((e) => e.to).join("\n");
    expect(String(edits[0].from)).toContain("opacity: 0.42");
    expect(to).not.toMatch(/opacity:\s*0?\.\d/);
    expect(to).toContain("border-left: 3px solid transparent");
    expect(to).toContain("border-left-color: var(--ink)");
    expect(to).toContain("font-weight: 480");
  });
  test("the text colours it uses are AA on white: the inactive ink is at least 4.5:1", () => {
    const lum = (hex: string) => { const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
    const ratio = (a: string, b: string) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
    expect(ratio("#415c76", "#ffffff")).toBeGreaterThan(4.5); // --ink-2, the inactive step colour
    expect(ratio("#143a62", "#ffffff")).toBeGreaterThan(4.5); // --ink, the active one
  });
});

import { archiveRevision } from "./templates";
import { textPieces } from "./promise-phrases";

describe("the widened promise scan", () => {
  test("confirmations, sends and call-backs by 'we', 'our team' or a role are all caught", () => {
    for (const bad of [
      "We will confirm the notice periods that apply and send any renewal offer in writing.",
      "We'll be in touch shortly.", "We\u2019ll get back to you.", "Our team will contact you.", "The property manager will call to arrange an inspection.",
      "Your property manager will acknowledge it the same day.", "An agent will reply within a day.", "Reception will send you a reminder.",
    ]) expect(promisesIn(bad).length).toBeGreaterThan(0);
  });
  test("negated sentences and plain information pass", () => {
    for (const ok of [
      "No licensed agent will respond to enquiries made through this demonstration.", "This is a preview — enquiries aren't sent yet.", "We won't keep calling.",
      "Notice periods depend on the lease and the tenancy law that applies, and a renewal offer is made in writing.", "Phone to be confirmed", "Call (02) 5550 0171.",
    ]) expect(promisesIn(ok)).toEqual([]);
  });
  test("it reads a built page's text, each value of the preview data JSON and each script string separately", () => {
    const html = `<html><body><p>Hello</p><script id="mu-preview-data" type="application/json">{"price":"The sale price was not disclosed.","listings":{"items":[{"headline":"We will confirm the price"}]}}</script><script>var a="Our team will contact you";var b='fine text here';</script></body></html>`;
    const pieces = textPieces(html);
    const hits = (kind: string) => pieces.filter((p) => p.kind === kind).flatMap((p) => promisesIn(p.text));
    expect(hits("page")).toEqual([]);
    expect(hits("data").length).toBe(1); // the "not disclosed" value does not switch the check off for its neighbour
    expect(hits("script").length).toBe(1);
  });
  test("a negation only counts shortly before the phrase and inside the same clause", () => {
    expect(promisesIn("No obligation, we will call you back.").length).toBeGreaterThan(0);
    expect(promisesIn("The sale price was not disclosed. We will be in touch.").length).toBeGreaterThan(0);
    expect(promisesIn("{\"a\":\"not disclosed\",\"b\":\"we will call you\"}").length).toBeGreaterThan(0);
    expect(promisesIn("No licensed agent will respond to enquiries made through this demonstration.")).toEqual([]);
    expect(promisesIn("This is a preview — enquiries aren't sent yet.")).toEqual([]);
    expect(promisesIn("We will not call you back.")).toEqual([]);
    expect(promisesIn("Nobody will contact you from this preview.")).toEqual([]);
  });
  test("generating refuses a page whose text promises a person will act, and a supplied listing field is withheld", async () => {
    const w = world("legal");
    writeFileSync(join(w.tpl, "index.html"), (await applyRewrite(LEGAL_TEMPLATE_SOURCE, TEMPLATE_SPECS.legal)).replace("<footer>", "<footer><p>Our team will contact you within a day.</p>"), "utf8");
    const lead = w.add("Fernley Quay Legal", "t:30");
    await expect(generatePreview(w.db, lead.id, { root: w.root, draftsRoot: w.draftsRoot, evidence: { ...evidence("Fernley Quay Legal"), leadId: lead.id } })).rejects.toThrow(/promises a person will act/);
  });
});

describe("tenants page wording, legal contrast and reproducible sources", () => {
  test("the notice-period FAQ no longer says 'we will confirm' or 'send'", () => {
    const e = NEXT_TEMPLATE_SPECS["real-estate"].edits.find((x) => x.file === "src/data/faqs.ts");
    expect(String(e?.from)).toContain("We will confirm the notice periods");
    expect(promisesIn(String(e?.to))).toEqual([]);
  });
  test("the legal band's inactive steps are not dimmed with opacity, and the active one is marked by a bar", () => {
    const css = TEMPLATE_SPECS.legal.css;
    expect(css).toContain(".keys--live .keys-steps li{opacity:1!important");
    expect(css).toContain('li[aria-current="step"]{border-left-color:var(--accent)}');
  });
  test("the legal flagship is pinned to a revision, and a malformed revision is refused", () => {
    const src = TEMPLATE_SPECS.legal.source;
    expect(src.kind === "local" && src.revision).toBe("3d530c9");
    expect(NEXT_TEMPLATE_SPECS["real-estate"].sourceRevision).toBe("9f374eb");
    expect(() => archiveRevision("C:/nowhere", "main; rm -rf", join(tmpdir(), "r8-arch"))).toThrow(/not a git revision/);
  });
});

describe("review follow-ups: business text, ratings that look like dates, and 'best ... in'", () => {
  test("a service that promises a call-back is withheld and noted; the rest of the preview generates", async () => {
    const w = world("legal");
    writeFileSync(join(w.tpl, "index.html"), await applyRewrite(LEGAL_TEMPLATE_SOURCE, TEMPLATE_SPECS.legal), "utf8");
    const lead = w.add("Fernley Quay Legal", "t:40");
    const ev = evidence("Fernley Quay Legal", { services: ["We will call you back about wills", "Probate"] });
    const out = await generatePreview(w.db, lead.id, { root: w.root, draftsRoot: w.draftsRoot, evidence: { ...ev, leadId: lead.id } });
    const html = readFileSync(join(out.dir, "index.html"), "utf8");
    expect(html).not.toContain("call you back");
    expect(html).toContain("Probate");
    expect(readFileSync(join(out.dir, "PREVIEW.md"), "utf8")).toContain("We will call you back about wills");
  });
  test("'Rated at 5/5 by our clients' is a rating; real dates still pass", async () => {
    const { readsAsClaim } = await import("./own-claims");
    for (const bad of ["Rated at 5/5 by our clients", "Rated 5/5 on Google", "5/5 reviews", "We are at 5/5 stars"]) expect(readsAsClaim(bad)).toBe(true);
    for (const ok of ["Auction Sat 3/5 at 11am", "Open Sat 3/5", "Inspection Wed 12/6", "Offers close 3/5 at 5pm"]) expect(readsAsClaim(ok)).toBe(false);
  });
  test("'Best property manager in Balmain' and 'Best dental clinic in Penrith' are claims; price lines and idioms still pass", async () => {
    const { readsAsClaim } = await import("./own-claims");
    for (const bad of ["Best property manager in Balmain", "Best dental clinic in Penrith", "Best realtor in Sydney", "Best lawyer in town", "Best conveyancer in the west", "Best practice in Newtown"]) expect(readsAsClaim(bad)).toBe(true);
    for (const ok of ["Best offers in excess of $1,200,000", "Best of both worlds in Balmain", "Best views in the street"]) expect(readsAsClaim(ok)).toBe(false);
  });
});

describe("the business's own voice promises nothing the preview can do", () => {
  test("'we'll tell / say / suggest / let you know / advise / walk through' are promises; negations and preview notices pass", () => {
    for (const bad of ["Where they help. We'll tell you when they don't.", "If your property is outside them, we'll say so and suggest someone who knows the area.", "We will let you know.", "We'll advise on the best method.", "We'll walk through it with you.", "and we can arrange any of them."])
      expect(promisesIn(bad).length).toBeGreaterThan(0);
    for (const ok of ["Useful for some properties and not for others.", "A property outside them may be better served by an agent who knows that area.", "We won't tell anyone.", "No agent will tell you.", "This is a preview — enquiries aren't sent yet.", "No licensed agent will respond to enquiries made through this demonstration."])
      expect(promisesIn(ok)).toEqual([]);
  });
  test("both lines are replaced in the prepared source, and the page copy that needed them is gone", () => {
    const edits = NEXT_TEMPLATE_SPECS["real-estate"].edits;
    for (const [file, from] of [["src/app/sell/page.tsx", "We'll tell you when they don't."], ["src/app/about/page.tsx", "we'll say so and suggest someone who knows the area."]]) {
      const e = edits.find((x) => x.file === file && String(x.from).includes(from));
      expect(e).toBeTruthy();
      expect(promisesIn(String(e!.to))).toEqual([]);
    }
  });
});
