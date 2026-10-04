// Audit A-L4 (docs/AUDIT-20260927.md): control audit files are named by the owner's Sydney date,
// not the UTC date. Synthetic entries in a temp dir only.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createAuditLog, sydneyAuditDate } from "../control-audit";

test("Sydney calendar date, DST-aware", () => {
  expect(sydneyAuditDate("2026-09-27T13:59:59.000Z")).toBe("2026-09-27"); // 23:59 AEST
  expect(sydneyAuditDate("2026-09-27T14:00:00.000Z")).toBe("2026-09-28"); // 00:00 AEST next day
  expect(sydneyAuditDate("2026-10-04T13:30:00.000Z")).toBe("2026-10-05"); // 00:30 AEDT (DST began 4 Oct)
  expect(sydneyAuditDate("2027-04-03T13:30:00.000Z")).toBe("2027-04-04"); // 00:30 AEDT, the night DST ends
  expect(() => sydneyAuditDate("not a time")).toThrow();
});

test("a Sydney-morning entry lands in that Sydney day's file", () => {
  const dir = mkdtempSync(join(tmpdir(), "control-audit-"));
  try {
    const log = createAuditLog({ dir });
    // 07:30 Monday 28 Sep in Sydney is still Sunday 27 Sep in UTC.
    log.append({ ts: "2026-09-27T21:30:00.000Z", taskId: "t_synthetic42", action: "preview", tier: "read-only", approval: "not-needed", outcome: "preview" });
    expect(log.files().map((f) => basename(f))).toEqual(["control-2026-09-28.jsonl"]);
    expect(log.read()).toHaveLength(1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
