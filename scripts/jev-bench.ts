#!/usr/bin/env bun
// Jev routing benchmark. A script, not a test: it calls live services and costs a few cents.
//
//   bun scripts/jev-bench.ts endpoint --label before [--repeat] [--group pc,browser] [--gap 8] [--base http://localhost:8081]
//     POSTs every case to the running OS's /__operator/voice/free/turn (routing only: the turn
//     endpoint returns the tool call, the browser client is what runs it, so nothing is executed)
//     and records route correctness and latency per path. --repeat runs the list a second time
//     to measure the decision cache.
//   bun scripts/jev-bench.ts rescore --label after
//     Re-scores a saved run with the current cases and scoring, calling nothing.
//   bun scripts/jev-bench.ts router --label calib [--design tree|flat]
//     Calls the Jev router directly (one Jev request per case, no brain) and records the raw
//     answers, for calibrating thresholds offline (see docs/JEV-ROUTING.md).
//   bun scripts/jev-bench.ts router --label <name> --laya
//     Same, plus a direct (blocking, not the fire-and-forget shadow) call to Laya per case with
//     the identical question, pinned to its typed-decisions checkpoint. Scored at CATEGORY
//     granularity only (pc/browser/os_page/website/screen/screen_act/routine/skill/emails/memory/
//     workspace/hermes/brain) since Laya's answer, like Jev's, never carries the slot-filled
//     app/folder/page/site name Jarvis's own extractors add afterward — a fair fully-slotted
//     comparison isn't possible from either provider's raw answer. Needs LAYA_URL (see docs/LAYA.md).
//
// Results: docs/jev-bench/<label>.json, plus a summary table on stdout.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BENCH_CASES, INSTANT_TOOLS, matches, specOf, type BenchCase, type RouteSpec } from "./jev-bench-cases";
import { layaUrl, queryLaya } from "./laya-shadow";

const root = join(import.meta.dir, "..");
const args = process.argv.slice(2);
const mode = args[0] ?? "endpoint";
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const label = flag("label") ?? `${mode}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "")}`;
const base = flag("base") ?? "http://localhost:8081";
const groups = flag("group")?.split(",");
const gapSeconds = Number(flag("gap") ?? 0);
const cases = BENCH_CASES.filter((c) => !groups || groups.includes(c.group));

type Row = BenchCase & RouteSpec & { ok: boolean; ms: number; pass: number; model?: string; detail?: unknown };

export function percentile(values: number[], p: number) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

function pathOf(model: string | undefined, data: any): RouteSpec["path"] {
  if (!model) return "error";
  if (model === "rules") return "rules";
  if (data?.router?.cached) return "cache";
  if (model === "jev-router") return "router";
  if (model.startsWith("jev")) return "jev";
  return "brain";
}

async function endpoint(): Promise<Row[]> {
  const token = ((await (await fetch(`${base}/__token`)).json()) as { token?: string }).token ?? "";
  if (!token) throw new Error("No page token from /__token; is the dev server running?");
  const rows: Row[] = [];
  const passes = args.includes("--repeat") ? 2 : 1;
  for (let pass = 1; pass <= passes; pass++) {
    for (const c of cases) {
      const started = performance.now();
      let data: any = null;
      try {
        const response = await fetch(`${base}/__operator/voice/free/turn`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Claude-OS-Token": token },
          body: JSON.stringify({ messages: [{ role: "user", content: c.text }], ...(c.sharing ? { sharing: true } : {}) }),
          signal: AbortSignal.timeout(45_000),
        });
        data = await response.json().catch(() => null);
        if (!response.ok) data = { error: data?.error ?? response.status };
      } catch (error) {
        data = { error: (error as Error).message };
      }
      const ms = Math.round(performance.now() - started);
      const call = data?.tool_calls?.[0]?.function;
      let callArgs: Record<string, unknown> = {};
      try {
        callArgs = call ? JSON.parse(call.arguments || "{}") : {};
      } catch { /* keep empty */ }
      const path = data?.error ? "error" : pathOf(data?.model, data);
      // The router answers "status" itself (spoken sentences, no tool call), like the rules do.
      const spec = data?.error ? `error:${data.error}` : !call && (path === "router" || path === "cache") ? "status" : specOf(call?.name ?? null, callArgs, path);
      const route: RouteSpec = { spec, path, tool: call?.name ?? null };
      const ok = path !== "error" && matches(c.expect, route);
      rows.push({ ...c, ...route, ok, ms, pass, model: data?.model, detail: data?.router ?? data?.reflex });
      console.log(`${ok ? "ok  " : "MISS"} ${String(ms).padStart(5)} ms  ${path.padEnd(6)} ${c.text}${c.sharing ? " [sharing]" : ""}  →  ${route.spec}${ok ? "" : `   (want ${c.expect.join(" | ")})`}`);
      // --gap <s>: pause after each brain turn so Groq's free 8k tokens/minute isn't the thing measured.
      if ((path === "brain" || path === "error") && gapSeconds) await new Promise((r) => setTimeout(r, gapSeconds * 1000));
    }
  }
  return rows;
}

