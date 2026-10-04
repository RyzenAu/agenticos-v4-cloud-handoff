import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SHORTHAND, readShorthand, shorthandIn } from "./shorthand";

const root = mkdtempSync(join(tmpdir(), "shorthand-"));
mkdirSync(join(root, ".operator-data"));
writeFileSync(join(root, ".operator-data", "shorthand.json"), JSON.stringify({ terms: { SR: "Sydney Road clinic", yt: "YouTube Music" } }));
afterAll(() => rmSync(root, { recursive: true, force: true }));

test("finds shorthand as whole words only", () => {
  expect(shorthandIn("open yt and search lofi", DEFAULT_SHORTHAND)).toEqual(["yt = YouTube"]);
  expect(shorthandIn("check my IG and gh", DEFAULT_SHORTHAND)).toEqual(["ig = Instagram", "gh = GitHub"]);
  expect(shorthandIn("the M&U deck", DEFAULT_SHORTHAND)).toEqual(["m&u = M&U Ventures"]);
  expect(shorthandIn("bytes and light", DEFAULT_SHORTHAND)).toEqual([]);
  expect(shorthandIn("youtube", DEFAULT_SHORTHAND)).toEqual([]);
});

test("his own terms are added and override the defaults", () => {
  const map = readShorthand(root);
  expect(map.sr).toBe("Sydney Road clinic");
  expect(map.yt).toBe("YouTube Music");
  expect(map.ig).toBe("Instagram");
  expect(readShorthand(join(root, "missing"))).toEqual(DEFAULT_SHORTHAND);
});
