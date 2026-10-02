// @ts-ignore: bun supplies test types at runtime.
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
test("CRM isolated non-browser React DOM interactions", () => {
  const root = resolve(import.meta.dir, "../../..");
  const result = spawnSync(process.execPath, ["test", "./src/components/crm/behaviour.inner.tsx"], {
    cwd: root,
    encoding: "utf8",
  });
  const output = (result.stdout ?? "") + (result.stderr ?? "");
  if (result.status !== 0) console.log(output.slice(-8000));
  expect(result.status).toBe(0);
  expect(Number(output.match(/(\d+) pass/)?.[1] ?? 0)).toBeGreaterThanOrEqual(9);
}, 120000);