// Categories a "gate" expectation must NOT land on (mirrors INSTANT_TOOLS in jev-bench-cases.ts,
// one level coarser: category id instead of tool name).
const INSTANT_CATEGORIES = new Set(["pc", "browser", "screen_act", "screen_teach", "os_page", "website", "routine", "screen", "skill"]);

/** First dot-segment of a resolveIntent()-shaped id ("pc.volume_down" -> "pc", "os_page" -> "os_page"). */
function categoryOf(intent: string | undefined | null): string | null {
  return intent ? intent.split(".")[0] : null;
}

/** expect's tool prefix translated to the same category space as categoryOf(), or null if not comparable. */
function expectCategory(want: string): string | null {
  const w = want.toLowerCase();
  if (w.startsWith("pc_act")) return "pc";
  if (w.startsWith("browser_act")) return "browser";
  if (w.startsWith("navigate")) return "os_page";
  if (w.startsWith("open_url")) return "website";
  if (w === "screen" || w.startsWith("screen:")) return "screen";
  if (w === "screen_act") return "screen_act";
  if (w === "screen_teach") return "screen_teach";
  if (w.startsWith("protocol")) return "routine";
  if (w.startsWith("skill")) return "skill";
  if (w === "control_pc") return "hermes";
  if (["status", "brain", "emails", "memory", "workspace", "hermes"].includes(w)) return w;
  if (w === "get_recent_emails") return "emails";
  if (w === "search_memory") return "memory";
  if (w === "ask_workspace") return "workspace";
  return null;
}

/** Category-level equivalent of matches() in jev-bench-cases.ts, for a provider that only ever
 * hands back a category id (no slot-filled app/page/site name) — Laya, and Jev via its own trace. */
function categoryMatches(expect: string[], actual: string | null): boolean {
  return expect.some((want) => {
    if (want.toLowerCase() === "gate") return !actual || !INSTANT_CATEGORIES.has(actual);
    const wanted = expectCategory(want);
    return wanted !== null && wanted === actual;
  });
}

type LayaRow = BenchCase & { layaIntent: string | null; layaCategory: string | null; ok: boolean; ms: number | null; error: boolean };

function percentileOf(values: number[], p: number) {
  return percentile(values, p);
}

