import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publishPageContext, readPageContext, resetPageContext } from "../../src/lib/page-context";
import { resolveCrmContext } from "../../src/lib/crm-ref";
import { configureCrmIntegrations, crmRuntime, closeCrmRuntime } from "./runtime";
import type { CrmChange } from "./store";

afterEach(resetPageContext);
test("CRM hands committed invalidations to the owning stream adapter without field values", () => {
  const root = mkdtempSync(join(tmpdir(), "crm-event-contract-"));
  const changes: CrmChange[] = [];
  const remove = configureCrmIntegrations(root, {
    publishChange: (change) => changes.push(change),
  });
  try {
    const store = crmRuntime(root).store;
    const company = store.createCompany(
      { name: "Synthetic confidential name" },
      { personId: "usman" },
    );
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      ref: { kind: "company", id: company.id },
      change: "created",
    });
    expect(Object.keys(changes[0]).sort()).toEqual(["at", "change", "ref"]);
    expect(Date.parse(changes[0].at)).toBeGreaterThanOrEqual(Date.parse(company.createdAt));
    expect(JSON.stringify(changes)).not.toContain(company.name);
    expect(() =>
      store.transaction(() => {
        store.createCompany({ name: "Must roll back" }, { personId: "mehroz" });
        throw new Error("Synthetic rollback");
      }),
    ).toThrow("Synthetic rollback");
    expect(changes).toHaveLength(1);
    remove();
    store.updateCompany(company.id, { notes: "Saved after disconnect" }, company.version, {
      personId: "usman",
    });
    expect(changes).toHaveLength(1);
  } finally {
    remove();
    closeCrmRuntime(root);
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* Windows keeps a just-closed SQLite file locked for a moment; a temp folder may outlive the test */
    }
  }
});

test("CRM uses the existing page selection contract and withdraws it on unmount", () => {
  publishPageContext("crm", {
    selection: {
      kind: "client",
      id: "company-7",
      label: "Synthetic company",
      to: "/crm",
      search: { ref: "crm:deal:deal-7", tab: "deals" },
    },
  });
  expect(resolveCrmContext({ context: readPageContext() })).toEqual({
    ok: true,
    ref: { kind: "deal", id: "deal-7" },
    how: "active-record",
  });
  publishPageContext("crm", null);
  expect(resolveCrmContext({ context: readPageContext() }).ok).toBe(false);
  expect(
    resolveCrmContext({
      context: { selection: { to: "/finance", search: { ref: "crm:deal:deal-7" } } },
    }).ok,
  ).toBe(false);
});

// Claude owns the server event topic, Jobs subjects/filter, route mount and navigation.
// These tests exercise the CRM extension boundary; they do not claim those mounts are integrated.
