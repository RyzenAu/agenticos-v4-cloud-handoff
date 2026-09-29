// Founder-triggered lead previews: templates, fill safeguards, the registry and deploy/take-down
// — all against synthetic fixtures and a fake PowerShell runner (never Vercel, never the real CRM).
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activities, openCrm, upsertLead, findLead, logActivity } from "../leads/crm";
import type { Evidence } from "../site-draft/evidence";
import { deployPreview, MAX_LIVE_PREVIEWS, redact, takeDownPreview, type Shell } from "./deploy";
import { bannerText, escapeHtml, factsFromEvidence, fillTemplate, previewDomain, previewSlug, stampExpiry, vercelConfig, type PreviewFacts } from "./fill";
import { generatePreview, previewBlocker, previewProject } from "./generate";
import { daysLeft, isExpired, readRegistry, upsertPreview, type PreviewRecord } from "./registry";
import { applyRewrite, residueIn, TEMPLATE_SPECS, visibleText } from "./templates";
import { publicSiteUrl } from "./thumb";

const LEGAL_FIXTURE = `<!doctype html><html><head><title>Marden &amp; Rowe | Solicitors</title><meta name="description" content="Marden &amp; Rowe"><meta name="robots" content="noindex"></head><body>
<p class="demo-note">Demo website by M&amp;U. Marden &amp; Rowe is fictional.</p>
<header class="site-header"><a class="wordmark" href="#top">Marden &amp; Rowe</a><nav class="nav"><a href="#services">Areas</a><a href="#prepare">First meeting</a><a class="btn" href="tel:+61255500188"><span class="long">Call (02) 5550 0188</span></a></nav></header>
<h1 class="display">Talk it through with a Leichhardt solicitor.</h1><p class="lede">Marden &amp; Rowe, 88 Norton Street, Leichhardt.</p>
<form class="hero-control" action="#prepare"><select></select></form><p class="hero-alt">call (02) 5550 0188</p>
<section class="statement" aria-label="About Marden &amp; Rowe"><p>Most matters start with one conversation.</p></section>
<section class="services"><h2 class="services-title">Areas of practice</h2><div class="services-intro"><p>We don't act in family law.</p></div>
<ul class="svc-list"><li class="svc" style="--i:0"><span class="svc-name">Property</span><span class="svc-scope">Buying</span></li><li class="svc" style="--i:1"><span class="svc-name">Wills</span><span class="svc-scope">Estates</span></li></ul></section>
<section class="tool-section" id="prepare">tool</section>
<section class="finale"><h2 class="call-title">Visit Marden &amp; Rowe</h2><p class="big big--lead">88 Norton Street</p><div class="finale-side"><p>Suite 4, 88 Norton Street. Monday to Friday, 8:30am to 5:30pm.</p><a href="tel:+61255500188">Call</a></div></section>
<footer><div class="footer-grid">Marden &amp; Rowe (02) 5550 0188</div><p class="footer-mark">Marden &amp; Rowe</p></footer>
<nav class="callbar"><a href="tel:+61255500188">Call us</a></nav><script type="application/json" id="tool-data">{}</script></body></html>`;

function evidenceFor(overrides: Partial<Evidence> = {}): Evidence {
  const fact = (field: string, value: string, category: any = "business") => ({ category, field, value, sourceUrl: "https://www.openstreetmap.org/", sourceLabel: "OpenStreetMap", observedAt: "2026-09-24T00:00:00Z", status: value ? "verified" as const : "missing" as const });
  return {
    leadId: 1, name: "Harbour & Co Lawyers", vertical: "legal", area: "Penrith NSW", generatedAt: "2026-09-24T00:00:00Z",
    facts: [fact("name", "Harbour & Co Lawyers"), fact("suburb", "Penrith", "location"), fact("address", "1 Test Street, Penrith NSW 2750", "location"), fact("phone", "(02) 4700 0000", "contact")],
    services: [{ category: "service", field: "service", value: "Workers compensation", sourceUrl: "https://harbour.example/services", sourceLabel: "Business's own website", observedAt: "2026-09-24T00:00:00Z", status: "verified" }],
    hasOwnWebsite: true, ownSiteReachable: true, robotsBlocked: false, complianceNotes: [],
    ...overrides,
  };
}
const LEAD_BITS = { website: "https://harbour.example/", emails: [], emailOk: false };

