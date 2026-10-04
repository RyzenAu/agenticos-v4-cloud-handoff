import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCrm, upsertLead } from "../leads/crm";
import { draftForLead, draftMode } from "./dispatch";

const root = mkdtempSync(join(tmpdir(), "mu-draft-dispatch-"));
const db = openCrm(join(root, "crm.sqlite"));
const lead = upsertLead(db, { placeId: "synthetic-dental", vertical: "dental", name: "Sample Dental", area: "Sydney NSW", phone: "", address: "", website: "", mapsUrl: "", rating: null, reviews: null, emails: [], emailOk: false, score: 0, pitch: "website", reasons: [], googleAt: null, source: "osm" } as any);
afterAll(() => { db.close(); rmSync(root, { recursive: true, force: true }); });

test("dental defaults to the owner's flagship; other existing design workflows remain available", () => {
  expect(draftMode("dental")).toBe("flagship");
  expect(draftMode("dental", "bespoke")).toBe("bespoke");
  expect(draftMode("legal")).toBe("bespoke");
});
test("the CLI/voice/quick-action dispatch cannot run a Claude or generic builder for default dental", async () => {
  let flagshipCalls = 0;
  const builders = {
    flagship: async () => { flagshipCalls++; return { record: { slug: "sample-dental" } }; },
    bespoke: async () => { throw new Error("Unexpected Claude build"); },
    fast: async () => { throw new Error("Unexpected generic template"); },
  } as unknown as Parameters<typeof draftForLead>[3];
  const options = { root, draftsRoot: join(root, "drafts"), by: "synthetic" };
  expect((await draftForLead(db, lead.id, options, builders)).kind).toBe("flagship");
  expect((await draftForLead(db, lead.id, { ...options, fast: true }, builders)).kind).toBe("flagship");
  expect(flagshipCalls).toBe(2);
  builders!.flagship = async () => { throw new Error("Selected template missing"); };
  await expect(draftForLead(db, lead.id, options, builders)).rejects.toThrow("Selected template missing");
});
