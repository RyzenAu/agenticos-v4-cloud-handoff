import { describe, expect, test } from "bun:test";
import {
  DEFAULT_LEAD_FILTERS,
  leadFilterOptions,
  selectLeadResults,
  websitePresence,
  WEBSITE_FILTER_OPTIONS,
  OWNER_FILTER_OPTIONS,
  CONTACT_FILTER_OPTIONS,
  CREATED_FILTER_OPTIONS,
  FOLLOWUP_FILTER_OPTIONS,
  LEAD_SORT_OPTIONS,
  type LeadFilters,
} from "../../src/lib/lead-search";
import type { BoardLead } from "../../src/lib/leads";

const NOW = Date.parse("2026-10-01T12:00:00+10:00");
function lead(id: number, patch: Partial<BoardLead> = {}): BoardLead {
  return {
    id,
    name: "Fixture Dental",
    area: "Parramatta NSW",
    address: "8 Sample Road",
    phone: "02 9999 0000",
    website: "",
    mapsUrl: "",
    emails: [],
    emailOk: false,
    vertical: "dental",
    score: 50,
    pitch: "website",
    reasons: [],
    status: "new",
    owner: "usman",
    nextAt: null,
    lastContactAt: null,
    createdAt: "2026-09-30T00:00:00Z",
    source: "osm",
    deal: {
      stage: "found",
      closed: false,
      evidence: "Synthetic fixture",
      nextAction: "Review",
      owner: "usman",
      stageSince: null,
      daysInStage: null,
      daysInferred: false,
      stuck: null,
      economics: {} as BoardLead["deal"]["economics"],
      contactPref: "",
      issues: [],
    },
    ...patch,
  };
}
const ids = (leads: readonly BoardLead[], filters: Partial<LeadFilters> = {}, now = NOW) =>
  selectLeadResults(leads, filters, now).map((lead) => lead.id);
const withSite = (id: number, website: string, websiteStatus?: string) => {
  const result = lead(id, { website });
  result.deal.websiteStatus = websiteStatus;
  return result;
};