async function legalTemplate() {
  return applyRewrite(LEGAL_FIXTURE, TEMPLATE_SPECS.legal);
}

describe("templates", () => {
  test("the legal rewrite removes every flagship identity fact and leaves tokens", async () => {
    const out = await legalTemplate();
    expect(residueIn(out, TEMPLATE_SPECS.legal)).toEqual([]);
    expect(out).toContain("{{BUSINESS}}");
    expect(out).toContain("<!--MU:REPEAT-->");
    expect(out).toContain("<!--MU:HEAD-->");
    expect(out).toContain("<!--MU:BODY-->");
    expect(out).not.toContain("tool-section");
    expect(out).not.toContain('name="robots" content="noindex">'); // flagship's own robots tag replaced at fill time
    expect(out.match(/class="svc"/g)?.length).toBe(1); // one repeatable item, not the flagship's list
  });

  test("residue check catches a surviving flagship name", () => {
    expect(residueIn("<p>Call Marden &amp; Rowe</p>", TEMPLATE_SPECS.legal).length).toBeGreaterThan(0);
    expect(residueIn('<img alt="Lantern Dental room">', TEMPLATE_SPECS.dental).length).toBeGreaterThan(0);
    expect(visibleText("<style>.Aldergate{}</style><p>ok</p>")).not.toContain("Aldergate");
  });
});

