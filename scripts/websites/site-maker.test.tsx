// W-F (29 Sep 2026): Websites → "Make a site" and "Jarvis, make a top-tier dental site for <lead>". Both
// build ONE site brief and open Track 3's coding DRAFT with it; nothing starts, deploys or touches DNS.
// Synthetic data only.
import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterContextProvider,
} from "@tanstack/react-router";
import {
  buildSiteRequest,
  jarvisPhrase,
  parseSiteAsk,
  PRESET_SKILLS,
  repoFor,
  SITE_BRIEF_MAX,
  SITE_REQUEST_MAX,
  SITE_SKILLS,
  SITE_VERTICALS,
  siteDraftHref,
  verticalFromWords,
  type SiteTarget,
} from "../../src/lib/site-maker";
import {
  CODING_REQUEST_MAX,
  codingCommandEntry,
  isCodingRequest,
} from "../../src/lib/commands/coding";
import { siteMakerCommandEntry } from "../../src/lib/commands/site-maker";
import { buildCommandIndex, resolveCommand } from "../../src/lib/commands/registry";
import { CONSEQUENTIAL_WORDS, objectiveFrom, templateFrom } from "../coding/shaper";
import { codingDraftFor, loadCodingDetector } from "../jarvis-command/coding";
import { commandIntent } from "../jarvis-command/words";
import { OUR_SITES } from "./catalogue";
import { MakeSite } from "../../src/components/websites/make-site";
import { SitesGlance } from "../../src/components/websites/sites-glance";
import { deployLine, previewFor } from "../../src/components/websites/glance";
import type { LocalTemplate, OurSite } from "../../src/lib/websites";

const lead: SiteTarget = {
  kind: "lead",
  leadId: 12,
  name: "Harbour Test Dental",
  area: "Parramatta",
  website: "https://harbour-test.example/",
};

