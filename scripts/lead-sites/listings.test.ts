// G-15: a real-estate preview shows the business's own listings, or an honest empty state (never the template's example stock).
import { describe, expect, test } from "bun:test";
import { preparedRealEstateSource } from "./prepared-source-helper";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findLead, openCrm, upsertLead } from "../leads/crm";
import type { Evidence } from "../site-draft/evidence";
import { generatePreview } from "./generate";
import { normaliseListings } from "./listings";

const now = new Date("2026-10-03T00:00:00Z");
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360f8cfc0000003010100c9fe92ef0000000049454e44ae426082", "hex");
const fact = (field: string, value: string, category: any = "business") => ({ category, field, value, sourceUrl: "https://own.example/", sourceLabel: "Fictional fixture", observedAt: "2026-10-03T00:00:00Z", status: value ? ("verified" as const) : ("missing" as const) });

function evidence(leadId: number): Evidence {
  return {
    leadId, name: "Tallowmere Property", vertical: "real-estate" as any, area: "Marrow Creek NSW", generatedAt: "2026-10-03T00:00:00Z",
    facts: [fact("name", "Tallowmere Property"), fact("suburb", "Marrow Creek", "location"), fact("address", "3/22 Quarry Lane, Marrow Creek NSW 2999", "location"), fact("phone", "(02) 5550 0171", "contact")],
    services: [{ ...fact("service", "Residential sales", "service"), category: "service" }],
    hasOwnWebsite: true, ownSiteReachable: true, robotsBlocked: false, complianceNotes: [],
  } as Evidence;
}

/** A minimal exported real-estate template: the home page and the ONE placeholder property page, in the layout Next 16 writes. */
function world() {
  const root = mkdtempSync(join(tmpdir(), "r8-listings-"));
  const draftsRoot = join(root, "drafts");
  const t = join(draftsRoot, "_templates", "real-estate");
  mkdirSync(join(t, "property", "preview-listing", "__next.property", "$d$slug"), { recursive: true });
  writeFileSync(join(t, "index.html"), `<html><head><title>{{TITLE}}</title></head><body data-mu-property-experience="v3"><div class="mu-preview-banner" data-mu-expires="{{EXPIRES}}">{{BANNER}}</div><h1>{{BUSINESS}}</h1></body></html>`);
  writeFileSync(join(t, "property", "preview-listing.html"), `<html><head></head><body><div class="mu-preview-banner" data-mu-expires="{{EXPIRES}}">{{BANNER}}</div><main data-slug="preview-listing">{{BUSINESS}}</main></body></html>`);
  writeFileSync(join(t, "property", "preview-listing.txt"), "slug:preview-listing {{BUSINESS}}");
  writeFileSync(join(t, "property", "preview-listing", "__next._tree.txt"), "tree preview-listing");
  writeFileSync(join(t, "property", "preview-listing", "__next.property", "$d$slug", "__PAGE__.txt"), "page preview-listing");
  writeFileSync(join(t, "template.json"), JSON.stringify({ kind: "next-export", css: "", head: "" }));
  const db = openCrm(join(root, ".operator-data", "crm.sqlite"));
  upsertLead(db, { placeId: "t:1", vertical: "real-estate", area: "Marrow Creek NSW", name: "Tallowmere Property", phone: "", address: "", website: "https://own.example/", mapsUrl: "", rating: null, reviews: null, emails: [], emailOk: false, score: 1, pitch: "", reasons: [], googleAt: null, source: "osm" } as any);
  return { root, draftsRoot, db, lead: findLead(db, "t:1")! };
}

const dataOf = (indexHtml: string) => JSON.parse(/<script id="mu-preview-data" type="application\/json">([\s\S]*?)<\/script>/.exec(indexHtml)![1]);