describe("fill", () => {
  test("fills from verified evidence with every safeguard in place", async () => {
    const facts = factsFromEvidence(evidenceFor(), LEAD_BITS);
    const html = fillTemplate(await legalTemplate(), facts, "legal", { now: new Date("2026-09-24T00:00:00Z") });
    expect(html).toContain(escapeHtml(bannerText("Harbour & Co Lawyers")));
    expect(html).toContain('content="noindex, nofollow, noarchive, nosnippet"');
    expect(html).toContain("form-action 'none'");
    expect(html).toContain("connect-src 'self'"); // own RSC prefetches only — nothing third-party
    expect(html).toContain('data-mu-expires="2026-10-24T00:00:00.000Z"');
    expect(html).toContain("Workers compensation");
    expect(html).toContain("tel:(02)4700 0000".replace(/[()\s]/g, ""));
    expect(html).not.toContain("hero-control"); // the flagship's topic picker is gone
    expect(html).not.toMatch(/\{\{/);
    expect(residueIn(html, TEMPLATE_SPECS.legal)).toEqual([]);
  });

  test("missing facts become neutral placeholders, never guesses", async () => {
    const ev = evidenceFor({ services: [] });
    ev.facts = ev.facts.map((f) => (f.field === "phone" || f.field === "address" ? { ...f, value: "", status: "missing" as const } : f));
    const facts = factsFromEvidence(ev, LEAD_BITS);
    const html = fillTemplate(await legalTemplate(), facts, "legal");
    expect(html).toContain("Phone to be confirmed");
    expect(html).toContain("Penrith (street address to be confirmed)");
    expect(html).toContain("To be confirmed with Harbour &amp; Co Lawyers");
    expect(html).toContain("Opening hours to be confirmed");
    expect(html).toContain('href="#visit"'); // no tel: link without a verified number
  });

  test("escapes business names and service text", async () => {
    const facts: PreviewFacts = { ...factsFromEvidence(evidenceFor(), LEAD_BITS), business: '<script>alert(1)</script>', services: [{ name: "<b>x</b>", sourceUrl: "https://a.example/" }] };
    const html = fillTemplate(await legalTemplate(), facts, "legal");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toContain("<b>x</b>");
  });

  test("an unverified email or opted-out lead never shows an email", () => {
    expect(factsFromEvidence(evidenceFor(), { ...LEAD_BITS, emails: ["a@b.com.au"], emailOk: false }).email).toBe("");
    expect(factsFromEvidence(evidenceFor(), { ...LEAD_BITS, emails: ["a@b.com.au"], emailOk: true }).email).toBe("a@b.com.au");
  });

  test("slug, domain, expiry stamp and vercel headers", () => {
    expect(previewSlug("St Clair Dental", 1)).toBe("st-clair-dental");
    expect(previewSlug("Brown & Co.", 2)).toBe("brown-and-co");
    expect(previewSlug("!!!", 7)).toBe("lead-7");
    expect(previewDomain("st-clair-dental")).toBe("st-clair-dental.muventures.com.au");
    expect(() => previewDomain("bad..slug")).toThrow();
    expect(stampExpiry('<div data-mu-expires="old">', "2027-01-01T00:00:00.000Z")).toContain('data-mu-expires="2027-01-01T00:00:00.000Z"');
    const cfg = JSON.parse(vercelConfig());
    const headers = cfg.headers[0].headers.map((h: any) => `${h.key}: ${h.value}`).join("\n");
    expect(headers).toContain("X-Robots-Tag: noindex");
    expect(headers).toContain("form-action 'none'");
    expect(previewProject("st-clair-dental")).toBe("mu-preview-st-clair-dental");
  });
});

describe("registry", () => {
  test("expiry is surfaced after 30 days", () => {
    const rec = { status: "live" as const, expiresAt: "2026-10-24T00:00:00.000Z" };
    expect(daysLeft(rec, new Date("2026-10-20T00:00:00Z"))).toBe(4);
    expect(isExpired(rec, new Date("2026-10-20T00:00:00Z"))).toBe(false);
    expect(isExpired(rec, new Date("2026-10-25T00:00:00Z"))).toBe(true);
    expect(isExpired({ ...rec, status: "taken_down" }, new Date("2026-11-25T00:00:00Z"))).toBe(false);
  });
});

describe("thumbnails", () => {
  test("only public http(s) sites are captured", () => {
    expect(publicSiteUrl("example.com.au")).toBe("https://example.com.au/");
    expect(publicSiteUrl("http://127.0.0.1:8081")).toBeNull();
    expect(publicSiteUrl("http://192.168.1.2")).toBeNull();
    expect(publicSiteUrl("file:///c:/x")).toBeNull();
  });
});

function fixtureWorld() {
  const root = mkdtempSync(join(tmpdir(), "lead-sites-"));
  const draftsRoot = join(root, "drafts");
  mkdirSync(join(draftsRoot, "_templates", "legal"), { recursive: true });
  const db = openCrm(join(root, ".operator-data", "crm.sqlite"));
  upsertLead(db, {
    placeId: "osm:node/1", vertical: "legal", area: "Penrith NSW", name: "Harbour & Co Lawyers", phone: "(02) 4700 0000",
    address: "1 Test Street, Penrith NSW 2750", website: "https://harbour.example/", mapsUrl: "", rating: null, reviews: null,
    emails: [], emailOk: false, score: 30, pitch: "redesign", reasons: ["there's no online booking"], googleAt: null, source: "osm",
  } as any);
  const lead = findLead(db, "osm:node/1")!;
  return { root, draftsRoot, db, lead };
}

describe("generate → deploy → take down", () => {
  test("generates locally, deploys only with the exact domain, logs every step, keeps the follow-up date", async () => {
    const { root, draftsRoot, db, lead } = fixtureWorld();
    writeFileSync(join(draftsRoot, "_templates", "legal", "index.html"), await legalTemplate(), "utf8");
    logActivity(db, lead, { kind: "call", outcome: "call_back", nextAt: "2026-10-01T00:00:00.000Z", by: "usman" });

    const gen = await generatePreview(db, lead.id, { root, draftsRoot, by: "usman", evidence: evidenceFor({ leadId: lead.id }), now: new Date("2026-09-24T00:00:00Z") });
    expect(gen.record.status).toBe("generated");
    expect(gen.dir).toBe(join(draftsRoot, "harbour-and-co-lawyers", "flagship-preview"));
    expect(existsSync(join(gen.dir, "vercel.json"))).toBe(true);
    expect(readFileSync(join(gen.dir, "index.html"), "utf8")).toContain("Not the official Harbour &amp; Co Lawyers website");
    expect(findLead(db, lead.id)!.nextAt).toBe("2026-10-01T00:00:00.000Z");

    const calls: string[][] = [];
    const shell: Shell = async (args) => { calls.push(args); return { ok: true, out: "MU_STEP deploy ok\nMU_DONE" }; };
    const check = async () => ({ status: 200, banner: true, noindexHeader: true });
    await expect(deployPreview(db, lead.id, { root, confirm: "wrong.muventures.com.au", by: "usman", shell, check, retryMs: 0 })).rejects.toThrow(/exact domain/);
    expect(calls.length).toBe(0);

    const live = await deployPreview(db, lead.id, { root, confirm: "harbour-and-co-lawyers.muventures.com.au", by: "usman", shell, check, retryMs: 0, now: new Date("2026-09-24T00:00:00Z") });
    expect(live.status).toBe("live");
    expect(live.expiresAt).toBe("2026-10-24T00:00:00.000Z");
    expect(calls[0]).toEqual(expect.arrayContaining(["-Action", "deploy", "-Project", "mu-preview-harbour-and-co-lawyers", "-Domain", "harbour-and-co-lawyers.muventures.com.au"]));
    const staged = readFileSync(join(root, ".operator-data", "lead-sites", "harbour-and-co-lawyers", "index.html"), "utf8");
    expect(staged).toContain('data-mu-expires="2026-10-24T00:00:00.000Z"');
    expect(existsSync(join(root, ".operator-data", "lead-sites", "harbour-and-co-lawyers", "PREVIEW.md"))).toBe(false);

    const down = await takeDownPreview(db, lead.id, { root, by: "mehroz", shell });
    expect(down.status).toBe("taken_down");
    expect(calls[1]).toEqual(["-Action", "takedown", "-Project", "mu-preview-harbour-and-co-lawyers"]);

    const notes = activities(db, lead.id).map((a) => a.note).join("\n");
    expect(notes).toContain("Flagship preview generated");
    expect(notes).toContain("Preview deployed to https://harbour-and-co-lawyers.muventures.com.au by usman");
    expect(notes).toContain("Preview taken down by mehroz");
    expect(findLead(db, lead.id)!.nextAt).toBe("2026-10-01T00:00:00.000Z");
  });

  test("a failed deploy is recorded, not reported as live", async () => {
    const { root, draftsRoot, db, lead } = fixtureWorld();
    writeFileSync(join(draftsRoot, "_templates", "legal", "index.html"), await legalTemplate(), "utf8");
    await generatePreview(db, lead.id, { root, draftsRoot, by: "usman", evidence: evidenceFor({ leadId: lead.id }) });
    const shell: Shell = async () => ({ ok: false, out: "MU_ERROR deploy failed token=abc123" });
    await expect(deployPreview(db, lead.id, { root, confirm: "harbour-and-co-lawyers.muventures.com.au", by: "usman", shell, retryMs: 0 })).rejects.toThrow(/Deploy failed/);
    const rec = readRegistry(root)[0];
    expect(rec.status).toBe("failed");
    expect(rec.lastError).not.toContain("abc123");
    expect(redact("key: sk-1 ok")).toBe("[redacted] ok");
  });

  test("never more than the live cap, and never for excluded or opted-out leads", async () => {
    const { root, draftsRoot, db, lead } = fixtureWorld();
    writeFileSync(join(draftsRoot, "_templates", "legal", "index.html"), await legalTemplate(), "utf8");
    await generatePreview(db, lead.id, { root, draftsRoot, by: "usman", evidence: evidenceFor({ leadId: lead.id }) });
    for (let i = 0; i < MAX_LIVE_PREVIEWS; i++)
      upsertPreview(root, { ...readRegistry(root)[0], leadId: 1000 + i, status: "live" } as PreviewRecord);
    const shell: Shell = async () => ({ ok: true, out: "MU_DONE" });
    await expect(deployPreview(db, lead.id, { root, confirm: "harbour-and-co-lawyers.muventures.com.au", by: "usman", shell, retryMs: 0 })).rejects.toThrow(/already live/);
    expect(previewBlocker({ ...lead, excluded: true, excludedReason: "chain" })).toMatch(/excluded/);
    expect(previewBlocker({ ...lead, status: "do_not_contact" })).toMatch(/not to be contacted/);
  });
});

describe("motion templates (Next.js static exports)", () => {
  const { applyEdit, tokensInRscTextRows, exportResidue, NEXT_TEMPLATE_SPECS } = require("./next-templates");
  const { exportSafe, fillExportText, finishExportHtml } = require("./fill");
  const { fillExportDir, templateHeadFor } = require("./generate");

  test("edits must match, or the build stops", () => {
    expect(applyEdit("a <b/> c", { file: "x", from: "<b/>", to: "<i/>" })).toBe("a <i/> c");
    expect(() => applyEdit("abc", { file: "x", from: "zzz", to: "" })).toThrow(/not found/);
    expect(() => applyEdit("abc", { file: "x", from: /zzz/, to: "" })).toThrow(/not found/);
  });

  test("token values are safe in HTML, JS strings and the RSC payload", () => {
    expect(exportSafe(`O'Brien "Dental" <b>{x}</b> \ \`y\``)).toBe("O’Brien ”Dental” bx/b y");
    const js = `const s={name:"{{BUSINESS}}"};self.__next_f.push([1,"{\\"n\\":\\"{{BUSINESS}}\\"}"])`;
    const out = fillExportText(js, { BUSINESS: `Smith "&" Co's` });
    expect(out).toContain('name:"Smith ”&” Co’s"');
    expect(() => new Function(out.replace("self.__next_f.push", "void"))).not.toThrow();
    expect(fillExportText("{{UNKNOWN}}", {})).toBe("{{UNKNOWN}}");
  });

  test("a token inside a length-prefixed RSC text row is refused", () => {
    const row = (text: string) => `self.__next_f.push([1,${JSON.stringify(`5:T${Buffer.byteLength(text).toString(16)},${text}`)}])`;
    expect(tokensInRscTextRows(`<script>${row("Hello {{BUSINESS}} there")}</script>`)).toEqual(["{{BUSINESS}}"]);
    expect(tokensInRscTextRows(`<script>${row("No tokens here")}</script>`)).toEqual([]);
  });

  test("filling an export adds data, safeguards and keeps the React-rendered banner", () => {
    const root = mkdtempSync(join(tmpdir(), "lead-export-"));
    const tpl = join(root, "tpl");
    mkdirSync(join(tpl, "_next", "static", "chunks"), { recursive: true });
    writeFileSync(join(tpl, "index.html"), `<html><head><meta name="robots" content="index"><title>{{TITLE}}</title></head><body><div class="mu-preview-banner" data-mu-expires="{{EXPIRES}}">{{BANNER}}</div><h1>{{BUSINESS}}</h1><script>self.__next_f.push([1,"{\\"b\\":\\"{{BUSINESS}}\\",\\"e\\":\\"{{EXPIRES}}\\"}"])</script></body></html>`);
    writeFileSync(join(tpl, "_next", "static", "chunks", "a.js"), `var site={name:"{{BUSINESS}}",phone:"{{PHONE}}"};`);
    writeFileSync(join(tpl, "template.json"), JSON.stringify({ kind: "next-export", css: "header{top:0}", head: '<link rel="preload" as="image" href="/x.webp">' }));
    const out = join(root, "out");
    const facts = factsFromEvidence(evidenceFor(), LEAD_BITS);
    fillExportDir(tpl, out, facts, "legal", new Date("2026-09-24T00:00:00Z"), templateHeadFor({ css: "header{top:0}", head: '<link rel="preload" as="image" href="/x.webp">' }));
    const html = readFileSync(join(out, "index.html"), "utf8");
    expect(html).toContain("Preview concept prepared by M&U Ventures for Harbour & Co Lawyers. Not the official Harbour & Co Lawyers website.");
    expect(html).toContain('data-mu-expires="2026-10-24T00:00:00.000Z"');
    expect(html).toContain('\\"e\\":\\"2026-10-24T00:00:00.000Z\\"'); // payload matches the markup
    expect(html).toContain('<script id="mu-preview-data" type="application/json">{"services":[{"name":"Workers compensation"');
    expect(html).toContain('content="noindex, nofollow, noarchive, nosnippet"');
    expect(html).not.toContain('content="index"');
    expect(html).toContain("header{top:0}");
    expect(html).toContain('href="/x.webp"');
    expect(html).not.toMatch(/\{\{[A-Z0-9_]+\}\}/);
    expect(readFileSync(join(out, "_next", "static", "chunks", "a.js"), "utf8")).toBe('var site={name:"Harbour & Co Lawyers",phone:"(02) 4700 0000"};');
    expect(existsSync(join(out, "template.json"))).toBe(false);
    expect(() => finishExportHtml("<html><head></head><body></body></html>", facts, "X", "", "2026-01-01T00:00:00.000Z")).toThrow(/expiry|safeguards/);
  });

  test("the export leak check scans JS chunks, not just HTML", () => {
    const dir = mkdtempSync(join(tmpdir(), "lead-residue-"));
    mkdirSync(join(dir, "_next"), { recursive: true });
    writeFileSync(join(dir, "index.html"), "<p>fine</p>");
    writeFileSync(join(dir, "_next", "c.js"), 'var n="Lantern Dental";');
    expect(exportResidue(dir, NEXT_TEMPLATE_SPECS.dental).join()).toContain("c.js");
  });
});
