import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { CrmStore } from "./store";
import { CrmCsv } from "./csv";
const opened: Database[] = [];
const by = { personId: "usman" as const };
function fixture() {
  const db = new Database(":memory:");
  opened.push(db);
  const store = new CrmStore(db);
  return { store, csv: new CrmCsv(store) };
}
afterEach(() => {
  for (const db of opened.splice(0)) db.close();
});
describe("reviewed atomic CSV imports", () => {
  test("preview validates and commit is durable/idempotent", () => {
    const { store, csv } = fixture();
    const preview = csv.preview(
      "name,email,owner\nExample Pty Ltd,owner@example.test,mehroz\nInvalid,not-an-email,usman",
    );
    expect(preview.valid).toBe(1);
    expect(preview.invalid).toBe(1);
    expect(store.snapshot().companies).toHaveLength(0);
    expect(() => csv.commit(preview.id, [], by)).toThrow();
    expect(store.snapshot().companies).toHaveLength(0);
    const resolutions = [{ row: 3, action: "skip" as const }];
    const first = csv.commit(preview.id, resolutions, by);
    expect(first.created).toBe(1);
    const restarted = new CrmCsv(store);
    expect(restarted.commit(preview.id, resolutions, by)).toMatchObject({
      duplicate: true,
      created: 1,
    });
    expect(store.snapshot().companies).toHaveLength(1);
    expect(() =>
      restarted.commit(
        preview.id,
        [
          { row: 2, action: "skip" },
          { row: 3, action: "skip" },
        ],
        by,
      ),
    ).toThrow();
  });
  test("duplicates require a decision and updates never clear opt-outs", () => {
    const { store, csv } = fixture();
    const c = store.createCompany(
      {
        name: "Existing",
        phone: "0412 345 678",
        doNotContact: true,
        excluded: true,
        excludedReason: "Owner exclusion",
        notes: "Preserve this",
      },
      by,
    );
    const p = csv.preview("name,phone,optedOut,notes\nExisting,+61 412 345 678,false,");
    expect(p.conflicts).toBe(1);
    expect(() => csv.commit(p.id, [], by)).toThrow();
    csv.commit(
      p.id,
      [{ row: 2, action: "update", recordId: c.id, expectedVersion: c.version }],
      by,
    );
    const after = store.getCompany(c.id)!;
    expect(after.doNotContact).toBe(true);
    expect(after.excluded).toBe(true);
    expect(after.notes).toBe("Preserve this");
  });
  test("a stale conflict aborts every preceding change in the batch", () => {
    const { store, csv } = fixture();
    const c = store.createCompany({ name: "Existing" }, by);
    const p = csv.preview("name,notes\nFresh company,new\nExisting,imported");
    store.updateCompany(c.id, { notes: "Concurrent edit" }, c.version, by);
    expect(() =>
      csv.commit(
        p.id,
        [{ row: 3, action: "update", recordId: c.id, expectedVersion: c.version }],
        by,
      ),
    ).toThrow();
    expect(store.snapshot().companies).toHaveLength(1);
    expect(store.getCompany(c.id)?.notes).toBe("Concurrent edit");
  });
  test("in-file duplicates are flagged, forbidden sources are not persisted", () => {
    const { store, csv } = fixture();
    const p = csv.preview("name,locality\nDuplicate,Sydney\nDuplicate,Sydney");
    expect(p.rows[1].conflicts[0].id).toBe("csv-row:2");
    expect(() => csv.commit(p.id, [], by)).toThrow();
    expect(store.snapshot().companies).toHaveLength(0);
    csv.commit(p.id, [{ row: 3, action: "skip" }], by);
    expect(store.snapshot().companies).toHaveLength(1);
    expect(() => csv.preview("name,source\nTransient Places name,google")).toThrow();
    expect(() => csv.preview("name,fieldSources\nBad,google")).toThrow();
  });
  test("new duplicate candidates after preview force another review", () => {
    const { store, csv } = fixture();
    const preview = csv.preview("name\nConcurrent company");
    store.createCompany({ name: "Concurrent company" }, by);
    expect(() => csv.commit(preview.id, [], by)).toThrow("new duplicate candidates");
    expect(store.snapshot().companies).toHaveLength(1);
  });
  test("contacts and multiple deals import under an explicit company", () => {
    const { store, csv } = fixture();
    const c = store.createCompany({ name: "Account" }, by);
    const contacts = csv.preview(
      `companyId,name,email\n${c.id},Sarah,sarah@example.test\n${c.id},Alex,alex@example.test`,
      "contacts",
    );
    expect(csv.commit(contacts.id, [], by).created).toBe(2);
    const deals = csv.preview(
      `companyId,title,oneOffCents,gst\n${c.id},Website,165000,inclusive\n${c.id},Future project,200000,exclusive`,
      "deals",
    );
    expect(csv.commit(deals.id, [], by).created).toBe(2);
    expect(store.snapshot().deals[0].currency).toBe("AUD");
    const exported = csv.export("companies");
    expect(exported.count).toBe(1);
    expect(exported.csv).toContain('"Account"');
  });
});
