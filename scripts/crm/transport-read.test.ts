import { expect, test } from "bun:test";
import { BusinessContractFixture, founders, invokeHandler } from "./business-contract-fixtures";
import { createCrmMiddleware } from "./plugin";
import { crmRefString } from "../../src/lib/crm-ref";

test("read-only founder sessions load deferred document bodies over GET while mutations stay blocked", async () => {
  const f = new BusinessContractFixture();
  try {
    const company = f.store.createCompany(
      { name: "Synthetic read-only company" },
      { personId: "usman" },
    );
    const document = f.store.createDocument(
      { companyId: company.id, title: "Synthetic brief", content: "The exact saved requirements" },
      { personId: "usman" },
    );
    const middleware = createCrmMiddleware({
      root: f.dir,
      token: "synthetic-only",
      role: () => "server",
      readOnly: () => true,
      principal: () => founders.mehroz,
      service: () => ({
        snapshot: () => f.store.snapshot({ documentSummaries: true }),
        resolveLegacyLead: (id) => f.store.resolveLegacyLead(id),
        operations: f.ops,
      }),
    });
    const summary = await invokeHandler(middleware.handle, { url: "/__crm/snapshot" });
    expect(summary.status).toBe(200);
    expect(JSON.parse(summary.text).documents[0].versions[0]).toMatchObject({
      content: "",
      contentDeferred: true,
    });
    const url = `/__crm/record?ref=${encodeURIComponent(crmRefString({ kind: "document", id: document.id }))}`;
    const full = await invokeHandler(middleware.handle, { url });
    expect(full.status).toBe(200);
    expect(JSON.parse(full.text).data.versions[0].content).toBe("The exact saved requirements");
    expect(full.headers["cache-control"]).toBe("no-store");
    const write = await invokeHandler(middleware.handle, {
      url: "/__crm/ops",
      method: "POST",
      body: {
        name: "crm.company.update",
        input: {
          id: company.id,
          expectedVersion: company.version,
          patch: { name: "Must not save" },
        },
      },
    });
    expect(write.status).toBe(409);
    expect(f.store.getCompany(company.id)?.name).toBe(company.name);
    expect(
      (await invokeHandler(middleware.handle, { url: "/__crm/record?ref=crm:document:missing" }))
        .status,
    ).toBe(404);
    expect(
      (await invokeHandler(middleware.handle, { url: "/__crm/record?ref=garbage" })).status,
    ).toBe(400);
    const anonymous = createCrmMiddleware({
      root: f.dir,
      token: "synthetic-only",
      principal: () => null,
      service: () => {
        throw new Error("Must not open");
      },
    });
    expect((await invokeHandler(anonymous.handle, { url })).status).toBe(401);
  } finally {
    f.dispose();
  }
});