describe("G-15 listings input", () => {
  test("statuses, prices, photos and portal links map as the contract says", () => {
    const dir = mkdtempSync(join(tmpdir(), "r8-ph-"));
    writeFileSync(join(dir, "a.png"), PNG);
    writeFileSync(join(dir, "fake.jpg"), "not an image");
    const out = normaliseListings(
      [
        { id: "1", status: "for-sale", address: "9 Ironbark Rise, Marrow Creek", price: "Guide AUD 1,150,000", photos: ["a.png", { file: "fake.jpg" }, "https://cdn.example/x.jpg"], portalUrl: "https://portal.example/l/1", beds: 3 },
        { id: "2", status: "for-sale", address: "2/40 Saltbush Parade, Marrow Creek" },
        { id: "3", status: "sold", address: "17 Currawong Close, Marrow Creek", result: "Sold AUD 980,000" },
        { id: "4", status: "sold", address: "5 Lantana Way, Marrow Creek" },
        { id: "5", status: "for-rent", address: "11/8 Wharf Road, Marrow Creek", price: "AUD 720 per week" },
        { id: "6", status: "leased", address: "28 Stringybark Avenue, Marrow Creek" },
        { id: "7", status: "withdrawn", address: "1 Pinnacle Court, Marrow Creek" },
        { id: "8", status: "gone", address: "x" },
        { id: "9", status: "for-sale" },
      ] as any,
      { photosRoot: dir, now },
    );
    const by = (id: string) => out.items.find((l) => l.id === id)!;
    expect(out.items.map((l) => l.id)).toEqual(["1", "2", "3", "4", "5", "6"]); // withdrawn, unknown status and no address are not shown
    expect(out.withdrawn).toBe(1);
    expect(by("1").priceDisplay).toBe("Guide AUD 1,150,000");
    expect(by("1").photos!.length).toBe(1); // the real image only: a fake .jpg and a remote link are never used
    expect(by("1").photos![0].src).toBe("/listing-photos/9-ironbark-rise-marrow-creek/1.png");
    expect(by("1").portalUrl).toBe("https://portal.example/l/1");
    expect(by("1").unspecified).toEqual(["baths", "cars"]);
    expect(by("2").priceDisplay).toBe("Contact the agency for the price"); // no price published: said plainly, never guessed
    expect(by("2").noPhotos).toBe(true);
    expect(by("2").photos).toBeUndefined();
    expect(by("3").resultDisplay).toBe("Sold AUD 980,000");
    expect(by("4").resultDisplay).toBe("Sold");
    expect(by("4").priceNote).toMatch(/not disclosed/);
    expect(by("5").method).toBe("lease");
    expect(by("6").resultDisplay).toBe("Leased");
    expect(out.photos).toEqual([{ from: join(dir, "a.png"), to: "listing-photos/9-ironbark-rise-marrow-creek/1.png" }]);
    expect(out.notes.join("\n")).toMatch(/photo link was not used/);
    expect(out.notes.join("\n")).toMatch(/no photograph/);
  });

  test("no input at all is an empty list, and unsafe slugs and links are cleaned", () => {
    expect(normaliseListings(undefined, { now }).items).toEqual([]);
    const out = normaliseListings([{ id: "x", status: "for-sale", address: "<b>1 Evil Rd</b>, Town", portalUrl: "javascript:alert(1)" }, { id: "y", status: "for-sale", address: "<b>1 Evil Rd</b>, Town" }] as any, { now });
    expect(out.items[0].portalUrl).toBeUndefined();
    expect(out.items.map((l) => l.slug)).toEqual(["b-1-evil-rd-b-town", "b-1-evil-rd-b-town-2"]);
    for (const l of out.items) expect(l.slug).toMatch(/^[a-z0-9-]+$/);
  });
});

