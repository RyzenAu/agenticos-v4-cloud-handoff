import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyOwnSiteFacts, type Evidence } from "./evidence";

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const base = (): Evidence => ({
  leadId: 1, name: "X Lawyers", vertical: "legal", area: "Parramatta NSW", generatedAt: "2026-09-24T00:00:00.000Z",
  facts: [{ category: "contact", field: "phone", value: "", sourceUrl: "https://www.openstreetmap.org/node/1", sourceLabel: "OpenStreetMap", observedAt: "2026-09-24T00:00:00.000Z", status: "missing" }],
  services: [], hasOwnWebsite: false, ownSiteReachable: false, robotsBlocked: false, complianceNotes: [],
});

describe("own-site facts", () => {
  test("facts read on the business's own site outrank the directory listing and carry its URL", () => {
    const dir = mkdtempSync(join(tmpdir(), "own-site-")); dirs.push(dir);
    writeFileSync(join(dir, "own-site-facts.json"), JSON.stringify({ sourceUrl: "https://example.com.au/contact", phone: "02 8539 7475", services: ["Family Law", "Conveyancing"] }));
    const e = applyOwnSiteFacts(base(), dir);
    const phone = e.facts.find((f) => f.field === "phone")!;
    expect(phone.value).toBe("02 8539 7475");
    expect(phone.status).toBe("verified");
    expect(phone.sourceLabel).toBe("Business's own website");
    expect(e.services.map((s) => s.value)).toEqual(["Family Law", "Conveyancing"]);
    expect(e.hasOwnWebsite).toBe(true);
  });

  test("no file, or a non-public source URL, changes nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "own-site-")); dirs.push(dir);
    expect(applyOwnSiteFacts(base(), dir)).toEqual(base());
    writeFileSync(join(dir, "own-site-facts.json"), JSON.stringify({ sourceUrl: "http://127.0.0.1/x", phone: "1" }));
    expect(applyOwnSiteFacts(base(), dir).facts[0].value).toBe("");
  });
});
