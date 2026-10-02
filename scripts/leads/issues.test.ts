import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isChallengePage } from "./challenge-page";
import { openCrm, upsertLead, type Lead } from "./crm";
import {
  acceptableHook, applyIssueReport, detectIssues, hasViewportMeta, issueHook, issueReasons, issuesSpend,
  isPortalHost, isUnreadablePage, rankWithMimo, readIssues, scoreIssues, statedHours, type IssueReport,
} from "./issues";
import { callOpener, emailDraft } from "./outreach";
import { isVerifiedFact } from "./score";

const NOW = new Date("2026-09-25T02:00:00Z");

function lead(over: Partial<Lead> = {}): Lead {
  return {
    id: 500, placeId: "osm:node/1", vertical: "dental", area: "Parramatta", name: "Smile Dental", phone: "02 9999 0000",
    address: "1 Church St, Parramatta NSW 2150", website: "https://smiledental.com.au/", mapsUrl: "https://osm.org/node/1",
    rating: null, reviews: null, emails: [], emailOk: false, score: 75, pitch: "both", reasons: ["Redesign + receptionist: not mobile-friendly"],
    status: "new", owner: "", nextAt: null, lastContactAt: null, googleAt: null, createdAt: "2026-09-20T00:00:00Z",
    source: "osm", attribution: "", excluded: false, excludedReason: "", websiteSource: "osm_tag", websiteConfidence: null,
    websiteCheckedAt: null, websiteCheck: "not-checked", mergedInto: null, phoneSource: "", phoneConfidence: null, phoneCheckedAt: null, suggestedPhone: "",
    ...over,
  };
}

const filler = "<p>" + "We look after families across Western Sydney with gentle, modern dentistry. ".repeat(6) + "</p>";

function page(body: string, head = '<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="description" content="Family dentist in Parramatta, open six days.">') {
  return `<!doctype html><html><head><title>Smile Dental</title>${head}</head><body>${body}${filler}<footer>© 2026 Smile Dental</footer></body></html>`;
}

function fakeFetch(routes: Record<string, string | { status: number; body?: string } | Error>) {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    const hit = routes[url];
    if (hit instanceof Error) throw hit;
    if (hit === undefined) return new Response("not found", { status: 404 });
    if (typeof hit === "string") {
      const r = new Response(hit, { headers: { "Content-Type": "text/html" } });
      Object.defineProperty(r, "url", { value: url });
      return r;
    }
    const r = new Response(hit.body ?? "", { status: hit.status });
    Object.defineProperty(r, "url", { value: url });
    return r;
  }) as typeof fetch;
}

const deps = (routes: Parameters<typeof fakeFetch>[0]) => ({ request: fakeFetch(routes), now: NOW, crawl4ai: false as const, checkLinks: false, sleep: async () => {} });

