/**
 * Jarvis real-desktop acceptance suite: nine SYNTHETIC tasks on this PC, each independently verified,
 * with a hash-only audit log that is scanned for leaks afterwards.
 *
 *   bun --no-env-file scripts/jarvis-desktop-acceptance/suite.ts                 dry run (default): plans only
 *   bun --no-env-file scripts/jarvis-desktop-acceptance/suite.ts --run           real run on the desktop
 *     [--only notepad-save,calculator] [--runs 1..3] [--headed]
 *     [--playwright <path to playwright-core/index.mjs>]  (else "playwright-core" or PLAYWRIGHT_CORE_PATH)
 *
 * Scope, in code (lib.ts, tasks.ts): artefacts only under D:\tmp\jarvis-acceptance\<run>\; only windows
 * this run opened are focused, acted on or closed; screen_act always gets onlyWindow; no model keys
 * (rules + UIA + Playwright only); nothing is force-killed. Evidence: <run>\_evidence\report.json and
 * the audit JSONL beside it. Exit 0 only when every task passed and the audit scan found no leak.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { newTaskId } from "../../src/lib/control-outcome";
import { createAuditLog } from "../control-audit";
import { ACCEPTANCE_ROOT, auditSummary, ensureDir, runDir, runName, scanForMarkers, type TaskResult } from "./lib";
import { TASKS, type Ctx } from "./tasks";

const args = process.argv.slice(2);
const flag = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const RUN = args.includes("--run");
const ONLY = flag("--only")?.split(",").map((s) => s.trim()).filter(Boolean);
const RUNS = Math.max(1, Math.min(3, Number(flag("--runs") ?? 1) || 1));
const selected = TASKS.filter((t) => !ONLY || ONLY.includes(t.id));

function dryRun() {
  const run = runName();
  console.log(`DRY RUN: nothing is executed. ${selected.length} tasks; a real run would use ${join(ACCEPTANCE_ROOT, run)}\n`);
  for (const t of selected) {
    const p = t.plan(runDir(run));
    console.log(`[${t.id}] ${t.title}  (tier ${p.tier})`);
    p.steps.forEach((s, i) => console.log(`   ${i + 1}. ${s}`));
    console.log(`   pass when: ${p.pass.join("; ")}`);
    console.log(`   cleanup:   ${p.cleanup.join("; ")}\n`);
  }
}

async function realRun(n: number): Promise<{ results: TaskResult[]; leaks: number; dir: string }> {
  if (process.platform !== "win32") throw new Error("The desktop suite runs on Windows only.");
  const name = runName();
  const run = runDir(name);
  const evidence = ensureDir(join(run, "_evidence"));
  const audit = createAuditLog({ dir: join(evidence, "audit") });
  const { createPsHost } = await import("../jarvis-skills/ps-host");
  const { SCREEN_PRELUDE, nativeScreen } = await import("../screen-hands/native");
  const { createScreenHands, nativeHands } = await import("../screen-hands/index");
  const { FLAGS_OFF } = await import("../screen-hands/flags");
  const { loadChromium } = await import("../screen-hands/browser-exec");
  const ps = createPsHost({ prelude: SCREEN_PRELUDE });
  const hands = nativeHands(ps, nativeScreen(ps));
  // --trace: log each file-dialog call and its answer (handles and booleans only, never text).
  if (args.includes("--trace") && hands.dialog) {
    const inner = hands.dialog as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
    const traced: Record<string, unknown> = {};
    for (const k of Object.keys(inner))
      traced[k] = async (...a: unknown[]) => {
        const r = await inner[k](...a).catch((e: Error) => (console.log(`     trace ${k} threw: ${e.message.slice(0, 80)}`), Promise.reject(e)));
        console.log(`     trace ${k}(${a.filter((x) => typeof x === "number").join(",")}) -> ${JSON.stringify(r)}`);
        if (k === "focusFileName" && r === false) console.log(`     trace focus: ${(await ps.run(`[JarvisScreen]::DialogFocus(${Math.trunc(Number(a[0]))})`, 8000).catch(() => "?")).trim()}`);
        return r;
      };
    hands.dialog = traced as unknown as typeof hands.dialog;
  }
  let currentTask = newTaskId();
  const sink = (entry: unknown) => void audit.append({ ...(entry as object), taskId: currentTask });
  // No model keys: rules, UIA and Playwright only. The deny-list, the pre-press recheck and refs are on.
  const screen = createScreenHands({ key: () => "", ps, hands, flags: () => ({ ...FLAGS_OFF, recheck: true, denylist: true, refs: true }), audit: sink, jarvisChrome: null });
  const chromium = await loadChromium(flag("--playwright"));
  const ctx: Ctx = {
    run, ps, hands, screen, owned: new Set(), markers: [], chromium, headed: args.includes("--headed"),
    audit: (e) => sink({ ts: new Date().toISOString(), ...e }),
    get taskId() {
      return currentTask;
    },
    log: (line) => console.log(line),
  };
  console.log(`RUN ${n}: ${run}  (playwright ${chromium ? "loaded" : "NOT available"})`);
  const results: TaskResult[] = [];
  try {
    for (const t of selected) {
      currentTask = newTaskId();
      const started = Date.now();
      ctx.audit({ action: "acceptance_task", tier: t.plan(run).tier, approval: "flag", outcome: "preview", judgment: t.id.replace(/[^a-z0-9-]/g, "") });
      let r: Omit<TaskResult, "id" | "title" | "ms">;
      try {
        r = await t.run(ctx);
      } catch (error) {
        r = { status: "fail", outcome: "failed", checks: [{ name: "ran without throwing", ok: false, evidence: String((error as Error).message).slice(0, 160) }], cleanup: [] };
      }
      const result: TaskResult = { id: t.id, title: t.title, ms: Date.now() - started, ...r };
      ctx.audit({ action: "acceptance_task", tier: t.plan(run).tier, approval: "flag", outcome: r.outcome === "n/a" ? "refused" : r.outcome, judgment: t.id.replace(/[^a-z0-9-]/g, ""), verdict: r.status === "pass" ? "passed" : r.status === "fail" ? "failed" : "inconclusive", ms: result.ms });
      const lines = auditSummary(audit.read(), currentTask);
      results.push({ ...result, note: `audit: ${lines.length} lines (${lines.slice(0, 12).join(", ")}${lines.length > 12 ? ", …" : ""})` });
      console.log(`  ${result.status.toUpperCase().padEnd(7)} ${t.id} (${result.ms} ms) outcome=${r.outcome}`);
      for (const c of r.checks) console.log(`     ${c.ok ? "ok " : "NO "} ${c.name}: ${c.evidence}`);
      for (const c of r.cleanup) console.log(`     cleanup: ${c}`);
    }
  } finally {
    screen.close();
  }
  const leaks = scanForMarkers(audit.files(), ctx.markers);
  const report = {
    run: name, when: new Date().toISOString(), playwright: !!chromium, tasks: results,
    audit: { files: audit.files().map((f) => f.split(/[\\/]/).pop()), entries: audit.read().length, markersScanned: ctx.markers.length, leaks },
  };
  mkdirSync(evidence, { recursive: true });
  writeFileSync(join(evidence, "report.json"), JSON.stringify(report, null, 2), "utf8");
  console.log(`  audit: ${report.audit.entries} entries, ${ctx.markers.length} synthetic markers scanned, ${leaks.length} leaks`);
  console.log(`  evidence: ${evidence}`);
  return { results, leaks: leaks.length, dir: evidence };
}

if (import.meta.main) {
  if (!RUN) {
    dryRun();
    process.exit(0);
  }
  let allPass = true;
  for (let n = 1; n <= RUNS; n++) {
    const { results, leaks } = await realRun(n);
    const passed = results.filter((r) => r.status === "pass").length;
    console.log(`RUN ${n} RESULT: ${passed}/${results.length} passed, ${leaks} audit leaks\n`);
    allPass &&= passed === results.length && leaks === 0;
  }
  process.exit(allPass ? 0 : 1);
}
