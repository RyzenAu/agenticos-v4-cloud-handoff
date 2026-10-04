// House rule (owner, 3 Oct 2026): no internal names in what a person reads. A route or page component must not print a script path, a
// `bun run` command, an endpoint path in prose ("(/__jobs)") or an MU_ environment name. This reads the source of the pages in
// F's scope and looks at every line that is not a comment or an import; URLs inside fetch calls are not prose (they follow a quote or a
// backtick, not a space or a parenthesis). Technical-detail sections are allowed explicitly below, each with its reason.
import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const DIRS = ["src/routes", "src/components/shell/pages", "src/components/shell", "src/components/shell/command-scene", "src/components/websites", "src/components/workspace", "src/components/business", "src/components/finance", "src/components/memory"];
// Pages that belong to other workers (Agents, Coding, Computers, CRM, Receptionist) or that are the Inspector's own technical view.
const SKIP_FILES = [/agents\./, /coding\./, /computers\.tsx/, /crm\.tsx/, /receptionist\.tsx/, /hermes\.tsx/, /dashboard\.tsx/, /inspector\.tsx/, /^src\/routes\/-pages\//];
// Allowed on a line: technical-detail sections whose job is to show where a number came from, or that feed the Inspector rather than the page.
const ALLOW_LINE = [
  /useInspectorFacts|publish\(|inspect/, // the Inspector drawer is the technical-detail view
  /import\.meta\.glob|graphLoaders/, // module loading, not copy
  /\bfrom "/, // the tail of a multi-line import
  /graph-to-dashboard\.sh <local-path|claude-os\/src\/data\/graphs\/index\.json/, // the text sent to Hermes as its prompt for a graph question; never shown on the page
];
const PROSE = /scripts\/|bun run|[\s(]\/__[a-z]|\bMU_[A-Z]{2,}|~\/[.a-z]/;

function files(dir: string): string[] {
  return readdirSync(join(ROOT, dir)).flatMap((f) => {
    const rel = `${dir}/${f}`;
    return statSync(join(ROOT, rel)).isFile() && /\.tsx?$/.test(f) && !/\.test\./.test(f) ? [rel] : [];
  });
}

export function offenders(): string[] {
  const out: string[] = [];
  for (const rel of DIRS.flatMap(files)) {
    if (SKIP_FILES.some((re) => re.test(rel))) continue;
    // A block of lines inside useInspectorFacts(...) is Inspector detail: skip from its call to the closing "});".
    let inInspector = false;
    readFileSync(join(ROOT, rel), "utf8").split(/\r?\n/).forEach((line, i) => {
      const t = line.trim();
      if (/useInspectorFacts\(/.test(t)) inInspector = true;
      const skip = inInspector;
      if (inInspector && /^\}\);?$/.test(t)) inInspector = false;
      if (skip || /^(\/\/|\*|\/\*)/.test(t) || /^import /.test(t) || ALLOW_LINE.some((re) => re.test(line))) return;
      const code = line.replace(/\/\/ .*$/, "");
      if (PROSE.test(code)) out.push(`${rel}:${i + 1}: ${t.slice(0, 140)}`);
    });
  }
  return out;
}

test("no page prints a script path, a bun command, an endpoint path or an MU_ name", () => {
  expect(offenders()).toEqual([]);
});