describe("lead search", () => {
  test("all terms must match; their order and fields may differ", () => {
    const rows = [
      lead(1, { name: "Smile Practice", area: "Blacktown NSW" }),
      lead(2, { name: "Smile Practice" }),
    ];
    expect(ids(rows, { q: "blacktown smile" })).toEqual([1]);
    expect(ids(rows, { q: "  SMILE   blacktown " })).toEqual([1]);
    expect(ids(rows, { q: "Smile Blacktown nonexistent" })).toEqual([]);
  });

  test("folds accents and punctuation without altering display values", () => {
    const row = lead(1, { name: "Clínica D’Ávila & Søn", area: "São Paulo" });
    expect(ids([row], { q: "clinica d avila son sao" })).toEqual([1]);
    expect(row.name).toBe("Clínica D’Ávila & Søn");
    expect(
      ids([lead(2, { name: "Straße Æsthetic Łódź" })], { q: "strasse aesthetic lodz" }),
    ).toEqual([2]);
  });

  test("searches address, email, domain and exact lead ID", () => {
    const row = lead(412, {
      emails: ["booking@smile.example"],
      website: "https://clinic.example/contact",
    });
    for (const q of [
      "8 sample road",
      "booking@smile.example",
      "clinic.example",
      "#412",
      "412 booking",
    ]) {
      expect(ids([row], { q })).toEqual([412]);
    }
    expect(ids([row], { q: "#41" })).toEqual([]);
    // Maps and provenance are not silently treated as contact data or a business website.
    expect(
      ids([lead(1, { mapsUrl: "https://maps.example/hidden", source: "private-origin" })], {
        q: "hidden",
      }),
    ).toEqual([]);
  });

  test("matches Australian phone formatting and country prefixes in either direction", () => {
    const rows = [
      lead(1, { phone: "+61 (2) 9999 0000" }),
      lead(2, { phone: "02-9999-0000" }),
      lead(3, { phone: "0061 2 9999 0000" }),
    ];
    for (const q of [
      "0299990000",
      "+61 2 9999 0000",
      "+61 (0)2 9999 0000",
      "02 9999 0000",
      "99990000",
      "0061299990000",
      "0061 2 9999 0000",
      "+610299990000",
    ]) {
      expect(ids(rows, { q })).toEqual([1, 2, 3]);
    }
    expect(ids([lead(4, { phone: "+61 412 345 678" })], { q: "0412345678" })).toEqual([4]);
    expect(ids([lead(5, { phone: "0412 345 678" })], { q: "+61412345678" })).toEqual([5]);
    expect(ids([lead(6, { phone: "+44 20 7946 0991" })], { q: "442079460991" })).toEqual([6]);
    for (const q of [
      "+61 2 9999 0000 dental",
      "dental 0299990000",
      "0061 2 9999 0000 dental",
      "dental +610299990000",
    ]) {
      expect(ids(rows, { q })).toEqual([1, 2, 3]);
    }
  });

  test("formatted phones keep digit order and cannot combine incidental numeric fields", () => {
    const rows = [
      lead(1, { phone: "02 9999 0000" }),
      lead(2, { phone: "02 0000 9999" }),
      lead(3, { phone: "02 9999 1234", address: "0000 Sample Road" }),
    ];
    for (const q of ["02 9999 0000", "0299990000", "+61 (2) 9999 0000", "dental 02-9999-0000"]) {
      expect(ids(rows, { q })).toEqual([1]);
    }
    expect(ids(rows, { q: "9999 0000" })).toEqual([1]);
  });

  test("explicit #ID never matches a different lead's phone or address", () => {
    const rows = [
      lead(41, { phone: "", score: 1 }),
      lead(412, { phone: "0412 345 678", address: "41 Sample Road", score: 100 }),
    ];
    expect(ids(rows, { q: "#41" })).toEqual([41]);
    expect(ids(rows, { q: "dental #41" })).toEqual([41]);
    expect(ids(rows, { q: "#41 nonexistent" })).toEqual([]);
    expect(ids(rows, { q: "41" })).toEqual([41, 412]);
    expect(ids(rows, { q: "#412 0412 345 678" })).toEqual([412]);
    expect(ids(rows, { q: "0412 345 678 #412" })).toEqual([412]);
  });

  test("exact and prefix business names outrank higher-scored incidental matches", () => {
    const rows = [
      lead(1, { name: "Other Practice", area: "Smile", score: 100 }),
      lead(2, { name: "The Smile Practice", score: 90 }),
      lead(3, { name: "Smile Practice", score: 80 }),
      lead(4, { name: "Smile", score: 1 }),
    ];
    expect(ids(rows, { q: "smile" })).toEqual([4, 3, 2, 1]);
    expect(ids(rows, { q: "smile", sort: "score" })).toEqual([1, 2, 3, 4]);
  });

  test("ranks exact identifiers and complete phones ahead of incidental numeric fields", () => {
    expect(
      ids([lead(8, { address: "412 Road", score: 100 }), lead(412, { score: 1 })], { q: "412" }),
    ).toEqual([412, 8]);
    expect(
      ids([lead(9, { phone: "", address: "0299990000 Road", score: 100 }), lead(7, { score: 1 })], {
        q: "0299990000",
      }),
    ).toEqual([7, 9]);
  });

  test("blank and punctuation-only searches use score without excluding records", () => {
    const rows = [lead(1, { score: 20 }), lead(2, { score: 90 })];
    expect(ids(rows, { q: "  " })).toEqual([2, 1]);
    expect(ids(rows, { q: "... + ()" })).toEqual([2, 1]);
  });

  test("tolerates sparse imported fields and invalid scores without throwing", () => {
    const sparse = { id: 1 } as BoardLead;
    expect(ids([sparse], { q: "missing" })).toEqual([]);
    expect(ids([sparse], { q: "1" })).toEqual([1]);
    expect(
      ids([sparse], { contact: "none", owner: "unassigned", followup: "unscheduled" }),
    ).toEqual([1]);
    expect(websitePresence(sparse)).toBe("unknown");
    expect(ids([lead(3, { score: NaN }), lead(2, { score: Infinity }), sparse])).toEqual([1, 2, 3]);
  });
});

