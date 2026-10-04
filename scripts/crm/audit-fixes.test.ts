// Regression tests for the first mounted-app audit (F-02, F-09, F-10, F-18): unnamed Google leads, CSV headers and round trip, the timeline's story, rule wording.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCrm, upsertLead, findLead } from "../leads/crm";
import { editLead, leadEditVersion } from "../leads/edit";
import type { Principal } from "../identity/principal";
import { companyLabel } from "../../src/components/crm/selectors";
import { CrmAutomations } from "./automation";
import { CrmCsv } from "./csv";
import { isAuPhone, timeZoneNames } from "./validation";
import { createCrmOperations } from "./ops";
import { CrmStore } from "./store";

const usman: Principal = {
  personId: "usman",
  via: "loopback-owner",
  actor: "human",
  displayName: "Usman",
};
const by = { personId: "usman" as const };
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* Windows keeps a closed SQLite file locked for a moment */
    }
  }
});
function googleLeads(count = 2) {
  const dir = mkdtempSync(join(tmpdir(), "crm-audit-"));
  dirs.push(dir);
  const db = openCrm(join(dir, "crm.sqlite"));
  for (let i = 1; i <= count; i++)
    upsertLead(db, {
      placeId: `gp-${i}`,
      source: "google",
      attribution: "",
      vertical: "dental",
      area: "Parramatta",
      name: `Synthetic Dental ${i}`,
      phone: "",
      address: "",
      website: "",
      mapsUrl: "",
      rating: null,
      reviews: null,
      emails: [],
      emailOk: false,
      score: 0,
      pitch: "website",
      reasons: [],
      googleAt: null,
    });
  return { db, store: new CrmStore(db) };
}

test("F-02: a migrated Google lead has no stored name, so every screen prints a readable label with the suburb, industry and lead number", () => {
  const { store } = googleLeads();
  const [first] = store.snapshot().companies;
  expect(first.name).toBe(""); // the storage rule is unchanged
  expect(companyLabel(first)).toBe("Unnamed company · dental, Parramatta (lead #1)");
  expect(companyLabel(first, { short: true })).toBe("Unnamed company (lead #1)");
  expect(companyLabel({ name: "  Real Name  " })).toBe("Real Name");
  expect(companyLabel({ name: "", industry: "", locality: "", legacyLeadId: null })).toBe(
    "Unnamed company",
  );
  expect(companyLabel(null)).toBe("Unnamed company");
});

test("F-02: two unnamed companies in the same suburb are never offered as duplicates, but two real same-name companies still are", () => {
  const { store } = googleLeads(3);
  const ops = createCrmOperations({ store });
  const pairs =
    (ops.run("crm.duplicates.list", {}, usman).data as {
      a: { id: string };
      b: { id: string };
      reasons: string[];
    }[]) ?? [];
  expect(pairs).toEqual([]);
  store.createCompany({ name: "Harbour Dental", locality: "Sydney" }, by);
  store.createCompany({ name: "harbour  dental", locality: "sydney" }, by);
  const after = ops.run("crm.duplicates.list", {}, usman).data as { reasons: string[] }[];
  expect(after).toHaveLength(1);
  expect(after[0].reasons).toContain("same name and locality");
});

test("F-02: a deal auto-titled before its company had a name is retitled when the name arrives through Leads; a founder's own title is left alone", () => {
  const { db, store } = googleLeads(2);
  let snap = store.snapshot();
  expect(snap.deals.map((d) => d.title).sort()).toEqual([
    "Lead #1 opportunity",
    "Lead #2 opportunity",
  ]);
  // A founder retitles lead 2's deal by hand.
  const second = snap.deals.find((d) => d.legacyLeadId === 2)!;
  store.updateDeal(second.id, { title: "Dentist rebrand" }, second.version, by);
  // A founder confirms both names in Leads (a manual correction is the independent source).
  for (const id of [1, 2]) {
    const lead = findLead(db, id)!;
    editLead(db, id, {
      by: "usman",
      version: leadEditVersion(lead),
      name: `Confirmed Dental ${id}`,
    });
  }
  snap = store.snapshot();
  expect(snap.companies.map((c) => c.name).sort()).toEqual([
    "Confirmed Dental 1",
    "Confirmed Dental 2",
  ]);
  const titles = Object.fromEntries(snap.deals.map((d) => [d.legacyLeadId, d.title]));
  expect(titles[1]).toBe("Confirmed Dental 1 opportunity");
  expect(titles[2]).toBe("Dentist rebrand");
  // Reading again changes nothing (no second version bump).
  const versions = snap.deals.map((d) => d.version);
  expect(store.snapshot().deals.map((d) => d.version)).toEqual(versions);
});

