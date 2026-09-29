import { expect, test } from "bun:test";
import yaml from "js-yaml";
import { spliceTopLevelBlock } from "./config-splice";

test("only the named block changes; comments, order and CRLF survive", () => {
  const before =
    "# top comment\r\nmodel:\r\n  default: gpt-6-sol\r\nmoa:\r\n  default_preset: old\r\n  presets:\r\n    old:\r\n      enabled: true\r\n# keep me\r\nproviders:\r\n  claude-sub:\r\n    api: x\r\n";
  const after = spliceTopLevelBlock(before, "moa", { default_preset: "ministry", presets: { ministry: { enabled: true } } });
  expect(after.startsWith("# top comment\r\nmodel:\r\n  default: gpt-6-sol\r\nmoa:\r\n  default_preset: ministry")).toBe(true);
  expect(after).toContain("\r\n# keep me\r\nproviders:\r\n  claude-sub:\r\n    api: x\r\n");
  expect(/[^\r]\n/.test(after)).toBe(false);
  expect((yaml.load(after) as any).moa.presets.ministry.enabled).toBe(true);
});

test("appends the block when the key is absent", () => {
  expect(spliceTopLevelBlock("model:\n  x: 1\n", "moa", { presets: {} })).toBe("model:\n  x: 1\nmoa:\n  presets: {}\n");
});
