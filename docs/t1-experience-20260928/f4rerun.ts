// Track 1 re-run of the AUDIT-F4 matrix (typed vs spoken destination) against the t1-experience worktree.
// In-process, network-free: the voice turn runs with a FAKE brain (every Groq call answers "[audit-brain]"
// with no tools) and NO Jev key (so Jev-routed lanes fall to the brain identically on both paths); nothing
// real is executed. Typed = the new typed box logic: routeJarvisText (the registry) first, else the SAME
// /voice/free/turn. Spoken = /voice/free/turn (which now asks the registry first). The client side of
// each tool call is normalised to a destination the way voice-companion.tsx would run it.
//   bun D:/agent-scratch/t1/f4rerun.ts > D:/agent-scratch/t1/f4rerun.json
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COMMANDS } from "D:/agent-scratch/f4/results/commands.ts";
const WT = process.env.F4_WT || "C:/Users/Nebula PC/source/repos/AgenticOS-v4-wt/t1-experience";
const { freeVoice } = await import(`${WT}/scripts/free-voice.ts`);
const { routeJarvisText, routeHref } = await import(`${WT}/src/lib/commands/jarvis-route.ts`);
const { voiceDestination, voiceIntent } = await import(`${WT}/src/lib/voice-actions.ts`);
const { recentVoiceIntent } = await import(`${WT}/src/lib/voice-recent.ts`);
const { actsOrPays } = await import(`${WT}/src/lib/commands/action-guard.ts`);

const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { "Content-Type": "application/json" } });
let brainCalls = 0;
const voice = freeVoice(mkdtempSync(join(tmpdir(), "t1-f4-")), {
  key: (name: string) => (name === "GROQ_API_KEY" ? "fake-not-a-key" : ""),
  fetch: (async (url: string) => {
    if (String(url).includes("groq")) {
      brainCalls++;
      return json({ choices: [{ message: { content: "[audit-brain] (fake brain: no tools)" } }] });
    }
    throw new Error(`blocked: ${url}`);
  }) as typeof fetch,
});

function toolDest(name: string, args: Record<string, unknown>): string {
  if (name === "navigate") {
    const d = voiceDestination(args.path);
    return d ? `navigate ${String(args.path)}` : `navigate REFUSED ${String(args.path)}`;
  }
  if (name === "pc_act" && args.action === "open_app") return `app ${String(args.target)}`;
  if (name === "page_answer") return `page-answer ${String(args.query)}`;
  if (name === "open_lead") return `open-lead ${String(args.name)}`;
  if (name === "open_url") return `open ${String(args.url)}`;
  if (name === "explain_page") return "explain (page context, in the browser)";
  return `${name} ${JSON.stringify(args).slice(0, 80)}`;
}
async function turnDest(text: string): Promise<string> {
  const r: any = await voice.handle("/voice/free/turn", { messages: [{ role: "user", content: text }] }).catch((e: Error) => ({ error: e.message }));
  if (r?.error) return `error ${r.error}`;
  const calls = r.tool_calls ?? [];
  if (calls.length) return calls.map((c: any) => toolDest(c.function.name, JSON.parse(c.function.arguments || "{}"))).join(" + ");
  if (typeof r.content === "string" && r.content.startsWith("[audit-brain]")) return "brain";
  return `said (${r.model ?? "?"}${r.route?.intent ? ` ${r.route.intent}` : ""})`;
}
/**
 * The typed box's REAL branch order (voice-companion.tsx execute(), review item 16): recent items, local
 * image search, memory sources, visual panels, the registry, the old page intents, then the same turn.
 * Only the last one is the turn; anything earlier is a client destination compared on its own.
 */
function typedDest(text: string, spoken: string): Promise<string> | string {
  if (recentVoiceIntent(text)) return `recent ${recentVoiceIntent(text)}`;
  if (/\b(?:find|search|look for|show)\b.*\b(?:images?|photos?|pictures?|screenshots?)\b/i.test(text) && /\b(?:laptop|mac|computer|local|desktop|downloads|pictures|named|called)\b/i.test(text)) return "local-image-search";
  if (/\b(?:memory|brain) sources\b/i.test(text)) return "memory-sources";
  const r = routeJarvisText(text);
  if (!r) {
    if (/^(?:show|bring up|pull up)(?: me)? (?:my |the )?(?:memories|memory|brain|calendar|business|images)\s*[.!?]?$/i.test(text)) return "show-visual";
    const intent = voiceIntent(text);
    if (intent.kind === "navigate" && !actsOrPays(text)) return `navigate ${intent.path}`;
    return spoken; // the typed box runs the same /voice/free/turn
  }
  if (r.kind === "navigate") return `navigate ${routeHref(r)}`;
  if (r.kind === "open-url") return `open ${r.url}`;
  if (r.kind === "device") return `app ${r.plan.request.utterance.replace(/^open /, "")}`;
  if (r.kind === "page-answer") return `page-answer ${r.query}`;
  if (r.kind === "open-lead") return `open-lead ${r.name}`;
  if (r.kind === "explain") return "explain (page context, in the browser)";
  return `said (rules registry.${r.kind === "answer" ? r.entryId : r.kind})`;
}

const rows: any[] = [];
const extra = [
  { id: "F3a", area: "F3", text: "open usage" },
  { id: "F3b", area: "F3", text: "open models" },
  { id: "F3c", area: "F3", text: "go to setup" },
  { id: "F3d", area: "F3", text: "which models are free" },
  { id: "F3e", area: "F3", text: "what needs setup" },
  { id: "F3f", area: "F3", text: "show usage" },
  // REVIEW-T1 safety probes (fix 2): money, action and compound words, typed vs spoken.
  ...["press send", "click submit", "pay the Telstra bill", "buy it", "type my card number", "open stake.com", "open Telstra and pay the bill", "open microsoft store and buy minecraft", "open finance and pay Telstra", "open the inbox and send it", "open gmail and delete everything", "open that call"].map((text, i) => ({ id: `RV${i + 1}`, area: "review", text })),
];
for (const c of [...COMMANDS.filter((c) => !c.kind || c.kind === "abort"), ...extra] as any[]) {
  if (c.id === "X05") continue; // not applicable in the audit either
  const spoken = await turnDest(c.text);
  const typed = await typedDest(c.text, spoken);
  const norm = (d: string) => d.replace(/^said \((rules|jev-router)[^)]*\)$/, "said").replace(/\s+\(.*\)$/, "");
  rows.push({ id: c.id, area: c.area, text: c.text, expect: c.expect ?? "", typed, spoken, same: norm(typed) === norm(spoken) });
}
const nav = rows.filter((r) => r.area === "navigation");
const navOk = nav.filter((r) => r.same && r.typed.startsWith("navigate ") && !r.typed.includes("REFUSED"));
const f4 = rows.filter((r) => r.area !== "F3" && r.area !== "review");
console.log(JSON.stringify({ at: new Date().toISOString(), brainCalls, commands: f4.length, same: f4.filter((r) => r.same).length, navigationSame: `${navOk.length} of ${nav.length}`, f3: rows.filter((r) => r.area === "F3"), review: rows.filter((r) => r.area === "review"), rows }, null, 1));
process.exit(0);
