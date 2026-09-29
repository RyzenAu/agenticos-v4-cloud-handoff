import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { isRouteReferenceModule, lucideExportMap, lucideValueImports, needsWholeBarrel, subsetEntry } from "./dev-page-weight";

test("collects value imports from lucide-react and skips type-only ones", () => {
  const code = `
    import { Plus, X as Close,
      type LucideIcon, Search } from "lucide-react";
    import type { LucideProps } from 'lucide-react';
    export { Bell } from "lucide-react";
    import { Plus as Again } from "other-lib";
  `;
  expect(lucideValueImports(code).sort()).toEqual(["Bell", "Plus", "Search", "X"]);
});

test("namespace, default and dynamic imports need the whole barrel", () => {
  expect(needsWholeBarrel(`import * as Icons from "lucide-react";`)).toBe(true);
  expect(needsWholeBarrel(`const m = await import("lucide-react");`)).toBe(true);
  expect(needsWholeBarrel(`import { Plus } from "lucide-react";`)).toBe(false);
  expect(needsWholeBarrel(`import type { LucideIcon } from "lucide-react";`)).toBe(false);
});

test("maps every alias in the barrel to its icon file and builds the subset entry", () => {
  const barrel = `
    import * as index from './icons/index.js';
    export { index as icons };
    export { default as Plus, default as PlusIcon, default as LucidePlus } from './icons/plus.js';
    export { default as createLucideIcon } from './createLucideIcon.js';
  `;
  const map = lucideExportMap(barrel);
  expect(map.get("PlusIcon")).toEqual({ file: "./icons/plus.js", name: "default" });
  expect(map.get("createLucideIcon")?.file).toBe("./createLucideIcon.js");
  expect(map.has("icons")).toBe(false);
  const entry = subsetEntry(["PlusIcon", "LucideIcon", "Plus"], map, "/pkg/dist/esm");
  expect(entry).toBe(
    'export { default as Plus } from "/pkg/dist/esm/icons/plus.js";\nexport { default as PlusIcon } from "/pkg/dist/esm/icons/plus.js";\n',
  );
});

test("every icon this app imports exists in the installed lucide-react barrel", () => {
  const require = createRequire(join(import.meta.dir, "..", "package.json"));
  const barrel = join(dirname(require.resolve("lucide-react/package.json")), "dist", "esm", "lucide-react.js");
  const map = lucideExportMap(readFileSync(barrel, "utf8"));
  expect(map.size).toBeGreaterThan(1000);
  for (const name of ["Plus", "MessageSquare", "ChevronRight", "LoaderCircle", "Loader2"]) expect(map.has(name)).toBe(true);
});

test("only route reference modules lose their dev source map", () => {
  const routes = "C:/app/src/routes";
  expect(isRouteReferenceModule("C:/app/src/routes/design.tsx", routes)).toBe(true);
  expect(isRouteReferenceModule("C:\\app\\src\\routes\\agents.hermes.tsx", routes)).toBe(true);
  expect(isRouteReferenceModule("C:/app/src/routes/design.tsx?tsr-split=component", routes)).toBe(false);
  expect(isRouteReferenceModule("C:/app/src/routes/__root.tsx", routes)).toBe(false);
  expect(isRouteReferenceModule("C:/app/src/routes/business.css", routes)).toBe(false);
  expect(isRouteReferenceModule("C:/app/src/components/design.tsx", routes)).toBe(false);
});