describe("honest website filters", () => {
  test("only explicit verified absence plus an empty website means no website", () => {
    const rows = [
      withSite(1, "", "no_website_verified"),
      withSite(2, "", "no_website_unverified"),
      withSite(3, "", "bot_protected"),
      withSite(4, "", "failed"),
      withSite(5, ""),
      withSite(6, "https://example.com", "no_website_verified"),
      withSite(7, "https://facebook.com/fixture", "no_website_verified"),
    ];
    expect(ids(rows, { website: "verified_none" })).toEqual([1]);
    expect(ids(rows, { website: "unknown" })).toEqual([2, 3, 4, 5]);
    expect(websitePresence(withSite(8, "   ", "no_website_verified"))).toBe("verified_none");
  });

  test("a saved URL is presence, not a verification claim", () => {
    for (const status of [undefined, "ok", "bot_protected", "failed", "no_website_unverified"]) {
      expect(websitePresence(withSite(1, "https://clinic.example", status))).toBe("has_site");
    }
    expect(websitePresence(withSite(2, "clinic.example"))).toBe("has_site");
    expect(websitePresence(withSite(3, "https://clinic.example", "not_their_site"))).toBe(
      "wrong_site",
    );
    expect(websitePresence(withSite(4, "", "not_their_site"))).toBe("wrong_site");
  });

  test("social classification uses exact hostname boundaries, never substring guesses", () => {
    for (const url of [
      "https://www.facebook.com/fixture",
      "m.facebook.com/fixture",
      "https://instagram.com/fixture",
      "https://linkedin.com/company/fixture",
      "https://youtu.be/example",
    ]) {
      expect(websitePresence(withSite(1, url))).toBe("social_only");
    }
    for (const url of [
      "https://notfacebook.com",
      "https://facebook.com.example.org",
      "https://clinic.example/facebook.com",
    ]) {
      expect(websitePresence(withSite(2, url))).toBe("has_site");
    }
    expect(websitePresence(withSite(3, "https://facebook.com/fixture", "not_their_site"))).toBe(
      "wrong_site",
    );
  });

  test("missing and invalid URL values never become an absence claim or a real site", () => {
    for (const url of [
      "",
      "   ",
      "not a url",
      "unknown",
      "javascript:alert(1)",
      "ftp://example.com",
    ]) {
      expect(websitePresence(withSite(1, url))).toBe("unknown");
    }
  });
});