describe("issues: detection is evidence-backed", () => {
  test("phone-only dental practice: no booking, no form -> phone_only (severe) with the pages it was checked on", async () => {
    const home = page(`<nav><a href="/about">About</a><a href="/contact">Contact us</a></nav><p>Call <a href="tel:0299990000">02 9999 0000</a></p><p>Hours: Monday – Friday 8am – 5pm, Saturday closed</p>`);
    const contact = page(`<p>Phone us on 02 9999 0000</p><a href="/">Home</a><a href="/about">About</a>`);
    const report = await detectIssues(lead(), deps({ "https://smiledental.com.au/": home, "https://smiledental.com.au/contact": contact }));
    expect(report.status).toBe("ok");
    const codes = report.issues.map((i) => i.code);
    expect(codes[0]).toBe("phone_only");
    expect(codes).toContain("no_after_hours");
    expect(codes).not.toContain("not_mobile");
    const phoneOnly = report.issues[0];
    expect(phoneOnly.evidence.url).toContain("https://smiledental.com.au/contact");
    expect(phoneOnly.evidence.seen).toMatch(/0299990000|02 9999 0000/);
    expect(report.hook).toMatch(/ring/);
    expect(["both", "receptionist"]).toContain(report.pitch);
    expect(report.score).toBeGreaterThanOrEqual(40);
    const after = report.issues.find((i) => i.code === "no_after_hours")!;
    expect(after.evidence.seen).toMatch(/5pm/);
  });

  test("a modern site with HotDoc booking and nothing wrong scores near zero and pitches none", async () => {
    const home = page(`<a href="/contact">Contact</a><a href="/about">About</a><a class="btn" href="https://www.hotdoc.com.au/medical-centres/parramatta">Book online</a><a href="tel:0299990000">Call 02 9999 0000</a>`);
    const report = await detectIssues(lead(), deps({ "https://smiledental.com.au/": home, "https://smiledental.com.au/contact": home }));
    expect(report.issues).toEqual([]);
    expect(report.pitch).toBe("none");
    expect(report.score).toBeLessThanOrEqual(5);
    expect(report.strengths.join(" ")).toContain("HotDoc");
    expect(report.hook).toBe("");
  });

  test("an Incapsula / SiteGround stub is bot-protected: audit pending, never 'not mobile-friendly'", async () => {
    const stub = `<html style="height:100%"><head><meta name="viewport" content="initial-scale=1.0"><script src="/_Incapsula_Resource?SWJIYLWA=1"></script></head><body></body></html>`;
    const report = await detectIssues(lead(), deps({ "https://smiledental.com.au/": stub }));
    expect(report.status).toBe("bot_protected");
    expect(report.issues).toEqual([]);
    expect(report.pitch).toBe("audit_pending");
    expect(report.score).toBe(0);
    const sg = `<html><head><meta http-equiv="refresh" content="0;/.well-known/sgcaptcha/?r=%2F"></meta></head></html>`;
    expect(isUnreadablePage(sg)).toBe(true);
    expect(isChallengePage(sg)).toBe(true);
  });

  test("'website' is only pitched when discovery verified there's no site", async () => {
    const unverified = await detectIssues(lead({ website: "", websiteCheckedAt: null }), deps({}));
    expect(unverified.status).toBe("no_website_unverified");
    expect(unverified.pitch).toBe("audit_pending");
    const verified = await detectIssues(lead({ website: "", websiteCheckedAt: "2026-09-24T10:00:00Z", websiteCheck: "none-verified" }), deps({}));
    expect(verified.status).toBe("no_website_verified");
    expect(verified.pitch).toBe("audit_pending"); // needs a human check before a no-website pitch (25 Sep 2026)
    expect(verified.issues[0].finding).toContain("checked 2026-09-24");
  });

  test("a portal/chain URL on file is never graded as their site", async () => {
    expect(isPortalHost("www.domain.com.au")).toBe(true);
    expect(isPortalHost("www.bupadental.com.au")).toBe(true);
    expect(isPortalHost("smiledental.com.au")).toBe(false);
    const report = await detectIssues(lead({ website: "https://www.domain.com.au/" }), deps({}));
    expect(report.status).toBe("not_their_site");
    expect(report.pitch).toBe("audit_pending");
  });

  test("HTTPS is only flagged when https:// genuinely fails", async () => {
    const home = page(`<a href="/contact">Contact</a><a href="/about">About</a><a href="https://www.hotdoc.com.au/x">Book online</a>`);
    const broken = await detectIssues(lead({ website: "http://smiledental.com.au/" }), deps({
      "http://smiledental.com.au/": home,
      "https://smiledental.com.au/": Object.assign(new TypeError("fetch failed"), { cause: { code: "ERR_TLS_CERT_ALTNAME_INVALID" } }),
    }));
    expect(broken.issues.map((i) => i.code)).toContain("no_https");
    const fine = await detectIssues(lead({ website: "http://smiledental.com.au/" }), deps({ "http://smiledental.com.au/": home, "https://smiledental.com.au/": home }));
    expect(fine.issues.map((i) => i.code)).not.toContain("no_https");
  });

  test("no viewport tag at all -> not_mobile; any attribute order counts as present", async () => {
    expect(hasViewportMeta('<meta content="width=device-width" name="viewport">')).toBe(true);
    expect(hasViewportMeta("<meta name=viewport content=width=device-width>")).toBe(true);
    expect(hasViewportMeta('<meta name="description" content="x">')).toBe(false);
    const home = page(`<a href="/contact">Contact</a><a href="/about">About</a><a href="https://www.hotdoc.com.au/x">Book online</a>`, "<title>x</title>");
    const report = await detectIssues(lead(), deps({ "https://smiledental.com.au/": home }));
    expect(report.issues.map((i) => i.code)).toContain("not_mobile");
  });

  test("statedHours reads early closes and weekend closures, quoting the page", () => {
    expect(statedHours("Opening Hours: Monday: 8am – 5.30pm Tuesday 8am – 5pm")?.closesEarly).toBe(true);
    expect(statedHours("Mon–Fri 8am – 8pm, Sat 9am – 1pm")).toBeNull();
    const weekend = statedHours("We are open Mon-Fri 8am - 8pm. Sunday: Closed.");
    expect(weekend?.closedWeekend).toBe(true);
    expect(weekend?.snippet).toContain("Sunday: Closed");
  });
});