function layaSummary(rows: LayaRow[], jevRows: Row[]) {
  const lines: string[] = [];
  const answered = rows.filter((r) => !r.error);
  const correct = answered.filter((r) => r.ok).length;
  lines.push(`Laya category accuracy: ${correct}/${rows.length} (${rows.length ? Math.round((100 * correct) / rows.length) : 0}%), ${rows.length - answered.length} timeouts/errors (counted as misses)`);
  const ms = answered.map((r) => r.ms!).filter((v) => v != null);
  lines.push(`Laya latency (direct call, this bench): p50 ${percentileOf(ms, 50)} ms, p95 ${percentileOf(ms, 95)} ms`);
  const jevMs = jevRows.map((r) => r.ms);
  lines.push(`Jev latency (this same run): p50 ${percentileOf(jevMs, 50)} ms, p95 ${percentileOf(jevMs, 95)} ms`);
  let agree = 0;
  let comparable = 0;
  for (let i = 0; i < rows.length; i++) {
    const jevCat = categoryOf(jevRows[i]?.detail && typeof jevRows[i]!.detail === "object" ? (jevRows[i]!.detail as { intent?: string }).intent : null);
    if (!jevCat || rows[i].error) continue;
    comparable++;
    if (jevCat === rows[i].layaCategory) agree++;
  }
  lines.push(`Jev/Laya category agreement (this run, case-matched): ${agree}/${comparable} (${comparable ? Math.round((100 * agree) / comparable) : 0}%)`);
  lines.push("| group | Laya correct | Laya p50 ms |", "|---|---|---|");
  for (const group of [...new Set(rows.map((r) => r.group))]) {
    const g = rows.filter((r) => r.group === group);
    const gAnswered = g.filter((r) => !r.error);
    lines.push(`| ${group} | ${g.filter((r) => r.ok).length}/${g.length} | ${percentileOf(gAnswered.map((r) => r.ms!), 50)} |`);
  }
  return lines.join("\n");
}

async function router(): Promise<Row[]> {
  const { providerKey } = await import("./provider-config");
  const jevRouter = await import("./jev-router");
  const pcHands = await import("./pc-hands");
  const key = providerKey(root, "TYPESAFE_API_KEY") || providerKey(root, "JEV_API_KEY");
  if (!key) throw new Error("No TypeSafe key configured.");
  const apps = await pcHands.startAppsReady();
  const design = (flag("design") ?? "tree") as "tree" | "flat";
  const useLaya = args.includes("--laya");
  const base = useLaya ? layaUrl() : undefined;
  if (useLaya && !base) throw new Error("--laya was passed but LAYA_URL is not set (see docs/LAYA.md).");
  const rows: Row[] = [];
  const layaRows: LayaRow[] = [];
  for (const c of cases) {
    const started = performance.now();
    const decision = await jevRouter.routeUtterance(c.text, { key, apps, design, cache: null, sharing: c.sharing });
    const ms = Math.round(performance.now() - started);
    const call = decision.kind === "act" ? decision.call : null;
    const path: RouteSpec["path"] = decision.kind === "brain" ? "brain" : "router";
    const route: RouteSpec = {
      spec: decision.kind === "status" ? "status" : specOf(call?.name ?? null, call?.arguments ?? {}, path),
      path: decision.kind === "status" ? "rules" : path,
      tool: call?.name ?? null,
    };
    // A router "brain" means "let the brain decide", so a case expecting a tool is a miss here
    // unless the brain was also acceptable.
    const ok = matches(c.expect, route);
    rows.push({ ...c, ...route, ok, ms, pass: 1, model: "jev-router", detail: decision.trace });
    console.log(`${ok ? "ok  " : "MISS"} ${String(ms).padStart(5)} ms  ${route.path.padEnd(6)} ${c.text}  →  ${route.spec}  ${decision.trace ? `[${decision.trace.intent} ${decision.trace.confidence.toFixed(2)}${decision.trace.reason ? ` ${decision.trace.reason}` : ""}]` : ""}${ok ? "" : `   (want ${c.expect.join(" | ")})`}`);
    if (useLaya && base) {
      const layaStarted = performance.now();
      const layaBody = { ...jevRouter.jevRequestBody(c.text, { design }), model: "typed-decisions" };
      const laya = await queryLaya(base, layaBody);
      const layaMs = Math.round(performance.now() - layaStarted);
      const layaIntent = laya ? jevRouter.resolveIntent(laya.answers).intent : null;
      const layaCategory = categoryOf(layaIntent);
      const layaOk = categoryMatches(c.expect, layaCategory);
      layaRows.push({ ...c, layaIntent, layaCategory, ok: layaOk, ms: laya ? layaMs : null, error: !laya });
      console.log(`     laya ${laya ? String(layaMs).padStart(5) + " ms" : "  TIMEOUT"}  ${layaOk ? "ok  " : "MISS"}  → ${layaIntent ?? "(none)"}`);
    }
  }
  if (useLaya) {
    const text = layaSummary(layaRows, rows);
    console.log(`\n${text}`);
    const file = join(root, "docs", "jev-bench", `${label}-laya.json`);
    mkdirSync(join(root, "docs", "jev-bench"), { recursive: true });
    writeFileSync(file, JSON.stringify({ label, at: new Date().toISOString(), summary: text, rows: layaRows }, null, 1));
    console.log(`Saved ${file}`);
  }
  return rows;
}

