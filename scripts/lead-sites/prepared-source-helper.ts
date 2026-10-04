// Test helper: the real-estate template source after its overlay and edits, prepared ONCE per test process into a temporary folder that is removed
// when the process ends (each preparation copies the example site's photographs, so one per test used to leave hundreds of MB behind).
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NEXT_TEMPLATE_SPECS, prepareSource } from "./next-templates";

let dir: string | null = null;

export function preparedRealEstateSource(): string {
  if (dir && existsSync(dir)) return dir;
  dir = mkdtempSync(join(tmpdir(), "r8-prepared-"));
  prepareSource(NEXT_TEMPLATE_SPECS["real-estate"], dir);
  const made = dir;
  process.on("exit", () => { try { rmSync(made, { recursive: true, force: true }); } catch { /* best effort: it is our own temporary folder */ } });
  return dir;
}