describe("record filters", () => {
  test("combines vertical, pitch, outcome status, pipeline stage, owner, area and source", () => {
    const wanted = lead(1, {
      vertical: "legal",
      pitch: "redesign",
      status: "interested",
      owner: "mehroz",
      area: "Liverpool NSW",
      source: "manual",
    });
    wanted.deal.stage = "replied";
    const rows = [wanted, lead(2), lead(3, { ...wanted, id: 3, source: "osm" })];
    expect(
      ids(rows, {
        vertical: "legal",
        pitch: "redesign",
        status: "interested",
        stage: "replied",
        owner: "mehroz",
        area: "Liverpool NSW",
        source: "manual",
      }),
    ).toEqual([1]);
    expect(ids(rows, { stage: "proposal" })).toEqual([]);
  });

  test("owner is the record's assignment; blank is unassigned, unknown owners are not", () => {
    const rows = [
      lead(1, { owner: "" }),
      lead(2, { owner: " " }),
      lead(3, { owner: "agent" }),
      lead(4, { owner: "Mehroz" }),
    ];
    expect(ids(rows, { owner: "unassigned" })).toEqual([1, 2]);
    expect(ids(rows, { owner: "mehroz" })).toEqual([4]);
  });

  test("all six contact filters test presence, without claiming verification or consent", () => {
    const rows = [
      lead(1, { emails: ["hello@example.com"], emailOk: false }),
      lead(2),
      lead(3, { phone: "", emails: ["hello@example.com"] }),
      lead(4, { phone: "-", emails: [" "] }),
    ];
    expect(ids(rows, { contact: "phone" })).toEqual([1, 2]);
    expect(ids(rows, { contact: "email" })).toEqual([1, 3]);
    expect(ids(rows, { contact: "both" })).toEqual([1]);
    expect(ids(rows, { contact: "missing_phone" })).toEqual([3, 4]);
    expect(ids(rows, { contact: "missing_email" })).toEqual([2, 4]);
    expect(ids(rows, { contact: "none" })).toEqual([4]);
  });

  test("keeps DNC and closed statuses as explicit searchable records", () => {
    const rows = [
      lead(1, { status: "do_not_contact" }),
      lead(2, { status: "won" }),
      lead(3, { excluded: true }),
    ];
    rows[0].deal.closed = true;
    rows[1].deal.closed = true;
    expect(ids(rows)).toEqual([1, 2]);
    expect(ids(rows, { status: "do_not_contact" })).toEqual([1]);
    expect(ids(rows, { showExcluded: true })).toEqual([1, 2, 3]);
  });

  test("verified reasons preserve the existing rule rejecting rewritten discovery claims", () => {
    const rows = [
      lead(1, { reasons: ["Broken booking link"], verified: [true] }),
      lead(2, { reasons: ["No website found"], verified: [true] }),
      lead(3, { reasons: ["Broken booking link"], verified: [false] }),
      lead(4, { reasons: ["No website found", "Missing contact link"], verified: [true, true] }),
    ];
    expect(ids(rows, { verifiedOnly: true })).toEqual([1, 4]);
  });

  test("options retain actual values, deduplicate blanks, and sort deterministically", () => {
    const rows = [
      lead(1, { area: "Zetland", source: "Places API" }),
      lead(2, { area: "  Auburn NSW ", source: "osm" }),
      lead(3, { area: "Auburn NSW", source: "osm" }),
      lead(4, { area: "", source: undefined }),
    ];
    expect(leadFilterOptions(rows)).toEqual({
      areas: [
        { value: "Auburn NSW", label: "Auburn NSW" },
        { value: "Zetland", label: "Zetland" },
      ],
      sources: [
        { value: "osm", label: "osm" },
        { value: "Places API", label: "Places API" },
      ],
    });
    expect(ids(rows, { area: "Auburn NSW", source: "osm" })).toEqual([2, 3]);
    expect(leadFilterOptions([...rows].reverse())).toEqual(leadFilterOptions(rows));
  });

  test("all public option values are unique and all-inclusive values are left to the UI", () => {
    for (const options of [
      WEBSITE_FILTER_OPTIONS,
      OWNER_FILTER_OPTIONS,
      CONTACT_FILTER_OPTIONS,
      CREATED_FILTER_OPTIONS,
      FOLLOWUP_FILTER_OPTIONS,
      LEAD_SORT_OPTIONS,
    ]) {
      expect(new Set(options.map((option) => option.value)).size).toBe(options.length);
      expect(options.every((option) => option.value && option.label)).toBe(true);
    }
    expect(Object.isFrozen(DEFAULT_LEAD_FILTERS)).toBe(true);
  });
});

