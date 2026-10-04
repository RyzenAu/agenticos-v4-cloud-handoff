import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { CrmStore } from "./store";
import { measureCrmPerformance } from "./performance";

test("directory reads keep prepared-statement count constant as document histories grow", () => {
  const { results } = measureCrmPerformance([2, 12], 1);
  expect(results[1].snapshot.queryCount).toBe(results[0].snapshot.queryCount);
  expect(results[1].snapshot.queryCount).toBeLessThan(25);
  expect(results[1].list.queryCount).toBe(results[0].list.queryCount);
  expect(results[1].list.queryCount).toBeLessThan(results[1].snapshot.queryCount);
  expect(results[1].summarySnapshot.jsonBytes).toBeLessThan(results[1].snapshot.jsonBytes);
});

test("document summaries explicitly defer bodies and exact record reads retain statuses and versions", () => {
  const db = new Database(":memory:");
  try {
    const store = new CrmStore(db),
      by = { personId: "mehroz" as const };
    const company = store.createCompany({ name: "Synthetic document company" }, by);
    let document = store.createDocument(
      { companyId: company.id, title: "Synthetic brief", content: "Original requirements" },
      by,
    );
    document = store.updateDocument(document.id, { status: "issued" }, document.version, by);
    document = store.addDocumentVersion(
      document.id,
      { content: "Corrected requirements" },
      document.version,
      by,
    );
    document = store.updateDocument(document.id, { status: "accepted" }, document.version, by);
    const summary = store.snapshot({ documentSummaries: true }).documents[0];
    expect(summary.versions.map((v) => [v.number, v.status, v.content, v.contentDeferred])).toEqual(
      [
        [1, "issued", "", true],
        [2, "accepted", "", true],
      ],
    );
    const loaded = store.getDocument(document.id)!;
    expect(loaded.versions.map((v) => v.content)).toEqual([
      "Original requirements",
      "Corrected requirements",
    ]);
    expect(loaded.versions.every((v) => !v.contentDeferred)).toBe(true);
    expect(store.snapshot().documents[0]).toEqual(loaded);
  } finally {
    db.close();
  }
});
