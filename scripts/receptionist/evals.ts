import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Source } from "./types";
export type EvalFacts = { passed: number; total: number; reports: number; date: string };
export function readEvals(root: string): Source<EvalFacts> {
  try {
    const dir = join(root, "reports", "evals");
    const reports = readdirSync(dir).flatMap((file) => {
      const date = file.match(/-(\d{4}-\d{2}-\d{2})\.md$/)?.[1];
      if (!date) return [];
      const match = readFileSync(join(dir, file), "utf8").match(
        /\*\*Result:\s*(\d+)\/(\d+) scenario checks passed\*\*/i,
      );
      return match ? [{ date, passed: Number(match[1]), total: Number(match[2]) }] : [];
    });
    if (!reports.length) return { ok: false, reason: "No eval report on file" };
    const date = reports
      .map((r) => r.date)
      .sort()
      .at(-1)!;
    const latest = reports.filter((r) => r.date === date);
    return {
      ok: true,
      date,
      reports: latest.length,
      passed: latest.reduce((s, r) => s + r.passed, 0),
      total: latest.reduce((s, r) => s + r.total, 0),
    };
  } catch {
    return { ok: false, reason: "No eval report on file" };
  }
}
export function readLegalTemplate(root: string): "present" | "missing" | "unknown" {
  try {
    const text = readFileSync(join(root, "src/lib/buildmaster/client-profile.ts"), "utf8").replace(
      /\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,
      "",
    );
    const literal = text.match(/\bSUPPORTED_NICHES\s*(?::[^=]+)?=\s*\[([^\]]*)\]/)?.[1];
    return literal === undefined
      ? "unknown"
      : /['"]LEGAL['"]/.test(literal)
        ? "present"
        : "missing";
  } catch {
    return "unknown";
  }
}
