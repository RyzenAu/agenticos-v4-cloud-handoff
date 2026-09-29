import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readHunt } from "./hunt";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));
function file(data: unknown) {
  const dir = mkdtempSync(join(tmpdir(), "lead-hunt-"));
  dirs.push(dir);
  const path = join(dir, "lead-hunt-last.json");
  writeFileSync(path, JSON.stringify(data));
  return path;
}
const NOW = Date.parse("2026-09-24T03:00:00");

test("a night where Places refused every search is failed with the owner's fix, never ok", () => {
  // The shape lead-hunt.py wrote before it recorded a status.
  const report = readHunt(
    file({
      ran_at: "2026-09-24T01:30:32",
      area: "Mount Druitt NSW",
      runs: [],
      errors: [
        "dental: Places API 403: The caller does not have permission",
        "real-estate: Places API 403: The caller does not have permission",
      ],
    }),
    NOW,
  );
  expect(report).toMatchObject({ status: "failed", added: 0, overdue: false, failingSince: "2026-09-24T01:30:32" });
  expect(report.problem).toContain("403");
  expect(report.ownerAction).toContain("Places API (New)");
});

test("the script's own status and owner action are used, arrows made readable", () => {
  const report = readHunt(
    file({
      ran_at: "2026-09-24T01:30:32",
      area: "Rooty Hill NSW",
      runs: [{ vertical: "dental", new: 3 }],
      errors: ["real-estate: Places API 429: quota"],
      status: "partial",
      problem: "Google Places quota or billing stopped the search",
      owner_action: "Check billing > quotas.",
      failing_since: "2026-09-23T01:30:00",
    }),
    NOW,
  );
  expect(report).toMatchObject({ status: "partial", added: 3, failingSince: "2026-09-23T01:30:00" });
  expect(report.ownerAction).toBe("Check billing → quotas.");
});

test("a clean night is ok; no file or an old run is flagged", () => {
  expect(readHunt(file({ ran_at: "2026-09-24T01:30:00", area: "x", runs: [{ new: 2 }], errors: [] }), NOW)).toMatchObject({
    status: "ok",
    added: 2,
    failingSince: null,
  });
  expect(readHunt(null, NOW)).toMatchObject({ status: "never", overdue: true });
  expect(readHunt(file({ ran_at: "2026-09-20T01:30:00", runs: [], errors: [] }), NOW).overdue).toBe(true);
});
