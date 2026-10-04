import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { exportConsistencyFixtureJson, exportPackageEconomicsJson } from "../src/lib/business-economics";
import { exportReceptionistCatalogueJson } from "../src/lib/receptionist-packages";

/** Fixed OS-only destinations: no configurable path, providers, secrets or other repository writes. */
const TARGETS = [
  { url: new URL("../docs/receptionist-package-catalogue.json", import.meta.url), content: exportReceptionistCatalogueJson },
  { url: new URL("../docs/sales/receptionist-pack-2026-09-28/package-economics.json", import.meta.url), content: exportPackageEconomicsJson },
  { url: new URL("../docs/receptionist-consistency-fixture.json", import.meta.url), content: exportConsistencyFixtureJson },
] as const;

export async function exportReceptionistCatalogue(check = false) {
  const written: string[] = [];
  for (const target of TARGETS) {
    const path = fileURLToPath(target.url);
    const content = target.content();
    if (check) {
      const current = await readFile(path, "utf8").catch(() => null);
      if (current !== content) throw new Error(`Stale export: ${path}; run bun scripts/export-receptionist-catalogue.ts`);
    } else {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content, "utf8");
    }
    written.push(path);
  }
  return { targets: written, mode: "draft-only", checked: check };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--check")) throw new Error("Only --check is supported; output destinations are fixed.");
  const result = await exportReceptionistCatalogue(args.includes("--check"));
  console.log(`${result.checked ? "Verified" : "Exported"} draft-only catalogue and economics:\n${result.targets.join("\n")}`);
}