describe("issues: scoring rewards fixable, evidenced problems", () => {
  const issue = (code: any, severity: 1 | 2 | 3, offer: "redesign" | "receptionist" | "both") =>
    ({ code, severity, offer, finding: code, short: code, say: code, evidence: { url: "https://x.com.au/", seen: "x", source: "site" as const } });
  test("phone-only dental with 40+ reviews outranks a site with only minor tidy-ups", () => {
    const hot = scoreIssues({ status: "ok", issues: [issue("phone_only", 3, "both")], strengths: [] }, { vertical: "dental", reviews: 45 });
    const minor = scoreIssues({ status: "ok", issues: [issue("seo_basics", 1, "redesign"), issue("no_tap_to_call", 1, "redesign")], strengths: ["HTTPS", "mobile viewport set", "online booking (HotDoc)", "© 2026"] }, { vertical: "dental", reviews: 45 });
    expect(hot.score).toBeGreaterThan(40);
    expect(minor.score).toBeLessThanOrEqual(20);
    expect(minor.pitch).toBe("none");
    expect(hot.pitch).toBe("receptionist"); // one contact-path issue alone is a receptionist pitch, not a redesign
  });
  test("redesign needs real weight: one moderate redesign issue alone isn't a redesign pitch", () => {
    const one = scoreIssues({ status: "ok", issues: [issue("no_cta", 2, "redesign")], strengths: [] }, { vertical: "legal", reviews: null });
    expect(one.pitch).toBe("none");
    const severe = scoreIssues({ status: "ok", issues: [issue("not_mobile", 3, "redesign")], strengths: [] }, { vertical: "legal", reviews: null });
    expect(severe.pitch).toBe("redesign");
  });
});

describe("issues: deterministic ranking and grounded hooks", () => {
  const base: IssueReport = {
    leadId: 500, checkedAt: NOW.toISOString(), website: "https://smiledental.com.au/", auditedUrl: "https://smiledental.com.au/", via: "fetch",
    status: "ok", statusNote: "", strengths: [], hook: "the rule hook", hookSource: "rule", score: 50, pitch: "both", verdict: "Receptionist + redesign: x",
    issues: [
      { code: "no_after_hours", finding: "Stated hours finish by 6 pm", short: "closes by 6 pm", say: "your hours finish around 5", evidence: { url: "https://smiledental.com.au/", seen: 'hours: "Mon 8am – 5pm"', source: "site" }, severity: 2, offer: "receptionist" },
      { code: "phone_only", finding: "Phone is the only way in", short: "phone-only", say: "the only way to book is to ring", evidence: { url: "https://smiledental.com.au/", seen: "no form", source: "site" }, severity: 3, offer: "both" },
    ],
  };

  test("acceptableHook rejects hype and numbers that aren't in the evidence", () => {
    expect(acceptableHook("the only way to book with you online is to ring, and your hours finish at 5pm", base)).toBe(true);
    expect(acceptableHook("you're losing 30 patients a week to missed calls", base)).toBe(false);
    expect(acceptableHook("we can guarantee more bookings!", base)).toBe(false);
    // Never reads the business its own number, and must be about the top issue (hours here).
    expect(acceptableHook("your hours finish at 5pm and the only number is 02 9999 0000", base)).toBe(false);
    expect(acceptableHook("your phone number isn't a tap-to-call link on mobile", base)).toBe(false);
  });

  test("ranking is deterministic even when the legacy paid switch is enabled", async () => {
    let calls=0;
    const result=await rankWithMimo(base, lead(), { env: {MIMO_BULK:"1"}, request:(async()=>{calls++; throw new Error("must not call provider");}) as typeof fetch });
    expect(calls).toBe(0);
    expect(result.costUsd).toBe(0);
    expect(result.report.hookSource).toBe("rule");
    expect(result.report.hook).toBe(result.report.issues[0].say);
    expect(result.report.issues.map(i=>i.severity)).toEqual([...result.report.issues.map(i=>i.severity)].sort((a,b)=>b-a));
    expect(issuesSpend("not-a-ledger")).toBe(0);
    expect(result.skipped).toContain("no model");
  });
});