describe("the site brief (src/lib/site-maker.ts)", () => {
  test("a draft takes the same length as the coding page", () => {
    expect(SITE_REQUEST_MAX).toBe(CODING_REQUEST_MAX);
  });

  test("each vertical's flagship is the catalogue's flagship repo", () => {
    for (const v of SITE_VERTICALS) {
      if (!v.flagship) continue;
      const site = OUR_SITES.find((s) => s.kind === "flagship" && s.vertical === v.id);
      expect(site?.repo).toBe(v.flagship.repo);
      expect(site?.name).toBe(v.flagship.name);
    }
  });

  test("a lead: name, suburb, their site, the flagship repo, the skills and the guard rails", () => {
    const r = buildSiteRequest({
      target: lead,
      vertical: "dental",
      brief: "Calm and premium; same-week appointments up front",
      skills: PRESET_SKILLS,
    });
    expect(r.ok).toBe(true);
    expect(r.length).toBeLessThanOrEqual(SITE_REQUEST_MAX);
    expect(r.request).toStartWith(
      "Make a top-tier dental website for Harbour Test Dental (CRM lead #12, Parramatta; their site today: harbour-test.example)",
    );
    expect(r.request).toContain(
      "in the muv-demo-dental repo, starting from the Lantern Dental flagship on this job's own branch",
    );
    expect(r.request).toContain("Brief: Calm and premium; same-week appointments up front.");
    for (const id of PRESET_SKILLS) expect(r.request).toContain(id);
    expect(r.request).toContain("Claims only from public evidence");
    expect(r.request).toContain("Reduced-motion fallbacks");
    expect(r.request).toContain("No paid image or video generation.");
    expect(r.request).toContain("Stay local: nothing goes live, no DNS.");
    expect(r.request).toContain("1440 and 390");
  });

  test("never puts a phone number or email into the brief, even if the lead object carries them", () => {
    const leaky = {
      ...lead,
      phone: "0400 000 000",
      emails: ["front@harbour-test.example"],
    } as SiteTarget;
    const r = buildSiteRequest({ target: leaky, vertical: "dental", skills: PRESET_SKILLS });
    expect(r.request).not.toContain("0400");
    expect(r.request).not.toContain("@");
  });

  test("the coding shaper keeps the whole brief, adds no merge step and keeps build + review", () => {
    const r = buildSiteRequest({
      target: lead,
      vertical: "dental",
      brief: "Warm, local, no stock photos",
      skills: SITE_SKILLS.map((s) => s.id),
    });
    expect(CONSEQUENTIAL_WORDS.test(r.request)).toBe(false);
    expect(objectiveFrom(r.request).length).toBeGreaterThanOrEqual(r.request.length - 2);
    expect(templateFrom(r.request)).toBe("build+review");
  });

  test("paid skills are named and gated on the owner's approval of the exact spend", () => {
    const r = buildSiteRequest({
      target: lead,
      vertical: "dental",
      skills: [...PRESET_SKILLS, "mu-killer-site", "generate-asset"],
    });
    expect(r.request).toContain(
      "Paid generation (generate-asset, mu-killer-site) only after the owner approves the exact spend.",
    );
    expect(r.request).not.toContain("No paid image");
  });

  test("a brief that's too long is refused with the reason; nothing is cut", () => {
    const long = "word ".repeat(80);
    const r = buildSiteRequest({
      target: lead,
      vertical: "dental",
      brief: long,
      skills: PRESET_SKILLS,
    });
    expect(r.ok).toBe(false);
    if (!r.ok)
      expect(r.reason).toBe(
        `The brief is over ${SITE_BRIEF_MAX} characters. Shorten it; nothing is cut.`,
      );
    const all = buildSiteRequest({
      target: lead,
      vertical: "other",
      otherVertical: "physiotherapy clinic",
      brief: "x".repeat(SITE_BRIEF_MAX),
      skills: SITE_SKILLS.map((s) => s.id),
    });
    expect(all.length).toBeGreaterThan(SITE_REQUEST_MAX);
    expect(all.ok).toBe(false);
    if (!all.ok) expect(all.reason).toContain("nothing is cut");
  });

  test("just a brief needs a line of brief", () => {
    const r = buildSiteRequest({
      target: { kind: "brief" },
      vertical: "trades",
      skills: PRESET_SKILLS,
    });
    expect(r.ok).toBe(false);
    const ok = buildSiteRequest({
      target: { kind: "brief" },
      vertical: "trades",
      brief: "Emergency plumber, 24/7",
      skills: PRESET_SKILLS,
    });
    expect(ok.ok).toBe(true);
    expect(ok.request).toStartWith("Make a top-tier trades website from the brief below");
  });

  test("repos: our own site in its own repo; trades starts from the dental flagship and says why", () => {
    expect(
      repoFor(
        {
          kind: "site",
          siteId: "bianca",
          name: "Bianca Brown Realty",
          repo: "bianca-brown-realty",
          client: true,
        },
        "real-estate",
      ),
    ).toMatchObject({ repo: "bianca-brown-realty", startsFrom: null });
    const trades = repoFor({ kind: "brief" }, "trades");
    expect(trades.repo).toBe("muv-demo-dental");
    expect(trades.why).toContain("No trades");
    expect(repoFor(lead, "legal").repo).toBe("muv-flagship-legal");
    expect(repoFor(lead, "real-estate").repo).toBe("aldergate");
    const site = buildSiteRequest({
      target: {
        kind: "site",
        siteId: "bianca",
        name: "Bianca Brown Realty",
        repo: "bianca-brown-realty",
        url: "https://bianca.example",
        client: true,
      },
      vertical: "real-estate",
      skills: PRESET_SKILLS,
    });
    expect(site.request).toStartWith(
      "Make the Bianca Brown Realty site top-tier (M&U's client, bianca.example), in the bianca-brown-realty repo, on this job's own branch.",
    );
  });

  test("a picked repo overrides, but only a plain repo id", () => {
    expect(
      buildSiteRequest({ target: lead, vertical: "dental", skills: [], repo: "muv-marketing" })
        .request,
    ).toContain("in the muv-marketing repo");
    expect(
      buildSiteRequest({ target: lead, vertical: "dental", skills: [], repo: "../../etc" }).request,
    ).toContain("in the muv-demo-dental repo");
  });

  test("the draft link is Track 3's /coding?request=", () => {
    expect(siteDraftHref("Make a site")).toBe("/coding?request=Make+a+site");
    expect(jarvisPhrase(lead, "dental")).toBe(
      "Make a top-tier dental site for Harbour Test Dental",
    );
    expect(jarvisPhrase({ kind: "brief" }, "other", "physio clinic")).toBe(
      "Make a top-tier physio clinic site",
    );
  });

  test("verticals from words", () => {
    expect(verticalFromWords("St Clair Dental")).toBe("dental");
    expect(verticalFromWords("Brander Smith McKnight Lawyers")).toBe("legal");
    expect(verticalFromWords("Wish Real Estate")).toBe("real-estate");
    expect(verticalFromWords("Parra Plumbing")).toBe("trades");
    expect(verticalFromWords("Jo's Cafe")).toBeNull();
  });
});

