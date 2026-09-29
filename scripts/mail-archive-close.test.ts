// close() must succeed with prepared statements open and must not lose committed mail (synthetic messages, temp dir).
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mailArchive } from "./mail-archive";

const roots: string[] = [];
afterAll(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));
test("close after writes does not throw, is idempotent, and a fresh handle sees every committed message", () => {
  const root = mkdtempSync(join(tmpdir(), "mail-close-"));
  roots.push(root);
  const a = mailArchive(root);
  a.importMetadata("gmail", "synthetic@example.test", [{ id: "m1", threadId: "t1", internalDate: String(Date.UTC(2026, 8, 29)), snippet: "hello synthetic", payload: { headers: [{ name: "Subject", value: "Synthetic one" }, { name: "From", value: "a@example.test" }] } }]);
  expect(() => a.close()).not.toThrow();
  expect(() => a.close()).not.toThrow();
  const b = mailArchive(root);
  expect(b.stats().total).toBe(1);
  b.close();
});