describe("G-15 generated preview", () => {
  test("each supplied listing gets its own property page and photos; the placeholder and any withdrawn property are gone", async () => {
    const w = world();
    const photos = mkdtempSync(join(tmpdir(), "r8-ph2-"));
    writeFileSync(join(photos, "a.png"), PNG);
    const out = await generatePreview(w.db, w.lead.id, {
      root: w.root, draftsRoot: w.draftsRoot, evidence: evidence(w.lead.id), now, listingPhotosRoot: photos,
      listings: [{ id: "a", status: "for-sale", address: "9 Ironbark Rise, Marrow Creek", price: "Guide AUD 1,150,000", photos: ["a.png"] }, { id: "w", status: "withdrawn", address: "1 Pinnacle Court, Marrow Creek" }],
    });
    const prop = join(out.dir, "property");
    expect(readFileSync(join(prop, "9-ironbark-rise-marrow-creek.html"), "utf8")).toContain('data-slug="9-ironbark-rise-marrow-creek"');
    expect(readFileSync(join(prop, "9-ironbark-rise-marrow-creek", "__next.property", "$d$slug", "__PAGE__.txt"), "utf8")).toBe("page 9-ironbark-rise-marrow-creek");
    expect(existsSync(join(prop, "9-ironbark-rise-marrow-creek", "__next.property.$d$slug.__PAGE__.txt"))).toBe(true);
    expect(existsSync(join(prop, "preview-listing.html"))).toBe(false); // the placeholder is not a property
    expect(existsSync(join(prop, "preview-listing"))).toBe(false);
    expect(existsSync(join(prop, "1-pinnacle-court-marrow-creek.html"))).toBe(false); // withdrawn: no page
    expect(existsSync(join(out.dir, "listing-photos", "9-ironbark-rise-marrow-creek", "1.png"))).toBe(true);
    const data = dataOf(readFileSync(join(out.dir, "index.html"), "utf8"));
    expect(data.listings.items.map((l: any) => l.slug)).toEqual(["9-ironbark-rise-marrow-creek"]);
    expect(JSON.stringify(data)).not.toContain("Pinnacle");
    expect(readFileSync(join(out.dir, "PREVIEW.md"), "utf8")).toMatch(/## Listings[\s\S]*1 for sale[\s\S]*1 withdrawn/);
  });

  test("with no listings the preview has no property page at all and says so", async () => {
    const w = world();
    const out = await generatePreview(w.db, w.lead.id, { root: w.root, draftsRoot: w.draftsRoot, evidence: evidence(w.lead.id) });
    expect(existsSync(join(out.dir, "property", "preview-listing.html"))).toBe(false);
    expect(dataOf(readFileSync(join(out.dir, "index.html"), "utf8")).listings.items).toEqual([]);
    expect(readFileSync(join(out.dir, "PREVIEW.md"), "utf8")).toContain("No listings were supplied");
  });

  test("a listing text containing < or a flagship word is data, not markup or residue", async () => {
    const w = world();
    const out = await generatePreview(w.db, w.lead.id, { root: w.root, draftsRoot: w.draftsRoot, evidence: evidence(w.lead.id), listings: [{ id: "a", status: "for-sale", address: "5 Aldergate Street, Annandale", headline: "Under <$900k </script>", price: "$900,000" }] });
    const index = readFileSync(join(out.dir, "index.html"), "utf8");
    const raw = /<script id="mu-preview-data" type="application\/json">([\s\S]*?)<\/script>/.exec(index)![1];
    expect(raw).not.toContain("</script>");
    expect(JSON.parse(raw).listings.items[0].headline).toBe("Under <$900k </script>");
    expect(JSON.parse(raw).listings.items[0].address.street).toBe("5 Aldergate Street"); // the business's own street name
  });

  test("a stale template cache that still carries the example stock (no v3 marker) is refused", async () => {
    const w = world();
    const f = join(w.draftsRoot, "_templates", "real-estate", "index.html");
    writeFileSync(f, readFileSync(f, "utf8").replace("v3", "v2"));
    await expect(generatePreview(w.db, w.lead.id, { root: w.root, draftsRoot: w.draftsRoot, evidence: evidence(w.lead.id) })).rejects.toThrow(/outdated|Rebuild/);
  });
});

import { mailtoHref, telHref } from "./fill";
import { auditListingData } from "./own-values";
import { STOCK_LEAK } from "./stock-leak";
import { readsAsClaim } from "./own-claims";
import { assertPreviewDesign } from "./design";
import { deployPreview } from "./deploy";
import { NEXT_TEMPLATE_SPECS, prepareSource } from "./next-templates";

const dataBlock = (html: string) => JSON.parse(/<script id="mu-preview-data" type="application\/json">([\s\S]*?)<\/script>/.exec(html)![1]);

describe("review blocker: listing text is audited field by field", () => {
  const probe = {
    id: "p", status: "for-sale" as const, address: "5 Test Road, Marrow Creek", price: "$900,000",
    headline: "Award-winning agency, 5 star reviews, sale guaranteed",
    description: ["Marketed by Aldergate", "A bright three bedroom home close to the station."],
    features: ["Rated 4.9 on Google", "Solar panels"],
  };
  test("claim-like and example-agency text is withheld and noted; the clean text and the price stay", async () => {
    const w = world();
    const out = await generatePreview(w.db, w.lead.id, { root: w.root, draftsRoot: w.draftsRoot, evidence: evidence(w.lead.id), now, listings: [probe] });
    const item = dataBlock(readFileSync(join(out.dir, "index.html"), "utf8")).listings.items[0];
    expect(item.headline).toBe("5 Test Road, Marrow Creek"); // falls back to the plain address
    expect(item.description).toEqual(["A bright three bedroom home close to the station."]);
    expect(item.features).toEqual(["Solar panels"]);
    expect(item.priceDisplay).toBe("$900,000");
    const md = readFileSync(join(out.dir, "PREVIEW.md"), "utf8");
    expect(md).toMatch(/headline was withheld/);
    expect(md).toMatch(/description was withheld \(it names the template/);
    expect(md).toMatch(/feature was withheld/);
  });
  test("the backstop reads the written data block and finds what the page-text audit never could", () => {
    const html = `<script id="mu-preview-data" type="application/json">${JSON.stringify({ listings: { items: [{ id: "p", headline: "Sale guaranteed", description: ["Marketed by Aldergate", "Call Imogen Sallis"], features: ["An award-winning team"], photos: [{ alt: "Theo Marchetti at 3 Glover Street" }] }] } })}</script>`;
    const problems = auditListingData(html, evidence(1), [], STOCK_LEAK);
    expect(problems.join("\n")).toMatch(/headline reads as a claim/);
    expect(problems.join("\n")).toMatch(/description names the template's example agency/);
    expect(problems.join("\n")).toMatch(/feature reads as a claim/);
    expect(problems.join("\n")).toMatch(/photo caption names/);
    expect(auditListingData(html.replace(/Sale guaranteed|Marketed by Aldergate|Call Imogen Sallis|An award-winning team|Theo Marchetti at 3 Glover Street/g, "Lovely home"), evidence(1), [], STOCK_LEAK)).toEqual([]);
  });
  test("a business whose own street is a template street keeps it in the address, but not in free text", async () => {
    const w = world();
    const out = await generatePreview(w.db, w.lead.id, { root: w.root, draftsRoot: w.draftsRoot, evidence: evidence(w.lead.id), now, listings: [{ id: "a", status: "for-sale", address: "5 Aldergate Street, Marrow Creek", price: "$1", description: ["Corner of Aldergate Street."] }] });
    const item = dataBlock(readFileSync(join(out.dir, "index.html"), "utf8")).listings.items[0];
    expect(item.address.street).toBe("5 Aldergate Street"); // address is exempt
    expect(item.description).toEqual([]); // free text naming the example agency is not
  });
});

describe("review should-fix: photos stay inside the photos folder", () => {
  test("../ escapes, absolute paths elsewhere, and a missing photos folder are all refused; an inside path works", () => {
    const base = mkdtempSync(join(tmpdir(), "r8-photos-"));
    const inside = join(base, "photos");
    mkdirSync(inside);
    writeFileSync(join(inside, "ok.png"), PNG);
    writeFileSync(join(base, "outside.png"), PNG);
    const mk = (photos: string[], photosRoot?: string) => normaliseListings([{ id: "a", status: "for-sale", address: "1 A St, B", photos }], { photosRoot, now });
    expect(mk(["../outside.png"], inside).photos).toEqual([]);
    expect(mk([join(base, "outside.png").replace(/\\/g, "/")], inside).photos).toEqual([]);
    expect(mk(["ok.png"]).photos).toEqual([]); // no photos folder given: nothing falls back to the working directory
    expect(mk([join(inside, "ok.png")], inside).photos.length).toBe(1);
    expect(mk(["ok.png"], inside).photos.length).toBe(1);
    expect(mk(["../outside.png"], inside).notes.join()).toMatch(/outside the photos folder/);
  });
});

describe("review should-fix: claim patterns", () => {
  test("the reviewer's list is caught, accents and fullwidth letters included, and priced services still pass", () => {
    for (const bad of ["Rated 4.9 on Google", "Five star care", "Sydney's No.1 conveyancer", "100% satisfaction", "Winner 2024 Local Business Awards", "Money-back promise", "Awàrd winning", "Ａward winning", "Number one in Penrith", "Guaranteed results"])
      expect(readsAsClaim(bad)).toBe(true);
    for (const ok of ["Small claims under $20,000", "Disputes <$100k", "Wills and estates", "Property management", "Family law", "Conveyancing from $1,200"])
      expect(readsAsClaim(ok)).toBe(false);
  });
});

describe("review should-fix: email and phone links", () => {
  test("mailto is not doubled, and nothing after the address survives", () => {
    expect(mailtoHref("mailto:a@b.com.au")).toBe("mailto:a@b.com.au");
    expect(mailtoHref("info@x.com.au?bcc=z@y.com")).toBe("");
    expect(mailtoHref("a@b.com\r\nBcc: c@d.com")).toBe("");
    expect(mailtoHref("a@b.com#x")).toBe("");
    expect(mailtoHref("a+tag@b.com.au")).toBe("mailto:a+tag@b.com.au");
  });
  test("an after-hours note: the first complete number is linked and the full text stays on the page", () => {
    expect(telHref("02 9555 0188 (after hours 0412 345 678)")).toBe("tel:+61295550188");
    expect(telHref("02 9555 0188 or 0412 345 678")).toBe(""); // a second number outside a bracket is ambiguous: text only
  });
});

describe("review should-fix: old-template wording", () => {
  test("the refusal says the template is from an older version, with no script path or run command", () => {
    let message = "";
    try { assertPreviewDesign("real-estate", '<main data-mu-property-experience="v2"></main>'); } catch (e) { message = (e as Error).message; }
    expect(message).toMatch(/older version/);
    expect(message).not.toMatch(/scripts?[\\/]|bun |\.ts\b|--build-root/);
  });
  test("deploying a preview generated at v2 says it must be generated again", async () => {
    const w = world();
    const out = await generatePreview(w.db, w.lead.id, { root: w.root, draftsRoot: w.draftsRoot, evidence: evidence(w.lead.id), now });
    const f = join(out.dir, "index.html");
    writeFileSync(f, readFileSync(f, "utf8").replace("v3", "v2"));
    await expect(deployPreview(w.db, w.lead.id, { root: w.root, confirm: out.record.domain, by: "x", shell: async () => ({ ok: true, out: "" }) } as any)).rejects.toThrow(/generated from an older template version[\s\S]*Generate it again/);
  });
});

describe("review blocker: agent pages carry the business's own contact, never the template agent's", () => {
  const repo = join("C:", "Users", "Nebula PC", "source", "repos", "aldergate");
  test.skipIf(!existsSync(repo))("the prepared real-estate source has no agent phone, email or first-name button left, and no example phone number anywhere", () => {
    const work = preparedRealEstateSource();
    const page = readFileSync(join(work, "src", "app", "agents", "[slug]", "page.tsx"), "utf8");
    expect(page).not.toMatch(/a\.phone|a\.email|a\.name\.split/);
    expect(page).toContain("{site.phone}");
    expect(page).toContain("href={site.phoneHref}");
    expect(page).toContain("Email the agency");
    const all = (require("node:fs").readdirSync(join(work, "src"), { recursive: true }) as string[]).filter((p) => /\.(tsx?|json)$/.test(p)).map((p) => readFileSync(join(work, "src", p), "utf8")).join("\n");
    expect(all).not.toMatch(/0400[ -]?000[ -]?00\d/);
    expect(all).not.toMatch(/\(?0[2-478]\)?[ -]?\d{4}[ -]?\d{4}/); // no other literal Australian number in the template source
  });
});

import { activities } from "../leads/crm";

describe("callers: photos resolve from the lead's own drafts folder and problems are reported", () => {
  test("listings.json and listing-photos beside the lead's drafts are used with no extra input (the Leads route and the CLI pass neither)", async () => {
    const w = world();
    const leadDir = join(w.draftsRoot, "tallowmere-property");
    mkdirSync(join(leadDir, "listing-photos"), { recursive: true });
    writeFileSync(join(leadDir, "listing-photos", "a.png"), PNG);
    writeFileSync(join(leadDir, "listings.json"), JSON.stringify([{ id: "a", status: "for-sale", address: "9 Ironbark Rise, Marrow Creek", price: "$1,150,000", photos: ["a.png"] }]));
    const out = await generatePreview(w.db, w.lead.id, { root: w.root, draftsRoot: w.draftsRoot, evidence: evidence(w.lead.id), now });
    expect(out.listings).toMatchObject({ shown: 1, photosUsed: 1, source: "file" });
    expect(out.listings!.photosFolder).toBe(join(leadDir, "listing-photos"));
    expect(existsSync(join(out.dir, "listing-photos", "9-ironbark-rise-marrow-creek", "1.png"))).toBe(true);
  });
  test("photos supplied but no folder to read: the result and the Leads timeline both say so", async () => {
    const w = world();
    const out = await generatePreview(w.db, w.lead.id, { root: w.root, draftsRoot: w.draftsRoot, evidence: evidence(w.lead.id), now, listings: [{ id: "a", status: "for-sale", address: "9 Ironbark Rise, Marrow Creek", photos: ["a.png"] }] });
    expect(out.listings!.photosUsed).toBe(0);
    expect(out.listings!.notes.join(" ")).toMatch(/photos folder was not found or was not given/);
    const timeline = activities(w.db, w.lead.id).map((a) => a.note).join("\n");
    expect(timeline).toMatch(/Listings: 1 shown, 0 photo\(s\) used; 1 photo problem/);
    expect(timeline).toContain("listing-photos");
  });
  test("a listings.json that cannot be read is reported, not silently ignored", async () => {
    const w = world();
    const leadDir = join(w.draftsRoot, "tallowmere-property");
    mkdirSync(leadDir, { recursive: true });
    writeFileSync(join(leadDir, "listings.json"), "{ not json");
    const out = await generatePreview(w.db, w.lead.id, { root: w.root, draftsRoot: w.draftsRoot, evidence: evidence(w.lead.id), now });
    expect(out.listings!.shown).toBe(0);
    expect(out.listings!.notes.join(" ")).toMatch(/listings\.json could not be read/);
  });
  test("a preview with no listings anywhere reports none and does not fail", async () => {
    const w = world();
    const out = await generatePreview(w.db, w.lead.id, { root: w.root, draftsRoot: w.draftsRoot, evidence: evidence(w.lead.id), now });
    expect(out.listings).toMatchObject({ shown: 0, photosUsed: 0, source: "none" });
  });
});

describe("re-review N1: price, result and photo credit are audited; only the address is exempt", () => {
  const probe = "Call Imogen Sallis on 0400 000 001 at Aldergate - No.1 agency, price guaranteed";
  test("the probe string is withheld from price, result and credit, and the plain prices still pass", () => {
    const photos = mkdtempSync(join(tmpdir(), "r8-n1-"));
    writeFileSync(join(photos, "a.png"), PNG);
    const out = normaliseListings(
      [
        { id: "a", status: "for-sale", address: "1 A St, B", price: probe, photos: [{ file: "a.png", credit: probe }] },
        { id: "b", status: "sold", address: "2 A St, B", result: probe },
        { id: "c", status: "for-sale", address: "3 A St, B", price: "$1,250,000" },
        { id: "d", status: "for-sale", address: "4 A St, B", price: "Offers over $900k" },
        { id: "e", status: "for-sale", address: "5 A St, B", price: "Contact agent" },
        { id: "f", status: "for-rent", address: "6 A St, B", price: "$650 per week" },
      ] as any,
      { photosRoot: photos, now },
    );
    const by = (id: string) => out.items.find((l) => l.id === id)!;
    expect(by("a").priceDisplay).toBe("Contact the agency for the price");
    expect(by("a").photos![0].credit).toBe("Supplied by the business");
    expect(by("b").resultDisplay).toBe("Sold");
    expect(by("c").priceDisplay).toBe("$1,250,000");
    expect(by("d").priceDisplay).toBe("Offers over $900k");
    expect(by("e").priceDisplay).toBe("Contact agent");
    expect(by("f").priceDisplay).toBe("$650 per week");
    expect(out.notes.join("\n")).toMatch(/price was withheld/);
    expect(out.notes.join("\n")).toMatch(/photo credit was withheld/);
  });
  test("the written data block is audited too, price and credit included", () => {
    const html = `<script id="mu-preview-data" type="application/json">${JSON.stringify({ listings: { items: [{ id: "p", priceDisplay: probe, resultDisplay: "", photos: [{ alt: "", credit: probe }] }] } })}</script>`;
    const problems = auditListingData(html, evidence(1), ["1 A St"], STOCK_LEAK).join("\n");
    expect(problems).toMatch(/price names the template|price reads as a claim/);
    expect(problems).toMatch(/photo credit/);
    const fine = `<script id="mu-preview-data" type="application/json">${JSON.stringify({ listings: { items: [{ id: "p", priceDisplay: "$1,250,000", photos: [{ alt: "", credit: "Supplied by the business" }] }] } })}</script>`;
    expect(auditListingData(fine, evidence(1), [], STOCK_LEAK)).toEqual([]);
  });
});

describe("re-review N2: a listings file with a byte-order mark, and its notes", () => {
  test("a UTF-8 BOM (PowerShell 5.1) is accepted, and the summary is on the result", async () => {
    const w = world();
    const leadDir = join(w.draftsRoot, "tallowmere-property");
    mkdirSync(leadDir, { recursive: true });
    writeFileSync(join(leadDir, "listings.json"), "﻿" + JSON.stringify([{ id: "a", status: "for-sale", address: "9 Ironbark Rise, Marrow Creek", price: "$1" }]));
    const out = await generatePreview(w.db, w.lead.id, { root: w.root, draftsRoot: w.draftsRoot, evidence: evidence(w.lead.id), now });
    expect(out.listings).toMatchObject({ shown: 1, source: "file" });
    expect(out.listings!.summary).toMatch(/^Listings: 1 shown, 0 photo\(s\) used/);
  });
  test("an unreadable or oversized file is named in PREVIEW.md and on the Leads timeline", async () => {
    const w = world();
    const leadDir = join(w.draftsRoot, "tallowmere-property");
    mkdirSync(leadDir, { recursive: true });
    writeFileSync(join(leadDir, "listings.json"), "x".repeat(1024 * 1024 + 10));
    const out = await generatePreview(w.db, w.lead.id, { root: w.root, draftsRoot: w.draftsRoot, evidence: evidence(w.lead.id), now });
    expect(readFileSync(join(out.dir, "PREVIEW.md"), "utf8")).toMatch(/listings\.json is too large/);
    expect(activities(w.db, w.lead.id).map((a) => a.note).join("\n")).toMatch(/Listings: none used\. listings\.json is too large/);
    expect(out.listings!.summary).toMatch(/left out/);
  });
});

describe("re-review N3: genuine local streets stay; the example properties go; a file called ..x.jpg is fine", () => {
  test("bare street names are not stock, the example addresses and slugs are", () => {
    const hit = (t: string) => STOCK_LEAK.some((re) => re.test(t));
    expect(hit("A renovated terrace at 7 Darling Street, Balmain")).toBe(false);
    expect(hit("Walk to Glover Street and Norton Street cafes")).toBe(false);
    expect(hit("Just like 27 Darling Street")).toBe(true);
    expect(hit("see 8/42 Wellington Street")).toBe(true);
    expect(hit("/property/14-louisa-road-birchgrove")).toBe(true);
    expect(hit("Marketed by Theo Marchetti")).toBe(true);
  });
  test("a photo named ..x.jpg inside the folder is used; a real ../ escape is not", () => {
    const base = mkdtempSync(join(tmpdir(), "r8-dots-"));
    const inside = join(base, "photos");
    mkdirSync(inside);
    writeFileSync(join(inside, "..x.png"), PNG);
    writeFileSync(join(base, "out.png"), PNG);
    const mk = (p: string) => normaliseListings([{ id: "a", status: "for-sale", address: "1 A St, B", photos: [p] }] as any, { photosRoot: inside, now });
    expect(mk("..x.png").photos.length).toBe(1);
    expect(mk("../out.png").photos.length).toBe(0);
  });
});

describe("re-review N4: size limits say what they skipped", () => {
  test("too many photos on one listing are noted", () => {
    const dir = mkdtempSync(join(tmpdir(), "r8-cap-"));
    const names = Array.from({ length: 23 }, (_, i) => `p${i}.png`);
    for (const n of names) writeFileSync(join(dir, n), PNG);
    const out = normaliseListings([{ id: "a", status: "for-sale", address: "1 A St, B", photos: names }] as any, { photosRoot: dir, now });
    expect(out.photos.length).toBe(20);
    expect(out.notes.join("\n")).toMatch(/only the first 20 of 23 photos/);
  });
});

describe("re-review: hidden characters and more claim wording", () => {
  test("zero-width characters and soft hyphens do not hide a claim; the new phrases are caught", () => {
    for (const bad of ["Aw­ard winning", "Aw​ard winning", "Highly rated agents", "Best agency in Penrith", "Top 5% of agents"]) expect(readsAsClaim(bad)).toBe(true);
    for (const ok of ["Offers over $900k", "Contact agent", "Close to the best parks", "Property management"]) expect(readsAsClaim(ok)).toBe(false);
  });
});

describe("follow-ups: ordinary price lines and dates are not claims", () => {
  test("the three reported strings pass, in price and in free text, and the earlier probes stay withheld", () => {
    for (const ok of ["Best offers in excess of $1,200,000", "Auction Sat 3/5 at 11am", "Best of both worlds in Balmain", "Open for inspection Sat 3/5", "On 3/5 at 10:30am"]) {
      expect(readsAsClaim(ok)).toBe(false);
      expect(readsAsClaim(ok, { priceLine: true })).toBe(false);
    }
    for (const bad of ["Call Imogen Sallis on 0400 000 001 at Aldergate - No.1 agency, price guaranteed", "Rated 4.5/5 by clients", "4/5 stars on Google", "Best agency in Penrith", "Award-winning team"])
      expect(readsAsClaim(bad)).toBe(true);
  });
  test("a listing with those price lines keeps them", () => {
    const out = normaliseListings([
      { id: "a", status: "for-sale", address: "1 A St, B", price: "Best offers in excess of $1,200,000", headline: "Best of both worlds in Balmain" },
      { id: "b", status: "for-sale", address: "2 A St, B", price: "Auction Sat 3/5 at 11am" },
    ] as any, { now });
    expect(out.items[0].priceDisplay).toBe("Best offers in excess of $1,200,000");
    expect(out.items[0].headline).toBe("Best of both worlds in Balmain");
    expect(out.items[1].priceDisplay).toBe("Auction Sat 3/5 at 11am");
    expect(out.notes.join()).not.toMatch(/withheld/);
  });
  test("a named practitioner in a listing field is withheld, not a reason to refuse the preview", async () => {
    const w = world();
    const out = await generatePreview(w.db, w.lead.id, { root: w.root, draftsRoot: w.draftsRoot, evidence: evidence(w.lead.id), now, listings: [{ id: "a", status: "for-sale", address: "9 Ironbark Rise, Marrow Creek", price: "$1", description: ["Inspect with Dr Jane Citizen.", "Three bedrooms."] }] });
    const item = dataBlock(readFileSync(join(out.dir, "index.html"), "utf8")).listings.items[0];
    expect(item.description).toEqual(["Three bedrooms."]);
    expect(out.listings!.notes.join()).toMatch(/description was withheld/);
  });
});

import { readListingsFile } from "./listings";

describe("follow-ups: listings files saved the way Windows saves them", () => {
  const rows = JSON.stringify([{ id: "a", status: "for-sale", address: "9 Ironbark Rise, Marrow Creek", price: "$1" }]);
  const write = (bytes: Buffer) => { const f = join(mkdtempSync(join(tmpdir(), "r8-enc-")), "listings.json"); writeFileSync(f, bytes); return f; };
  test("UTF-16 little endian (Out-File default), UTF-16 big endian, UTF-8 with and without a mark", () => {
    const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(rows, "utf16le")]);
    const be = Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(rows, "utf16le").swap16()]);
    const bom8 = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(rows)]);
    for (const b of [le, be, bom8, Buffer.from(rows)]) expect((readListingsFile(write(b)).value as any[])[0].id).toBe("a");
  });
  test("an unreadable file gives a plain reason", () => {
    expect(readListingsFile(write(Buffer.from("{ not json"))).problem).toMatch(/UTF-8 or UTF-16/);
    expect(readListingsFile(write(Buffer.alloc(1024 * 1024 + 5, 120))).problem).toMatch(/too large/);
  });
  test("a UTF-16 file generates, end to end", async () => {
    const w = world();
    const leadDir = join(w.draftsRoot, "tallowmere-property");
    mkdirSync(leadDir, { recursive: true });
    writeFileSync(join(leadDir, "listings.json"), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(rows, "utf16le")]));
    const out = await generatePreview(w.db, w.lead.id, { root: w.root, draftsRoot: w.draftsRoot, evidence: evidence(w.lead.id), now });
    expect(out.listings).toMatchObject({ shown: 1, source: "file" });
  });
});

describe("follow-ups: photo limits reach the Leads timeline", () => {
  test("a photo cap and a size skip are named on the timeline", async () => {
    const w = world();
    const photos = mkdtempSync(join(tmpdir(), "r8-tl-"));
    const names = Array.from({ length: 22 }, (_, i) => { writeFileSync(join(photos, `p${i}.png`), PNG); return `p${i}.png`; });
    await generatePreview(w.db, w.lead.id, { root: w.root, draftsRoot: w.draftsRoot, evidence: evidence(w.lead.id), now, listingPhotosRoot: photos, listings: [{ id: "a", status: "for-sale", address: "9 Ironbark Rise, Marrow Creek", price: "$1", photos: names }] });
    expect(activities(w.db, w.lead.id).map((a) => a.note).join("\n")).toMatch(/Listings: 1 shown, 20 photo\(s\) used; 1 photo problem[\s\S]*only the first 20 of 22 photos/);
  });
});