describe('Jarvis: "make a top-tier dental site for <lead>"', () => {
  test("parses the vertical and the name; needs one of them", () => {
    expect(parseSiteAsk("make a top-tier dental site for Harbour Test Dental")).toEqual({
      vertical: "dental",
      otherVertical: null,
      name: "Harbour Test Dental",
      quality: "top-tier",
    });
    expect(
      parseSiteAsk("Hey Jarvis, can you build me a killer website for the lead St Clair Dental?"),
    ).toMatchObject({ vertical: "dental", name: "St Clair Dental" });
    expect(parseSiteAsk("create a new real estate website")).toMatchObject({
      vertical: "real-estate",
      name: null,
    });
    expect(parseSiteAsk("make a physio clinic site for Move Well")).toMatchObject({
      vertical: "other",
      otherVertical: "physio clinic",
      name: "Move Well",
    });
    expect(parseSiteAsk("design a premium law firm website for Brander Smith")).toMatchObject({
      vertical: "legal",
      name: "Brander Smith",
    });
    for (const not of [
      "make a website",
      "make a site map",
      "make the dental site faster",
      "fix the header layout in the dental site",
      "open websites",
      "draft a website for Harbour Test Dental",
    ])
      expect(parseSiteAsk(not)).toBeNull();
  });

  test("the command entry opens the coding draft with the full site brief (nothing starts)", () => {
    const e = siteMakerCommandEntry("make a top-tier dental site for Harbour Test Dental");
    expect(e?.id).toBe("websites:make-site");
    expect(e?.action).toMatchObject({ type: "navigate", to: "/coding" });
    const request = e?.action.type === "navigate" ? (e.action.search?.request ?? "") : "";
    expect(request).toStartWith(
      "Make a top-tier dental website for Harbour Test Dental (look them up in the CRM leads and their public sources), in the muv-demo-dental repo",
    );
    for (const id of PRESET_SKILLS) expect(request).toContain(id);
    expect(request.length).toBeLessThanOrEqual(CODING_REQUEST_MAX);
    expect(e?.detail).toContain("nothing starts until you confirm");
  });

  test("typed (palette/registry) and the coding entry reach the same draft; other coding words are unchanged", () => {
    const words = "make a top-tier dental site for Harbour Test Dental";
    const viaCoding = codingCommandEntry(words);
    const viaRegistry = resolveCommand(words, buildCommandIndex());
    expect(viaRegistry.status).toBe("resolved");
    if (viaRegistry.status === "resolved") expect(viaRegistry.entry).toEqual(viaCoding!);
    const fix = codingCommandEntry("fix the header layout in the dental site");
    expect(fix?.id).toBe("coding:request");
    expect(codingCommandEntry("open websites")).toBeNull();
  });

  test("spoken and typed Ask Jarvis: the voice coding rules don't grab it, the command entry opens the site draft", async () => {
    const words = "Jarvis, make a top-tier dental site for Harbour Test Dental";
    // scripts/coding/voice.ts uses isCodingRequest: it must not shape the raw words before the entry sees them.
    expect(isCodingRequest(words)).toBe(false);
    // …even when the name itself holds a coding word ("Test", "App"), which T3's detector would match.
    expect(isCodingRequest("make a top-tier dental site for Parra App Dental")).toBe(false);
    expect(isCodingRequest("fix the header layout in the dental site")).toBe(true);
    expect(await loadCodingDetector()).toBe(true);
    const draft = codingDraftFor(words);
    expect(draft?.path).toStartWith(
      "/coding?request=Make+a+top-tier+dental+website+for+Harbour+Test+Dental",
    );
    expect(commandIntent(words)?.why).toContain("coding");
  });
});