describe("issues: storage, exclusions and openers", () => {
  test("applyIssueReport rescores a normal lead, refuses our own client and won leads; readIssues never creates the table", () => {
    const dir = mkdtempSync(join(tmpdir(), "issues-crm-"));
    const db = openCrm(join(dir, "crm.sqlite"));
    try {
      const base = { vertical: "dental" as const, area: "Parramatta", address: "", website: "https://smiledental.com.au/", mapsUrl: "", rating: null, reviews: null, emails: [], emailOk: false, score: 75, pitch: "both" as const, reasons: ["old"], googleAt: null };
      const a = upsertLead(db, { ...base, placeId: "a", name: "Smile Dental", phone: "0299990000" });
      expect(readIssues(db, a.id)).toBeNull();
      expect(db.query("SELECT 1 FROM sqlite_master WHERE name = 'lead_issues'").get()).toBeNull();
      const report: IssueReport = {
        leadId: a.id, checkedAt: NOW.toISOString(), website: base.website, auditedUrl: base.website, via: "fetch", status: "ok", statusNote: "",
        strengths: [], hook: "the only way to book is to ring", hookSource: "rule", score: 62, pitch: "both", verdict: "Receptionist + redesign: phone-only contact",
        issues: [{ code: "phone_only", finding: "Phone is the only way in", short: "phone-only", say: "the only way to book is to ring", evidence: { url: base.website, seen: "no form", source: "site" }, severity: 3, offer: "both" }],
      };
      expect(applyIssueReport(db, a, report)).toBe(true);
      const row = db.query("SELECT score, pitch, reasons FROM leads WHERE id = ?").get(a.id) as any;
      expect(row.score).toBe(62);
      expect(JSON.parse(row.reasons)[1]).toBe("Phone is the only way in — seen on https://smiledental.com.au/ (2026-09-25)");
      expect(isVerifiedFact(JSON.parse(row.reasons)[1])).toBe(true);
      expect(issueHook(db, { ...a, status: "new" })).toBe("the only way to book is to ring");
      expect(applyIssueReport(db, { ...a, id: 32 }, report)).toBe(false);
      expect(applyIssueReport(db, { ...a, status: "won" }, report)).toBe(false);
      expect(applyIssueReport(db, { ...a, status: "do_not_contact" }, report)).toBe(false);
      expect(issueHook(db, { ...a, status: "do_not_contact" })).toBeNull();
      expect(issueReasons(report)[0]).toBe(report.verdict);
    } finally {
      db.close();
    }
  });

  test("the issue-led opener still identifies M&U and asks permission; the email keeps the opt-out", () => {
    const opener = callOpener({ name: "Smile Dental", vertical: "dental", reasons: [], hook: "the only way to book online is to ring." });
    expect(opener).toMatch(/^Hi, it's Usman from M&U Ventures/);
    expect(opener).toContain("noticed the only way to book online is to ring. Have you got 30 seconds");
    const d = emailDraft({ name: "Smile Dental", vertical: "dental", reasons: ["Receptionist: x"], pitch: "both", hook: "the only way to book online is to ring" });
    expect(d.body).toContain("noticed the only way to book online is to ring");
    expect(d.body).toContain('Reply "stop"');
  });

  test("a real page that loads reCAPTCHA on its contact form is not a challenge page", () => {
    const real = page('<form><input type="email" name="email"><textarea></textarea></form><script src="https://www.google.com/recaptcha/api.js"></script>') + filler.repeat(5);
    expect(isChallengePage(real)).toBe(false);
    expect(isChallengePage('<html><body><script src="https://www.google.com/recaptcha/api.js"></script>Please verify.</body></html>')).toBe(true);
  });
});
