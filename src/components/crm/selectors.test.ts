// @ts-ignore: bun supplies test types at runtime.
import { describe, expect, test } from "bun:test";
import type { Company, CrmSnapshot, Deal, Task } from "../../../scripts/crm/types";
import { SALES_STAGES } from "../../../scripts/crm/types";
import {
  companyForRef,
  dateKey,
  filterCompanies,
  localDateTime,
  matchesSearch,
  moneyCents,
  pipelineTotals,
  taskUrgency,
  validateCrmSearch,
} from "./selectors";
const company = (id: string, extra: Partial<Company> = {}): Company => ({
  id,
  version: 1,
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-01T00:00:00Z",
  name: `Company ${id}`,
  industry: "Dental",
  website: "",
  locality: "Sydney",
  address: "",
  timezone: "Australia/Sydney",
  phone: "0412 345 678",
  emails: [],
  owner: "usman",
  tags: [],
  source: { kind: "manual", reference: "", attribution: "" },
  fieldSources: {},
  status: "prospect",
  notes: "",
  doNotContact: false,
  emailAllowed: false,
  excluded: false,
  excludedReason: "",
  mergedInto: null,
  legacyLeadId: null,
  websiteCheck: "not-checked",
  websiteCheckedAt: null,
  ...extra,
});
const snapshot = (): CrmSnapshot => ({
  schemaVersion: 1,
  generatedAt: "2026-10-02T00:00:00Z",
  companies: [
    company("a"),
    company("b", { doNotContact: true, owner: "mehroz", name: "Müller Clinic" }),
  ],
  contacts: [],
  deals: [],
  projects: [],
  tasks: [],
  activities: [],
  documents: [],
  pipelines: [
    {
      id: "sales",
      name: "Sales",
      version: 1,
      createdAt: "",
      updatedAt: "",
      stages: [...SALES_STAGES],
    },
  ],
});
const task = (dueAt: string | null): Task => ({
  id: "t",
  companyId: "a",
  title: "Call",
  description: "",
  kind: "follow-up",
  status: "open",
  owner: "usman",
  dueAt,
  completedAt: null,
  dealId: null,
  projectId: null,
  contactId: null,
  legacyLeadId: null,
  version: 1,
  createdAt: "",
  updatedAt: "",
});
const deal = (stageId: string, oneOffCents: number, recurringCents = 0): Deal => ({
  id: stageId,
  companyId: "a",
  title: stageId,
  owner: "usman",
  contactIds: [],
  service: "Website",
  scope: "",
  pipelineId: "sales",
  stageId,
  oneOffCents,
  recurringCents,
  currency: "AUD",
  gstTreatment: "exclusive",
  probability: null,
  expectedClose: null,
  nextAction: "",
  nextActionDue: null,
  closeReason: "",
  stageHistory: [],
  legacyLeadId: null,
  catalogueId: null,
  commercialBasis: "agreed",
  version: 1,
  createdAt: "",
  updatedAt: "",
});
describe("CRM search and deep links", () => {
  test("validates route views, tabs and opaque IDs", () => {
    expect(validateCrmSearch({ ref: "crm:company:a", tab: "timeline", view: "companies" })).toEqual(
      { ref: "crm:company:a", tab: "timeline", view: "companies" },
    );
    expect(
      validateCrmSearch({ ref: "crm:company:../../other", view: "broken", tab: "nope" }),
    ).toEqual({});
    expect(validateCrmSearch({ ref: "crm:company:<script>" })).toEqual({});
  });
  test("matches accents, phone formats and legacy IDs", () => {
    expect(matchesSearch(["Müller Clinic", "0412 345 678", 45], "muller clinic")).toBe(true);
    expect(matchesSearch(["0412 345 678"], "+61 412 345 678")).toBe(true);
    expect(matchesSearch([45], "#45")).toBe(true);
    expect(matchesSearch(["0412 345 678"], "0399 123 456")).toBe(false);
  });
  test("filters merged companies and contact restrictions without inferring permission", () => {
    const s = snapshot();
    s.companies.push(company("merged", { mergedInto: "a" }));
    expect(
      filterCompanies(s, { search: "", owner: "", status: "", restriction: "restricted" }).map(
        (c) => c.id,
      ),
    ).toEqual(["b"]);
    expect(
      filterCompanies(s, { search: "", owner: "usman", status: "prospect", restriction: "" }).map(
        (c) => c.id,
      ),
    ).toEqual(["a"]);
  });
  test("opens related and merged records while preserving old lead IDs", () => {
    const s = snapshot();
    s.companies.push(company("old", { mergedInto: "a", legacyLeadId: 42 }));
    s.deals.push(deal("proposal", 100));
    expect(companyForRef(s, { kind: "deal", id: "proposal" })?.id).toBe("a");
    expect(companyForRef(s, { kind: "lead", id: "42" })?.id).toBe("a");
    expect(companyForRef(s, { kind: "contact", id: "absent" })).toBeUndefined();
  });
});
test("historical links follow repeated merges and reject cycles", () => {
  const s = snapshot();
  s.companies = [
    company("a", { legacyLeadId: 42, mergedInto: "b" }),
    company("b", { mergedInto: "c" }),
    company("c"),
  ];
  expect(companyForRef(s, { kind: "company", id: "a" })?.id).toBe("c");
  expect(companyForRef(s, { kind: "lead", id: "42" })?.id).toBe("c");
  s.companies[2].mergedInto = "a";
  expect(companyForRef(s, { kind: "company", id: "a" })).toBeUndefined();
});
describe("CRM actionable dates and commercial totals", () => {
  test("uses Sydney calendar days across DST rather than a fixed offset", () => {
    expect(dateKey("2026-10-03T14:30:00Z")).toBe("2026-10-04");
    expect(dateKey("2026-10-04T13:30:00Z")).toBe("2026-10-05");
    expect(dateKey("2026-10-04")).toBe("2026-10-04");
  });
  test("separates overdue, due, upcoming and unscheduled tasks", () => {
    const now = Date.parse("2026-10-02T00:00:00Z");
    expect(taskUrgency(task("2026-10-01"), now)).toBe("overdue");
    expect(taskUrgency(task("2026-10-02"), now)).toBe("today");
    expect(taskUrgency(task("2026-10-03"), now)).toBe("upcoming");
    expect(taskUrgency(task(null), now)).toBe("unscheduled");
  });
  test("does not count lost deals as pipeline or won business", () => {
    const s = snapshot();
    s.deals = [
      deal("new", 12345, 100),
      deal("proposal", 20000, 200),
      deal("won", 50000, 500),
      deal("lost", 999999),
    ];
    expect(pipelineTotals(s)).toEqual({
      estimatedOneOff: 32345,
      estimatedRecurring: 300,
      wonOneOff: 50000,
      wonRecurring: 500,
      openCount: 2,
      wonCount: 1,
    });
  });
  test("normalises mixed inclusive, exclusive and non-taxable deals to ex GST", () => {
    const s = snapshot();
    s.deals = [
      { ...deal("new", 11000, 1100), gstTreatment: "inclusive" },
      { ...deal("proposal", 10000, 1000), gstTreatment: "exclusive" },
      { ...deal("won", 11000, 1100), gstTreatment: "inclusive" },
      { ...deal("won", 5000, 500), id: "non-taxable", gstTreatment: "not-applicable" },
    ];
    expect(pipelineTotals(s)).toEqual({
      estimatedOneOff: 20000,
      estimatedRecurring: 2000,
      wonOneOff: 15000,
      wonRecurring: 1500,
      openCount: 2,
      wonCount: 2,
    });
  });
  test("converts dollars into exact cents and rejects invalid commercial values", () => {
    expect(moneyCents("123.45")).toBe(12345);
    expect(() => moneyCents("-1")).toThrow();
    expect(() => moneyCents("NaN")).toThrow();
    expect(localDateTime(null)).toBe("");
  });
});