// ── the page ─────────────────────────────────────────────────────────────

const router = createRouter({
  routeTree: createRootRoute(),
  history: createMemoryHistory({ initialEntries: ["/websites"] }),
});
const render = (el: React.ReactElement) =>
  renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: new QueryClient() },
      createElement(RouterContextProvider, { router }, el),
    ),
  );

const site = (over: Partial<OurSite>): OurSite => ({
  id: "synthetic",
  kind: "flagship",
  name: "Synthetic Dental",
  vertical: "dental",
  url: "https://synthetic-dental.example",
  alsoAt: [],
  project: "synthetic-dental",
  linkedProject: null,
  deployedAt: null,
  repo: { path: "C:/synthetic/repos/synthetic-dental", exists: true, commit: null },
  brief: null,
  thumb: null,
  ...over,
});

describe("Websites page: Make a site and At a glance", () => {
  test("Make a site shows the four steps, the top-tier skills and a draft button that waits until it's ready", () => {
    const html = render(<MakeSite sites={[site({})]} />);
    for (const s of [
      "Make a site",
      "Who it&#x27;s for",
      "Vertical",
      "Skills",
      "Brief (optional)",
      "Create coding draft",
      "Ask Jarvis instead",
      "Top-tier set",
    ])
      expect(html).toContain(s);
    for (const v of SITE_VERTICALS) expect(html).toContain(`>${v.label}</button>`);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Create coding draft/);
    expect(html).toContain("Nothing deploys, publishes or changes DNS from here.");
    expect(html).not.toMatch(/>\s*Deploy\b/);
    // The top-tier skills are already set; who and the vertical are still to do (the brief is optional here).
    expect(html).toContain('aria-label="1 of 3 steps set"');
    expect(html).toContain("2 steps to go");
  });

  test("At a glance: live address, preview and last deploy, with an honest dash when unknown", () => {
    const vercel = { error: "vercel CLI not found", at: null };
    expect(deployLine(site({}), vercel)).toEqual({
      text: "— Vercel couldn't be read",
      known: false,
    });
    expect(deployLine(site({}), { error: null, at: null }).text).toBe("— not checked yet");
    expect(deployLine(site({}), { error: null, at: "2026-09-29T00:00:00.000Z" }).text).toBe(
      "— not in the Vercel listing",
    );
    expect(
      deployLine(site({ deployedAt: new Date(Date.now() - 3 * 86_400_000).toISOString() }), vercel)
        .known,
    ).toBe(true);
    const templates: LocalTemplate[] = [
      {
        vertical: "dental",
        flagship: "synthetic",
        builtAt: null,
        kind: null,
        localUrl: "http://tpl-dental.localhost:8091/",
        thumb: null,
      },
    ];
    expect(previewFor(site({ alsoAt: ["https://synthetic-preview.example"] }), templates)).toEqual({
      href: "https://synthetic-preview.example",
      label: "synthetic-preview.example",
    });
    expect(previewFor(site({}), templates)).toEqual({
      href: "http://tpl-dental.localhost:8091/",
      label: "Local template",
    });
    expect(previewFor(site({ kind: "client" }), templates)).toBeNull();
    const html = render(
      <SitesGlance
        sites={[site({}), site({ id: "c", kind: "client", name: "Synthetic Client" })]}
        templates={templates}
        vercel={vercel}
      />,
    );
    expect(html).toContain("synthetic-dental.example");
    expect(html).toContain("Synthetic Client");
    expect(html).toContain("— Vercel couldn&#x27;t be read");
    expect(html).toContain("Local template");
  });
});