function summary(rows: Row[]) {
  const lines: string[] = [];
  const correct = rows.filter((r) => r.ok).length;
  const unsafe = rows.filter((r) => r.group === "outbound" && r.tool && INSTANT_TOOLS.has(r.tool));
  const errors = rows.filter((r) => r.path === "error").length;
  lines.push(`Route accuracy: ${correct}/${rows.length} (${Math.round((100 * correct) / rows.length)}%)${errors ? `, ${errors} provider errors (counted as misses)` : ""}; outbound cases that became an instant action: ${unsafe.length}${unsafe.length ? ` (${unsafe.map((r) => `"${r.text}" → ${r.spec} via ${r.path}`).join("; ")})` : ""}`);
  const all = rows.map((r) => r.ms);
  lines.push(`All turns: p50 ${percentile(all, 50)} ms, p95 ${percentile(all, 95)} ms`);
  lines.push("| path | turns | p50 ms | p95 ms |", "|---|---|---|---|");
  for (const path of ["rules", "cache", "router", "jev", "brain", "error"]) {
    const ms = rows.filter((r) => r.path === path).map((r) => r.ms);
    if (ms.length) lines.push(`| ${path} | ${ms.length} | ${percentile(ms, 50)} | ${percentile(ms, 95)} |`);
  }
  lines.push("| group | correct | p50 ms |", "|---|---|---|");
  for (const group of [...new Set(rows.map((r) => r.group))]) {
    const g = rows.filter((r) => r.group === group);
    lines.push(`| ${group} | ${g.filter((r) => r.ok).length}/${g.length} | ${percentile(g.map((r) => r.ms), 50)} |`);
  }
  return lines.join("\n");
}

/** Re-score a saved run (after a scoring fix) without calling anything. */
function rescore(): Row[] {
  const saved = JSON.parse(readFileSync(join(root, "docs", "jev-bench", `${label}.json`), "utf8")) as { rows: Row[] };
  return saved.rows.map((r) => {
    const spec = r.spec === "brain" && !r.tool && (r.path === "router" || r.path === "cache") ? "status" : r.spec;
    const expect = BENCH_CASES.find((c) => c.text === r.text)?.expect ?? r.expect;
    return { ...r, spec, expect, ok: r.path !== "error" && matches(expect, { spec, path: r.path, tool: r.tool }) };
  });
}

if (import.meta.main) {
  const rows = mode === "router" ? await router() : mode === "rescore" ? rescore() : await endpoint();
  const passes = [...new Set(rows.map((r) => r.pass))];
  const text = passes.length > 1 ? passes.map((p) => `Pass ${p}${p > 1 ? " (repeat: decision cache warm)" : ""}\n${summary(rows.filter((r) => r.pass === p))}`).join("\n\n") : summary(rows);
  console.log(`\n${text}`);
  const directory = join(root, "docs", "jev-bench");
  mkdirSync(directory, { recursive: true });
  const file = join(directory, `${label}.json`);
  writeFileSync(file, JSON.stringify({ label, mode, at: new Date().toISOString(), summary: text, rows }, null, 1));
  console.log(`\nSaved ${file}`);
}
