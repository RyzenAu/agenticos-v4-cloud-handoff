import { describe, expect, test } from "bun:test";
import {
  crmRefString,
  parseCrmRef,
  resolveCrmContext,
  resolveLegacyLead,
  CRM_KINDS,
} from "../../src/lib/crm-ref";
import { crmHref, artifactHref } from "../../src/lib/crm-links";
describe("CRM integration references", () => {
  test("all kinds round trip and preserve legacy IDs", () => {
    for (const kind of CRM_KINDS)
      expect(parseCrmRef(crmRefString({ kind, id: "42" }))).toEqual({ kind, id: "42" });
    expect(resolveLegacyLead(42)).toEqual({ kind: "lead", id: "42" });
    expect(resolveLegacyLead(42, () => ({ kind: "company", id: "legacy-42" }))).toEqual({
      kind: "company",
      id: "legacy-42",
    });
    expect(crmHref({ kind: "lead", id: "42" })).toBe("/leads?lead=42");
    expect(crmHref({ kind: "deal", id: "42" }, "timeline")).toBe(
      "/crm?ref=crm%3Adeal%3A42&tab=timeline",
    );
  });
  test("malformed references fail closed", () => {
    for (const s of [
      "crm:person:42",
      "crm:deal:",
      "crm:deal:../42",
      "crm:deal:42?x",
      "crm:deal:42:x",
      " crm:deal:42",
      "crm:deal:42\n",
    ])
      expect(parseCrmRef(s)).toBeNull();
    expect(() => crmRefString({ kind: "deal", id: "../x" })).toThrow();
  });
  test("ambiguous page targets ask; explicit targets override page context", () => {
    const a = { kind: "company" as const, id: "a" },
      b = { kind: "company" as const, id: "b" };
    expect(resolveCrmContext({ context: { candidates: [a, b] } }).ok).toBe(false);
    expect(resolveCrmContext({ context: { candidates: [a, a] } })).toMatchObject({
      ok: true,
      ref: a,
    });
    expect(resolveCrmContext({ ref: b, context: { crm: a } })).toMatchObject({
      ok: true,
      ref: b,
      how: "explicit",
    });
    expect(resolveCrmContext({ context: { crm: a }, kinds: ["deal"] }).ok).toBe(false);
  });
  test("artifacts link to gated routes and reject traversal or external destinations", () => {
    expect(artifactHref("artifact:job-1/research/report.md")).toBe(
      "/__computers/artifacts/job-1/f/research/report.md",
    );
    expect(artifactHref("artifact:job-1")).toBe("/__computers/artifacts/job-1");
    for (const s of [
      "https://evil.test",
      "artifact:job/../secret",
      "artifact:job/%2e%2e/secret",
      "artifact:job//file",
      "artifact:job/file?x",
      "artifact:job/\\file",
    ])
      expect(artifactHref(s)).toBeNull();
  });
});