describe("dates and ordering", () => {
  test("created windows include the boundary and exclude future, missing and invalid dates", () => {
    const rows = [
      lead(1, { createdAt: new Date(NOW - 7 * 86_400_000).toISOString() }),
      lead(2, { createdAt: new Date(NOW - 7 * 86_400_000 - 1).toISOString() }),
      lead(3, { createdAt: new Date(NOW + 1).toISOString() }),
      lead(4, { createdAt: "invalid" }),
      lead(5, { createdAt: "" }),
    ];
    expect(ids(rows, { created: "7" })).toEqual([1]);
    expect(ids(rows, { created: "30" })).toEqual([1, 2]);
    expect(ids(rows, { created: "90" })).toEqual([1, 2]);
    expect(ids(rows, { created: "7" }, NaN)).toEqual([]);
  });

  test("today is the full Sydney day, including later times and a previous UTC date", () => {
    const rows = [
      lead(1, { nextAt: "2026-09-30T14:00:00Z" }), // Sydney Oct 1 midnight
      lead(2, { nextAt: "2026-10-01T23:59:59+10:00" }),
      lead(3, { nextAt: "2026-09-30T23:59:59+10:00" }),
      lead(4, { nextAt: "2026-10-02T00:00:00+10:00" }),
      lead(5, { nextAt: "invalid" }),
      lead(6),
    ];
    expect(ids(rows, { followup: "today" })).toEqual([1, 2]);
    expect(ids(rows, { followup: "overdue" })).toEqual([3]);
    expect(ids(rows, { followup: "unscheduled" })).toEqual([5, 6]);
    expect(ids(rows, { followup: "today" }, NaN)).toEqual([]);
  });

  test("Sydney day filters work across daylight saving", () => {
    const now = Date.parse("2026-10-05T00:30:00+11:00");
    const rows = [
      lead(1, { nextAt: "2026-10-04T13:00:00Z" }),
      lead(2, { nextAt: "2026-10-04T12:59:59Z" }),
    ];
    expect(ids(rows, { followup: "today" }, now)).toEqual([1]);
    expect(ids(rows, { followup: "overdue" }, now)).toEqual([2]);
  });

  test("newest and next follow-up put invalid or missing dates last with stable ID ties", () => {
    const rows = [
      lead(8, { createdAt: "invalid", nextAt: "invalid" }),
      lead(4, { createdAt: "2026-09-15", nextAt: "2026-10-05" }),
      lead(2, { createdAt: "2026-09-30", nextAt: "2026-10-02" }),
      lead(3, { createdAt: "2026-09-30", nextAt: "2026-10-02" }),
      lead(6, { createdAt: "", nextAt: null }),
    ];
    expect(ids(rows, { sort: "newest" })).toEqual([2, 3, 4, 6, 8]);
    expect(ids(rows, { sort: "next" })).toEqual([2, 3, 4, 6, 8]);
  });

  test("score and relevance use stable ID ties, name sort folds accents", () => {
    const rows = [
      lead(3, { name: "Zulu" }),
      lead(2, { name: "Éclair" }),
      lead(1, { name: "Alpha" }),
    ];
    expect(ids(rows, { sort: "name" })).toEqual([1, 2, 3]);
    expect(ids(rows, { sort: "score" })).toEqual([1, 2, 3]);
    expect(ids(rows)).toEqual([1, 2, 3]);
  });

  test("selection never mutates the array, record objects or filters", () => {
    const rows = [lead(3, { score: 1 }), lead(1, { score: 90 }), lead(2, { score: 50 })];
    const snapshot = JSON.stringify(rows);
    const filters = Object.freeze({ q: "fixture", sort: "score" as const });
    const result = selectLeadResults(Object.freeze(rows), filters, NOW);
    expect(result.map((row) => row.id)).toEqual([1, 2, 3]);
    expect(result[0]).toBe(rows[1]);
    expect(JSON.stringify(rows)).toBe(snapshot);
    expect(filters).toEqual({ q: "fixture", sort: "score" });
  });
});

describe("round 6 review: short digit runs are not phone fragments", () => {
  const smith = lead(1, { name: "Smith Dental", address: "5 King St", phone: "0412 345 678" });
  const other = lead(2, { name: "Other Practice", address: "12 Hill Rd", phone: "0427 701 234" });
  const ids = (q: string) => selectLeadResults([smith, other], { q }).map((l) => l.id);
  test("'smith 12' does not match Smith Dental through 0412...", () => expect(ids("smith 12")).toEqual([]));
  test("'12' matches the street number only, not every phone", () => expect(ids("12")).toEqual([2]));
  test("'2770' does not match 0427 701 234", () => expect(ids("2770")).toEqual([]));
  test("six or more digits still match inside a phone", () => expect(ids("345678")).toEqual([1]));
  test("a whole formatted number still matches however it is written", () => {
    for (const q of ["0412 345 678", "+61412345678", "0412345678"]) expect(ids(q)).toEqual([1]);
  });
  test("#ID stays exact", () => expect(ids("#2")).toEqual([2]));
});

describe("round 6 review: the overdue filter agrees with the overview tile", () => {
  const past = "2026-09-01T01:00:00.000Z";
  const now = Date.parse("2026-10-02T01:00:00.000Z");
  const open = lead(1, { nextAt: past });
  const closed = lead(2, { nextAt: past, deal: { ...lead(2).deal, closed: true } as BoardLead["deal"] });
  const dnc = lead(3, { nextAt: past, status: "do_not_contact" });
  test("closed and do-not-contact leads are not overdue", () => {
    expect(selectLeadResults([open, closed, dnc], { followup: "overdue" }, now).map((l) => l.id)).toEqual([1]);
  });
});
test("round 6 review: the search box caps its length and the options are memoised", () => {
  const src = require("node:fs").readFileSync(require("node:path").join(import.meta.dir, "../../src/components/operator/lead-filters.tsx"), "utf8");
  expect(src).toContain("maxLength={200}");
  expect(src).toContain("useMemo(() => leadFilterOptions(leads), [leads])");
});
