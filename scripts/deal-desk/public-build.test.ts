import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "..");
/** The OS serves public/deal-desk as a static page. It must be rebuilt whenever tools/deal-desk or src/lib/deal-desk changes. */
test("public/deal-desk is a fresh build of tools/deal-desk", async () => {
  const out = await Bun.build({ entrypoints: [join(root, "tools/deal-desk/app.ts")], target: "browser", minify: false, sourcemap: "none" });
  expect(out.success).toBe(true);
  const norm = (s: string) => s.replace(/\r\n/g, "\n");
  expect(norm(readFileSync(join(root, "public/deal-desk/app.js"), "utf8"))).toBe(norm(await out.outputs[0].text()));
  expect(norm(readFileSync(join(root, "public/deal-desk/index.html"), "utf8"))).toBe(norm(readFileSync(join(root, "tools/deal-desk/index.html"), "utf8")));
});