function csvRig() {
  const dir = mkdtempSync(join(tmpdir(), "crm-audit-csv-"));
  dirs.push(dir);
  const db = openCrm(join(dir, "crm.sqlite"));
  const store = new CrmStore(db);
  return { store, csv: new CrmCsv(store) };
}

test("F-09: natural headings are accepted and mapped, in any case", () => {
  const { csv } = csvRig();
  const preview = csv.preview(
    "Business name,Phone,Email,Suburb\nNatural Co,0412 345 678,hello@natural.example,Penrith",
  );
  expect(preview.invalid).toBe(0);
  expect(preview.headers).toEqual(["name", "phone", "email", "locality"]);
  expect(preview.rows[0].values).toMatchObject({
    name: "Natural Co",
    phone: "0412 345 678",
    email: "hello@natural.example",
    locality: "Penrith",
  });
  expect(csv.preview("NAME,business_phone\nUpper Co,0412 345 678").rows[0].values.phone).toBe(
    "0412 345 678",
  );
});

test("F-09: an unknown or doubled column is refused in plain words, never as 'transient directory payloads'", () => {
  const { csv } = csvRig();
  let message = "";
  try {
    csv.preview("name,favourite colour\nX,blue");
  } catch (e) {
    message = (e as Error).message;
  }
  expect(message).toContain("These columns aren't recognised: favourite colour");
  expect(message).not.toMatch(/transient|payload/i);
  expect(() => csv.preview("name,Business name\nX,Y")).toThrow(/both mean "name"/);
});

test("F-09: Export all, then import that same file: every row is a match, nothing is new, and the export's own columns are ignored", () => {
  const { store, csv } = csvRig();
  store.createCompany(
    {
      name: "Alpha Dental",
      locality: "Sydney",
      emails: ["a@alpha.example", "b@alpha.example"],
      phone: "0412 345 678",
      tags: ["vip", "dental"],
      notes: "Note, with a comma",
    },
    by,
  );
  store.createCompany({ name: "Beta Legal", locality: "Penrith" }, by);
  const exported = csv.export("companies");
  expect(exported.count).toBe(2);
  const preview = csv.preview(exported.csv);
  expect(preview.invalid).toBe(0);
  expect(preview.ignored).toEqual(["id", "source", "version"]);
  expect(preview.rows).toHaveLength(2);
  for (const row of preview.rows) expect(row.conflicts.length).toBeGreaterThan(0);
  expect(preview.rows.every((r) => r.conflicts.some((c) => c.reason === "same record ID"))).toBe(
    true,
  );
  // Skipping every match leaves the CRM exactly as it was.
  csv.commit(
    preview.id,
    preview.rows.map((r) => ({ row: r.row, action: "skip" as const })),
    by,
  );
  expect(store.snapshot().companies).toHaveLength(2);
  // Contacts and deals round-trip too.
  const company = store.snapshot().companies[0];
  store.createContact(
    { companyId: company.id, name: "Sam Contact", email: "sam@alpha.example" },
    by,
  );
  store.createDeal(
    { companyId: company.id, title: "Alpha website", service: "website" } as never,
    by,
  );
  for (const kind of ["contacts", "deals"] as const) {
    const again = csv.preview(csv.export(kind).csv, kind);
    expect(again.invalid).toBe(0);
    expect(again.rows.every((r) => r.conflicts.length > 0)).toBe(true);
  }
});

test("F-10: what a founder does to records is recorded in words, once, and never prints an id", () => {
  const { store } = csvRig();
  const ops = createCrmOperations({ store });
  const run = (name: string, input: unknown) => {
    const r = ops.run(name, input, usman);
    expect(r.ok, `${name}: ${r.text}`).toBe(true);
    return r.data as { id: string; version: number };
  };
  const company = run("crm.company.create", { name: "Story Co" });
  run("crm.company.update", {
    id: company.id,
    expectedVersion: company.version,
    patch: { phone: "02 9999 0000", notes: "hello" },
  });
  run("crm.contact.add", { companyId: company.id, name: "Sam Contact" });
  const deal = run("crm.deal.create", {
    companyId: company.id,
    title: "Story website",
    service: "website",
  });
  const moved = ops.run(
    "crm.deal.move",
    {
      id: deal.id,
      expectedVersion: deal.version,
      stageId: "proposal",
      reason: "Scope agreed on the phone",
    },
    usman,
  );
  expect(moved.ok).toBe(true);
  const task = run("crm.task.create", { companyId: company.id, title: "Send the quote" });
  run("crm.task.complete", { id: task.id, expectedVersion: task.version });
  const titles = store
    .snapshot()
    .activities.filter((a) => a.kind === "change")
    .map((a) => a.title)
    .sort();
  expect(titles).toEqual(
    [
      "Company added: Story Co",
      "Company details updated (phone, notes)",
      "Contact added: Sam Contact",
      "Deal added: Story website",
      "Deal moved to Proposal: Story website",
      "Task added: Send the quote",
      "Task completed: Send the quote",
    ].sort(),
  );
  const note = store.snapshot().activities.find((a) => a.title.startsWith("Deal moved"))!.note;
  expect(note).toBe("Scope agreed on the phone");
  for (const a of store.snapshot().activities)
    for (const id of [company.id, deal.id, task.id])
      expect(a.title + (a.note ?? "")).not.toContain(id);
  // The same change is never recorded twice, and an import or a refused change adds nothing.
  const before = store.snapshot().activities.length;
  ops.run("crm.task.complete", { id: task.id, expectedVersion: 1 }, usman); // stale version: refused
  expect(store.snapshot().activities).toHaveLength(before);
});

test("F-18: the event rules are described in plain words", () => {
  const { store } = csvRig();
  const rules = new CrmAutomations({ store }).list();
  expect(rules.length).toBeGreaterThan(0);
  for (const rule of rules) {
    expect(rule.sourceRequirement).not.toMatch(
      /durable|trigger service|stable event|persisted|polling|event ID/i,
    );
    expect(rule.action).not.toMatch(
      /durable|trigger service|stable event|persisted|polling|event ID/i,
    );
  }
});

test("F-19: Australian phone numbers are accepted in the ways people write them, and nonsense is not", () => {
  for (const ok of [
    "",
    "02 9999 0000",
    "(02) 9999 0000",
    "9999 0000",
    "0412 345 678",
    "0412345678",
    "+61 412 345 678",
    "+61 2 9999 0000",
    "1300 123 456",
    "1800 123 456",
    "13 12 34",
    "+64 9 123 4567",
  ])
    expect(isAuPhone(ok), ok).toBe(true);
  for (const bad of [
    "abc",
    "12345",
    "0112 345 678",
    "+61 112 345 678",
    "04123",
    "02 9999 000",
    "phone 0412 345 678",
  ])
    expect(isAuPhone(bad), bad).toBe(false);
  expect(timeZoneNames()[0]).toBe("Australia/Sydney");
  expect(
    timeZoneNames()
      .slice(0, 5)
      .every((z) => z.startsWith("Australia/")),
  ).toBe(true);
});

test("F-19: a validation failure names each field in plain words and returns a message per field, never a field path", () => {
  const { store } = csvRig();
  const ops = createCrmOperations({ store });
  const bad = ops.run(
    "crm.company.create",
    { name: "Path Co", phone: "abc", timezone: "Mars/Olympus", emails: ["nope"] },
    usman,
  );
  expect(bad.ok).toBe(false);
  expect(bad.code).toBe("validation");
  expect(bad.fieldErrors).toEqual({
    phone: "Enter an Australian phone number, such as 02 9999 0000 or 0412 345 678.",
    timezone: "Choose a time zone from the list.",
    emails: "Enter a valid email address.",
  });
  expect(bad.text).toBe(
    "Time zone: Choose a time zone from the list. Phone: Enter an Australian phone number, such as 02 9999 0000 or 0412 345 678. Email addresses: Enter a valid email address.",
  );
  expect(bad.text).not.toMatch(/emails\.0|patch\.|timezone:/);
  // An update's patch fields are named the same way.
  const company = store.createCompany({ name: "Patch Co" }, by);
  const update = ops.run(
    "crm.company.update",
    { id: company.id, expectedVersion: company.version, patch: { phone: "abc" } },
    usman,
  );
  expect(Object.keys(update.fieldErrors ?? {})).toEqual(["phone"]);
  expect(update.text.startsWith("Phone: ")).toBe(true);
  // A blank name says so plainly.
  expect(ops.run("crm.company.create", { name: "" }, usman).fieldErrors).toEqual({
    name: "This is required.",
  });
  expect(store.snapshot().companies.map((c) => c.name)).toEqual(["Patch Co"]);
});
